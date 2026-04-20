# FEM 3D Viewport Freeze During Simulation — Diagnostic Report

## Problem Statement

When a simulation run starts in the control room, the FEM 3D viewport immediately
resets to the initial magnetization state and never updates again. Arrows and
shader data remain frozen at `t=0` for the entire simulation duration.

---

## Root Cause Summary

The FEM (and FDM native GPU) step loop **never sends magnetization data** during
interactive runs, and the preview-field mechanism only fires **once** (on first
display-revision mismatch), leaving the viewport permanently frozen after `t=0`.

---

## Detailed Bug Inventory

### BUG-1 (PRIMARY): `magnetization` gated on `display_selection.is_none()` — always `None` during interactive runs

**Files:**
- `crates/fullmag-runner/src/dispatch.rs` lines 2531–2536 (FEM time-stepping)
- `crates/fullmag-runner/src/dispatch.rs` lines 2228 (FEM direct minimization)
- `crates/fullmag-runner/src/dispatch.rs` lines 1914–1915 (FDM native GPU)

**Mechanism:**

```rust
// dispatch.rs, FEM time-stepping POST-STEP block (line 2531)
let magnetization =
    if live.display_selection.is_none() && stats.step % heavy_payload_every == 0 {
        Some(flatten_vectors(&backend.copy_m(node_count)?))
    } else {
        None
    };
```

When running via `run_problem_with_live_preview_interruptible` (which the
orchestrator uses for all interactive FEM and FDM runs),
`live.display_selection` is `Some(...)`. The condition
`live.display_selection.is_none()` is **always false**, so `magnetization` is
**always `None`**.

The intent was: "if we have display_selection, use preview_field instead of raw
magnetization." But the preview_field mechanism (BUG-2) doesn't fire on every
step, creating a dead zone where neither data path produces output.

**Impact:** `live_state.latest_step.magnetization` is always `None` →
`build_step_update_v2()` produces empty frames → frontend
`latest_fields.frames.m` never populated → `selectViewportVectorField` returns
`null` for the `liveField` path.

---

### BUG-2 (PRIMARY): `preview_field` only sent on display-revision change, not per-step

**Files:**
- `crates/fullmag-runner/src/interactive_runtime.rs` lines 33–41
- `crates/fullmag-runner/src/dispatch.rs` lines 2460–2489 (FEM PRE-STEP)
- `crates/fullmag-runner/src/dispatch.rs` lines 2522–2527 (FEM POST-STEP)

**Mechanism:**

```rust
// interactive_runtime.rs
pub(crate) fn display_refresh_due(
    last_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    _local_step: u64,
) -> bool {
    last_preview_revision != Some(display_state.revision)
}
```

`preview_due` is `true` only when `display_state.revision` differs from
`last_preview_revision`. During simulation, the user does not change display
settings, so the revision stays constant. After the first step caches the
revision, **all subsequent steps have `preview_due = false`**.

The PRE-STEP block runs first and caches the revision. The POST-STEP block
(which runs AFTER the actual solver step with fresh data) sees
`preview_due = false` and sends `preview_field = None`.

**Result:** Only the initial (pre-step-0) preview_field is ever sent. The viewport
shows `t=0` magnetization and never advances.

---

### BUG-3: Final `on_step` in `run_problem_with_callback` skips FEM magnetization

**File:** `crates/fullmag-runner/src/lib.rs` lines 444–449

```rust
magnetization: match &plan.backend_plan {
    BackendPlanIR::Fdm(_) => Some(final_m),
    BackendPlanIR::FdmMultilayer(_)
    | BackendPlanIR::Fem(_)
    | BackendPlanIR::FemEigen(_) => None,
},
```

Even for the non-interactive `run_problem_with_callback` path, the final step
update sent after artifacts are written omits magnetization for FEM. The control
room never gets the final converged state.

---

### BUG-4 (ARCHITECTURAL): `latest_fields` path never wired up in CLI

**Files:**
- `crates/fullmag-cli/src/orchestrator.rs` lines 2987, 3112, 3246, 5602
- `crates/fullmag-cli/src/live_workspace.rs` line 70

`latest_fields` is always `CurrentLiveLatestFields::default()` (empty) in all
publish payloads from the CLI. The deprecated Q16 `magnetization` field on
`latest_step` is still the only spatial-data transport mechanism, but BUG-1
ensures it's always `None` during interactive runs.

This is a half-completed migration: the old path (`magnetization`) is deprecated
but still the only functioning transport; the new path (`latest_fields`) was
declared but never connected.

---

### BUG-5: `content_hash()` doesn't detect value-only field changes

**File:** `crates/fullmag-api/src/types.rs` lines 581–594

```rust
fn content_hash(&self) -> u64 {
    let mut hasher = DefaultHasher::new();
    self.0.len().hash(&mut hasher);
    for (key, values) in &self.0 {
        key.hash(&mut hasher);
        values.len().hash(&mut hasher); // only length, not values!
    }
    hasher.finish()
}
```

Only hashes key count + per-key array length. When magnetization values change
but the mesh topology stays constant, the hash is identical. This is mitigated by
`has_latest_fields_update` (line 875), but since `latest_fields` is never
populated (BUG-4), the mitigation is dead code.

---

### BUG-6: `syncLatestMagnetizationFrameFromLiveState` is a one-shot mechanism

**File:** `apps/web/lib/session/merge.ts` lines 336–344

```typescript
if (
  merged.live_state?.magnetization &&
  (sceneRevisionAdvanced || !merged.latest_fields.frames.m)
) {
```

This merge guard only runs when:
- `sceneRevisionAdvanced` (geometry changed) — never during simulation
- `!merged.latest_fields.frames.m` — only the FIRST time

After the first frame arrives (via step_update_v2 or this path), the condition
`!merged.latest_fields.frames.m` becomes false. Subsequent magnetization
updates are silently dropped.

**Note:** This bug is currently masked by BUG-1 (magnetization is always null
during interactive runs, so this code never fires). It would become relevant
once BUG-1 is fixed.

---

### BUG-7: `frameGuard` backendEpoch stuck at 0 in legacy path

**File:** `apps/web/lib/fieldFrame/frameGuard.ts`

`backendEpoch` is always 0 in the legacy (non-latest_fields) path. Frame
rejection relies entirely on `fieldRevision` being strictly increasing.

**File:** `apps/web/lib/fieldFrame/envelopeAdapter.ts` line 81

```typescript
fieldRevision = configRevision || sourceStep
```

If both `configRevision` and `sourceStep` are 0 (e.g., initial state),
`fieldRevision` is 0 — and frames with revision 0 may be silently rejected.

---

## Architectural Debt Findings

| Finding | Location | Severity |
|---------|----------|----------|
| Incomplete Q16 migration: old `magnetization` deprecated, new `latest_fields` never wired | CLI orchestrator + live_workspace | Critical |
| Two-block step callback (PRE-STEP + POST-STEP) with shared `last_preview_revision` causes data race between stale pre-step preview and null post-step preview | dispatch.rs FEM/FDM loops | High |
| `display_refresh_due` uses revision-gated logic instead of step-cadence — appropriate for on-demand preview but incompatible with live viewport streaming | interactive_runtime.rs | High |
| Magnetization gated on `display_selection.is_none()` is a false dichotomy: interactive runs need BOTH display-selection AND magnetization | dispatch.rs | Critical |
| `content_hash` hashes shape not values — time bomb for when `latest_fields` gets wired up | types.rs | Medium |
| `normalize.ts` 2009 lines, `ControlRoomContext.tsx` 2083 lines, `orchestrator.rs` 5600+ lines — all violate 1000-line rule | Various | Low (maintainability) |

---

## Fix Plan

### Stage 1: Send magnetization on every Nth step during interactive FEM runs (CRITICAL FIX)

**Goal:** Ensure the viewport receives updated magnetization vectors during simulation.

**Changes:**
1. `crates/fullmag-runner/src/dispatch.rs`: In the FEM time-stepping POST-STEP
   block, send `magnetization` on cadence (every `heavy_payload_every` steps)
   regardless of `display_selection` state.
2. Same fix for FEM direct-minimization path.
3. Same fix for FDM native GPU path (same pattern).
4. `crates/fullmag-runner/src/lib.rs`: Include FEM magnetization in final step update.

### Stage 2: Fix frontend merge to allow repeated magnetization updates

**Goal:** Ensure merge.ts doesn't block subsequent frame updates.

**Changes:**
1. `apps/web/lib/session/merge.ts`: Remove the `!merged.latest_fields.frames.m`
   one-shot guard — always sync when live_state has fresh magnetization and the
   source step has advanced.

### Stage 3: Fix `envelopeAdapter` fieldRevision for monotonic progress

**Goal:** Ensure fieldRevision advances with solver steps so frameGuard doesn't
reject frames.

**Changes:**
1. `apps/web/lib/fieldFrame/envelopeAdapter.ts`: Use `sourceStep` as primary
   fieldRevision input when available, instead of `configRevision || sourceStep`.

---

## Files Changed Summary

| File | Stage | Change |
|------|-------|--------|
| `crates/fullmag-runner/src/dispatch.rs` | 1 | Send magnetization during interactive runs |
| `crates/fullmag-runner/src/lib.rs` | 1 | Include FEM in final magnetization update |
| `apps/web/lib/session/merge.ts` | 2 | Allow repeated magnetization frame merges |
| `apps/web/lib/fieldFrame/envelopeAdapter.ts` | 3 | Fix fieldRevision monotonicity |
