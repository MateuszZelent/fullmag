"use client";

import { useMemo } from "react";

import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  evaluateFemMeshReadinessGuide,
  type FemMeshReadinessGuideModel,
} from "./femMeshReadinessGuide";

type OptionalResourceHook<T> = (options?: { enabled?: boolean }) => {
  data: T | null;
  status?: string;
};

function getOptionalLifecycleHook<T>(
  hookName: keyof typeof geometryLifecycleResources,
): OptionalResourceHook<T> | undefined {
  try {
    const candidate = geometryLifecycleResources[hookName];
    return typeof candidate === "function"
      ? (candidate as unknown as OptionalResourceHook<T>)
      : undefined;
  } catch {
    return undefined;
  }
}

function useOptionalResource<T>(
  hookName: keyof typeof geometryLifecycleResources,
  options: { enabled: boolean },
): { data: T | null; status: string } {
  const hook = getOptionalLifecycleHook<T>(hookName);
  if (typeof hook === "function") {
    return hook(options) as { data: T | null; status: string };
  }
  return { data: null, status: "idle" };
}

export function useFemMeshReadinessGuide(options?: {
  enabled?: boolean;
  selectedObjectId?: string | null;
  selectedObjectPolicy?: unknown;
  sharedDomainPolicy?: unknown;
  universePolicy?: unknown;
}): FemMeshReadinessGuideModel | null {
  const discretization = useSessionStatusSelector(
    (status) => status.data?.domain?.discretization ?? null,
  );
  const normalizedLane =
    typeof discretization === "string"
      ? discretization.trim().toLowerCase()
      : "";
  const femEnabled = options?.enabled !== false && normalizedLane === "fem";

  const scene = useOptionalResource("useSceneResource", {
    enabled: femEnabled,
  });
  const geometryValidation = useOptionalResource(
    "useGeometryValidationResource",
    { enabled: femEnabled },
  );
  const universePolicy = useOptionalResource("useUniverseMeshPolicyResource", {
    enabled: femEnabled && options?.universePolicy === undefined,
  });
  const meshSemantics = useOptionalResource("useMeshSemanticsResource", {
    enabled: femEnabled,
  });
  const meshSummary = useOptionalResource("useMeshSummaryResource", {
    enabled: femEnabled,
  });
  const activeBuild = useOptionalResource("useMeshBuildCurrent", {
    enabled: femEnabled,
  });
  const latestBuild = useOptionalResource("useMeshBuildLatestSuccessful", {
    enabled: femEnabled,
  });
  const qualityGates = useOptionalResource(
    "useMeshSharedDomainQualityGatesResource",
    {
      enabled: femEnabled,
    },
  );

  return useMemo(() => {
    if (!femEnabled) return null;

    const semanticsRecord =
      meshSemantics.data &&
      typeof meshSemantics.data === "object" &&
      !Array.isArray(meshSemantics.data)
        ? (meshSemantics.data as Record<string, unknown>)
        : null;
    const resolvedSharedDomainPolicy =
      options?.sharedDomainPolicy ??
      (semanticsRecord?.shared_domain_config !== undefined
        ? {
            config: semanticsRecord.shared_domain_config,
            revision: semanticsRecord.revision ?? 0,
          }
        : null);
    const resolvedUniversePolicy =
      options?.universePolicy ??
      universePolicy.data ??
      (semanticsRecord?.universe_config !== undefined
        ? {
            config: semanticsRecord.universe_config,
            revision: semanticsRecord.revision ?? 0,
          }
        : null);

    return evaluateFemMeshReadinessGuide({
      activeBuild: activeBuild.data,
      geometryValidation: geometryValidation.data,
      latestBuild: latestBuild.data,
      meshSemantics: meshSemantics.data,
      meshSummary: meshSummary.data,
      qualityGates: qualityGates.data,
      scene: scene.data,
      selectedObjectId: options?.selectedObjectId ?? null,
      selectedObjectPolicy: options?.selectedObjectPolicy ?? null,
      sharedDomainPolicy: resolvedSharedDomainPolicy,
      universePolicy: resolvedUniversePolicy,
    });
  }, [
    activeBuild.data,
    femEnabled,
    geometryValidation.data,
    latestBuild.data,
    meshSemantics.data,
    meshSummary.data,
    options?.selectedObjectId,
    options?.selectedObjectPolicy,
    options?.sharedDomainPolicy,
    options?.universePolicy,
    qualityGates.data,
    scene.data,
    universePolicy.data,
  ]);
}
