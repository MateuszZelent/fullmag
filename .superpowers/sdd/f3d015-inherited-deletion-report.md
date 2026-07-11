# F3D-015 inherited override deletion

## Scope

Implemented the audited F3D-015 contract for visualization target overrides.

- `Inherited` removes `style.surface_color_source` from the current serialized
  target override rather than writing `undefined` into a merge patch.
- Empty `style`, `display`, `quantity`, and then empty target entries are pruned.
- Child-region override state combines the backend resource with local/pending
  overlays and deduplicates canonical target ids.
- Reset emits one replacement `overrides` list that removes only regions owned
  by the selected object.

## Regression evidence

RED was observed before implementation: the `Inherited` command produced an
override still containing `style.surface_color_source: component_x`.

Focused verification after the fix:

```text
pnpm --dir apps/control-room exec vitest run \
  src/kernel/visualization/ObjectVisualizationController.test.ts \
  src/kernel/visualization/visualizationCommandContributions.test.ts \
  src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
# 3 files, 135 tests passed

pnpm --dir apps/control-room typecheck
# passed

pnpm --dir apps/control-room exec eslint <changed F3D-015 files> --max-warnings=0
# passed
```

No API schema, generated transport, resource family, or realtime event changed:
the existing visualization-state PATCH already owns atomic replacement of the
`overrides` resource.
