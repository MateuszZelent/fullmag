# Control Room API Compatibility and Airbox Identity Implementation Plan

> **For agentic workers:** Execute inline with test-driven development and verification checkpoints.

**Goal:** Eliminate stale-API request storms and synthetic Airbox leakage into Unassigned Mesh.

**Architecture:** Separate health from API compatibility at launcher startup, centralize Airbox semantic identity, and gate optional resources at their owning status/revision boundary. Keep HTTP v2 authoritative and do not add legacy fallback transport.

**Tech Stack:** Rust, Axum/reqwest, React 19, TypeScript, Vitest, generated OpenAPI v2 transport.

## Global Constraints

- Do not retry HTTP 404.
- Keep `part:__air__` as a data-plane carrier.
- Do not hand-build endpoint strings in React modules.
- Preserve unrelated dirty-worktree changes.

### Task 1: API reuse compatibility

- [x] Add a failing launcher test for a healthy bridge whose OpenAPI lacks mandatory v2 routes.
- [x] Require the expected contract header and mandatory OpenAPI paths before reuse.
- [ ] Run focused `fullmag-cli` tests. Blocked by the pre-existing duplicate `mesh_build_report` field in `step_utils.rs`.

### Task 2: Canonical Airbox identity

- [x] Add failing tests for `__airbox__` and role-owned Airbox carriers.
- [x] Introduce one shared semantic predicate and replace literal frontend filters in the affected selection/Explorer/viewport path.
- [x] Run focused catalog, Explorer, and viewport tests.

### Task 3: Bounded availability behavior

- [x] Add failing API tests for three-attempt transient retry and zero 404 retry.
- [x] Add short backoff for network, 408, 429, and 502-504 only.
- [x] Gate mesh memberships by the runtime mesh manifest boundary; keep object-metrics 404 terminal and non-retried because absence is a valid resource state.

### Task 4: Production verification

- [x] Run Control Room focused tests, typecheck, lint, full tests, and resource-first gates.
- [x] Run browser viewport proof: canvas and region-overlay checks passed before the pre-existing Projection-control assertion failed.
- [x] Report pre-existing failures separately from changes in this plan.
