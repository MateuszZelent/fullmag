import { DEFAULT_RELAX_TORQUE_APM } from "@/shared/domain/physics/torqueUnits";

type HysteresisJsonPrimitive = boolean | null | number | string;
type HysteresisJsonValue =
  | HysteresisJsonPrimitive
  | HysteresisJsonValue[]
  | { [key: string]: HysteresisJsonValue };
type HysteresisJsonObject = { [key: string]: HysteresisJsonValue };

export const DEFAULT_HYSTERESIS_FIELD_MIN_MT = -100;
export const DEFAULT_HYSTERESIS_FIELD_MAX_MT = 100;
export const DEFAULT_HYSTERESIS_FIELD_STEP_MT = 10;
export const DEFAULT_HYSTERESIS_BRANCH_MODE = "major_loop";
export const DEFAULT_HYSTERESIS_INITIAL_PROTOCOL = "positive_saturation";
export const DEFAULT_HYSTERESIS_MEASUREMENT_AXIS = "field_axis";
export const DEFAULT_HYSTERESIS_ORIENTATION_PRESET = "oop_positive";

export const DEFAULT_HYSTERESIS_STORAGE = {
  scalar_history: true,
  magnetization: "selected",
  every_n: 5,
  key_events: true,
  key_event_threshold_dm: 0.02,
} as const;

export const DEFAULT_HYSTERESIS_SETTLE_STEP = {
  kind: "relax",
  method: "llg_overdamped",
  alpha: 1,
  torque_tolerance: DEFAULT_RELAX_TORQUE_APM,
  max_steps: 10000,
  on_non_convergence: "continue_with_warning",
} as const;

export function createDefaultHysteresisStage(): HysteresisJsonObject {
  return {
    branch_mode: DEFAULT_HYSTERESIS_BRANCH_MODE,
    entrypoint_kind: "flat_hysteresis",
    field_max_mT: DEFAULT_HYSTERESIS_FIELD_MAX_MT,
    field_min_mT: DEFAULT_HYSTERESIS_FIELD_MIN_MT,
    field_step_mT: DEFAULT_HYSTERESIS_FIELD_STEP_MT,
    kind: "hysteresis",
    initial_protocol: DEFAULT_HYSTERESIS_INITIAL_PROTOCOL,
    measurement_axis: DEFAULT_HYSTERESIS_MEASUREMENT_AXIS,
    orientation: {
      kind: "preset",
      preset_name: DEFAULT_HYSTERESIS_ORIENTATION_PRESET,
    },
    settle_pipeline: {
      kind: "sequence",
      steps: [DEFAULT_HYSTERESIS_SETTLE_STEP],
    },
    storage: DEFAULT_HYSTERESIS_STORAGE,
  };
}
