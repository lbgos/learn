import type {
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { cn } from "~/lib/utils";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  /** In the page flow (learn reader, whose slide starts under it) instead of floating over the timeline's top. */
  inline: boolean;
  providerStatus: ServerProvider | null;
  providerStatusBannerKey: string | null;
  setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    inline,
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  return (
    <div
      className={cn(
        "pointer-events-none flex flex-col",
        inline
          ? "learn-banner-lane mx-auto w-full max-w-(--chat-content-max-width) empty:hidden [&>*]:mx-0 [&>*]:max-w-[33rem]"
          : "chat-banner-lane absolute top-0 z-30",
      )}
    >
      <ProviderStatusBanner
        status={providerStatus}
        onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
    </div>
  );
}
