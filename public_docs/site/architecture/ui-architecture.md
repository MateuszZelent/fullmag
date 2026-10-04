---
title: Control Room Architecture
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-architecture-ui-architecture)=
# Control Room Architecture

The **FullMag Control Room** (`apps/control-room`) is built as a modular, resource-first web application designed for interactive micromagnetic problem authoring, high-throughput WebGL visualization, and live runtime observation.

It bridges browser interaction with FullMag's underlying Rust/C++ solvers through OpenAPI v2 contracts, canonical `ProblemIR` representations, and HTTP binary resources and WebSocket invalidation events.

---

## Architectural Principles

```text
graph TD
    A["User Interactions (Ribbon / Explorer / Viewport / Inspector)"] --> B["Module Kernel & Registry"]
    B --> C["Resource Controllers & Draft Isolation"]
    C --> D["OpenAPI v2 HTTP Client & WebSocket Invalidation"]
    D --> E["FullMag Rust/C++ Backend Session Engine"]
    E --> F["Canonical ProblemIR Lowering & Validation"]
    F --> G["FDM & FEM CPU/GPU Solvers"]
    G --> H["Binary Vector Buffers & Realtime Metrics"]
    H --> I["Three.js / WebGL 3D Viewport & ECharts"]
```

1. **Physical-Model Alignment**: The UI operates on micromagnetic domain concepts (geometry, materials, physical interactions, discretization, and stages) rather than exposing numerical storage details.
2. **Modular Kernel Architecture**: Feature areas are self-contained modules (`src/modules/*`) registered dynamically with the core shell.
3. **Explicit Draft Isolation**: Inspector property edits remain in an isolated draft state until committed by the user, preventing partial or corrupt configuration frames from reaching the active solver session.
4. **SSR Hydration Consistency**: Client components reading runtime state use `useSyncExternalStore` or hydration gates so the first client render matches the server-rendered state.
5. **Token-First Design System**: Styling is governed by central `--fm-*` CSS tokens (Catppuccin Mocha for dark mode, Latte for light mode), Tailwind CSS, and shadcn/ui shared primitives.

---

## Module Kernel & Layout Slots

The Control Room shell layout is partitioned into flexible **Layout Slots** managed by `src/kernel/module`:

```
apps/control-room/src/
├── kernel/              # Core shell runtime, layout manager, API client, event bus
│   ├── api/             # OpenAPI v2 client, generated types, binary codecs
│   ├── module/          # Module registry, manifest resolver, slot contracts
│   ├── resources/       # Revision-aware resource hooks and invalidation
│   ├── selection/       # Selection controller
│   └── layout/          # Layout controller and persistence
└── modules/             # Self-contained UI feature modules
    ├── ribbon/          # Header strip tabs & command groups
    ├── explorer/        # Semantic tree model browser
    ├── viewport-3d/     # WebGL canvas, Three.js scene, vector field shaders
    ├── inspector/       # Property panel, draft editor, unit converters
    ├── live-charts/     # ECharts time-series & energy component graphs
    ├── status-bar/      # Session state, solver engine, device metrics
    └── app-menu/        # Command palette (Ctrl+K) & workspace settings
```

### Module Manifest Contract

Every UI module exports a standardized `manifest.ts` defining its identity, contributed layout slots, menu actions, and ribbon buttons:

```typescript
import type { ModuleManifest } from "@/kernel/types";

export const inspectorManifest: ModuleManifest = {
  id: "inspector",
  title: "Inspector",
  version: "0.1.0",
  slots: ["panel-right"],
  component: () => import("./InspectorModule"),
};
```

This is the minimal shape from `inspectorManifest`; command contributions belong under
`contributes.commands`, with a `run` handler. Slot identifiers are the `SlotId` union;
`"shell.right"` is not a supported slot.

---

## Viewport 3D & WebGL Lifecycle

The 3D Viewport (`src/modules/viewport-3d`) renders geometric domains and 3D vector fields ($\mathbf{m}, \mathbf{H}_{\text{eff}}$) using **Three.js** and **React Three Fiber (R3F)**.

### Performance & Memory Safeguards

- **Instanced Mesh Glyphs**: Vector field arrows and cones are rendered using `THREE.InstancedMesh` with GPU instancing to reduce draw-call overhead for large vector datasets.
- **Binary ArrayBuffer Codecs**: Field samples are fetched as scoped HTTP binary resources. `decodeFieldVector` validates the FMVP header, component count, revisions, indexing and an FP64 payload, then exposes a `Float64Array`. Renderer-side GPU buffers are a separate representation. WebSocket events invalidate resources; they do not carry the field arrays.
- **Context Loss Recovery**: WebGL canvas lifecycle events (`webglcontextlost`, `webglcontextrestored`) are monitored so rendering resources can be reconstructed after context restoration.
- **Topology Caching**: FEM mesh element topologies and node coordinates are cached separately from per-step vector field data, avoiding redundant GPU geometry re-uploads during time integration.

---

## State Management & Invalidation Pipeline

Workspace state is maintained across three distinct tiers:

1. **Selection & Layout Store**: Tracks selected tree node IDs, panel visibility, ribbon tab index, and visual profile settings.
2. **Draft Property Store**: Holds transient uncommitted user edits in the Inspector before explicit application.
3. **Session & Runtime Store**: Synchronizes with the active backend session (`/v2/sessions/current/*`), listening to WebSocket revision/invalidation events for stage completions, metric updates, and field invalidations.

```
User Input ──> Draft Store ──(Apply Draft)──> Session API ──> WebSocket Event ──> Viewport Invalidated ──> GPU Redraw
```

---

## Technical Specifications

| Subsystem | Stack / Technology | Key Files |
|---|---|---|
| Framework | Next.js 16 (React 19) | `apps/control-room/package.json` |
| 3D Graphics | Three.js / @react-three/fiber | `apps/control-room/src/modules/viewport-3d/` |
| 2D Charting | ECharts / Recharts | `apps/control-room/src/modules/live-charts/` |
| State | Controllers / resource hooks / `useSyncExternalStore` | `apps/control-room/src/kernel/resources/`, `selection/`, `layout/` |
| Transport | OpenAPI v2 (`openapi-fetch`), HTTP resources and WebSocket events | `apps/control-room/src/kernel/api/` |
| Styling | CSS Custom Properties (`--fm-*`), Tailwind | `apps/control-room/src/design/styles/` |
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

| Claim | Repository path | Stable symbol |
|---|---|---|
| Module and slot contracts | `apps/control-room/src/kernel/types.ts` | `ModuleManifest`, `SlotId` |
| Actual Inspector manifest | `apps/control-room/src/modules/inspector/manifest.ts` | `inspectorManifest` |
| HTTP resource facade | `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `ControlRoomApi` |
| WebSocket transport | `apps/control-room/src/kernel/realtime/RealtimeClient.ts` | `RealtimeClient` |
| Event-to-resource invalidation | `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts` | `RealtimeInvalidationBridge` |
| Resource revision ownership | `apps/control-room/src/kernel/resources/ResourceInvalidationController.ts` | `ResourceInvalidationController` |
| FP64 field decoding | `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts` | `decodeFieldVector` |

These are source-level implementation references. This documentation review does not establish
browser/WebGL execution or solver qualification.
