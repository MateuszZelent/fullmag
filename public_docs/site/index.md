---
title: FullMag documentation
status: implemented
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
    <p><strong>Uladzislau Makartsou</strong><br />Adam Mickiewicz University, Poznań</p>
    <p><strong>Prof. Philipp Pirro</strong><br />RPTU Kaiserslautern-Landau</p>
  </div>
  <div class="fm-home-masthead__funding">
    <svg viewBox="0 0 54 36" role="img" aria-label="European Union flag" xmlns="http://www.w3.org/2000/svg">
      <rect width="54" height="36" rx="2" fill="#003399" />
      <defs>
        <polygon id="fm-masthead-eu-star" points="0,-1.65 0.37,-0.51 1.57,-0.51 0.60,0.20 0.97,1.33 0,0.63 -0.97,1.33 -0.60,0.20 -1.57,-0.51 -0.37,-0.51" fill="#FFCC00" />
      </defs>
      <use href="#fm-masthead-eu-star" transform="translate(27.00, 7.50)" />
      <use href="#fm-masthead-eu-star" transform="translate(32.25, 8.91)" />
      <use href="#fm-masthead-eu-star" transform="translate(36.09, 12.75)" />
      <use href="#fm-masthead-eu-star" transform="translate(37.50, 18.00)" />
      <use href="#fm-masthead-eu-star" transform="translate(36.09, 23.25)" />
      <use href="#fm-masthead-eu-star" transform="translate(32.25, 27.09)" />
      <use href="#fm-masthead-eu-star" transform="translate(27.00, 28.50)" />
      <use href="#fm-masthead-eu-star" transform="translate(21.75, 27.09)" />
      <use href="#fm-masthead-eu-star" transform="translate(17.91, 23.25)" />
      <use href="#fm-masthead-eu-star" transform="translate(16.50, 18.00)" />
      <use href="#fm-masthead-eu-star" transform="translate(17.91, 12.75)" />
      <use href="#fm-masthead-eu-star" transform="translate(21.75, 8.91)" />
    </svg>
    <div>
      <p class="fm-home-label">EU Horizon Europe · MSCA</p>
      <p>Funded by the <strong>European Union</strong> under <strong>HORIZON-MSCA-2024-PF-01</strong>, Grant Agreement No. <strong>101208951 (CNMA)</strong>.</p>
      <p><a href="acknowledgements/index.html">Acknowledgements &amp; citations →</a></p>
    </div>
  </div>
</div>

<div class="fm-home-intro">
  <p class="fm-home-eyebrow">Documentation organized by layer</p>
  <h2>Frontend, backend, and Python API are separate documentation families.</h2>
  <p>Control Room behavior is documented under Frontend; physical equations, numerical realization, and runtime contracts under Backend; and public authoring commands and parameters under Python API. Install the pure-Python DSL from <a href="https://pypi.org/project/fullmag/">PyPI (<code>pip install fullmag</code>)</a> and run solves inside the Docker Compose DEV runtime.</p>
  <div class="fm-home-actions">
    <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Getting started</a>
    <a class="fm-home-action" href="getting-started/interactive-python.html">Live Python (REPL)</a>
    <a class="fm-home-action" href="frontend/index.html">Frontend</a>
    <a class="fm-home-action" href="backend/index.html">Backend</a>
    <a class="fm-home-action" href="python-api/index.html">Python API</a>
    <a class="fm-home-action" href="validation/index.html">Validation</a>
    <a class="fm-home-action" href="acknowledgements/index.html">Acknowledgements &amp; EU Grant</a>
    <a class="fm-home-action" href="changelog/index.html">Changelog</a>
    <a class="fm-home-action" href="https://github.com/MateuszZelent/fullmag">GitHub</a>
  </div>
</div>

```{figure} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room Workspace Overview
:class: fm-ui-figure
:width: 100%

The FullMag Control Room unified workspace for authoring FDM and FEM models, monitoring live Python sessions, visualizing 2D/3D vector fields, and analyzing spectral and time-domain results.
```

```{toctree}
:hidden:
:maxdepth: 5

getting-started/index
frontend/index
backend/index
python-api/index
validation/index
acknowledgements/index
```

## How to use this documentation

| Question | Canonical branch |
|---|---|
| How do I operate the browser application? | {doc}`frontend/index` |
| What algorithm and data structure does the solver execute? | {doc}`backend/index` |
| How are FDM/FEM CPU and CUDA solvers accelerated and preflight-checked? | {ref}`numerical-methods-performance` |
| Which Python command or parameter should I use? | {doc}`python-api/index` |
| How was a capability validated? | {doc}`validation/index` |
| How do I run a first study? | {doc}`getting-started/index` |
| Where are EU grant details, institutional credits, and inspired-solver citations? | {doc}`acknowledgements/index` |

A capability can appear in more than one branch, with each branch documenting its own layer. For example,
**FEM meshing** is split into:

- Frontend: panels, drafts, Apply/Build transactions, reports, and visualization;
- Backend: Gmsh/MFEM realization, topology, conformity, fallbacks, and numerical validity;
- Python API: `FEM`, `PerObjectMeshRecipe`, `study.universe.mesh(...)`, object mesh helpers,
  parameter tables, and `ProblemIR` lowering.

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

## Funding & European Union grant acknowledgement

<div class="fm-eu-grant-card">
  <div class="fm-eu-grant-card__flag" aria-label="European Union emblem">
    <svg viewBox="0 0 54 36" role="img" aria-label="European Union flag: twelve golden stars on a reflex blue field" xmlns="http://www.w3.org/2000/svg">
      <rect width="54" height="36" rx="2" fill="#003399" />
      <defs>
        <polygon id="fm-home-eu-star" points="0,-1.65 0.37,-0.51 1.57,-0.51 0.60,0.20 0.97,1.33 0,0.63 -0.97,1.33 -0.60,0.20 -1.57,-0.51 -0.37,-0.51" fill="#FFCC00" />
      </defs>
      <use href="#fm-home-eu-star" transform="translate(27.00, 7.50)" />
      <use href="#fm-home-eu-star" transform="translate(32.25, 8.91)" />
      <use href="#fm-home-eu-star" transform="translate(36.09, 12.75)" />
      <use href="#fm-home-eu-star" transform="translate(37.50, 18.00)" />
      <use href="#fm-home-eu-star" transform="translate(36.09, 23.25)" />
      <use href="#fm-home-eu-star" transform="translate(32.25, 27.09)" />
      <use href="#fm-home-eu-star" transform="translate(27.00, 28.50)" />
      <use href="#fm-home-eu-star" transform="translate(21.75, 27.09)" />
      <use href="#fm-home-eu-star" transform="translate(17.91, 23.25)" />
      <use href="#fm-home-eu-star" transform="translate(16.50, 18.00)" />
      <use href="#fm-home-eu-star" transform="translate(17.91, 12.75)" />
      <use href="#fm-home-eu-star" transform="translate(21.75, 8.91)" />
    </svg>
  </div>
  <div class="fm-eu-grant-card__body">
    <p class="fm-home-eyebrow">Horizon Europe · MSCA Postdoctoral Fellowship</p>
    <p><strong>Mateusz Zelent</strong> acknowledges funding from the European Union's Horizon Europe programme under <strong>HORIZON-MSCA-2024-PF-01</strong>, Marie Skłodowska-Curie Grant Agreement No. <strong>101208951 (CNMA)</strong>.</p>
    <p class="fm-eu-grant-card__disclaimer">Funded by the European Union. Views and opinions expressed are however those of the author(s) only and do not necessarily reflect those of the European Union or the European Research Executive Agency (REA). Neither the European Union nor the granting authority can be held responsible for them.</p>
  </div>
</div>

## Scientific heritage & ecosystem

FullMag's workflow, numerical abstractions, and benchmark suite draw inspiration from pioneering
open-source micromagnetic packages — including **MuMax3**, **Amumax**, **mumax⁺**, **Boris
Computational Spintronics**, **OOMMF**, **TetraX**, **Tetmag**, and **NeuralMag** — as well as
core scientific libraries such as **MFEM**, **Gmsh**, **hypre**, **libCEED**, and **PETSc/SLEPc**.
See {doc}`acknowledgements/index` for full attributions, software descriptions, and literature
citations with DOIs.

## Citation

Until a versioned release with a persistent identifier is available, cite the repository and the
exact commit used for the reported result (alongside the published [`fullmag`](https://pypi.org/project/fullmag/) PyPI version when applicable); full BibTeX and related software references are collected on {doc}`acknowledgements/index`.
