import { createFileRoute, redirect } from "@tanstack/react-router";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";

export const Route = createFileRoute("/_chat/settings/source-control")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/learning", replace: true });
  },
  component: SourceControlSettingsPanel,
});
