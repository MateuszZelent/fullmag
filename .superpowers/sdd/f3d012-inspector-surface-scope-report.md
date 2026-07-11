# F3D-012 Inspector surface scope report

## Scope

The selected-target Inspector remains the owner of the Object surfaces matrix.
This task does not create a global visualization registry.

## Change

- Object and part selections show only mesh parts whose canonical target equals
  the selected target.
- Region selections use only the current manifest region `mesh_part_ids` carrier;
  memberships do not become mutable surface rows.
- Airbox selections show only `air` or `airbox` mesh parts.
- Toggling a row submits the vector visibility patch for the selected panel
  target, rather than resolving and mutating the clicked part target.

## Regression coverage

- A two-object manifest proves an Object A panel excludes Object B.
- Region and airbox selections prove their scoped carrier sets.
- Object, region, and airbox vector commands prove their patch scope matches the
  selected panel target.

## Verification

- `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`
- `pnpm --dir apps/control-room exec eslint src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanelModel.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
- `pnpm --dir apps/control-room typecheck`
