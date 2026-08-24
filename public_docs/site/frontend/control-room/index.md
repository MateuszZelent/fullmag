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
