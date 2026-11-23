export {
  resolveCanonicalPhysicsModuleKind,
  type CanonicalPhysicsModuleKind,
} from "./physicsShared";
export { ObjectPhysicsInspectorPanel } from "./ObjectPhysicsSpec";
export { PhysicsModuleInspectorPanel } from "./PhysicsModuleSpec";
export {
  applyExchangeOrDmiStudyPatch,
  buildExchangeAndDmiRows,
  buildExchangeOrDmiObjectParams,
} from "./ExchangeAndDmiSpecs";
export {
  applyZeemanStudyPatch,
  buildAnisotropyAndZeemanRows,
  buildAnisotropyObjectParams,
  renderCubicAnisotropyFooter,
} from "./AnisotropyAndZeemanSpecs";
export {
  applyDemagStudyPatch,
  buildDemagRows,
  CouplingInspectorPanel,
} from "./DemagAndCouplingSpecs";
export {
  applyThermalOrPbcStudyPatch,
  buildObjectTransportAndSpinLinks,
  buildThermalElasticAndPbcRows,
  type ScopedModuleLink,
} from "./ThermalAndTransportPhysicsSpecs";
