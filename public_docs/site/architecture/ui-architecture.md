---
title: Control Room Architecture
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/frontend-v2/01-module-kernel-architecture.md, docs/specs/resource-first-control-room-api-v2.md, apps/control-room/src/modules/inspector/manifest.ts
---

(public-docs-architecture-ui-architecture)=
# Control Room Architecture

The **FullMag Control Room** (`apps/control-room`) is a modular, resource-first web application for
interactive micromagnetic problem authoring, WebGL visualization, and live runtime observation.
It uses the generated OpenAPI v2 transport, one handwritten `ControlRoomApi` facade, resource hooks,
and a WebSocket invalidation stream. Heavy mesh and field payloads remain on versioned HTTP binary
resources; WebSocket messages announce lifecycle changes and resource invalidation rather than
carrying an alternative state model.

## Architectural principles

```text
User interaction -> module kernel -> command/API facade -> v2 HTTP resources
                                           ^                    |
                                           |                    v
                                  WebSocket invalidation <- revision change
```

1. **Physical-model alignment**: the UI operates on geometry, materials, interactions,
   discretization, and stages rather than backend storage layouts.
2. **One module kernel**: feature areas under `src/modules/*` register with the shell and contribute
   to shared layout slots. FDM and FEM do not get separate application shells.
3. **Draft isolation**: Inspector edits remain local until an explicit command applies them.
4. **SSR hydration consistency**: client components reading external state use server snapshots or
   explicit hydration gates so the first client render matches SSR.
5. **Token-first design**: central `--fm-*` tokens, Tailwind utilities, and shared shadcn/ui-style
   primitives define the visual system.

## Module kernel and layout slots

The implemented source layout keeps kernel services separate from UI modules:

```text
apps/control-room/src/
|-- kernel/
|   |-- api/          # generated OpenAPI transport, facade, paths, binary codecs
|   |-- module/       # registry, manifests, slot contracts
|   |-- resources/    # revision-aware server-resource cache
|   |-- selection/    # selected semantic entity
|   |-- realtime/     # WebSocket invalidation bridge
|   `-- workspace/    # layout and workspace state
`-- modules/
    |-- ribbon/
    |-- explorer/
    |-- viewport-3d/
    |-- inspector/
    |-- live-charts/
    |-- status-bar/
    `-- app-menu/
```

Every UI module exports a `manifest.ts` with its identity, lazy component, slots, declared events,
optional capability gates, and optional command contributions. The implemented Inspector manifest
is:

```typescript
export const inspectorManifest: ModuleManifest = {
  id: "inspector",
  title: "Inspector",
  version: "0.1.0",
  slots: ["panel-right"],
  component: () => import("./InspectorModule"),
  contributes: {
    commands: [
      {
        id: "workspace.toggle-right-panel",
        title: "Toggle Inspector Panel",
        group: "workspace",
        category: "Window",
        scope: "workspace",
        run: (ctx) => {
          ctx.layout?.togglePanel("right");
          return { status: "completed" };
        },
      },
    ],
  },
  emits: ["viewport:mesh-size-bin-hovered"],
  listens: ["workspace:selection-changed"],
};
```

## Viewport and WebGL lifecycle

The 3D viewport under `src/modules/viewport-3d` renders geometry, meshes, and vector fields with
Three.js and React Three Fiber. Its lifecycle contract includes bounded render work, explicit
resource disposal, context-loss handling, and separation of topology uploads from changing field
values. Field and mesh samples are fetched from versioned HTTP binary resources and decoded into
typed arrays; they are not streamed as authoritative state over the event channel.

## State and invalidation

Control Room state has three distinct ownership classes:

1. **Selection and workspace state** tracks selected semantic IDs, layout, and presentation choices.
2. **Inspector drafts** hold transient uncommitted edits until an explicit command applies them.
3. **Server resources** are owned by revision-aware resource hooks and caches. Thin session status
   advertises revisions; WebSocket events invalidate affected keys, and hooks refetch authoritative
   HTTP resources.

```text
User input -> Draft -> Command -> HTTP resource revision -> WebSocket invalidation -> Refetch -> Redraw
```

## Implemented stack

| Subsystem | Stack / technology | Source area |
|---|---|---|
| Framework | Next.js 16, React 19 | `apps/control-room/package.json` |
| 3D graphics | Three.js, React Three Fiber | `apps/control-room/src/modules/viewport-3d/` |
| 2D charting | ECharts and chart modules | `apps/control-room/src/modules/live-charts/` |
| State | Zustand, resource hooks, `useSyncExternalStore` | `apps/control-room/src/kernel/resources/`, `selection/`, `workspace/` |
| Transport | OpenAPI v2 (`openapi-fetch`) and WebSocket invalidation | `apps/control-room/src/kernel/api/`, `realtime/` |
| Styling | `--fm-*` CSS tokens, Tailwind, shared primitives | `apps/control-room/src/design/styles/` |

The architecture described above is implemented in the current tree. Broader frontend lifecycle
and cutover qualification remain separate target gates and are not implied by this page status.
