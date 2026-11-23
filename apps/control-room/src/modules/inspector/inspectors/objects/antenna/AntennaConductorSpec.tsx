"use client";

import {
  Activity,
  Layers,
  PlugZap,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaNavigationLinks } from "@/modules/explorer/public";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  buildConductorMaterialTransaction,
  conductorMaterialContext,
  type ConductorMaterialDraft,
} from "../../../panels/antenna/AntennaConductorMaterialModel";
import {
  asNumber,
  asRecord,
  asString,
  buildAntennaOriginSelection,
  executeAntennaMergePatchTransaction,
  formatLengthSmart,
  normalizeSceneForAntennaNavigation,
  openAntennaNavigationLink,
  RadixAntennaPortComposer,
  type JsonRecord,
  type MergePatchTransactionRequest,
} from "../../../panels/antenna/AntennaCoreHelpers";
import { formatAntennaParameter } from "../../../panels/antenna/AntennaReadoutModel";
import {
  CONDUCTIVITY_UNITS,
  FREQUENCY_UNITS,
  MU0,
} from "./antennaCoreShared";

const CONDUCTOR_METALS = [
  { id: "cu", label: "Copper (Cu) — 59.6 MS/m", sigmaSpm: 5.96e7 },
  { id: "au", label: "Gold (Au) — 41.0 MS/m", sigmaSpm: 4.1e7 },
  { id: "al", label: "Aluminum (Al) — 37.7 MS/m", sigmaSpm: 3.77e7 },
  { id: "ag", label: "Silver (Ag) — 63.0 MS/m", sigmaSpm: 6.3e7 },
  { id: "pt", label: "Platinum (Pt) — 9.43 MS/m", sigmaSpm: 9.43e6 },
  { id: "w", label: "Tungsten (W) — 17.9 MS/m", sigmaSpm: 1.79e7 },
  { id: "ta", label: "β-Tantalum (Ta) — 0.53 MS/m", sigmaSpm: 5.3e5 },
] as const;

interface AntennaConductorDraft {
  metalPreset: string;
  conductivitySpm: number;
  inletBridgeConductivitySpm: number;
  outletBridgeConductivitySpm: number;
  referenceFreqHz: number;
}

function matchMetalPreset(sigmaSpm: number): string {
  for (const metal of CONDUCTOR_METALS) {
    if (Math.abs(sigmaSpm - metal.sigmaSpm) / metal.sigmaSpm < 0.015) {
      return metal.id;
    }
  }
  return "custom";
}

export function AntennaConductorInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
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
  const geom = useMemo(() => asRecord(antennaObj?.geometry), [antennaObj]);
  const geomParams = useMemo(() => asRecord(geom?.geometry_params), [geom]);
  const loopRec = useMemo(() => asRecord(geomParams?.loop), [geomParams]);
  const isClosedLoop = loopRec?.enabled === true;
  const thicknessM = asNumber(geomParams?.thickness_m) ?? 50e-9;

  const partIdsText = useMemo(() => {
    const rawParts = Array.isArray(geomParams?.conductors)
      ? geomParams.conductors.map(asRecord)
      : [];
    const ids = rawParts
      .map((p) => asString(p?.id))
      .filter((id): id is string => id !== null);
    if (isClosedLoop) {
      const inletPart = asString(loopRec?.inlet_connection_part_id);
      const outletPart = asString(loopRec?.outlet_connection_part_id);
      if (inletPart) ids.push(inletPart);
      if (outletPart) ids.push(outletPart);
    }
    return ids.length > 0 ? ids.join(", ") : "Whole conductor";
  }, [geomParams, isClosedLoop, loopRec]);

  const objectTransports = useMemo(() => {
    const list = Array.isArray(sceneRec?.current_transports)
      ? sceneRec.current_transports.map(asRecord).filter((t): t is JsonRecord => t !== null)
      : [];
    return list.filter(
      (ct) =>
        Array.isArray(ct.domain) &&
        ct.domain.some((ref) => asString(asRecord(ref)?.object_id) === objectId),
    );
  }, [objectId, sceneRec]);

  const conductorOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.conductor",
        "conductor",
        objectId,
      ),
    [objectId, selection],
  );

  const conductorNavLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      conductorOriginSelection,
    );
  }, [conductorOriginSelection, objectId, scene.data]);

  const handleOpenGeometry = useCallback(() => {
    const geomLink = conductorNavLinks.find((l) => l.key === "geometry");
    if (geomLink) {
      openAntennaNavigationLink({
        kernel,
        link: geomLink,
        objectId,
        originSelection: conductorOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.antenna.geometry",
        label: "Geometry",
        nodeId: `model:object:${objectId}:geometry`,
        objectId,
        ref: {
          kind: "object.antenna.geometry",
          nodeId: `model:object:${objectId}:geometry`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [conductorNavLinks, conductorOriginSelection, kernel, objectId, sessionScopeKey]);

  const handleOpenMeshPolicy = useCallback(() => {
    const meshLink = conductorNavLinks.find((l) => l.key === "mesh");
    if (meshLink) {
      openAntennaNavigationLink({
        kernel,
        link: meshLink,
        objectId,
        originSelection: conductorOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.mesh",
        label: "Mesh",
        nodeId: `model:object:${objectId}:mesh`,
        objectId,
        ref: {
          kind: "object.mesh",
          nodeId: `model:object:${objectId}:mesh`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [conductorNavLinks, conductorOriginSelection, kernel, objectId, sessionScopeKey]);

  const baseline = useMemo<AntennaConductorDraft>(() => {
    const sigma = asNumber(geomParams?.conductivity_s_per_m) ?? 5.96e7;
    const inletSigma =
      asNumber(loopRec?.inlet_connection_conductivity_s_per_m) ?? sigma;
    const outletSigma =
      asNumber(loopRec?.outlet_connection_conductivity_s_per_m) ?? sigma;
    return {
      conductivitySpm: sigma,
      inletBridgeConductivitySpm: inletSigma,
      metalPreset: matchMetalPreset(sigma),
      outletBridgeConductivitySpm: outletSigma,
      referenceFreqHz: 10e9,
    };
  }, [geomParams, loopRec]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const spec = useMemo<InspectorSpec<AntennaConductorDraft>>(
    () => ({
      id: "object.antenna.conductor",
      header: {
        breadcrumbs: [
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
          { id: "conductor", label: "Conductor" },
        ],
      },
      identity: {
        domain: "material",
        entityId: `cond:${objectId}`,
        icon: Zap,
        kindLabel: "Ohmic charge transport material & RF ports",
        statePill: () => ({ label: "Committed", tone: "ok" }),
        title: () => `${antennaName} Conductor`,
      },
      facts: (d) => {
        const skinDepthM =
          d.conductivitySpm > 0 && d.referenceFreqHz > 0
            ? 1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm)
            : null;
        const presetLabel =
          CONDUCTOR_METALS.find((m) => m.id === d.metalPreset)?.id.toUpperCase() ??
          "Custom";
        return [
          { id: "metal", label: "Metal preset", value: presetLabel },
          {
            id: "sigma",
            label: "Conductivity σ",
            value:
              d.conductivitySpm > 0
                ? `${(d.conductivitySpm / 1e6).toFixed(2)} MS/m`
                : "Not configured",
          },
          {
            id: "rho",
            label: "Resistivity ρ",
            value:
              d.conductivitySpm > 0
                ? `${((1 / d.conductivitySpm) * 1e8).toFixed(2)} µΩ·cm`
                : null,
          },
          {
            id: "delta",
            label: "Skin depth δ",
            value: formatLengthSmart(skinDepthM),
          },
        ];
      },
      notices: (d): readonly InspectorNotice<AntennaConductorDraft>[] => {
        const skinDepthM =
          d.conductivitySpm > 0 && d.referenceFreqHz > 0
            ? 1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm)
            : null;
        if (skinDepthM !== null && thicknessM > skinDepthM) {
          return [
            {
              id: "skin-depth-warn",
              text: `Conductor thickness t = ${formatLengthSmart(thicknessM)} exceeds AC skin depth δ = ${formatLengthSmart(skinDepthM)} at ${(d.referenceFreqHz / 1e9).toFixed(1)} GHz.`,
              title: "AC skin-effect regime",
              tone: "warn",
            },
          ];
        }
        return [];
      },
      sections: [
        {
          defaultOpen: true,
          footer: () => (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={handleOpenGeometry}
              >
                Open Geometry
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={handleOpenMeshPolicy}
              >
                Open Mesh Policy
              </Button>
            </div>
          ),
          icon: Layers,
          id: "conductor-details",
          rows: [
            {
              format: () => asString(antennaObj?.role) ?? "antenna",
              label: "Role",
              mono: true,
              type: "readonly",
            },
            {
              format: () => asString(geom?.geometry_kind) ?? "Not configured",
              label: "Layout",
              mono: true,
              type: "readonly",
            },
            {
              format: () => partIdsText,
              label: "Part IDs",
              mono: true,
              type: "readonly",
            },
            {
              format: () => asString(antennaObj?.material_ref) ?? "Unassigned",
              label: "Object material ref",
              mono: true,
              type: "readonly",
            },
            {
              format: () => (antennaObj?.object_mesh ? "Authored" : "Default"),
              label: "Authored mesh policy",
              type: "readonly",
            },
            ...objectTransports.flatMap((ct) => {
              const trName = asString(ct.name) ?? "transport";
              const mats = Array.isArray(ct.materials)
                ? ct.materials.map(asRecord).filter((m): m is JsonRecord => m !== null)
                : [];
              const matchingMats = mats.filter(
                (m) => asString(asRecord(m.region)?.object_id) === objectId,
              );
              if (matchingMats.length === 0) {
                return [
                  {
                    format: () => "Not configured",
                    label: `Charge conductivity · ${trName}`,
                    type: "readonly" as const,
                  },
                ];
              }
              return matchingMats.map((m, idx) => {
                const regionId = asString(asRecord(m.region)?.region_id) ?? "whole";
                const sigmaVal = asRecord(m.material)?.sigma_Spm;
                return {
                  format: () => formatAntennaParameter(sigmaVal, "S/m"),
                  label:
                    matchingMats.length === 1 && regionId === "whole"
                      ? `Charge conductivity · ${trName}`
                      : `Charge conductivity · ${trName} (${regionId || idx + 1})`,
                  type: "readonly" as const,
                };
              });
            }),
          ],
          title: "Conductor identity & charge transport",
        },
        {
          defaultOpen: true,
          icon: Zap,
          id: "primary-conductor",
          rows: [
            {
              key: "metalPreset",
              label: "Conductor metal preset",
              options: [
                ...CONDUCTOR_METALS.map((m) => ({ label: m.label, value: m.id })),
                { label: "Custom Conductivity", value: "custom" },
              ],
              type: "select",
            },
            {
              defaultDisplayUnit: "MS/m",
              key: "conductivitySpm",
              label: "Electrical conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              symbol: <>&sigma;</>,
              type: "quantity",
              units: CONDUCTIVITY_UNITS,
            },
            {
              defaultDisplayUnit: "MS/m",
              key: "inletBridgeConductivitySpm",
              label: "Inlet bridge conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              showWhen: () => isClosedLoop,
              symbol: (
                <>
                  &sigma;<sub>in</sub>
                </>
              ),
              type: "quantity",
              units: CONDUCTIVITY_UNITS,
            },
            {
              defaultDisplayUnit: "MS/m",
              key: "outletBridgeConductivitySpm",
              label: "Outlet bridge conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              showWhen: () => isClosedLoop,
              symbol: (
                <>
                  &sigma;<sub>out</sub>
                </>
              ),
              type: "quantity",
              units: CONDUCTIVITY_UNITS,
            },
            {
              format: (d) =>
                d.conductivitySpm > 0
                  ? `${((1 / d.conductivitySpm) * 1e8).toFixed(3)} µΩ·cm`
                  : "Not configured",
              label: "DC resistivity",
              symbol: <>&rho;</>,
              type: "readonly",
            },
          ],
          title: "Primary conductor material",
        },
        {
          defaultOpen: true,
          icon: PlugZap,
          id: "add-antenna-port",
          rows: [
            {
              render: () => (
                <RadixAntennaPortComposer
                  objectId={objectId}
                  refetch={scene.refetch}
                  scene={scene.data ?? null}
                  sessionScopeKey={sessionScopeKey}
                  status={scene.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Add antenna port",
        },
        {
          defaultOpen: false,
          icon: Activity,
          id: "skin-depth",
          live: true,
          rows: [
            {
              defaultDisplayUnit: "GHz",
              key: "referenceFreqHz",
              label: "Reference RF frequency",
              min: 1e3,
              minExclusive: true,
              symbol: (
                <>
                  f<sub>ref</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              format: (d) => {
                if (d.conductivitySpm <= 0 || d.referenceFreqHz <= 0) {
                  return "Not computed";
                }
                const delta =
                  1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm);
                return `${formatLengthSmart(delta)} (${thicknessM <= delta ? "t <= δ quasi-static" : "t > δ AC skin regime"})`;
              },
              label: "Skin depth at f_ref",
              symbol: <>&delta;</>,
              type: "readonly",
            },
          ],
          title: "Reference skin-depth check",
        },
      ],
      commitBar: {
        cleanMessage: () => "Conductor conductivity is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;

          let request: MergePatchTransactionRequest;

          const sceneWithRev = scene.data
            ? ({ ...scene.data, revision: baseRev } as SceneResource)
            : null;

          let canonicalCtx: ReturnType<typeof conductorMaterialContext> | null = null;
          if (sceneWithRev) {
            try {
              canonicalCtx = conductorMaterialContext(sceneWithRev, objectId);
            } catch {
              canonicalCtx = null;
            }
          }

          if (sceneWithRev && canonicalCtx) {
            const materialDraft: ConductorMaterialDraft = {
              baseRevision: baseRev,
              dirty: true,
              key: JSON.stringify([sessionScopeKey ?? "local", objectId]),
              rows: canonicalCtx.rows.map((row) => {
                if (row.key === "inlet_connection_conductivity_s_per_m") {
                  return { ...row, value: String(draft.inletBridgeConductivitySpm) };
                }
                if (row.key === "outlet_connection_conductivity_s_per_m") {
                  return { ...row, value: String(draft.outletBridgeConductivitySpm) };
                }
                return { ...row, value: String(draft.conductivitySpm) };
              }),
            };
            request = buildConductorMaterialTransaction(
              sceneWithRev,
              objectId,
              materialDraft,
            ) as MergePatchTransactionRequest;
          } else {
            const patchedObjects = objects.map((obj) => {
              if (asString(obj.id) !== objectId) return obj;
              const g = asRecord(obj.geometry) ?? {};
              const gp = asRecord(g.geometry_params) ?? {};
              const existingLoop = asRecord(gp.loop);
              return {
                ...obj,
                geometry: {
                  ...g,
                  geometry_params: {
                    ...gp,
                    conductivity_s_per_m: draft.conductivitySpm,
                    ...(existingLoop?.enabled === true
                      ? {
                          loop: {
                            ...existingLoop,
                            inlet_connection_conductivity_s_per_m:
                              draft.inletBridgeConductivitySpm,
                            outlet_connection_conductivity_s_per_m:
                              draft.outletBridgeConductivitySpm,
                          },
                        }
                      : {}),
                  },
                },
              };
            });

            const rawTransports = Array.isArray(sceneRec?.current_transports)
              ? sceneRec.current_transports
              : null;
            const patchedTransports = rawTransports
              ? rawTransports.map((entry) => {
                  const ct = asRecord(entry);
                  if (
                    !ct ||
                    !Array.isArray(ct.domain) ||
                    !ct.domain.some(
                      (ref) => asString(asRecord(ref)?.object_id) === objectId,
                    )
                  ) {
                    return entry;
                  }
                  const mats = Array.isArray(ct.materials)
                    ? ct.materials.map((mEntry) => {
                        const mr = asRecord(mEntry);
                        if (
                          !mr ||
                          asString(asRecord(mr.region)?.object_id) !== objectId
                        ) {
                          return mEntry;
                        }
                        const regionId = asString(asRecord(mr.region)?.region_id);
                        const inletId = asString(loopRec?.inlet_connection_part_id);
                        const outletId = asString(loopRec?.outlet_connection_part_id);
                        const sigmaTarget =
                          isClosedLoop && regionId && regionId === inletId
                            ? draft.inletBridgeConductivitySpm
                            : isClosedLoop && regionId && regionId === outletId
                              ? draft.outletBridgeConductivitySpm
                              : draft.conductivitySpm;
                        return {
                          ...mr,
                          material: {
                            ...(asRecord(mr.material) ?? {}),
                            sigma_Spm: sigmaTarget,
                          },
                        };
                      })
                    : ct.materials;
                  return { ...ct, materials: mats };
                })
              : undefined;

            request = {
              base_revision: baseRev,
              kind: "merge_patch",
              merge_patch: {
                objects: patchedObjects as unknown as JsonObject[],
                ...(patchedTransports
                  ? {
                      current_transports: patchedTransports as unknown as JsonObject[],
                    }
                  : {}),
              },
            };
          }

          await executeAntennaMergePatchTransaction({
            kernel,
            label: `Edit antenna conductor conductivity ${objectId}`,
            mutationKind: "material",
            request,
            scene: scene.data,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      antennaName,
      antennaObj,
      geom,
      handleOpenGeometry,
      handleOpenMeshPolicy,
      isClosedLoop,
      kernel,
      loopRec,
      objectId,
      objectTransports,
      objects,
      partIdsText,
      scene.data,
      scene.refetch,
      scene.status,
      sceneRec,
      sessionScopeKey,
      thicknessM,
    ],
  );

  const handleConductorFieldChange = useCallback(
    <K extends keyof AntennaConductorDraft & string>(
      key: K,
      value: AntennaConductorDraft[K],
      helpers: { patchDraft: (partial: Partial<AntennaConductorDraft>) => void },
    ) => {
      if (key === "metalPreset" && typeof value === "string" && value !== "custom") {
        const matched = CONDUCTOR_METALS.find((m) => m.id === value);
        if (matched) {
          helpers.patchDraft({ conductivitySpm: matched.sigmaSpm });
        }
      } else if (key === "conductivitySpm" && typeof value === "number") {
        helpers.patchDraft({ metalPreset: matchMetalPreset(value) });
      }
    },
    [],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleConductorFieldChange}
    />
  );
}
