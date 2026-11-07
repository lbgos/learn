import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const LearnRole = Schema.Literals([
  "tutor",
  "planning",
  "practice",
  "research",
  "transcript",
  "developer",
  "visual",
  "review",
  "extraction",
  "audit",
]);
export type LearnRole = typeof LearnRole.Type;

export const LEARN_ROLE_PARENT: Readonly<Record<LearnRole, LearnRole | null>> = {
  tutor: null,
  planning: "tutor",
  practice: "tutor",
  research: "tutor",
  transcript: "research",
  developer: "tutor",
  visual: "developer",
  review: "tutor",
  extraction: "review",
  audit: "review",
};

export const LEARN_ROLE_USE: Readonly<Record<LearnRole, string>> = {
  tutor: "Teaching; new sessions start here",
  planning: "Opening questions and the plan",
  practice: "Problems, hints and grading",
  research: "Sources the tutor looks up",
  transcript: "YouTube transcripts when captions are missing",
  developer: "Simulations and other code",
  visual: "Visuals; needs a model that reads images",
  review: "Reviews and tests of built work",
  extraction: "Builds the graph from sessions and notes",
  audit: "Checks the graph",
};

const Route = Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null)));
export const LearnRoutes = Schema.Struct({
  tutor: Route,
  planning: Route,
  practice: Route,
  research: Route,
  transcript: Route,
  developer: Route,
  visual: Route,
  review: Route,
  extraction: Route,
  audit: Route,
});
export type LearnRoutes = typeof LearnRoutes.Type;

/** Null routes use these selections before following the role's parent. */
export const DEFAULT_LEARN_ROUTES: LearnRoutes = {
  tutor: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  planning: null,
  practice: null,
  research: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  transcript: {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-high",
  },
  developer: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  visual: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  review: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  extraction: null,
  audit: null,
};

/** The saved or default selection for a role, following parents; undefined when all are unset. */
export function resolveLearnRoute(
  routes: LearnRoutes,
  role: LearnRole,
): ModelSelection | undefined {
  let cursor: LearnRole | null = role;
  while (cursor !== null) {
    const selection = routes[cursor] ?? DEFAULT_LEARN_ROUTES[cursor];
    if (selection !== null) return selection;
    cursor = LEARN_ROLE_PARENT[cursor];
  }
  return undefined;
}

export const LearnGraphSettings = Schema.Struct({
  extraction: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  extractionChunkTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(500)).pipe(
    Schema.withDecodingDefault(Effect.succeed(8192)),
  ),
  tutorGraphTools: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type LearnGraphSettings = typeof LearnGraphSettings.Type;

const TcpEndpoint = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!/^tcp:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s/:?#@]+):[0-9]+$/.test(value)) return false;
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      return port >= 1 && port <= 65535;
    },
    { message: "Expected tcp://host:port with a port from 1 to 65535" },
  ),
);

export const LearnVoiceSettings = Schema.Struct({
  sttEndpoint: TcpEndpoint.pipe(
    Schema.withDecodingDefault(Effect.succeed("tcp://127.0.0.1:10300")),
  ),
  sttLanguage: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  ttsEndpoint: TcpEndpoint.pipe(
    Schema.withDecodingDefault(Effect.succeed("tcp://127.0.0.1:10800")),
  ),
  ttsVoice: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("af_heart"))),
  readAloud: Schema.Literals(["off", "manual", "auto"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("manual")),
  ),
});
export type LearnVoiceSettings = typeof LearnVoiceSettings.Type;

export const LearnSettings = Schema.Struct({
  routes: LearnRoutes.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  graph: LearnGraphSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  voice: LearnVoiceSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type LearnSettings = typeof LearnSettings.Type;

// Patches have no defaults: absent keys keep their current values, null restores inheritance.
export const LearnSettingsPatch = Schema.Struct({
  routes: Schema.optionalKey(
    Schema.Struct({
      tutor: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      planning: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      practice: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      research: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      transcript: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      developer: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      visual: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      review: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      extraction: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      audit: Schema.optionalKey(Schema.NullOr(ModelSelection)),
    }),
  ),
  graph: Schema.optionalKey(
    Schema.Struct({
      extraction: Schema.optionalKey(Schema.Boolean),
      extractionChunkTokens: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(500)),
      ),
      tutorGraphTools: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  voice: Schema.optionalKey(
    Schema.Struct({
      sttEndpoint: Schema.optionalKey(TcpEndpoint),
      sttLanguage: Schema.optionalKey(Schema.String),
      ttsEndpoint: Schema.optionalKey(TcpEndpoint),
      ttsVoice: Schema.optionalKey(Schema.String),
      readAloud: Schema.optionalKey(Schema.Literals(["off", "manual", "auto"])),
    }),
  ),
});
export type LearnSettingsPatch = typeof LearnSettingsPatch.Type;
