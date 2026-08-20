---
title: Demagnetization — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
target: public_docs/site/physics/interactions/demagnetization/index.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Demagnetization and magnetostatics

## Audit verdict

| Area | Verdict |
|---|---|
| Maxwell equations and energy | Correct for the declared H-field convention. |
| Open-boundary discussion | Technically strong and appropriately distinguishes FDM and FEM methods. |
| Periodic magnetostatics | Present, but the zero-wave-vector convention must be promoted to a first-class user choice. |
| API/status consistency | Inconsistent: public vocabulary and implementation comments do not support one blanket `implemented` claim. |
| Bibliography | Contains a concrete error in the Newell citation. |
| Examples | Need one minimal canonical example and method-specific convergence examples. |

## Required corrections

1. Correct the Newell reference to: A. J. Newell, W. Williams, and D. J. Dunlop,
   “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of
   Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993), DOI
   `10.1029/93JB00694`.
2. Replace legacy `realization="poisson_robin"` authoring with the canonical model/variant form,
   for example `study.demag(model="airbox", variant="robin")`, unless the live API explicitly
   documents the realization alias as a migration surface.
3. Resolve the discrepancy between public BEM/FMM capability claims and code comments that mark
   some models as future vocabulary. Unsupported methods must fail closed and appear as
   `semantic_only` or `unsupported`.
4. Keep the method pages, but shorten the root page to a method-selection guide. Do not duplicate
   full derivations and giant IR records on the root.
5. State the periodic `k = 0` convention and macroscopic sample-shape assumption explicitly in
   requested intent and provenance.

## Proposed canonical physical content

In the absence of free currents, the magnetostatic field satisfies

```math
\nabla\times H_d = 0,
\qquad
\nabla\cdot(H_d + M) = 0.
```

Writing `H_d = -grad(phi)` gives

```math
\nabla^2\phi = \nabla\cdot M
```

inside the magnetic material and Laplace's equation outside. At a material/vacuum interface with
normal `n`, the physical transmission conditions are

```math
[\phi] = 0,
\qquad
[\partial_n\phi] = M\cdot n,
```

where the jump orientation must be fixed once and used consistently by the weak form and source
maps.

The demagnetization energy is

```math
E_d = -\frac{\mu_0}{2}\int_{\Omega_m} M\cdot H_d\,dV
    =  \frac{\mu_0}{2}\int_{\mathbb R^3}|H_d|^2\,dV \ge 0
```

for the open-boundary problem under the stated decay convention.

## Method-selection contract

### FDM open boundary

The recommended structured-grid method is a cell-integrated demagnetizing tensor convolved by
FFT. Documentation must distinguish:

- cell-integrated Newell tensor versus point-dipole approximation;
- exact padding/circulant embedding convention;
- active-cell mask and nonmagnetic padding;
- self term and near-field accuracy;
- precision and reduction path;
- periodic-axis handling.

### FEM open boundary

Each family has a distinct mathematical contract:

- **airbox Dirichlet/Robin:** volumetric exterior truncation, explicit airbox geometry, boundary
  condition, and convergence with airbox size;
- **Fredkin–Koehler:** interior Poisson solve plus boundary integral correction;
- **BEM coupling:** explicit trace space, dense/compressed boundary operator, singular quadrature,
  and preconditioner;
- **FMM acceleration:** approximation order, admissibility, error control, and reproducibility.

A method name in Python or IR is not proof that all four execution lanes exist.

### Periodic magnetostatics

For periodic axes, the `k = 0` component is not determined by the local periodic Maxwell problem
alone. The public contract must record the selected convention, for example:

- zero mean demagnetizing field;
- prescribed macroscopic demagnetizing tensor;
- slab/wire correction;
- fully open direction plus periodic transverse directions.

Silent zero-mode choices make energies from different solvers incomparable.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `M` | magnetization | A/m |
| `H_d` | demagnetizing field | A/m |
| `B` | magnetic flux density | T |
| `phi` | scalar magnetic potential | A |
| `mu0` | vacuum permeability | H/m |
| `E_d` | demagnetization energy | J |
| `n` | oriented interface unit normal | 1 |

## Recommended capability matrix

| Solver | Device | Public status rule |
|---|---|---|
| FDM | CPU | Name the exact tensor, padding, PBC, and precision realization. |
| FDM | GPU | Require executed-device convolution and reduction evidence; no host fallback under strict mode. |
| FEM | CPU | Report each airbox/FK/BEM/FMM method separately. |
| FEM | GPU | Report only device-resident methods actually executed and qualified. |

The root page should render this matrix from one capability source rather than copying status text
from several planners and implementation notes.

## Stage-first authoring example

```python
# %% Canonical FEM airbox request
import fullmag as fm

nm = 1.0e-9
study = fm.study("demag_airbox_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(3 * nm, 3 * nm, 2 * nm))

sample = study.geometry(fm.Box(60 * nm, 30 * nm, 6 * nm), name="sample")
sample.Ms = 800.0e3
sample.Aex = 13.0e-12
sample.alpha = 0.5
sample.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=20_000,
    tolT=1.0e-6,
)
```

This block must be executed by documentation CI and its serialized demagnetization request compared
with the current `ProblemIR` schema. A separate native fixture must prove that the requested method
is accepted for FEM/CPU/double/strict.

## Required validation suite

1. **Uniform ellipsoid:** compare the volume-averaged field with analytic demagnetizing factors and
   verify `N_x + N_y + N_z = 1`.
2. **Rectangular prism:** compare cell-centred fields with a trusted analytic/reference solution.
3. **Energy identity:** compare `-mu0/2 int M·H_d` with field-energy evaluation where available.
4. **Symmetry:** field and energy must transform correctly under rotations/reflections supported by
   the mesh.
5. **FDM refinement:** separate discretization error from FFT padding error.
6. **Airbox convergence:** vary exterior extent, boundary order, and mesh grading.
7. **FK/BEM:** verify singular quadrature and boundary-trace convergence.
8. **Periodic zero mode:** test the exact documented macroscopic convention.
9. **CPU/GPU:** compare field, energy, and residual—not only final relaxed magnetization.
10. **Multi-body geometry:** verify vacuum coupling and absence of artificial exchange across gaps.

## Recommended extensions

- a method advisor based on geometry, periodicity, requested accuracy, memory, and target device;
- explicit macroscopic-shape objects for periodic zero-mode control;
- field-error estimators and airbox-convergence automation;
- downloadable standard problems for ellipsoid, prism, thin film, periodic film, and separated bodies.

## Bibliography

- W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
- A. J. Newell, W. Williams, and D. J. Dunlop, *J. Geophys. Res. Solid Earth* **98**,
  9551–9555 (1993), DOI `10.1029/93JB00694`.
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,”
  *IEEE Transactions on Magnetics* **26** (1990).
- A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
