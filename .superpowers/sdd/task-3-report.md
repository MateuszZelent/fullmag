# Task 3 report: domain-generation field identity

## Scope delivered

- Added `resolveViewport3DFieldDomainCompatibility` as the single viewport field/domain identity decision.
  - FMVP v3 requires both exact decimal-string domain generation IDs and rejects missing or unequal values.
  - It also preserves topology hash/revision checks and only compares point counts for `full_domain` indexing.
  - FMVP v2 remains explicitly `degraded` with reason `fmvp-v2-legacy`.
- Replaced the render-model and chunked scalar-color topology-only guards with the resolver. A v3 mismatch therefore cannot produce scalar colors, vector glyphs, or mapped field values.
- Target field buffers now retain field generation in their identity and hold the compatibility result. Surface/vector capability checks reject mismatch buffers. Scene-model buffer construction supplies current topology identity.
- Added `domainGenerationId` to field-color, FDM cuboid, and vector-glyph build-key inputs and values. Topology-index and region-overlay keys intentionally remain generation-independent because they do not depend on field samples.
- Realtime parsing retains a safe generation token. A generation-only `fields/samples` event now produces a distinct field-resource invalidation revision while remaining HTTP-invalidations-only. Unsafe numeric JSON generation IDs are treated as unknown rather than compared as imprecise JavaScript numbers.
- Rust already published `domain_generation_id` and the AsyncAPI schema already described it. No OpenAPI regeneration or AsyncAPI schema edit was required. Added a Rust publisher regression proving a field-samples change is emitted for generation-only change.

## TDD record

RED command:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/model/viewport3DFieldDomainCompatibility.test.ts src/modules/viewport-3d/viewport3dRenderModel.test.ts src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.test.ts src/modules/viewport-3d/viewport3dDomainAdapter.test.ts src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.test.ts src/kernel/realtime/RealtimeInvalidationBridge.test.ts
```

Observed expected failures: missing compatibility module, equal field build keys after a generation-only change, and a generation-only realtime event collapsing to revision `11` rather than `generation:8:revision:11`.

GREEN and final verification:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/model/viewport3DFieldDomainCompatibility.test.ts src/modules/viewport-3d/viewport3dRenderModel.test.ts src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.test.ts src/modules/viewport-3d/viewport3dDomainAdapter.test.ts src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.test.ts src/kernel/realtime/RealtimeInvalidationBridge.test.ts
# 6 files passed, 139 tests passed

cargo test -p fullmag-api realtime_changes_since_refreshes_field_samples_when_only_domain_generation_changes
# 1 passed

cargo test -p fullmag-api asyncapi_document_matches_realtime_rust_schema_names
# 1 passed

pnpm --dir apps/control-room typecheck
# passed

git diff --check
# passed
```

## Contract boundaries

- HTTP field resources remain authoritative. The websocket carries only invalidation identity; it does not carry field, scalar, vector, or topology payload data.
- No direct module fetches or generated transport edits were added.
- `viewport3dDomainAdapter.ts` was inspected but not changed: it adapts FDM/FEM geometry/manifest parts and has no field-buffer admission path. The resolver is used at the render-model, chunked-color, and target-buffer boundaries where field data enters GPU-facing work.
- Native FEM builds were not run.
