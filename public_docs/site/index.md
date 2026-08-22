---
title: FullMag documentation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: public_docs_information_architecture_v2.py
---

(public-docs-root)=
# FullMag documentation

<div class="fm-home-masthead">
  <div class="fm-home-masthead__brand">
    <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" loading="lazy" />
    <p class="fm-home-eyebrow">Finite-difference and finite-element micromagnetics</p>
  </div>
  <div class="fm-home-masthead__authors">
    <p class="fm-home-label">Authors</p>
    <p><strong>Dr Mateusz Zelent</strong><br />RPTU Kaiserslautern-Landau</p>
    <p><strong>Dr Mateusz Gołebiewski</strong><br />Adam Mickiewicz University, Poznań</p>
    <p><strong>Prof. Philipp Pirro</strong><br />RPTU Kaiserslautern-Landau</p>
  </div>
  <div class="fm-home-masthead__funding">
    <img src="https://upload.wikimedia.org/wikipedia/commons/b/b7/Flag_of_Europe.svg" alt="European Union emblem" loading="lazy" />
    <div>
      <p class="fm-home-label">Funding</p>
      <p>Mateusz Zelent acknowledges funding from the European Union's Framework Programme for Research and Innovation under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. <strong>101208951 (CNMA)</strong>.</p>
    </div>
  </div>
</div>

<div class="fm-home-intro">
  <p class="fm-home-eyebrow">Documentation organized by responsibility</p>
  <h2>Frontend, Python authoring, and numerical backend are documented independently.</h2>
  <p>FullMag uses one canonical physical model, but the browser interface, Python DSL, and backend implementation answer different questions. The documentation tree now follows those ownership boundaries instead of mixing UI controls, public commands, numerical algorithms, and implementation details on the same page.</p>
  <div class="fm-home-actions">
    <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Getting started</a>
    <a class="fm-home-action" href="frontend/index.html">Frontend</a>
    <a class="fm-home-action" href="python-api/index.html">Python API</a>
    <a class="fm-home-action" href="backend/index.html">Backend</a>
    <a class="fm-home-action" href="physics/index.html">Physics</a>
    <a class="fm-home-action" href="validation/index.html">Validation</a>
  </div>
</div>

```{toctree}
:hidden:
:maxdepth: 5

getting-started/index
frontend/index
python-api/index
backend/index
physics/index
validation/index
```

## Choose the documentation owner

| Branch | Use it when you need to know | Typical questions |
|---|---|---|
| {doc}`Frontend <frontend/index>` | what the browser displays or edits | Where is the FEM object-mesh panel? What does Apply & Build do? Which values are read-only? |
| {doc}`Python API <python-api/index>` | how to author a reproducible study | Which command creates a prism mesh? Which parameter controls airbox grading? What is serialized? |
| {doc}`Backend <backend/index>` | how the numerical implementation realizes the request | Which Gmsh route executes? What element families are generated? What fallback and quality gates apply? |
| {doc}`Physics <physics/index>` | the physical model and conventions | Which energy and effective-field equations are solved? What are the SI units and signs? |
| {doc}`Validation <validation/index>` | evidence and qualification boundaries | Which analytical, standard-problem, parity, and convergence tests support a claim? |

## Meshing map

Meshing is intentionally repeated under the three owners, but each branch has a different scope:

```text
Frontend / Control Room / Meshing
    ├── FDM grid inspector
    └── FEM object, airbox, region, build and quality panels

Python API / Meshing
    ├── FDM / grids, multilayer convolution, boundary correction
    └── FEM
        ├── ferromagnet / tetrahedral, thin-film, prism, hex, boundary layers, import
        └── airbox / geometry and grading

Backend / Meshing
    ├── FDM / structured-grid realization
    └── FEM
        ├── shared-domain assembly
        ├── ferromagnet mesh generators
        ├── airbox mesh generator
        └── quality, extraction and provenance
```

The same concept may therefore appear in three places without duplication of ownership. For example,
`swept_prism` is configured in Python API, selected and inspected in Frontend, and mathematically and
algorithmically realized in Backend.

## Canonical simulation flow

```text
Python study or Control Room draft
            │
            ▼
       canonical ProblemIR
            │
            ▼
validation and capability resolution
            │
            ▼
backend mesh and operator realization
            │
            ▼
ordered stages, outputs, diagnostics, artifacts and provenance
```

Requested intent and resolved execution remain separate throughout this flow. A visible control or a
serializable field does not prove that a particular CPU/GPU lane, topology, solver, or fallback was
executed.

## Citation

Until a versioned release with a persistent identifier is available, cite the repository and exact
commit used for the result:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a computational framework for reproducible
> finite-difference and finite-element micromagnetics*, research software, 2026.
