# Native FEM Magnetoelastic Patch v1

- Status: draft implementation contract
- Last updated: 2026-05-16
- Related ADR: `docs/adr/0014-native-fem-backend-modularization.md`
- Related physics:
  - `docs/physics/0700-shared-magnetoelastic-semantics.md`
  - `docs/physics/fem_magnetoelastic.md`
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- Related reports:
  - `docs/reports/16.05.2026/fullmag_magnetoelastic_audit.md`
  - `docs/reports/16.05.2026/fullmag_magnetoelastic_implementation_plan.md`

## Scope

This patch contract defines the first production-oriented native FEM path for
bidirectional magnetoelasticity:

```text
mode: quasistatic
mesh scope: same mesh only
strain model: small strain
material model: linear elastic cubic/isotropic as lowered by ProblemIR
```

The existing prescribed-strain path remains executable and ABI-compatible. It
does not count as two-way magnetoelasticity.

## ProblemIR and Planner

`Magnetoelastic` remains one energy term. `MechanicsIR` selects the requested
mechanics mode.

Current planner policy:

- `PrescribedStrain`: executable on native FEM when a prescribed strain load is
  present.
- `QuasistaticElasticity`: must be rejected until the native mechanics
  subsystem exists.
- `Elastodynamics`: must be rejected until a separate dynamic mechanics solver
  family exists.

The planner must validate references to magnets, elastic bodies, elastic
materials, and magnetostriction laws before lowering.

`FemPlanIR` carries two separate records during the migration:

- `magnetoelastic`: the current native compatibility payload containing `B1`,
  `B2`, and prescribed strain values consumed by the existing `mel_*` ABI
  fields;
- `mechanics`: the canonical self-contained `FemMechanicalPlanIR` contract with
  mode, elastic body, elastic material, magnetostriction law, mechanical loads,
  boundary conditions, and future solver controls.

New backend work must treat `FemMechanicalPlanIR` as the source of mechanics
ownership. The old `mel_*` ABI fields exist only to keep the prescribed-strain
slice executable until the mechanics subsystem replaces them.

## Native C ABI Target

The current wide `fullmag_fem_plan_desc` may remain during migration, but the
target ABI split is:

```text
fullmag_fem_problem_desc
fullmag_fem_mesh_desc
fullmag_fem_material_desc
fullmag_fem_interaction_desc[]
fullmag_fem_mechanics_desc
fullmag_fem_solver_desc
fullmag_fem_runtime_desc
fullmag_fem_observable_desc[]
```

The mechanics descriptor must include:

- mechanics mode;
- elastic material constants;
- mechanical boundary conditions;
- mechanical loads;
- solver policy;
- Picard controls for quasistatic coupling;
- optional mechanical timestep for future elastodynamics.

## Native Backend Target

Native FEM must introduce subsystem ownership boundaries:

```text
ElasticitySubsystem
MagnetoelasticSubsystem
MechanicsState
MechanicsObservables
SameMeshTransfer
```

`Context` may hold transitional compatibility fields, but new mechanics state
must have a documented target owner and removal condition.

## Quasistatic Solve

The V1 quasistatic path solves:

```text
integral eps(v):C:eps(u) dV
  = integral eps(v):C:eps_mag(m) dV
    + external mechanical loads
```

Implementation requirements:

- assemble stiffness matrix once when mesh, material, and BCs are fixed;
- build solver and preconditioner once;
- refresh only the RHS when magnetization changes;
- warm-start from the previous displacement;
- recover strain and stress after solve;
- compute `H_mel`, `E_mel`, and `E_el` from the same energy contract.

## Observables

The patch must provide these names and SI units:

| Name | Type | Unit |
|---|---|---|
| `H_mel` | vector field | A/m |
| `u` | vector field | m |
| `eps` | tensor/Voigt field | 1 |
| `sigma` | tensor/Voigt field | Pa |
| `E_mel` | scalar | J |
| `E_el` | scalar | J |
| `E_kin_el` | scalar | J, elastodynamics only |
| `elastic_residual_norm` | scalar | solver residual norm |

Until the mechanics solver exists, `u`, `eps`, `sigma`, `E_el`, `E_kin_el`,
and `elastic_residual_norm` are not executable outputs.

## Reject Policy

V1 must reject:

- multi-mesh `Omega_m != Omega_s` execution without transfer operators;
- periodic mechanics without a feature-specific PBC gate;
- unconstrained rigid-body modes unless explicit pin/constraint policy exists;
- elastodynamics on the quasistatic solver family;
- promotion to public/validated capability without the gates below.

## Acceptance Gates

Required gates:

- local directional derivative test for `E_mel` vs `H_mel`;
- `B1=B2=0` gives zero field and zero coupling energy;
- zero prescribed strain gives zero prescribed-strain `H_mel`;
- elasticity patch test;
- clamped-bar or beam magnetostriction validation;
- solver setup reuse and iteration telemetry;
- no accepted-step hot-path heap allocation;
- no hidden host/device transfer in GPU accepted-step paths;
- CPU/GPU parity before any shared GPU capability label.
