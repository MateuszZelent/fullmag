import type {
  AuthoringTransactionRequest,
  DomainMetaResource,
  JsonObject,
  MeshSharedDomainConfigResource,
  MeshUniverseConfigResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import * as meshPolicyResourceCache from "@/kernel/resources/meshPolicyResourceCache";

import {
  buildAirboxMeshPolicyReplaceRequest,
  draftFromEffectiveUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  rebaseAirboxMeshPolicyDraft,
} from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  buildSharedDomainPolicyConfig,
  draftFromEffectiveSharedDomainResource,
  draftFromSharedDomainResource,
  type SharedDomainPolicyDraft,
} from "../../panels/mesh-details/sharedDomainMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  asString,
  buildSafeMutationContext,
  estimateSceneFdmGridShape,
  SESSION_STATUS_KEY,
  snapSevenSmooth,
} from "./meshShared";

export interface MeshRootDraft {
  lane: "fdm" | "fem";
  zStackMode: "single_3d" | "multilayer";
  sizingMode: "cell_size" | "cell_count";
  cellSizeM: readonly [number, number, number];
  gridCountX: number;
  gridCountY: number;
  gridCountZ: number;
  fftSmoothSnap: boolean;
  hmaxM: number;
  hminM: number;
  growthRate: number;
  curvatureFactor: number;
  narrowRegionResolution: number;
  enableNarrowRegionRefinement: boolean;
  elementsAcrossThickness: number;
  anisotropyLimit: number;
  optimizeMethod: string;
  optimizeQuality: boolean;
}

export function buildMeshRootBaseline(input: {
  domainGrid: DomainMetaResource["grid"] | null | undefined;
  femActive: boolean;
  multilayerAvailable: boolean;
  sceneData: SceneResource | null | undefined;
  sharedPolicyData: MeshSharedDomainConfigResource | null | undefined;
  universePolicyData: MeshUniverseConfigResource | null | undefined;
}): MeshRootDraft {
  const {
    domainGrid: grid,
    femActive,
    multilayerAvailable,
    sceneData,
    sharedPolicyData,
    universePolicyData,
  } = input;

  const studyRec = asRecord(asRecord(sceneData)?.study);
  const fdmRec = asRecord(studyRec?.fdm);
  const demagRec = asRecord(fdmRec?.demag);
  const authoredCell = Array.isArray(fdmRec?.default_cell)
    ? (fdmRec.default_cell as unknown[]).map(asNumber)
    : [];
  const spacing = grid?.spacing ?? [4e-9, 4e-9, 2e-9];
  const shape = grid?.shape ?? [128, 64, 1];
  const commonCells = Array.isArray(demagRec?.common_cells)
    ? (demagRec.common_cells as unknown[]).map(asNumber)
    : Array.isArray(demagRec?.common_cells_xy)
      ? [
          asNumber((demagRec.common_cells_xy as unknown[])[0]),
          asNumber((demagRec.common_cells_xy as unknown[])[1]),
          1,
        ]
      : [];

  const sharedCfg =
    asRecord(sharedPolicyData?.config) ??
    asRecord(asRecord(sharedPolicyData)?.effective_config);
  const universeCfg =
    asRecord(universePolicyData?.config) ??
    asRecord(universePolicyData?.effective_config);
  const narrowObj =
    asRecord(sharedCfg?.narrow_region_resolution) ??
    asRecord(universeCfg?.narrow_region_resolution);

  const optRaw = sharedCfg?.optimize;
  const optimizeMethod =
    typeof optRaw === "string" && optRaw.trim().length > 0
      ? optRaw.trim()
      : "Netgen";
  const optimizeQuality =
    typeof optRaw === "string"
      ? optRaw.trim().length > 0
      : sharedCfg?.optimize_quality !== false;

  const demagMode = asString(demagRec?.mode);
  const demagStrategy = asString(demagRec?.strategy);
  const isMultilayer =
    demagMode === "two_d_stack" ||
    demagStrategy === "multilayer_convolution" ||
    multilayerAvailable;

  return {
    anisotropyLimit:
      asNumber(narrowObj?.anisotropy_limit) ??
      asNumber(sharedCfg?.anisotropy_limit) ??
      asNumber(universeCfg?.anisotropy_limit) ??
      5,
    cellSizeM: [
      authoredCell[0] && authoredCell[0] > 0
        ? authoredCell[0]
        : spacing[0] && spacing[0] > 0
          ? spacing[0]
          : 4e-9,
      authoredCell[1] && authoredCell[1] > 0
        ? authoredCell[1]
        : spacing[1] && spacing[1] > 0
          ? spacing[1]
          : 4e-9,
      authoredCell[2] && authoredCell[2] > 0
        ? authoredCell[2]
        : spacing[2] && spacing[2] > 0
          ? spacing[2]
          : 2e-9,
    ],
    curvatureFactor:
      asNumber(sharedCfg?.curvature_factor) ??
      asNumber(universeCfg?.airbox_curvature_factor) ??
      0.35,
    elementsAcrossThickness:
      asNumber(narrowObj?.elements_across_thickness) ??
      asNumber(sharedCfg?.elements_across_thickness) ??
      asNumber(universeCfg?.elements_across_thickness) ??
      2,
    enableNarrowRegionRefinement:
      typeof narrowObj?.enable_narrow_region_refinement === "boolean"
        ? narrowObj.enable_narrow_region_refinement
        : typeof sharedCfg?.enable_narrow_region_refinement === "boolean"
          ? (sharedCfg.enable_narrow_region_refinement as boolean)
          : Boolean(
              asNumber(sharedCfg?.narrow_region_resolution) ??
                asNumber(universeCfg?.airbox_narrow_region_resolution),
            ),
    fftSmoothSnap: typeof demagRec?.explain === "boolean" ? demagRec.explain : true,
    gridCountX:
      commonCells[0] && commonCells[0] > 0
        ? commonCells[0]
        : shape[0] && shape[0] > 0
          ? shape[0]
          : 128,
    gridCountY:
      commonCells[1] && commonCells[1] > 0
        ? commonCells[1]
        : shape[1] && shape[1] > 0
          ? shape[1]
          : 64,
    gridCountZ:
      commonCells[2] && commonCells[2] > 0
        ? commonCells[2]
        : shape[2] && shape[2] > 0
          ? shape[2]
          : 1,
    growthRate:
      asNumber(sharedCfg?.growth_rate) ??
      asNumber(sharedCfg?.maximum_element_growth_rate) ??
      asNumber(universeCfg?.airbox_growth_rate) ??
      1.3,
    hmaxM:
      asNumber(sharedCfg?.hmax) ??
      asNumber(sharedCfg?.maximum_element_size) ??
      asNumber(universeCfg?.airbox_hmax) ??
      5e-9,
    hminM:
      asNumber(sharedCfg?.hmin) ??
      asNumber(sharedCfg?.minimum_element_size) ??
      asNumber(universeCfg?.airbox_hmin) ??
      2e-9,
    lane: femActive ? "fem" : "fdm",
    narrowRegionResolution:
      asNumber(sharedCfg?.narrow_region_resolution) ??
      asNumber(universeCfg?.airbox_narrow_region_resolution) ??
      2,
    optimizeMethod,
    optimizeQuality,
    sizingMode: commonCells[0] && !authoredCell[0] ? "cell_count" : "cell_size",
    zStackMode: isMultilayer ? "multilayer" : "single_3d",
  };
}

export function hasAuthoredSceneFdmSizing(sceneData: unknown): boolean {
  const studyRec = asRecord(asRecord(sceneData)?.study);
  const fdmRec = asRecord(studyRec?.fdm);
  const demagRec = asRecord(fdmRec?.demag);
  const hasCell =
    Array.isArray(fdmRec?.default_cell) &&
    fdmRec.default_cell.length >= 3 &&
    fdmRec.default_cell.every((v) => (asNumber(v) ?? 0) > 0);
  const hasCount =
    (Array.isArray(demagRec?.common_cells) && demagRec.common_cells.length >= 3) ||
    (Array.isArray(demagRec?.common_cells_xy) && demagRec.common_cells_xy.length >= 2);
  return hasCell || hasCount;
}

export function resolveEffectiveFdmGridShape(
  sceneData: unknown,
  draft: MeshRootDraft,
): [number, number, number] {
  if (draft.sizingMode === "cell_count") {
    return [
      draft.fftSmoothSnap
        ? snapSevenSmooth(draft.gridCountX)
        : Math.max(1, Math.round(draft.gridCountX)),
      draft.fftSmoothSnap
        ? snapSevenSmooth(draft.gridCountY)
        : Math.max(1, Math.round(draft.gridCountY)),
      Math.max(1, Math.round(draft.gridCountZ)),
    ];
  }
  return (
    estimateSceneFdmGridShape(sceneData, draft.cellSizeM, draft.fftSmoothSnap) ?? [
      draft.gridCountX,
      draft.gridCountY,
      draft.gridCountZ,
    ]
  );
}

export function isMeshRootFdmDraftModified(
  draft: MeshRootDraft,
  base: MeshRootDraft,
): boolean {
  return (
    draft.sizingMode !== base.sizingMode ||
    draft.zStackMode !== base.zStackMode ||
    draft.fftSmoothSnap !== base.fftSmoothSnap ||
    draft.gridCountX !== base.gridCountX ||
    draft.gridCountY !== base.gridCountY ||
    draft.gridCountZ !== base.gridCountZ ||
    draft.cellSizeM[0] !== base.cellSizeM[0] ||
    draft.cellSizeM[1] !== base.cellSizeM[1] ||
    draft.cellSizeM[2] !== base.cellSizeM[2]
  );
}

export async function persistMeshRootFdmPolicy(input: {
  draft: MeshRootDraft;
  kernel: ReturnType<typeof useKernel>;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | undefined;
  universePolicyData: MeshUniverseConfigResource | null | undefined;
}): Promise<SceneResource | null> {
  const { draft, kernel, sceneData, sessionScopeKey, universePolicyData } = input;
  const reqOptions = sessionScopeKey ? { sessionScopeKey } : undefined;
  const nx = draft.fftSmoothSnap
    ? snapSevenSmooth(draft.gridCountX)
    : Math.max(1, Math.round(draft.gridCountX));
  const ny = draft.fftSmoothSnap
    ? snapSevenSmooth(draft.gridCountY)
    : Math.max(1, Math.round(draft.gridCountY));
  const nz = Math.max(1, Math.round(draft.gridCountZ));

  const studyRec = asRecord(asRecord(sceneData)?.study);
  const existingFdm = asRecord(studyRec?.fdm) ?? {};
  const existingDemag = asRecord(existingFdm.demag) ?? {};
  const demagStrategy =
    draft.zStackMode === "multilayer" ? "multilayer_convolution" : "single_grid";
  const demagMode = draft.zStackMode === "multilayer" ? "two_d_stack" : "three_d";

  const fdmPatch: JsonObject = {
    ...(existingFdm as JsonObject),
    default_cell: draft.sizingMode === "cell_size" ? [...draft.cellSizeM] : null,
    demag: {
      ...(existingDemag as JsonObject),
      common_cells:
        draft.sizingMode === "cell_count" && draft.zStackMode !== "multilayer"
          ? [nx, ny, nz]
          : null,
      common_cells_xy:
        draft.sizingMode === "cell_count" && draft.zStackMode === "multilayer"
          ? [nx, ny]
          : null,
      explain: draft.fftSmoothSnap,
      mode: demagMode,
      strategy: demagStrategy,
    },
  };

  const baseRevision =
    asNumber(asRecord(sceneData)?.revision) ??
    asNumber(asRecord(sceneData)?.scene_revision) ??
    0;
  const mutationCtx = buildSafeMutationContext(
    kernel,
    sessionScopeKey,
    "mesh.root.fdm",
  );
  const committed = await runAuthoringMutationWithHistory(
    mutationCtx,
    "Update FDM discretization policy",
    async (prep) => {
      const tx: AuthoringTransactionRequest = {
        base_revision: prep.baseRevision ?? baseRevision,
        kind: "merge_patch",
        merge_patch: {
          study: {
            fdm: fdmPatch,
          },
        },
      };
      return kernel.api.model.commitTransaction(tx, reqOptions);
    },
  );
  const committedScene = asRecord(committed)?.committed_scene as
    | SceneResource
    | undefined;
  if (
    committedScene &&
    geometryLifecycleResources.publishCommittedSceneResource
  ) {
    const committedRev =
      asNumber(asRecord(committedScene)?.revision) ?? `w5:${Date.now()}`;
    geometryLifecycleResources.publishCommittedSceneResource(
      kernel.resources,
      committedScene,
      committedRev,
      undefined,
      true,
      sessionScopeKey ?? null,
      kernel.api.resourceCacheScope,
    );
  }
  const uniResource: MeshUniverseConfigResource =
    universePolicyData ?? {
      config: null,
      effective_config: null,
      revision: 0,
    };
  if (uniResource.config !== null && uniResource.config !== undefined) {
    const uniDraft = rebaseAirboxMeshPolicyDraft(
      draftFromUniverseMeshPolicyResource(uniResource),
      universePolicyData ?? null,
    );
    const builtUni = buildAirboxMeshPolicyReplaceRequest(uniDraft, {
      lane: "fdm",
    });
    if (!("error" in builtUni) && builtUni.request) {
      await kernel.api.meshing.replaceUniversePolicy(builtUni.request, reqOptions);
    }
  }
  invalidateAuthoringMutationDependents(
    kernel.resources,
    "geometry",
    `w5:${Date.now()}`,
  );
  kernel.resources.invalidate(
    geometryLifecycleResources.SCENE_RESOURCE_KEY,
    `w5:${Date.now()}`,
  );
  kernel.resources.invalidate(SESSION_STATUS_KEY, `w5:${Date.now()}`);
  kernel.resources.invalidate(
    geometryLifecycleResources.MESH_UNIVERSE_POLICY_RESOURCE_KEY,
    `w5:${Date.now()}`,
  );
  return committedScene ?? null;
}

export async function applyMeshRootFemPolicy(input: {
  draft: MeshRootDraft;
  kernel: ReturnType<typeof useKernel>;
  sessionScopeKey: string | undefined;
  sharedPolicyData: MeshSharedDomainConfigResource | null | undefined;
  universePolicyData: MeshUniverseConfigResource | null | undefined;
}): Promise<void> {
  const { draft, kernel, sessionScopeKey, sharedPolicyData, universePolicyData } =
    input;
  const reqOptions = sessionScopeKey ? { sessionScopeKey } : undefined;

  const baseShared = draftFromSharedDomainResource(sharedPolicyData ?? null);
  const nextSharedDraft: SharedDomainPolicyDraft = {
    ...baseShared,
    authoredPresent: true,
    curvatureFactor: String(draft.curvatureFactor),
    growthRate: String(draft.growthRate),
    hMax: String(draft.hmaxM),
    hMin: String(draft.hminM),
    narrowRegionResolution: String(draft.narrowRegionResolution),
    optimize: draft.optimizeQuality,
    optimizeMethod: draft.optimizeMethod || "Netgen",
  };
  const builtShared = buildSharedDomainPolicyConfig(nextSharedDraft);
  if (!builtShared.ok) {
    throw new Error(builtShared.error);
  }
  const configPayload: JsonObject = {
    ...builtShared.config,
    ...(draft.enableNarrowRegionRefinement
      ? {
          anisotropy_limit: draft.anisotropyLimit,
          elements_across_thickness: draft.elementsAcrossThickness,
          enable_narrow_region_refinement: true,
        }
      : {
          enable_narrow_region_refinement: false,
        }),
  };

  const nextShared = await kernel.api.meshing.sharedDomain.replacePolicy(
    { config: configPayload },
    reqOptions,
  );
  const nextRev =
    typeof nextShared?.revision === "number"
      ? nextShared.revision
      : `w5:${Date.now()}`;

  if (sessionScopeKey && nextShared && typeof nextShared.revision === "number") {
    meshPolicyResourceCache.publishCommittedMeshPolicyResource?.(
      kernel.resources,
      geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
      sessionScopeKey,
      nextShared,
      kernel.api.resourceCacheScope,
    );
  }

  const uniResource: MeshUniverseConfigResource =
    universePolicyData ?? {
      config: null,
      effective_config: null,
      revision: 0,
    };
  if (uniResource.config !== null && uniResource.config !== undefined) {
    const uniDraft = rebaseAirboxMeshPolicyDraft(
      {
        ...draftFromUniverseMeshPolicyResource(uniResource),
        narrowRegionResolution: String(draft.narrowRegionResolution),
      },
      universePolicyData ?? null,
    );
    const builtUni = buildAirboxMeshPolicyReplaceRequest(uniDraft, {
      lane: "fem",
    });
    if (!("error" in builtUni) && builtUni.request) {
      await kernel.api.meshing.replaceUniversePolicy(builtUni.request, reqOptions);
    }
  }

  kernel.resources.invalidate(
    geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
    nextRev,
  );
  kernel.resources.invalidate(
    geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
    nextRev,
  );
  kernel.resources.invalidate(
    geometryLifecycleResources.SCENE_RESOURCE_KEY,
    `mesh-policy:shared-domain:${String(nextRev)}`,
  );
  kernel.resources.invalidate(
    SESSION_STATUS_KEY,
    `mesh-policy:shared-domain:${String(nextRev)}`,
  );
}

export function buildEffectiveFemDefaultsPatch(
  sharedPolicyData: MeshSharedDomainConfigResource | null | undefined,
  universePolicyData: MeshUniverseConfigResource | null | undefined,
): Partial<MeshRootDraft> {
  const sharedEffective = asRecord(asRecord(sharedPolicyData)?.effective_config);
  const effShared = draftFromEffectiveSharedDomainResource(
    sharedPolicyData
      ? {
          config: sharedEffective ?? sharedPolicyData.config ?? null,
          effective_config: sharedEffective ?? null,
          revision: sharedPolicyData.revision,
        }
      : null,
  );
  const uniResource: MeshUniverseConfigResource =
    universePolicyData ?? {
      config: null,
      effective_config: null,
      revision: 0,
    };
  const effUni = draftFromEffectiveUniverseMeshPolicyResource({
    ...uniResource,
    config: uniResource.effective_config ?? uniResource.config ?? null,
  });
  const patch: Partial<MeshRootDraft> = {
    optimizeMethod: effShared.optimizeMethod || "Netgen",
    optimizeQuality: effShared.optimize,
  };
  const hmax = asNumber(effShared.hMax) ?? asNumber(effUni.airboxHmax);
  const hmin = asNumber(effShared.hMin) ?? asNumber(effUni.airboxHmin);
  const growth =
    asNumber(effShared.growthRate) ?? asNumber(effUni.airboxGrowthRate);
  const curv =
    asNumber(effShared.curvatureFactor) ?? asNumber(effUni.curvatureFactor);
  const narrow =
    asNumber(effShared.narrowRegionResolution) ??
    asNumber(effUni.narrowRegionResolution);
  if (hmax !== null && hmax > 0) patch.hmaxM = hmax;
  if (hmin !== null && hmin > 0) patch.hminM = hmin;
  if (growth !== null && growth > 0) patch.growthRate = growth;
  if (curv !== null && curv > 0) patch.curvatureFactor = curv;
  if (narrow !== null && narrow > 0) {
    patch.narrowRegionResolution = narrow;
    patch.enableNarrowRegionRefinement = true;
  }
  return patch;
}
