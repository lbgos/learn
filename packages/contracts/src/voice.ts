import * as Schema from "effect/Schema";

export const VoiceBackend = Schema.Literals(["stt", "tts"]);
export const VoiceErrorReason = Schema.Literals([
  "unreachable",
  "timeout",
  "protocol",
  "empty",
  "too-long",
]);
export const VoiceErrorResponse = Schema.Struct({
  error: Schema.Struct({ backend: VoiceBackend, reason: VoiceErrorReason, message: Schema.String }),
});
export const VoiceTranscribeQuery = Schema.Struct({
  language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
/** Nemotron on the GPU host first, the Wyoming Whisper endpoint when it fails. */
export const VoiceSttBackend = Schema.Literals(["nemotron", "whisper"]);
export const VoiceTranscript = Schema.Struct({ text: Schema.String, backend: VoiceSttBackend });
export type VoiceTranscript = typeof VoiceTranscript.Type;
export const VoiceSynthesizeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4000)),
  voice: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type VoiceSynthesizeInput = typeof VoiceSynthesizeInput.Type;
export const VoiceBackendStatus = Schema.Struct({
  ok: Schema.Boolean,
  endpoint: Schema.String,
  detail: Schema.String,
});
/** `nemotron` is present when the server has a Nemotron host configured. */
export const VoiceStatus = Schema.Struct({
  stt: VoiceBackendStatus,
  tts: VoiceBackendStatus,
  nemotron: Schema.optionalKey(VoiceBackendStatus),
});
export type VoiceStatus = typeof VoiceStatus.Type;
