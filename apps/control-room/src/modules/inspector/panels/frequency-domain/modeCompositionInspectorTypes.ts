import type {
  ModeCompositionController,
  ModeCompositionResource,
} from "@/kernel/visualization/ModeCompositionController";

export interface ModeCompositionCompatibleObject {
  readonly label: string;
  readonly objectId: string;
  readonly targetId: `object:${string}`;
}

export interface ModeCompositionSpectrumParticipationFractions {
  readonly total: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ModeCompositionSpectrumObjectParticipation {
  readonly fractions: ModeCompositionSpectrumParticipationFractions;
  readonly objectId: string;
}

export interface ModeCompositionSpectrumParticipation {
  readonly global: ModeCompositionSpectrumParticipationFractions | null;
  readonly objects: readonly ModeCompositionSpectrumObjectParticipation[];
}

export interface ModeCompositionSpectrumMode {
  readonly branchId?: string;
  readonly fieldId: string | null;
  readonly frequencyHz: number;
  readonly modeId: string;
  readonly participation?: ModeCompositionSpectrumParticipation;
  readonly rawModeIndex?: number;
  readonly residualNorm?: number;
}

export interface ModeCompositionSpectrumSample {
  readonly label: string;
  readonly modes: readonly ModeCompositionSpectrumMode[];
  readonly sampleId: string;
}

export interface ModeCompositionInspectorSpectrum {
  readonly samples: readonly ModeCompositionSpectrumSample[];
}

export interface ModeCompositionInspectorDependencies {
  readonly compatibleObjects: readonly ModeCompositionCompatibleObject[];
  readonly controller: Pick<
    ModeCompositionController,
    "assign" | "mutate" | "remove" | "setPhaseClock" | "updateLayer"
  > | null;
  readonly resource: ModeCompositionResource | null;
  readonly spectrum: ModeCompositionInspectorSpectrum | null;
}
