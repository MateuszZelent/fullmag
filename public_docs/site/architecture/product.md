---
title: Product architecture
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/fullmag-application-architecture-v2.md
---

(public-docs-architecture-product)=
# Product architecture

The public FullMag product has four surfaces:

1. Python authoring,
2. the local FullMag launcher,
3. the browser control room,
4. FDM and FEM compute backends.

The user authors one physical problem and receives one provenance-preserving result model. The
selected backend is an execution decision, not a second public physical language.

## Product flow

Python authoring or browser authoring → canonical physical model → validation and execution
planning → session, run and stage → selected FDM or FEM realization → fields, observables,
artifacts and provenance → control-room and export surfaces.

The public site documents user-observable behavior. Internal module boundaries, code ownership and
unfinished migrations remain in developer documentation.
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

- No standalone Python callable is introduced by this architecture page. Use the exact source symbol named by the linked API or implementation page; architecture terms alone are not public functions.

