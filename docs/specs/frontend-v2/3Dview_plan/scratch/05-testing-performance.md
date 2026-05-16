# 05 - Testing, Performance, and Quality Gates

This document defines the gates that make the Phase 5 plan implementation-ready. The gates are part of the plan, not optional follow-up work.

## 1. Test Tiers

| Tier | Scope | Gate |
|---|---|---|
| API facade | JSON/binary methods, 200/204/304, ETag, abort, diagnostics | Every PR touching resources |
| Resource hooks | revision selectors, stable loaders, cache reuse, unrelated invalidation | Every PR touching hooks |
| Domain adapters | FDM/FEM, manifest mapping, airbox, LOD-before-allocation | Every PR touching adapters |
| Render model | pure model build, degraded states, quantity switch semantics | Every PR touching model |
| R3F layers | mount/unmount, invalidate on prop changes, resource disposal | Every PR touching renderer |
| Memory stress | quantity cycles, 3D/2D switches, unmount cleanup | Before declaring viewport complete |
| Idle audit | zero frames after settling, no polling, no timers | Before declaring viewport complete |
| Browser smoke | canvas nonblank, camera interaction, object layer visible | Before release |

## 2. API Facade Tests

Required cases:

1. `data.domain.topology()` returns decoded FMMT for 200.
2. `data.domain.topology()` returns `not-applicable` for 204.
3. binary method sends `If-None-Match` when cache has an ETag.
4. binary method returns `not-modified` for 304 and does not decode an empty body.
5. field vector method includes quantity path params and component/scope query params through the facade, not string concatenation in modules.
6. request diagnostics include path, status, duration, request id, and outcome.
7. abort cancels request and does not update hook state after unmount.

## 3. Resource Hook Tests

Required cases:

1. initial revision fetches once;
2. unrelated resource invalidation does not refetch;
3. relevant revision refetches exactly once;
4. React rerender without revision change does not refetch;
5. 304 reuses cached decoded data and preserves ready state;
6. 204 exposes `not-applicable` degraded state for FDM topology;
7. inflight dedupe shares one request across equivalent consumers;
8. cache eviction calls dispose callbacks.

## 4. Domain Adapter Tests

### FDM

Required cases:

1. 204 topology is accepted.
2. grid metadata builds structured render input.
3. LOD/displayed cell budget is chosen before instance matrix allocation.
4. oversize grid degrades instead of allocating unbounded buffers.
5. quantity switch reuses topology geometry.

### FEM

Required cases:

1. FMMT positions convert to render buffers with explicit ownership.
2. object/part/airbox mapping uses `MeshSharedDomainManifestResource.mesh_parts`.
3. marker values are not treated as scene object indexes.
4. airbox is detected by `role="air"`.
5. missing manifest mapping disables object-level picking and reports degraded state.
6. boundary face hit resolves object/part only when lookup is reliable.

## 5. Render Model Tests

Required cases:

1. null resources produce an empty/degraded render model.
2. FDM render model has objects and no binary topology requirement.
3. FEM render model separates magnetic objects from airbox.
4. scalar field update changes field data without changing geometry reference.
5. topology revision change changes geometry and releases stale geometry owner.
6. selection change updates selection render data without refetching field data.
7. unsupported field-value probe does not claim a numeric value.

## 6. R3F Layer Tests

Required cases:

1. `Viewport3DCanvas` mounts exactly one `<Canvas>`.
2. there is no `ViewportGrid`, pane array, or per-pane state in Phase 5 code.
3. object mesh layer mounts/unmounts geometry/material ownership cleanly.
4. scalar field layer updates color buffers without rebuilding geometry.
5. vector glyph layer respects `max_glyphs` and releases stale instance buffers.
6. wireframe builds edge buffers only when visible.
7. airbox layer toggles without hiding magnetic object field coloring.
8. context loss/restored does not leave stale resource counts.

## 7. Memory Stress Procedure

Automated procedure:

1. mount `viewport-3d`;
2. load mock FDM domain and one field;
3. load mock FEM topology, manifest, airbox, and one field;
4. switch quantity/component/scope repeatedly;
5. toggle scalar/vector/wireframe/airbox layers repeatedly;
6. switch to `viewport-2d` and unmount 3D;
7. switch back to 3D;
8. repeat the cycle;
9. assert bounded high-water memory, zero module-owned WebGL resources after unmount, no unbounded cache growth, and no active workers/subscriptions/observers.

Do not assert exact heap return to baseline. Use resource counts, byte budgets, and tolerance-based high-water marks.

## 8. Idle Performance Audit

Procedure:

1. mount workspace with viewport data loaded;
2. wait until resources settle;
3. do not move camera or pointer;
4. record frames, requests, long tasks, timers, animation frame handles, and dirty reasons for a fixed window;
5. fail if the viewport renders without a dirty reason;
6. fail if any polling or interval refresh appears;
7. fail if unrelated status/resource events invalidate the canvas.

## 9. Performance Budgets

Initial budgets are conservative and must be measured.

| Metric | Budget |
|---|---|
| Idle viewport frames after settling | 0 |
| Unrelated invalidation field/topology refetches | 0 |
| Quantity switch topology rebuilds | 0 |
| Field/color transform | worker/chunked when above threshold |
| Glyph count | `<= max_glyphs` |
| Decoded resource cache | `<= 128 MB` default |
| Single field vector cache entry | reject/degrade above soft cap unless explicitly allowed |
| Module-owned WebGL resources after unmount | 0 |
| Active workers/subscriptions/observers after unmount | 0 |

## 10. Commands

Always run the applicable subset and do not claim completion without reading output:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
```

Commands to add with the implementation:

```bash
pnpm --dir apps/control-room test -- --run viewport-3d
pnpm --dir apps/control-room test -- --run resource-hooks
pnpm --dir apps/control-room test -- --run viewport-memory-stress
pnpm --dir apps/control-room audit:idle-performance
```

If `audit:idle-performance` does not exist when viewport code lands, adding it is part of the same implementation slice.

## 11. Browser Verification

Before release:

1. start `apps/control-room`;
2. open `/workspace`;
3. verify canvas is nonblank;
4. verify camera orbit/zoom/pan works;
5. verify quantity switch does not flash blank geometry;
6. verify airbox toggle does not hide magnetic field coloring;
7. verify unmount/remount does not leak module-owned resources;
8. capture screenshot/canvas smoke evidence.

