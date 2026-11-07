import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "vite-plus/test";

import { prependAppModelContext } from "./appModelContext.ts";

it("preserves turn text when the app context is absent or empty", () => {
  const text = "  Describe the graph.\n";
  for (const appContext of [undefined, [], [{ key: "mcp_app_empty", text: " \n" }]]) {
    assert.equal(
      prependAppModelContext({ driver: ProviderDriverKind.make("claudeAgent"), text, appContext }),
      text,
    );
  }
});

it.each([
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "acp",
  "pi",
  "muse",
  "futureDriver",
])("prepends all app entries as one compact block for %s", (driver) => {
  const actual = prependAppModelContext({
    driver: ProviderDriverKind.make(driver),
    text: "Explain what changed.",
    appContext: [
      { key: "mcp_app_sim", text: "Pendulum: L=1.5 m, damping=0.1 s^-1.\nPaused at t=2 s." },
      { key: "mcp_app_board", text: "Board main, revision 7. Selected item: user-ink-2." },
    ],
  });
  assert.equal(
    actual,
    [
      "<mcp_app_context>",
      "[mcp_app_sim]",
      "Pendulum: L=1.5 m, damping=0.1 s^-1.",
      "Paused at t=2 s.",
      "",
      "[mcp_app_board]",
      "Board main, revision 7. Selected item: user-ink-2.",
      "</mcp_app_context>",
      "",
      "Explain what changed.",
    ].join("\n"),
  );
});

it("keeps Codex turn text unchanged because it consumes native app context", () => {
  const text = "Show the selected item.";
  assert.equal(
    prependAppModelContext({
      driver: ProviderDriverKind.make("codex"),
      text,
      appContext: [{ key: "mcp_app_board", text: "Board main, revision 8." }],
    }),
    text,
  );
});
