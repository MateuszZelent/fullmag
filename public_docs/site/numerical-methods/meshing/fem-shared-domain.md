---
title: FEM Shared Domain
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/fem-shared-domain.md
---

(public-docs-numerical-methods-meshing-fem-shared-domain)=
# FEM shared-domain mesh

(numerical-methods-fem-shared-domain-problem-statement)=
## Physical and numerical problem

FEM solves on one conforming shared-domain mesh assembled from the universe and all magnetic
objects. Universe mesh policy, per-object mesh policy, and the final solver mesh are three
distinct semantic layers that must not collapse into one anonymous blob.

(numerical-methods-fem-shared-domain-governing-equations)=
## Governing equations

The solver does not introduce a new equation; it consumes the conforming mesh produced by the
assembly. Environment/universe and object/interface semantics are documented in
{doc}`../../physics/foundations/index` and the meshing family.

(numerical-methods-fem-shared-domain-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $V_{\mathrm{uni}}$ | universe mesh region | $\mathrm{m^3}$ |
| $V_{\mathrm{obj}}$ | object mesh region | $\mathrm{m^3}$ |
| $\Gamma_{\mathrm{int}}$ | object interface | $\mathrm{m^2}$ |
| $h$ | element size | $\mathrm{m}$ |

(numerical-methods-fem-shared-domain-assumptions-and-validity)=
## Assumptions and validity

The final solve consumes one conforming mesh. Per-object controls stay first-class, air meshing
can be coarser than interfacial meshing, and interface/transition refinement are solver semantics,
not viewport tricks.

(numerical-methods-fem-shared-domain-python-api)=
## Python API

```python
# %% Universe + per-object policy assemble into one conforming mesh
import fullmag as fm

nm = 1.0e-9

study = fm.study("shared_domain_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1200 * nm, 600 * nm, 550 * nm))
study.universe.mesh(minimum_element_size=10 * nm, maximum_element_size=110 * nm, maximum_element_growth_rate=1.9)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(minimum_element_size=3 * nm, maximum_element_size=3 * nm, layers=1, topology="prismatic")

study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(numerical-methods-fem-shared-domain-problem-ir)=
## ProblemIR and provenance

Universe, object, and final mesh layers surface through the mesh workflow and build report
provenance; requested object intents never overwrite the final assembly record.

(numerical-methods-fem-shared-domain-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Non-conforming or collapsed layer requests are reported by the planner/build report rather than
silently merged.

(numerical-methods-fem-shared-domain-discrete-realization)=
## Discrete realization

Assembly is realized by the native meshing backend; the container-backed build is authoritative
for build/verification.

(numerical-methods-fem-shared-domain-implementation-mapping)=
## Implementation mapping

Anchors: `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` and `_gmsh_extraction.py` for
mesh assembly/extraction; object recipes lower through
`packages/fullmag-py/src/fullmag/model/discretization.py`.

(numerical-methods-fem-shared-domain-validation)=
## Validation

Conformity and universal/object/interface preservation are covered by meshing and standard-problem
tests.

(numerical-methods-fem-shared-domain-limitations)=
## Limitations

Interface refinement, transition grading, swept regions, and adaptive remeshes are solver
semantics and remain separate capabilities from base assembly.

(numerical-methods-fem-shared-domain-scientific-bibliography)=
## Scientific bibliography

Conforming meshing references belong to the FEM mesh and standard-problem documentation.

(numerical-methods-fem-shared-domain-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Shared assembly | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` | assembly | Conforming solver mesh | Meshing tests |
