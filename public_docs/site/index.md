---
title: FullMag documentation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: readme.md
---

(public-docs-root)=
# FullMag

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
</div>

<div class="fm-home-intro">
  <p class="fm-home-eyebrow">Documentation organized by ownership</p>
  <h2>Frontend, backend, and Python API are separate documentation families.</h2>
  <p>The documentation tree follows the layer that owns a fact. Control Room behavior is documented under Frontend; numerical realization, physics, and runtime contracts under Backend; public authoring commands and parameters under Python API.</p>
  <div class="fm-home-actions">
    <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Getting started</a>
    <a class="fm-home-action" href="frontend/index.html">Frontend</a>
    <a class="fm-home-action" href="backend/index.html">Backend</a>
    <a class="fm-home-action" href="python-api/index.html">Python API</a>
    <a class="fm-home-action" href="validation/index.html">Validation</a>
  </div>
</div>

```{toctree}
:hidden:
:maxdepth: 5

getting-started/index
frontend/index
backend/index
python-api/index
validation/index
```

## How to use this documentation

| Question | Canonical branch |
|---|---|
| How do I operate the browser application? | {doc}`frontend/index` |
| What algorithm and data structure does the solver execute? | {doc}`backend/index` |
| Which Python command or parameter should I use? | {doc}`python-api/index` |
| How was a capability validated? | {doc}`validation/index` |
| How do I run a first study? | {doc}`getting-started/index` |

The same concept may appear in more than one branch, but each page has one owner. For example,
**FEM meshing** is split into:

- Frontend: panels, drafts, Apply/Build transactions, reports, and visualization;
- Backend: Gmsh/MFEM realization, topology, conformity, fallbacks, and numerical validity;
- Python API: `FEM`, `PerObjectMeshRecipe`, `study.universe.mesh(...)`, object mesh helpers,
  parameter tables, and ProblemIR lowering.

## Simulation data flow

```text
Python API or Control Room
            │
            ▼
      canonical ProblemIR
            │
            ▼
 planner and capability resolution
            │
            ▼
 backend mesh / operators / stages
            │
            ▼
 artifacts, diagnostics, provenance
```

Requested intent and resolved execution are never treated as the same object. A mesh parameter
entered in Python or the UI is a request; the generated mesh, its topology, quality, markers,
fallbacks, and digest are backend evidence.

## Citation

Until a versioned release with a persistent identifier is available, cite the repository and exact
commit used for the reported result.

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
