import { LearnGraphError, TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { LearnStructuredError } from "../LearnStructuredGeneration.ts";

const isGraphError = Schema.is(LearnGraphError);
const isStructuredError = Schema.is(LearnStructuredError);
const isTextGenerationError = Schema.is(TextGenerationError);

/** Keep provider diagnostics in the typed cause; give the learner an actionable message. */
export function graphFailure(error: unknown) {
  if (!isGraphError(error) || error.reason !== "generation") return undefined;
  const cause = isStructuredError(error.cause) ? error.cause : undefined;
  const stage = error.operation === "audit" ? "Graph review" : "Graph extraction";
  if (cause && isTextGenerationError(cause.cause) && /timed out/i.test(cause.cause.detail))
    return { status: 504, message: `${stage} timed out waiting for the model. Try again.` };
  return {
    status: 502,
    message: cause?.problems?.length
      ? `${stage} could not validate the model's result after ${cause.attempts} attempts. Try Extract now again.`
      : `${stage} could not complete the model request. Check the ${cause?.role ?? "extraction"} model in Settings > Learning, then try again.`,
  };
}
