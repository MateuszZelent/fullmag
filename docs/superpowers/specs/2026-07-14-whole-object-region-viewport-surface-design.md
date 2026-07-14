# Whole-object region viewport surface repair

## Problem

The backend publishes valid magnetization data for `m` and component `x`, but the 3D viewport does not request or render it for ferromagnetic objects. The scene model currently maps every manifest region to a region visualization target. Material regions that describe an entire object therefore inherit the default hidden subregion settings and suppress the object's surface pass before field loading begins.

## Decision

Keep the object visualization target authoritative when a manifest region represents the same whole object. A region is whole-object when its canonical source-region candidate identifies its sole owning source object. Such a region must not replace the mesh part's object target.

Continue mapping genuine subregions to independent region targets. Their visibility, shader, vector, and field settings remain independently controllable.

This is a frontend scene-target classification repair. It does not change the backend field endpoint, OpenAPI contract, field binary format, solver semantics, or visualization defaults.

## Data flow

1. The topology manifest supplies mesh parts, source object IDs, and region candidates.
2. Scene-model target resolution classifies genuine subregions by mesh-part ID.
3. Whole-object material regions are excluded from that subregion lookup.
4. Their primary magnetic mesh parts resolve through existing object settings.
5. Enabled object surface passes create the existing scoped field demand.
6. Component X uses the existing `m` request with `component=x` and renders the returned nodal values.

## Error and lifecycle boundaries

The repair must not mask missing or invalid field data. Existing unavailable/error states remain unchanged. The reported React maximum-update-depth failure is verified after restoring the magnetic surface; it is fixed separately only if the browser reproduction still triggers it, so target classification and R3F lifecycle concerns are not conflated without evidence.

## Verification

1. Add a failing unit test proving that a whole-object region is omitted from the part-to-region target map.
2. In the same focused coverage, prove that a genuine subregion is still mapped.
3. Run the focused scene-model test after the minimal implementation.
4. Run a managed mixed-target browser scenario and verify:
   - an `m` field request with `component=x` occurs for the selected ferromagnetic target;
   - the ferromagnetic surface is visibly rendered;
   - no `Maximum update depth exceeded` error occurs;
   - the canvas is visible, `gl.isContextLost()` is false, and the drawing buffer is non-zero.
5. Run Control Room typecheck, lint with zero warnings, the full test suite, viewport performance/memory gates, and React Doctor.

## Acceptance criteria

- Whole-object regions no longer hide their owning ferromagnetic object.
- Real subregions retain independent visualization behavior.
- Component X is requested as `m?component=x` through the existing typed resource path.
- The displayed range remains derived from backend data; no hardcoded range or fallback geometry is introduced.
- Browser and repository quality gates pass without weakening visualization quality.

## Out of scope

- Backend magnetization computation changes.
- API or binary codec changes.
- Broad scene-model refactoring.
- Changing default visibility of genuine subregions.
