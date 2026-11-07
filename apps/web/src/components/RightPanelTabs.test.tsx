import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it } from "vite-plus/test";
import { RightPanelTabs } from "./RightPanelTabs";

it("renders the board and simulation tabs", () => {
  const html = renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[
        { id: "board:main", kind: "whiteboard", name: "main" },
        { id: "sim:sims/pendulum.sim.js", kind: "simulation", path: "sims/pendulum.sim.js" },
      ]}
      environmentId={null}
      activeSurfaceId="board:main"
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddBrowserInProfile={() => undefined}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddPullRequests={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddDevice={() => undefined}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
  expect(html).toContain(">Board<");
  expect(html).toContain(">Sim<");
  expect(html).toContain("content");
});
