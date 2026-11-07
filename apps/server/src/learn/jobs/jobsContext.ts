import type { OrchestrationV2Run, OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const LEARN_JOBS_CONTEXT_KEY = "learn_jobs";
const SUMMARY_CHARS = 600;
const LABEL_CHARS = 120;
const MAX_FINISHED = 8;

/** Delegated tasks whose result never wakes the thread: learn jobs, and tasks whose delivery was dropped. */
export const isHeldTask = (task: OrchestrationV2Subagent) =>
  task.origin === "app_owned" && task.completionDelivery?.state === "disposed";

const finished = (status: OrchestrationV2Subagent["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

const label = (task: OrchestrationV2Subagent) =>
  (task.title ?? task.prompt).replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS);

// Job titles from LearnJobs name what the tutor shows a finished file with.
const SHOW_TOOL = { "Visual: ": "html_render", "Animation: ": "visual_show", "Sim: ": "sim_show" };
const SHOWABLE_PATH =
  /\b(?:visuals\/[a-z0-9][a-z0-9-]*\.html|sims\/[a-z0-9]+(?:[-_][a-z0-9]+)*\.sim\.js)\b/;

/** How to show a finished visual or sim job's file, or undefined for anything else. */
function showCall(task: OrchestrationV2Subagent): string | undefined {
  if (task.status !== "completed" || task.result === null) return undefined;
  const tool = Object.entries(SHOW_TOOL).find(([prefix]) => task.title?.startsWith(prefix))?.[1];
  const path = SHOWABLE_PATH.exec(task.result)?.[0];
  if (tool === undefined || path === undefined) return undefined;
  const height = tool === "html_render" ? /"height"\s*:\s*(\d+)/.exec(task.result)?.[1] : undefined;
  return `${tool}({ path: "${path}"${height === undefined ? "" : `, height: ${height}`} })`;
}

/** The `## Summary` section of a research brief, otherwise the whole result, bounded. */
export function compactJobResult(result: string): string {
  const text = (
    /^## Summary[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(result)?.[1] ?? result
  ).trim();
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS).trimEnd()}…`;
}

/**
 * Held jobs for the tutor's turn. A job finished after the previous run started is listed once,
 * at the first turn whose context was built after it finished.
 */
export function formatLearnJobsContext(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "startedAt">>;
  readonly runOrdinal: number;
}): string | undefined {
  const held = input.subagents.filter(isHeldTask);
  if (held.length === 0) return undefined;
  const since = input.runs
    .filter((run) => run.ordinal < input.runOrdinal && run.startedAt !== null)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.startedAt;
  const done = held
    .flatMap((task) =>
      finished(task.status) &&
      task.completedAt !== null &&
      (since == null || DateTime.isGreaterThanOrEqualTo(task.completedAt, since))
        ? [{ task, completedAt: task.completedAt }]
        : [],
    )
    .toSorted((left, right) => DateTime.Order(left.completedAt, right.completedAt))
    .slice(-MAX_FINISHED);
  const running = held.filter(
    (task) => task.status === "pending" || task.status === "running" || task.status === "waiting",
  );
  const listed = new Set(done.map(({ task }) => task.id));
  // Prepared files stay listed every turn, so a visual made at planning is at hand at its step.
  const prepared = held
    .filter((task) => !listed.has(task.id))
    .flatMap((task) => {
      const call = showCall(task);
      return call === undefined ? [] : [`- ${call} · ${label(task)}`];
    })
    .slice(-MAX_FINISHED);
  if (done.length === 0 && running.length === 0 && prepared.length === 0) return undefined;
  const lines: string[] = [];
  if (done.length > 0)
    lines.push(
      "Background jobs finished since your last turn. Use a result when the step needs it; task_status with its taskId returns the full text.",
    );
  for (const { task } of done) {
    const call = showCall(task);
    lines.push(
      `- ${label(task)} [${task.status}] taskId ${task.id}${call === undefined ? "" : `; show with ${call}`}`,
    );
    if (task.result !== null && task.result.trim() !== "")
      lines.push(
        ...compactJobResult(task.result)
          .split("\n")
          .map((line) => `  ${line}`),
      );
  }
  if (running.length > 0) lines.push(`Still running: ${running.map(label).join("; ")}`);
  if (prepared.length > 0)
    lines.push("Prepared earlier; show each when its step comes, once:", ...prepared);
  return lines.join("\n");
}
