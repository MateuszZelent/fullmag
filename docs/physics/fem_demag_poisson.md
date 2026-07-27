# FEM Demag Poisson

- Status: partial native FEM CPU module contract
- Last updated: 2026-07-27
- Mixed-P1 target: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Implementation:
  `backends/fem/cpu/mfem/interactions/demag_poisson.hpp/.cpp`,
  `demag_poisson_ready.hpp/.cpp`, `demag_poisson_lifecycle.hpp/.cpp`,
  `demag_poisson_solve.hpp/.cpp`, `demag_poisson_rhs.hpp/.cpp`,
  `demag_poisson_boundary.hpp/.cpp`, `demag_poisson_periodic.hpp/.cpp`,
  `demag_poisson_hypre.hpp/.cpp`, `demag_poisson_recovery.hpp/.cpp`,
  `demag_poisson_field.hpp/.cpp`, `demag_poisson_cache.hpp/.cpp`,
  `demag_poisson_energy.hpp/.cpp`, and `demag_poisson_telemetry.hpp/.cpp`
- Test: `backends/fem/tests/demag_poisson_contract.cpp`

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
responsibility is surrounding `H_eff` composition, interrupt polling, and
step-level timing scopes.

## Dyskretyzacja FEM

Current transitional flow:

```text
assemble RHS for laplace(u) = div(Ms m)
solve scalar Poisson problem on magnetic + airbox domain
recover H_demag = -grad(u)
zero nonmagnetic nodes for LLG/energy
integrate energy with nodal lumped weights
add optional Robin boundary correction
```

The equations and signs above are topology-neutral, but the current executable
mesh/ABI/operator path is tetrahedral. Native `prism6` magnetic plus
`pyramid5`/`tet4` air assembly is a separate target contract in note 0106 and
must remain unavailable until basis, quadrature, material masking, recovery,
energy, CPU/GPU, and managed-runtime gates pass. P1 order alone is not evidence
that a lane supports every first-order cell topology.

The energy contract, RHS workspace/assembly, Robin/Dirichlet boundary operator
policy, periodic reduced Poisson operator/solve, non-periodic Hypre solve,
`H_demag` recovery, field/visual postprocessing, frozen-field cache policy,
readiness gate, lifecycle, compute wrapper, and telemetry have been moved into
separate `demag_poisson_*.*` modules. `demag_poisson_ready.*` owns the fresh
solve readiness predicate, `demag_poisson_lifecycle.*` owns native init/destroy,
and `demag_poisson_solve.*` owns the one-call assemble/solve/recover wrapper.
`demag_poisson.*` is now only the aggregate include/translation-unit surface.
The shared demag dispatcher and update execution wrapper live in `demag.*`, so
cached reuse, fresh Poisson, and fresh FEM/BEM execution are selected outside
`mfem_bridge.cpp`. Demag-specific solver statistics and visualization H_eff
reconstruction are filled by the demag modules; non-demag timing aggregation is
still in `mfem_bridge.cpp`.

## Ograniczenia capability

- Current production target: P1 native FEM CPU.
- Current mixed-P1 status: non-executable target; unsupported requests reject
  before backend startup and never split prisms silently.
- Supported boundary modes in the extracted demag module are airbox Dirichlet
  and airbox Robin.
- Periodic demag uses the extracted algebraic `P^T A P` reduction and lift
  helpers.
- Non-periodic demag uses the extracted Hypre-backed solve helper when the MFEM
  runtime is MPI/Hypre-enabled.
- The Hypre solve helper returns the solved workspace vector directly to
  recovery and potential-cache update, avoiding the previous final host copy
  from `x_par` back into the generic solution buffer. RHS transfer into
  `b_par` and first-use warm-start transfer into `x_par` remain explicit,
  audited host transfers.
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
  Dirichlet/Robin demag and requires an initialized Poisson operator. The gate
  is owned by `demag_poisson_ready.*`.
- Native Poisson-demag lifecycle allocation and teardown are owned by
  `demag_poisson_lifecycle.*`.
- One-shot Poisson-demag compute orchestration is owned by
  `demag_poisson_solve.*`.
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
  local non-MFEM builds. It pins the Poisson sign by requiring RHS assembly to
  use the `+ integral Ms m dot grad(v)` source for `laplace(u) = div(Ms m)`;
  in MFEM-stack builds it also recovers the manufactured potential
  `u = x + 2y - 3z` on a tetrahedral cell and requires
  `H_demag = (-1, -2, 3) = -grad(u)`. It also checks the full-domain
  visualization H_eff reconstruction helper, telemetry-header docstring,
  top-level source-contract docstrings for the aggregate, ready, lifecycle,
  solve, RHS, boundary, periodic, Hypre, recovery, field, cache, energy, and
  telemetry modules, and source ownership for the ready/lifecycle/solve modules
  so runtime wrapper definitions do not return to `demag_poisson.cpp` or
  `mfem_bridge.cpp`.
- Local non-MFEM builds compile the public energy contract. The MFEM RHS,
  boundary-policy, periodic-reduction, Hypre-solve, and recovery code are
  guarded by `FULLMAG_HAS_MFEM_STACK`.
- `tests/fem_demag_validation/sphere_validation.py` is the scripted MFEM-stack
  gate for the uniformly magnetized sphere reference. It writes
  `tests/fem_demag_validation/results/sphere_convergence.csv` and exits
  nonzero if any required metric is non-finite or the finest Robin run exceeds
  5% relative error in the effective demag factor.
- `tests/fem_demag_validation/airbox_convergence.py` is the scripted MFEM-stack
  gate for airbox convergence. It writes
  `tests/fem_demag_validation/results/airbox_convergence.csv` and exits
  nonzero if any required metric is non-finite or any boundary-condition group
  fails to improve from the smallest to largest airbox scale.
- `tests/fem_demag_validation/ellipsoid_validation.py` is the scripted
  MFEM-stack gate for Osborn ellipsoid factors. It exits nonzero when any axis
  differs by more than 10% or a shape's three effective demag factors fail to
  sum to 1 within 0.15.
- `tests/fem_demag_validation/telemetry_validation.py` validates residual /
  iteration telemetry CSV artifacts: finite residual, nonnegative iterations,
  and nonnegative demag phase timings for assemble/RHS, solve, recover, and
  energy. `tests/fem_demag_validation/test_acceptance.py` unit-tests that
  artifact shape. Active solve evidence is still required before production
  qualification.
- `tests/fem_demag_validation/periodic_airbox_validation.py` validates
  periodic-airbox demag CSV artifacts: finite demag energy and telemetry,
  bounded primitive-cell periodic seam continuity, and agreement between the
  primitive periodic cell and a supercell reference. The script also has a
  `--produce` mode that runs the primitive periodic cell and explicit
  supercell through the managed MFEM runtime, reads `H_demag` field artifacts
  from JSON or Zarr output, and writes
  `.fullmag/reports/fem-demag-periodic-airbox-validation/periodic_airbox_validation.csv`.
  The produced `e_demag_J` values are integrated from saved `m_final` and
  `H_demag` fields; for the supercell reference this integration is restricted
  to magnetic elements whose centroids lie in the central primitive cell.
  As of the 2026-06-27 managed run, this producer is an active passing
  CPU/MFEM qualification gate for the k=0 periodic-airbox slice. Native
  periodic demag field finalization now
  projects recovered representative values before energy evaluation, and the
  native FEM Zarr snapshot writer transposes AoS triples into the advertised
  component-major layout. The periodic airbox mesher also assigns non-Robin
  physical boundary markers to every lateral periodic seam surface fragment,
  preserves all such marker pairs in `periodic_boundary_pairs`, and excludes
  those surfaces from `Gamma_out`, so the producer records
  `robin_periodic_seam_face_count=0`. With those fixes the primitive
  `H_demag` seam metric passes with `h_demag_pair_max_abs_Apm=0.0`. The native
  runtime now also emits scalar-potential `demag_phi` Zarr snapshots with
  `component_order=["scalar"]`; the fresh managed 3x3 producer at
  `.fullmag/reports/fem-demag-periodic-airbox-validation-phi/periodic_airbox_validation.csv`
  records `phi_pair_status=emitted_by_runtime` and `phi_pair_max_abs=0.0`.
  The periodic reduced Poisson solve also reports actual MFEM CG
  iterations/residual telemetry rather than hard-coded zeroes. The validation
  mesh now uses a thin-film magnetic policy (`hmin=3 nm`, magnetic `hmax=8 nm`,
  interface `hmax=5 nm`, edge/corner `hmax=4 nm`, two through-thickness layers)
  plus one translated hole-refinement region per explicit supercell hole.
  Runtime producer CSVs now include energy-diagnostic columns:
  `runtime_total_e_demag_J`, `runtime_total_to_field_scope_ratio`,
  `magnetic_volume_m3`, `magnetic_element_count`, `magnetic_node_count`, and
  `energy_scope`. A finite-array diagnostic with lateral open boundaries showed
  slow supercell convergence (`6.894685e-01` at 3x3 and `4.201782e-01` at 5x5
  relative error), proving that lateral open boundaries are not a valid
  equivalence reference for this PBC gate. The managed passing 3x3 artifact now
  uses lateral PBC on the outer supercell faces and is written at
  `.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv`.
  It reports primitive `e_demag_J=1.8678852700529174e-19`, supercell
  central-cell `e_demag_J=1.8633818564459878e-19`, relative error
  `2.4167958871934916e-3` against the `2.0e-2` tolerance, zero primitive
  `H_demag` and `phi` seam mismatch, `robin_periodic_seam_face_count=0`,
  primitive CG telemetry `38` iterations / `8.035072644447357e-18` residual,
  and supercell CG telemetry `65` iterations / `3.735510701495055e-17`
  residual.

Required before production qualification:

- Robin vs Dirichlet comparison;
- RHS assembly fixture for magnetic/nonmagnetic element masks;
- boundary marker fixture for Dirichlet/Robin/seam exclusion;
- periodic reduced-system fixture for matrix/RHS reduction, lifted solution,
  active primitive/supercell periodic-airbox CSV generation, and passing
  `H_demag`/`phi` seam plus supercell-reference metrics;
- active residual/iteration telemetry regression on an MFEM-stack solve;
- performance regression for RHS, solve, recover, and energy phases.
