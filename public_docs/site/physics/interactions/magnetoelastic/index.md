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

Cubic magnetoelasticity couples magnetization $\mathbf{m}$ to local mechanical strain
$\boldsymbol{\varepsilon}^{\mathrm{eng}}$ through coefficients $B_1$ and $B_2$. In the current
prescribed-strain realization, strain is an input field rather than a coupled elastodynamic unknown.

```{figure} /_static/diagrams/magnetoelastic-voigt-strain-coupling.svg
:alt: Two-panel diagram of magnetoelastic coupling in Fullmag: Panel (a) maps the symmetric 3x3 strain tensor to the 6-component engineering-Voigt vector (epsilon_11, epsilon_22, epsilon_33, gamma_23, gamma_13, gamma_12), highlighting the factor of 2 in engineering shear gamma_ij = 2 epsilon_ij and the resulting B_1/B_2 energy density and field; Panel (b) maps the Fullmag mechanics object graph and separates the executable FEM prescribed-strain subset from fail-closed FDM and coupled-mechanics roadmaps.
:width: 100%
:name: fig-magnetoelastic-voigt-strain-coupling
:figclass: fm-physics-figure

Engineering-Voigt strain convention and Fullmag magnetoelastic object-graph boundaries. Panel (a)
shows the tensor-to-Voigt mapping where normal strains couple through $B_1$ and engineering shear
strains $\gamma_{ij}=2\varepsilon_{ij}$ are halved in the kernel to recover tensor shear
$\varepsilon_{ij}$ in $2B_2\varepsilon_{ij}m_im_j$ (compare Kittel 1949; Vanderveken *et al.*
2021). Panel (b) shows `ElasticMaterial`, `ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`,
and `Magnetoelastic`, isolating the executable FEM CPU/GPU prescribed-strain subset from
semantic-only isotropic laws, FDM public plans, and coupled elasticity/elastodynamics solvers
(Vanderveken *et al.* 2021; Flauger *et al.* 2026).
```

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

(physics-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum small-strain, cubic symmetry,
prescribed-strain, and backend capability limits stated on this page. `H_mel` divides by the
local saturation magnetization $M_{s,i}$, nonmagnetic nodes contribute zero field and energy, and
no displacement PDE or back-action stress solve is performed in the current executable subset.

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

# %% Mechanics graph constructors (IR authoring boundary; stage facade not yet attached)
elastic = fm.ElasticMaterial(name="substrate_material", C11=1.66e11, C12=6.39e10, C44=7.96e10, rho=2329.0)
substrate_geometry = fm.Box(40 * nm, 20 * nm, 4 * nm, name="substrate_geometry")
substrate = fm.ElasticBody(name="substrate", geometry=substrate_geometry, elastic_material=elastic)
law = fm.MagnetostrictionLaw(name="cubic_b1_b2", kind="cubic", B1=2.4e6, B2=3.1e6)
load = fm.MechanicalLoad(kind="prescribed_strain", strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0))
coupling = fm.Magnetoelastic(magnet="film", body=substrate.name, law=law.name)
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

The stage-first builder currently does not expose direct stage-registration methods for
`ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`, and `Magnetoelastic`; the block above
therefore illustrates the standalone object-construction and `ProblemIR` authoring boundary rather
than an end-to-end coupled stage run. For exact constructor arguments on `fm.Magnetoelastic`, see
{doc}`/python-api/interactions/magnetoelastic`.

(physics-magnetoelastic-validation)=
## Validation boundary

- `MagnetostrictionLaw.B1`, `B2`, and `lambda_s` are validated for finiteness downstream at the
  `ProblemIR`/planner boundary rather than at Python construction.
- `MechanicalLoad.strain` and `stress` verify vector length at construction and check finite values
  during IR/planner validation.
- `ElasticMaterial` enforces positive $C_{12}$ at construction rather than the full cubic elastic
  stability inequalities $C_{44}>0$, $C_{11}-C_{12}>0$, and $C_{11}+2C_{12}>0$.

(physics-magnetoelastic-problem-ir)=
## ProblemIR semantics

The canonical term references named graph objects (`to_ir()` of `coupling` above):

```json
{
  "kind": "magnetoelastic",
  "magnet": "film",
  "body": "substrate",
  "law": "cubic_b1_b2"
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

(physics-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored `Magnetoelastic` link names (`magnet`, `body`, `law`),
`ElasticMaterial` constants, `ElasticBody` reference, `MagnetostrictionLaw` kind/coefficients,
`MechanicalLoad` engineering-Voigt vector, and execution request. Resolved execution records the
selected FEM CPU or GPU prescribed-strain plan (`FemMagnetoelasticPlanIR`, `FemMechanicalPlanIR`),
precision, and capability decision. Validation errors reject missing links, duplicate
`Magnetoelastic` terms, invalid Voigt vector lengths, or non-positive elastic parameters before
runtime. Unsupported combinations (such as isotropic `lambda_s`, `QuasistaticElasticity`,
`Elastodynamics`, `prescribed_stress` / `body_force`, or full public FDM plans) fail closed and
are never silently converted into another law or omitted.

(physics-magnetoelastic-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization (`packages/fullmag-py/src/fullmag/model/energy.py`,
`mechanics.py`), `ProblemIR` owns canonical intent (`crates/fullmag-ir/src/mechanics.rs`,
`study.rs`), `crates/fullmag-plan/src/fem.rs` (`resolve_fem_magnetoelastic_plan`) owns prescribed-strain
legality, and native FEM CPU/CUDA kernels own Voigt shear halving, local $M_{s,i}$ scaling, and
lumped-mass energy integration. Control Room support for magnetoelastic authoring is tracked in
{doc}`/frontend/capability-register`; parameters without a UI control are configured in Python.

(physics-magnetoelastic-limitations)=
## Limitations

Quasistatic elasticity, elastodynamics, two-way magnetostriction, mechanical damping, acoustic
radiation, and temperature-dependent elasticity are represented in schema vocabulary only and are
not currently executable features.

(physics-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

1. C. Kittel, "Physical Theory of Ferromagnetic Domains," *Reviews of Modern Physics* **21**(4),
   541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
2. F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos,
   F. Ciubotaru, and C. Adelmann, "Finite difference magnetoelastic simulator," *Open Research
   Europe* **1**, 35 (2021),
   [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1)
   (Gold OA CC-BY; [EuropePMC PMC10445870](https://europepmc.org/articles/PMC10445870)).
3. F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos,
   F. Ciubotaru, and C. Adelmann, "Confined magnetoelastic waves in thin waveguides," *Physical
   Review B* **103**(5), 054439 (2021),
   [doi:10.1103/PhysRevB.103.054439](https://doi.org/10.1103/PhysRevB.103.054439)
   ([arXiv:2011.10326 OA](https://arxiv.org/abs/2011.10326)).
4. P. Flauger, M. Küß, M. K. Steinbauer, F. Bruckner, B. Emhofer, E. Nysten, M. Weiß,
   D. Suess, H. J. Krenner, M. Albrecht, and C. Abert, "Modeling magnetoelastic wave interactions
   in magnetic films and heterostructures: A finite-difference approach," *Physical Review
   Applied* **25**(3) (2026), [doi:10.1103/9txq-sc8f](https://doi.org/10.1103/9txq-sc8f)
   (Hybrid OA CC-BY; [arXiv:2509.06007](https://arxiv.org/abs/2509.06007)).
5. E. du Trémolet de Lacheisserie, *Magnetostriction: Theory and Applications of
   Magnetoelasticity*, CRC Press, 1993.
6. A. E. Clark, "Magnetostrictive Rare Earth-Fe2 Compounds," in *Ferromagnetic Materials*, Vol. 1,
   North-Holland, 1980.

(physics-magnetoelastic-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | coupling reference term |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `ElasticMaterial, ElasticBody, MagnetostrictionLaw, MechanicalLoad` | mechanics graph authoring |
| `crates/fullmag-plan/src/fem.rs` | `resolve_fem_magnetoelastic_plan` | FEM prescribed-strain legality |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel/e_mel` | FDM local reference routines |
| `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` | `field/energy` | FEM CPU realization |
| `backends/fem/gpu/cuda/interactions/magnetoelastic` | `upload and kernels` | FEM GPU realization |
| `backends/fdm/gpu/cuda/interactions` | `fused magnetoelastic branches` | partial FDM GPU evidence |
