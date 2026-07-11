# P1 final control-path fix report

## Scope

This change repairs the two Important findings from the final P1 review only:

1. Ribbon visualization commands now receive the target already resolved from
   scene, manifest, and registry provenance.
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

### Correction after final re-review

The first version made every `mesh-part` selection resolve directly to a part.
That was too broad: it bypassed the canonical explicit `object_id` and
scene-validated `geometry_id` branches. The final implementation instead keeps
the generic selection resolver unchanged and gives commands an optional
`visualizationTarget` resolved by the Ribbon. The Ribbon supplies that target
only after applying the canonical resolver; without a manifest it still passes
the deliberate part-scoped fallback.

Focused regressions cover all target branches:

- a matching `targets.parts` entry wins;
- no part entry plus explicit `object_id` resolves to its object;
- no explicit object plus a scene-validated geometry alias resolves to its
  object;
- a missing manifest remains part-scoped.

### GREEN

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/selection/visualizationTargetResolver.test.ts src/kernel/visualization/ObjectVisualizationController.test.ts src/kernel/visualization/visualizationCommandContributions.test.ts src/modules/ribbon/ribbonStructure.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec eslint src/kernel/visualization/ObjectVisualizationController.ts src/kernel/visualization/visualizationCommandContributions.test.ts src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanelModel.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git diff --check
```

Result: 132 focused tests passed; TypeScript, targeted ESLint, and whitespace
validation passed.

## Implementation

- The Ribbon supplies its canonical target through `CommandContext`, so
  `visualization.target.set-*` and `visualization.target.clear-overrides`
  address exactly the target shown by the Ribbon without changing generic
  `object_id` or geometry-alias resolution.
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
