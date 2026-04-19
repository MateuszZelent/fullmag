# ADR 0010: Magnetization Changes Do Not Invalidate Mesh Topology

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-19 |
| Deciders  | Frontend team, solver team |
| Relates   | `apps/web/features/interaction/model/dirtyGraph.ts` |

## Context

Magnetization configuration (preset kind, direction, seed, texture transform) defines the initial state of the magnetic field on the mesh. It does **not** affect the mesh topology itself — changing from Uniform to Vortex magnetization does not require rebuilding the finite element mesh.

Previous implementations sometimes coupled magnetization changes to mesh rebuilds, creating unnecessary delays.

## Decision

When a magnetization asset is modified:

| Artifact | New Status |
|---|---|
| geometry | unchanged |
| airbox | unchanged |
| mesh | **unchanged** |
| initialState | stale |
| results | stale (or missing) |

The mesh remains valid. Only the initial state (field values sampled on the mesh) needs re-realization.

### Exception

If a future magnetization feature affects discretization requirements (e.g., adaptive mesh refinement based on domain wall width), that specific feature must opt-in to mesh invalidation explicitly. The default path does not invalidate mesh.

## Implementation

- `dirtyGraphReducer` handles `magnetization.changed` — updates `initialState` to stale, leaves `mesh` untouched.
- `deriveRunGate` shows "Realize Initial State" action when initial state is stale but mesh is valid.

## Consequences

**Positive:** Faster magnetization iteration. Users can change presets without waiting for mesh rebuild.

**Negative:** Users must still click "Realize Initial State" after magnetization changes. This is the correct behavior — realization samples the field on the mesh and should be an explicit step.
