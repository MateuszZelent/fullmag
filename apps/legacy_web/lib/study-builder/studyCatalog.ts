export interface OptionDescriptor {
  value: string;
  label: string;
  description: string;
}

export const RELAX_ALGORITHM_DETAILS: Record<string, OptionDescriptor> = {
  llg_overdamped: {
    value: "llg_overdamped",
    label: "LLG overdamped",
    description: "Damping-driven relaxation using the standard effective field path; best default for parity across backends.",
  },
  projected_gradient_bb: {
    value: "projected_gradient_bb",
    label: "Projected gradient (BB)",
    description: "Direct constrained energy minimization with Barzilai-Borwein step selection; native GPU/FEM lanes currently use bootstrap field and energy snapshots.",
  },
  nonlinear_cg: {
    value: "nonlinear_cg",
    label: "Nonlinear conjugate gradient",
    description: "Manifold optimization that can reduce iteration count on harder equilibrium problems; native GPU/FEM lanes currently use bootstrap field and energy snapshots.",
  },
  tangent_plane_implicit: {
    value: "tangent_plane_implicit",
    label: "Tangent-plane implicit",
    description: "Planned FEM-oriented stiff relaxation path; defined in the semantic model but disabled until engine support is available.",
  },
};

export const INTEGRATOR_DETAILS: Record<string, OptionDescriptor> = {
  heun: {
    value: "heun",
    label: "Heun (RK2)",
    description: "Explicit predictor-corrector integrator with low per-step overhead.",
  },
  rk4: {
    value: "rk4",
    label: "RK4",
    description: "Classic fourth-order explicit method for smooth precessional trajectories.",
  },
  rk23: {
    value: "rk23",
    label: "RK2(3) adaptive",
    description: "Adaptive embedded pair with lighter cost than RK45.",
  },
  rk45: {
    value: "rk45",
    label: "RK4(5) adaptive",
    description: "Accuracy-oriented adaptive stepping for transients and mixed timescales.",
  },
  abm3: {
    value: "abm3",
    label: "ABM3",
    description: "Multistep predictor-corrector that reuses history on smooth trajectories.",
  },
  auto: {
    value: "auto",
    label: "Backend default",
    description: "Lets the selected engine choose the most mature integrator path.",
  },
};

export const EIGEN_TARGET_DETAILS: Record<string, OptionDescriptor> = {
  lowest: {
    value: "lowest",
    label: "Lowest",
    description: "Solve for the lowest-frequency modes first.",
  },
  nearest: {
    value: "nearest",
    label: "Nearest",
    description: "Target modes nearest a selected frequency window.",
  },
};

export const EIGEN_EQUILIBRIUM_SOURCE_DETAILS: Record<string, OptionDescriptor> = {
  relax: {
    value: "relax",
    label: "Relaxed initial state",
    description: "Materialize a relax step before the eigensolve.",
  },
  provided: {
    value: "provided",
    label: "Provided initial state",
    description: "Use the workspace state exactly as authored.",
  },
  artifact: {
    value: "artifact",
    label: "State artifact",
    description: "Load the equilibrium from a prior saved artifact.",
  },
};

export const EIGEN_NORMALIZATION_DETAILS: Record<string, OptionDescriptor> = {
  unit_l2: {
    value: "unit_l2",
    label: "Unit L2",
    description: "Normalize each mode by its L2 norm.",
  },
  unit_max_amplitude: {
    value: "unit_max_amplitude",
    label: "Unit max amplitude",
    description: "Normalize by peak mode amplitude for easier visual comparison.",
  },
};

export const EIGEN_DAMPING_POLICY_DETAILS: Record<string, OptionDescriptor> = {
  ignore: {
    value: "ignore",
    label: "Ignore damping",
    description: "Solve the undamped operator to inspect conservative mode structure.",
  },
  include: {
    value: "include",
    label: "Include damping",
    description: "Keep damping in the linearized operator when backend support is available.",
  },
};

export const EIGEN_SPIN_WAVE_BC_DETAILS: Record<string, OptionDescriptor> = {
  free: {
    value: "free",
    label: "Free",
    description: "Default unconstrained boundary behavior.",
  },
  pinned: {
    value: "pinned",
    label: "Pinned",
    description: "Clamp transverse dynamics at the selected boundary.",
  },
  periodic: {
    value: "periodic",
    label: "Periodic",
    description: "Repeat the mode profile over the domain period.",
  },
  floquet: {
    value: "floquet",
    label: "Floquet",
    description: "Periodic boundary with an explicit phase shift across the unit cell.",
  },
  surface_anisotropy: {
    value: "surface_anisotropy",
    label: "Surface anisotropy",
    description: "Apply effective surface pinning/anisotropy in the eigen boundary model.",
  },
};

export function describeOption(
  catalog: Record<string, OptionDescriptor>,
  value: string | null | undefined,
): OptionDescriptor | null {
  if (!value) return null;
  return catalog[value] ?? null;
}
