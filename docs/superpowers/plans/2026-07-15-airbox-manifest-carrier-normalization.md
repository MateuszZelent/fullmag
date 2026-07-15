# Airbox Manifest Carrier Normalization Implementation Plan

> **For Codex:** Execute this plan with `executing-plans`, preserve the approved design in `docs/superpowers/specs/2026-07-14-airbox-visualization-identity-and-stability-design.md`, and do not broaden the change into backend manifest or API schema work.

**Goal:** Normalize the production `part:__air__` mesh-part plus `object_id=__air__` object-segment pair into one canonical Airbox carrier so Explorer, viewport, selection, and diagnostics cannot reconstruct a magnetic `__air__` fallback.

**Architecture:** Add one kernel-owned manifest-carrier normalizer that preserves raw transport ownership fields and adds canonical carrier kind, field capability, label, role, and ownership aliases. Make both the semantic target catalog and the FEM viewport domain adapter consume that output. Extend the shared Airbox predicate and ownership alias resolver so reserved Airbox identities in `id`, `object_id`, and `geometry_id` collapse to the same alias, while an ordinary object named `air` remains untouched unless it has an explicit Airbox role.

**Tech Stack:** TypeScript, React 19, Next.js 16, Vitest, Playwright/browser smoke, ESLint.

---

## Task 1: Lock the identity and alias contract with failing tests

**Files:**

- Modify: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.test.ts`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/semanticRenderTargetExplorerContract.test.ts`

1. Add a production-manifest fixture containing a mesh part with `id=part:__air__`, `role=air`, no ownership ids, plus an object segment with `object_id=__air__`.
2. Assert that reserved Airbox identities in `object_id` and `geometry_id` are recognized, but the unreserved name `air` without an Airbox role is not.
3. Assert that the production pair produces only the mesh-part carrier, one `model:airbox` semantic address, and `mesh-parts` diagnostics rather than `mixed`.
4. Assert that a segment-only Airbox becomes a labelled, non-field-capable Airbox carrier with null scene-object ownership and no `objectPartIds["__air__"]` entry.
5. Assert that a legitimate orphan magnetic segment retains its existing fallback behavior.
6. Run the four focused test files and confirm the new assertions fail for the expected duplicate/misclassification reasons:

   `env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/kernel/selection/semanticRenderTargetCatalog.test.ts src/kernel/visualization/visualizationDisplayResolution.test.ts src/modules/viewport-3d/viewport3dDomainAdapter.test.ts src/modules/viewport-3d/semanticRenderTargetExplorerContract.test.ts`

## Task 2: Implement the kernel-owned carrier normalizer

**Files:**

- Create: `apps/control-room/src/kernel/selection/manifestRenderableCarriers.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts`
- Test: the focused files from Task 1

1. Extend `isVisualizationAirboxIdentity` to inspect `id`, `role`, `object_id`, and `geometry_id`, including `_geom` ownership aliases, without treating plain `air` as reserved by name.
2. Make `manifestCarrierOwnershipAliases` emit one canonical Airbox alias for every reserved Airbox representation and preserve the current aliases for ordinary carriers.
3. Implement a typed normalized carrier result with raw mesh-part/object-segment data, `carrierKind`, `fieldCapable`, canonical label/role, ownership aliases, and diagnostics.
4. Deduplicate mesh-part ids and object segments against mesh-part ownership aliases. Prefer a field-capable Airbox mesh part over an Airbox segment.
5. Preserve a segment-only Airbox as `role=air`, `label=Airbox`, `fieldCapable=false`; preserve ordinary orphan segments as magnetic fallbacks; keep outer-boundary filtering semantics unchanged downstream.
6. Run the focused tests until the identity, alias, and normalizer cases pass.

## Task 3: Route Explorer and viewport through the shared result

**Files:**

- Modify: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Test: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/semanticRenderTargetExplorerContract.test.ts`

1. Remove the semantic catalog's independent object-segment conversion and delegate manifest carrier construction to the kernel normalizer.
2. Remove the viewport adapter's independent object-segment conversion and consume the same normalized carrier list and diagnostics.
3. Exclude every Airbox carrier from `objectPartIds`, even when its raw segment retains `object_id=__air__`.
4. Verify segment-only Airbox selection resolves to `mesh-part-airbox` with a null `objectId`, while ordinary orphan magnetic segments still resolve to part fallbacks.
5. Run the focused suite and confirm it is green.

## Task 4: Verify regression coverage and static quality gates

**Files:**

- Modify only if a directly related regression is found.

1. Run the complete Control Room suite:

   `env TMPDIR=/tmp corepack pnpm --dir apps/control-room test`

2. Run type checking and lint:

   `corepack pnpm --dir apps/control-room typecheck`

   `corepack pnpm --dir apps/control-room lint --max-warnings=0`

3. Run architecture and API hygiene:

   `corepack pnpm --dir apps/control-room check:api-hygiene`

   `corepack pnpm --dir apps/control-room check:architecture-hygiene`

4. Run the idle-performance audit:

   `corepack pnpm --dir apps/control-room audit:idle-performance`

5. Run the repository-supported React Doctor command if present; if no owned command exists, record that precisely instead of downloading an unpinned package.

6. Build the production frontend:

   `corepack pnpm --dir apps/control-room build`

## Task 5: Prove the actual browser behavior

**Files:**

- Modify: an existing owned browser smoke only if required to add the Airbox identity assertion.

1. Start the production Control Room from the isolated worktree using the existing repository launcher/build output.
2. Load an active FEM session whose manifest contains the production Airbox pair.
3. Assert the 3D canvas is visible, the WebGL context is live, and drawing-buffer width and height are positive.
4. Assert Explorer contains exactly one canonical Airbox branch and no unassigned `__air__`/`segment:__air__` node.
5. Assert viewport diagnostics do not report a duplicate magnetic Airbox carrier or `mixed` solely because the object segment coexists.
6. Capture the browser-smoke output as final runtime evidence.

## Task 6: Review, commit, rebase, and integrate

**Files:** all task-owned changes only.

1. Review `git diff --check`, the complete diff, and changed-file scope using the repository's Google engineering review guidance.
2. Run `verification-before-completion` and repeat every material gate affected by final edits.
3. Inspect `git diff --cached --name-only` in a separate command before each commit; never stage unrelated shared-worktree changes.
4. Commit the approved spec/plan and implementation with descriptive messages.
5. Fetch and rebase the isolated branch onto current `origin/master`; rerun impacted verification if upstream moved.
6. Push/integrate only the isolated branch commits, then confirm the resulting commit is reachable from the intended integration branch.
