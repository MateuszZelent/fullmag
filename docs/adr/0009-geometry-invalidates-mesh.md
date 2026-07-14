# ADR 0009: Geometry Changes Invalidate Mesh

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-19 |
| Deciders  | Frontend team, solver team |
| Relates   | `apps/web/features/interaction/model/dirtyGraph.ts`, `apps/web/features/interaction/model/runGate.ts` |

## Context

Fullmag follows a COMSOL-style workflow: Geometry → Mesh → Study → Results. Changes to geometry invalidate the mesh, which invalidates the initial state, which invalidates results. The UI must make this dependency chain explicit so users know why their Run button is blocked.

## Decision

When a geometry change is committed (Apply from the Geometry inspector), the dirty graph marks:

| Artifact | New Status |
|---|---|
| geometry | valid (new revision) |
| airbox | stale |
| mesh | stale (or missing if never built) |
| initialState | stale (or missing) |
| results | stale (or missing) |

The **RunGate** derives from the dirty graph that run/relax is blocked until mesh and initial state are rebuilt.

Region edits use the same backend classifier as scene commits; the scene journal
revision is not a substitute for realization identity:

| Mutation | FDM grid/topology | FEM conformal mesh | Membership | Coefficients | Initial state |
|---|---|---|---|---|---|
| rename/label only | unchanged | unchanged | unchanged | unchanged | unchanged |
| material override | unchanged | unchanged | unchanged | stale | unchanged |
| texture/magnetization override | unchanged | unchanged | unchanged | unchanged | stale |
| shape/frame/enabled/priority | stale when owner occupancy changes | stale/new generation | stale | stale when resolved fields change | stale when mask changes |
| mesh/realization policy | stale | stale/new generation | stale | stale when materialization changes | stale when mask changes |
| delete/duplicate/reorder | stale if object/region identity changes | stale/new generation | stale | stale | stale |

The old mesh may remain visible for inspection, but it must be labelled
`stale` and cannot satisfy a current run precondition. A current realized mesh
requires matching topology/generation identity and the independent region
membership/coefficient/initial-state revisions. Websocket events only invalidate
resource keys; the HTTP v2 resource snapshot remains authoritative.

### Rules

1. Geometry changes always invalidate mesh topology.
2. Airbox realization depends on geometry (bounding box).
3. Mesh build clears mesh and airbox staleness but makes initial state stale (new topology).
4. Initial state realization clears initial state staleness.
5. Mesh build does **not** auto-trigger. The user must explicitly click "Build Mesh."

## Implementation

- `dirtyGraphReducer` handles `geometry.changed` action.
- `deriveRunGate(dirtyGraph)` returns blockers with actionable commands (e.g., "Build Mesh" → `mesh.build.all`).
- The UI shows blockers in the Run panel with one-click fix buttons.

## Consequences

**Positive:** Users always know why Run is blocked and what to do about it. No hidden auto-builds.

**Negative:** More clicks for geometry iteration. Mitigated by clear blocker messages and one-click actions.
