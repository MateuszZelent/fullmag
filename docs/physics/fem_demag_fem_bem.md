# FEM/BEM Open-Boundary Demag

- Status: native FEM CPU dense-reference module contract, active MFEM solve path requires runtime validation
- Last updated: 2026-05-17
- Implementation:
  `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.hpp/.cpp`,
  `demag_fem_bem_energy.hpp/.cpp`, `demag_fem_bem_solve.hpp/.cpp`,
  `demag_fem_bem_surface.hpp/.cpp`, `demag_fem_bem_operator.hpp/.cpp`,
  `demag_fem_bem_linear_solve.hpp/.cpp`,
  `demag_fem_bem_boundary_values.hpp/.cpp`,
  `demag_fem_bem_workspace.hpp/.cpp`,
  `demag_fem_bem_potential.hpp/.cpp`, `demag_fem_bem_telemetry.hpp/.cpp`,
  and `demag_fem_bem_rhs.hpp/.cpp`
- Test: `native/backends/fem/tests/demag_fem_bem_contract.cpp`
- Architecture reference: `docs/physics/0870-fem-bem-demag-open-boundary.md`

## Pole

The FEM/BEM module is an open-boundary demagnetizing-field path for body-only
tetrahedral meshes. It is separate from the airbox Poisson demag module:
FEM/BEM does not require an airbox and instead couples a volume FEM solve to a
boundary integral operator on the exterior magnetic surface.

The recovered field is `H_demag` in `A/m`. The LLG stepper consumes it as an
effective-field contribution; this module does not apply gamma, damping, or
direct-torque scaling.

## Energia

FEM/BEM uses the same demag energy convention as the Poisson demag module:

```text
E_d = -0.5 mu0 integral_Omega_m Ms m.H_demag dV
```

`demag_fem_bem_energy_from_field(...)` delegates this scalar convention to the
shared demag energy implementation so Poisson and FEM/BEM report consistent
sign, units, lumped-mass weighting, and magnetic-node masking.
The wrapper is owned by `demag_fem_bem_energy.*`; `demag_fem_bem.*` is only the
aggregate include/translation-unit surface.

## Boundary Operator

The local reference implementation extracts a `DemagBoundarySurface` from the
magnetic tetrahedral body mesh:

- `boundary_nodes`: global mesh nodes that participate in the BEM surface
- `global_to_boundary`: global-node to dense-boundary-row map
- `triangles`: oriented exterior boundary triangles
- `unit_normals`: outward unit normals
- `triangle_areas`: triangle areas

`DenseDemagBemOperator` assembles a dense O(Nb^2) boundary matrix. This is a
correctness/reference operator, not a production compressed BEM/H2/FMM path.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| saturation magnetization | `Ms` | `A/m` |
| demag field | `H_demag` | `A/m` |
| demag energy | `E_d` | `J` |
| boundary potential | `u` | MFEM scalar potential convention |

## Capability Boundary

- Active FEM/BEM demag requires `FULLMAG_HAS_MFEM_STACK`.
- The initial active path requires an MPI/Hypre-enabled MFEM runtime.
- Periodic FEM/BEM demag is explicitly unsupported.
- The dense BEM operator is validation/reference scale only.
- Production qualification still requires analytic sphere/thin-film fixtures and
  comparison against converged Poisson airbox demag.
- Per-step Fredkin-Koehler solve orchestration is owned by
  `demag_fem_bem_solve.*`.

## Testy

Current local gate:

```bash
cmake --build native/build --target fem_demag_fem_bem_contract
ctest --test-dir native/build/backends/fem -R fem_demag_fem_bem_contract --output-on-failure
```

The current contract checks body-only boundary-surface extraction, finite dense
BEM matrix/apply behavior, constant-potential sanity on a unit tetrahedron, and
energy parity with the shared demag convention. It also checks source ownership
for the energy and solve modules so those definitions do not return to the
aggregate `demag_fem_bem.cpp`.
