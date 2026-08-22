---
title: Inspector And Draft Transactions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-inspector)=
# Inspector and draft transactions

Inspector forms use explicit draft isolation. A field edit changes local UI state; it does not
immediately alter canonical authoring state or a materialized solver resource.

## Transaction states

| State | Meaning |
|---|---|
| clean | draft is semantically equal to the loaded resource revision |
| dirty | one or more authored values differ from the loaded resource |
| invalid | draft cannot be converted to a canonical request |
| pending | an Apply or Build command is in flight |
| saved, mesh stale | policy revision advanced, but the solver mesh still represents an older revision |
| realized | a completed build report references the current geometry and policy revisions |

## Actions

- **Apply** validates and replaces the relevant authored resource.
- **Revert** restores the currently loaded resource and discards local edits.
- **Build** materializes already-saved policy.
- **Apply & Build** saves a valid dirty draft and then submits a build command.

Numeric strings are normalized before dirty comparison, so equivalent textual forms such as `1e-9`
and `0.000000001` do not create a false change. Advanced JSON remains subject to the same canonical
request validation as dedicated controls.
