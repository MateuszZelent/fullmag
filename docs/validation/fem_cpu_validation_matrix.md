# FEM CPU Validation Matrix

- Status: release-gate validation matrix for native FEM CPU modularization
- Last updated: 2026-05-17
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
| Interaction docs | `fem_interaction_docs_contract` | required release docs and per-interaction docs exist |
| Explicit RK | `fem_rk_explicit_contract` | tableau type/dispatch ownership, RK workspace storage/allocation ownership, stage RHS ownership, explicit RK step ownership, and Context no longer declaring RK helpers |
| Fixed-step Heun | `fem_heun_step_contract` | Heun predictor-corrector ownership and Context no longer declaring the Heun step entrypoint |
| Adaptive DT | `fem_adaptive_dt_contract` | adaptive config validation/import ownership, PI controller ownership, and componentwise AoS error norm |
| MFEM device | `fem_mfem_device_contract` | MFEM device-string/GPU-index plan import ownership, device-info cache ownership, and CPU/GPU device classification |
| GPU state runtime | `fem_gpu_state_runtime_contract` | GPU-state bootstrap/upload ownership, host-resident no-CUDA metadata initialization, and Context no longer owning startup residency mechanics |
| State I/O runtime | `fem_state_io_contract` | magnetization readback/upload ownership, observable field copy semantics, runtime cache invalidation, and Context no longer owning C ABI state I/O |
| Interrupt runtime | `fem_interrupt_contract` | cooperative interrupt polling ownership and Context no longer defining the inline polling helper |
| Snapshot runtime | `fem_snapshot_contract` | scalar snapshot/statistics ownership and Context no longer declaring the snapshot entrypoint |
| Step metrics | `fem_step_metrics_contract` | common step-stat aggregation, average/field norm helpers, demag solver stat publication, and PhaseTimings ownership outside Context |
| Stage completion | `fem_stage_completion_contract` | relaxation-stop validation/state initialization, plateau-window policy/tracking, stop-reason ownership including C ABI error/cancel paths, and Context no longer declaring the update wrapper |
| Field refresh | `fem_field_refresh_contract` | field-refresh policy validation/import ownership and demag frozen-cache reset ownership |
| FEM base plan fields | `fem_plan_fields_contract` | base ABI plan validation, runtime scalar import, mesh cardinality import, and Context no longer owning those checks |
| FEM mesh core | `fem_mesh_contract` | mesh plan-field import ownership, magnetic mask ownership, periodic topology/helper ownership, periodic compatibility gate ownership, nodal-volume helper ownership, and Context no longer owning static AoS periodic projection |
| FEM state | `fem_state_contract` | initial magnetization validation/copy ownership, static periodic projection, and time/step reset ownership |
| FEM material fields | `fem_material_fields_contract` | scalar and per-node material field import/validation ownership and scalar material convention validation |
| FEM field buffers | `fem_field_buffers_contract` | nodal field-buffer sizing/zeroing ownership and external-field seeding of `H_eff` |
| Exchange | `fem_exchange_contract` | no-MFEM behavior, plan-field initialization ownership including consistent-mass projection policy, operator/field/runtime/fallback ownership, mass projection ownership, legacy GPU upload ownership, and Context no longer declaring the runtime refresh wrapper |
| Effective field | `fem_effective_field_contract` | field/direct-torque gate ownership, top-level H_eff composition ownership, eager initial effective-field refresh policy ownership, and Context no longer declaring the composition entrypoint |
| Demag dispatcher | `fem_demag_contract` | plan-field initialization ownership, cached/Poisson/FEM-BEM dispatch decision |
| Demag Poisson | `fem_demag_poisson_contract` | energy, cache, telemetry, visual field, periodic-reduction predicate, ready/lifecycle/solve ownership, and Context no longer declaring Poisson lifecycle/solve entrypoints |
| Demag FEM/BEM | `fem_demag_fem_bem_contract` | boundary extraction, dense BEM sanity, energy sign, energy/solve ownership |
| DMI | `fem_dmi_contract` | DMI disabled/error contracts, interfacial-DMI ownership, bulk-DMI ownership, workspace ownership, plan-field/normal initialization ownership, and module ownership |
| Thermal | `fem_thermal_brown_contract` | Brown sigma, seed/cache, field addition, plan-field initialization ownership, module ownership, nonmagnetic zeroing |
| STT | `fem_stt_contract` | direct torque families, Slonczewski/Zhang-Li module ownership, plan-field/family validation ownership, and disabled behavior |
| Oersted | `fem_oersted_contract` | analytical cylinder, explicit nodal field behavior, plan-field/realization validation ownership, and module ownership |
| Magnetoelastic | `fem_magnetoelastic_contract` | prescribed-strain field/energy, field-add module ownership, plan-field initialization ownership, masking, and additive H_eff |
| Zeeman/anisotropy | `fem_zeeman_contract`, `fem_anisotropy_contract` | local field, energy, Zeeman plan-field initialization and broadcast/field/energy module ownership, uniaxial/cubic module ownership, and anisotropy plan-field initialization plus axis normalization/validation ownership |

## Required Physics Fixtures

| Area | Fixture | Required criterion | Status |
|---|---|---|---|
| Exchange | uniform state | zero exchange field and energy | local contract only |
| Exchange | sinusoidal mode | convergence of `H_ex` against analytic Laplacian | open |
| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | open |
| Demag Poisson | airbox sweep | convergence with airbox size and boundary mode | open |
| Demag FEM/BEM | body-only sphere or ellipsoid | demag factor agreement | open |
| DMI | directional derivative | finite-difference energy derivative matches weak residual | open |
| STT | macrospin CPP | sign and precession direction match reference | open |
| Thermal | seeded replay | deterministic replay for fixed seed and accepted `(t, dt)` | open |
| LLG | damping-only macrospin | energy decreases under relaxation | open |
| Periodic FEM | exchange periodic pair fixture | class-consistent field across periodic nodes | partially covered historically |

## Environment Boundary

The local no-MFEM contracts are useful regression gates but do not replace
active MFEM-stack validation. The current local MFEM configure still fails
before compilation because `MFEMConfig.cmake` references a missing directory:

```text
.fullmag/runtimes/fem-gpu-host/include
```

Until that runtime is repaired, production qualification remains open even when
the local no-MFEM contract suite is green.
