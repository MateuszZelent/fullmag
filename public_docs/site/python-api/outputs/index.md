---
title: Outputs
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-root)=
# Outputs

Outputs turn solver results into inspectable scientific artifacts: fields and scalars, quantity
selection, eigenmodes and spectra, dispersion and response, step snapshots, and autosave tables.

```{toctree}
:maxdepth: 1

fields-and-scalars
quantities
modes-and-spectra
dispersion-and-response
snapshots
autosave
```
## Control Room crosswalk

Inspect supported outputs through `Model Explorer -> Stages -> <stage> -> Autosave` and the result-inspection flow. Output fields without a matching inspector control are `TODO: frontend support`; this index does not imply that publication is authorable in the UI. See {doc}`/frontend/capability-register`.

## API and source scope

This navigation page has no standalone output function. Terminal pages own exact Python calls, artifact semantics, limitations, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
