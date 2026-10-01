import type { LiveStatusResource, SessionListResource } from "../api/apiTypes";
import { SESSIONS_PATH } from "../api/apiPaths";
import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeStore,
} from "../resources/ResourceRuntimeStore";
import {
  sessionRequestScopeKey,
  sessionResourceIdentityFromStatus,
  confirmedSessionResourceIdentity,
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
      const collection = runtimeStore.getSnapshot<SessionListResource>(SESSIONS_PATH).data;
      if (!collection || collection.sessions.length === 0) return null;
      const status = runtimeStore.getSnapshot<LiveStatusResource>(
        SESSION_STATUS_RESOURCE_KEY,
      ).data;
      return sessionRequestScopeKey(confirmedSessionResourceIdentity(sessionResourceIdentityFromStatus(status), collection));
    },
    subscribe: (listener) => {
      const unsubscribeStatus = runtimeStore.subscribe(SESSION_STATUS_RESOURCE_KEY, listener);
      const unsubscribeCollection = runtimeStore.subscribe(SESSIONS_PATH, listener);
      return () => { unsubscribeStatus(); unsubscribeCollection(); };
    },
  };
}
