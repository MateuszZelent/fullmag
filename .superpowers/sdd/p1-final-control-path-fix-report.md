# P1 final control-path fix report

## Scope

This change repairs the two Important findings from the final P1 review only:

1. Visualization commands now preserve an explicit `mesh-part` selection as a
   `part` target even when the selection also carries its owning `objectId`.
2. Inspector part-vector visibility now uses the same bounded pending-target
   transaction as the primary target patch path.

No endpoint, transport, OpenAPI type, resource ownership, or module boundary
changed.

## TDD evidence

### RED

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationCommandContributions.test.ts
```

The added mesh-part command regression failed: an owning object received the
override instead of `part:part-film`.

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
```

The added part-vector transaction regression failed because
`queuePartVectorVisibilityPatch` did not exist. The missing behavior was an
optimistic local pending override paired with the queued registry patch.

### GREEN

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationCommandContributions.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec eslint src/kernel/visualization/ObjectVisualizationController.ts src/kernel/visualization/visualizationCommandContributions.test.ts src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanelModel.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git diff --check
```

Result: 58 focused tests passed; TypeScript, targeted ESLint, and whitespace
validation passed.

## Implementation

- `resolveVisualizationTargetFromSelection` now gives `selection.ref.type ===
  "mesh-part"` precedence over the generic `objectId` fallback. This makes
  `visualization.target.set-*` and `visualization.target.clear-overrides`
  address exactly the target shown by the Ribbon and keeps missing-manifest
  selections safely part-scoped.
- `queuePartVectorVisibilityPatch` centralizes the inspector's mesh-part
  vector control: it resolves the canonical target, queues the backend-owned
  override, and calls `patchTargetPending` using the visualization resource
  revision.
- The regression verifies the immediate visual state is false while the old
  registry revision is present and returns to the registry value only after a
  newer revision acknowledges the pending patch.

## Scope hygiene

The worktree contains unrelated pre-existing SDD report edits and dependency
symlinks. They were neither modified nor staged by this task.
