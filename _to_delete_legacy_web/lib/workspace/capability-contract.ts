export type UiCapabilityDomain =
  | "geometry"
  | "mesh"
  | "physics"
  | "study"
  | "runtime"
  | "analyze";

export interface UiCapability {
  id: string;
  domain: UiCapabilityDomain;
  backendSupport: string[];
  uiPanel: string;
  serializerPath: string;
  status: "implemented" | "partial" | "missing";
}

export const CORE_UI_CAPABILITIES: UiCapability[] = [
  {
    id: "demag.realization",
    domain: "physics",
    backendSupport: ["fem", "fdm"],
    uiPanel: "PhysicsPanel",
    serializerPath: "script_builder.demag_realization",
    status: "partial",
  },
  {
    id: "airbox.mesh",
    domain: "mesh",
    backendSupport: ["fem"],
    uiPanel: "UniversePanel",
    serializerPath: "script_builder.universe",
    status: "partial",
  },
  {
    id: "study.pipeline",
    domain: "study",
    backendSupport: ["fem", "fdm"],
    uiPanel: "StudyBuilderWorkspace",
    serializerPath: "script_builder.study_pipeline",
    status: "implemented",
  },
];

