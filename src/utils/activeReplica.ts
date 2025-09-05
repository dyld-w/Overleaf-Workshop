// utils/activeReplica.ts
import type { LocalReplicaSCMProvider } from "../scm/localReplicaSCM";

let _active: LocalReplicaSCMProvider | undefined;

export const ActiveReplica = {
  get(): LocalReplicaSCMProvider | undefined { return _active; },
  set(rep: LocalReplicaSCMProvider | undefined) { _active = rep; }
};
