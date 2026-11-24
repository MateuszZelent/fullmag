import { useState, useSyncExternalStore } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { createInspectorEditSessionStore, InspectorEditSessionProvider, useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { MicrostripGeometryEditor } from "./MicrostripGeometryEditor";
import { AntennaPlacementEditor } from "./AntennaPlacementEditor";

interface Props { objectId: string; scene: SceneResource | null; sceneScopeKey: string | null; status: string; refetch: () => void }
const serverVersion = () => 0;

/** Local forms keep separate drafts; the Inspector owns one aggregate guard. */
export function AntennaGeometryAuthoring(props: Props) {
  const [geometry] = useState(createInspectorEditSessionStore), [placement] = useState(createInspectorEditSessionStore);
  useSyncExternalStore(geometry.subscribe, geometry.getVersion, serverVersion);
  useSyncExternalStore(placement.subscribe, placement.getVersion, serverVersion);
  const sessions = [geometry.getCurrentSession(), placement.getCurrentSession()].filter(session => session !== null);
  const dirty = sessions.filter(session => session.dirty), applying = sessions.some(session => session.applying);
  const single = dirty.length === 1 ? dirty[0] : null;
  const reason = dirty.length > 1 ? "Save each edited form locally. Then review and explicitly rebase the remaining draft." : single?.applyBlockReason;
  useRegisterInspectorEditSession("staged", applying, dirty.length > 0,
    Boolean(single?.valid && !single.lockReason && !reason), single?.lockReason,
    () => single && !applying ? single.apply() : false,
    async () => { if (!applying) for (const session of sessions) await session.reset(); },
    { historyMode: "mutation-owned", applyBlockReason: reason });
  return <>
    <InspectorEditSessionProvider store={geometry}><MicrostripGeometryEditor {...props} /></InspectorEditSessionProvider>
    <InspectorEditSessionProvider store={placement}><AntennaPlacementEditor {...props} /></InspectorEditSessionProvider>
  </>;
}
