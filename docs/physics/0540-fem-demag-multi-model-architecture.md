# FEM demagnetization: multi-model architecture

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-04-16
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`

## 1. Problem statement

The dipolar self-interaction (demagnetization) in FEM micromagnetics can be realized through
fundamentally different physical approaches. These approaches differ in:

- how the open-boundary condition at infinity is handled,
- whether the computational domain includes non-magnetic air regions,
- what mesh topology is required,
- computational cost and accuracy trade-offs.

Fullmag must provide an architecture where the **user selects a demag model** and the system
derives the correct mesh, solver, and boundary requirements from that choice. The physical
problem definition must remain the same across all models — only the numerical realization
differs.

### 1.1 Known approaches

| Model | Representative solver | Open-boundary strategy | Requires air mesh? |
|---|---|---|---|
| **Airbox** (Poisson + finite domain) | COMSOL, Fullmag current | Truncated domain with Dirichlet or Robin BC | **Yes** — shared-domain mesh with universe/air elements |
| **BEM** (Boundary Element Method) | tetmag | H²-matrix / boundary integral on magnetic surface | **No** — only body mesh + boundary faces |
| **Fredkin–Koehler** (FEM/BEM hybrid) | TetraX | Plane-wave extension of Fredkin–Koehler | **No** — only body mesh + boundary faces |
| **FMM** (Fast Multipole Method) | Research codes | Multipole expansion for far-field | **No** — only body mesh |
| **Shell transform** (mapped exterior) | Some COMSOL extensions | Coordinate mapping to infinity | **Yes** — but exterior is mapped, not truncated |

### 1.2 Current state

Fullmag currently implements only the **airbox** model with two boundary condition variants:

- `PoissonDirichlet`: $u = 0$ on the outer air-box boundary
- `PoissonRobin`: $\partial u / \partial n + \beta u = 0$ on the outer air-box boundary

Both require a shared-domain mesh that includes magnetic regions and an air-box region.

## 2. Physical model

All demag models solve the same underlying physics.

### 2.1 Governing equations

The dipolar self-interaction is described by magnetostatics in the absence of free current:

$$
\nabla \times \mathbf{H}_d = 0, \quad
\nabla \cdot \mathbf{B} = 0, \quad
\mathbf{B} = \mu_0 (\mathbf{H}_d + \mathbf{M})
$$

Introducing a scalar potential $u$ with $\mathbf{H}_d = -\nabla u$:

$$
\Delta u = \nabla \cdot \mathbf{M} \quad \text{in } \mathbb{R}^3, \qquad
u(\mathbf{x}) \to 0 \text{ as } |\mathbf{x}| \to \infty
$$

The magnetostatic energy is:

$$
E_d = -\frac{\mu_0}{2} \int_{\Omega_m} \mathbf{M} \cdot \mathbf{H}_d \, dV
$$

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{M}$ | Magnetization | A/m |
| $M_s$ | Saturation magnetization | A/m |
| $\mathbf{m}$ | Reduced magnetization ($\|\mathbf{m}\| = 1$) | dimensionless |
| $u$ | Scalar magnetic potential | A |
| $\mathbf{H}_d$ | Demagnetizing field | A/m |
| $E_d$ | Demagnetizing energy | J |
| $\mu_0$ | Vacuum permeability | H/m |
| $\beta$ | Robin parameter | 1/m |

### 2.3 Assumptions and approximations

All models assume:
- Quasi-static magnetostatics (no retardation effects)
- Linear constitutive relation $\mathbf{B} = \mu_0(\mathbf{H} + \mathbf{M})$
- $M_s$ is spatially varying but the reduced magnetization constraint $\|\mathbf{m}\| = 1$ holds

Model-specific approximations:

**Airbox**:
- Open boundary approximated by a finite air-box domain
- Dirichlet: $u = 0$ on outer boundary (zeroth-order approximation)
- Robin: $\partial u / \partial n + \beta u = 0$ (first-order dipole approximation)
- Accuracy depends on air-box size, shape, and grading

**BEM**:
- Exact open-boundary via boundary integral on magnetic surface
- No truncation error from finite domain
- Dense or H²-compressed boundary operator

**Fredkin–Koehler**:
- FEM/BEM hybrid: volume FEM on magnetic region, boundary integral for coupling
- Plane-wave extension avoids meshing non-magnetic spacers in multilayers

**FMM**:
- Multipole expansion of far-field interactions
- Tunable accuracy via expansion order

## 3. Numerical interpretation

### 3.1 FDM

FDM uses FFT-based Newell tensor convolution — a fundamentally different realization.
This note does not change FDM demag. The `model=` vocabulary is FEM-specific for now.

### 3.2 FEM

The key architectural insight: **the demag model choice determines mesh requirements**.

| Model | Mesh topology | Universe/air-box | Boundary faces |
|---|---|---|---|
| Airbox | Shared-domain mesh (magnetic + air) | Required | On outer air-box surface |
| BEM | Body-only mesh | Not required | On magnetic body surface |
| Fredkin–Koehler | Body-only mesh | Not required | On magnetic body surface |
| FMM | Body-only mesh | Not required | Not strictly required |

This means the planner must:
1. Read the requested demag model
2. Determine mesh requirements from the model
3. Validate that the mesh workflow produces the required mesh topology
4. Route to the correct solver initialization

### 3.3 Hybrid

Future: possible combination of airbox for near-field and FMM for far-field.
Not in scope for this architecture phase.

## 4. API, IR, and planner impact

### 4.1 Python API surface

New canonical API:

```python
# Demag model selection
Demag(model="airbox")                       # default, COMSOL-style
Demag(model="airbox", variant="robin")      # explicit Robin BC
Demag(model="airbox", variant="dirichlet")  # explicit Dirichlet BC
Demag(model="bem")                          # future: tetmag-style BEM
Demag(model="fredkin_koehler")              # future: TetraX-style
Demag(model="fmm")                          # future: fast multipole

# Study builder
study.demag(model="airbox")
study.demag(model="airbox", variant="robin")

# Legacy (deprecated, still accepted):
study.demag(realization="poisson_robin")    # maps to model="airbox", variant="robin"
```

### 4.2 ProblemIR representation

```
RequestedFemDemagIR:
  Auto                              → planner resolves
  Airbox { variant: AirboxVariant } → requires shared-domain mesh
  Bem                               → body-only mesh
  FredkinKoehler                    → body-only mesh
  Fmm                               → body-only mesh

AirboxVariant:
  Auto       → defaults to Robin
  Dirichlet
  Robin

ResolvedFemDemagIR:
  AirboxDirichlet
  AirboxRobin
  Bem                               → future
  FredkinKoehler                    → future
  Fmm                               → future
```

### 4.3 Planner and capability-matrix impact

The planner must:

1. **Resolve `Auto`** → `Airbox { Robin }` (current default)
2. **Check mesh requirements** based on resolved model:
   - Airbox → require `shared_domain_mesh_with_air`, validate air elements exist
   - BEM/FK/FMM → require only body mesh, validate boundary faces exist
3. **Reject unimplemented models** with clear error:
   `"Demag model 'bem' is not yet implemented. Currently supported: airbox."`
4. **Build `AirBoxConfigIR`** only when model is Airbox
5. **Carry the resolved model** through to runner and provenance

Each resolved variant declares capabilities:
- `requires_airbox() -> bool`
- `requires_boundary_mesh() -> bool`
- `provenance_name() -> &str`
- `is_implemented() -> bool`

## 5. Validation strategy

### 5.1 Analytical checks

For the airbox model (currently implemented):
- Uniformly magnetized sphere: $N = 1/3$, convergence with mesh and airbox size
- Ellipsoids: known demagnetization factors
- Airbox convergence sweep: Dirichlet and Robin must converge to the same limit

### 5.2 Cross-backend checks

When BEM/FK are implemented:
- Same geometry, same $\mathbf{M}$ → same $\mathbf{H}_d$ within tolerance
- Energy agreement across models
- Airbox results must approach BEM/FK results as airbox grows

### 5.3 Regression tests

- `Demag(model="airbox")` produces identical results to current `Demag(realization="poisson_robin")`
- Legacy `realization=` API still works and maps correctly
- Unimplemented models rejected with clear error
- Round-trip: Python → IR → script export preserves model choice

## 6. Completeness checklist

- [x] Physics equations (same for all models)
- [x] Python API design (model= vocabulary)
- [x] ProblemIR types (RequestedFemDemagIR, ResolvedFemDemagIR extended)
- [x] Planner mesh-routing logic
- [x] Capability declarations per model
- [ ] Airbox Dirichlet backend — implemented
- [ ] Airbox Robin backend — implemented
- [ ] BEM backend — architecture only, not implemented
- [ ] Fredkin–Koehler backend — architecture only, not implemented
- [ ] FMM backend — architecture only, not implemented
- [ ] Cross-model validation
- [ ] Documentation updated

## 7. Known limits and deferred work

### Current airbox correctness blockers (Phase 0)

1. **Robin energy inconsistency with `field_refresh`**: When demag is cached,
   the Robin boundary energy term is not added to `E_demag`. This is a correctness bug.
2. **MFEM device classification**: Any device string ≠ `"cpu"` is treated as GPU,
   breaking `omp` and `ceed-cpu` host backends.
3. **P1-only constraint**: Native backend expects P1 elements but doesn't explicitly
   reject higher order at the planner level.
4. **Stale naming**: Backend names reference `cuda` even on CPU.

### Deferred

- BEM implementation (tetmag-style H²-matrix)
- Fredkin–Koehler implementation (TetraX-style)
- FMM implementation
- Shell transformation (mapped exterior)
- Higher-order FEM (P2+)
- Heterogeneous material validation for multi-model
- HPC distributed-memory Poisson
- AMG parameter tuning matrix

## 8. References

1. Fredkin, D.R. and Koehler, T.R. (1990). "Hybrid method for computing demagnetizing fields."
   IEEE Trans. Magn., 26(2), 415–417.
2. Abert, C. et al. (2013). "A fast finite-element micromagnetic solver based on the
   nonequidistant fast Fourier transform." J. Magn. Magn. Mater., 345, 29–35. (tetmag)
3. Körber, L. et al. (2022). "TetraX: Finite-Element Micromagnetic-Modeling Package."
   AIP Advances, 12(11), 115213.
4. COMSOL Multiphysics, AC/DC Module documentation (scalar magnetic potential formulation).
5. Fudan Micromagnetics Module for COMSOL (user manual).
