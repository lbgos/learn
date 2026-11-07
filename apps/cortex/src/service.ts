import { advise, graph } from "./knowledge.ts";
import { CortexIndex } from "./index.ts";
import { limits, readSchema, truncateBytes } from "./schema.ts";
import type { Vault } from "./vault.ts";

export class CortexService {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  readonly vault: Vault;
  readonly index: CortexIndex;

  constructor(vault: Vault, index: CortexIndex) {
    this.vault = vault;
    this.index = index;
  }

  // One model session and writer are shared by all clients. Bound waiting work as well as output.
  execute<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.pending >= 16) return Promise.reject(new Error("Cortex is busy; retry later"));
    this.pending++;
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.pending--;
    });
  }

  async addSource(input: unknown) {
    const receipt = this.vault.addSource(input);
    try {
      await this.index.indexSource(receipt.sourceId);
      return { ...receipt, indexed: true };
    } catch {
      return { ...receipt, indexed: false, message: "Source saved; run rebuild to retry indexing" };
    }
  }

  advise(input: unknown) {
    return advise(this.vault, this.index, input);
  }

  graph(input: unknown) {
    return graph(this.vault, input);
  }

  read(input: unknown) {
    const { sourceId, from, to } = readSchema.parse(input);
    const source = this.vault.source(sourceId);
    if (from > source.lines.length) throw new Error("Start line is outside the source");
    const end = Math.min(
      to ?? source.lines.length,
      from + limits.excerptLines - 1,
      source.lines.length,
    );
    const selected = source.lines.slice(from - 1, end).join("\n");
    const excerpt = truncateBytes(selected, limits.excerptBytes);
    const complete = excerpt.length === selected.length;
    return {
      sourceId,
      revision: source.revision,
      title: source.metadata.title,
      from,
      to: from + excerpt.split("\n").length - 1,
      excerpt,
      truncated: !complete || end < (to ?? source.lines.length),
      lastLineComplete: complete,
    };
  }

  record(input: unknown) {
    const event = this.vault.record(input);
    this.index.replayEvents();
    return event;
  }
}
