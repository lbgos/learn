// Ported from learnharness (AGPL-3.0-only) src/core/coverage.ts @ c549494.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous ledger fingerprints and injected ID generation live only in this node entry.
import * as NodeCrypto from "node:crypto";
import type { CoverageEntry, TeacherProseMessage } from "../model.ts";
import * as coverage from "../coverage.ts";
export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
export const newGraphNodeId = () => `n_${NodeCrypto.randomBytes(6).toString("hex")}`;
export const newGraphChainId = () => `arg_${NodeCrypto.randomBytes(6).toString("hex")}`;
export const notesSourceId = (relativePath: string) => `notes:${sha256(relativePath)}`;
export const notesContentFingerprint = sha256;
export const messageFingerprint = (message: TeacherProseMessage) =>
  coverage.messageFingerprint(message, sha256);
export const coverageSlots = (messages: ReadonlyArray<TeacherProseMessage>) =>
  coverage.coverageSlots(messages, sha256);
export const coverageOf = (
  messages: ReadonlyArray<TeacherProseMessage>,
  entries: ReadonlyArray<CoverageEntry>,
  chatId: string,
) => coverage.coverageOf(messages, entries, chatId, sha256);
export const batchTag = (batch: ReadonlyArray<coverage.CoverageSlot>) =>
  coverage.batchTag(batch, sha256);
