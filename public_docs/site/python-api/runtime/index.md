---
title: Runtime
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-root)=
# Runtime

The runtime selects and executes a backend and device for the study. This family covers runtime
selection, backend policy, the batch simulation lifecycle, interactive live sessions (`fm.connect()`),
result reading, published artifacts, and provenance records that keep requested intent separated
from resolved execution.

- **Batch / stage-first execution**: Author `fm.study(...)` and `study.stages.add_*`, lower to
  `ProblemIR`, and run reproducibly via the container CLI or {doc}`simulation`.
- **Interactive live execution**: Attach directly to a running FullMag instance via {doc}`live-session`
  (`fm.connect()`, `fm.relax()`, `fm.run()`, `fm.field()`, `fm.sweep()`, `fm.export_script()`) while
  Control Room inspects the shared session live.

```{toctree}
:maxdepth: 1

runtime-selection
backend-policy
simulation
live-session
results
artifacts
provenance
```
## Control Room crosswalk

Control Room surfaces live runtime status, resolved engine/device provenance, active background
mesh/solver jobs, and realtime diagnostics in the bottom status bar and footer drawers, alongside
connected sessions in **Active simulations** and instance tabs (see {doc}`live-session` and
{doc}`/frontend/capability-register`). Direct runtime-policy selection (`auto`/`fdm`/`fem`, `cpu`/`gpu`,
precision) is edited in **Study -> Execution Profile**, while backend-only artifact publication flags
and legacy selection options without matching UI fields remain Python-authored (`TODO: frontend support`).

```{image} /_static/images/ui/status-bar-footer.png
:alt: Control Room status bar showing runtime state, mesh readiness, WebSocket status, and active compute engine
:align: center
:width: 100%
```

```{image} /_static/images/ui/explorer-jobs-and-diagnostics-tabs.png
:alt: Control Room Explorer Jobs and Diagnostics tabs showing live command queue and runtime diagnostics
:align: center
:width: 100%
```

## API and source scope

This index does not define a standalone runtime function. Terminal pages own exact calls, lifecycle semantics, limitations, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
