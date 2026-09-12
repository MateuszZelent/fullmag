export const BACKEND_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  fdm: {
    label: "FDM regular grid",
    performance: "Best throughput on large rectilinear domains; especially efficient on CUDA with FFT-based demag.",
    physics: "Cell-centered micromagnetics on a Cartesian mesh. Great for block-like or voxelized geometries.",
  },
  fem: {
    label: "FEM tetra mesh",
    performance: "Higher geometric fidelity, but more expensive per degree of freedom than regular-grid FDM.",
    physics: "Finite elements follow curved boundaries and imported CAD/STL shapes more faithfully.",
  },
  fdm_multilayer: {
    label: "FDM multilayer",
    performance: "Optimized for stacked-film workflows, where layer coupling matters more than arbitrary 3D geometry.",
    physics: "Regular-grid micromagnetics with explicit multilayer structure and inter-layer bookkeeping.",
  },
};

export const INTEGRATOR_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  heun: {
    label: "Heun (RK2)",
    performance: "Low overhead per step and easy to debug; good when you already know a safe fixed timestep.",
    physics: "Second-order explicit integration of the LLG equation with predictor-corrector structure.",
  },
  rk4: {
    label: "RK4",
    performance: "More work per step than Heun, but usually better accuracy at the same fixed timestep.",
    physics: "Classic fourth-order Runge-Kutta for smooth precessional dynamics when timestep is controlled manually.",
  },
  rk23: {
    label: "RK2(3) adaptive",
    performance: "Good default when you want adaptive stepping without the heavier RK45 cost profile.",
    physics: "Embedded pair estimates local truncation error and adjusts dt to keep LLG integration within tolerance.",
  },
  rk45: {
    label: "RK4(5) adaptive",
    performance: "Accuracy-oriented adaptive integrator; often robust, but heavier per accepted step.",
    physics: "Dormand-Prince style embedded stepping tracks fast transients while expanding dt in quieter regions.",
  },
  abm3: {
    label: "ABM3",
    performance: "Efficient on smooth trajectories after startup, because it reuses history instead of recomputing as many stages.",
    physics: "Multistep predictor-corrector integration; best when the magnetization evolves smoothly over time.",
  },
  auto: {
    label: "Backend default",
    performance: "Lets the runtime choose the default solver path for the current backend.",
    physics: "Useful for scripted flows where the backend decides the safest or most mature integrator.",
  },
};

export const RELAXATION_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  llg_overdamped: {
    label: "LLG overdamped",
    performance: "Most robust relaxation path and the easiest to reason about across FDM and FEM.",
    physics: "Uses the normal effective field but removes the precessional term, so magnetization follows a damping-driven descent toward equilibrium.",
  },
  projected_gradient_bb: {
    label: "Projected gradient (BB)",
    performance: "Often converges faster than overdamped LLG; CUDA FDM and FEM currently use bootstrap field/energy snapshot paths.",
    physics: "Direct energy minimization on the unit-sphere constraint rather than explicit physical time stepping.",
  },
  nonlinear_cg: {
    label: "Nonlinear conjugate gradient",
    performance: "Can reduce iteration count on harder minimization problems; CUDA FDM and FEM currently use bootstrap field/energy snapshot paths.",
    physics: "Direct manifold optimization with conjugate directions, so it targets equilibrium states rather than transient dynamics.",
  },
  tangent_plane_implicit: {
    label: "Tangent-plane implicit",
    performance: "Planned FEM relaxation path; not executable in the current public runner.",
    physics: "Reserved for the future implicit tangent-plane formulation. Current releases must keep it disabled in authoring UI.",
  },
};

export const PRECISION_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  single: {
    label: "Single precision",
    performance: "Lower memory traffic and usually higher GPU throughput; useful for exploratory sweeps and fast previews.",
    physics: "Round-off noise is larger, so very tight convergence criteria or tiny energy differences are less trustworthy.",
  },
  double: {
    label: "Double precision",
    performance: "More expensive, but safer for long runs, tight tolerances, and numerically delicate geometries.",
    physics: "Higher mantissa precision reduces accumulated error in torque, energy, and demag-heavy workloads.",
  },
};
