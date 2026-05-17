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
| Exchange | `fem_exchange_contract` | no-MFEM behavior, operator/field/runtime/fallback ownership, mass projection ownership, legacy GPU upload ownership, and source ownership |
| Demag dispatcher | `fem_demag_contract` | cached/Poisson/FEM-BEM dispatch decision |
| Demag Poisson | `fem_demag_poisson_contract` | energy, cache, telemetry, visual field, ready/lifecycle/solve ownership |
| Demag FEM/BEM | `fem_demag_fem_bem_contract` | boundary extraction, dense BEM sanity, energy sign, energy/solve ownership |
| DMI | `fem_dmi_contract` | DMI disabled/error contracts, interfacial-DMI ownership, bulk-DMI ownership, workspace ownership, and module ownership |
| Thermal | `fem_thermal_brown_contract` | Brown sigma, seed/cache, field addition, module ownership, nonmagnetic zeroing |
| STT | `fem_stt_contract` | direct torque families, Slonczewski/Zhang-Li module ownership, and disabled behavior |
| Oersted | `fem_oersted_contract` | analytical cylinder, explicit nodal field behavior, and module ownership |
| Magnetoelastic | `fem_magnetoelastic_contract` | prescribed-strain field/energy, field-add module ownership, masking, and additive H_eff |
| Zeeman/anisotropy | `fem_zeeman_contract`, `fem_anisotropy_contract` | local field, energy, Zeeman broadcast/field/energy module ownership, and uniaxial/cubic module ownership |

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
