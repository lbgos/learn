import type { ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Tooltip for an icon control; `children` is the control itself. */
export function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
