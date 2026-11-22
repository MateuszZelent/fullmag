import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";

export * from "../../inspectors/mesh";
export {
  computeExchangeLengthGuard,
  estimateSceneFdmGridShape,
  formatLengthSmart,
  MeshBuildsInspectorSpecPanel,
  MeshQualityInspectorSpecPanel,
  MeshRegionsInspectorSpecPanel,
  MeshRootInspectorSpecPanel,
  MeshSharedDomainInspectorSpecPanel,
  MeshSizeFieldsInspectorSpecPanel,
  MeshUnassignedInspectorSpecPanel,
  MeshUnassignedPartInspectorSpecPanel,
  ObjectMeshInspectorSpecPanel,
  type ExchangeLengthGuardEvaluation,
} from "../../inspectors/mesh";

export const MESH_ROOT_SESSION_METHOD_CONTRACT = {
  hint: "Assigned by the session simulation mode",
  label: "Session method",
  resolveSessionDiscretization,
} as const;
