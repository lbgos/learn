import { createFileRoute } from "@tanstack/react-router";
import { LearnMemorySettingsPanel } from "../learn/LearnMemorySettings";

export const Route = createFileRoute("/_chat/settings/memory")({
  component: LearnMemorySettingsPanel,
});
