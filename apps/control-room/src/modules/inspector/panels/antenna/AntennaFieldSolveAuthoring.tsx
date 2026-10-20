import { useState, useSyncExternalStore } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { createInspectorEditSessionStore, InspectorEditSessionProvider, useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { AntennaProjectionDriveComposer } from "./AntennaProjectionDriveComposer";
import { AntennaSpectrumComposer } from "./AntennaSpectrumComposer";
import { AntennaSolveTargetsEditor } from "./AntennaSolveTargetsEditor";

interface Props {
  objectId: string; stageId: string; scene: SceneResource | null;
  sceneScopeKey: string | null; status: string; refetch: () => void;
}
const serverVersion = () => 0;

/** Each form owns its local session; the Inspector sees one combined guard. */
export function AntennaFieldSolveAuthoring(props: Props) {
  const [targets] = useState(createInspectorEditSessionStore);
  const [projection] = useState(createInspectorEditSessionStore);
  const [spectrum] = useState(createInspectorEditSessionStore);
  useSyncExternalStore(spectrum.subscribe, spectrum.getVersion, serverVersion);
  useSyncExternalStore(targets.subscribe, targets.getVersion, serverVersion);
  useSyncExternalStore(projection.subscribe, projection.getVersion, serverVersion);
  const sessions = [targets.getCurrentSession(), projection.getCurrentSession(), spectrum.getCurrentSession()].filter(session => session !== null);
  const dirty = sessions.filter(session => session.dirty);
  const applying = sessions.some(session => session.applying);
  const single = dirty.length === 1 ? dirty[0] : null;
  const reason = dirty.length > 1 ? "Save each edited form locally. Then review and explicitly rebase the remaining draft."
    : single?.applyBlockReason;
  useRegisterInspectorEditSession("staged", applying, dirty.length > 0,
    Boolean(single?.valid && !single.lockReason && !reason), single?.lockReason,
    () => single && !applying ? single.apply() : false,
    async () => { if (!applying) for (const session of sessions) await session.reset(); },
    { historyMode: "mutation-owned", applyBlockReason: reason });
  return <>
    <InspectorEditSessionProvider store={targets}><AntennaSolveTargetsEditor {...props} /></InspectorEditSessionProvider>
    <InspectorEditSessionProvider store={projection}><AntennaProjectionDriveComposer {...props} /></InspectorEditSessionProvider>
    <InspectorEditSessionProvider store={spectrum}><AntennaSpectrumComposer {...props} /></InspectorEditSessionProvider>
  </>;
}
