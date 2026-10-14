import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND } from "@/kernel/runtime/antennaFieldSolveStudyCommand";
import { Button } from "@/shared/ui/Button";
import { antennaFieldSolveDefinitionPortError } from "@/shared/domain/study/antennaFieldSolveCapability";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";

interface Props { objectId: string; stageId: string; scene: SceneResource | null; status: string }

/** Only the port choice is local; the command owns the revisioned transaction. */
export function AntennaStudyStageComposer({ objectId, stageId, scene, status }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, objectId, stageId]);
  const token = useMemo(() => ({ key }), [key]);
  const owner = useRef<object | null>(null);
  const inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = token; return () => { owner.current = null; }; }, [token]);
  const [choice, setChoice] = useState<{ key: string; portId: string } | null>(null);
  const [pendingToken, setPendingToken] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; kind: "error" | "success"; message: string } | null>(null);
  const definitions = (scene?.antenna_field_solve_stages ?? [])
    .filter((stage) => stage.id === stageId && stage.source_object_id === objectId);
  const definition = definitions.length === 1 ? definitions[0] : null;
  const portIds = definition?.port_mode_ids ?? [];
  const capabilityError = definition ? antennaFieldSolveDefinitionPortError(portIds) : null;
  const portId = choice?.key === key ? choice.portId : portIds.length === 1 ? portIds[0] : "";
  const pending = pendingToken === token;
  const currentScene = Boolean(scope && scene?.scene?.id === identity?.sessionId && status === "ready");
  const selectedPorts = (scene?.antenna_port_modes ?? []).filter((port) => port.id === portId);
  const validPort = portIds.filter((id) => id === portId).length === 1 && selectedPorts.length === 1
    && selectedPorts[0].source_object_id === objectId
    && selectedPorts[0].current_transport_id === definition?.current_transport_id;

  async function add() {
    if (!currentScene || !validPort || capabilityError || !scope || inflight.current === token) return;
    const isCurrent = () => owner.current === token && commands.getSessionScopeKey() === scope;
    inflight.current = token;
    setPendingToken(token);
    setFeedback(null);
    try {
      const result = await commands.execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
        api, resources, authoringHistory, selection, source: "inspector",
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
        input: { objectId, stageId, portModeId: portId },
      });
      if (isCurrent() && result.status !== "cancelled") setFeedback({ key,
        kind: result.status === "completed" ? "success" : "error",
        message: result.message ?? "Field-solve command did not confirm completion.",
      });
    } catch (error) {
      if (isCurrent()) setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inflight.current === token) inflight.current = null;
      if (isCurrent()) setPendingToken(null);
    }
  }

  return <InspectorGroup title="Add field solve to Study">
    <p className="fm-inspector-hint">Select one port mode for this stage. This adds a reference, not a solved field, and does not start LLG or relaxation.</p>
    <FormField type="select" label="Stage port mode" value={portId} disabled={!currentScene || !definition || Boolean(capabilityError)}
      onChange={(event) => { setChoice({ key, portId: event.currentTarget.value }); setFeedback(null); }}>
      <option value="">Select an explicit port mode</option>
      {[...new Set(portIds)].map((id) => <option key={id} value={id}>{id}</option>)}
    </FormField>
    {!definition ? <FeedbackBanner kind="error" message="The field-solve definition is missing or ambiguous." /> : null}
    {capabilityError ? <FeedbackBanner kind="error" message={capabilityError} /> : null}
    {portId && !validPort ? <FeedbackBanner kind="error" message="The selected port must belong uniquely to this source and current transport." /> : null}
    {feedback?.key === key && !capabilityError ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <Button type="button" disabled={!currentScene || !validPort || Boolean(capabilityError) || pending} onClick={() => void add()}>Add Field Solve to Study</Button>
  </InspectorGroup>;
}
