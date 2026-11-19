---
title: Frontend State and Commands
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-state-and-commands-root)=
# Frontend State and Commands

Frontend state is resource-oriented and dual-plane. Control-plane metadata, commands, and revisions
exchange over typed **OpenAPI v2** JSON endpoints synchronized via WebSocket invalidations, while
dense spatial meshes, vector buffers, region masks, planar cuts, and table histories stream over
versioned binary HTTP codecs. Components must never invent a parallel local simulation truth.

Key invariants:

- drafts stay local and isolated until explicitly applied;
- successful authoring writes return an updated backend `scene_revision`;
- dependent mesh, preparation, and field caches are invalidated explicitly across resources;
- command acceptance, command completion, and scientific qualification remain separate states;
- `current` and `latest-successful` mesh/runtime artifacts remain distinct;
- backend validation and transport errors appear verbatim or in bounded summaries.

## Command Registry & Palette (`Ctrl+Shift+P`)

Modules declare typed actions (`CommandContribution`) with `id`, `title`, `group`, `category`,
`scope`, `shortcut`, `isEnabled`, `disabledReason`, `isActive`, and `run`. All global and session
commands are searchable from the **Command Palette** (`CommandPaletteModule`, opened with
`Ctrl+Shift+P`, `Edit -> Command Palette`, or the top-bar **Command search** button). Non-session
contexts restrict visible items using `projectWorkspacePaletteCommands`.

```{image} /_static/images/ui/command-palette-ctrl-k.png
:alt: Control Room Command Palette (Ctrl+Shift+P) filtering commands with live shortcut and disabled-reason feedback
:align: center
:width: 100%
```

## Isolated Drafts, Commit Fencing & Revision Reconciliation

All inspector editors register with `InspectorEditSession` under `"staged"`, `"liveViewport"`, or
`"immediate"` mode:

```{image} /_static/images/ui/inspector-panel-draft.png
:alt: Staged Inspector edit session showing STATE modified badge, Revert and highlighted Apply buttons, and Draft ready to apply bar
:align: center
:width: 100%
```

Because an external Python script or sibling tab may mutate the session concurrently, authoring
writes (`runAuthoringMutationWithHistory`) carry optimistic `scene_revision` preconditions. When a
`409` revision conflict occurs (`revision_conflict` / `scene_revision_conflict`), reconciliation
helpers (`reconcileObjectEditAck`, `reconcileObjectIdentityAck`) preserve unconflicted local edits
or prompt the user to rebase before retrying. Stage re-execution (`executeStageAfterApply`) also
pins `(scene_revision, solver_profile, domain)` and aborts cleanly if any compute input changes
between **Apply** and **Compute**.

## Live Python Client Presence & Session Sync

When an interactive Python script calls `fm.connect()`, `LiveSession`
(`packages/fullmag-py/src/fullmag/live/_session.py`) registers a unique `python-<hex>` `client_id`
and sends a presence heartbeat every `10 s` to `PUT /v2/sessions/current/clients/{client_id}`
(`SessionClientsResource`, `30 s` API TTL). Scene transactions committed from Python bump
`scene_revision`, emit WebSocket invalidation events, refresh Control Room resources cleanly, and
surface attached sessions directly inside **Active simulations** on `/home`.

```{image} /_static/images/ui/start-screen-python-live-connect.png
:alt: Live Control Room synchronizing with a connected Python script session
:align: center
:width: 100%
```

## Versioned Binary HTTP Codecs

To keep JSON payloads thin, `apps/control-room/src/kernel/api/codecs/`
decodes zero-copy `ArrayBuffer` responses identified by 4-byte magic headers:

| Magic | Codec module | Payload semantics |
|---|---|---|
| `FMVP` (+ `FMMI`) | `fieldVectorCodec.ts` | 3D/spatial scalar & vector fields (`KIND_F64`/`KIND_F32`, versions v2–v5 and v6 artifact delegation) |
| `FMMT` | `topologyCodec.ts` | FEM topology (positions, cell/facet connectivity, global ordinals, cell/facet/boundary markers) |
| `FMRM` | `fdmRegionMembershipCodec.ts` | FDM grid cell-to-region membership (`Uint32Array`, `FMRM_INACTIVE_REGION_ID` sentinel in v2) |
| `FMBM` | `fdmMultilayerActiveMaskCodec.ts` | Per-layer active cell masks for multilayer FDM models |
| `FMCS` | `crossSectionCodec.ts` | 2D planar slice field and geometry cut payloads |
| `FMQS` | `crossSectionQualityCodec.ts` | 2D cross-section mesh quality profiles |
| `FMMQ` | `meshQualityDataCodec.ts` | FEM element size, edge-length, and quality histograms |
| `FMPP` | `periodicPairsCodec.ts` | Bloch-periodic master/slave boundary facet pairing data |
| `FMTB` | `tableRowsCodec.ts` | Decimated scalar/time-series table rows for charts and exports |

## Capability scope and Python interoperability

- **Browser authoring scope**: Command infrastructure, optimistic `scene_revision` drafts, WebSocket invalidation, and all nine binary decoders above are implemented; live two-way Python script buffer diff/sync in the hidden Ribbon `Automation` tab remains `Python-only`.
- **Primary surfaces**: Command Palette (`Ctrl+Shift+P`), Inspector **Apply** (`Ctrl+Shift+Enter`) / **Reset**, Footer **Logs** (HTTP/WS/Command audit), and Start Screen **Active simulations**.
- **Shared OpenAPI v2 & binary codecs**: `fullmag.live` (`fm.connect()`, `LiveSession`) drives HTTP resource endpoints compatible with the same OpenAPI v2 schema consumed by `ControlRoomApi`, and client binary decoders match the backend serializers used by `fullmag.client` (`fmvp`, `fmtb`).

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Command palette & command filtering | `apps/control-room/src/modules/overlay/CommandPaletteModule.tsx` | `CommandPaletteView` |
| Command palette shortcut registration | `apps/control-room/src/modules/overlay/manifest.ts` | `overlayManifest` |
| Inspector edit session contract | `apps/control-room/src/modules/inspector/InspectorEditSession.tsx` | `inspectorActionState` |
| Revision-pinned stage execution | `apps/control-room/src/modules/inspector/panels/studyStageApplyAndRun.ts` | `executeStageAfterApply` |
| Python live session & 10s heartbeat | `packages/fullmag-py/src/fullmag/live/_session.py` | `LiveSession` |
| Binary vector/scalar field codec | `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts` | `decodeFieldVector` |
| Binary FEM topology codec | `apps/control-room/src/kernel/api/codecs/topologyCodec.ts` | `FMMT_HEADER_LEN` |
| Binary FDM region mask codec | `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts` | `decodeFdmRegionMembership` |
