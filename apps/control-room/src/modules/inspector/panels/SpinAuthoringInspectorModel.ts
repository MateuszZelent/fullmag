import type { SceneCurrentTransport } from "@/kernel/api/apiTypes";
import { isKnownCurrentTransport } from "@/shared/domain/physics/transportRecognition";

export {
  isUnsupportedSpinAuthoringResource,
  type SpinAuthoringFamily,
} from "@/shared/domain/physics/spinAuthoringRecognition";

export interface CurrentSourceOption {
  label: string;
  value: string;
}

export type TorqueCurrentBinding = "prescribed_density" | "current_transport";

export function torqueCurrentBindingPatch(
  draft: { currentDensity: string; currentSource: string },
  binding: TorqueCurrentBinding,
  defaultCurrentSource = "",
): { currentDensity: string; currentSource: string } {
  if (binding === "current_transport") {
    return {
      currentDensity: "",
      currentSource: draft.currentSource.trim()
        ? draft.currentSource
        : defaultCurrentSource,
    };
  }
  return {
    currentDensity: draft.currentDensity.trim()
      ? draft.currentDensity
      : "0, 0, 0",
    currentSource: "",
  };
}

export function currentSourceOptions(
  currents: readonly SceneCurrentTransport[],
  currentValue: string,
): CurrentSourceOption[] {
  const available = Array.from(new Set(currents.flatMap((current) => {
    if (!isKnownCurrentTransport(current)) return [];
    const name = current.name.trim();
    return name ? [name] : [];
  }))).sort((left, right) => left.localeCompare(right));
  const selected = currentValue.trim();
  return [
    ...(selected && !available.includes(selected)
      ? [{ label: `${selected} (unavailable)`, value: selected }]
      : []),
    ...available.map((value) => ({ label: value, value })),
  ];
}

/**
 * Inventory of the existing torque/Oersted drafts. JSON textareas stay
 * explicitly opaque so unknown records remain lossless and fail closed.
 */
export const SPIN_AUTHORING_DRAFT_INVENTORY = {
  spin_torque: {
    typed: [
      "id",
      "kind",
      "currentDensity",
      "currentSource",
      "degree",
      "beta",
      "spinPolarization",
      "lambdaAsymmetry",
      "epsilonPrime",
      "fixedLayerPosition",
      "formulaVersion",
      "freeLayerThickness",
      "stackNormal",
      "schemaVersion",
      "xiDl",
      "xiFl",
      "rawSpinPolarization",
    ],
    opaque: ["drive", "target", "realization", "compatibilityOrigin"],
  },
  oersted_field: {
    typed: ["id", "kind", "axis", "center", "current", "radius", "source", "model"],
    opaque: ["timeDependence"],
  },
} as const;
