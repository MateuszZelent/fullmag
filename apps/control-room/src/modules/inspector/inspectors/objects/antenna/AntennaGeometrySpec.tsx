"use client";

import {
  Activity,
  Compass,
  Ruler,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useGeometryDiagnosticsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useGeometryRealizationResource } from "@/kernel/resources/useGeometryRealizationResource";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { inspectorValuesEqual, type InspectorNotice, type InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  asNumber,
  asRecord,
  asString,
  executeAntennaMergePatchTransaction,
  formatLengthSmart,
  GeometryDiagnosticsView,
  type JsonRecord,
} from "../../../panels/antenna/AntennaCoreHelpers";
import { committedAntennaGeometryScene } from "../../../panels/antenna/AntennaGeometryAcknowledgement";
import { resolveAntennaPlacement } from "../../../panels/antenna/AntennaPlacementModel";
import {
  antennaCircuitFields,
  buildMicrostripCircuitPatch,
  microstripCircuitDraft,
  microstripCircuitSourceKey,
  type MicrostripCircuitDraft,
} from "../../../panels/antenna/MicrostripGeometryEditorModel";
import {
  type AntennaGeometryAndPlacementDraft,
  buildAntennaTopologyGeometryPayload,
  createDefaultAntennaGeometryDraft,
  DEFAULT_LOOP_PARAMETERS,
  hasFullMicrostripCircuitPrerequisites,
  LENGTH_UNITS,
  resolveTopologyFromGeometry,
  SCENE_ORIGIN_TARGET_VALUE,
  type Waypoint3DDraft,
} from "./antennaCoreShared";
import {
  ANTENNA_GEOMETRY_CLOSED_LOOP_SECTION,
  ANTENNA_GEOMETRY_LAYOUT_SECTIONS,
} from "./antennaGeometrySections";

function antennaGeometrySource(scene: SceneResource | null, objectId: string): string {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = asRecord(object?.geometry) as JsonObject | null;
  return JSON.stringify([
    object?.transform,
    geometry && microstripCircuitSourceKey(geometry, scene, objectId),
  ]);
}

export function AntennaGeometryInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const realization = useGeometryRealizationResource(Boolean(sessionScopeKey && objectId));
  const geometryDiagnostics = useGeometryDiagnosticsResource({
    enabled: Boolean(objectId),
  });

  const currentScene = sessionScopeKey === scene.sessionScopeKey ? scene.data : null;
  const sceneId = currentScene?.scene?.id;
  const draftKey = JSON.stringify([sessionScopeKey, sceneId, objectId]);
  const [editSource, setEditSource] = useState<{ key: string; source: string } | null>(null);
  const sceneRec = useMemo(() => asRecord(currentScene), [currentScene]);
  const objects = useMemo(
    () =>
      Array.isArray(sceneRec?.objects)
        ? sceneRec.objects.map(asRecord).filter((o): o is JsonRecord => o !== null)
        : [],
    [sceneRec],
  );
  const antennaObj = useMemo(
    () => objects.find((o) => asString(o.id) === objectId) ?? null,
    [objectId, objects],
  );

  const source = useMemo(
    () => antennaGeometrySource(currentScene, objectId),
    [currentScene, objectId],
  );

  const magneticTargets = useMemo(() => {
    const candidates = objects.filter((o) => asString(o.id) !== objectId);
    const ordered = [
      ...candidates.filter((o) => Boolean(o.magnetization_ref)),
      ...candidates.filter((o) => !o.magnetization_ref),
    ];
    return ordered
      .map((o) => ({
        label: `${asString(o.name) ?? asString(o.id)} (${asString(o.id)})`,
        value: asString(o.id) ?? "",
      }))
      .filter((opt) => opt.value.length > 0);
  }, [objectId, objects]);

  const baseline = useMemo<AntennaGeometryAndPlacementDraft>(() => {
    const base = createDefaultAntennaGeometryDraft();
    const geom = asRecord(antennaObj?.geometry);
    const params = asRecord(geom?.geometry_params);
    const topology = resolveTopologyFromGeometry(geom);
    const stationsRaw = Array.isArray(params?.stations) ? params.stations : [];
    const st0 = asRecord(stationsRaw[0]);
    const transform = asRecord(antennaObj?.transform);
    const tr = Array.isArray(transform?.translation)
      ? transform.translation
      : [0, 0, 50e-9];
    const quat = Array.isArray(transform?.rotation_quat) ? transform.rotation_quat : null;
    const inPlaneAngleDeg =
      quat &&
      quat.length === 4 &&
      asNumber(quat[0]) === 0 &&
      asNumber(quat[1]) === 0 &&
      asNumber(quat[2]) !== null &&
      asNumber(quat[3]) !== null
        ? Number(
            (
              (2 * Math.atan2(Number(quat[2]), Number(quat[3])) * 180) /
              Math.PI
            ).toFixed(4),
          )
        : 0;

    const thicknessM = asNumber(params?.thickness_m) ?? base.thicknessM;
    const returnOffsetM = asNumber(params?.return_offset_m) ?? base.returnOffsetM;
    const zTrans = asNumber(tr[2]) ?? 60e-9;

    const cpwGapM = asNumber(st0?.left_gap_m) ?? base.cpwGapM;
    const cpwRightGapM = asNumber(st0?.right_gap_m) ?? cpwGapM;
    const groundWidthM = asNumber(st0?.left_ground_width_m) ?? base.groundWidthM;
    const rightGroundWidthM = asNumber(st0?.right_ground_width_m) ?? groundWidthM;
    const symmetricCpw =
      Math.abs(cpwGapM - cpwRightGapM) < 1e-15 &&
      Math.abs(groundWidthM - rightGroundWidthM) < 1e-15;

    const waypointsRaw = Array.isArray(params?.waypoints) ? params.waypoints : [];
    const waypoints: Waypoint3DDraft[] =
      waypointsRaw.length >= 2
        ? waypointsRaw.map((entry, idx) => {
            const wr = asRecord(entry) ?? {};
            return {
              bendRadiusM: asNumber(wr.bend_radius_m) ?? 20e-9,
              rowId: `wp:${idx}`,
              xM: asNumber(wr.x_m) ?? 0,
              yM: asNumber(wr.y_m) ?? 0,
              zM: asNumber(wr.z_m) ?? 50e-9,
            };
          })
        : [...base.waypoints];

    const isCpw = geom?.geometry_kind === "CPWAntennaLayout";
    const circuitGeometry = geom && (isCpw || geom.geometry_kind === "MicrostripAntennaLayout")
      ? geom as JsonObject
      : null;
    const circuit = circuitGeometry
      ? microstripCircuitDraft(circuitGeometry, currentScene, objectId)
      : null;
    const loopParameters: Record<string, string> = { ...DEFAULT_LOOP_PARAMETERS };
    if (circuit && circuitGeometry) {
      for (const field of antennaCircuitFields(circuitGeometry)) {
        const val = circuit.parameters[field.key];
        if (val && val.trim().length > 0) {
          loopParameters[field.key] = val;
        }
      }
    }

    const loopShapeRaw = asString(params?.loop_shape);
    const loopShape =
      loopShapeRaw === "rectangular" || loopShapeRaw === "omega"
        ? loopShapeRaw
        : "circular";
    const cadScaleRaw = asString(params?.scale_unit);
    const cadScaleUnit =
      cadScaleRaw === "um" || cadScaleRaw === "mm" || cadScaleRaw === "m"
        ? cadScaleRaw
        : "nm";

    return {
      ...base,
      bridgeConductivitySpm:
        asNumber(loopParameters.inlet_connection_conductivity_s_per_m) ??
        base.bridgeConductivitySpm,
      bridgeLengthM:
        asNumber(loopParameters.inlet_connection_length_m) ?? base.bridgeLengthM,
      bridgeWidthM:
        asNumber(loopParameters.inlet_connection_width_m) ?? base.bridgeWidthM,
      cadAssetId: asString(params?.asset_id) ?? base.cadAssetId,
      cadScaleUnit,
      closedLoopEnabled: circuit?.enabled ?? false,
      conductivitySpm: asNumber(params?.conductivity_s_per_m) ?? base.conductivitySpm,
      cpwGapM,
      cpwRightGapM,
      groundWidthM,
      inPlaneAngleDeg,
      lateralOffsetXM: asNumber(tr[0]) ?? 0,
      lateralOffsetYM: asNumber(tr[1]) ?? 0,
      lengthM: asNumber(params?.length_m) ?? base.lengthM,
      loopFeedGapM: asNumber(params?.feed_gap_m) ?? base.loopFeedGapM,
      loopInnerRadiusM: asNumber(params?.inner_radius_m) ?? base.loopInnerRadiusM,
      loopParameters,
      loopPitchM: asNumber(params?.pitch_m) ?? base.loopPitchM,
      loopShape,
      loopTurns: asNumber(params?.turns) ?? base.loopTurns,
      meanderBendRadiusM: asNumber(params?.bend_radius_m) ?? base.meanderBendRadiusM,
      meanderFingerCount: asNumber(params?.finger_count) ?? base.meanderFingerCount,
      meanderPitchM: asNumber(params?.pitch_m) ?? base.meanderPitchM,
      placementTargetId: magneticTargets[0]?.value ?? SCENE_ORIGIN_TARGET_VALUE,
      potentialJumpV: asNumber(circuit?.potentialJumpV) ?? base.potentialJumpV,
      returnOffsetM,
      returnWidthM: asNumber(params?.return_width_m) ?? base.returnWidthM,
      rightGroundWidthM,
      signalWidthM:
        asNumber(params?.signal_width_m) ??
        asNumber(st0?.signal_width_m) ??
        base.signalWidthM,
      sourceCutNormal:
        circuit?.sourceCutNormal === "negative_axis" ? "negative_axis" : "positive_axis",
      sourceCutOffsetM: asNumber(circuit?.sourceCutOffsetM) ?? (isCpw
        ? (-Number(loopParameters.inlet_connection_length_m) + Number(loopParameters.inlet_crossbar_length_m)) / 2
        : -(thicknessM + returnOffsetM) / 2),
      standoffGapM: Math.max(1e-9, Math.abs(zTrans) - thicknessM * 0.2),
      standoffSide: zTrans >= 0 ? "above" : "below",
      stations:
        stationsRaw.length >= 2
          ? stationsRaw.map((entry, idx) => {
              const sr = asRecord(entry) ?? {};
              return {
                leftGapM: String(sr.left_gap_m ?? cpwGapM),
                leftGroundWidthM: String(sr.left_ground_width_m ?? groundWidthM),
                rightGapM: String(sr.right_gap_m ?? cpwRightGapM),
                rightGroundWidthM: String(sr.right_ground_width_m ?? rightGroundWidthM),
                rowId: `st:${idx}`,
                s: String(sr.s ?? (idx === 0 ? 0 : 1)),
                signalWidthM: String(sr.signal_width_m ?? 150e-9),
              };
            })
          : base.stations,
      symmetricCpw,
      thicknessM,
      topology,
      waypoints,
    };
  }, [antennaObj, currentScene, magneticTargets, objectId]);

  const computePlacementPreview = useCallback(
    (draft: AntennaGeometryAndPlacementDraft) => {
      const targetId = draft.placementTargetId;
      if (
        !currentScene ||
        !realization.data ||
        !targetId ||
        targetId === SCENE_ORIGIN_TARGET_VALUE
      ) {
        return null;
      }
      try {
        const draftGeom = buildAntennaTopologyGeometryPayload(draft);
        const sceneForPlacement: SceneResource = {
          ...currentScene,
          objects: (currentScene.objects ?? []).map((obj) => {
            if (obj.id === objectId) {
              return { ...obj, geometry: draftGeom };
            }
            if (obj.id === targetId && !obj.magnetization_ref) {
              return { ...obj, magnetization_ref: "mag_target" };
            }
            return obj;
          }),
        };
        return resolveAntennaPlacement(
          sceneForPlacement,
          realization.data,
          objectId,
          targetId,
          draft.standoffSide,
          draft.standoffGapM,
        );
      } catch {
        return null;
      }
    },
    [currentScene, objectId, realization.data],
  );

  const committedTranslationText = useMemo(() => {
    const tr = Array.isArray(asRecord(antennaObj?.transform)?.translation)
      ? (asRecord(antennaObj?.transform)?.translation as unknown[])
      : [0, 0, 0];
    const parts = [0, 1, 2].map(
      (i) => formatLengthSmart(asNumber(tr[i]) ?? 0) ?? "0 nm",
    );
    return `[${parts.join(", ")}]`;
  }, [antennaObj]);

  const objectDiagnostics = useMemo(() => {
    const all = Array.isArray(geometryDiagnostics.data?.diagnostics)
      ? geometryDiagnostics.data.diagnostics
      : [];
    return all.filter((d) => !d.object_id || d.object_id === objectId);
  }, [geometryDiagnostics.data, objectId]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const needsRebase = useCallback(
    (draft: AntennaGeometryAndPlacementDraft) =>
      editSource?.key === draftKey && editSource.source !== source && !inspectorValuesEqual(draft, baseline),
    [baseline, draftKey, editSource, source],
  );

  const spec = useMemo<InspectorSpec<AntennaGeometryAndPlacementDraft>>(
    () => ({
      id: "object.antenna.geometry",
      header: {
        breadcrumbs: [
          {
            id: "obj",
            label: antennaName,
            selection: {
              kind: "object.root",
              label: antennaName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "geometry", label: "Geometry & Layout" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "geometry",
        entityId: `object:${objectId}:geometry`,
        icon: Ruler,
        kindLabel: "Parametric 3D conductor layout & standoff",
        statePill: () =>
          objectDiagnostics.some((d) => d.severity === "error")
            ? { label: "Diagnostic error", tone: "err" }
            : { label: "Committed", tone: "ok" },
        title: () => `${antennaName} Geometry`,
      },
      facts: (d) => [
        { id: "topo", label: "Topology", value: d.topology.replaceAll("_", " ") },
        { id: "w", label: "Signal w", value: formatLengthSmart(d.signalWidthM) },
        { id: "t", label: "Thickness t", value: formatLengthSmart(d.thicknessM) },
        { id: "gap", label: "Standoff Δz", value: formatLengthSmart(d.standoffGapM) },
      ],
      notices: (d) => {
        const notices: InspectorNotice<AntennaGeometryAndPlacementDraft>[] = [];
        if (needsRebase(d)) {
          notices.push({
            id: "conductor-rebase-required",
            title: "Conductor geometry changed on the server",
            text: "Review the current scene and rebase your draft before applying.",
            tone: "warn",
            quickFix: {
              label: "Rebase draft",
              onApply: () => setEditSource({ key: draftKey, source }),
            },
          });
        }
        if (baseline.closedLoopEnabled && (!d.closedLoopEnabled || baseline.topology !== d.topology)) {
          notices.push({
            id: "reopen-loop-warn",
            text: "Reopening a committed closed loop requires explicit terminal-source migration on the charge transport.",
            title: "Closed-loop source contract",
            tone: "warn",
          });
        }
        return notices;
      },
      modeTabs: [
        { id: "layout", label: "Conductor Layout" },
        { id: "placement", label: "Standoff & 3D Placement" },
        { id: "loop", label: "Closed-Loop Return" },
      ],
      sections: [
        ...ANTENNA_GEOMETRY_LAYOUT_SECTIONS,
        {
          defaultOpen: objectDiagnostics.length > 0,
          icon: Activity,
          id: "geometry-diagnostics",
          modeTabId: "layout",
          rows: [
            {
              render: () => (
                <GeometryDiagnosticsView
                  diagnosticsData={geometryDiagnostics.data}
                  objectId={objectId}
                  status={geometryDiagnostics.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () =>
            objectDiagnostics.length > 0
              ? `${objectDiagnostics.length} issues`
              : "Clean",
          title: "Geometry diagnostics",
        },
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                scene.refetch();
                realization.refetch();
              }}
            >
              Refresh placement bounds
            </Button>
          ),
          icon: Compass,
          id: "standoff-placement",
          modeTabId: "placement",
          rows: [
            {
              key: "placementTargetId",
              label: "Magnetic placement target",
              options:
                magneticTargets.length > 0
                  ? magneticTargets
                  : [{ label: "Scene origin", value: SCENE_ORIGIN_TARGET_VALUE }],
              type: "select",
            },
            {
              key: "standoffSide",
              label: "Placement side",
              options: [
                { label: "Above +Z", value: "above" },
                { label: "Below −Z", value: "below" },
              ],
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "standoffGapM",
              label: "Standoff gap",
              min: 1e-10,
              minExclusive: true,
              symbol: (
                <>
                  h<sub>gap</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "lateralOffsetXM",
              label: "Lateral offset X",
              symbol: <>&Delta;x</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "lateralOffsetYM",
              label: "Lateral offset Y",
              symbol: <>&Delta;y</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "inPlaneAngleDeg",
              label: "In-plane rotation angle",
              max: 180,
              min: -180,
              step: 5,
              symbol: (
                <>
                  &phi;<sub>z</sub>
                </>
              ),
              type: "number",
              unitSuffix: "deg",
            },
            {
              format: (d) => {
                const resolved = computePlacementPreview(d);
                if (resolved) {
                  const dz = resolved.delta[2];
                  const formatted = formatLengthSmart(Math.abs(dz)) ?? "0 nm";
                  return dz === 0 ? "0 nm" : `${dz > 0 ? "+" : "−"}${formatted}`;
                }
                return "Bounds pending realization";
              },
              label: "Proposed Δz",
              type: "readonly",
            },
            {
              format: () => committedTranslationText,
              label: "Committed translation",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Standoff z & 3D placement",
        },
        ANTENNA_GEOMETRY_CLOSED_LOOP_SECTION,
      ],
      commitBar: {
        cleanMessage: () => "Conductor layout & 3D placement are synchronized",
        mode: "staged",
        lockReason: (draft) => {
          if (!sessionScopeKey || !sceneId || scene.status !== "ready" || !antennaObj) {
            return "Wait for the current antenna scene before applying.";
          }
          if (antennaObj.locked === true) return "Unlock the antenna before editing its geometry.";
          if (needsRebase(draft)) return "Rebase the conductor draft against the current scene.";
          if (baseline.closedLoopEnabled && (!draft.closedLoopEnabled || baseline.topology !== draft.topology)) {
            return "Migrate the committed closed-loop source before reopening it or changing topology.";
          }
          return null;
        },
        onRevert: () => setEditSource(null),
        onApply: async (draft, previous) => {
          const baseRev = currentScene?.revision;
          if (!currentScene || !sessionScopeKey || typeof baseRev !== "number" || !Number.isSafeInteger(baseRev) || baseRev < 0) {
            return false;
          }
          const builtGeometry = buildAntennaTopologyGeometryPayload(draft);
          const existingGeom = asRecord(antennaObj?.geometry);
          const existingParams = asRecord(existingGeom?.geometry_params) ?? {};
          const sameKind = existingGeom?.geometry_kind === builtGeometry.geometry_kind;

          const mergedParams: JsonObject = {
            ...(sameKind ? existingParams as JsonObject : {}),
            ...(asRecord(builtGeometry.geometry_params) as JsonObject),
          };
          const mergedGeometry: JsonObject = {
            geometry_kind: builtGeometry.geometry_kind,
            geometry_params: mergedParams,
          };

          // Compute Z placement via AABB realization bounds when ready, with fallback
          const resolvedPlacement = computePlacementPreview(draft);
          const signZ = draft.standoffSide === "above" ? 1 : -1;
          let fallbackZ = signZ * (draft.standoffGapM + draft.thicknessM * 0.5);
          const targetObj =
            draft.placementTargetId &&
            draft.placementTargetId !== SCENE_ORIGIN_TARGET_VALUE
              ? objects.find((o) => asString(o.id) === draft.placementTargetId)
              : null;
          const targetLz = asNumber(
            asRecord(asRecord(targetObj?.geometry)?.geometry_params)?.lz,
          );
          const targetTr = Array.isArray(asRecord(targetObj?.transform)?.translation)
            ? (asRecord(targetObj?.transform)?.translation as unknown[])
            : null;
          const targetZ = asNumber(targetTr?.[2]) ?? 0;
          if (targetObj && targetLz !== null && targetLz > 0) {
            fallbackZ =
              targetZ +
              signZ * (targetLz * 0.5 + draft.standoffGapM + draft.thicknessM * 0.5);
          }

          const zTranslation = resolvedPlacement
            ? resolvedPlacement.translation[2]
            : fallbackZ;

          const placementChanged = (
            ["placementTargetId", "standoffSide", "standoffGapM", "lateralOffsetXM", "lateralOffsetYM", "inPlaneAngleDeg"] as const
          ).some((key) => draft[key] !== previous[key]);
          const buildPatchedTransform = (obj: JsonRecord): JsonObject => {
            const existingTransform = asRecord(obj.transform) ?? {};
            const nextTransform: JsonObject = {
              ...(existingTransform as JsonObject),
              translation: [
                draft.lateralOffsetXM,
                draft.lateralOffsetYM,
                zTranslation,
              ],
            };
            // NEVER overwrite transform.rotation with Euler angles!
            // Update rotation_quat ONLY when inPlaneAngleDeg !== 0 (or changed from non-zero baseline).
            if (draft.inPlaneAngleDeg !== 0 || baseline.inPlaneAngleDeg !== 0) {
              const halfRad = (draft.inPlaneAngleDeg * Math.PI) / 360;
              nextTransform.rotation_quat = [
                0,
                0,
                Math.sin(halfRad),
                Math.cos(halfRad),
              ];
            }
            return nextTransform;
          };

          const positionedObjects = objects.map((obj) =>
            asString(obj.id) === objectId && placementChanged
              ? { ...obj, transform: buildPatchedTransform(obj) }
              : obj,
          );
          let circuitPatch: JsonObject | undefined;
          let submittedGeometry = mergedGeometry;

          if (draft.closedLoopEnabled) {
            const circuitDraft: MicrostripCircuitDraft = {
              enabled: true,
              parameters: { ...draft.loopParameters },
              potentialJumpV: String(draft.potentialJumpV),
              sourceCutNormal: draft.sourceCutNormal,
              sourceCutOffsetM: String(draft.sourceCutOffsetM),
            };

            if (
              mergedGeometry.geometry_kind === "CPWAntennaLayout" ||
              hasFullMicrostripCircuitPrerequisites(currentScene, objectId, mergedGeometry)
            ) {
              circuitPatch = buildMicrostripCircuitPatch(
                { ...currentScene, objects: positionedObjects as unknown as SceneResource["objects"] },
                objectId,
                mergedGeometry,
                circuitDraft,
              );
            } else if (mergedGeometry.geometry_kind === "MicrostripAntennaLayout") {
              const loop: JsonObject = { enabled: true };
              for (const field of antennaCircuitFields(mergedGeometry)) {
                const raw = draft.loopParameters[field.key] ?? "";
                loop[field.key] = field.numeric ? Number(raw) : raw.trim();
              }
              submittedGeometry = {
                ...mergedGeometry,
                geometry_params: { ...mergedParams, loop },
              };
            } else {
              throw new Error("Choose a straight microstrip or coplanar layout for a closed return.");
            }
          }
          const mergePatch = circuitPatch ?? {
            objects: positionedObjects.map((obj) =>
              asString(obj.id) === objectId ? { ...obj, geometry: submittedGeometry } : obj,
            ) as unknown as JsonObject[],
          };

          try {
            const response = await executeAntennaMergePatchTransaction({
              kernel,
              label: `Edit antenna geometry ${objectId}`,
              mutationKind: "geometry",
              request: {
                base_revision: baseRev,
                kind: "merge_patch",
                merge_patch: mergePatch,
              },
              scene: currentScene,
              sessionScopeKey,
              resolveCommittedScene: (response) =>
                committedAntennaGeometryScene(
                  response,
                  currentScene,
                  objectId,
                  submittedGeometry,
                  circuitPatch,
                  positionedObjects.find((obj) => asString(obj.id) === objectId)?.transform,
                ),
            });
            if (!response.committed_scene) return false;
            const committedSource = antennaGeometrySource(response.committed_scene, objectId);
            setEditSource((edit) => edit?.key === draftKey ? { key: draftKey, source: committedSource } : edit);
          } catch (error) {
            scene.refetch();
            throw error;
          }
          return true;
        },
      },
    }),
    [
      antennaName,
      antennaObj,
      baseline.closedLoopEnabled,
      baseline.inPlaneAngleDeg,
      baseline.topology,
      committedTranslationText,
      computePlacementPreview,
      currentScene,
      draftKey,
      geometryDiagnostics.data,
      geometryDiagnostics.status,
      kernel,
      magneticTargets,
      needsRebase,
      objectDiagnostics,
      objectId,
      objects,
      realization,
      scene,
      sceneId,
      sessionScopeKey,
      source,
    ],
  );

  return (
    <SpecInspectorHost
      key={draftKey}
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={(_key, _value, { draft }) => {
        if (inspectorValuesEqual(draft, baseline)) setEditSource({ key: draftKey, source });
      }}
    />
  );
}
