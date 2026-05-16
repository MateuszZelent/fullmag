# FEM Exchange Interaction

- Status: native FEM CPU module contract, full field assembly requires MFEM runtime validation
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/exchange.hpp/.cpp`
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
recovered by lumped or consistent magnetic-mass projection and is zeroed on
nonmagnetic nodes before it leaves the module.

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
full nodes.

## Ograniczenia capability

- Active exchange field assembly requires `FULLMAG_HAS_MFEM_STACK`.
- Local non-MFEM builds verify disabled zero-field behavior and explicit
  environment errors when active exchange is requested without MFEM.
- The legacy sparse GPU upload remains a compatibility bridge; it does not
  change the physical exchange contract.

## Testy

Current local gate:

```bash
cmake --build native/build --target fem_exchange_contract
ctest --test-dir native/build/backends/fem -R fem_exchange_contract --output-on-failure
```

The full MFEM exchange branch still requires an environment with complete MFEM
headers and libraries.
