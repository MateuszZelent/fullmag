---
title: Dzyaloshinskii–Moriya interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-dmi-root)=
# Dzyaloshinskii–Moriya interaction

Fullmag distinguishes interfacial and bulk Dzyaloshinskii–Moriya interaction (DMI). They have
different symmetry, field operators, natural boundary terms, and backend restrictions.

```{toctree}
:maxdepth: 1

interfacial
bulk
boundary-conditions
validation
```

(physics-dmi-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-dmi-governing-equations)=
## Governing equations

For a constant oriented interface normal $\hat{\mathbf n}$, the interfacial density is

```{math}
:label: eq-public-dmi-dmi-interfacial-energy
w_{\mathrm i}
=
D_{\mathrm i}
\left[
(\hat{\mathbf n}\cdot\mathbf m)\nabla\cdot\mathbf m
-
\mathbf m\cdot\nabla(\hat{\mathbf n}\cdot\mathbf m)
\right].
```

Its bulk field is

```{math}
:label: eq-public-dmi-dmi-interfacial-field
\mathbf H_{\mathrm i}
=
\frac{2D_{\mathrm i}}{\mu_0M_s}
\left[
\nabla(\hat{\mathbf n}\cdot\mathbf m)
-
\hat{\mathbf n}\,\nabla\cdot\mathbf m
\right].
```

For the canonical $\hat{\mathbf n}=\hat{\mathbf z}$ thin-film case this gives
$(2D_{\mathrm i}/\mu_0M_s)
(\partial_xm_z,\partial_ym_z,-\partial_xm_x-\partial_ym_y)$.

Bulk DMI uses

```{math}
:label: eq-public-dmi-dmi-bulk-energy
w_{\mathrm b}=D_{\mathrm b}\,\mathbf m\cdot(\nabla\times\mathbf m),
```

```{math}
:label: eq-public-dmi-dmi-bulk-field
\mathbf H_{\mathrm b}
=
-\frac{2D_{\mathrm b}}{\mu_0M_s}\nabla\times\mathbf m .
```

The sign of $D$, the interface-normal orientation, and the coordinate handedness jointly
determine chirality. None may be silently changed during normalization.

(physics-dmi-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $D_{\mathrm i},D_{\mathrm b}$ | interfacial and bulk DMI coefficients | $\mathrm{J\,m^{-2}}$ |
| $\hat{\mathbf n}$ | oriented interface normal | $1$ |
| $w_{\mathrm i},w_{\mathrm b}$ | energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf H_{\mathrm i},\mathbf H_{\mathrm b}$ | DMI effective field | $\mathrm{A\,m^{-1}}$ |

(physics-dmi-assumptions-and-validity)=
## Boundary conditions and validity

For an open boundary, exchange and DMI must be varied together; applying a pure Neumann
exchange condition while retaining DMI generally loses the chiral boundary twist. Periodic
boundaries remove that exterior surface term but require consistent periodic neighbor mapping.

The FDM interfacial path is restricted to the canonical $+\hat{\mathbf z}$ normal. FEM may
represent a general finite non-zero normal. Bulk-DMI FDM support is subject to the planner's
periodicity and topology restrictions. Spatial coefficient fields must match the realized mesh.

(physics-dmi-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | explicit/material coefficient | reference executable | bounded stencil tests | interfacial normal fixed to +z; topology restrictions apply |
| FDM | GPU | same canonical intent | implemented | device parity workload-specific | FP32/FP64 kernels and separate energy reduction |
| FEM | CPU | scalar/spatial material routes | implemented | weak-form and mesh convergence required | general oriented interfacial normal |
| FEM | GPU | same resolved FEM IR | implemented | executed-device qualification separate | resident residual, projection, and reduction |

(physics-dmi-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("interfacial_dmi_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

body.Ku1 = 4.7e5
body.anisU = (0.0, 0.0, 1.0)
body.dind = 3.0e-3  # J/m^2
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=500, tolT=1.0e-6)
```

The study facade already supports material-owned interfacial DMI. It must not be documented as
unregisterable.



Explicit constructors remain useful for IR tests:

(physics-dmi-problem-ir)=
## ProblemIR and coefficient ownership

```json
{
  "kind": "interfacial_dmi",
  "D": 0.003,
  "interface_normal": [0.0, 0.0, 1.0]
}
```

Material-owned and explicit routes are alternative coefficient sources; they must not be
silently added. Resolved execution records normalized normal, scalar versus spatial coefficient,
mesh, boundary policy, solver, device, and precision.

(physics-dmi-validation)=
## Validation boundary and required code corrections

`InterfacialDMI.__init__` currently checks vector length/conversion but not finite values or
non-zero norm. Those checks occur later and should either be documented there or moved into the
constructor. The `Material.Dbulk` warning and public coefficient contract use
$\mathrm{J\,m^{-2}}$.

## Required numerical validation

- one-dimensional cycloid/helix with the expected wave vector and chirality;
- sign reversal under $D\to-D$;
- interfacial normal reversal with an explicitly defined convention;
- exchange+DMI natural-boundary twist;
- finite-difference energy/field consistency;
- periodic translation invariance for bulk DMI;
- mesh refinement and matched CPU/GPU comparisons;
- skyrmion/domain-wall benchmarks that state all sign conventions.

(physics-dmi-limitations)=
## Limitations and recommended extensions

FDM support for arbitrary interface normals, curved local normals, interface-local DMI, and
heterogeneous tensor DMI requires new typed operators. Do not approximate these by rotating only
the magnetization while leaving the grid stencil unchanged.

(physics-dmi-scientific-bibliography)=
## Scientific bibliography

1. A. Fert, V. Cros, and J. Sampaio, *Nature Nanotechnology* **8**, 152–156 (2013).
2. S. Rohart and A. Thiaville, *Physical Review B* **88**, 184422 (2013),
   DOI: 10.1103/PhysRevB.88.184422.
3. A. N. Bogdanov and D. A. Yablonskii, *Soviet Physics JETP* **68**, 101 (1989).

(physics-dmi-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-dmi-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `InterfacialDMI, BulkDMI` | explicit authoring |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `Material.Dind/Dbulk` | canonical material coefficients |
| `packages/fullmag-py/src/fullmag/world.py` | `geometry material facade` | stage-first `dind` authoring |
| `crates/fullmag-plan/src/fdm.rs` | `DMI planning` | FDM normal, topology, and field resolution |
| `crates/fullmag-plan/src/fem.rs` | `DMI planning` | FEM coefficient/normal resolution |
| `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp` | `interfacial DMI` | FEM CPU weak residual |
| `backends/fem/cpu/mfem/interactions` | `bulk DMI` | FEM CPU bulk operator |
| `backends/fdm/gpu/cuda/interactions` | `DMI kernels` | FDM GPU realization |
| `backends/fem/gpu/cuda/interactions` | `DMI kernels` | FEM GPU realization |

(physics-dmi-round-trip-and-failure-semantics)=
