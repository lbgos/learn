import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, MessageId, RunId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { TimelineEntry } from "../../session-logic";
import { primaryServerSettingsAtom } from "../../state/server";
import { at } from "./fixtures.test-utils";
import { LearnReader } from "./LearnReader";

const reader = vi.hoisted(() => ({
  entries: [] as TimelineEntry[],
  synthesize: vi.fn<(text: string, signal: AbortSignal) => Promise<ArrayBuffer>>(),
}));
vi.mock("../../hooks/useIncrementalTimelineEntries", () => ({
  useIncrementalTimelineEntries: () => reader.entries,
}));
vi.mock("../../voice/client", () => ({ synthesizeText: reader.synthesize }));
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");
const prose = (runId: RunId, text: string): TimelineEntry => ({
  id: runId,
  kind: "message",
  createdAt: at,
  message: {
    id: MessageId.make(runId),
    role: "assistant",
    text,
    runId,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});

function setup() {
  reader.synthesize.mockReset();
  // Synthesis stays pending, so the test can watch the request get cancelled.
  reader.synthesize.mockImplementation(() => new Promise(() => {}));
  reader.entries = [prose(run1, "Forces add."), prose(run2, "Mass resists")];
}

const registry = AtomRegistry.make({
  initialValues: [
    [
      primaryServerSettingsAtom,
      {
        ...DEFAULT_SERVER_SETTINGS,
        learn: {
          ...DEFAULT_SERVER_SETTINGS.learn,
          voice: { ...DEFAULT_SERVER_SETTINGS.learn.voice, readAloud: "auto" },
        },
      },
    ],
  ],
});
// Held, so the seeded settings survive until the reader subscribes.
registry.mount(primaryServerSettingsAtom);
type RunState = "running" | "waiting" | "settled";
/** "waiting" is the measured frame after a run's last event: no active run, not settled yet. */
const view = (run: RunState) => (
  <RegistryContext.Provider value={registry}>
    <LearnReader
      threadDetailRef={null}
      entriesInput={{ optimisticMessages: [] }}
      activeThreadKey="thread"
      working={run !== "settled"}
      runningRunId={run === "running" ? run2 : null}
      latestRunId={run2}
      latestRunSettled={run === "settled"}
      paused={false}
      pending={null}
      bottomInset={0}
      onPendingInputChange={() => {}}
      questionSlotRef={() => {}}
      onOpenSimulation={() => {}}
      onSendMessage={async () => {}}
    />
  </RegistryContext.Provider>
);

describe("learn reader read-aloud", () => {
  it("auto-reads an answer once when its run finishes on screen, never on return, and stops on leaving", async () => {
    setup();
    await using screen = await render(view("running"));
    await expect.element(screen.getByText("Mass resists")).toBeVisible();
    expect(screen.getByRole("button", { name: "Read aloud" }).query()).toBeNull();

    reader.entries = [prose(run1, "Forces add."), prose(run2, "Mass **resists** change.")];
    await screen.rerender(view("waiting"));
    expect(reader.synthesize).not.toHaveBeenCalled();
    await screen.rerender(view("settled"));
    await vi.waitFor(() => expect(reader.synthesize).toHaveBeenCalledOnce());
    const [text, signal] = reader.synthesize.mock.calls[0]!;
    expect(text).toBe("Mass resists change.");

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await expect.element(screen.getByText("Forces add.")).toBeVisible();
    expect(signal.aborted).toBe(true);
    await expect.element(screen.getByRole("button", { name: "Read aloud" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await expect.element(screen.getByText("Mass resists change.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Read aloud" })).toBeVisible();
    expect(reader.synthesize).toHaveBeenCalledOnce();
  });
});
