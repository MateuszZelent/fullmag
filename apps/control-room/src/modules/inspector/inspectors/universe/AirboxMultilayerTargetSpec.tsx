"use client";

import {
  Activity,
  Grid3x3,
  Layers,
  Radar,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFdmMultilayerLayoutResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import { resolveAirboxInspectorLane, useAirboxInspectorRuntimeStatus } from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  asNumber,
  asRecord,
  asString,
  asTuple3,
  formatTupleSmart,
  sanitizeStatusText,
  useSafeFieldMetaResource,
} from "../../panels/airbox/airboxSpecShared";

// ============================================================================
// 2. airbox.multilayer.target — AirboxMultilayerTargetInspectorSpecPanel
// ============================================================================

export function AirboxMultilayerTargetInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);

  const multilayerRes = useFdmMultilayerLayoutResource();
  const bDemagFieldMeta = useSafeFieldMetaResource({
    enabled: lane === "fdm" || lane === null,
    quantityId: "b_demag",
    scope_id: "airbox",
    scope_kind: "airbox",
  });

  const certifiedTarget = useMemo(
    () => resolveFdmMultilayerAirboxTarget(multilayerRes.data),
    [multilayerRes.data],
  );

  const airbox = useMemo(
    () => asRecord(multilayerRes.data?.airbox),
    [multilayerRes.data],
  );
  const cells = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.cells[0],
        certifiedTarget.cells[1],
        certifiedTarget.cells[2],
      ];
    }
    return asTuple3(airbox?.cells) ?? [0, 0, 0];
  }, [airbox?.cells, certifiedTarget]);

  const cellSize = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.cellSize[0],
        certifiedTarget.cellSize[1],
        certifiedTarget.cellSize[2],
      ];
    }
    return (
      asTuple3(airbox?.cell_size_m) ?? asTuple3(airbox?.cell_size) ?? [0, 0, 0]
    );
  }, [airbox?.cell_size, airbox?.cell_size_m, certifiedTarget]);

  const origin = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.origin[0],
        certifiedTarget.origin[1],
        certifiedTarget.origin[2],
      ];
    }
    return asTuple3(airbox?.origin_m) ?? asTuple3(airbox?.origin) ?? [0, 0, 0];
  }, [airbox?.origin, airbox?.origin_m, certifiedTarget]);

  const sampleCount =
    certifiedTarget?.sampleCount ??
    asNumber(airbox?.sample_count) ??
    cells[0] * cells[1] * cells[2];
  const valueCount =
    certifiedTarget?.valueCount ??
    asNumber(airbox?.value_count) ??
    sampleCount * 3;

  const boundsMax = useMemo<[number, number, number]>(
    () => [
      origin[0] + cells[0] * cellSize[0],
      origin[1] + cells[1] * cellSize[1],
      origin[2] + cells[2] * cellSize[2],
    ],
    [cellSize, cells, origin],
  );

  const bDemagMaterialized =
    bDemagFieldMeta.status === "ready" && bDemagFieldMeta.data !== null;
  const hDemagAvailable = airbox?.h_demag_available === true;
  const hEffAvailable = airbox?.h_eff_available === true;
  const hEffReason = asString(airbox?.h_eff_unavailable_reason);
  const carrierUnavailableReason = asString(airbox?.unavailable_reason);

  const sourcePolicyText =
    asString(airbox?.source_policy) ?? "Not published";
  const carrierFingerprint =
    certifiedTarget?.carrierFingerprint ??
    asString(airbox?.carrier_fingerprint) ??
    "Not published";
  const carrierRevision = asNumber(airbox?.carrier_revision);
  const layoutRevision = asNumber(multilayerRes.data?.layout_revision);
  const observationRevision = asNumber(multilayerRes.data?.observation_revision);
  const sourceGridsText = useMemo(() => {
    const fps = airbox?.source_grid_fingerprints;
    if (Array.isArray(fps) && fps.length > 0) {
      return fps.filter((x): x is string => typeof x === "string").join(", ");
    }
    return "Not published";
  }, [airbox?.source_grid_fingerprints]);

  const runtimeIdentityText = useMemo(() => {
    const rt = airbox?.source_runtime_identity;
    if (!rt || typeof rt !== "object" || Array.isArray(rt)) {
      return "Not published";
    }
    try {
      return JSON.stringify(rt);
    } catch {
      return "Not published";
    }
  }, [airbox?.source_runtime_identity]);

  const layers = useMemo(
    () => multilayerRes.data?.layers ?? [],
    [multilayerRes.data?.layers],
  );

  const runBuildFdmGrid = useCallback(async () => {
    await kernel.commands.execute(
      "grid.build-fdm",
      createCommandContext("inspector", kernel, {
        input: { origin: "airbox" },
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.multilayer.target",
      }),
    );
  }, [kernel, runtimeStatus, sessionScopeKey]);

  const baseline = useMemo(() => ({ unit: "nm" }), []);

  const spec = useMemo<InspectorSpec<{ unit: string }>>(() => {
    const carrierReady =
      certifiedTarget !== null ||
      (multilayerRes.data?.available === true && hDemagAvailable);

    const notices: InspectorNotice<{ unit: string }>[] = [];
    if (!carrierReady && carrierUnavailableReason) {
      notices.push({
        id: "ml-carrier-not-published",
        quickFix: {
          label: "Build FDM Grid",
          onApply: () => {
            void runBuildFdmGrid();
          },
        },
        text: sanitizeStatusText(
          carrierUnavailableReason,
          "Target-only Airbox carrier is not materialized yet.",
        ),
        title: "Target-only Airbox carrier not materialized",
        tone: "warn",
      });
    }
    notices.push({
      id: "ml-target-info",
      quickFix: {
        label: "Visualize H_demag in 3D",
        onApply: (ctx) =>
          ctx.selectNode({
            kind: "airbox.visualization",
            label: "Visualization",
            nodeId: "model:airbox:visualization",
            objectId: null,
            ref: null,
          }),
      },
      text: "Certified target-only stray-field observation grid outside magnetic Z-layers; distinct from the common FFT scratch layout.",
      title: "Stray-field observation carrier",
      tone: "info",
    });

    return {
      id: "airbox.multilayer.target",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          { id: "ml-target", label: "Multilayer Target" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          icon: Grid3x3,
          label: "Build FDM Grid",
          onRun: runBuildFdmGrid,
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:multilayer-target",
        icon: Radar,
        kindLabel: "Target-only stray-field observation carrier",
        statePill: () =>
          carrierReady
            ? { label: "Ready", tone: "ok" }
            : { label: "Not materialized", tone: "neutral" },
        title: () => "Multilayer Demag Target",
      },
      facts: () => [
        {
          id: "grid",
          label: "Target grid",
          value: sampleCount > 0 ? cells.join(" × ") : null,
        },
        {
          id: "bdemag",
          label: "B_demag",
          tone: bDemagMaterialized ? "ok" : undefined,
          value: bDemagMaterialized ? "Ready" : "Not materialized",
        },
        {
          id: "hdemag",
          label: "H_demag",
          tone: hDemagAvailable ? "ok" : undefined,
          value: hDemagAvailable ? "Ready" : "Not materialized",
        },
        {
          id: "values",
          label: "Values",
          value: valueCount > 0 ? valueCount.toLocaleString("en-US") : null,
        },
      ],
      notices: () => notices,
      sections: [
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void runBuildFdmGrid()}
            >
              Build FDM Grid
            </Button>
          ),
          icon: Radar,
          id: "carrier-geometry",
          rows: [
            {
              format: () =>
                "Target-only stray-field observation outside magnetic Z-layers",
              label: "Airbox scope",
              type: "readonly",
            },
            {
              format: () =>
                "Post-step stray-field observation carrier (excluded from spin integration and common FFT scratch layout)",
              label: "Solver usage",
              type: "readonly",
            },
            {
              format: () =>
                certifiedTarget !== null
                  ? "Yes (certified target-only)"
                  : airbox?.target_only === true
                    ? "Yes"
                    : "Pending certification",
              label: "Target-only carrier",
              type: "readonly",
            },
            {
              format: () =>
                `${cells.join(" × ")} (${sampleCount.toLocaleString("en-US")} cells)`,
              label: "Target grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: () => valueCount.toLocaleString("en-US"),
              label: "Values",
              type: "readonly",
            },
            {
              format: () => formatTupleSmart(cellSize),
              label: "Target cell size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: () => formatTupleSmart(origin),
              label: "Target origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                sampleCount > 0
                  ? `${formatTupleSmart(origin)} .. ${formatTupleSmart(boundsMax)}`
                  : "Not materialized",
              label: "Observation AABB bounds",
              type: "readonly",
            },
          ],
          title: "Target grid, scope & solver usage",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "field-capability",
          rows: [
            {
              format: () =>
                bDemagMaterialized
                  ? "Ready (materialized field data)"
                  : bDemagFieldMeta.status === "loading"
                    ? "Loading field metadata"
                    : "Not materialized",
              label: "B_demag field resource",
              symbol: (
                <>
                  B<sub>d</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                hDemagAvailable ? "Ready (3-component vector)" : "Not materialized",
              label: "Demagnetizing field (H_demag)",
              symbol: (
                <>
                  H<sub>d</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                hEffAvailable
                  ? "Ready (H_demag + uniform fields)"
                  : hEffReason
                    ? `Not materialized (${sanitizeStatusText(hEffReason, "pending")})`
                    : "Not materialized",
              label: "Effective field (H_eff)",
              symbol: (
                <>
                  H<sub>eff</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          title: "Field capability & materialization",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "coupled-layers",
          rows: [
            {
              items: () =>
                layers.map((layer) => ({
                  id: layer.layer_id,
                  jumpSelection: {
                    kind: "mesh.grid.layer",
                    label: layer.magnet_name,
                    nodeId: `model:mesh:grid:layer:${encodeURIComponent(layer.layer_id)}`,
                    objectId: layer.object_id,
                    ref: null,
                  },
                  label: layer.magnet_name,
                })),
              label: "Source Z-layers",
              showWhen: () => layers.length > 0,
              type: "chips",
            },
            {
              copyText: () => carrierFingerprint,
              format: () => carrierFingerprint,
              label: "Carrier fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                carrierRevision !== null
                  ? String(carrierRevision)
                  : "Not published",
              label: "Carrier revision",
              type: "readonly",
            },
            {
              format: () =>
                layoutRevision !== null
                  ? String(layoutRevision)
                  : "Not published",
              label: "Layout revision",
              type: "readonly",
            },
            {
              format: () =>
                observationRevision !== null
                  ? String(observationRevision)
                  : "Not published",
              label: "Observation revision",
              type: "readonly",
            },
            {
              copyText: () => sourcePolicyText,
              format: () => sourcePolicyText,
              label: "Source policy",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => sourceGridsText,
              format: () => sourceGridsText,
              label: "Source grids",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => runtimeIdentityText,
              format: () => runtimeIdentityText,
              label: "Runtime",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Carrier provenance & coupled Z-layers",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Certified target-only multilayer stray-field carrier",
      },
    };
  }, [
    airbox?.target_only,
    bDemagFieldMeta.status,
    bDemagMaterialized,
    boundsMax,
    carrierFingerprint,
    carrierRevision,
    carrierUnavailableReason,
    cellSize,
    cells,
    certifiedTarget,
    hDemagAvailable,
    hEffAvailable,
    hEffReason,
    layers,
    layoutRevision,
    multilayerRes.data?.available,
    observationRevision,
    origin,
    runBuildFdmGrid,
    runtimeIdentityText,
    sampleCount,
    sourceGridsText,
    sourcePolicyText,
    valueCount,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
