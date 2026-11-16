---
title: Studies
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-root)=
# Studies

A study defines what to compute: time evolution, relaxation, hysteresis, eigenmodes, or frequency
response. Stages are authored in order and executed by the runtime; the pages here document each
study type's stage and its results.

```{toctree}
:maxdepth: 1

time-evolution
relaxation
hysteresis
eigenmodes
frequency-response
```
## Control Room crosswalk

Use `Model Explorer -> Study` (`StudyInspectorPanel`) to configure requested backend, device, precision,
and execution mode, and `Model Explorer -> Stages -> Add stage` (`StudyStageDraftEditor`) to author
and interactively re-run supported stage types (`relax`, `run`, `hysteresis`, `eigenmodes`,
`frequency_response`). Each stage routes through `StudyStageInspectorRouter`, supports initial-state
handoff (`StageInitialStateSelector`) and revision-pinned Apply-and-Compute (`executeStageAfterApply`),
and plots live time series, hysteresis loops, or spectra in `LiveChartsView` and `AnalysisPlotsView`.
Fields absent from the corresponding stage editor remain `TODO: frontend support`; child pages identify
them explicitly. See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/studies-and-stages`.

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Study and Stage Inspectors showing solver execution profile, ordered stage pipeline, and interactive stage re-run controls
:align: center
:width: 100%
```

## API and source scope

This is a navigation page without a standalone study constructor. Terminal pages own the exact Python examples, equations or applicability boundary, validation, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
