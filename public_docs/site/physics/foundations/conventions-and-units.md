---
title: Conventions and units
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
source_of_truth: packages/fullmag-py/src/fullmag/model/dynamics.py and crates/fullmag-ir/src/lib.rs
---

(public-docs-physics-foundations-conventions-and-units)=
(foundation-conventions-problem-statement)=
# Conventions and units

Fullmag's public authoring layer uses SI-valued quantities and lowers them into one typed
ProblemIR. This page defines shared symbols and units; interaction-specific parameters and
equations remain on their canonical interaction pages.

(foundation-conventions-governing-equations)=
## Governing equations

```{math}
:label: eq-foundation-reduced-magnetization
\mathbf{m}(\mathbf{x},t)=\frac{\mathbf{M}(\mathbf{x},t)}{M_s(\mathbf{x})},
\qquad |\mathbf{m}(\mathbf{x},t)|=1.
```

```{math}
:label: eq-foundation-energy-field
\delta E_k[\mathbf{m};\boldsymbol{\eta}]
=-\mu_0\int_{\Omega_m}M_s\,\mathbf{H}_k\cdot\boldsymbol{\eta}\,\mathrm{d}V.
```

```{math}
:label: eq-foundation-gamma
\gamma_{\mu_0}=\mu_0|\gamma_e|\approx2.211\times10^5\;\mathrm{m\,(A\,s)^{-1}}.
```

(foundation-conventions-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{M}$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\mathbf{H}_k$ | effective field contribution of term k | $\mathrm{A\,m^{-1}}$ |
| $E_k$ | energy contribution of term k | $\mathrm{J}$ |
| $\boldsymbol{\eta}$ | tangent magnetization variation | $1$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |

(foundation-conventions-assumptions-and-validity)=
## Assumptions and validity

Coordinates and mesh lengths are metres. Fields at the solver boundary are A/m; a
user-facing induction in tesla is converted by its owning API. Dimensionless quantities use
unit 1. Magnetic normalization applies only to magnetic degrees of freedom. FDM weighting,
FEM quadrature, mass projection, precision, and memory placement are realization-specific.

(foundation-conventions-python-api)=
## Python API

This foundation owns no interaction constructor. The shared authoring entry point is
fullmag.study; StudyBuilder.engine, StudyBuilder.device, StudyBuilder.mode, and the stage
builder configure requested execution.

```python
# %%
import fullmag as fm

nm = 1.0e-9
study = fm.study("units_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    dt=5.0e-13,
    max_steps=1,
)
```

The example supplies a complete minimal geometry, material, mesh, and magnetization state.

| Python entry point | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| fm.study(problem_name) | callable | None | $1$ | problem_name is None or a valid name accepted by study | creates the stage-first authoring builder | public authoring surface; runtime is lane-specific | problem_meta and captured study state |

(foundation-conventions-problem-ir)=
## ProblemIR

ProblemIR is the typed container in crates/fullmag-ir/src/lib.rs. Lowering preserves SI
intent in materials, magnets, energy_terms, study, and backend_policy; the planner records
resolved execution and provenance. The complete serialized object is produced by repository
lowering rather than a hand-written fixture.

(foundation-conventions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent contains authored values and requested engine, device, and mode. Resolved
execution contains selected lane, precision, discretization, and capability decision.
Validation errors reject non-finite or contradictory values. Unsupported combinations fail
closed; no backend silently changes units or interaction type.

(foundation-conventions-discrete-realization)=
## Discrete realization

| Lane | Representation | Status |
|---|---|---|
| FDM CPU | structured cells and cell-weighted fields | partial; qualification is separate |
| FDM GPU | structured cells and device fields | partial; device and precision evidence are required |
| FEM CPU | unstructured mesh degrees of freedom and FEM weights | partial; quadrature is lane-specific |
| FEM GPU | unstructured mesh state and device kernels | partial; compilation is not runtime qualification |

(foundation-conventions-implementation-mapping)=
## Implementation mapping

fullmag.study owns stage-first authoring, LLG owns dynamics-unit validation, and ProblemIR
owns the canonical typed container. Physical interaction claims are mapped on owner pages.

(foundation-conventions-validation)=
## Validation

The adjacent source map is checked against the current source tree by
validate_scientific_docs.py. The Python example is parsed by the public-example guard. These
checks establish provenance and parsing, not numerical equivalence or GPU parity.

(foundation-conventions-limitations)=
## Limitations

This page does not certify a solver lane, material model, or numerical error bound. It does
not own conversion policy for an individual interaction.

(foundation-conventions-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, 1963.
   [WorldCat record](https://search.worldcat.org/title/536451).
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(foundation-conventions-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| LLG units and IR | packages/fullmag-py/src/fullmag/model/dynamics.py | class LLG | validates gamma and serializes dynamics | all authoring lanes | source-backed |
| study authoring | packages/fullmag-py/src/fullmag/world.py | study | creates the public builder | all authoring lanes | source-backed |
| canonical container | crates/fullmag-ir/src/lib.rs | ProblemIR | stores normalized problem intent | all lanes | source-backed |
