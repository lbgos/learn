import * as Schema from "effect/Schema";

const CaptionTrack = Schema.Struct({
  baseUrl: Schema.String,
  languageCode: Schema.String,
  kind: Schema.optional(Schema.String),
});
export const Player = Schema.Struct({
  videoDetails: Schema.Struct({
    title: Schema.String,
    author: Schema.String,
    lengthSeconds: Schema.String,
  }),
  captions: Schema.Struct({
    playerCaptionsTracklistRenderer: Schema.Struct({
      captionTracks: Schema.Array(CaptionTrack),
      defaultAudioTrackIndex: Schema.optional(Schema.Number),
      audioTracks: Schema.optional(
        Schema.Array(
          Schema.Struct({
            defaultCaptionTrackIndex: Schema.optional(Schema.Number),
          }),
        ),
      ),
    }),
  }),
});
export const TimedText = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      tStartMs: Schema.Number,
      dDurationMs: Schema.optional(Schema.Number),
      segs: Schema.optional(Schema.Array(Schema.Struct({ utf8: Schema.String }))),
    }),
  ),
});
export const CaptionResult = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  duration: Schema.String,
  lineCount: Schema.Number,
  captionKind: Schema.Literals(["manual", "auto"]),
});

export function videoIdFromUrl(input: string) {
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
    throw new Error("Expected a YouTube video URL.");
  let id: string | null | undefined;
  if (url.hostname === "youtu.be") id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)
  ) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Expected a YouTube video URL.");
  return id;
}

export function selectTrack(player: typeof Player.Type) {
  const list = player.captions.playerCaptionsTracklistRenderer;
  const original =
    list.audioTracks?.[list.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex ?? 0;
  const originalLanguage = list.captionTracks[original]?.languageCode;
  const candidates = list.captionTracks.filter(
    (track) => /^en(?:-|$)/.test(track.languageCode) || track.languageCode === originalLanguage,
  );
  // The default caption track identifies the original language when English is absent.
  return (candidates.length ? candidates : list.captionTracks).toSorted(
    (a, b) =>
      Number(a.kind === "asr") - Number(b.kind === "asr") ||
      Number(/^en(?:-|$)/.test(b.languageCode)) - Number(/^en(?:-|$)/.test(a.languageCode)),
  )[0];
}

function timestamp(seconds: number) {
  if (!Number.isFinite(seconds)) throw new Error("Invalid caption timestamp or video duration.");
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function mergeCues(captions: typeof TimedText.Type) {
  const lines: Array<{ start: number; text: string }> = [];
  let line: { start: number; text: string } | undefined;
  for (const event of captions.events) {
    const text = event.segs
      ?.map((seg) => seg.utf8)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const start = event.tStartMs / 1000;
    if (line === undefined || start - line.start >= 15) {
      line = { start, text };
      lines.push(line);
    } else line.text += ` ${text}`;
  }
  return lines;
}

export function formatTranscript(
  id: string,
  player: typeof Player.Type,
  track: typeof CaptionTrack.Type,
  captions: typeof TimedText.Type,
) {
  const lines = mergeCues(captions);
  if (!lines.length) throw new Error("No caption cues.");
  const title = player.videoDetails.title.replace(/\s+/g, " ").trim();
  const channel = player.videoDetails.author.replace(/\s+/g, " ").trim();
  const duration = timestamp(Number(player.videoDetails.lengthSeconds));
  const captionKind = track.kind === "asr" ? "auto" : "manual";
  return `# ${title}\nchannel: ${channel} | url: https://www.youtube.com/watch?v=${id} | duration: ${duration}\nsource: youtube captions (${captionKind}, ${track.languageCode})\n\n${lines.map((line) => `[${timestamp(line.start)}] ${line.text}`).join("\n")}\n`;
}

export function existingResult(
  path: string,
  content: string,
): typeof CaptionResult.Type | undefined {
  const match =
    /^# (.+)\nchannel: .+ \| url: https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11} \| duration: (\d+:\d{2})\nsource: youtube captions \((manual|auto), [^\n)]+\)\n/m.exec(
      content,
    );
  const lineCount = content.split("\n").filter((line) => /^\[\d+:\d{2}\] \S/.test(line)).length;
  if (!match || !lineCount) return undefined;
  return {
    path,
    title: match[1]!,
    duration: match[2]!,
    lineCount,
    captionKind: match[3] === "auto" ? "auto" : "manual",
  };
}
