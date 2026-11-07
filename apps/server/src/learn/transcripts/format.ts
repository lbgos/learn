import * as Schema from "effect/Schema";

/** One timestamped transcript line, in seconds from the start of the video. */
export interface TranscriptLine {
  readonly start: number;
  readonly text: string;
}

export const TranscriptSource = Schema.Literals(["nemotron", "gemini"]);
export type TranscriptSource = typeof TranscriptSource.Type;

export const TranscriptResult = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  channel: Schema.String,
  duration: Schema.String,
  source: TranscriptSource,
  words: Schema.Number,
  indexed: Schema.Boolean,
  /** One line when indexed is false; omitted otherwise. */
  warning: Schema.optional(Schema.String),
});
export type TranscriptResult = typeof TranscriptResult.Type;

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function stamp(seconds: number) {
  if (!Number.isFinite(seconds)) throw new Error("Invalid timestamp");
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${String(minutes).padStart(2, "0")}:${rest}`;
}

/** Groups cues into one line per 15 seconds, like the caption transcript format. */
export function toLines(segments: ReadonlyArray<TranscriptLine>) {
  const lines: Array<{ start: number; parts: string[] }> = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const last = lines.at(-1);
    if (last && segment.start - last.start < 15) last.parts.push(text);
    else lines.push({ start: segment.start, parts: [text] });
  }
  return lines.map((line) => ({ start: line.start, text: line.parts.join(" ") }));
}

export function wordCount(lines: ReadonlyArray<TranscriptLine>) {
  return lines.reduce(
    (total, line) => total + line.text.split(/\s+/u).filter((word) => word.length > 0).length,
    0,
  );
}

export function formatTranscript(input: {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly durationSeconds: number;
  readonly source: TranscriptSource;
  readonly lines: ReadonlyArray<TranscriptLine>;
}) {
  const title = input.title.replace(/\s+/gu, " ").trim();
  const channel = input.channel.replace(/\s+/gu, " ").trim();
  if (!title || !channel) throw new Error("Missing video title or channel");
  const body = input.lines.map((line) => `[${stamp(line.start)}] ${line.text}`).join("\n");
  if (!body) throw new Error("Empty transcript");
  return `# ${title}\nchannel: ${channel} | url: https://www.youtube.com/watch?v=${input.id} | duration: ${stamp(input.durationSeconds)}\nsource: ${sourceLabel(input.source)}\n\n${body}\n`;
}

function sourceLabel(source: TranscriptSource) {
  return source === "nemotron" ? "nemotron 3.5 transcribe (word timestamps)" : "gemini transcribe";
}

const HEADER =
  /^# (.+)\r?\nchannel: (.+) \| url: https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11}) \| duration: ((?:\d+:)?\d+:\d{2})\r?\n(?:source: ([^\n]*)\r?\n)?/u;

/** Reads back a transcript this module wrote, for reuse and for validating a child's file. */
export function parseTranscript(content: string) {
  const match = HEADER.exec(content);
  if (!match) return undefined;
  const [, title, channel, id, duration, source = ""] = match;
  const body = content.slice(match[0].length);
  const lines = body.split("\n").flatMap((line) => {
    const cue = /^\[((?:\d+:)?\d{2}:\d{2})\] (\S.*)$/u.exec(line);
    if (!cue) return [];
    const parts = cue[1]!.split(":").map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return [{ start: seconds, text: cue[2]! }];
  });
  if (!lines.length) return undefined;
  const fromSource: TranscriptSource = /^nemotron/u.test(source) ? "nemotron" : "gemini";
  return {
    id: id!,
    title: title!,
    channel: channel!,
    duration: duration!,
    source: fromSource,
    lines,
    words: wordCount(lines),
  };
}

/** Splits at whole seconds so each request stays under the STT server's audio limit. */
export function planChunks(durationSeconds: number, maxSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error("Invalid video duration");
  if (maxSeconds <= 0) throw new Error("Invalid chunk length");
  const total = Math.ceil(durationSeconds);
  const chunks: Array<{ start: number; seconds: number }> = [];
  for (let start = 0; start < total; start += maxSeconds)
    chunks.push({ start, seconds: Math.min(maxSeconds, total - start) });
  return chunks;
}

/** One cue from the video's own caption track, in seconds from the start of the video. */
export interface CaptionCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A transcript whose content words mostly appear in the captions is the same speech. */
const MIN_CAPTION_OVERLAP = 0.5;
const MIN_CAPTION_WORDS = 20;
const MIN_TRANSCRIPT_WORDS = 10;

/** Function words survive any repartitioning; words of four or more letters carry the content. */
const contentWords = (text: string) =>
  text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}']{3,}/gu) ?? [];

/**
 * Share of a chunk's content words that the video's captions also contain for the same window,
 * or undefined when either side has too few words to judge. Fabricated text scores near zero.
 */
export function captionOverlap(
  captions: ReadonlyArray<CaptionCue>,
  start: number,
  seconds: number,
  text: string,
) {
  const reference = new Map<string, number>();
  let captionWords = 0;
  for (const cue of captions) {
    if (cue.end <= start || cue.start >= start + seconds) continue;
    for (const word of contentWords(cue.text)) {
      reference.set(word, (reference.get(word) ?? 0) + 1);
      captionWords += 1;
    }
  }
  const said = contentWords(text);
  if (said.length < MIN_TRANSCRIPT_WORDS || captionWords < MIN_CAPTION_WORDS) return undefined;
  let hits = 0;
  for (const word of said) {
    const left = reference.get(word) ?? 0;
    if (left === 0) continue;
    hits += 1;
    reference.set(word, left - 1);
  }
  return hits / said.length;
}

/**
 * Whether a chunk's text is plausibly what the video says. Missing captions or thin text means we
 * cannot tell, which passes; only a clearly low overlap fails.
 */
export function matchesCaptions(
  captions: ReadonlyArray<CaptionCue>,
  start: number,
  seconds: number,
  text: string,
) {
  const overlap = captionOverlap(captions, start, seconds, text);
  return overlap === undefined || overlap >= MIN_CAPTION_OVERLAP;
}

const NemotronSegment = Schema.Struct({
  start: Schema.Number,
  text: Schema.String,
});
const NemotronWord = Schema.Struct({
  word: Schema.String,
  start: Schema.Number,
});
export const NemotronReply = Schema.Struct({
  text: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  segments: Schema.optional(Schema.Array(NemotronSegment)),
  words: Schema.optional(Schema.Array(NemotronWord)),
});

/** Segments when the server returns them, else words regrouped into one-second cues. */
export function replySegments(reply: typeof NemotronReply.Type): ReadonlyArray<TranscriptLine> {
  if (reply.segments?.length)
    return reply.segments.map((segment) => ({ start: segment.start, text: segment.text }));
  if (reply.words?.length) {
    const lines: Array<{ start: number; parts: string[] }> = [];
    for (const word of reply.words) {
      const last = lines.at(-1);
      if (last && word.start - last.start < 15) last.parts.push(word.word);
      else lines.push({ start: word.start, parts: [word.word] });
    }
    return lines.map((line) => ({ start: line.start, text: line.parts.join(" ") }));
  }
  throw new Error("The STT server returned no timestamped text.");
}
