---
title: Swept Meshes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/fem-swept-mesh.md
---

(public-docs-numerical-methods-meshing-swept-meshes)=
# Swept and thin-film meshes

(numerical-methods-swept-meshes-problem-statement)=
## Physical and numerical problem

Thin-film magnets are resolved with structured through-thickness element layers and swept
topologies (prism/hex) instead of unstructured tetrahedral fill, preserving layer resolution and
avoiding sliver elements.

(numerical-methods-swept-meshes-governing-equations)=
## Governing equations

Layer distribution is discrete construction, not a new physical equation. Element counts and
stretching control through-thickness resolution.

(numerical-methods-swept-meshes-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $n_{\mathrm{layers}}$ | through-thickness element layers | $1$ |
| $h_{\mathrm{edge}}$ | swept-edge size | $\mathrm{m}$ |
| $r_{\mathrm{stretch}}$ | layer stretching ratio | $1$ |

(numerical-methods-swept-meshes-assumptions-and-validity)=
## Assumptions and validity

Layer counts and stretching ratios are validated by the meshing policy; topology selectors must be
supported by the FEM backend.

(numerical-methods-swept-meshes-python-api)=
## Python API

```python
# %% Thin-film swept topology
import fullmag as fm

nm = 1.0e-9

study = fm.study("swept_meshes_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1200 * nm, 600 * nm, 550 * nm))
film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=3 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(numerical-methods-swept-meshes-problem-ir)=
## ProblemIR and provenance

Swept and layer policy lower into the object mesh recipe and build report; the realized layer
topology is recorded separately from the request.

(numerical-methods-swept-meshes-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Unsupported sweep directions and invalid layer counts fail immediately; pyramid-to-tetrahedra
transitions follow backend legality.

(numerical-methods-swept-meshes-discrete-realization)=
## Discrete realization

Swept construction is realized by the meshing backend (Gmsh); native/container verification is
authoritative.

(numerical-methods-swept-meshes-implementation-mapping)=
## Implementation mapping

Anchors: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` and
`packages/fullmag-py/src/fullmag/model/discretization.py` (`SweptMeshControls`,
`SweepDistribution`).

(numerical-methods-swept-meshes-validation)=
## Validation

Thin-film standard-problem meshing/relaxation tests exercise the swept topology.

(numerical-methods-swept-meshes-limitations)=
## Limitations

Swept support is geometry-dependent; arbitrary bodies require free-tetrahedral fallback.

(numerical-methods-swept-meshes-scientific-bibliography)=
## Scientific bibliography

Thin-film discretization references belong to the standard-problem documentation.

(numerical-methods-swept-meshes-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Swept mesh | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | swept construction | Structured layer mesh | Meshing tests |
