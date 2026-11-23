"use client";

import { Layers, SlidersHorizontal } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import {
  SpecInspectorHost,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { diffMeshPolicies, type MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import {
  formatCountClean,
  sanitizeMeshDisplayText,
} from "../../panels/mesh-details/MeshQualityAndHistorySpecViews";
import { buildSharedDomainPolicyDiffRows } from "../../panels/mesh-details/useMeshDetailsModel";
import {
  asNumber,
  asRecord,
  asString,
  useSafeMeshBuildLatestSuccessful,
} from "./meshShared";

export interface MeshRegionsDraft {
  selectedPartId: string;
  highlightSelectedPart: boolean;
  deviationFilter: "all" | "deviations_only";
}

interface HierarchyRow {
  id: string;
  depth: number;
  kindLabel: string;
  label: string;
  elementsText: string;
  jumpSelection: {
    kind: string;
    label: string;
    nodeId: string;
    objectId: string | null;
    ref: null;
  } | null;
}

export function MeshRegionsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scene = geometryLifecycleResources.useSceneResource();
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const semantics = geometryLifecycleResources.useMeshSemanticsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();
  const latestBuild = useSafeMeshBuildLatestSuccessful();

  const parts = useMemo(() => {
    const rec = asRecord(manifest.data);
    const list = Array.isArray(rec?.mesh_parts) ? rec.mesh_parts : [];
    return list.map((entry, idx) => {
      const p = asRecord(entry) ?? {};
      return {
        elementCount: asNumber(p.element_count) ?? 0,
        id: asString(p.part_id) ?? asString(p.id) ?? `part-${idx}`,
        label: asString(p.label) ?? asString(p.name) ?? `Part ${idx + 1}`,
        ownerId: asString(p.owner_object_id),
        regionId: asString(p.region_id),
        role: asString(p.role),
      };
    });
  }, [manifest.data]);

  const hierarchyRows = useMemo<HierarchyRow[]>(() => {
    const rows: HierarchyRow[] = [];
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    const manifestRegions = Array.isArray(manifest.data?.regions)
      ? manifest.data.regions.map(asRecord).filter(Boolean)
      : [];

    for (const rawObj of objs) {
      const obj = asRecord(rawObj);
      const objId = asString(obj?.id);
      if (!objId) continue;
      const objName = asString(obj?.name) ?? objId;
      const objParts = parts.filter((p) => p.ownerId === objId);
      const objElemSum = objParts.reduce((acc, p) => acc + p.elementCount, 0);
      rows.push({
        depth: 0,
        elementsText: objElemSum > 0 ? objElemSum.toLocaleString("en-US") : "—",
        id: `obj:${objId}`,
        jumpSelection: {
          kind: "object.mesh",
          label: `${objName} Mesh`,
          nodeId: `model:object:${objId}:mesh`,
          objectId: objId,
          ref: null,
        },
        kindLabel: "Object",
        label: objName,
      });

      const authoredRegions = Array.isArray(obj?.regions)
        ? obj.regions.map(asRecord).filter(Boolean)
        : [];
      for (const reg of authoredRegions) {
        const regId = asString(reg?.id);
        if (!regId) continue;
        const regName = asString(reg?.name) ?? regId;
        const regParts = objParts.filter((p) => p.regionId === regId);
        const regElems = regParts.reduce((acc, p) => acc + p.elementCount, 0);
        rows.push({
          depth: 1,
          elementsText: regElems > 0 ? regElems.toLocaleString("en-US") : "—",
          id: `reg:${objId}:${regId}`,
          jumpSelection: {
            kind: "object.region.mesh",
            label: `${regName} Mesh`,
            nodeId: `model:object:${objId}:region:${regId}:mesh`,
            objectId: objId,
            ref: null,
          },
          kindLabel: "Region",
          label: `↳ ${regName}`,
        });
      }

      for (const mReg of manifestRegions) {
        if (asString(mReg?.owner_object_id) !== objId) continue;
        const mRegId = asString(mReg?.region_id) ?? asString(mReg?.id);
        if (!mRegId || rows.some((r) => r.id === `reg:${objId}:${mRegId}`)) continue;
        rows.push({
          depth: 1,
          elementsText: formatCountClean(asNumber(mReg?.element_count)),
          id: `mreg:${objId}:${mRegId}`,
          jumpSelection: null,
          kindLabel: "Realized region",
          label: `↳ ${asString(mReg?.label) ?? mRegId}`,
        });
      }

      for (const part of objParts) {
        rows.push({
          depth: 2,
          elementsText: part.elementCount.toLocaleString("en-US"),
          id: `part:${part.id}`,
          jumpSelection: null,
          kindLabel: "Mesh part",
          label: `  ↳ ${part.label}`,
        });
      }
    }

    const exteriorParts = parts.filter((p) => !p.ownerId);
    for (const part of exteriorParts) {
      rows.push({
        depth: 0,
        elementsText: part.elementCount.toLocaleString("en-US"),
        id: `ext:${part.id}`,
        jumpSelection:
          part.role === "airbox"
            ? {
                kind: "airbox.mesh",
                label: "Airbox Mesh",
                nodeId: "model:airbox:mesh",
                objectId: null,
                ref: null,
              }
            : {
                kind: "mesh.unassigned.part",
                label: part.label,
                nodeId: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
                objectId: null,
                ref: null,
              },
        kindLabel: part.role === "airbox" ? "Airbox" : "Unassigned part",
        label: part.label,
      });
    }
    return rows;
  }, [manifest.data, parts, scene.data]);

  const policyDiffRows = useMemo<MeshPolicyDiffRow[]>(() => {
    const sharedRows = buildSharedDomainPolicyDiffRows({
      activeBuild: activeBuild.data?.active_build,
      latestBuild: latestBuild.data?.last_success,
      semantics: semantics.data,
    });
    const rec = asRecord(semantics.data);
    const configs = Array.isArray(rec?.object_configs) ? rec.object_configs : [];
    const objectRows: MeshPolicyDiffRow[] = [];
    for (const entry of configs) {
      const item = asRecord(entry) ?? {};
      const objId = asString(item.object_id) ?? "object";
      const cfg = asRecord(item.config) as JsonObject | null;
      const eff = asRecord(item.effective_config) as JsonObject | null;
      if (!cfg && !eff) continue;
      const diffed = diffMeshPolicies({
        current: cfg,
        draft: cfg,
        realized: eff,
        scope: "object",
      }).map((row) => ({
        ...row,
        label: `${objId} · ${row.label}`,
      }));
      objectRows.push(...diffed);
    }
    return [...sharedRows, ...objectRows];
  }, [activeBuild.data?.active_build, latestBuild.data?.last_success, semantics.data]);

  const partOptions = useMemo(
    () =>
      parts.length > 0
        ? parts.map((p) => ({ label: p.label, value: p.id }))
        : [{ label: "No mesh parts built", value: "" }],
    [parts],
  );

  const baseline = useMemo<MeshRegionsDraft>(
    () => ({
      deviationFilter: "all",
      highlightSelectedPart: false,
      selectedPartId: parts[0]?.id ?? "",
    }),
    [parts],
  );

  const applyPartHighlight = useCallback(
    (partId: string, highlight: boolean) => {
      if (!kernel.visualization?.patchTarget || !partId) return;
      for (const p of parts) {
        if (p.id === partId && highlight) {
          kernel.visualization.patchTarget(
            { id: p.id, kind: "part", label: p.label },
            { boundsVisible: true, visible: true, wireframeVisible: true },
          );
        } else {
          kernel.visualization.clearTarget?.({
            id: p.id,
            kind: "part",
            label: p.label,
          });
        }
      }
    },
    [kernel.visualization, parts],
  );

  const handleLiveChange = useCallback(
    <K extends keyof MeshRegionsDraft & string>(
      key: K,
      value: MeshRegionsDraft[K],
    ) => {
      if (key === "highlightSelectedPart") {
        applyPartHighlight(parts[0]?.id ?? "", Boolean(value));
      } else if (key === "selectedPartId") {
        applyPartHighlight(String(value), true);
      }
    },
    [applyPartHighlight, parts],
  );

  const spec = useMemo<InspectorSpec<MeshRegionsDraft>>(
    () => ({
      id: "mesh.regions",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "regions", label: "Regions & Parts" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:regions",
        icon: Layers,
        kindLabel: "Region hierarchy, physical parts & policy comparison",
        statePill: () =>
          parts.length > 0
            ? { label: `${parts.length} parts`, tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Mesh Regions & Parts",
      },
      facts: () => [
        { id: "parts", label: "Mesh parts", value: String(parts.length) },
        { id: "hierarchy", label: "Hierarchy nodes", value: String(hierarchyRows.length) },
        {
          id: "diffs",
          label: "Policy diffs",
          value: String(policyDiffRows.filter((r) => r.state !== "unchanged").length),
        },
      ],
      modeTabs: [
        { id: "parts", label: "Hierarchy & Parts" },
        { id: "comparison", label: "Policy Comparison" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "region-hierarchy-section",
          live: true,
          modeTabId: "parts",
          rows: [
            {
              key: "selectedPartId",
              label: "Target part",
              options: partOptions,
              showWhen: () => parts.length > 0,
              type: "select",
            },
            {
              key: "highlightSelectedPart",
              label: "Highlight selected part in 3D",
              type: "switch",
            },
            {
              columns: [
                {
                  header: "Domain / Object / Region / Part",
                  id: "label",
                  renderCell: (r) => (r as HierarchyRow).label,
                },
                {
                  header: "Kind",
                  id: "kind",
                  renderCell: (r) => (r as HierarchyRow).kindLabel,
                },
                {
                  align: "right",
                  header: "Elements",
                  id: "elements",
                  mono: true,
                  renderCell: (r) => (r as HierarchyRow).elementsText,
                },
              ],
              label: "Mesh region & part hierarchy",
              onSelectRow: (r, ctx) => {
                const row = r as HierarchyRow;
                if (row.jumpSelection) {
                  ctx.selectNode(row.jumpSelection);
                }
              },
              rowKey: (r) => (r as HierarchyRow).id,
              rows: () => hierarchyRows,
              showWhen: () => hierarchyRows.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Region & physical part hierarchy",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "comparison-section",
          modeTabId: "comparison",
          rows: [
            {
              key: "deviationFilter",
              label: "Filter comparison",
              options: [
                { label: "All parameters", value: "all" },
                { label: "Deviations only", value: "deviations_only" },
              ],
              type: "segmented",
            },
            {
              columns: [
                {
                  header: "Parameter",
                  id: "param",
                  renderCell: (r) => {
                    const row = r as MeshPolicyDiffRow;
                    return `${row.scope} · ${row.label}`;
                  },
                },
                {
                  align: "right",
                  header: "Current / Draft",
                  id: "current",
                  mono: true,
                  renderCell: (r) => {
                    const row = r as MeshPolicyDiffRow;
                    return row.currentValue === row.draftValue
                      ? sanitizeMeshDisplayText(row.currentValue, "—")
                      : `${sanitizeMeshDisplayText(row.currentValue, "—")} → ${sanitizeMeshDisplayText(row.draftValue, "—")}`;
                  },
                },
                {
                  align: "right",
                  header: "Realized",
                  id: "realized",
                  mono: true,
                  renderCell: (r) =>
                    sanitizeMeshDisplayText((r as MeshPolicyDiffRow).realizedValue, "—"),
                },
                {
                  align: "right",
                  header: "Impact",
                  id: "impact",
                  renderCell: (r) =>
                    sanitizeMeshDisplayText((r as MeshPolicyDiffRow).impact, "—"),
                },
              ],
              label: "Policy vs realized mesh diff",
              rowKey: (r) => {
                const row = r as MeshPolicyDiffRow;
                return `${row.scope}:${row.path}`;
              },
              rows: (d) =>
                d.deviationFilter === "deviations_only"
                  ? policyDiffRows.filter((r) => r.state !== "unchanged")
                  : policyDiffRows,
              type: "table",
              wide: true,
            },
          ],
          title: "Policy comparison (Current · Draft · Realized · Impact)",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightSelectedPart !== b.highlightSelectedPart,
        mode: "liveViewport",
        onResetDisplay: () => {
          for (const p of parts) {
            kernel.visualization?.clearTarget?.({
              id: p.id,
              kind: "part",
              label: p.label,
            });
          }
        },
        statusMessage: "Live 3D mesh part highlight",
      },
    }),
    [hierarchyRows, kernel.visualization, partOptions, parts, policyDiffRows],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={{ onLiveFieldChange: handleLiveChange }}
      selection={selection}
      spec={spec}
      onAfterFieldChange={(key, value, helpers) => {
        if (key === "highlightSelectedPart") {
          applyPartHighlight(helpers.draft.selectedPartId, Boolean(value));
        } else if (key === "selectedPartId" && helpers.draft.highlightSelectedPart) {
          applyPartHighlight(String(value), true);
        }
      }}
    />
  );
}
