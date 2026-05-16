# FEM Demag Poisson

- Status: partial native FEM CPU module contract
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/demag_poisson.hpp/.cpp`
- Test: `native/backends/fem/tests/demag_poisson_contract.cpp`

## Energia

The native FEM Poisson demag path recovers `H_demag = -grad(u)` and reports:

```text
E_d = -0.5 mu0 integral_Omega_m Ms m . H_demag dV
```

The `0.5` factor avoids double-counting self-field energy. Robin boundary
energy is a separate correction evaluated during extracted field recovery and
cached for frozen-field energy updates.

## Pole / torque

Demag contributes an effective field:

```text
H_d = -grad(u)
```

It is added to `H_eff` in `A/m`. It is not a direct torque.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| saturation magnetization | `Ms` | `A/m` |
| magnetic scalar potential | `u` | `A` |
| demag field | `H_demag` | `A/m` |
| energy | `E_d` | `J` |

## Warunki brzegowe

The current bridge supports airbox Dirichlet and airbox Robin realizations.
The extracted module now owns the Dirichlet/Robin boundary-conditioned operator
policy and the non-periodic Hypre solve policy. The remaining monolithic bridge
responsibility is orchestration, interrupt polling, and timing aggregation.

## Dyskretyzacja FEM

Current transitional flow:

```text
assemble RHS from div(M)
solve scalar Poisson problem on magnetic + airbox domain
recover H_demag = -grad(u)
zero nonmagnetic nodes for LLG/energy
integrate energy with nodal lumped weights
add optional Robin boundary correction
```

The energy contract, RHS workspace/assembly, Robin/Dirichlet boundary operator
policy, periodic reduced Poisson operator/solve, non-periodic Hypre solve, and
`H_demag` recovery have been moved into `demag_poisson.*`. The module also owns
the frozen-field refresh decision and cached-energy helper used when a demag
refresh interval reuses a previous Poisson solution. Demag-specific solver
statistics and visualization H_eff reconstruction are filled by the module;
step orchestration and non-demag timing aggregation are still in
`mfem_bridge.cpp`.

## Ograniczenia capability

- Current production target: P1 native FEM CPU.
- Supported boundary modes in the extracted demag module are airbox Dirichlet
  and airbox Robin.
- Periodic demag uses the extracted algebraic `P^T A P` reduction and lift
  helpers.
- Non-periodic demag uses the extracted Hypre-backed solve helper when the MFEM
  runtime is MPI/Hypre-enabled.
- Field recovery uses the extracted `recover_demag_poisson_field(...)` helper
  for both periodic lifted potentials and non-periodic Hypre solutions.
- Recovered periodic demag fields are finalized by
  `finalize_demag_poisson_recovered_field(...)`, which projects representative
  node values across periodic classes and synchronizes the full-domain visual
  demag buffer when active.
- Frozen-field cache reuse is controlled by
  `demag_poisson_should_refresh_field(...)`. Refreshed fields are captured by
  `demag_poisson_store_refreshed_field_cache(...)` and reused by
  `demag_poisson_try_load_cached_field(...)`; cached energy uses
  `demag_poisson_cached_energy_from_field(...)` so Robin boundary energy stays
  frozen consistently with the cached potential.
- Fresh Poisson solves are gated by
  `demag_poisson_operator_ready_for_fresh_solve(...)`, which accepts only airbox
  Dirichlet/Robin demag and requires an initialized Poisson operator.
- Demag solver telemetry is filled by `fill_demag_poisson_solver_stats(...)`.
  Stable runtime log labels for demag solver/preconditioner choices are owned by
  `demag_poisson_linear_solver_name(...)` and
  `demag_poisson_preconditioner_name(...)`. Demag phase timing fields are
  accumulated in `DemagPoissonPhaseTimings` and copied to step stats by
  `fill_demag_poisson_phase_stats(...)`. Per-call profiling for
  `FULLMAG_FEM_STEP_PROFILE` is formatted by `DemagPoissonCallProfile` and
  `demag_poisson_call_profile_line(...)`.
- Full-domain visualization H_eff is built by
  `update_demag_poisson_visual_effective_field(...)`, replacing zeroed solver
  demag with the full-domain Poisson-recovered field where available.
- Full demag production qualification still requires analytic tests and
  convergence reports.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_demag_poisson_contract` checks the `-0.5 mu0 Ms m.H` energy convention,
  nodal lumped weights, per-node `Ms`, nonmagnetic-node masking, frozen-field
  refresh policy, cached Robin boundary energy, and demag solver stats reset in
  local non-MFEM builds. It also checks the full-domain visualization H_eff
  reconstruction helper.
- Local non-MFEM builds compile the public energy contract. The MFEM RHS,
  boundary-policy, periodic-reduction, Hypre-solve, and recovery code are
  guarded by `FULLMAG_HAS_MFEM_STACK`.

Required before production qualification:

- sphere `H=-M/3`;
- ellipsoid or rectangular-prism reference;
- airbox convergence;
- Robin vs Dirichlet comparison;
- RHS assembly fixture for magnetic/nonmagnetic element masks;
- boundary marker fixture for Dirichlet/Robin/seam exclusion;
- periodic reduced-system fixture for matrix/RHS reduction and lifted solution;
- residual/iteration telemetry regression;
- performance regression for RHS, solve, recover, and energy phases.
