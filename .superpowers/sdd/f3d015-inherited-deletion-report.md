# F3D-015 review: inherited override deletion

## Scope reviewed

Read-only review of `18ad320c..9bc76d70`, limited to the F3D-015 contract:
semantic deletion/pruning, preservation of local-only preferences, child override
count/reset semantics, and API/transport scope.

## Important

### Backend-only child overrides can still be invisible and impossible to reset

`resolveChildRegionOverrideTargetIds` iterates only `childTargets`
(`ObjectVisualizationPanelModel.ts:1069-1080`).  Those targets are derived from
the currently loaded scene/manifest.  If an object has a backend-only region
override after reload while that region is not present in that render's
scene/manifest list, the count is zero.  The UI does not render the child-reset
surface unless `childRegionTargets.length > 0`
(`ObjectVisualizationPanel.tsx:1770` / `VisualizationOverridesSection:1202`),
and the handler returns before submitting its otherwise-correct owner-filtered
atomic replacement (`ObjectVisualizationPanel.tsx:1512-1513`).

This leaves precisely the backend-only override case called out by F3D-015
unobservable and unresettable.  Derive the count/reset eligibility from the
backend override list filtered by canonical owner as well as known child targets;
then use that same owner-filtered set for clearing local/pending overlays.

## Verified correct

- `removeTargetOverrideField` removes the serialized semantic field and prunes
  empty `display`, `style`, `quantity`, then empty entries.  Its mapping covers
  all serialized fields in `visualizationStateOverrideFromTargetPatch`; it leaves
  `primitiveVisible`, centering, and surface-offset local preferences untouched.
- The current `Inherited` command uses one complete replacement `overrides`
  list and removes the matching local/pending semantic field only after that
  patch is queued.
- `removeOwnerChildRegionVisualizationOverrides` filters the full backend list
  by decoded/canonical owner and therefore does not delete another owner's
  regions when invoked.
- The diff adds no OpenAPI, generated transport, route, or realtime-contract
  change.
- Focused regression suite passed: 3 files, 135 tests.

## Verdict

**Important issue found.** No Critical or Minor findings.

## Follow-up resolution

The count now derives owner-region ids from both the backend `overrides` list
and true local/pending overlays, even when the loaded child target list is
empty. The reset control is eligible from that count and sends the same
owner-filtered atomic replacement list. A regression covers a backend-only
`region:object-a:core` override with no child targets and preserves
`region:object-b:core`.

Focused verification after the follow-up: 3 files, 136 tests; typecheck and
targeted ESLint pass.
