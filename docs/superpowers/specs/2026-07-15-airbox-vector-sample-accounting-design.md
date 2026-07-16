# Airbox Vector Sample Accounting Design

## Goal

Make the Airbox `Full` points and vector passes use one air-only node carrier, remove the hidden 1,200-vector truncation, and report measured field and renderer counts instead of manifest-derived estimates.

## Canonical semantics

`part:__air__` remains the data-plane mesh carrier for the canonical `airbox` visualization target. Its raw manifest membership may contain nodes shared with magnetic parts, but the canonical Airbox visualization carrier excludes those shared magnetic nodes. For the active reference mesh this produces 10,586 air-only nodes from a raw 16,940-node manifest part.

Both `Points -> Full` and `Vectors -> Full` use this air-only selection. Interface nodes remain available through their interface and magnetic carriers; they are not duplicated in the Airbox pass. Surface mode uses the corresponding surface subset of the same air-only selection.

## Backend and resource contract

The existing HTTP v2 field-vector endpoint remains authoritative:

`GET /v2/sessions/current/data/fields/{quantity_id}/samples/vector`

Airbox requests continue to use `scope_kind=airbox` and the exact manifest carrier id `scope_id=part:__air__`. The FMVP v3 response continues to publish `sampled_node_indices`, point count, scope identity, topology identity, and field identity. No new route, WebSocket payload, or duplicate JSON read model is introduced.

The meshing manifest remains the source of raw topology ownership. A shared frontend air-only selection builder derives the effective visualization node set by subtracting magnetic-node membership from the Airbox manifest carrier. The same derived selection supplies point geometry, vector-budget limits, and field-demand planning.

## Vector budget and sampling

The Airbox-specific constant limit of 1,200 is removed. The requested Airbox vector budget is clamped to the effective air-only node count and then sent as `max_samples`. Explicit target budgets are not silently reduced by the session-wide fallback `sampling.max_glyphs`; the target's effective-node limit is the authoritative maximum for this per-target control.

The backend may return fewer samples than requested because of resource availability or a valid scoped response. The renderer uses the decoded FMVP point and node-index counts as its input count and publishes the number of adopted glyphs after the instance upload becomes visible.

Progressive worker construction and chunked GPU upload remain enabled. A full 10,586-arrow request must not introduce an always-on render loop, synchronous unbounded diagnostics, or a second field request.

## Inspector accounting

The `Arrow budget` range uses the effective air-only node count. `Arrow samples` no longer computes `min(requestedBudget, manifestNodeCount)` and does not claim an estimate as a rendered result.

The Inspector displays three distinct values when data is available:

- available air-only nodes;
- decoded field samples from the current FMVP resource;
- adopted logical glyphs from the renderer.

Until the resource or adoption receipt exists, the corresponding value is `waiting`, not a guessed number. One logical arrow consists of a shaft and a head, but the user-facing glyph count counts the arrow once.

## State ownership

Manifest and field payloads remain server resources in resource hooks and caches. Effective node selection is derived render-model data. Renderer adoption count is bounded imperative diagnostics owned by the existing render-adoption registry. The Inspector reads these sources through the existing visualization/resource model; it does not store topology, field arrays, or session snapshots in module state.

## Failure and degraded states

- A missing or incompatible field resource reports `waiting` or the existing degradation reason and renders no vectors.
- A scope, topology, quantity, or field-buffer identity mismatch must not reuse a stale glyph count.
- A decoded sample count larger than the effective air-only node count is rejected as inconsistent.
- Zero-magnitude samples do not produce visible glyphs and are excluded from the adopted logical-glyph count.
- Point and vector passes must share the same air-only carrier identity even when only one pass is visible.

## Verification

Focused tests must prove:

1. the effective Airbox full selection excludes nodes owned by magnetic parts;
2. point geometry uses the effective Airbox selection rather than the raw 16,940-node manifest membership;
3. a requested full budget produces `max_samples=10,586` for the reference topology and is not clamped to 1,200 or 16,384;
4. FMVP response sample count flows into the target field buffer;
5. zero-magnitude values do not inflate the visible/adopted glyph count;
6. the Inspector distinguishes available nodes, decoded samples, and adopted glyphs;
7. stale field/topology/adoption identities clear measured counts;
8. viewport tests, memory-stress gates, idle-performance audit, typecheck, lint, and the complete Control Room test suite pass;
9. a browser smoke confirms a visible WebGL canvas, non-lost context, non-zero drawing buffer, one Airbox field request, and matching Inspector/renderer counts.

## Scope

This change does not alter the physical definition of `H_demag`, introduce a new API endpoint, change FMVP encoding, or render magnetic-interface arrows twice. It repairs Airbox visualization carrier semantics and count observability only.
