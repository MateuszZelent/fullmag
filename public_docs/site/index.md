---
title: FullMag user guide and reference
status: partial
doc_kind: user-guide
audience: user
owner: fullmag-public-docs
source_of_truth: readme.md
---

(public-docs-root)=
# FullMag user guide and reference

<div class="fm-home-hero">
  <div class="fm-home-hero__brand">
    <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" loading="lazy" />
  </div>
  <div class="fm-home-hero__content">
    <p class="fm-home-eyebrow">Physics-first micromagnetics</p>
    <h2>Author, run, inspect, and reproduce one physical problem.</h2>
    <p>FullMag is a research software platform for reproducible micromagnetic simulation across finite-difference and finite-element backends.</p>
    <div class="fm-home-actions">
      <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Start the user guide</a>
      <a class="fm-home-action" href="python-api/index.html">Browse the Python API</a>
      <a class="fm-home-action" href="physics/index.html">Read the physics reference</a>
    </div>
  </div>
</div>

:::{admonition} Documentation status
:class: note

This portal is the public user manual and scientific reference. It is an active research
prototype, so every page distinguishes executable, semantic-only, planned, experimental, and
not-qualified behavior. The internal development plans, implementation audits, agent rules, and
unfinished engineering notes remain under `docs/` and are not published by this site.
:::

FullMag is designed as one scientific application with one semantic model and several numerical
realizations. A user describes a physical problem; the same request can be lowered to the
canonical `ProblemIR`, planned for a backend, executed as a session and stage, and inspected
through fields, observables, artifacts, and provenance.

## How to use this manual

The organization follows the progressive flow used by established micromagnetics manuals: start
with a working authoring path, then consult the reference chapter for the object or interaction
you are using.

```{toctree}
:maxdepth: 2
:caption: User guide

getting-started/index
```

```{toctree}
:maxdepth: 3
:caption: Reference

python-api/index
physics/index
numerical-methods/index
validation/index
architecture/index
```

| If you want to… | Start here |
|---|---|
| install FullMag and run a first problem | {doc}`getting-started/index` |
| author a model in Python | {doc}`python-api/index` |
| understand an interaction, equation, or unit | {doc}`physics/index` |
| compare FDM/FEM or CPU/GPU realizations | {doc}`numerical-methods/index` and the relevant physics page |
| check qualification evidence | {doc}`validation/index` |
| understand `ProblemIR`, planning, runtime, or provenance | {doc}`architecture/index` |

## The canonical FullMag workflow

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

The control room and the Python DSL are two authoring surfaces for the same physical model. The
planner must expose an unsupported combination instead of silently changing the requested
interaction, backend, precision, or device. A source file or Python class is therefore not, by
itself, evidence that every execution lane is qualified.

## A first copyable Python workflow

The stage pipeline is the normal user-facing authoring surface. The `# %%` separators make the
example usable as a notebook or as a regular Python script.

```python
# %% Imports and SI units
import fullmag as fm

nm = 1.0e-9

# %% Define one study and its physical interaction
study = fm.study("first_exchange_study")
study.engine("fdm")
study.exchange()
study.cell(2 * nm, 2 * nm, 1 * nm)

# %% Geometry, material, and initial magnetization
film = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3       # A/m
film.Aex = 13.0e-12     # J/m
film.alpha = 0.01       # dimensionless
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Ordered stages
study.stages.add_relax(
    stage_id="relax",
    tolT=1.0e-6,
    dt=1.0e-15,
    max_steps=50_000,
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

This declares the requested physical workflow. The planner and runtime subsequently resolve the
solver implementation, device, precision, mesh, outputs, and qualification evidence. The
meaning of `tolT`, `dt`, and `until` belongs to the stage and dynamics reference; the example does
not hide those values inside a helper.

The complete interaction pages repeat this progression with equations, SI symbols, exhaustive
parameters, output names, `ProblemIR` mappings, backend matrices, source maps, tests, and
limitations. For example, the canonical Exchange owner is
{doc}`physics/interactions/exchange/index`, while its authoring contract is
{doc}`python-api/interactions/exchange`.

The repository-owned standard-problem scenarios are the executable source of truth for complete
simulation scripts. A page may link to or reproduce a relevant `tests/standard_problems/...` or
`examples/...` stage script, but it must not replace that workflow with a direct top-level
constructor
simulation.

## Scientific scope and maturity

FullMag treats interactions as first-class physical model terms. Each interaction page owns its
physical definition once and then separates FDM/FEM, CPU/GPU, precision, implementation, and
qualification evidence.

| Area | Current public scope |
|---|---|
| Core micromagnetics | Landau–Lifshitz–Gilbert dynamics, exchange, demagnetization, external fields, anisotropy, DMI, and observables. |
| FDM | CPU reference paths and CUDA-oriented paths with lane-specific precision and qualification evidence. |
| FEM | Shared-domain meshing, native CPU/GPU solver paths, and explicit boundaries for unsupported interactions. |
| Spintronics | Selected STT/SOT and prescribed-current semantics; self-consistent transport remains limited or deferred by module. |
| Multiphysics | Magnetoelastic and related mechanics semantics with explicit implementation and qualification limits. |
| Analysis | Relaxation, frequency-domain, eigenmode, and post-processing workflows according to their current evidence. |

The public status vocabulary is deliberately strict:

| Status | Meaning |
|---|---|
| `semantic_only` | The API or `ProblemIR` can describe the feature, but no public executable path is provided. |
| `reference_executable` | The feature runs on a correctness or bootstrap path. |
| `production_executable` | The feature runs on a target production backend. |
| `validated` | The stated workload has explicit validation evidence. |
| `planned` / `experimental` / `not qualified` | The implementation or evidence is incomplete and must not be presented as production-ready. |

Presence in the Python API, `ProblemIR`, or native source tree does not imply execution support on
every backend.

## Authors and affiliations

FullMag is developed as research software by the contributors listed in the project metadata:

| Author | Affiliation |
|---|---|
| Dr Mateusz Zelent | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |
| Dr Mateusz Gołebiewski | Institute of Spintronics and Quantum Information, Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |

This table is project metadata. It does not claim equal authorship of every source file, solver, or
documentation page by every listed contributor.

## Funding and acknowledgements

Mateusz Zelent acknowledges funding from the European Union's Framework Programme for Research
and Innovation **HORIZON-MSCA-2024-PF-01** under the Marie Skłodowska-Curie Grant Agreement,
Project No. **101208951–CNMA**.

FullMag also builds on the wider scientific software ecosystem for micromagnetics, numerical
methods, finite-element discretization, GPU computing, and reproducible research infrastructure.

## How to cite FullMag and identify a result

Until a dedicated FullMag publication is assigned, cite the repository and the exact revision used
for the work:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a physics-first micromagnetics platform for
> reproducible FDM/FEM simulation workflows*, research software repository,
> [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag), accessed via
> [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

For a reproducible result, record:

- the FullMag commit or release;
- the generated documentation version and build timestamp;
- the authored Python and canonical `ProblemIR` model;
- the resolved solver, device, precision, mesh, and capability decision; and
- the runtime qualification evidence and produced artifacts.

The public portal must not make a moving `master` link look like a fixed scientific release.

## Contact, contribution, and licensing

Project coordination: **Mateusz Zelent, RPTU**.

- Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag)
- Documentation issues and feature requests: use the repository issue tracker.
- Contributions should preserve the physics-first model, canonical `ProblemIR`, explicit capability
  checks, and source-backed validation.

The current repository has no root-level license file. Public redistribution or reuse should wait
for an explicit project license and should follow the repository's current collaboration policy.

The public workflow builds only `public_docs/site`; internal development material under `docs/`,
including plans, audits, and agent instructions, is deliberately excluded from the portal.

## Public documentation address

The canonical public address is [https://fullmag.mzelent.pl/](https://fullmag.mzelent.pl/).
The GitHub Pages project address remains available as a fallback:
[https://mateuszelent.github.io/fullmag/](https://mateuszelent.github.io/fullmag/).
