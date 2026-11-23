export {
  MaterialLibraryPickerDialog,
  type MaterialLibraryPickerDialogProps,
} from "./MaterialLibraryPickerDialog";
export {
  computePendingPhysicsActivations,
  type MaterialPhysicsSyncParams,
  type MaterialPhysicsSyncResult,
  type PendingPhysicsActivation,
  type PhysicsActivationError,
  syncMaterialPhysicsAutoActivation,
} from "./materialPhysicsAutoActivation";
export {
  buildConstitutiveMergePatch,
  buildUniaxialInteractionPayload,
  type BuiltInReferenceMaterial,
  classifyUniaxialAnisotropyRegime,
  computeAnisotropyFieldTesla,
  computeExchangeLengthMeters,
  formatAnisotropyFieldReadout,
  orthogonalizeAxisGramSchmidt,
  REFERENCE_MATERIALS_CATALOG,
  resolveMaterialPropertiesFromDraft,
  type UnifiedObjectMaterialDraft,
  validateBornCubicStability,
} from "./materialShared";
export { ObjectMaterialInspectorPanel } from "./ObjectMaterialSpec";
