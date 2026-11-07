import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { physicsEnvironment } from "./state";

/**
 * A fresh install has no projects. Once the environment's project list is known to be empty,
 * create or open the Physics Lab project, so the learner lands in a workspace with no setup.
 * The server registers the project; the index route then opens a draft in it.
 */
export function useEnsurePhysicsLab(environmentId: EnvironmentId | null, noProjects: boolean) {
  const ensureLab = useAtomCommand(physicsEnvironment.ensureLab, { reportFailure: false });
  const requested = useRef<EnvironmentId | null>(null);
  useEffect(() => {
    if (environmentId === null || !noProjects || requested.current === environmentId) return;
    requested.current = environmentId;
    void ensureLab({ environmentId, input: {} }).then((result) => {
      // Allow another attempt on the next evidence change if the server was not ready.
      if (result._tag !== "Success") requested.current = null;
    });
  }, [ensureLab, environmentId, noProjects]);
}
