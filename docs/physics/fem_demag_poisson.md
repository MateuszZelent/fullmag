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
`H_demag` recovery have been moved into `demag_poisson.*`. Step orchestration
and timing aggregation are still in `mfem_bridge.cpp`.

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
- Full demag production qualification still requires analytic tests and
  convergence reports.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_demag_poisson_contract` checks the `-0.5 mu0 Ms m.H` energy convention,
  nodal lumped weights, per-node `Ms`, and nonmagnetic-node masking.
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
