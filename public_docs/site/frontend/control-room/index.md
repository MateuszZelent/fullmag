---
title: Control Room
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-root)=
# Control Room

The Control Room is the interactive authoring and inspection client. Its core rule is that every
write is explicit: form edits create a draft, **Apply** commits canonical authored policy, and a
separate build or run command materializes backend resources.

## Workspace ownership

| Area | Responsibility |
|---|---|
| Explorer | selects study, universe, object, region, interaction, stage, mesh, or artifact |
| Inspector | edits the selected canonical resource and exposes validation feedback |
| Viewport | renders geometry, mesh, and field resources; it is not the source of numerical truth |
| Mesh Build monitor | tracks requested, running, failed, and latest-successful mesh builds |
| Status/footer | shows session, backend, device, precision, and stage state |
| Script export | serializes canonical authored intent to the stage-first Python DSL |

The implementation is centered in `apps/control-room/src/modules`, with API/resource ownership in
`apps/control-room/src/kernel`. The older `apps/legacy_web` implementation is not the canonical UI
contract unless a page says otherwise.
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
