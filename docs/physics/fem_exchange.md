# FEM Exchange Interaction

- Status: native FEM CPU/GPU module contract, full field assembly requires MFEM runtime validation
- Last updated: 2026-06-17
- Implementation:
  `backends/fem/cpu/mfem/interactions/exchange.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_operator.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_field.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_runtime.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_fallback.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/exchange_mass_projection.hpp/.cpp`,
  `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp/.cu`,
  `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp/.cu`,
  `backends/fem/gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp/.cu`
- Test: `backends/fem/tests/exchange_contract.cpp`,
  `backends/fem/tests/source_facade_gpu_rk_contract.cpp`

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

The default projection uses the unweighted lumped magnetic volume mass diagonal
and applies pointwise `1/Ms_i` scaling:

```text
H_ex,i = -2 (K_A m)_i / (mu0 Ms_i M_lumped,i)
```

The consistent-mass mode instead solves the `Ms`-weighted mass projection:

```text
M_Ms q = K_A m
H_ex = -2 q / mu0
```

which is equivalent to the weak statement
`delta E_ex = -mu0 integral Ms H_ex.delta_m dV`. Periodic reductions aggregate
RHS and mass on periodic node classes before lifting the field back to full
nodes. This projection policy is kept separate from exchange stiffness assembly
so the operator module remains responsible only for magnetic-attribute
selection and MFEM form setup.

## GPU realization

The current native FEM GPU RK path uses the assembled MFEM stiffness matrix as a
legacy sparse CSR operator uploaded to device memory. The field kernel applies
the same lumped projection as the CPU lumped path:

```text
H_ex = -2 M_lumped^-1 K_A m / (mu0 Ms)
```

with nonmagnetic nodes masked to zero. GPU RK planning currently requires
`enable_exchange=true`, so final GPU exchange-energy reduction assumes the
legacy sparse operator is present. The final energy kernel computes

```text
E_ex = sum_i m_i . (K_A m)_i
```

across the three magnetization components, matching the CPU assembled stiffness
energy convention. Consistent-mass exchange projection is a CPU/MFEM projection
policy; it is not the current device-resident GPU RK exchange path.

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
- The GPU RK device-resident path currently requires exchange to be enabled and
  uses the legacy sparse/lumped projection path. Consistent-mass projection is
  not claimed as the current GPU RK exchange realization.
- The no-MFEM fallback is isolated in `exchange_fallback.*` and does not claim
  active exchange execution.

## Testy

Current source-contract gate:

```bash
cmake --build native/build --target fem_exchange_contract
ctest --test-dir native/build/backends/fem -R fem_exchange_contract --output-on-failure
```

Final runtime proof uses the managed FEM runtime route:

```bash
just verify-fem-exchange-runtime
```

That recipe first runs `just ensure-managed-fem-runtime`, then executes
`tests/fem_exchange_validation/sinusoidal_mode.py` in the FEM runtime container.
Host CMake/CTest runs are useful diagnostics and source-contract checks, but
they are not the final native FEM exchange runtime proof.

`fem_exchange_contract` also checks source-module ownership for operator
assembly, field computation, runtime refresh, fallback, mass projection, and
legacy GPU upload. It also checks top-level source-contract docstrings for the
aggregate, operator, field-compute, runtime-refresh, fallback, mass-projection,
and legacy GPU upload sources, plus exchange enablement storage in
`ExchangeRuntimeState` instead of flat `Context`.

`fem_source_facade_gpu_rk_contract` checks that GPU RK exchange field and energy
headers document the legacy sparse/lumped projection, sign, units, magnetic-node
masking, and the separation between exchange upload, RK dispatch, and final
energy reductions.

Runtime validation is gated by
`just verify-fem-exchange-runtime`, which runs
`tests/fem_exchange_validation/sinusoidal_mode.py`. The scripted acceptance
requires finite `H_ex` and energy metrics, finest-mesh `H_ex` relative error
below 25% against `2 A_ex/(mu0 Ms) Delta m` using the energy-equivalent
helical amplitude `2 E_ex/(mu0 Ms V)`, and finest-mesh energy relative error
below 8% against `A_ex k^2 V`. It also records raw `max_h_eff` as an
outlier diagnostic and writes
`tests/fem_exchange_validation/results/sinusoidal_mode.csv`. Executing the full
CSV sweep still requires a managed runtime export with complete MFEM/libCEED
libraries and the matching PyO3 `_fullmag_core`.
