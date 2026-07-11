# F3D-016 local viewport preference ownership

## Decision

`primitiveVisible`, `vectorCenteringEnabled`,
`vectorSurfaceOffsetEnabled`, and `vectorSurfaceOffsetScale` are client-owned
viewport rendering preferences. The airbox-only developer vector fallback is
owned by the same local preference model. None is a public visualization target
override, so this change requires no backend or OpenAPI contract change.

## Implementation

- Replaced `localRenderOverrides` with explicit `viewportPreferences` and
  `viewportPreferenceDefaults` in `ObjectVisualizationController`.
- Kept local preferences out of persistent target/default patches and out of
  pending backend acknowledgement overlays.
- Applied preferences in the resolver only after HTTP-backed settings.
- Routed Inspector, Ribbon and visualization commands through the explicit local
  preference methods; persistent fields still use the existing HTTP v2 resource
  path.
- Added the Inspector message: “This viewport only — not saved to the simulation
  or shared with other clients.”

## Verification

- RED: new controller tests failed because `patchViewportPreferences` did not
  exist.
- GREEN: `pnpm --dir apps/control-room exec vitest run
  src/kernel/visualization/ObjectVisualizationController.test.ts
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts
  src/modules/ribbon/ribbonStructure.test.ts
  src/kernel/visualization/visualizationCommandContributions.test.ts`
  — 156 tests passed.
- `pnpm --dir apps/control-room lint -- <changed files>` passed with zero warnings.
- `pnpm --dir apps/control-room typecheck` passed.

## Policy proof

The controller test verifies that an HTTP-backed persistent `visible` setting is
shared by two client controllers, while a local primitive/centering preference is
visible only in the initiating controller and disappears on controller reload.
