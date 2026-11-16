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

It bridges browser interaction with FullMag's underlying Rust/C++ solvers and `fullmag.live`
Python sessions through **OpenAPI v2** JSON control-plane contracts, canonical `ProblemIR`
lowering, HTTP binary data-plane codecs, and WebSocket invalidation events.

---

## Architectural Principles

```
User Interactions / Live Python (`fm.connect`)
   ──> Authoring Transaction (`scene_revision` fenced) or Control Command
   ──> OpenAPI v2 Session API & Canonical ProblemIR Lowering
   ──> WebSocket Revision Invalidation ──> Scoped Resource Cache Invalidation
   ──> HTTP Binary Data Plane (`FMVP` / `FMMT` / `FMRM` / `FMCS` / `FMTB` / `FMMQ`)
   ──> Three.js R3F 3D Viewport, 2D Field Map & ECharts Plots
```

1. **Physical-Model Alignment**: The UI operates on micromagnetic domain concepts (`object_id`, regions, materials, physical interactions, discretization, and stages) rather than mixing UI display names with solver behavior.
2. **Modular Kernel Architecture**: Feature areas are self-contained modules (`src/modules/*`) registered dynamically into kernel layout slots (`src/kernel/module`).
3. **Explicit Draft Isolation & Conflict Fencing**: Inspector property edits stay in isolated draft stores (`"staged"`, `"liveViewport"`, or `"immediate"`) until committed with `scene_revision` preconditions so neither partial drafts nor concurrent Python writes overwrite state silently.
4. **SSR Hydration Consistency**: Client components reading runtime, tab-route, or theme stores use `useSyncExternalStore` or hydration gates so the first client render matches server-rendered HTML.
5. **Token-First Design System**: Central `--fm-*` CSS custom properties (`theme.css`) implement Catppuccin **Mocha** (`data-theme="dark"`) and Catppuccin **Latte** (`data-theme="light"`), paired with Tailwind utilities and shadcn/Radix shared primitives.

---

## Shell Routing, Module Kernel & Layout Slots

Browser URL routing (`src/kernel/layout/tabRoutes.ts`, `InstanceTabStrip.tsx`) supports `/home`
(non-blocking Start Screen overlay preserving mounted sessions), `/session/<slug>`,
`/session/<slug>?port=<port>`, and `/instance/<port>` for switching seamlessly across parallel
local instances or Docker Compose development groups.

The Control Room shell layout partitions responsibilities across `kernel/` and `modules/`:

```
apps/control-room/src/
├── kernel/              # Core shell runtime, layout, API client, event bus, codecs
│   ├── api/             # OpenAPI v2 client, generated types, binary codecs (FMVP/FMMT/FMRM/FMCS/FMTB/FMMQ...)
│   ├── authoring/       # History mutations, quantity fields, draft guards
│   ├── commands/        # CommandRegistry, shortcuts, diagnostics, workspace policy
│   ├── layout/          # InstanceTabStrip, tabRoutes, AppMenuBar, layout persistence
│   ├── module/          # Module registry, manifest resolver, slot contracts
│   ├── realtime/        # WebSocket RealtimeClient & RealtimeInvalidationBridge
│   ├── resources/       # Revision-aware resource hooks, cache scoping, invalidation
│   └── selection/       # Unified selection controller across tree, 3D, 2D & plots
└── modules/             # Self-contained UI feature modules
    ├── start/           # Start Screen hub (/home), templates, import, recent work, instance discovery
    ├── ribbon/          # Discretization-aware Ribbon tabs & placeholder stripping
    ├── explorer/        # Five-tab semantic browser (Model, Resources, Results, Jobs, Diagnostics)
    ├── inspector/       # InspectorRegistry, route catalog & domain-specific semantic panels
    ├── viewport-3d/     # WebGL/Three.js R3F scene, studio HDRI & transparent/view PNG capture
    ├── field-map/       # 2D planar probe map, streamlines/contours, multislice & snapshot replay
    ├── live-charts/     # Real-time ECharts magnetization, energy & convergence traces
    ├── analysis-plots/  # ECharts dispersion, S(k,f) heatmap, Gamma FFT, FMR & hysteresis charts
    ├── analysis-*/      # Analysis feature modules (dispersion, hysteresis, resonance)
    ├── results-navigator/ # Durable SolutionSet browser & saved-result playback
    ├── overlay/         # Command Palette (Ctrl+Shift+P), MeshBuildDialog, notifications
    ├── footer/          # Bottom dock (Logs, Telemetry, Diagnostics, Engine, Operations/Mesh Jobs, Problems, Quick Chart)
    └── status-bar/      # Live session state, readiness helper, mesh/compute progress
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
