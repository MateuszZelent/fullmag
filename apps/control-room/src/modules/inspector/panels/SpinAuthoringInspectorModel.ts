export {
  isUnsupportedSpinAuthoringResource,
  type SpinAuthoringFamily,
} from "@/shared/domain/physics/spinAuthoringRecognition";

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
