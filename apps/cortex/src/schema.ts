import { z } from "zod";

export const limits = {
  sourceBytes: 2_000_000,
  requestBytes: 2_100_000,
  responseBytes: 24_000,
  excerptBytes: 12_000,
  excerptLines: 80,
  snippetChars: 600,
  results: 8,
} as const;

export const sourceIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const conceptsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\r\n]+$/),
  )
  .max(8);
export const sourceMetadataSchema = z.object({
  kind: z.enum(["video", "lecture", "course", "note", "book"]),
  title: z.string().trim().min(1).max(240),
  url: z.url().max(2048).optional(),
  channel: z.string().trim().min(1).max(240).optional(),
  durationSeconds: z.number().nonnegative().finite().optional(),
  concepts: conceptsSchema.optional(),
  added: z.iso.datetime(),
  language: z.string().min(2).max(35),
});
export const addSourceSchema = sourceMetadataSchema
  .omit({ added: true, language: true })
  .extend({
    language: sourceMetadataSchema.shape.language.default("und"),
    path: z.string().max(4096).optional(),
    text: z.string().min(1).max(limits.sourceBytes).optional(),
  })
  .refine((value) => (value.path === undefined) !== (value.text === undefined), {
    message: "Supply exactly one of path or text",
  });
export const sourceRefSchema = z
  .object({
    sourceId: sourceIdSchema,
    revision: revisionSchema.optional(),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
    timeFrom: z.number().nonnegative().optional(),
    timeTo: z.number().nonnegative().optional(),
  })
  .refine((ref) => ref.to === undefined || (ref.from !== undefined && ref.to >= ref.from))
  .refine(
    (ref) => ref.timeTo === undefined || (ref.timeFrom !== undefined && ref.timeTo >= ref.timeFrom),
  );
export const recordSchema = z.object({
  type: z.enum(["belief", "exposure", "understanding", "endorsement", "confidence"]),
  statement: z.string().trim().min(1).max(1000),
  stance: z.enum(["affirm", "reject", "uncertain", "unspecified"]).default("unspecified"),
  confidence: z.number().min(0).max(1).nullable(),
  sourceRef: sourceRefSchema.optional(),
  supersedes: z.uuid().optional(),
  concepts: conceptsSchema.optional(),
});
const envelope = z.object({
  id: z.uuid(),
  time: z.iso.datetime(),
  seq: z.number().int().positive(),
});
export const eventSchema = z.union([
  envelope.extend({
    type: z.literal("source.added"),
    sourceId: sourceIdSchema,
    revision: revisionSchema,
  }),
  envelope.extend({
    type: z.literal("observation"),
    observation: recordSchema,
  }),
]);
export const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  k: z.number().int().min(1).max(limits.results).default(5),
});
export const readSchema = z
  .object({
    sourceId: sourceIdSchema,
    from: z.number().int().positive().default(1),
    to: z.number().int().positive().optional(),
  })
  .refine((value) => value.to === undefined || value.to >= value.from);
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;
export type CortexEvent = z.infer<typeof eventSchema>;
export type Observation = z.infer<typeof recordSchema>;

export function truncateBytes(text: string, bytes: number) {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  // A UTF-8 boundary is required for byte caps, including Ukrainian excerpts.
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

export const adviseSchema = z.object({
  text: z.string().trim().min(1).max(limits.sourceBytes),
  concepts: conceptsSchema.min(1).optional(),
});
export const graphSchema = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(5).default(5),
});
