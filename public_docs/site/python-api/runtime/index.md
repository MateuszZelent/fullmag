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
selection, backend policy, the simulation lifecycle, result reading, published artifacts, and
provenance records that keep requested intent separated from resolved execution.

```{toctree}
:maxdepth: 1

runtime-selection
backend-policy
simulation
results
artifacts
provenance
```
## Control Room crosswalk

Runtime metadata and published results are available for inspection through the runtime/result views. Direct runtime selection, backend policy authoring, and artifact publication controls are `TODO: frontend support` unless a child page names a specific live control. See {doc}`/frontend/capability-register`.

## API and source scope

This index does not define a standalone runtime function. Terminal pages own exact calls, lifecycle semantics, limitations, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
