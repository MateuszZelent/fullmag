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

<div class="fm-home-masthead">
  <div class="fm-home-masthead__brand">
    <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" loading="lazy" />
    <p class="fm-home-eyebrow">Physics-first micromagnetics</p>
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
      <p class="fm-home-label">Funding and acknowledgement</p>
      <p>FullMag has received funding from the European Union's Framework Programme for Research and Innovation, HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. <strong>101208951–CNMA</strong>.</p>
      <a href="https://marie-sklodowska-curie-actions.ec.europa.eu/">
        <img class="fm-home-funding-badge" src="https://img.shields.io/badge/Marie%20Sk%C5%82odowska--Curie%20Actions-Horizon%20Europe-003399?style=for-the-badge" alt="Marie Skłodowska-Curie Actions — Horizon Europe" loading="lazy" />
      </a>
    </div>
  </div>
</div>

<div class="fm-home-intro">
  <p class="fm-home-eyebrow">Research software and scientific reference</p>
  <h2>A clear path from physical model to reproducible result.</h2>
  <p>FullMag is a micromagnetics platform for authoring, planning, executing, inspecting, and reproducing simulations across finite-difference and finite-element backends.</p>
  <div class="fm-home-actions">
    <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Start with the user guide</a>
    <a class="fm-home-action" href="physics/index.html">Read the physics reference</a>
    <a class="fm-home-action" href="python-api/index.html">Browse the Python API</a>
    <a class="fm-home-action" href="changelog/index.html">Documentation changelog</a>
  </div>
</div>

<div class="fm-home-status">
  <strong>Documentation status.</strong> FullMag is active research software. Each reference page
  states what is executable, semantic-only, planned, experimental, or not qualified. Internal
  development plans and engineering notes remain outside this public portal. The documentation
  changelog records public-page edits and explicit user-visible contract changes.
</div>

```{toctree}
:hidden:
:maxdepth: 4

getting-started/index
python-api/index
physics/index
numerical-methods/index
validation/index
architecture/index
```

## What FullMag is

FullMag keeps one physical model across the Python DSL, browser control room, canonical
`ProblemIR`, planner, runtime, and numerical backends. The planner reports an unsupported
combination instead of silently changing the requested interaction, solver, device, or
precision.

The public manual separates scientific meaning from implementation detail. An interaction page
defines the equations, symbols, units, assumptions, parameters, backend realizations, source
mapping, and validation evidence in one place.

## Start here

- {doc}`getting-started/index` — install FullMag and run a first stage-based
  workflow.
- {doc}`python-api/index` — author objects, parameters, stages, and canonical
  lowering.
- {doc}`physics/index` — read the implemented equations and solver-specific
  realizations.
- {doc}`validation/index` — inspect analytical cases, standard problems, parity, and
  qualification status.
- [Documentation changelog](changelog/index.html) — inspect recent public-documentation commits
  and Sphinx-native version-change records.

## The canonical workflow

1. Author the physical model in Python or the browser.
2. Lower the request to the canonical `ProblemIR`.
3. Validate the model and resolve backend capabilities.
4. Execute ordered sessions, runs, and stages through FDM or FEM.
5. Inspect fields, observables, artifacts, and provenance.

The normal public Python workflow uses `fm.study(...)` and ordered
`study.stages.add_*` calls. Complete copyable scenarios follow the repository-owned
`tests/standard_problems/...` stage scripts; the manual does not teach direct top-level
construction of a simulation request.

## Scientific scope

The current public scope covers Landau–Lifshitz–Gilbert dynamics, exchange, demagnetization,
Zeeman fields, anisotropy, DMI, thermal noise, selected spin-torque and Oersted terms, shared
FDM/FEM numerical methods, and explicit CPU/GPU qualification boundaries. Follow the individual
reference page for the authoritative support status; source presence alone is not a qualification
claim.

## Cite and contact

Until a dedicated FullMag publication is assigned, cite the repository and the exact revision used
for the result:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a physics-first micromagnetics platform for
> reproducible FDM/FEM simulation workflows*, research software repository,
> [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag), accessed via
> [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

Project coordination: **Mateusz Zelent, RPTU**.

- Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag)
- Public site: [fullmag.mzelent.pl](https://fullmag.mzelent.pl/)
- Documentation issues and feature requests: use the repository issue tracker.

The public workflow builds only `public_docs/site`. Internal plans, audits, agent instructions,
and unfinished engineering reports under `docs/` are deliberately excluded from the portal.
