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

It bridges browser interaction with FullMag's underlying Rust/C++ solvers through OpenAPI v2 contracts, canonical `ProblemIR` representations, and real-time binary transport streams.

---

## Architectural Principles

```text
graph TD
    A["User Interactions (Ribbon / Explorer / Viewport / Inspector)"] --> B["Module Kernel & Registry"]
    B --> C["Zustand State Stores & Draft Isolation"]
    C --> D["OpenAPI v2 Client & SSE/WS Event Pipeline"]
    D --> E["FullMag Rust/C++ Backend Session Engine"]
    E --> F["Canonical ProblemIR Lowering & Validation"]
    F --> G["FDM & FEM CPU/GPU Solvers"]
    G --> H["Binary Vector Buffers & Realtime Metrics"]
    H --> I["Three.js / WebGL 3D Viewport & ECharts"]
```

1. **Physics-First Alignment**: The UI operates strictly on micromagnetic physical concepts (geometry, materials, physical interactions, discretization, stages) rather than exposing raw numerical memory offsets.
2. **Modular Kernel Architecture**: Feature areas are self-contained modules (`src/modules/*`) registered dynamically with the core shell.
3. **Explicit Draft Isolation**: Inspector property edits remain in an isolated draft state until committed by the user, preventing partial or corrupt configuration frames from reaching the active solver session.
4. **Hydration Hygeine & SSR Match**: Client components reading runtime state use `useSyncExternalStore` or hydration gates to guarantee first client render matches SSR.
5. **Token-First Design System**: Styling is governed by central `--fm-*` CSS tokens (Catppuccin Mocha for dark mode, Latte for light mode), Tailwind CSS, and shadcn/ui shared primitives.

---

## Module Kernel & Layout Slots

The Control Room shell layout is partitioned into flexible **Layout Slots** managed by `src/kernel/modules`:

```
apps/control-room/src/
├── kernel/              # Core shell runtime, layout manager, API client, event bus
│   ├── api/             # OpenAPI v2 client, generated types, binary codecs
│   ├── modules/         # Module registry, manifest resolver, slot contracts
│   └── state/           # Central session stores, selection, layout persistence
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
export const inspectorModuleManifest: ModuleManifest = {
  id: "inspector",
  name: "Inspector Panel",
  slots: [
    {
      slotId: "shell.right",
      component: InspectorShell,
      priority: 10,
    },
  ],
  commands: [
    {
      id: "inspector.apply-draft",
      label: "Apply Draft Changes",
      shortcut: "Ctrl+Enter",
    },
  ],
};
```

---

## Viewport 3D & WebGL Lifecycle

The 3D Viewport (`src/modules/viewport-3d`) renders geometric domains and 3D vector fields ($\mathbf{m}, \mathbf{H}_{\text{eff}}$) using **Three.js** and **React Three Fiber (R3F)**.

### Performance & Memory Safeguards

- **Instanced Mesh Glyphs**: Vector field arrows and cones are rendered using `THREE.InstancedMesh` with GPU instancing to achieve stable 60 FPS performance even for grids with $>10^6$ vector samples.
- **Binary ArrayBuffer Codecs**: Field samples stream directly from the backend over WebSocket/HTTP as unboxed `Float32Array` buffers, bypassing JSON parsing overhead.
- **Context Loss Recovery**: WebGL canvas lifecycle events (`webglcontextlost`, `webglcontextrestored`) are monitored to automatically restore shader resources without crashing the workspace.
- **Topology Caching**: FEM mesh element topologies and node coordinates are cached separately from per-step vector field data, avoiding redundant GPU geometry re-uploads during time integration.

---

## State Management & Invalidation Pipeline

Workspace state is maintained across three distinct tiers:

1. **Selection & Layout Store**: Tracks selected tree node IDs, panel visibility, ribbon tab index, and visual profile settings.
2. **Draft Property Store**: Holds transient uncommitted user edits in the Inspector before explicit application.
3. **Session & Runtime Store**: Synchronizes with the active backend session (`/v2/sessions/current/*`), listening to real-time SSE event channels for stage completions, metric updates, and field invalidations.

```
User Input ──> Draft Store ──(Apply Draft)──> Session API ──> SSE Event ──> Viewport Invalidated ──> GPU Redraw
```

---

## Technical Specifications

| Subsystem | Stack / Technology | Key Files |
|---|---|---|
| Framework | Next.js 16 (React 19) | `apps/control-room/package.json` |
| 3D Graphics | Three.js / @react-three/fiber | `apps/control-room/src/modules/viewport-3d/` |
| 2D Charting | ECharts / Recharts | `apps/control-room/src/modules/live-charts/` |
| State | Zustand / `useSyncExternalStore` | `apps/control-room/src/kernel/state/` |
| Transport | OpenAPI v2 (`openapi-fetch`), WebSocket, SSE | `apps/control-room/src/kernel/api/` |
| Styling | CSS Custom Properties (`--fm-*`), Tailwind | `apps/control-room/src/design/styles/` |
