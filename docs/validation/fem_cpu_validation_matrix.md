# FEM CPU Validation Matrix

- Status: release-gate validation matrix for native FEM CPU modularization
- Last updated: 2026-05-18
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

## Required Physics Fixtures

| Area | Fixture | Required criterion | Status |
|---|---|---|---|
| Exchange | uniform state | zero exchange field and energy | local contract only |
| Exchange | sinusoidal mode | convergence of helical `E_ex = A k^2 V` with finite `H_ex` diagnostic | scripted in `tests/fem_exchange_validation/sinusoidal_mode.py`; representative `fullmag --headless` finest-mesh stage passes on managed runtime; full CSV sweep requires a PyO3 `_fullmag_core` built with MFEM/libCEED |
| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | covered by `tests/fem_demag_validation/sphere_validation.py` (requires MFEM stack) |
| Demag Poisson | airbox sweep | convergence with airbox size and boundary mode | covered by `tests/fem_demag_validation/airbox_convergence.py` (requires MFEM stack) |
| Demag FEM/BEM | body-only sphere | demag factor agreement | scripted in `tests/fem_demag_validation/fem_bem_body_validation.py`; body-only mesh materializes and source CLI diagnostic passes through Fredkin-Koehler, but active run remains runtime-open until the launcher/PyO3 core reports MFEM/libCEED CPU availability |
| DMI | directional derivative | finite-difference energy derivative matches weak residual | covered by `fem_dmi_weak_residual` |
| STT | macrospin CPP | sign and precession direction match reference | covered by `fem_stt_contract` |
| Thermal | seeded replay | deterministic replay for fixed seed and accepted `(t, dt)` | covered by `fem_thermal_brown_contract` |
| LLG | damping-only macrospin | energy decreases under relaxation | covered by `fem_llg_rhs_contract` |
| Periodic FEM | exchange periodic pair fixture | class-consistent field across periodic nodes | local class/reduction coverage by `fem_mesh_contract` and `fem_aos_field_contract`; active exchange numerical periodic fixture requires MFEM stack |

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

Result: `4/4` selected MFEM-stack contracts passed. Rows marked
`runtime-open (requires MFEM stack)` still lack a concrete numerical fixture
gate. Rows covered by `tests/fem_demag_validation/*.py` have scripted runtime
gates with fail-fast acceptance criteria, but still require those scripts to be
run before production qualification can be closed.

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
