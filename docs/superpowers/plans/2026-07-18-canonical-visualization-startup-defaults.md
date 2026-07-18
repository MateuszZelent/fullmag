# Canonical Visualization Startup Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start magnetic objects as HSL surface-only while Airbox/non-magnetic targets have no active pass, preserving explicit Python/v2 values.

**Architecture:** Canonical v2 layer defaults remain the source of truth. The frontend controller uses matching fallback constants only when the resource has no explicit value; resolved target settings and nested layer values always win.

**Tech Stack:** Rust/Axum/Utoipa OpenAPI v2, TypeScript, Vitest.

## Global Constraints

- Do not add browser-persisted simulation defaults or a second authoring state.
- Preserve explicit v2 target/layer/style values, including values lowered from Python.
- Keep v2 HTTP resources authoritative and regenerate generated OpenAPI artifacts if schemas change.

---

### Task 1: Canonical default layers and resolved targets

**Files:**
- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Produces object defaults with `surface.visible=true`, HSL/orientation surface source, and every optional display pass disabled.
- Produces Airbox defaults with master target visible and all display passes disabled.

- [x] Add a failing router test asserting the object and Airbox resolved defaults.
- [x] Run `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api visualization_state_ --no-fail-fast` and confirm it fails on the old Airbox wireframe default.
- [x] Change only canonical default constructors/layer builders needed to make the test pass.
- [x] Cover an explicit nested target/layer value superseding the default.
- [x] Re-run the focused API test.

### Task 2: Frontend resolution and reset behavior

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Test: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts`

**Interfaces:**
- `DEFAULT_OBJECT_VISUALIZATION` remains HSL surface-only.
- `DEFAULT_AIRBOX_VISUALIZATION` has all passes disabled.
- `resolveAirboxVisualizationSettingsFromState` and Airbox reset preserve resource-provided explicit values and otherwise use canonical defaults.

- [x] Add failing frontend tests for all-pass-off Airbox fallback and explicit resource override precedence.
- [x] Run the focused Vitest files and confirm the old wireframe fallback fails.
- [x] Update fallback/reset constants and mappings with no local persistence changes.
- [x] Re-run focused tests.

### Task 3: Contract generation and verification

**Files:**
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

- [x] Regenerate with `CARGO_TARGET_DIR=/tmp/fullmag-codex-target pnpm --dir apps/control-room generate:api` after the schema change.
- [x] Run API tests, frontend typecheck, lint, and focused/full visualization tests.
- [x] Run resource-first and contract gates.
