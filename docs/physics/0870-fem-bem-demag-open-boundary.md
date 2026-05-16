# FEM/BEM Open-Boundary Demag

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-16
- Related ADRs:
  - `docs/adr/0014-native-fem-backend-modularization.md`
- Related specs:
  - `docs/specs/native-fem-backend-architecture-v1.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics:
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`

## 1. Problem Statement

The current executable native FEM demagnetization path is Poisson demag on a
shared magnetic-plus-air domain. This is useful, but it makes open boundary
accuracy depend on an artificial airbox size, boundary condition, and mesh
grading.

Tetmag, authored by Riccardo Hertel, uses a different finite-element
magnetostatic realization in `external_solvers/tetmag`: a body-only FEM solve
coupled to a boundary element operator on the magnetic surface. The relevant
code is:

- `external_solvers/tetmag/main/DemagField.cpp`
- `external_solvers/tetmag/preproc/BEMprocessing.cpp`
- `external_solvers/tetmag/preproc/Lindholm.cpp`
- `external_solvers/tetmag/main/h2interface.c`

This note defines the Fullmag physics contract for that method. The
implementation must not copy Tetmag's AGPL source into Fullmag unless the
project explicitly accepts that license coupling. The safe implementation path
is to rederive the numerical method from the equations and use Tetmag only as
an external reference fixture.

## 2. Physical Model

### 2.1 Governing Equations

Let

```text
M(x) = Ms(x) m(x)
```

with `M` in A/m and `|m| = 1` on the magnetic domain `Omega_m`.
In the absence of free current, demagnetization is governed by

```text
curl H_d = 0
div B = 0
B = mu0 (H_d + M)
```

so

```text
H_d = -grad u
Delta u = div M              in all space
u(x) -> 0                    as |x| -> infinity
```

Fullmag's energy convention remains

```text
E_d = -0.5 * mu0 * integral_Omega_m M . H_d dV
```

in joules.

### 2.2 Hybrid FEM/BEM Decomposition

The open-boundary potential can be computed without meshing the exterior air by
splitting the potential into two interior fields:

```text
u = u1 + u2                                      in Omega_m
```

where `u1` handles the volume source and `u2` corrects the boundary to satisfy
the full-space decay condition.

Tetmag's implementation follows this pattern:

1. Solve a pure-Neumann Poisson problem on the magnetic body:

```text
integral_Omega_m grad u1 . grad v dV =
integral_Omega_m M . grad v dV
```

with one scalar gauge constraint because the Neumann problem is singular.

2. Restrict `u1` to the boundary nodes.

3. Apply a boundary integral operator to get the boundary values for the
harmonic correction:

```text
u2|_Gamma = B(u1|_Gamma)
```

Tetmag builds this operator either as a dense matrix in
`BEMprocessing::assembleLaplaceBEMmatrix()` or as an H2-compressed operator in
`h2interface.c`. Its dense path uses Lindholm triangle weights from
`Lindholm::weights()` and solid-angle diagonal terms.

4. Solve a Dirichlet Laplace problem on the magnetic body:

```text
Delta u2 = 0                                    in Omega_m
u2 = B(u1|_Gamma)                               on Gamma = boundary(Omega_m)
```

5. Recover the demag field:

```text
H_d = -grad(u1 + u2)
```

This is the important product distinction from the current Fullmag Poisson
airbox path: there is no volumetric airbox mesh. The exterior is represented by
the boundary integral operator on the magnetic surface.

### 2.3 Symbols and SI Units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M` | magnetization density, `Ms m` | A/m |
| `Ms` | saturation magnetization | A/m |
| `H_d` | demagnetizing field | A/m |
| `u`, `u1`, `u2` | magnetic scalar potentials | A |
| `mu0` | vacuum permeability | N/A^2 |
| `Omega_m` | magnetic domain | m^3 domain |
| `Gamma` | magnetic boundary | m^2 surface |
| `B` | boundary integral operator mapping boundary `u1` to boundary `u2` | dimensionless under the discrete Tetmag convention |

### 2.4 Assumptions and Validity Limits

- The first Fullmag implementation targets conforming closed tetrahedral
  magnetic meshes with P1 scalar potential and P1 nodal magnetization.
- The method requires a watertight oriented boundary surface. It is not valid
  for open surfaces, nonmanifold surfaces, or meshes with ambiguous exterior
  normals.
- The first implementation should support non-periodic open boundaries only.
  Periodic FEM/BEM demag is a separate method and must remain rejected.
- The first implementation should support one connected magnetic body or a
  merged multi-body magnetic mesh. Multi-body accuracy requires testing because
  the BEM surface must include every exterior magnetic boundary and must not
  include interior artificial faces between merged bodies.
- The method is an open-boundary FEM demag realization. It is not an FDM FFT
  demag path and must not emit FFT provenance.

## 3. Numerical Interpretation

### 3.1 FDM

No change. FDM demag remains tensor-kernel convolution on structured grids.
FEM/BEM demag is a FEM realization of the same continuum demag physics, not a
new public energy term.

### 3.2 FEM

The MFEM implementation should introduce a dedicated demag subsystem with these
owned components:

```text
DemagFemBemSubsystem
  BoundarySurface
  NeumannPoissonWorkspace
  BoundaryIntegralOperator
  DirichletLaplaceWorkspace
  PotentialRecoveryWorkspace
  SolverTelemetry
```

The subsystem computes:

```text
rhs_i = integral_Omega_m M . grad(phi_i) dV
```

then solves `K u1 = rhs` with a gauge constraint. For the Laplace correction it
uses the same scalar stiffness operator `K`, but applies essential Dirichlet
boundary values on every boundary true DOF and solves `K u2 = 0` with boundary
elimination.

Boundary operator stages:

1. **Dense reference operator.**
   Build a dense matrix over boundary nodes for small validation meshes. This
   is expected to be O(Nb^2) memory and setup. It is not the production path.

2. **Compressed production operator.**
   Add an H2/FMM-compatible abstraction after the dense reference is correct.
   The public contract is matrix-vector application `u2_boundary = B u1_boundary`.
   The implementation may use an external H2 library, FMM, or an internal ACA/H
   matrix later, but the solver subsystem must not expose that as physics.

Telemetry must be compatible with the opt-in solver profiler:

```text
demag_bem_setup
demag_poisson_neumann_solve
demag_bem_apply
demag_laplace_dirichlet_solve
demag_recover
demag_energy
```

These can map into the public stable phase vocabulary through `demag_total`,
`demag_solver_setup`, `demag_solver_apply`, `demag_recover`, and
`demag_energy`, with detailed subphase labels carried in diagnostics.

### 3.3 Hybrid

No hybrid semantics are introduced. Hybrid authoring must continue to lower
through `Demag()` and explicit backend hints. A future hybrid FDM/FEM coupling
must not reinterpret `fredkin_koehler` as an FDM correction model.

## 4. API, IR, and Planner Impact

### 4.1 Python API Surface

The existing Python API already admits future model vocabulary:

```python
fm.Demag(model="fredkin_koehler")
fm.Demag(model="bem")
```

The implementation should choose one canonical public name for this method:

```text
fredkin_koehler
```

and keep `bem` as either an alias or a lower-level implementation family only
after the capability matrix is updated. The method is best described to users
as "FEM/BEM open-boundary demag, no airbox".

### 4.2 ProblemIR Representation

`RequestedFemDemagIR` already contains:

```text
Bem
FredkinKoehler
Fmm
```

`RequestedFemDemagIR::requires_airbox()` already returns `false` for these
body-only methods. Implementation should stop rejecting `FredkinKoehler` once
the native subsystem is executable and validated for the supported scope.

`ResolvedFemDemagIR::FredkinKoehler` should produce provenance:

```text
fem_fredkin_koehler
```

and the FEM plan should keep `air_box_config = None`.

### 4.3 Planner and Capability-Matrix Impact

Planner requirements:

- `Demag(model="fredkin_koehler")` requires FEM discretization.
- It requires a conforming magnetic-domain mesh with extractable exterior
  boundary faces.
- It must reject FDM, periodic FEM demag, missing mesh topology, and
  non-watertight boundary meshes.
- `auto` should keep resolving to the currently validated Poisson airbox path
  until FEM/BEM passes validation and performance gates.

Capability status should start as `internal-reference`, then become
`public-executable`, and only later `validated` after analytical and
cross-solver benchmarks pass.

## 5. Runtime, Resources, and Provenance Impact

Runtime metadata must include:

- requested demag model: `fredkin_koehler`;
- resolved realization: `fem_fredkin_koehler`;
- boundary node count and boundary triangle count;
- BEM operator mode: `dense_reference`, `h2`, or future `fmm`;
- BEM setup checksum/provenance key based on mesh boundary topology and
  coordinates;
- Neumann solve iterations/residual;
- Dirichlet solve iterations/residual;
- BEM apply count;
- total demag solves for the step;
- phase timings compatible with `diagnostics/solver-profile`.

The control-room status resource must stay thin. Full diagnostic details should
be exposed through existing diagnostics/resources and optional artifacts, not
in `/status`.

## 6. Validation Strategy

### 6.1 Analytical Checks

1. **Constant potential / BEM sanity.**
   Applying the dense boundary operator to `-1` should reproduce Tetmag's H2
   sanity check behavior within tolerance on simple closed surfaces.

2. **Sphere demag.**
   Uniformly magnetized sphere should produce an average internal field close
   to:

```text
H_d = -M / 3
```

and energy close to:

```text
E_d = 0.5 * mu0 * N * integral_Omega_m |M|^2 dV, N = 1/3
```

3. **Ellipsoid or prism comparison.**
   Compare average demag factors against analytical ellipsoid formulas or
   high-resolution reference data.

4. **Energy/field derivative.**
   Perturb magnetization tangentially and verify that the energy derivative is
   consistent with `H_demag` under the Fullmag sign convention.

### 6.2 Cross-Backend Checks

- Compare FEM/BEM against existing FEM Poisson airbox on the same magnetic
  body with increasing airbox padding. FEM/BEM should approach the converged
  open-boundary result without airbox-size drift.
- Compare against FDM Newell tensor demag for simple cuboids after matching
  geometry and magnetization sampling.
- Compare selected small meshes against Tetmag output as an external oracle.
  Tetmag's AGPL code may be invoked as an external executable/reference data
  generator; do not copy its implementation into native Fullmag code.

### 6.3 Regression Tests

- Python/IR: `Demag(model="fredkin_koehler")` serializes and script-export
  round-trips.
- Planner: resolved FEM plan uses `ResolvedFemDemagIR::FredkinKoehler` and
  does not require `air_box_config`.
- Native boundary extraction: closed tetrahedron/cube mesh returns stable
  outward-oriented triangles and boundary-node map.
- Native dense BEM: constant-vector sanity check passes on a tetrahedron and
  cube.
- Native solve: one small sphere/cube fixture produces finite `H_demag`,
  finite `E_demag`, and nonzero profiler subphase timings when profiler is
  enabled.

## 7. Completeness Checklist

- [x] Python API remains canonical and round-trips `Demag(model="fredkin_koehler")`.
- [x] ProblemIR resolves `FredkinKoehler` without airbox.
- [ ] Planner rejects unsupported periodic and malformed-mesh cases.
- [ ] Capability matrix distinguishes internal-reference, public-executable,
  and validated status.
- [x] Native FEM has a dedicated FEM/BEM demag subsystem.
- [x] Dense BEM reference operator passes the local constant unit-tetra contract.
- [ ] Dense BEM reference operator passes sphere/ellipsoid validation fixtures.
- [ ] Production compressed BEM/H2/FMM path has a stable operator interface.
- [ ] Runtime provenance and artifacts identify the method and boundary
  operator mode.
- [ ] Opt-in solver profiler reports FEM/BEM demag subphases.
- [ ] Documentation links this note from the native FEM architecture spec.

## 8. Known Limits and Deferred Work

- Dense BEM is O(Nb^2) and must be treated as validation/reference only.
- H2/FMM library selection is an implementation decision, not a public physics
  choice.
- Periodic open-boundary FEM/BEM demag is deferred.
- Higher-order FE spaces are deferred until native FEM supports `fe_order > 1`
  as a real implementation.
- Multi-material `Ms(x)` is allowed by the weak RHS, but every validation case
  should first use uniform `Ms` before spatial material variation is promoted.

## 9. References

- Tetmag reference implementation:
  - `external_solvers/tetmag/main/DemagField.cpp`
  - `external_solvers/tetmag/preproc/BEMprocessing.cpp`
  - `external_solvers/tetmag/preproc/Lindholm.cpp`
  - `external_solvers/tetmag/main/h2interface.c`
- D. A. Lindholm, "Three-dimensional magnetostatic fields from point-matched
  integral equations with linearly varying scalar source density over a
  triangular domain", IEEE Transactions on Magnetics, 20(5), 2025-2032, 1984.
