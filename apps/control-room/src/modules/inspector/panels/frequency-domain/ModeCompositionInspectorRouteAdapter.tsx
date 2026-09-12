"use client";

import { useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useModeCompositionControllerResource } from "@/kernel/resources/modeCompositionResources";
import { useFrequencyDomainEigenSpectrumV3Resource } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  EigenSpectrumCompositionInspectorPanel,
  ModeCompositionActiveInspectorPanel,
  ModeCompositionObjectInspectorPanel,
  ModeCompositionObjectsInspectorPanel,
  type ModeCompositionInspectorDependencies,
} from "./ModeCompositionInspectors";
import { modeCompositionInspectorDependenciesFromResources } from "./modeCompositionInspectorDependencies";

/**
 * The inspector registry can only pass `InspectorPanelProps`. This adapter is
 * the single resource boundary for all four mode-composition inspector routes.
 */
function useModeCompositionInspectorDependencies(): ModeCompositionInspectorDependencies {
  const { modeComposition } = useKernel();
  const { resource: composition } = useModeCompositionControllerResource();
  const spectrum = useFrequencyDomainEigenSpectrumV3Resource();
  const scene = useSceneResource();

  return useMemo(
    () =>
      modeCompositionInspectorDependenciesFromResources({
        composition: composition.data,
        controller: modeComposition,
        scene: scene.data,
        spectrumArtifact: spectrum.data,
      }),
    [composition.data, modeComposition, scene.data, spectrum.data],
  );
}

export function EigenSpectrumCompositionInspectorRoute(
  props: InspectorPanelProps,
) {
  const dependencies = useModeCompositionInspectorDependencies();
  return (
    <EigenSpectrumCompositionInspectorPanel
      {...props}
      dependencies={dependencies}
    />
  );
}

export function ModeCompositionActiveInspectorRoute(props: InspectorPanelProps) {
  const dependencies = useModeCompositionInspectorDependencies();
  return (
    <ModeCompositionActiveInspectorPanel
      {...props}
      dependencies={dependencies}
    />
  );
}

export function ModeCompositionObjectsInspectorRoute(props: InspectorPanelProps) {
  const dependencies = useModeCompositionInspectorDependencies();
  return (
    <ModeCompositionObjectsInspectorPanel
      {...props}
      dependencies={dependencies}
    />
  );
}

export function ModeCompositionObjectInspectorRoute(props: InspectorPanelProps) {
  const dependencies = useModeCompositionInspectorDependencies();
  return (
    <ModeCompositionObjectInspectorPanel
      {...props}
      dependencies={dependencies}
    />
  );
}
