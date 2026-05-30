# FEM CPU Validation Matrix

- Status: release-gate validation matrix for native FEM CPU modularization
- Last updated: 2026-05-30
- Implementation: `native/backends/fem/`
- Test: `native/backends/fem/tests/interaction_docs_contract.cpp`

## Scope

This matrix records the validation expected before the native FEM CPU backend
can be treated as production-quality. It complements the module contracts under
`native/backends/fem/tests/`.

## Current Local Gates

| Gate | Command or target | Current purpose |
|---|---|---|
| ABI/native create | `fem_contract_validation` | availability lanes, `fe_order = 1`, adaptive config sanity |
| Interaction docs | `fem_interaction_docs_contract` | required release docs, per-interaction docs, required energy/field-or-torque/units/boundary/discretization/capability/test sections, and ownership-boundary docstrings in every active interaction header |
| Source facades | `fem_source_facade_contract` | C ABI, private backend-handle storage, Context facade delegation, core Context builder sequencing, legacy MFEM bridge, error, transfer-audit, DMI weak-residual, GPU state/exchange/RK facade source-level docstrings and non-owning boundaries, plus backend-step, backend-lifecycle init/teardown, transfer-audit/GPU-state diagnostic snapshot access, dense generalized eigensolver runtime ownership outside `api.cpp`, and managed runtime export of MFEM/libCEED/Hypre, OpenMPI, and CUDA headers/libs with relocatable MFEM CMake package metadata |
| Explicit RK | `fem_rk_explicit_contract`, `fem_gpu_rk_plan` | tableau type/dispatch ownership, RK workspace storage/allocation ownership, stage RHS ownership, explicit RK step ownership, GPU RK planning for hybrid CPU-demag upload, integrator source-level docstrings including LLG RHS helpers, integrator header non-ownership docstrings, and Context no longer declaring RK helpers |
| Fixed-step Heun | `fem_heun_step_contract`, `fem_rk_explicit_contract` | Heun routes through the generic explicit RK path via `heun_tableau()`, the legacy standalone Heun stepper source/header are absent from the build, and Context no longer declares a Heun step entrypoint |
| Adaptive DT | `fem_adaptive_dt_contract`, `fem_rk_explicit_contract` | adaptive config validation/import ownership, runtime PI-controller state plus active current-dt ownership, componentwise AoS error norm, Context no longer owning flat adaptive dt controller fields or `current_dt`, source-level docstring through the RK explicit gate, and adaptive header non-ownership docstring |
| LLG RHS | `fem_llg_rhs_contract` | Gilbert-form RHS ownership, nodewise damping, AoS normalization/masking helpers, source/header non-ownership docstrings, and damping-only macrospin energy-decrease fixture |
| Availability runtime | `fem_availability_contract`, `fem_mfem_context_contract` | native FEM CPU/GPU availability policy, lane reason strings, CUDA/CEED/device-index checks, C ABI delegation, runtime source-level docstring, and runtime header non-ownership docstring |
| Transfer audit | `fem_transfer_audit` | hot-loop transfer counters, snapshot ownership, violation latching, exchange-interop classification, and env-gate import ownership |
| MFEM context | `fem_mfem_context_contract` | MFEM resource lifecycle ownership, actual MFEM device handle/runtime selection ownership, base mesh/FES/GridFunction lifecycle handle ownership, component magnetization buffer ownership, compatibility upload wrapper ownership, Context no longer declaring lifecycle entrypoints or owning flat actual MFEM device or MFEM context lifecycle fields, runtime source-level docstrings for MFEM context plus sibling runtime translation units, and runtime header non-ownership docstrings |
| CPU threads | `fem_cpu_threads_contract`, `fem_mfem_context_contract` | plan/env CPU thread resolution, OpenMP runtime limits, demag/exchange thread policy publication, runtime source-level docstring, and runtime header non-ownership docstring |
| MFEM device | `fem_mfem_device_contract`, `fem_mfem_context_contract` | MFEM device-string/GPU-index plan import ownership, runtime state ownership, device-info cache/snapshot ownership, CPU/GPU device classification, Context no longer owning flat MFEM-device plan/cache fields, runtime source-level docstring, and runtime header non-ownership docstring |
| GPU state runtime | `fem_gpu_state_runtime_contract`, `fem_gpu_rk_plan`, `fem_mfem_context_contract` | GPU-state bootstrap/upload ownership, explicit demag-workspace allocation flag, device-side AoS/SoA transfer helper usage, host-resident no-CUDA metadata initialization, legacy sparse GPU-exchange metadata ownership, CUDA stream/event and pinned snapshot runtime ownership, Context no longer owning startup residency mechanics, flat legacy GPU-exchange metadata fields, or flat CUDA stream/snapshot fields, runtime source-level docstring, and runtime header non-ownership docstring |
| State I/O runtime | `fem_state_io_contract`, `fem_mfem_context_contract` | magnetization readback/upload ownership, observable field copy semantics, runtime cache invalidation, Context no longer owning C ABI state I/O, runtime source-level docstring, and runtime header non-ownership docstring |
| Interrupt runtime | `fem_interrupt_contract`, `fem_mfem_context_contract` | cooperative interrupt callback installation and polling ownership, callback/user-data/latch runtime state ownership, C ABI facade delegation for callback installation, Context no longer defining the inline polling helper or owning flat interrupt fields, runtime source-level docstring, and runtime header non-ownership docstring |
| Snapshot runtime | `fem_snapshot_contract`, `fem_mfem_context_contract` | scalar snapshot/statistics ownership, Context no longer declaring the snapshot entrypoint, runtime source-level docstring, and runtime header non-ownership docstring |
| Step metrics | `fem_step_metrics_contract`, `fem_mfem_context_contract` | common step-stat aggregation, average/field norm helpers, demag solver stat publication, PhaseTimings ownership outside Context, runtime source-level docstring, and PhaseTimings header non-ownership docstring |
| Stage completion | `fem_stage_completion_contract`, `fem_mfem_context_contract` | relaxation-stop validation/state initialization, runtime state ownership, plateau-window policy/tracking, snapshot ownership, stop-reason ownership including C ABI error/cancel paths, Context no longer owning flat relax-stop/snapshot/window fields or declaring the update wrapper, runtime source-level docstring, and runtime header non-ownership docstring |
| Field refresh | `fem_field_refresh_contract`, `fem_mfem_context_contract` | field-refresh policy validation/import ownership, demag-runtime policy storage, demag frozen-cache reset ownership, Context no longer owning a flat field-refresh policy, runtime source-level docstring, and runtime header non-ownership docstring |
| AoS field | `fem_aos_field_contract`, `fem_mfem_context_contract` | AoS/component packing, normalization, projection and zeroing helpers, Context no longer owning static AoS periodic projection, and runtime source-level docstring |
| FEM base plan fields | `fem_plan_fields_contract` | base ABI plan validation, scalar base-plan runtime state ownership, mesh cardinality import into `FemMeshRuntimeState`, Context no longer owning base-plan validation or flat scalar base-plan fields, core source-level docstring, and header non-ownership docstring |
| FEM mesh core | `fem_mesh_contract` | mesh cardinality ownership, mesh plan-field import ownership, runtime mesh topology/mask/periodic/nodal-volume ownership, magnetic mask ownership, periodic topology/helper ownership, periodic compatibility gate ownership, Context no longer owning flat mesh cardinality, topology, mask, periodic, or nodal-volume fields, Context no longer owning static AoS periodic projection, core source-level docstring, and header non-ownership docstring |
| FEM state | `fem_state_contract` | initial magnetization validation/copy ownership, runtime AoS magnetization plus accepted-step and accepted-time ownership, static periodic projection, time reset ownership, Context no longer owning flat `m_xyz`, `step_count`, or `current_time`, core source-level docstring, and header non-ownership docstring |
| FEM material fields | `fem_material_fields_contract` | scalar and per-node material field import/validation ownership, runtime scalar-material and per-node material-field ownership, scalar material convention validation, Context no longer owning flat scalar material constants or material field vectors, core source-level docstring, and header non-ownership docstring |
| FEM field buffers | `fem_field_buffers_contract` | nodal field-buffer sizing/zeroing ownership, external-field seeding of `H_eff`, runtime nodal integration-weight ownership for MFEM lumped mass, Context no longer owning flat `mfem_lumped_mass`, core source-level docstring, and header non-ownership docstring |
| Exchange | `fem_exchange_contract` | no-MFEM behavior, plan-field initialization ownership including exchange enablement and consistent-mass projection policy, operator/field/runtime/fallback ownership, runtime H_ex ownership, exchange plan/runtime state ownership, MFEM exchange workspace ownership, mass projection ownership, legacy GPU upload ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, and Context no longer declaring the runtime refresh wrapper or owning flat exchange enable/workspace fields |
| Effective field | `fem_effective_field_contract` | field/direct-torque gate ownership, top-level H_eff composition ownership, runtime H_eff/H_eff_visual ownership, disabled local-buffer zeroing for interfacial DMI/cubic anisotropy/bulk DMI, eager initial effective-field refresh policy ownership, composition-header non-ownership docstring, source-level docstring, and Context no longer declaring the composition entrypoint |
| Demag dispatcher | `fem_demag_contract` | plan-field initialization ownership including demag enablement, demag runtime initialization dispatch for Poisson vs Fredkin-Koehler, cached/Poisson/FEM-BEM field-update dispatch decision, selected demag-realization, solver-config, field-refresh policy and call-profiling counter runtime ownership, runtime H_demag/visual/cache ownership, Context no longer owning flat demag enablement, call counter, realization, solver config, field-refresh policy, or concrete demag-realization init branching, aggregate-header non-ownership docstring, source-level docstring, and non-owning boundary against concrete solver internals |
| Demag Poisson | `fem_demag_poisson_contract` | energy, cache, telemetry, visual field, periodic-reduction predicate, ready/lifecycle/solve ownership, runtime-state ownership for potential operator handles, RHS/recovery/Hypre workspaces, periodic reduced-system storage, boundary marker and Robin beta config storage, derived Robin boundary storage, readiness, essential DOFs, last-solve telemetry, solve counters, and cached Hypre handles, aggregate/leaf/telemetry header non-ownership docstrings, source-level docstrings for all Poisson demag modules, Context no longer declaring Poisson lifecycle/solve entrypoints, and Context no longer owning flat Poisson solver or boundary config runtime fields |
| Demag FEM/BEM | `fem_demag_fem_bem_contract` | boundary extraction, dense BEM sanity, energy sign, energy/solve ownership, runtime workspace/readiness ownership, Context no longer owning flat FEM/BEM demag workspace or readiness fields, aggregate/leaf-header non-ownership docstrings, and source-level docstrings for all FEM/BEM demag modules |
| DMI | `fem_dmi_contract`, `fem_dmi_weak_residual` | DMI disabled/error contracts, interfacial-DMI ownership, bulk-DMI ownership, workspace ownership, runtime H_DMI/H_bulk_DMI/energy/workspace pointer ownership, interfacial/bulk plan enablement/constants and normalized interface-normal runtime ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, plan-field/normal initialization ownership, Context no longer owning flat DMI plan fields or flat MFEM DMI workspace scratch, module ownership, and interfacial/bulk weak-residual directional-derivative fixtures |
| Thermal | `fem_thermal_brown_contract` | Brown sigma, seed/cache, deterministic replay for fixed seed and accepted `(t, dt)`, field addition, plan-field initialization ownership, Brown temperature/RNG-seed runtime ownership, Context no longer owning flat Brown temperature/seed plan fields, module ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, and nonmagnetic zeroing |
| STT | `fem_stt_contract` | direct torque families, Slonczewski/Zhang-Li module ownership, STT runtime plan-storage ownership, Context no longer owning flat STT plan fields, plan-field/family validation ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, reusable hot-path STT workspace, Zhang-Li additive-RHS normalization, disabled behavior, and macrospin CPP sign/precession-direction fixture |
| Oersted | `fem_oersted_contract` | analytical cylinder, explicit nodal field behavior, materialized H_oe runtime-state ownership, analytical/explicit enablement plus current/radius/center/axis/time-envelope runtime ownership, Context no longer owning flat Oersted plan fields, plan-field/realization validation ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, and module ownership |
| Magnetoelastic | `fem_magnetoelastic_contract` | prescribed-strain field/energy, runtime H_mel/energy state ownership, enablement plus B1/B2/strain-mode/strain-buffer runtime ownership, runtime strain-upload ownership outside the C ABI facade, Context no longer owning flat magnetoelastic plan fields, field-add module ownership, plan-field initialization ownership, aggregate/leaf-header non-ownership docstrings, source-level docstrings, masking, and additive H_eff |
| Zeeman/anisotropy | `fem_zeeman_contract`, `fem_anisotropy_contract` | local field, energy, Zeeman plan-field initialization plus broadcast/field/energy module ownership and leaf/source-level docstrings, Zeeman runtime H_ext plus uniform external-field plan storage ownership, Context no longer owning flat Zeeman enable/field-vector fields, uniaxial/cubic module ownership and leaf/source-level docstrings, anisotropy runtime H_ani/H_cubic/energy plus uniaxial/cubic plan storage ownership, Context no longer owning flat anisotropy/cubic plan fields, aggregate/leaf-header non-ownership docstrings, and anisotropy plan-field initialization plus axis normalization/validation ownership |

## Local Interaction Contract Pass

This section is a local-contract readiness table, not a validated-status promotion. It records the no-MFEM source, unit, sign, and ownership gates that can run in this checkout. Runtime validation remains separate where MFEM/CUDA-visible execution is required.

| Interaction | Local source gate | Units gate | Energy/field sign gate | CPU/GPU ownership gate | Status boundary |
|---|---|---|---|---|---|
| Exchange | `fem_exchange_contract` | `fem_exchange.md` pins `A_ex` in `J/m`, `Ms`/`H_ex` in `A/m`, and `E_ex` in `J` | source/docs gate pins positive `E_ex = integral A_ex |grad m|^2 dV` and the `H_ex,c = -2 h_raw_c/(mu0 Ms)` weak-form sign; sinusoidal Laplacian and energy convergence remain runtime fixtures | CPU owners: `exchange_*`; GPU owners: `gpu/cuda/exchange/*`, `rk_exchange_dispatch.*`, `rk_exchange_energy_reductions.*` | local-ready; runtime-open for MFEM sinusoidal Laplacian and convergence sweep |
| Demag | `fem_demag_contract`, `fem_demag_poisson_contract`, `fem_demag_fem_bem_contract` | `fem_demag_poisson.md` and `fem_demag_fem_bem.md` pin `u` in `A`, `H_demag` in `A/m`, and `E_d` in `J` | local gates pin `H_demag = -grad(u)` and `E_d = -0.5 mu0 integral Ms m.H_demag dV`; sphere/ellipsoid/airbox/residual checks remain runtime fixtures | CPU owners: `demag*`, `demag_poisson_*`, `demag_fem_bem_*`; GPU owners: `gpu/cuda/demag_poisson/*`, `rk_demag_dispatch.*`, `rk_demag_energy_reductions.*` | local-ready; runtime-open for sphere, ellipsoid, airbox convergence, residual, and strict GPU residency gates |
| Zeeman | `fem_zeeman_contract` | `fem_zeeman.md` pins `H_ext`/`Ms` in `A/m` and `E_Z` in `J` | local gate pins additive `H_Z = H_ext` and negative work sign `E_Z = -mu0 integral Ms m.H_ext dV` | CPU owners: `zeeman_*`; GPU owners: `gpu/cuda/interactions/zeeman/zeeman_kernels.*`, `rk_external_energy_reductions.*`, `rk_effective_field.*` | local-ready; CPU/GPU parity still runtime-open |
| Anisotropy | `fem_anisotropy_contract` | `fem_anisotropy_uniaxial.md` and `fem_anisotropy_cubic.md` pin `Ku*`/`Kc*` in `J/m^3`, axes dimensionless, `H_ani`/`H_cub` in `A/m`, and energies in `J` | local gate pins easy-axis/easy-cubic signs, cubic `H_cub = -(1/(mu0 Ms)) d e_cub/dm`, per-node scaling, and axis validation; directional derivative remains a production qualification fixture | CPU owners: `anisotropy_*`; GPU owners: `gpu/cuda/interactions/anisotropy/anisotropy_kernels.*`, `rk_anisotropy_field.*`, `rk_anisotropy_energy_reductions.*` | local-ready; broader derivative and CPU/GPU parity gates remain runtime/open qualification |
| DMI | `fem_dmi_contract`, `fem_dmi_weak_residual` | `fem_dmi.md` pins `Dind` / `InterfacialDMI(D=...)` as unchanged `J/m^2` surface input and `H_DMI` in `A/m` | weak-residual gate pins interfacial/bulk directional derivatives, chirality, spiral-pitch handedness/sign, boundary tilt, and non-default interface-normal use | CPU owners: `dmi_*`; GPU owners: `gpu/cuda/interactions/dmi/dmi_kernels.*`, `rk_dmi_fields.*`, `rk_dmi_energy_reductions.*` | local-ready plus prior CUDA smoke evidence; public status must stay below `validated` until documented validation workloads are current |
| Oersted | `fem_oersted_contract` | `fem_oersted.md` pins `I` in `A`, radius/center in `m`, and `H_oe` in `A/m` | local gate pins Ampere-law inside/outside field direction `a x r_hat`, envelope scaling, and unscaled explicit-field addition; no standalone energy is reported | CPU owners: `oersted_*`; GPU owners: `gpu/cuda/interactions/oersted/oersted_kernels.*`, `rk_oersted_field.*`, `rk_effective_field.*` | local-ready; generalized current-solution and CPU/GPU parity remain runtime-open |
| Thermal | `fem_thermal_brown_contract` | `fem_thermal.md` and `fem_thermal_brown.md` pin `T` in `K`, `dt` in `s`, `V_i` in `m^3`, `gamma_mu0` in `m/(A s)`, and `H_therm` in `A/m` | local gate pins Brown sigma scaling, accepted `(time, dt)` replay/cache, nonmagnetic zeroing, and no deterministic standalone energy; variance-vs-`dt` and Boltzmann macrospin remain runtime/statistical fixtures | CPU owners: `thermal_brown_*`; GPU owners: `gpu/cuda/interactions/thermal/thermal_kernels.*`, `rk_thermal_field.*` | local-ready; runtime-open for statistical variance, Boltzmann macrospin, and CPU/GPU parity gates |
| Magnetoelastic | `fem_magnetoelastic_contract` | `fem_magnetoelastic.md` pins `B1/B2` in `Pa`, strain dimensionless, `H_mel` in `A/m`, and `E_mel` in `J` | local gate pins engineering-shear Voigt convention, negative field derivative sign, energy integration, nonmagnetic masking, and additive `H_eff`; coupled mechanics remains deferred | CPU owners: `magnetoelastic_*`; GPU owners: `gpu/cuda/interactions/magnetoelastic/*`, `rk_magnetoelastic_field.*`, `rk_magnetoelastic_energy_reductions.*` | local-ready for prescribed strain; coupled mechanics and CPU/GPU parity remain runtime-open |

## Required Physics Fixtures

| Area | Fixture | Required criterion | Status |
|---|---|---|---|
| Exchange | uniform state | zero exchange field and energy | local contract only |
| Exchange | sinusoidal mode | finest-mesh `H_ex` agrees with `2 A_ex/(mu0 Ms) Delta m` within 25% and `E_ex = A k^2 V` converges under refinement | scripted in `tests/fem_exchange_validation/sinusoidal_mode.py`; representative `fullmag --headless` finest-mesh stage passes on managed runtime; full CSV sweep requires a PyO3 `_fullmag_core` built with MFEM/libCEED |
| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | covered by `tests/fem_demag_validation/sphere_validation.py` (requires MFEM stack) |
| Demag Poisson | ellipsoid factors | Osborn demag factors agree within 10% per axis and sum to 1 within 0.15 per shape | covered by `tests/fem_demag_validation/ellipsoid_validation.py` (requires MFEM stack) |
| Demag Poisson | airbox sweep | convergence with airbox size and boundary mode | covered by `tests/fem_demag_validation/airbox_convergence.py` (requires MFEM stack) |
| Demag FEM/BEM | body-only sphere | demag factor agreement | scripted in `tests/fem_demag_validation/fem_bem_body_validation.py`; body-only mesh materializes and source CLI diagnostic passes through Fredkin-Koehler, but active run remains runtime-open until the launcher/PyO3 core reports MFEM/libCEED CPU availability |
| DMI | directional derivative | finite-difference energy derivative matches weak residual | covered by `fem_dmi_weak_residual` |
| STT | macrospin CPP | sign and precession direction match reference | covered by `fem_stt_contract` |
| Thermal | seeded replay | deterministic replay for fixed seed and accepted `(t, dt)` | covered by `fem_thermal_brown_contract` |
| LLG | damping-only macrospin | energy decreases under relaxation | covered by `fem_llg_rhs_contract` |
| Periodic FEM | exchange periodic pair fixture | class-consistent field across periodic nodes | local class/reduction coverage by `fem_mesh_contract` and `fem_aos_field_contract`; active exchange numerical periodic fixture requires MFEM stack |

## Runtime Validation Matrix (MFEM/CUDA Stage)

No row in this section changes a capability row to `validated`. These are the runtime gates that must be executed in an MFEM/CUDA-capable environment before any public validation-status promotion.

| Area | Gate | Criterion | Required environment | Current status |
|---|---|---|---|---|
| Exchange | sinusoidal Laplacian | recovered `H_ex` matches `2 A_ex/(mu0 Ms) Delta m` for sinusoidal magnetization within 25% on the finest mesh | MFEM/libCEED CPU runtime or equivalent native FEM runtime | runtime-open; scripted acceptance covered by `tests/fem_exchange_validation/sinusoidal_mode.py`, full CSV run still requires MFEM/libCEED PyO3 core |
| Exchange | energy convergence | `E_ex` converges to `A k^2 V` under mesh refinement | MFEM/libCEED CPU runtime with PyO3 `_fullmag_core` built against the same stack | runtime-open; scripted acceptance covered by `tests/fem_exchange_validation/sinusoidal_mode.py`, full CSV run still requires MFEM/libCEED PyO3 core |
| Demag | sphere | uniformly magnetized sphere gives `H_demag ~= -M/3` and finite `E_d` | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/sphere_validation.py` |
| Demag | ellipsoid factors | effective demag factors agree with Osborn ellipsoid references within 10% per axis and sum to 1 within 0.15 per shape | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/ellipsoid_validation.py` |
| Demag | airbox convergence | Dirichlet/Robin airbox sweep improves with increasing airbox extent | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/airbox_convergence.py` |
| Demag | residual and iteration telemetry | solve publishes finite residuals, nonnegative iteration counts, and demag phase timings for assemble/RHS, solve, recover, and energy | MFEM/libCEED/Hypre runtime | runtime-open; telemetry CSV acceptance covered by `tests/fem_demag_validation/telemetry_validation.py` and `tests/fem_demag_validation/test_acceptance.py`, active solve evidence still required |
| DMI | chirality | interfacial and bulk DMI choose the expected handedness for domain-wall / spiral fixtures | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |
| DMI | spiral pitch | bulk/interfacial spiral pitch sign and scale match the documented coefficient convention | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |
| DMI | boundary tilt | natural-boundary derivative is nonzero for tangential tilt and zero for the baseline uniform state | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |
| Thermal | variance vs `dt` | Brown-field sample variance scales as `1/dt` with node volume, damping, `Ms`, and temperature | local sampler statistics plus stochastic runtime harness with deterministic seed | local sampler gate covered by `fem_thermal_brown_contract`; runtime CSV acceptance covered by `tests/fem_thermal_validation/artifact_validation.py` and `tests/fem_thermal_validation/test_acceptance.py`; active stochastic runtime evidence still required |
| Thermal | Boltzmann macrospin | long-run macrospin statistics match Boltzmann equilibrium within documented tolerance | statistical runtime harness with deterministic seed | runtime CSV acceptance covered by `tests/fem_thermal_validation/artifact_validation.py` and `tests/fem_thermal_validation/test_acceptance.py`; active stochastic LLG runtime trajectory gate still missing |
| GPU | strict residency counters | strict GPU path reports device source-of-truth, `hot_loop_compute_h2d_bytes = 0`, `hot_loop_compute_d2h_bytes = 0`, and `hot_loop_compute_host_sync_count = 0` | CUDA-visible MFEM/libCEED/Hypre GPU runtime | runtime-open; `scripts/analysis/fem_gpu_benchmark.py --require-gpu-strict-residency` enforces device source-of-truth plus zero hot-loop compute transfer/sync counters, and the box500 interaction preset enables it; current qualification still requires rerun |
| GPU | CPU/GPU parity | CPU and GPU fields, energies, and accepted-step statistics agree within per-interaction tolerances | CUDA-visible MFEM/libCEED/Hypre GPU runtime plus CPU reference run | runtime-open; scripted gate exists at `scripts/analysis/fem_gpu_benchmark.py --box500-airbox-interaction-consistency-preset` and `just bench-fem-box500-consistency` |

## Runtime Artifact Acceptance Commands

These commands are the handoff contract for the MFEM/CUDA validation stage. The
CSV-acceptance commands validate artifacts produced by runtime sweeps; they do
not run the solver themselves. Runtime-producing Python commands require a
PyO3 `_fullmag_core` built with the same MFEM/libCEED stack.

| Gate | Command |
|---|---|
| Exchange sinusoidal Laplacian and energy convergence | `python3 tests/fem_exchange_validation/sinusoidal_mode.py` |
| Demag sphere | `python3 tests/fem_demag_validation/sphere_validation.py` |
| Demag ellipsoid factors | `python3 tests/fem_demag_validation/ellipsoid_validation.py` |
| Demag airbox convergence | `python3 tests/fem_demag_validation/airbox_convergence.py` |
| Demag residual and iteration telemetry artifact | `python3 tests/fem_demag_validation/telemetry_validation.py <demag_telemetry.csv>` |
| DMI chirality, spiral pitch, and boundary tilt artifact | `python3 tests/fem_dmi_validation/artifact_validation.py <dmi_runtime.csv>` |
| Thermal variance and Boltzmann macrospin artifact | `python3 tests/fem_thermal_validation/artifact_validation.py <thermal_runtime.csv>` |
| GPU strict residency and CPU/GPU parity | `just bench-fem-box500-consistency` |

## Environment Boundary

The local no-MFEM contracts are useful regression gates but do not replace
active MFEM-stack validation. The managed host runtime at
`.fullmag/runtimes/fem-gpu-host` has now been regenerated with MFEM/libCEED/Hypre
headers, OpenMPI headers/runtime components, CUDA headers/libraries referenced
by MFEM, and relocated `MFEMConfig.cmake` / `MFEMTargets.cmake` metadata. A clean
`FULLMAG_USE_MFEM_STACK=ON` configure against that prefix now completes.

The currently checked active-MFEM contract slice is:

```text
cmake -S native -B /tmp/fullmag-native-mfem-check3 \
  -DFULLMAG_USE_MFEM_STACK=ON \
  -DFULLMAG_ENABLE_CUDA=OFF \
  -DCMAKE_PREFIX_PATH=/home/kkingstoun/git/fullmag/fullmag/.fullmag/runtimes/fem-gpu-host

cmake --build /tmp/fullmag-native-mfem-check3 --target \
  fem_source_facade_contract \
  fem_demag_poisson_contract \
  fem_exchange_contract \
  fem_demag_fem_bem_contract

env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/.fullmag/runtimes/fem-gpu-host/lib \
  ctest --test-dir /tmp/fullmag-native-mfem-check3/backends/fem \
  -R 'fem_(source_facade_contract|demag_poisson_contract|exchange_contract|demag_fem_bem_contract)' \
  --output-on-failure
```

Result: `4/4` selected MFEM-stack contracts passed. Rows marked runtime-open
have scripted gates or artifact validators, but still require those commands to
be run in the MFEM/CUDA environment before production qualification can be
closed.

Exchange sinusoidal validation now has a scripted runtime gate at
`tests/fem_exchange_validation/sinusoidal_mode.py`. The managed
`fullmag --headless` path successfully materializes and runs the representative
8 nm finest-mesh exchange-only stage through `fem_cpu_native`. The full CSV
refinement sweep is intentionally a Python entrypoint and needs the PyO3
`_fullmag_core` to be built with the same MFEM/libCEED CPU stack; the current
local `.fullmag/local/python` core is importable but reports no native FEM CPU
availability for time-domain FEM, so it cannot close the CSV acceptance run in
this checkout yet.

FEM/BEM body-only demag validation now has a scripted runtime gate at
`tests/fem_demag_validation/fem_bem_body_validation.py`. The script declares a
Fredkin-Koehler sphere without an airbox for `fullmag --headless` capture and
runs a CSV refinement sweep from the direct Python entrypoint, converting demag
energy to an effective sphere factor with `N = 2E/(mu0 Ms^2 V)`. Current source
CLI materializes the 12 nm body-only mesh and no longer lets the initial
diagnostic reject `fredkin_koehler`; the next local blocker is runtime
availability: `cargo run -p fullmag-cli -- --headless ...` and the direct PyO3
sweep both stop with `RunError: time-domain FEM execution requires the
MFEM/libCEED runtime stack`. The installed `.fullmag/local/bin/fullmag` binary
also needs to be rebuilt to pick up the diagnostic pass-through change.
