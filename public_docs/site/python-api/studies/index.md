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

Use `Model Explorer -> Stages -> Add stage` for the study types supported by `StudyStageDraftEditor`. Fields absent from the corresponding stage editor are `TODO: frontend support`; child pages must identify them explicitly. See {doc}`/frontend/capability-register`.

## API and source scope

This is a navigation page without a standalone study constructor. Terminal pages own the exact Python examples, equations or applicability boundary, validation, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
