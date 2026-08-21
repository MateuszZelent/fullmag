---
title: Magnetoelastic interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-magnetoelastic)=
# Magnetoelastic interaction

The executable subset is cubic $B_1/B_2$ coupling to **prescribed strain**. The current
interaction computes magnetic field and energy from supplied strain; it does not solve
displacement, elastic equilibrium, or elastodynamics.

(physics-magnetoelastic-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-magnetoelastic-governing-equations)=
## Governing equations and strain convention

The public six-component engineering-Voigt order is

```{math}
:label: eq-public-magnetoelastic-mel-voigt
\boldsymbol\varepsilon^{\mathrm{eng}}
=
(\varepsilon_{11},\varepsilon_{22},\varepsilon_{33},
\gamma_{23},\gamma_{13},\gamma_{12}),
\qquad
\gamma_{ij}=2\varepsilon_{ij}.
```

The implemented density is

```{math}
:label: eq-public-magnetoelastic-mel-density
w_{\mathrm{mel}}
=
B_1(\varepsilon_{11}m_1^2+\varepsilon_{22}m_2^2+\varepsilon_{33}m_3^2)
+
2B_2(\varepsilon_{12}m_1m_2+\varepsilon_{13}m_1m_3+\varepsilon_{23}m_2m_3).
```

```{math}
:label: eq-public-magnetoelastic-mel-field
\mathbf H_{\mathrm{mel}}
=
-\frac{1}{\mu_0M_s}
\frac{\partial w_{\mathrm{mel}}}{\partial\mathbf m}.
```

For example,

```{math}
:label: eq-public-magnetoelastic-mel-field-x
H_{\mathrm{mel},1}
=
-\frac{
2B_1\varepsilon_{11}m_1+
2B_2(\varepsilon_{12}m_2+\varepsilon_{13}m_3)}
{\mu_0M_s}.
```

(physics-magnetoelastic-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $B_1,B_2$ | cubic magnetoelastic constants | $\mathrm{Pa}=\mathrm{J\,m^{-3}}$ |
| $\varepsilon_{ij}$ | tensor strain | $1$ |
| $\gamma_{ij}$ | engineering shear strain | $1$ |
| $w_{\mathrm{mel}}$ | coupling energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf H_{\mathrm{mel}}$ | effective field | $\mathrm{A\,m^{-1}}$ |

(physics-magnetoelastic-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | constructors/IR and native field routines | partial; complete public plan rejected | none for full workflow | uniform/per-cell prescribed strain exists below the planner boundary |
| FDM | GPU | constructors/IR and kernel branches | partial | no complete lane qualification | FP32/FP64 source is not end-to-end execution evidence |
| FEM | CPU | prescribed-strain graph | implemented subset | field/energy and mesh tests required | one cubic law and prescribed strain; no mechanics solve |
| FEM | GPU | same prescribed-strain graph | implemented subset | executed-device parity separate | device strain upload and field/energy kernel |

(physics-magnetoelastic-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("magnetoelastic_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# The current stage facade does not yet attach the complete mechanics graph.
elastic = fm.ElasticMaterial(name="substrate_material", C11=1.66e11, C12=6.39e10, C44=7.96e10, rho=2329.0)
substrate_geometry = fm.Box(40 * nm, 20 * nm, 4 * nm, name="substrate_geometry")
substrate = fm.ElasticBody(name="substrate", geometry=substrate_geometry, elastic_material=elastic)
law = fm.MagnetostrictionLaw(name="cubic_b1_b2", kind="cubic", B1=2.4e6, B2=3.1e6)
load = fm.MechanicalLoad(kind="prescribed_strain", strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0))
coupling = fm.Magnetoelastic(magnet="film", body=substrate.name, law=law.name)
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

At the audited revision, the stage-first builder does not expose complete registration methods
for `ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`, and `Magnetoelastic`. Therefore the
following is intentionally an **IR-only construction test**, not a runnable coupled simulation:

Do not surround disconnected objects with a normal run stage and call it a magnetoelastic
example. Publish a complete stage example only after the mechanics graph can be attached and
lowered end to end.

(physics-magnetoelastic-validation)=
## Validation boundary and required code corrections

Current API checks are incomplete:

- `MagnetostrictionLaw.B1`, `B2`, and `lambda_s` are not explicitly finite-validated.
- `MechanicalLoad.strain` and `stress` check length but not all numeric/finite values.
- `ElasticMaterial` currently requires positive $C_{12}$, which is unnecessarily restrictive,
  while it does not enforce the actual cubic stability conditions
  $C_{44}>0$, $C_{11}-C_{12}>0$, and $C_{11}+2C_{12}>0$.

The documentation must distinguish the current API restriction from physical stability, and the
implementation should adopt the stability conditions.

(physics-magnetoelastic-problem-ir)=
## ProblemIR semantics

The canonical term references named graph objects:

```json
{
  "kind": "magnetoelastic",
  "magnet": "magnetic_film",
  "body": "elastic_film",
  "law": "b1b2"
}
```

Prescribed strain, the elastic material, and the law remain separate typed records. Isotropic
`lambda_s` is not silently converted to $B_1/B_2$ without a declared elastic/symmetry model.

## Required numerical validation

- zero field and energy for zero strain;
- pure normal-strain analytic components;
- pure engineering-shear factor-of-two test;
- finite-difference derivative of energy versus field;
- active-mask/nonmagnetic-node exclusion;
- uniform versus per-node/per-cell strain equivalence;
- CPU/GPU comparison at matched integration weights;
- eventual coupled-mechanics energy exchange and convergence tests.

(physics-magnetoelastic-limitations)=
## Limitations and roadmap

Quasistatic elasticity, elastodynamics, two-way magnetostriction, damping, acoustic radiation,
and temperature-dependent elasticity are semantic API intentions, not currently executable
features. Promote them only with a complete graph, time-integration policy, conservation/dissipation
tests, and provenance.

(physics-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

1. E. du Trémolet de Lacheisserie, *Magnetostriction: Theory and Applications of
   Magnetoelasticity*, CRC Press, 1993.
2. A. E. Clark, in *Ferromagnetic Materials*, Vol. 1, North-Holland, 1980.

(physics-magnetoelastic-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `Magnetoelastic` | coupling reference term |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `ElasticMaterial, ElasticBody, MagnetostrictionLaw, MechanicalLoad` | mechanics graph authoring |
| `crates/fullmag-plan/src/fem.rs` | `resolve_fem_magnetoelastic_plan` | FEM prescribed-strain legality |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel/e_mel` | FDM local reference routines |
| `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` | `field/energy` | FEM CPU realization |
| `backends/fem/gpu/cuda/interactions/magnetoelastic` | `upload and kernels` | FEM GPU realization |
| `backends/fdm/gpu/cuda/interactions` | `fused magnetoelastic branches` | partial FDM GPU evidence |

(physics-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-magnetoelastic-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.
