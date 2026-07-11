# F3D-020 — vector glyph derived-buffer cache budget

## Scope

Bound the vector-glyph derived-buffer cache without changing glyph density or
default visual style.

## Implementation

- `Viewport3DDerivedBufferCache` now accepts explicit byte and entry budgets.
  It deterministically evicts unretained least-recently-used entries after both
  `putReady` and retain-handle `release`.
- The cache now supports inactive-group cleanup and `dispose()` for lifecycle
  owners. Its snapshot remains the diagnostic surface and exposes
  `entryCount`, `estimatedBytes`, and `retainedBytes`.
- `VectorFieldLayer` sets a 64 MiB / 12-entry budget, removes inactive target
  or quantity groups, and releases/disposes the cache on unmount.

## Tests

- RED: the new cache tests failed before implementation because the cache had
  no budget enforcement, inactive-group cleanup, or disposal API.
- GREEN: 200 simulated quantity/style switches remain at one 16-byte entry
  under the configured 16-byte / two-entry test budget.
- A retained buffer survives budget pressure; after release it is evicted by
  the next LRU pressure event.
- Inactive group cleanup and cache disposal leave zero entries and bytes.

## Verification

- `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.test.ts src/modules/viewport-3d/layers/VectorFieldLayer.test.ts` — 20 passed.
- `pnpm --dir apps/control-room typecheck` — passed.
- Focused ESLint for the four changed source/test files with zero warnings — passed.
