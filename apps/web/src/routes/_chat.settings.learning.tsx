import { createFileRoute } from "@tanstack/react-router";
import { LearningSettingsPanel } from "../components/settings/LearningSettings";

export const Route = createFileRoute("/_chat/settings/learning")({
  component: LearningSettingsPanel,
});
