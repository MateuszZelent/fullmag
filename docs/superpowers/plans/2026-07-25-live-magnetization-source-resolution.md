# Live Magnetization Source Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make field metadata, FMVP payloads, revisions, and ETags consume the same freshest magnetization source.

**Architecture:** Add one source resolver in API session ownership that validates sources, preserves existing latest/preview provenance ordering, and treats unversioned live magnetization as a compatibility fallback. Route handlers materialize the selected source without changing transport contracts.

**Tech Stack:** Rust, Axum, Tokio tests, Fullmag resource-first v2 API, FMVP v3.

## Global Constraints

- No endpoint, OpenAPI, schema, generated frontend transport, or FMVP format changes.
- Persisted hysteresis snapshots retain highest precedence.
- Legacy unversioned live magnetization remains supported.
- HTTP v2 remains authoritative; realtime only invalidates by advancing resource revisions.
- No solver, GPU snapshot, codec, mesh-indexing, or viewport-rendering changes.

---

### Task 1: Reproduce the split-owner regression

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: `apply_current_live_field_frame`, field metadata route, FMVP vector route.
- Produces: a failing integration test for the `A -> B -> C` source sequence.

- [ ] **Step 1: Write the failing test**

Create a live session with legacy magnetization `A`. Apply a
`CurrentLiveFieldFrameRequest` containing provenance-rich `latest_fields["m"] =
B`. Assert metadata source provenance and statistics describe `B`, decode FMVP
with `decode_fmvp_payload_f64`, and assert the payload also equals `B`. Apply
`C` and assert revision, ETag, and payload all advance.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-live-m-source-red cargo test -p fullmag-api \
  v2_magnetization_meta_vector_revision_and_etag_follow_provenance_field_frames \
  -- --exact --nocapture
```

Expected: FAIL because metadata returns `B` while FMVP still returns legacy
`A`, and the revision/ETag do not advance.

### Task 2: Introduce one source resolver

**Files:**
- Modify: `crates/fullmag-api/src/session.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`

**Interfaces:**
- Produces: `resolved_current_field_source(snapshot, quantity, n_comp)` and a
  source enum representing latest, preview, or legacy live magnetization.
- Consumes: existing domain validation and latest/preview precedence helpers.

- [ ] **Step 1: Implement minimal source selection**

Resolve valid latest and preview sources first. For `m`, prefer a preview or a
latest field with explicit provenance; otherwise retain legacy live
magnetization precedence. For other quantities, preserve current behavior.

- [ ] **Step 2: Route all current-field consumers through it**

Use the resolver in `effective_field_source`, `get_field_meta`, and
`get_field_vector`. Keep persisted snapshot handling outside and ahead of the
current-field resolver.

- [ ] **Step 3: Run the regression test to verify GREEN**

Run the exact Task 1 command. Expected: PASS.

### Task 3: Preserve compatibility and validate the API contract

**Files:**
- Modify only if required by a discovered regression:
  `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: existing legacy source-precedence test and router suite.
- Produces: proof that the compatibility fallback and v2 data plane remain intact.

- [ ] **Step 1: Run focused source-resolution tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-live-m-source-test cargo test -p fullmag-api \
  magnetization -- --nocapture
```

Expected: all matching tests PASS, including the unversioned legacy fixture.

- [ ] **Step 2: Run API and resource-first gates**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-live-m-source-test cargo test -p fullmag-api router_v2 --no-fail-fast
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
cargo fmt --check
git diff --check
```

Expected: all commands PASS. OpenAPI generation is not required because no
route or schema changes.

### Task 4: Verify the repaired runtime boundary

**Files:**
- No source changes.

**Interfaces:**
- Consumes: rebuilt API and a running simulation.
- Produces: two-sample evidence for meta/F​​MVP/revision/ETag consistency.

- [ ] **Step 1: Rebuild/restart only the API through the normal launcher**

Do not stop the solver without user authorization. If the existing running API
cannot hot-load the fix, finish static verification and request a controlled
runtime restart.

- [ ] **Step 2: Sample twice**

Fetch `m/meta?component=x` and `m/samples/vector?component=full` twice. Record
source step/revision, response field revision, ETag, payload SHA-256, and
decoded component statistics.

Expected: source provenance advances; when values advance, payload hash,
revision, and ETag advance together, and decoded FMVP statistics match metadata
for the selected component.
