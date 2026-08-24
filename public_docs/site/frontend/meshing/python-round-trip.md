---
title: UI and Python Round-Trip
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-python-round-trip)=
# UI and Python Round-Trip

Control Room and Python are two authoring clients for the same canonical policy.

## Equivalence rules

1. UI lengths are written in SI metres.
2. Blank or `Inherited` means absence of an override, not numeric zero.
3. Advanced JSON is merged with typed controls and then validated.
4. `swept_prism` is canonicalized to the supported strict field bundle.
5. Authored `config` and backend `effective_config` are displayed separately.
6. Script export must preserve the authored policy, including explicit topology and fallback intent.
7. A generated mesh is identified by its report/digest, not by re-reading the editor fields.

The canonical Python routes are documented under
{doc}`../../python-api/meshing/index`. Backend realization is documented under
{doc}`../../numerical-methods/meshing/index`.
