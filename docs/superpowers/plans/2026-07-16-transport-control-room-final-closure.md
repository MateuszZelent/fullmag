# Transport Control Room Final Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close exact identity, canonical validation, capability gating, five-surface parity, and browser proof for transport authoring.

**Architecture:** The backend owns candidate validation by cloning and validating the canonical scene without commit. Session status owns a bounded transport-authoring capability summary; typed v2 projections and resource hooks feed five dedicated Inspector surfaces. Deterministic CDP proves browser contracts while a separate managed gate proves real execution.

**Tech Stack:** Rust/Axum/Utoipa, OpenAPI v2, TypeScript/React, Vitest, Node test runner, Chromium CDP.

## Global Constraints

- HTTP v2 is authoritative; realtime only invalidates resources.
- No direct component `fetch()` or hand-built endpoint strings.
- Unknown authoring records remain lossless and read-only.
- Exact identities are never normalized except for whitespace-only validation.
- Generated OpenAPI artifacts are regenerated from Rust source.

---

### Task 1: Exact source binding

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

- [ ] Add a failing round-trip test with current name and spin `current_source_id` both equal to `" charge "`.
- [ ] Verify RED demonstrates source trimming.
- [ ] Preserve the source exactly after whitespace-only validation.
- [ ] Verify round-trip and Replace payload tests pass.

### Task 2: Canonical candidate validation and capabilities

**Files:**
- Modify: `crates/fullmag-api/src/schemas/status.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify/generated: `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `openapi-v2-types.ts`, `openapi-v2-paths.ts`
- Modify: `apps/control-room/src/kernel/api/{apiPaths.ts,apiTypes.ts,ControlRoomApi.ts}`

- [ ] Add failing backend tests for valid clone-only validation, invalid semantic response, stale revision, and M2/M3/GPU/single capability diagnostics.
- [ ] Add typed request/response schemas and the versioned model route using canonical scene validation without commit.
- [ ] Add the bounded active-session transport capability map and OpenAPI registration.
- [ ] Regenerate API artifacts and add facade tests.

### Task 3: Five dedicated semantic surfaces

**Files:**
- Modify: `apps/control-room/src/kernel/resources/spinAuthoringResources.ts`
- Modify: `apps/control-room/src/modules/explorer/**`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Create/modify: focused transport Inspector models and panels under `apps/control-room/src/modules/inspector/panels/`

- [ ] Add failing Explorer/selection/registry tests for Current, Spin, Interfaces, Torques, and Oersted.
- [ ] Add typed interface projection hook and owner identity mapping.
- [ ] Add typed known-variant forms and lossless unknown read-only rendering for all five surfaces.
- [ ] Add candidate validation resource hook; disable mutation while stale, invalid, unsupported, or unresolved.
- [ ] Show requested lane, resolved lane, qualification, and reason.

### Task 4: Browser contract and managed runtime gates

**Files:**
- Modify: `apps/control-room/scripts/smoke-transport-authoring-ui-cdp.mjs`
- Modify: `apps/control-room/scripts/smoke-transport-authoring-ui-runtime.mjs`
- Test: `apps/control-room/scripts/smoke-transport-authoring-ui-runtime.test.mjs`
- Create: `apps/control-room/scripts/smoke-transport-managed-runtime.mjs`
- Modify: `apps/control-room/package.json`

- [ ] Add failing script-model tests requiring exact CRUD bodies, validation requests, export request, simulation command, result inspection, capability states, and cleanup.
- [ ] Make the contract fixture stateful and label its evidence non-physical.
- [ ] Add a separate managed-runtime script that requires real command completion and published-result evidence and exits nonzero when absent.
- [ ] Run the exact-worktree audit build and CDP smoke.

### Task 5: Final verification

- [ ] Run focused Rust and UI tests.
- [ ] Run the complete changed UI suite and CDP lifecycle tests.
- [ ] Run typecheck, API hygiene, architecture hygiene, targeted ESLint, generated API checks, and `git diff --check`.
- [ ] Run audit build, exact-worktree contract CDP, and managed runtime gate or record its explicit nonzero missing-runtime evidence.
- [ ] Inspect staged scope separately, commit, and report the full hash without self-approval.
