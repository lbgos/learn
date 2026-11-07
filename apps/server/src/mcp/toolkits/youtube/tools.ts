import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Captions from "../../../learn/captions/YouTubeCaptions.ts";
import { CaptionResult } from "../../../learn/captions/captions.ts";
import { TranscriptResult } from "../../../learn/transcripts/format.ts";
import { YouTubeTranscription } from "../../../learn/transcripts/YouTubeTranscription.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const YouTubeCaptionsTool = Tool.make("youtube_captions", {
  description:
    "Fetch existing YouTube subtitles into transcripts/<videoId>.raw.md in this thread's Lab. Prefer manual captions, then auto captions, in English or the original language. Reuse an existing transcript. Returns only file metadata; read the file to use its text.",
  parameters: Schema.Struct({ url: Schema.String }),
  success: CaptionResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    Captions.YouTubeCaptions,
    Threads.ThreadManagementService,
    Invocation.McpInvocationContext,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const TranscribeYouTubeTool = Tool.make("transcribe_youtube", {
  description:
    "Transcribe a YouTube video from its audio into transcripts/<id>.md with timestamps, then index it in Cortex. Uses the server's Nemotron speech-to-text, or Gemini when it is unavailable. Returns the path, title, channel, duration, source, word count and indexed. Can take a few minutes; read the file to teach from it.",
  parameters: Schema.Struct({ url: Schema.String }),
  success: TranscriptResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    YouTubeTranscription,
    Threads.ThreadManagementService,
    Invocation.McpInvocationContext,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const YouTubeToolkit = Toolkit.make(YouTubeCaptionsTool, TranscribeYouTubeTool);
