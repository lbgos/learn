import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  addSourceSchema,
  eventSchema,
  limits,
  recordSchema,
  sourceIdSchema,
  type CortexEvent,
} from "./schema.ts";
import { hash, parseSource, serializeSource, timestamp } from "./source.ts";

export function readBounded(
  path: string,
  maxBytes: number = limits.sourceBytes,
  allowedDirectory?: string,
) {
  const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
  try {
    if (allowedDirectory !== undefined) {
      // Check the opened inode, not just the caller's path, before reading any bytes.
      // Linux /proc also closes parent-directory symlink races. Fail closed elsewhere.
      const actual = NodeFS.realpathSync(`/proc/self/fd/${fd}`);
      const relative = NodePath.relative(allowedDirectory, actual);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative)
      )
        throw new Error("Source path is outside CORTEX_IMPORT_DIR");
    }
    if (!NodeFS.fstatSync(fd).isFile()) throw new Error("Source must be a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = NodeFS.readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > maxBytes) throw new Error("Source exceeds byte limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    NodeFS.closeSync(fd);
  }
}

function readProc(path: string) {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * True only when the lock's owner provably cannot be running: it was written during an
 * earlier boot, or by a process of this boot that no longer exists. Off Linux it is never stale.
 */
function lockIsStale(path: string) {
  const currentBoot = readProc("/proc/sys/kernel/random/boot_id")?.trim();
  const bootSeconds = Number(readProc("/proc/stat")?.match(/^btime (\d+)$/m)?.[1]);
  if (!currentBoot || !Number.isFinite(bootSeconds)) return false;
  const [ownerBoot, ownerPid] = NodeFS.readFileSync(path, "utf8").trim().split(" ");
  // Locks from older builds are empty; only their age can prove them stale.
  if (!ownerBoot) return NodeFS.statSync(path).mtimeMs < bootSeconds * 1000;
  if (ownerBoot !== currentBoot) return true;
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function writeLock(path: string) {
  const bootId = readProc("/proc/sys/kernel/random/boot_id")?.trim() ?? "";
  const fd = NodeFS.openSync(path, "wx", 0o600);
  try {
    NodeFS.writeSync(fd, bootId ? `${bootId} ${process.pid}\n` : "");
  } finally {
    NodeFS.closeSync(fd);
  }
}

/** Refuses a second writer; replaces a lock only when lockIsStale proves its owner gone. */
function acquireLock(path: string) {
  try {
    writeLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lockIsStale(path)) throw error;
    NodeFS.unlinkSync(path);
    writeLock(path);
  }
}

function syncDirectory(path: string) {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

export class Vault {
  readonly events: CortexEvent[] = [];
  private readonly lockPath: string;
  private closed = false;
  private faulted = false;

  readonly directory: string;

  private readonly importDirectory: string | undefined;

  constructor(directory: string, options: { importDirectory?: string } = {}) {
    this.importDirectory =
      options.importDirectory === undefined
        ? undefined
        : NodeFS.realpathSync(options.importDirectory);
    this.directory = directory;
    NodeFS.mkdirSync(NodePath.join(directory, "sources"), { recursive: true, mode: 0o700 });
    this.lockPath = NodePath.join(directory, ".writer.lock");
    // Refuse a second writer, including another rebuild process.
    acquireLock(this.lockPath);
    try {
      const eventPath = NodePath.join(directory, "events.jsonl");
      if (!NodeFS.existsSync(eventPath)) {
        const fd = NodeFS.openSync(eventPath, "wx", 0o600);
        NodeFS.fsyncSync(fd);
        NodeFS.closeSync(fd);
        syncDirectory(directory);
      }
      const text = NodeFS.readFileSync(eventPath, "utf8");
      if (text && !text.endsWith("\n"))
        throw new Error("Incomplete event tail; repair a copy before reopening the vault");
      for (const line of text.split("\n").slice(0, -1)) {
        const event = eventSchema.parse(JSON.parse(line));
        this.validateEvent(event);
        this.events.push(event);
      }
      for (const id of this.sourceIds()) this.registerSource(id);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    NodeFS.unlinkSync(this.lockPath);
  }

  sourceIds() {
    return NodeFS.readdirSync(NodePath.join(this.directory, "sources"))
      .filter((name) => /^[a-f0-9]{24}\.md$/.test(name))
      .map((name) => name.slice(0, -3))
      .sort();
  }

  source(sourceId: string) {
    const id = sourceIdSchema.parse(sourceId);
    const markdown = readBounded(
      NodePath.join(this.directory, "sources", `${id}.md`),
      limits.sourceBytes + 4096,
    );
    const source = { markdown, ...parseSource(markdown) };
    const registered = this.events.find(
      (event) => event.type === "source.added" && event.sourceId === id,
    );
    if (registered?.type === "source.added" && registered.revision !== source.revision) {
      throw new Error("Source artifact was modified");
    }
    return source;
  }

  private validateEvent(event: CortexEvent) {
    if (
      event.seq !== this.events.length + 1 ||
      this.events.some((prior) => prior.id === event.id)
    ) {
      throw new Error("Invalid event sequence or duplicate event id");
    }
    if (event.type === "source.added") {
      if (
        this.events.some(
          (prior) => prior.type === "source.added" && prior.sourceId === event.sourceId,
        )
      ) {
        throw new Error("Duplicate source registration");
      }
      if (this.source(event.sourceId).revision !== event.revision)
        throw new Error("Source artifact was modified");
      return;
    }
    const record = event.observation;
    if (record.sourceRef) {
      const source = this.source(record.sourceRef.sourceId);
      if (record.sourceRef.revision !== source.revision)
        throw new Error("Source revision mismatch");
      if (
        (record.sourceRef.from ?? 1) > source.lines.length ||
        (record.sourceRef.to ?? 1) > source.lines.length
      ) {
        throw new Error("Source line reference is outside the artifact");
      }
      if (record.sourceRef.timeFrom !== undefined) {
        const anchors = source.lines.flatMap((line) => {
          const time = timestamp(line);
          return time === undefined ? [] : [time];
        });
        if (
          !anchors.length ||
          record.sourceRef.timeFrom < anchors[0]! ||
          record.sourceRef.timeFrom > anchors.at(-1)!
        ) {
          throw new Error("Source time reference is outside known anchors");
        }
        if (record.sourceRef.timeTo !== undefined && record.sourceRef.timeTo > anchors.at(-1)!) {
          throw new Error("Source time reference is outside known anchors");
        }
      }
    }
    if (record.supersedes) {
      const prior = this.events.find((item) => item.id === record.supersedes);
      if (prior?.type !== "observation" || prior.observation.type !== record.type) {
        throw new Error("Correction must supersede an earlier observation of the same type");
      }
      if (
        this.events.some(
          (item) =>
            item.type === "observation" && item.observation.supersedes === record.supersedes,
        )
      ) {
        throw new Error("Observation already superseded; correct the current event");
      }
    }
  }

  private append(event: CortexEvent) {
    if (this.closed || this.faulted) throw new Error("Vault writer is unavailable");
    this.validateEvent(event);
    const fd = NodeFS.openSync(NodePath.join(this.directory, "events.jsonl"), "a");
    try {
      const data = Buffer.from(`${JSON.stringify(event)}\n`);
      let offset = 0;
      while (offset < data.length) offset += NodeFS.writeSync(fd, data, offset);
      NodeFS.fsyncSync(fd);
    } catch (error) {
      this.faulted = true;
      throw error;
    } finally {
      NodeFS.closeSync(fd);
    }
    this.events.push(event);
    return event;
  }

  private registerSource(sourceId: string) {
    const source = this.source(sourceId);
    const prior = this.events.find(
      (event) => event.type === "source.added" && event.sourceId === sourceId,
    );
    if (prior) return;
    this.append({
      id: NodeCrypto.randomUUID(),
      seq: this.events.length + 1,
      time: new Date().toISOString(),
      type: "source.added",
      sourceId,
      revision: source.revision,
    });
  }

  addSource(input: unknown) {
    if (this.closed || this.faulted) throw new Error("Vault writer is unavailable");
    const { text, path, ...metadata } = addSourceSchema.parse(input);
    if (path !== undefined && this.importDirectory === undefined)
      throw new Error("Path imports disabled; supply text or configure CORTEX_IMPORT_DIR");
    const body =
      path === undefined ? text! : readBounded(path, limits.sourceBytes, this.importDirectory);
    if (!body.trim() || Buffer.byteLength(body) > limits.sourceBytes)
      throw new Error("Empty or oversized source");
    const sourceId = hash(JSON.stringify(metadata) + "\n" + body).slice(0, 24);
    const target = NodePath.join(this.directory, "sources", `${sourceId}.md`);
    if (!NodeFS.existsSync(target)) {
      const fd = NodeFS.openSync(target, "wx", 0o600);
      try {
        NodeFS.writeFileSync(
          fd,
          serializeSource({ ...metadata, added: new Date().toISOString() }, body),
        );
        NodeFS.fsyncSync(fd);
      } finally {
        NodeFS.closeSync(fd);
      }
      syncDirectory(NodePath.join(this.directory, "sources"));
    }
    this.registerSource(sourceId);
    const source = this.source(sourceId);
    return { sourceId, revision: source.revision, title: source.metadata.title };
  }

  record(input: unknown) {
    const observation = recordSchema.parse(input);
    if (observation.sourceRef) {
      observation.sourceRef.revision ??= this.source(observation.sourceRef.sourceId).revision;
    }
    return this.append({
      id: NodeCrypto.randomUUID(),
      seq: this.events.length + 1,
      time: new Date().toISOString(),
      type: "observation",
      observation,
    });
  }
}
