# FEM Relaxation Provenance Contract Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: runner provenance and documentation only
- Out of scope: native MFEM/libCEED/CUDA hot loops, tangent-plane implicit solver, Python API, ProblemIR, OpenAPI

## Goal

Make FEM relaxation provenance honest for the current executable subset. `projected_gradient_bb` and `nonlinear_cg` are executable for FEM, but the current native path is a bootstrap runner-side minimizer that uploads trial magnetization states and reads native field/energy snapshots. It is not yet a production FE-metric, preconditioned, or tangent-plane minimizer.

## Contract

Execution provenance must distinguish:

- time integration: `requested_integrator` / `resolved_integrator`,
- energy minimization: `requested_energy_minimizer` / `resolved_energy_minimizer`,
- direct-minimization realization: `energy_minimizer_realization`.

For `llg_overdamped`, the stage remains an LLG time-integration path with precession disabled. Its minimizer fields stay absent.

For `projected_gradient_bb` and `nonlinear_cg`, provenance must record:

- requested and resolved minimizer algorithm from `RelaxationControlIR.algorithm`,
- realization `bootstrap_snapshot_tangent_gradient`,
- no claim that `tangent_plane_implicit`, FE-metric inner products, preconditioners, or native minimizer kernels were used.

## Validation

Add runner tests that fail before the provenance fields exist:

- serializing `ExecutionProvenance` for a FEM bootstrap minimizer includes the requested/resolved energy minimizer and realization,
- an LLG-only provenance sample does not emit minimizer fields.

## Acceptance

- `cargo test -p fullmag-runner fem_relaxation_provenance -- --nocapture` passes after a verified RED failure.
- `cargo test -p fullmag-runner relaxation_convergence --no-fail-fast` still passes.
- `cargo fmt --check -p fullmag-runner` passes.
- `git diff --check` passes.
- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` and `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` record this as a provenance/contract closure only, while production FE-metric/tangent-plane work remains open.
