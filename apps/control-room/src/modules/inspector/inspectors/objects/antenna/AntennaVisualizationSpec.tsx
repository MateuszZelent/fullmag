"use client";

import {
  Activity,
  Eye,
  Radio,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import {
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { closedLoopManifest } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import {
  antennaInspectionDisplayMatchesOwner,
  useAntennaExternalLeadInspectionResource,
  useAntennaFieldSolutionResource,
  useAntennaInspectionDisplayResource,
  useAntennaStageOutputCatalogResource,
} from "@/kernel/resources/antennaResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { AntennaFieldIntent, AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { InspectorPropertyRow } from "../../../primitives/InspectorPropertyRow";
import type { InspectorSpec } from "../../../template";
import type { VisualizationRenderModeValue } from "../../../visualization/VisualizationInspectorControls";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import { AntennaArtifactVisualization } from "../../../panels/antenna/AntennaArtifactVisualization";
import { AntennaCameraControls } from "../../../panels/antenna/AntennaCameraControls";
import { AntennaClippingControls } from "../../../panels/antenna/AntennaClippingControls";
import {
  antennaFieldSolutionIdentityStatus,
  resolveAntennaRuntimeIds,
} from "../../../panels/antenna/AntennaCompositionRuntime";
import {
  inspectionMatchesRuntimeStage,
  inspectionSelectionMatchesContext,
  resolveInspectionRuntimeStage,
  type InspectionRuntimeSelection,
} from "../../../panels/antenna/AntennaExternalLeadInspectionModel";
import { AntennaFieldBasisPreview } from "../../../panels/antenna/AntennaFieldBasisPreview";
import type { AntennaBasisQuantity } from "../../../panels/antenna/AntennaFieldBasisPreviewModel";
import {
  antennaVisualizationPresentation,
  resolveAntennaVisualizationSelection,
} from "../../../panels/antenna/AntennaVisualizationModel";
import { resolveSelectedObjectId } from "./antennaExcitationShared";
import {
  AntennaBasisDisplayPassControls,
  AntennaSurfaceColoringControls,
  AntennaVectorGlyphControls,
  type AntennaVizHostDraft,
} from "./antennaVisualizationSections";

export function AntennaVisualizationInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource();
  const sectionState = useVisualizationStateResource();
  const clip = sectionState.optimisticData?.clip;
  const visualization = useObjectVisualizationController();
  const requested = useObjectVisualizationSelector(
    (snapshot) => snapshot.antennaFieldIntent ?? null,
  );
  const displayStatus = useObjectVisualizationSelector(
    (snapshot) => snapshot.antennaFieldDisplayStatus ?? null,
  );
  const owner = useSessionResourceIdentity();
  const execution = useStageExecutionResource();

  const activeArtifactPin = useObjectVisualizationSelector((snapshot) =>
    Boolean(snapshot.artifactFieldSelection),
  );
  const [preferredRepresentation, setPreferredRepresentation] = useState<
    "inspection" | "basis" | null
  >(null);
  const effectiveRepresentation: "inspection" | "basis" =
    preferredRepresentation ?? (activeArtifactPin && !requested ? "inspection" : "basis");

  const stages = useMemo(
    () =>
      (scene.data?.antenna_field_solve_stages ?? []).filter(
        (s) => s.source_object_id === objectId,
      ),
    [objectId, scene.data],
  );
  const [preferredStageId, setPreferredStageId] = useState("");
  const activeStage =
    stages.find((s) => s.id === preferredStageId) ?? stages[0] ?? null;
  const stageId = activeStage?.id ?? null;

  const ids = useMemo(
    () => resolveAntennaRuntimeIds("solution", stageId, scene.data),
    [scene.data, stageId],
  );
  const field = useAntennaFieldSolutionResource(ids.solutionId);
  const catalog = useAntennaStageOutputCatalogResource(ids.stageId);

  const [inspectionSelection, setInspectionSelection] =
    useState<InspectionRuntimeSelection | null>(null);
  const validInspectionSelection =
    inspectionSelection &&
    inspectionSelectionMatchesContext(
      inspectionSelection,
      stageId ?? "",
      execution.data,
      owner,
    )
      ? inspectionSelection
      : null;
  const mapping = resolveInspectionRuntimeStage(
    stageId ?? "",
    execution.data,
    owner,
    validInspectionSelection,
  );
  const executionCurrent =
    execution.status === "ready" && !execution.refreshError;
  const inspection = useAntennaExternalLeadInspectionResource(
    mapping.state === "mapped" ? mapping.runtimeStageId : null,
    { pauseLoad: !executionCurrent },
  );

  const [quantity, setQuantity] = useState<AntennaFieldQuantity>(
    "magnetic_field_per_ampere",
  );
  const [preferredPort, setPreferredPort] = useState("");
  const [displaySource, setDisplaySource] = useState("basis");

  const validation = activeStage
    ? antennaStageValidationMessages(activeStage, scene.data)
    : ["No configured antenna field-solve stage"];
  const identityStatus = antennaFieldSolutionIdentityStatus(ids, field, catalog);
  const sourceMatches =
    field.data?.source_object_id === objectId &&
    field.data?.current_transport_id === activeStage?.current_transport_id;
  const ownerMatches = Boolean(
    owner &&
      field.data?.session_id === owner.sessionId &&
      field.data?.session_epoch === owner.sessionEpoch &&
      field.data?.request_scope_epoch === owner.requestScopeEpoch,
  );
  const basisAvailable =
    scene.status === "ready" &&
    validation.length === 0 &&
    identityStatus === "ready" &&
    sourceMatches &&
    ownerMatches;

  const raw = inspection.data;
  const closed = raw ? closedLoopManifest(raw) : null;
  const rawManifest = closed ?? raw?.manifest;
  const supportedInspection =
    Boolean(closed) ||
    (raw?.qualification === "NOT VERIFIED" &&
      raw.field_scope === "external_electrode_truncation");
  const rawOwnerMatches = Boolean(
    scene.status === "ready" &&
      executionCurrent &&
      inspection.status === "ready" &&
      !inspection.refreshError &&
      raw?.status === "inspection_only" &&
      supportedInspection &&
      rawManifest?.source_object_id === objectId &&
      inspectionMatchesRuntimeStage(raw, stageId ?? "", mapping, owner) &&
      raw.outputs.length === 1 &&
      raw.outputs[0]?.inspection_ref.stage_id === stageId &&
      raw.outputs[0]?.inspection_ref.output_id === raw.output_id &&
      raw.outputs[0]?.inspection_ref.content_digest ===
        rawManifest.content_digest,
  );
  const rawDisplay = useAntennaInspectionDisplayResource(
    rawOwnerMatches ? raw : null,
  );
  const rawAvailable = Boolean(
    rawOwnerMatches &&
      raw &&
      rawDisplay.status === "ready" &&
      !rawDisplay.refreshError &&
      rawDisplay.data &&
      antennaInspectionDisplayMatchesOwner(raw, rawDisplay.data),
  );

  const {
    inspectionMode,
    available,
    ports,
    port,
    currentAvailable,
    effectiveQuantity,
    current,
    perAmpereInspection,
    magnetic,
    surfaceAvailable,
    active,
  } = resolveAntennaVisualizationSelection({
    basisAvailable,
    display: rawDisplay.data,
    displaySource,
    field: field.data,
    objectId,
    owner,
    preferredPort,
    quantity,
    raw,
    rawAvailable,
    rawOwnerMatches,
    requested,
    stageId,
  });

  function setDisplay(patch: Partial<AntennaFieldIntent>): void {
    const selectedPort = patch.portModeId ?? port;
    if (
      !available ||
      !owner ||
      !objectId ||
      !stageId ||
      !selectedPort ||
      !ports.includes(selectedPort)
    ) {
      return;
    }
    const data = inspectionMode ? raw : field.data;
    if (!data) return;
    visualization.setAntennaFieldIntent({
      colorRange:
        (patch.quantity !== undefined &&
          patch.quantity !== effectiveQuantity) ||
        (patch.component !== undefined &&
          patch.component !== active?.component) ||
        (patch.portModeId !== undefined && patch.portModeId !== port)
          ? undefined
          : active?.colorRange,
      component: active?.component ?? "magnitude",
      contentDigest: inspectionMode
        ? (rawManifest?.content_digest ?? "")
        : (field.data?.content_digest ?? ""),
      glyphLengthScale: active?.glyphLengthScale ?? 1,
      kind: inspectionMode ? "inspection" : "basis",
      palette: active?.palette ?? "viridis",
      points: active?.points ?? false,
      portModeId: selectedPort,
      quantity: effectiveQuantity,
      recordContentDigest: inspectionMode
        ? raw?.record_content_digest
        : undefined,
      requestScopeEpoch: owner.requestScopeEpoch,
      runId: inspectionMode ? raw?.run_id : undefined,
      runtimeStageId: inspectionMode ? raw?.runtime_stage_id : undefined,
      sessionEpoch: owner.sessionEpoch,
      sessionId: owner.sessionId,
      solutionId: inspectionMode
        ? (raw?.output_id ?? "")
        : (field.data?.solution_id ?? ""),
      sourceObjectId: objectId,
      stageId,
      stageRevision: inspectionMode ? raw?.stage_revision : undefined,
      surface: surfaceAvailable && (active?.surface ?? false),
      vectorThickness: active?.vectorThickness ?? 1,
      vectors:
        effectiveQuantity === "electric_potential_per_ampere" ||
        effectiveQuantity === "device_potential"
          ? false
          : (active?.vectors ?? false),
      vectorsOnTop: active?.vectorsOnTop ?? false,
      wireframe: surfaceAvailable && (active?.wireframe ?? false),
      ...patch,
    });
  }

  const { quantitySpec, carrierLabel, renderReason } =
    antennaVisualizationPresentation({
      current,
      effectiveQuantity,
      field: field.data,
      inspectionMode,
      objectId,
      raw,
      surfaceAvailable,
    });

  const renderModes: Array<VisualizationRenderModeValue | "vectors"> = useMemo(
    () => [
      ...(surfaceAvailable
        ? (["surface", "surface+edges", "wireframe"] as const)
        : []),
      "points",
      ...(quantitySpec.components === 1 ? [] : (["vectors"] as const)),
      "off",
    ],
    [quantitySpec.components, surfaceAvailable],
  );

  const rawStatusReason =
    rawDisplay.error?.message ??
    inspection.error?.message ??
    (inspectionMode && mapping.state !== "mapped" ? mapping.message : null) ??
    (!stageId
      ? "No configured antenna solve stage"
      : validation.join("; ") ||
        (identityStatus === "ready" && !sourceMatches
          ? "Source or transport mismatch"
          : identityStatus === "ready" && !ownerMatches
            ? "Session owner mismatch"
            : scene.status !== "ready"
              ? `Scene ${scene.status}`
              : identityStatus));
  const statusReason = rawStatusReason
    .replace(/\bunavailable\b/gi, "not published")
    .replace(/\bunknown\b/gi, "unspecified");

  const baseline = useMemo<AntennaVizHostDraft>(
    () => ({ representation: effectiveRepresentation }),
    [effectiveRepresentation],
  );

  const enabledPassCount =
    Number(active?.points ?? false) +
    Number(active?.vectors ?? false) +
    Number(active?.surface ?? false) +
    Number(active?.wireframe ?? false);

  const spec: InspectorSpec<AntennaVizHostDraft> = {
    id: "object.antenna.visualization",
      header: {
        breadcrumbs: [
          {
            id: "obj",
            label: selection.label || objectId,
            selection: {
              kind: "object.root",
              label: selection.label || objectId,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "viz", label: "Antenna Visualization" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "visualization",
        entityId: `viz:antenna:${objectId}`,
        icon: Eye,
        kindLabel: "3D conductor J, V & Oersted B_ant visualization",
        statePill: () =>
          available
            ? { label: "Published snapshot", tone: "live" }
            : { label: "Awaiting solve", tone: "info" },
        title: () => "Antenna Visualization",
      },
      facts: () => [
        {
          id: "repr",
          label: "Representation",
          value:
            effectiveRepresentation === "inspection"
              ? "Raw SI (H / J / V)"
              : "Per-ampere basis",
        },
        {
          id: "qty",
          label: "Quantity",
          value: `${quantitySpec.label} [${quantitySpec.unit}]`,
        },
        {
          id: "passes",
          label: "Active passes",
          value: String(enabledPassCount),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Eye,
          id: "representation-mode",
          live: true,
          rows: [
            {
              render: () => (
                <InspectorPropertyRow label="Result representation">
                  <SegmentedControl
                    aria-label="Result representation"
                    columns={2}
                    options={[
                      {
                        label: "Raw SI results (H / J / V)",
                        value: "inspection",
                      },
                      {
                        label: "Published per-ampere basis",
                        value: "basis",
                      },
                    ]}
                    value={effectiveRepresentation}
                    onValueChange={(val) => {
                      const next = val as "inspection" | "basis";
                      setPreferredRepresentation(next);
                      if (next === "inspection") {
                        visualization.setAntennaFieldIntent(null);
                      }
                    }}
                  />
                </InspectorPropertyRow>
              ),
              type: "custom",
              wide: true,
            },
            {
              render: () => (
                <AntennaArtifactVisualization
                  scene={scene}
                  selection={selection}
                />
              ),
              showWhen: () => effectiveRepresentation === "inspection",
              type: "custom",
              wide: true,
            },
          ],
          title: "Result representation",
        },
        {
          defaultOpen: true,
          icon: Radio,
          id: "basis-display",
          live: true,
          rows: [
            {
              render: () => (
                <div
                  className="fm-inspector-stack"
                  data-testid="antenna-published-visualization"
                >
                  <InspectorPropertyRow label="Antenna visualization solve">
                    {stages.length > 0 ? (
                      <Select
                        value={stageId ?? ""}
                        onValueChange={(val) => {
                          setPreferredStageId(val);
                          visualization.setAntennaFieldIntent(null);
                        }}
                      >
                        <SelectTrigger aria-label="Antenna visualization solve">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          {stages.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="fm-inspector-hint">
                        No antenna field-solve stage configured.
                      </span>
                    )}
                  </InspectorPropertyRow>

                  <InspectorPropertyRow label="Execution runtime stage">
                    <Select
                      disabled={
                        !executionCurrent || mapping.candidates.length === 0
                      }
                      value={
                        mapping.state === "mapped"
                          ? mapping.runtimeStageId
                          : ""
                      }
                      onValueChange={(runtimeStageId) => {
                        if (
                          owner &&
                          stageId &&
                          execution.data &&
                          mapping.candidates.some(
                            (c) => c.runtimeStageId === runtimeStageId,
                          )
                        ) {
                          setInspectionSelection({
                            authoredStageId: stageId,
                            identity: owner,
                            runId: execution.data.run_id,
                            runtimeStageId,
                          });
                          visualization.setAntennaFieldIntent(null);
                        }
                      }}
                    >
                      <SelectTrigger aria-label="Antenna visualization execution">
                        <SelectValue placeholder="Select an inspection execution" />
                      </SelectTrigger>
                      <SelectContent className="fm-inspector-select-content">
                        {mapping.candidates.map((c) => (
                          <SelectItem
                            key={c.runtimeStageId}
                            value={c.runtimeStageId}
                          >
                            {c.runtimeStageId} · {c.status}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </InspectorPropertyRow>

                  <AntennaBasisDisplayPassControls
                    active={active}
                    available={available}
                    basisAvailable={basisAvailable}
                    carrierLabel={carrierLabel}
                    closedLoop={Boolean(closed)}
                    currentAvailable={currentAvailable}
                    displayStatus={displayStatus}
                    effectiveQuantity={effectiveQuantity}
                    inspectionMode={inspectionMode}
                    perAmpereInspection={perAmpereInspection}
                    port={port}
                    ports={ports}
                    quantityComponents={quantitySpec.components}
                    quantityLabel={quantitySpec.label}
                    quantityUnit={quantitySpec.unit}
                    rawAvailable={rawAvailable}
                    renderModes={renderModes}
                    renderReason={renderReason}
                    statusReason={statusReason}
                    surfaceAvailable={surfaceAvailable}
                    onClearIntent={() =>
                      visualization.setAntennaFieldIntent(null)
                    }
                    onPatchDisplay={(patch) => setDisplay(patch)}
                    onSelectDisplaySource={(source) => setDisplaySource(source)}
                    onSelectPort={(portId) => setPreferredPort(portId)}
                    onSelectQuantity={(qty) => setQuantity(qty)}
                  />
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Display passes, quantity & carrier",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "surface-coloring",
          live: true,
          rows: [
            {
              render: () => (
                <AntennaSurfaceColoringControls
                  active={active}
                  available={available}
                  displayStatus={displayStatus}
                  effectiveQuantity={effectiveQuantity}
                  inspectionMode={inspectionMode}
                  objectId={objectId}
                  owner={owner}
                  port={port}
                  quantityLabel={quantitySpec.label}
                  quantityUnit={quantitySpec.unit}
                  stageId={stageId}
                  onPatchDisplay={(patch) => setDisplay(patch)}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Surface coloring & range",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "vectors-controls",
          live: true,
          rows: [
            {
              render: () => (
                <AntennaVectorGlyphControls
                  active={active}
                  available={available}
                  port={port}
                  quantityComponents={quantitySpec.components}
                  onPatchDisplay={(patch) => setDisplay(patch)}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Vector glyphs",
        },
        {
          defaultOpen: false,
          icon: Scissors,
          id: "clipping-controls",
          live: true,
          rows: [
            {
              render: () => (
                <AntennaClippingControls
                  ownerKey={JSON.stringify(owner)}
                  resource={sectionState}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          summary: () =>
            clip
              ? clip.enabled
                ? `On: ${clip.axis.toUpperCase()} ${clip.position_percent.toFixed(1)}%`
                : "Section: Off"
              : "Section: Off",
          title: "Section clipping",
        },
        {
          defaultOpen: false,
          icon: Video,
          id: "camera-controls",
          live: true,
          rows: [
            {
              render: () => <AntennaCameraControls />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Camera presets",
        },
        {
          defaultOpen: false,
          icon: ShieldCheck,
          id: "basis-preview",
          live: true,
          rows: [
            {
              render: () =>
                field.data?.sample_positions ? (
                  <AntennaFieldBasisPreview
                    key={`${field.data.asset_id}:${effectiveQuantity}`}
                    quantity={effectiveQuantity as AntennaBasisQuantity}
                    solution={field.data}
                  />
                ) : null,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () =>
            effectiveRepresentation === "basis" &&
            Boolean(
              basisAvailable &&
                !inspectionMode &&
                !active?.points &&
                !active?.vectors &&
                field.data?.sample_positions,
            ),
          title: "Published basis numerical preview",
        },
      ],
      details: () => [
        { label: "Source object", mono: true, value: objectId },
        { label: "Field unit", mono: false, value: quantitySpec.unit },
        {
          label: "Asset",
          mono: true,
          value: available && field.data ? field.data.asset_id : null,
        },
        {
          label: "Mesh digest",
          mono: true,
          value: available && field.data ? field.data.mesh_digest : null,
        },
        {
          label: "Record digest",
          mono: true,
          value:
            available && inspectionMode && raw
              ? raw.record_content_digest
              : null,
        },
      ],
      commitBar: {
        hasOverrides: () =>
          Boolean(requested !== null || preferredRepresentation !== null),
        mode: "liveViewport",
        onResetDisplay: () => {
          visualization.setAntennaFieldIntent(null);
          setPreferredRepresentation(null);
          setPreferredPort("");
          setDisplaySource("basis");
        },
        statusMessage: available
          ? `Live 3D ${magnetic ? "magnetic" : "conductor"} carrier (${enabledPassCount} passes)`
          : "Live 3D viewport display controls",
      },
    };

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export { Activity };
