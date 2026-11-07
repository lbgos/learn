import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import type { Embedder } from "./embedding.ts";
import { limits, searchSchema, truncateBytes } from "./schema.ts";
import { chunkSource, type Passage } from "./source.ts";
import type { Vault } from "./vault.ts";

function lexicalQuery(query: string) {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .slice(0, 48)
    .map((word) => `"${word}"`)
    .join(" OR ");
}

export function reciprocalRankFusion(rankings: readonly (readonly number[])[]) {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

const idRow = z.object({ rowid: z.number() });
const passageRow = z.object({
  sourceId: z.string(),
  revision: z.string(),
  title: z.string(),
  from: z.number(),
  to: z.number(),
  timeFrom: z.number().nullable(),
  timeTo: z.number().nullable(),
  body: z.string(),
});

export class CortexIndex {
  private readonly db: NodeSqlite.DatabaseSync;

  private readonly vault: Vault;
  private readonly embedder: Embedder;

  constructor(vault: Vault, embedder: Embedder, options: { rebuild?: boolean } = {}) {
    this.vault = vault;
    this.embedder = embedder;
    const databasePath = NodePath.join(vault.directory, "index.sqlite");
    if (options.rebuild) {
      for (const suffix of ["", "-wal", "-shm"])
        NodeFS.rmSync(`${databasePath}${suffix}`, { force: true });
    }
    this.db = new NodeSqlite.DatabaseSync(databasePath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.db.enableLoadExtension(false);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const version = this.db.prepare("SELECT value FROM settings WHERE key = 'embedding'").get();
    const identity = `${embedder.id}:chunks-v2`;
    if (version?.value !== identity) {
      this.db.exec(
        "DROP TABLE IF EXISTS passages; DROP TABLE IF EXISTS lexical; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS sources;",
      );
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('embedding', ?)").run(identity);
    }
    if (
      !Number.isSafeInteger(embedder.dimensions) ||
      embedder.dimensions < 1 ||
      embedder.dimensions > 4096
    ) {
      throw new Error("Invalid embedding dimensions");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (sourceId TEXT PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passages (
        sourceId TEXT NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
        "from" INTEGER NOT NULL, "to" INTEGER NOT NULL, timeFrom REAL, timeTo REAL, body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(title, body, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(embedding float[${embedder.dimensions}] distance_metric=cosine);
      CREATE VIRTUAL TABLE IF NOT EXISTS observations USING fts5(statement);
    `);
  }

  close() {
    this.db.close();
  }

  async synchronize(rebuild = false) {
    if (rebuild) {
      this.db.exec(
        "BEGIN; DELETE FROM vectors; DELETE FROM lexical; DELETE FROM passages; DELETE FROM sources; COMMIT;",
      );
    }
    for (const sourceId of this.vault.sourceIds()) await this.indexSource(sourceId);
    this.replayEvents();
  }

  async indexSource(sourceId: string) {
    const source = this.vault.source(sourceId);
    const indexed = this.db
      .prepare("SELECT revision FROM sources WHERE sourceId = ?")
      .get(sourceId);
    if (indexed?.revision === source.revision) return;
    const passages = chunkSource(sourceId, source.markdown);
    // Embed before the transaction. Interrupted ingestion leaves the accepted artifact available for rebuild.
    const embeddings = [];
    for (const passage of passages)
      embeddings.push(await this.embedder.embed(`${passage.title}\n${passage.body}`));
    this.db.exec("BEGIN");
    try {
      const oldIds = this.db.prepare("SELECT rowid FROM passages WHERE sourceId = ?").all(sourceId);
      for (const row of oldIds) {
        const { rowid } = idRow.parse(row);
        this.db.prepare("DELETE FROM vectors WHERE rowid = ?").run(BigInt(rowid));
        this.db.prepare("DELETE FROM lexical WHERE rowid = ?").run(BigInt(rowid));
      }
      this.db.prepare("DELETE FROM passages WHERE sourceId = ?").run(sourceId);
      for (const [index, passage] of passages.entries())
        this.insertPassage(passage, embeddings[index]!);
      this.db
        .prepare("INSERT OR REPLACE INTO sources VALUES (?, ?)")
        .run(sourceId, source.revision);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertPassage(passage: Passage, embedding: Float32Array) {
    if (
      embedding.length !== this.embedder.dimensions ||
      embedding.some((number) => !Number.isFinite(number))
    ) {
      throw new Error("Invalid embedding");
    }
    const result = this.db
      .prepare("INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        passage.sourceId,
        passage.revision,
        passage.title,
        passage.from,
        passage.to,
        passage.timeFrom,
        passage.timeTo,
        passage.body,
      );
    this.db
      .prepare("INSERT INTO lexical(rowid, title, body) VALUES (?, ?, ?)")
      .run(result.lastInsertRowid, passage.title, passage.body);
    this.db
      .prepare("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)")
      .run(
        BigInt(result.lastInsertRowid),
        new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      );
  }

  replayEvents() {
    this.db.exec("BEGIN; DELETE FROM observations;");
    try {
      for (const event of this.vault.events) {
        if (event.type === "observation")
          this.db
            .prepare("INSERT INTO observations(rowid, statement) VALUES (?, ?)")
            .run(event.seq, event.observation.statement);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async search(input: unknown) {
    const { query, k } = searchSchema.parse(input);
    const lexical = lexicalQuery(query);
    const lexicalIds = lexical
      ? this.db
          .prepare(
            "SELECT rowid FROM lexical WHERE lexical MATCH ? ORDER BY bm25(lexical, 2, 1) LIMIT 30",
          )
          .all(lexical)
          .map((row) => idRow.parse(row).rowid)
      : [];
    const vector = await this.embedder.embed(query, true);
    const vectorIds = this.db
      .prepare("SELECT rowid FROM vectors WHERE embedding MATCH ? AND k = 30 ORDER BY distance")
      .all(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
      .map((row) => idRow.parse(row).rowid);
    return reciprocalRankFusion([lexicalIds, vectorIds])
      .slice(0, k)
      .map(([id, score], index) => {
        const passage = passageRow.parse(
          this.db.prepare("SELECT * FROM passages WHERE rowid = ?").get(id),
        );
        const { body, ...citation } = passage;
        return {
          rank: index + 1,
          ...citation,
          score,
          snippet: truncateBytes(body, limits.snippetChars),
        };
      });
  }

  beliefs(query: string) {
    const parsed = searchSchema.parse({ query });
    const lexical = lexicalQuery(parsed.query);
    if (!lexical) return [];
    const rows = this.db
      .prepare(
        "SELECT rowid FROM observations WHERE observations MATCH ? ORDER BY bm25(observations) LIMIT 8",
      )
      .all(lexical);
    const superseded = new Map<string, string>();
    for (const event of this.vault.events) {
      if (event.type === "observation" && event.observation.supersedes)
        superseded.set(event.observation.supersedes, event.id);
    }
    return rows.map((row) => {
      const event = this.vault.events[idRow.parse(row).rowid - 1]!;
      return { ...event, supersededBy: superseded.get(event.id) ?? null };
    });
  }

  stats() {
    return this.db
      .prepare(
        "SELECT (SELECT count(*) FROM sources) AS sources, count(*) AS passages FROM passages",
      )
      .get();
  }
}
