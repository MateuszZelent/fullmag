import type { AbsorbingBoundaryConfig } from "@/kernel/api/apiTypes";

/** The initial face layer used by both Inspector activation and the Physics ribbon. */
export function initialAbsorbingBoundary(): Extract<AbsorbingBoundaryConfig, { faces: unknown }> {
  return {
    faces: ["x+"], frame: "object", profile: "smootherstep",
    total_width_m: 4e-7, ramp_width_m: 3e-7, max_damping: 0.5,
  };
}
