---
title: FullMag public documentation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: readme.md
---

(public-docs-root)=
# FullMag

<div class="fm-home-hero">
  <div class="fm-home-hero__brand">
    <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" loading="lazy" />
  </div>
  <div class="fm-home-hero__content">
    <p class="fm-home-eyebrow">Physics-first micromagnetics</p>
    <h2>Author, run, inspect, and reproduce one physical problem.</h2>
    <p>FullMag is a research software platform for reproducible micromagnetic simulation across finite-difference and finite-element backends.</p>
    <div class="fm-home-actions">
      <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Start with the user guide</a>
      <a class="fm-home-action" href="python-api/index.html">Browse the Python API</a>
      <a class="fm-home-action" href="physics/index.html">Read the physics</a>
    </div>
  </div>
</div>

FullMag is an active research prototype. The public portal describes the user-facing product,
the physical model, the Python authoring contract, numerical realizations, validation scope,
and known limitations. It does not present an unqualified feature as production-ready merely
because a class, IR field, or backend source file exists.

## What FullMag is

FullMag is designed as one scientific application with a single semantic spine:

```text
Python DSL or browser authoring
        ↓
canonical physical model and ProblemIR
        ↓
validation, normalization, and capability planning
        ↓
session, run, and stage runtime
        ↓
FDM or FEM numerical realization
        ↓
fields, observables, artifacts, and provenance
        ↓
control room, analysis, export, and reproducible results
```

The central rule is simple: users describe a physical micromagnetic problem. The public
contract must not force them to think in terms of backend memory layouts, hidden fallbacks,
or implementation-specific storage details.

FullMag currently brings together:

- an embedded Python DSL for human-authored simulation scripts;
- a canonical `ProblemIR` representation shared by authoring and execution layers;
- explicit FDM and FEM planning with visible capability boundaries;
- a local browser control room for sessions, stages, fields, artifacts, and diagnostics;
- native CPU and GPU execution paths with separate qualification status;
- source-backed scientific documentation with equations, SI units, Python examples,
  implementation maps, and validation evidence.

## Choose your starting point

<div class="fm-home-grid">
  <div class="fm-home-card">
    <p class="fm-home-card__kicker">New to FullMag</p>
    <h3>Install and run a first problem</h3>
    <p>Set up the environment, choose FDM or FEM, and follow a complete first simulation.</p>
    <p><a href="getting-started/index.html">Open Getting started →</a></p>
  </div>
  <div class="fm-home-card">
    <p class="fm-home-card__kicker">Python authors</p>
    <h3>Build a reproducible script</h3>
    <p>Start from the canonical Python objects, inspect the lowered IR, and preserve the requested intent.</p>
    <p><a href="python-api/index.html">Open the Python API →</a></p>
  </div>
  <div class="fm-home-card">
    <p class="fm-home-card__kicker">Scientific users</p>
    <h3>Read the model before the solver</h3>
    <p>Each interaction owns its equations, symbols, units, backend realizations, source map, and validation boundary.</p>
    <p><a href="physics/index.html">Open Physics →</a></p>
  </div>
  <div class="fm-home-card">
    <p class="fm-home-card__kicker">Numerical work</p>
    <h3>Compare solver realizations</h3>
    <p>Follow time integration, meshing, demagnetization, relaxation, and state-transfer methods.</p>
    <p><a href="numerical-methods/index.html">Open Numerical methods →</a></p>
  </div>
</div>

## A first copyable Python script

The public examples are written as executable Python cells so they can be copied into a
notebook or a script. This small problem creates one ferromagnetic body, adds bulk exchange,
and lowers the authored request to `ProblemIR` without hiding the model behind a helper.

```python
# %% Imports and units
import fullmag as fm

nm = 1e-9

# %% Physical problem
problem = fm.Problem(
    name="first_exchange_problem",
    magnets=[
        fm.Ferromagnet(
            name="film",
            geometry=fm.Box(size=(100 * nm, 20 * nm, 5 * nm)),
            material=fm.Material(name="Permalloy", Ms=800e3, A=13e-12, alpha=0.02),
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        ),
    ],
    energy=[fm.Exchange()],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveField("m", every=1e-12)],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 5 * nm)),
    ),
)

# %% Inspect the canonical request before execution
problem_ir = problem.to_ir()
assert problem_ir["energy_terms"] == [{"kind": "exchange"}]
assert problem_ir["problem_meta"]["name"] == "first_exchange_problem"
print(problem_ir["problem_meta"]["name"])
```

The example is an authoring and lowering example. Running a simulation adds an explicit
backend selection and runtime policy; those decisions are documented in the relevant
Getting started, Python API, and architecture pages.

## Documentation map

```{toctree}
:maxdepth: 4
:caption: Public documentation

getting-started/index
python-api/index
physics/index
numerical-methods/index
validation/index
architecture/index
```

### How the documentation is organized

| Section | What it owns |
|---|---|
| **Getting started** | Installation, first scripts, first FDM/FEM runs, and solver selection. |
| **Python API** | Public constructors, parameters, validation, canonical script shapes, and `ProblemIR` lowering. |
| **Physics** | Physical equations, notation, SI units, assumptions, interaction ownership, and backend realizations. |
| **Numerical methods** | Discretization, time integration, relaxation, meshing, demagnetization solvers, and state transfer. |
| **Validation** | Analytical cases, standard problems, CPU/GPU parity, FEM/FDM comparisons, and qualification status. |
| **Architecture** | Product boundaries, semantic model, planner, runtime, capabilities, and provenance. |

The Python API and physics documentation are intentionally separate. A physics page explains
what an interaction means and how each solver realizes it; a Python API page explains how a
user authors and lowers the corresponding object. Neither page replaces the source-backed
implementation map on the other page.

## Project status and scientific scope

FullMag uses explicit status language. The presence of an API object or a native source file
does not by itself prove an executable or qualified backend.

| Area | Scope in the current project |
|---|---|
| Core micromagnetics | Landau–Lifshitz–Gilbert dynamics, exchange, demagnetization, external fields, anisotropy, DMI, and observables. |
| FDM | CPU reference paths and GPU-oriented CUDA paths, with lane-specific precision and qualification evidence. |
| FEM | Shared-domain meshing, native CPU/GPU solver paths, and explicit boundaries for unsupported interactions. |
| Spintronics | Selected STT/SOT and prescribed-current semantics; self-consistent transport remains limited or deferred by module. |
| Multiphysics | Magnetoelastic and related mechanics semantics are documented with explicit implementation and qualification limits. |
| Analysis | Relaxation, frequency-domain, eigenmode, and post-processing workflows are documented according to their current evidence. |

For the exact status of an interaction or numerical method, follow its page. Status is not
inferred from this overview.

## Authors and affiliations

FullMag is developed as a research software project by the contributors listed in the project
metadata:

| Author | Affiliation |
|---|---|
| Dr Mateusz Zelent | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |
| Dr Mateusz Gołebiewski | Institute of Spintronics and Quantum Information, Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |

The affiliation table is project metadata. It does not assert that every file, solver, or
documentation page has equal authorship by every listed contributor.

## Funding and acknowledgements

Mateusz Zelent acknowledges that FullMag has received funding from the European Union's
Framework Programme for Research and Innovation **HORIZON-MSCA-2024-PF-01** under the
Marie Skłodowska-Curie Grant Agreement, Project No. **101208951–CNMA**.

FullMag also builds on the wider scientific software ecosystem for micromagnetics,
high-performance numerical methods, finite-element discretization, GPU computing, and
reproducible research infrastructure.

## How to cite and identify a version

Until a dedicated FullMag publication is assigned, cite the repository and the exact revision
used for the work:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a physics-first micromagnetics platform
> for reproducible FDM/FEM simulation workflows*, research software repository,
> [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag),
> accessed via [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

For a reproducible result, record the FullMag commit or release, the generated documentation
version, the requested Python/IR model, the resolved backend and precision, and the runtime
qualification evidence. The public portal must never make a moving `master` link look like a
fixed scientific release.

## Contact and contribution

Project coordination: **Mateusz Zelent, RPTU**.

- Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag)
- Documentation issues and feature requests: use the repository issue tracker.
- Code and documentation contributions should preserve the physics-first model, the canonical
  `ProblemIR` path, explicit backend capability checks, and source-backed validation.

When adding physics or numerics, update the publication-style source note first, then keep the
Python API, `ProblemIR`, planner, runtime, artifacts, tests, and public documentation aligned.
Internal implementation plans, audits, agent instructions, and unfinished engineering reports
remain under `docs/`; they are not part of this public portal.

## Publication status

The canonical public address is:

[https://fullmag.mzelent.pl/](https://fullmag.mzelent.pl/)

The GitHub Pages project address remains available as a fallback:

[https://mateuszelent.github.io/fullmag/](https://mateuszelent.github.io/fullmag/)

The public workflow builds only `public_docs/site`. It does not publish the internal `docs/`
tree, development plans, private diagnostics, or agent instructions.
