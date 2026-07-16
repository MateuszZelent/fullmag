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
- `VectorFieldLayer` removes inactive target or quantity groups from the shared
  cache. The viewport runtime sets its 64 MiB / 12-entry budget and disposes it
  on the final viewport release.

## Review correction: viewport-wide ownership

The initial limit was owned by each `VectorFieldLayer`, which would multiply
the effective budget for many mesh parts. The final ownership is instead one
`VectorGlyphDerivedBufferRuntime` in the `Viewport3DScene` provider. Every
vector consumer obtains that same cache; its lease count disposes the cache only
after the last viewport lease releases. The tracker receives the live aggregate
`glyphCacheEntries`, `glyphCacheBytes`, and `glyphCacheRetainedBytes`, and the
compact viewport diagnostics prints them as `glyph-cache`.

## Review correction: provider boundary

The provider must wrap the entire `Viewport3DScene`, not the projection-camera
stack. `VectorFieldLayer` consumers mount below `Viewport3DModelLayerStack`, a
sibling of the projection stack. A renderer-tree regression test now requires
the provider to begin before and end after that model stack.

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
- Review correction verification: 32 focused tests (including shared-runtime
  leasing and tracker diagnostics), TypeScript, and focused ESLint — passed.
- Provider-boundary correction verification: 45 focused cache/vector/scene
  tests, TypeScript, and focused ESLint — passed.
