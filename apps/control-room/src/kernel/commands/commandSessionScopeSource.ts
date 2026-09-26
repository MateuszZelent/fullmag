import type { LiveStatusResource } from "../api/apiTypes";
import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeStore,
} from "../resources/ResourceRuntimeStore";
import {
  sessionRequestScopeKey,
  sessionResourceIdentityFromStatus,
} from "../resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import type { CommandSessionScopeSource } from "./CommandRegistry";

type CommandSessionScopeRuntimeStore = Pick<
  ResourceRuntimeStore,
  "getSnapshot" | "subscribe"
>;

/**
 * Adapts the shared session-status resource to the command registry's
 * contextual scope source. The runtime store remains the single source of
 * truth; this adapter does not mirror status or session identity locally.
 */
export function createCommandSessionScopeSource(
  runtimeStore: CommandSessionScopeRuntimeStore = sharedResourceRuntimeStore,
): CommandSessionScopeSource {
  return {
    getScopeKey: () => {
      const status = runtimeStore.getSnapshot<LiveStatusResource>(
        SESSION_STATUS_RESOURCE_KEY,
      ).data;
      return sessionRequestScopeKey(sessionResourceIdentityFromStatus(status));
    },
    subscribe: (listener) =>
      runtimeStore.subscribe(SESSION_STATUS_RESOURCE_KEY, listener),
  };
}
