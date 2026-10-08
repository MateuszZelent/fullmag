import { useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  composeAntennaSpectrumRequest,
  emptyAntennaSpectrumDraft,
  type AntennaSpectrumDraft,
} from "./AntennaSpectrumComposerModel";

interface Props {
  stageId: string;
  scene: SceneResource | null;
  status: string;
  refetch: () => void;
}

export function AntennaSpectrumComposer({ stageId, scene, status, refetch }: Props) {
  const { api, resources } = useKernel();
  const [draft, setDraft] = useState<AntennaSpectrumDraft>(emptyAntennaSpectrumDraft);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const stage = scene?.antenna_field_solve_stages?.find((item) => item.id === stageId);
  if (!stage) return null;
  const revision = scene?.revision;
  const canCreate = status === "ready" && typeof revision === "number" &&
    Number.isSafeInteger(revision) && revision >= 0 && !pending &&
    revision !== conflictRevision && (awaitingRevision === null || revision >= awaitingRevision);

  function update(patch: Partial<AntennaSpectrumDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFeedback(null);
  }

  async function create() {
    if (!scene || !canCreate || typeof revision !== "number") return;
    try {
      const request = composeAntennaSpectrumRequest(scene, stageId, draft);
      setPending(true);
      setFeedback(null);
      const response = await api.model.commitTransaction({
        base_revision: revision,
        kind: "merge_patch",
        merge_patch: {
          antenna_spectrum_requests: [
            ...(scene.antenna_spectrum_requests ?? []) as unknown as JsonObject[], request,
          ],
        },
      });
      resources.invalidate(MODEL_SCENE_PATH, response.scene_revision);
      resources.invalidate(MODEL_READINESS_PATH, response.scene_revision);
      setAwaitingRevision(response.scene_revision);
      setFeedback({ kind: "success", message: `Source FFT request ${request.id} committed. Execute the field-solve stage and spectrum analysis to publish results.` });
    } catch (error) {
      const isConflict = (error as { status?: number })?.status === 409;
      if (isConflict) setConflictRevision(revision);
      setFeedback({
        kind: "error",
        message: isConflict
          ? "Scene revision conflict. Refetch and review the FFT request before retrying."
          : error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  return <InspectorGroup title="Author structured spatial FFT">
    <FeedbackBanner kind="warning" message="This analyzes the per-ampere antenna field basis, not the spin-wave response. FEM element sampling requires a qualified tet4 field carrier." />
    <FormField label="FFT target object" type="select" value={draft.targetObjectId} onChange={(event) => update({ targetObjectId: event.currentTarget.value })}>
      <option value="">Select target object</option>
      {(scene?.objects ?? []).map((object) => <option key={object.id} value={object.id}>{object.name || object.id} ({object.id})</option>)}
    </FormField>
    <FormField label="Plane origin" unit="m" hint="Three SI coordinates; centre of the sampled plane." value={draft.originM} onChange={(event) => update({ originM: event.currentTarget.value })} />
    <FormField label="Axis u" hint="Three components of a unit vector." value={draft.axisU} onChange={(event) => update({ axisU: event.currentTarget.value })} />
    <FormField label="Axis v" hint="Unit vector orthogonal to axis u." value={draft.axisV} onChange={(event) => update({ axisV: event.currentTarget.value })} />
    <FormField label="Extent u" unit="m" value={draft.extentUM} onChange={(event) => update({ extentUM: event.currentTarget.value })} />
    <FormField label="Extent v" unit="m" value={draft.extentVM} onChange={(event) => update({ extentVM: event.currentTarget.value })} />
    <FormField label="Samples u" value={draft.samplesU} onChange={(event) => update({ samplesU: event.currentTarget.value })} />
    <FormField label="Samples v" value={draft.samplesV} onChange={(event) => update({ samplesV: event.currentTarget.value })} />
    <FormField label="Window" type="select" value={draft.windowKind} onChange={(event) => update({ windowKind: event.currentTarget.value as AntennaSpectrumDraft["windowKind"] })}>
      <option value="rectangular">Rectangular</option><option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option>
    </FormField>
    <FormField label="Normalization" type="select" value={draft.normalization} onChange={(event) => update({ normalization: event.currentTarget.value as AntennaSpectrumDraft["normalization"] })}>
      <option value="integral_si">Integral SI</option><option value="unitary_discrete">Unitary discrete</option>
    </FormField>
    <FormField label="Component" type="select" value={draft.component} onChange={(event) => update({ component: event.currentTarget.value as AntennaSpectrumDraft["component"] })}>
      <option value="x">Hx</option><option value="y">Hy</option><option value="z">Hz</option><option value="u">Hu</option><option value="v">Hv</option><option value="normal">Hnormal</option><option value="vector_power">Vector power</option>
    </FormField>
    <FormField label="Outside domain" type="select" value={draft.outsidePolicy} onChange={(event) => update({ outsidePolicy: event.currentTarget.value as AntennaSpectrumDraft["outsidePolicy"] })}>
      <option value="error">Fail request</option><option value="zero">Zero outside samples</option>
    </FormField>
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {conflictRevision === revision ? <Button type="button" disabled={pending} onClick={refetch}>Refetch Scene</Button> : null}
    <Button type="button" disabled={!canCreate} onClick={() => void create()}>Create source FFT request</Button>
  </InspectorGroup>;
}
