# FEM Exchange Interaction

- Status: native FEM CPU module contract, full field assembly requires MFEM runtime validation
- Last updated: 2026-05-18
- Implementation:
  `native/backends/fem/cpu/mfem/interactions/exchange.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_operator.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_field.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_runtime.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_fallback.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/exchange_mass_projection.hpp/.cpp`
- Test: `native/backends/fem/tests/exchange_contract.cpp`

## Pole

The native FEM CPU exchange module owns the exchange stiffness operator for the
MFEM bridge. It returns the exchange effective field `H_ex` in `A/m`. The LLG
stepper converts that field to `dm/dt`; this module does not apply gamma,
damping, or direct-torque scaling.

The continuum field convention is:

```text
H_ex = 2 A_ex / (mu0 Ms) Delta m
```

where `m = M / Ms` is reduced magnetization.

## Energia

The module reports exchange energy in joules:

```text
E_ex = integral_Omega A_ex |grad m|^2 dV
```

The assembled MFEM stiffness matrix represents the weak form
`integral A_ex grad(phi_i).grad(phi_j) dV` on magnetic elements. The field is
recovered by `exchange_mass_projection.*`, which owns lumped mass, consistent
mass, periodic reduced-node projection, `Ms` scaling, and export of each
component field. The field is zeroed on nonmagnetic nodes before it leaves the
top-level exchange module.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| exchange stiffness | `A_ex` | `J/m` |
| saturation magnetization | `Ms` | `A/m` |
| exchange field | `H_ex` | `A/m` |
| exchange energy | `E_ex` | `J` |

## Warunki brzegowe

The assembled operator uses natural exchange boundary conditions on free
magnetic boundaries. Nonmagnetic and airbox nodes are explicitly zeroed in the
returned field buffer.

## Dyskretyzacja FEM

For P1 tetrahedral H1 basis functions, each component is handled independently:

```text
rhs_c = K_A m_c
M h_raw_c = rhs_c
H_ex,c = -2 h_raw_c / (mu0 Ms)
```

The default projection uses the lumped magnetic mass diagonal. The
consistent-mass mode solves the mass projection with CG. Periodic reductions
aggregate RHS and mass on periodic node classes before lifting the field back to
full nodes. This projection policy is kept separate from exchange stiffness
assembly so the operator module remains responsible only for magnetic-attribute
selection and MFEM form setup.

Source ownership:

- `exchange_operator.hpp/.cpp` owns magnetic-attribute selection and exchange /
  mass form initialization.
- `exchange_field.hpp/.cpp` owns component upload, mass-projection calls,
  nonmagnetic zeroing, optional `H_eff` export, and exchange-energy
  accumulation.
- `exchange_runtime.hpp/.cpp` owns the Context refresh wrapper used by runtime
  snapshot/step setup.
- `exchange_fallback.hpp/.cpp` owns disabled zero-field behavior and explicit
  MFEM-stack errors for non-MFEM builds.
- `exchange_mass_projection.hpp/.cpp` owns lumped/consistent/periodic mass
  projection.
- `exchange_legacy_gpu_upload.hpp/.cpp` owns legacy sparse GPU upload.
- `exchange.hpp/.cpp` remains an aggregate include and compatibility
  translation unit.

Plan/runtime storage ownership: `ExchangeRuntimeState` stores the exchange
enablement flag, materialized `H_ex` buffer, and MFEM exchange workspace. The
aggregate plan import writes `plan.enable_exchange` to `ctx.exchange.enabled`
and the top-level `Context` does not own a flat `enable_exchange` field.

## Ograniczenia capability

- Active exchange field assembly requires `FULLMAG_HAS_MFEM_STACK`.
- Local non-MFEM builds verify disabled zero-field behavior and explicit
  environment errors when active exchange is requested without MFEM.
- The legacy sparse GPU upload is isolated in `exchange_legacy_gpu_upload.*`.
  It validates CSR shape/index data and transfers the assembled operator plus
  lumped mass vectors; it does not change the physical exchange contract.
- The no-MFEM fallback is isolated in `exchange_fallback.*` and does not claim
  active exchange execution.

## Testy

Current local gate:

```bash
cmake --build native/build --target fem_exchange_contract
ctest --test-dir native/build/backends/fem -R fem_exchange_contract --output-on-failure
```

`fem_exchange_contract` also checks source-module ownership for operator
assembly, field computation, runtime refresh, fallback, mass projection, and
legacy GPU upload. It also checks top-level source-contract docstrings for the
aggregate, operator, field-compute, runtime-refresh, fallback, mass-projection,
and legacy GPU upload sources, plus exchange enablement storage in
`ExchangeRuntimeState` instead of flat `Context`.

The full MFEM exchange branch still requires an environment with complete MFEM
headers and libraries.
