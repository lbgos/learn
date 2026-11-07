import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DeviceServiceState,
  type EnvironmentId,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  applyDeviceSnapshot,
  floatDeviceSurface,
  resetDeviceSessionBaselinesForTests,
  revealServerTabs,
  startAgentOpenedPreviews,
} from "./agentOpenedPreviews";

vi.mock("../../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);

const device = {
  hostId: "local",
  id: "pixel",
  platform: "android",
  name: "Pixel 8",
  version: "15",
  booted: true,
  physical: false,
} as const;

const session = {
  threadId: ref.threadId,
  hostId: "local",
  deviceId: "pixel",
  platform: "android",
  openedAt: "2026-01-01T00:00:00.000Z",
} as const;

const deviceState = (input: {
  readonly sessions?: ReadonlyArray<
    Omit<typeof session, "openedAt"> & { readonly openedAt: string }
  >;
  readonly devices?: ReadonlyArray<typeof device>;
}) =>
  ({
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: input.devices ?? [device],
    sessions: input.sessions ?? [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
  }) as unknown as DeviceServiceState;

const floating = { sheetLayout: false, autoShowFloatingPreview: true };

function setup() {
  resetPreviewStateForTests();
  resetDeviceSessionBaselinesForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
}

const miniPlayerSource = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;

describe("applyDeviceSnapshot", () => {
  it("treats the first snapshot as a baseline and floats sessions that start later", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("opens a session once its device summary arrives", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({}), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session], devices: [] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", name: "Pixel 8" });
  });

  it("closes a floating device when its session ends, even before a baseline", () => {
    setup();
    usePreviewMiniPlayerStore.getState().open(ref, {
      kind: "device",
      hostId: "local",
      deviceId: "pixel",
      platform: "android",
      name: "Pixel 8",
    });
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device" });

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("opens a session that ended and reopened between two snapshots", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toBeUndefined();

    const reopened = { ...session, openedAt: "2026-01-01T00:05:00.000Z" };
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [reopened] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("opens a device for a thread that had no sessions when the baseline was taken", () => {
    setup();
    const otherRef = scopeThreadRef(ref.environmentId, ThreadId.make("thread-2"));
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session, { ...session, threadId: otherRef.threadId }] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();
    expect(
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(otherRef)]?.source,
    ).toMatchObject({ kind: "device", deviceId: "pixel" });
  });
});

describe("floatDeviceSurface", () => {
  const source = {
    kind: "device",
    hostId: "local",
    deviceId: "pixel",
    platform: "android",
    name: "Pixel 8",
  } as const;

  it("floats a device with a live session, or before device state loads", () => {
    setup();
    floatDeviceSurface(ref, source, deviceState({ sessions: [session] }));
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });

    setup();
    floatDeviceSurface(ref, source, null);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("does not float a device whose session ended", () => {
    setup();
    floatDeviceSurface(ref, source, deviceState({ sessions: [] }));
    expect(miniPlayerSource()).toBeUndefined();
  });
});

describe("revealServerTabs", () => {
  const tab = (tabId: string, force?: boolean): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...(force === undefined ? {} : { revealRequest: { id: "r1", force } }),
  });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };

  it("floats revealed tabs, and only forced ones when floating previews are off", () => {
    setup();
    revealServerTabs(ref, [tab("tab_plain")], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBeNull();
    revealServerTabs(ref, [tab("tab_forced", true)], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBe("tab_forced");
  });
});

describe("startAgentOpenedPreviews", () => {
  const serverEpoch = "server-a";
  const serverTab = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId: "tab_a",
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...overrides,
  });
  const following = () => {
    setup();
    return { [Symbol.dispose]: startAgentOpenedPreviews() };
  };
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };
  it("never reveals tabs this client opened, desktop tabs, or a tab whose close failed", () => {
    using _following = following();
    const tab = serverTab({ tabId: "tab_closing" });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });
    applyPreviewServerSnapshot(ref, serverTab({ tabId: "tab_own", reveal: undefined }));
    applyPreviewServerSnapshot(ref, { ...serverTab({ tabId: "tab_desktop" }), runtime: "desktop" });
    beginPreviewSessionClose(ref, tab.tabId);
    cancelPreviewSessionClose(ref, tab, tab.tabId);
    expect(floatingTabId()).toBeNull();
  });
});
