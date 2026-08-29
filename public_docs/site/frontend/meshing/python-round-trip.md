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
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

