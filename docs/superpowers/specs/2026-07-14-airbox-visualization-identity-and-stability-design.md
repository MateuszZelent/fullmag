# Airbox Visualization Identity and Stability Design

**Status:** Manifest-ownership revision proposed
**Date:** 2026-07-14
**Revised:** 2026-07-15

## Problem

The control room currently exposes one physical Airbox through three visualization identities:

- `object:__air__`, originating from a synthetic solver object;
- `part:__air__`, originating from the FEM mesh carrier;
- `airbox`, the canonical product-level visualization target.

This violates `docs/specs/frontend-v2/23-per-object-visualization-control.md`. It also lets UI actions write an override for a target that the viewport does not use. In particular, enabling vectors on the mesh-part or synthetic-object duplicate does not enable the canonical Airbox vector layer.

The same interaction path contains three adjacent defects observed in the browser:

- Airbox histogram hover requests use the nonexistent mesh part id `airbox`, producing 404 responses;
- Recharts tooltip payload identity changes can repeatedly emit identical hover events, while the viewport stores every event as new React state, producing a maximum-update-depth loop and excessive animation-frame/reflow work;
- the API connection dialog does not explicitly connect its description to `DialogContent`, producing a Radix accessibility warning.

A later production manifest exposed a fourth identity defect. The same realized
air domain is published as both:

- a mesh part with `id=part:__air__`, `role=air`, and no `object_id` or
  `geometry_id`;
- an object segment with `object_id=__air__`.

The frontend ownership resolver compares only mesh-part `object_id` and
`geometry_id`, so it does not recognize these records as two representations of
one Airbox. It then rewrites the segment to `segment:__air__:<index>` with a
magnetic role. That derived identity is no longer recognized as Airbox and is
incorrectly exposed as an unassigned mesh part and a degraded magnetic render
carrier.

## Canonical identity contract

`airbox` is the only user-facing visualization target for the exterior air domain.

- `object:__air__` is an internal solver compatibility identity. It must not appear in `visualization/state.targets.objects` and must not receive new visualization overrides.
- A mesh part whose role is `air` or `airbox` is a data-plane carrier. It must not appear in `visualization/state.targets.parts`.
- An object segment whose `object_id` or `geometry_id` is a reserved Airbox
  identity is another data-plane representation of the same target. Rewriting
  its carrier id must not erase its semantic Airbox ownership.
- `part:<id>` remains a valid transport identifier for topology, histogram-bin membership, and field-sample requests.
- Other mesh parts are published as visualization fallbacks only when they do not resolve to an authored scene object.
- UI selection of an air-role mesh part resolves to the canonical `airbox` target even if an older backend still publishes the part incorrectly.

## Manifest carrier ownership normalization

The frontend establishes ownership once at the manifest boundary and reuses the
result for Explorer addressing, viewport carrier selection, topology freshness,
and render-carrier diagnostics.

Airbox identity is derived from all ownership-bearing fields:

- carrier `id`;
- carrier `role`;
- `object_id`;
- `geometry_id`.

The reserved ids `airbox`, `__air__`, and `__airbox__`, including existing
`part:` and `object:` transport prefixes, resolve to one canonical Airbox
ownership alias. The ordinary unreserved name `air` does not become Airbox by
name alone; it requires the explicit `air` or `airbox` role. This prevents an
authored object named `air` from being captured accidentally.

When a field-capable Airbox mesh part and an Airbox object segment coexist, the
mesh part owns the render address and the segment is treated as its duplicate.
It must not create a second Explorer node, magnetic carrier, picking target, or
`mixed` carrier diagnostic.

When the manifest has no matching Airbox mesh part, the object segment remains
available as a degraded, non-field-capable Airbox carrier. Its visible label is
`Airbox`; it resolves to `model:airbox`, returns no scene-object id, and never
appears under `Unassigned mesh parts`. This preserves degraded topology display
without inventing a magnetic object.

Legitimate unowned magnetic segments keep their current behavior and remain
explicit fallback targets. Universe outer-boundary carriers remain excluded.

## Override normalization

The v2 visualization resource normalizes legacy Airbox overrides before exposing or accepting state:

1. canonical `scope=airbox, scope_id=airbox` wins when present;
2. otherwise a legacy air-part override is converted to the canonical scope;
3. otherwise a legacy `scope=object, scope_id=__air__` override is converted;
4. duplicate legacy entries are removed from the public projection.

No new schema field is required. The mesh manifest remains the source for resolving the current Airbox carrier part id.

## Airbox vector flow

The complete vector path is:

1. Explorer, Inspector, ribbon, or air-role mesh selection resolves to target `airbox`.
2. Display writes update `visualization/state.layers.airbox`; per-target vector length and thickness remain in the canonical Airbox override style.
3. The viewport resolves Airbox settings only from the canonical target.
4. The mesh manifest supplies all field-capable air-role carrier parts.
5. Each field request uses `scope_kind=airbox` and the real carrier `scope_id`, such as `part:__air__`.
6. FMVP node indices map scoped or sampled field values back to topology nodes before glyph generation.

Magnetic-only quantities remain unavailable for Airbox. For a compatible quantity such as `H_demag` or `H_eff`, visible Airbox vectors with a positive budget must create a scoped request and vector segments.

## Histogram hover and render-loop stability

Airbox histogram hover receives the carrier part id from the current mesh manifest instead of hard-coding `airbox`.

The hover event is value-stable:

- a tooltip computes a primitive hover key from active state and bin index;
- identical hover values are not emitted repeatedly merely because Recharts allocated a new payload array;
- the viewport state subscriber preserves the previous state object when the incoming highlight is structurally identical.

Clearing hover still emits one `null` transition. No continuous frame loop or polling is introduced.

## Accessibility

`ApiConnectionErrorDialog` gives `DialogDescription` a stable id and passes the same id through `aria-describedby` on `DialogContent`.

## Verification

- API regression: synthetic `__air__` object and air-role mesh part are absent; owned magnetic parts are not fallback targets; one canonical Airbox remains.
- API regression: legacy Airbox overrides normalize with deterministic precedence.
- Selection regression: an air-role mesh part resolves to target `airbox`.
- Histogram regression: hover membership uses the manifest carrier id and identical hover values do not cause repeated viewport state updates.
- Vector regression: enabling canonical Airbox vectors produces an Airbox-scoped request for the real carrier and sampled/explicit node indices produce nonempty glyph segments.
- Dialog regression: description id and `aria-describedby` are connected.
- Manifest ownership regression: the production pair `part:__air__` plus
  `object_id=__air__` produces one Airbox carrier address, no unassigned
  `__air__`, no magnetic duplicate, and `mesh-parts` rather than `mixed`
  diagnostics.
- Degraded-manifest regression: an Airbox object segment without a mesh part
  remains one non-field-capable Airbox carrier labelled `Airbox`.
- Collision regression: an unreserved object or segment named `air` is not
  classified as Airbox without an explicit Airbox role.
- Explorer/viewport integration regression: exactly one `model:airbox` address
  exists and every realized Airbox carrier resolves to it.
- Frontend gates: focused tests, full test suite, lint, typecheck, React Doctor, idle-performance audit, and active-session 3D browser smoke with visible canvas, live WebGL context, and nonzero drawing buffer.

## Revision scope

This revision does not remove object segments from the backend manifest, rename
solver ids, change FMVP field scope, or alter physical air-domain topology. It
repairs semantic ownership at the frontend manifest boundary while preserving
the existing data-plane carriers and degraded rendering contract.
