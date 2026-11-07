import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { TranscriptionSettings } from "../learn/transcripts/settings.ts";

export const VoiceConfigSchema = Schema.Struct({
  sttEndpoint: Schema.String,
  sttLanguage: Schema.String,
  ttsEndpoint: Schema.String,
  ttsVoice: Schema.String,
});
export type VoiceConfigValue = typeof VoiceConfigSchema.Type;

/**
 * Reads the current voice endpoints; called per request so Settings changes apply without a
 * restart. `nemotron` is the `transcribe_youtube` STT host, tried before the Wyoming STT endpoint.
 */
export class VoiceConfig extends Context.Service<
  VoiceConfig,
  {
    readonly get: Effect.Effect<VoiceConfigValue>;
    readonly nemotron: Effect.Effect<TranscriptionSettings | null>;
  }
>()("t3/voice/VoiceConfig") {}
export const layerStatic = (
  config: VoiceConfigValue,
  nemotron: TranscriptionSettings | null = null,
) =>
  Layer.succeed(VoiceConfig, { get: Effect.succeed(config), nemotron: Effect.succeed(nemotron) });
