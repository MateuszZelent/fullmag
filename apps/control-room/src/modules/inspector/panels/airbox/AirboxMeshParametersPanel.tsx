"use client";

import { useMemo, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { AirboxFieldRow as FieldRow, boundedDisplayText } from "./airboxDisplay";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "../inspectorDraftState";
import {
  AIRBOX_GRADING_MODES,
  airboxMeshPolicyDraftDirty,
  buildAirboxMeshPolicyReplaceRequest,
  defaultUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftIdentityKeyForUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  type AirboxMeshPolicyDraft,
  type AirboxMeshPolicyLane,
} from "./airboxMeshPolicyDraft";
import type { MeshUniverseConfigReplaceRequest, MeshUniverseConfigResource } from "@/kernel/api/apiTypes";

type Feedback = { kind: "error" | "success"; message: string } | null;

export async function submitAirboxPolicyDraft(
  draft: AirboxMeshPolicyDraft,
  replace: (request: MeshUniverseConfigReplaceRequest) => Promise<MeshUniverseConfigResource>,
  options: { lane?: AirboxMeshPolicyLane } = {},
): Promise<
  | { error: string; kind: "error" }
  | { kind: "noop" }
  | { kind: "submitted"; resource: MeshUniverseConfigResource }
> {
  const result = buildAirboxMeshPolicyReplaceRequest(draft, options);
  if ("error" in result) return { error: result.error, kind: "error" };
  if (result.request === null) return { kind: "noop" } as const;
  return { kind: "submitted", resource: await replace(result.request) } as const;
}
type AirboxMeshPolicyTextKey = Exclude<
  keyof AirboxMeshPolicyDraft,
  "airboxGradingAuthored" | "authoredConfigPresent"
>;

const NUMBER_FIELDS: readonly {
  key: AirboxMeshPolicyTextKey;
  label: string;
  unit?: string;
}[] = [
  { key: "airboxHmax", label: "Maximum element size", unit: "m" },
  { key: "airboxHmin", label: "Minimum element size", unit: "m" },
  { key: "airboxGrowthRate", label: "Maximum element growth rate" },
  { key: "curvatureFactor", label: "Curvature factor" },
  { key: "narrowRegionResolution", label: "Resolution of narrow regions" },
];

const VECTOR_FIELDS: readonly {
  key: AirboxMeshPolicyTextKey;
  label: string;
}[] = [
  { key: "paddingX", label: "Padding X" },
  { key: "paddingY", label: "Padding Y" },
  { key: "paddingZ", label: "Padding Z" },
  { key: "airboxSizeX", label: "Size X" },
  { key: "airboxSizeY", label: "Size Y" },
  { key: "airboxSizeZ", label: "Size Z" },
  { key: "airboxCenterX", label: "Center X" },
  { key: "airboxCenterY", label: "Center Y" },
  { key: "airboxCenterZ", label: "Center Z" },
];

const EFFECTIVE_FIELDS = [
  ["mode", "Effective domain mode"],
  ["airbox_hmax", "Effective maximum element size"],
  ["airbox_hmin", "Effective minimum element size"],
  ["airbox_growth_rate", "Effective growth rate"],
  ["airbox_grading", "Effective grading"],
  ["padding", "Effective padding"],
  ["size", "Effective size"],
  ["center", "Effective center"],
] as const;

const FDM_EFFECTIVE_FIELDS = EFFECTIVE_FIELDS.filter(([key]) =>
  ["mode", "padding", "size", "center"].includes(key),
);

const displayEffectiveValue = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : value == null ? "not published" : String(value);

export type AirboxMeshParametersLane = "fem" | "fdm";

export function AirboxMeshParametersPanel({
  lane = "fem",
  selection,
}: InspectorPanelProps & { lane?: AirboxMeshParametersLane }) {
  void selection;
  const isFdm = lane === "fdm";
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const policy = useUniverseMeshPolicyResource();
  const resource = policy.data ?? defaultUniverseMeshPolicyResource();
  const baseDraft = useMemo(
    () => draftFromUniverseMeshPolicyResource(resource),
    [resource],
  );
  const baseKey = draftKeyForUniverseMeshPolicyResource(resource);
  const identityKey = draftIdentityKeyForUniverseMeshPolicyResource();
  const [draftState, setDraftState] = useState<
    InspectorDraftState<AirboxMeshPolicyDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey,
      identityKey,
    }),
  );
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const { dirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey,
    identityKey,
    isDirty: airboxMeshPolicyDraftDirty,
    state: draftState,
  });
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sourceDetail: "airbox-mesh-parameters",
      }),
    [kernel],
  );

  const updateDraft = (patch: Partial<AirboxMeshPolicyDraft>) =>
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey,
        currentDraft: draft,
        identityKey,
        isDirty: airboxMeshPolicyDraftDirty,
        patch,
      }),
    );

  const applyPolicy = async ({ silent = false } = {}) => {
    setPending(true);
    try {
      const submission = await submitAirboxPolicyDraft(
        draft,
        (request) => api.meshing.replaceUniversePolicy(request),
        { lane },
      );
      if (submission.kind === "error") {
        setFeedback({ kind: "error", message: submission.error });
        return false;
      }
      if (submission.kind === "noop") {
        if (!silent) setFeedback({ kind: "success", message: "No authored Airbox policy changes to apply." });
        return true;
      }
      const next = submission.resource;
      resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, next.revision);
      if (!silent) {
        setFeedback({
          kind: "success",
          message: isFdm
            ? "Canonical Airbox policy saved for FDM. Re-run or re-plan the study to materialize the new structured grid."
            : "Canonical Airbox policy saved. The realized shared-domain mesh is stale until rebuilt.",
        });
      }
      return true;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: boundedDisplayText(error instanceof Error ? error.message : String(error)) ?? "Backend request failed.",
      });
      return false;
    } finally {
      setPending(false);
    }
  };

  const build = async () => {
    if (dirty && !(await applyPolicy({ silent: true }))) return;
    try {
      await commands.execute("mesh.build-shared-domain", commandContext);
      setFeedback({ kind: "success", message: "Shared-domain mesh build submitted." });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: boundedDisplayText(error instanceof Error ? error.message : String(error)) ?? "Backend request failed.",
      });
    }
  };

  const revert = () => {
    setDraftState(initialInspectorDraftState({ baseDraft, baseKey, identityKey }));
    setFeedback(null);
  };

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Canonical Authored Parameters" badge="Python round-trip">
        <FieldRow label="Policy revision" value={String(resource.revision)} />
        {!isFdm ? (
          <>
            {NUMBER_FIELDS.map(({ key, label, unit }) => (
              <FormField
                key={key}
                label={label}
                type="number"
                unit={unit}
                value={draft[key]}
                onChange={(event) => updateDraft({ [key]: event.target.value })}
              />
            ))}
            <FormField
              label="Element grading"
              type="select"
              value={draft.airboxGrading}
              onChange={(event) =>
                updateDraft({
                  airboxGrading: event.target.value as AirboxMeshPolicyDraft["airboxGrading"],
                  airboxGradingAuthored: true,
                })
              }
            >
              {AIRBOX_GRADING_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </FormField>
          </>
        ) : (
          <FieldRow
            label="FDM policy scope"
            value="Structured-grid universe geometry"
          />
        )}
      </InspectorGroup>
      <InspectorGroup title="Canonical Airbox Geometry" badge="Python round-trip">
        <FormField
          label="Domain mode"
          type="select"
          value={draft.airboxMode}
          onChange={(event) => updateDraft({ airboxMode: event.target.value })}
        >
          <option value="">Inherited</option>
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </FormField>
        {VECTOR_FIELDS.map(({ key, label }) => (
          <FormField
            key={key}
            label={label}
            type="number"
            unit="m"
            value={draft[key]}
            onChange={(event) => updateDraft({ [key]: event.target.value })}
          />
        ))}
      </InspectorGroup>
      <InspectorGroup title="Backend-effective Values" badge="read-only">
        <FieldRow label="Source" value="effective_config published by backend" />
        {(isFdm ? FDM_EFFECTIVE_FIELDS : EFFECTIVE_FIELDS).map(([key, label]) => (
          <FieldRow key={key} label={label} value={displayEffectiveValue(resource.effective_config?.[key])} />
        ))}
        <FieldRow
          label="Unknown effective keys"
          value={String(Object.keys(resource.effective_config ?? {}).filter((key) => !EFFECTIVE_FIELDS.some(([known]) => known === key)).length)}
        />
        <FieldRow label="Effective key count" value={String(Object.keys(resource.effective_config ?? {}).length)} />
      </InspectorGroup>
      {!isFdm ? (
        <InspectorGroup title="Advanced Authored Policy JSON" badge="Python round-trip" collapsible defaultOpen={false}>
          <FormField
            label="Advanced universe policy JSON"
            rows={8}
            type="textarea"
            value={draft.configText}
            onChange={(event) => updateDraft({ configText: event.target.value })}
          />
        </InspectorGroup>
      ) : null}
      <InspectorGroup title="Transactions">
        {isFdm ? (
          <FeedbackBanner
            kind="warning"
            message="FDM policy changes apply to the next run; re-run or re-plan the study after applying."
          />
        ) : null}
        {dirty ? (
          <FeedbackBanner
            kind="warning"
            message={
              isFdm
                ? "Unapplied changes. Apply Airbox Policy, then re-run or re-plan the study."
                : "Unapplied changes. Apply Airbox Policy or Apply & Build before trusting the current Airbox mesh."
            }
          />
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button disabled={pending} size="sm" type="button" variant="primary" onClick={() => void applyPolicy()}>
            Apply Airbox Policy
          </Button>
          {!isFdm ? (
            <Button disabled={pending} size="sm" type="button" variant="secondary" onClick={() => void build()}>
              {dirty ? "Apply & Build Shared-Domain Mesh" : "Build Shared-Domain Mesh"}
            </Button>
          ) : null}
          <Button disabled={pending} size="sm" type="button" variant="ghost" onClick={revert}>
            Revert
          </Button>
        </div>
        {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
      </InspectorGroup>
    </div>
  );
}
