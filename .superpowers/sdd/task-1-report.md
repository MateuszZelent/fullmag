# Task 1 Report: Airbox UI/Visualization Debug Contract

## Result

DONE_WITH_CONCERNS. The six Task 1 frontend-v2 specifications now define the
canonical Airbox target/carrier split, exact Explorer hierarchy and stable ids,
Inspector panel ownership, bounded demand-driven diagnostics, field evidence
separation, and the kernel observation-service boundary.

## Files changed

- `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- `docs/specs/frontend-v2/11-explorer-view.md`
- `docs/specs/frontend-v2/13-inspector-and-property-editing.md`
- `docs/specs/frontend-v2/17-performance-memory-profiler.md`
- `docs/specs/frontend-v2/23-per-object-visualization-control.md`
- `docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md`

No source or test file was edited, staged, or committed. Existing changes in
`23-per-object-visualization-control.md` were preserved and extended in place.

## Prerequisite identity/stability audit

The current dirty diff contains the prerequisite identity implementation:

- `display.rs` filters synthetic Airbox objects and air-role carriers from the
  target registry, retains only orphan part fallbacks, and canonicalizes legacy
  Airbox overrides.
- `router_v2/tests.rs` asserts one canonical `airbox`, no synthetic/air carrier
  target, one orphan fallback, and legacy-override precedence/migration.
- `visualizationTargetResolver.ts` resolves roles `air` and `airbox` to the
  canonical `{kind: "airbox", id: "airbox"}` before registry part lookup; its
  focused test covers a stale `part:__air__` registry entry.
- Existing viewport tests cover the Airbox scoped query with
  `scope_kind=airbox`, `scope_id=part:__air__`, demand planning, decoded field
  adoption, and vector render planning. The Debug specs now state that target
  registry filtering, role-first resolution, and the canonical Airbox vector
  path are prerequisites to enabling Debug.

These prerequisite edits are present in the shared dirty worktree but are not
committed by this task.

## Contract evidence

- Explorer spec records the exact Airbox/Object/Region Visualization Debug tree,
  stable node ids, retained legacy ids, removal of the duplicate global Airbox
  Quality node, and no-fetch Debug badges.
- Inspector spec assigns distinct Airbox panels and the shared read-only
  `VisualizationDebugPanel` to all three Debug selection kinds.
- Performance spec caps snapshots at 64 KiB, samples at 12 points and 8
  components, issues at 20, matched requests at 8, requires zero heavy FMVP
  requests on open, and defines zero work when closed.
- Visualization-control spec states `airbox` is the user target and
  `part:__air__` its carrier, with Debug observing the former and reporting the
  latter separately.
- Field-data spec separates requested query, decoded payload, rendered derived
  data, and backend metadata, including compatibility and evidence-source rules.
- Module-kernel spec defines `VisualizationDebugController` as bounded,
  demand-driven observation only, not server state/cache/transport, with HTTP v2
  authoritative and WebSocket invalidation-only.

## Verification commands and output

Command:

```text
rg -n "airbox\.visualization\.debug|VisualizationDebugController|64 KiB" docs/specs/frontend-v2
```

Output:

```text
docs/specs/frontend-v2/01-module-kernel-architecture.md:114:`VisualizationDebugController` is a kernel-owned, opt-in diagnostic observation
docs/specs/frontend-v2/01-module-kernel-architecture.md:124:bodies. It enforces bounded lists and a 64 KiB serialized snapshot limit.
docs/specs/frontend-v2/23-per-object-visualization-control.md:69:The separate `VisualizationDebugController` is likewise not a visualization
docs/specs/frontend-v2/17-performance-memory-profiler.md:31:`VisualizationDebugController` snapshot is capped at **64 KiB**. Per snapshot,
docs/specs/frontend-v2/13-inspector-and-property-editing.md:52:| `airbox.visualization.debug` | `VisualizationDebugPanel` |
```

Command:

```text
git diff --check -- docs/specs/frontend-v2/01-module-kernel-architecture.md docs/specs/frontend-v2/11-explorer-view.md docs/specs/frontend-v2/13-inspector-and-property-editing.md docs/specs/frontend-v2/17-performance-memory-profiler.md docs/specs/frontend-v2/23-per-object-visualization-control.md docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md
```

Output: empty; exit code 0.

Command:

```text
git diff --stat -- docs/specs/frontend-v2/01-module-kernel-architecture.md docs/specs/frontend-v2/11-explorer-view.md docs/specs/frontend-v2/13-inspector-and-property-editing.md docs/specs/frontend-v2/17-performance-memory-profiler.md docs/specs/frontend-v2/23-per-object-visualization-control.md docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md
```

Output at verification time:

```text
 .../frontend-v2/01-module-kernel-architecture.md   | 23 +++++++++++++
 docs/specs/frontend-v2/11-explorer-view.md         | 39 ++++++++++++++++++++++
 .../13-inspector-and-property-editing.md           | 23 +++++++++++++
 .../frontend-v2/17-performance-memory-profiler.md  | 24 +++++++++++++
 .../23-per-object-visualization-control.md         | 23 +++++++++++++
 .../25-viewport-3d-field-data-architecture.md      | 23 +++++++++++++
 6 files changed, 155 insertions(+)
```

The `23` count includes prerequisite identity text already present in the dirty
worktree before this task.

## Self-review

- Every added rule traces to Task 1 or the governing debug plan.
- The specs preserve resource-first ownership: no endpoint, status payload, or
  WebSocket snapshot transport was introduced.
- The controller is explicitly non-authoritative and zero-work without demand.
- Airbox target and carrier identities are not conflated.
- Existing stable command-facing ids remain unchanged.
- Markdown whitespace validation passes.

## Concerns

- The prerequisite identity/stability implementation remains uncommitted in a
  shared dirty worktree. Task 1 correctly makes Debug conditional on it, but a
  later worker must ensure those prerequisite edits and focused tests survive
  integration.
- This was a documentation-only task. No Rust or frontend tests were run; the
  brief's specified verification was the exact `rg` contract search, supplemented
  by `git diff --check` and code/test diff inspection.

## Fix Review

Addressed all Task 1 review findings:

- added the canonical typed KernelApi property
  `readonly visualizationDebug: VisualizationDebugController` and its type-only
  import context;
- defined the 64 KiB limit as serialized JSON UTF-8 byte length using
  `TextEncoder`, not JavaScript string length;
- made separate reporting of the Airbox `part:__air__` carrier mandatory.

Command:

```text
rg -n "airbox\.visualization\.debug|VisualizationDebugController|64 KiB" docs/specs/frontend-v2
```

Result (exit code 0):

```text
docs/specs/frontend-v2/01-module-kernel-architecture.md:100:import type { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
docs/specs/frontend-v2/01-module-kernel-architecture.md:109:  readonly visualizationDebug: VisualizationDebugController;
docs/specs/frontend-v2/01-module-kernel-architecture.md:117:`VisualizationDebugController` is a kernel-owned, opt-in diagnostic observation
docs/specs/frontend-v2/01-module-kernel-architecture.md:127:bodies. It enforces bounded lists and a 64 KiB serialized snapshot limit.
docs/specs/frontend-v2/23-per-object-visualization-control.md:70:The separate `VisualizationDebugController` is likewise not a visualization
docs/specs/frontend-v2/13-inspector-and-property-editing.md:52:| `airbox.visualization.debug` | `VisualizationDebugPanel` |
docs/specs/frontend-v2/17-performance-memory-profiler.md:31:`VisualizationDebugController` snapshot is capped at **64 KiB** measured as the
```

Command:

```text
git diff --check -- docs/specs/frontend-v2/01-module-kernel-architecture.md docs/specs/frontend-v2/11-explorer-view.md docs/specs/frontend-v2/13-inspector-and-property-editing.md docs/specs/frontend-v2/17-performance-memory-profiler.md docs/specs/frontend-v2/23-per-object-visualization-control.md docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md
```

Result: no output; exit code 0.
