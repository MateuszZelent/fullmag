# Viewport3D Contract v1

Status: canonical  
Updated: 2026-04-23

## 1. Goal

Define one stable contract for all active 3D consumers in control room.

The contract consists of:

- `Viewport3DCapabilities`,
- `Viewport3DModel`,
- `Viewport3DToolbarState`.

## 2. Capability Source of Truth

`status.capabilities` is the only source of truth for 3D capability gating.

The adapter `status -> Viewport3DCapabilities` must not synthesize capability from:

- domain discretization labels,
- payload presence heuristics,
- local component-specific assumptions.

## 3. Required Models

### 3.1 `Viewport3DCapabilities`

Must expose at least:

- `can_render_3d`,
- `can_show_topology`,
- `can_show_structured_grid`,
- `can_show_vectors`,
- `can_show_scalar_history`,
- `algorithms_available`.

### 3.2 `Viewport3DModel`

Must carry resource-first runtime data needed by unified 3D host:

- selected quantity/component,
- topology and field revisions,
- selection state,
- clip state.

### 3.3 `Viewport3DToolbarState`

Toolbar options are always present in UI; unavailable options are disabled with explicit reason.
Fields:

- enablement booleans for quantity/component/clip/render-mode controls,
- deterministic disable reasons.

## 4. Adapter Boundaries

Adapters are mandatory and centralized:

- `statusToCapabilities`,
- `resourcesToViewportModel`,
- `runtimeToToolbarState`.

No React view component should recreate capability logic inline.

## 5. Compatibility

Legacy hosts may exist temporarily behind feature flags, but they must consume this
contract layer and are not allowed to introduce divergent capability rules.
