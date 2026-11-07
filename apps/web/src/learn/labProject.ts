import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useState } from "react";

import { physicsEnvironment } from "../physics/state";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

/** The Lab project of an environment; ensureLab is idempotent and the server runs it at boot. */
function useLabProjectId(environmentId: EnvironmentId | null): ProjectId | null {
  const connectedIds = useConnectedEnvironmentIds();
  const connected = environmentId !== null && connectedIds.includes(environmentId);
  const ensureLab = useAtomCommand(physicsEnvironment.ensureLab, { reportFailure: false });
  const [lab, setLab] = useState<{ environmentId: EnvironmentId; projectId: ProjectId } | null>(
    null,
  );
  useEffect(() => {
    if (environmentId === null || !connected) return;
    let active = true;
    void ensureLab({ environmentId, input: {} }).then((result) => {
      if (active && result._tag === "Success")
        setLab({ environmentId, projectId: result.value.projectId });
    });
    return () => {
      active = false;
    };
  }, [connected, ensureLab, environmentId]);
  return lab?.environmentId === environmentId ? lab.projectId : null;
}

/** The primary environment's Lab project, where every learn session lives; null until resolved. */
export function useLabProjectRef() {
  const environmentId = usePrimaryEnvironmentId();
  const projectId = useLabProjectId(environmentId);
  return useMemo(
    () =>
      environmentId !== null && projectId !== null
        ? scopeProjectRef(environmentId, projectId)
        : null,
    [environmentId, projectId],
  );
}
