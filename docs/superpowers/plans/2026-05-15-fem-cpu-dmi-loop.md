# FEM CPU DMI Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated Rust FEM CPU-reference DMI element loops with one shared implementation while preserving the current bootstrap physics.

**Architecture:** Add one helper that writes DMI fields into caller-provided buffers. Allocating observation paths allocate buffers and call it; workspace hot paths reuse new `FemFieldScratch` DMI buffers and add into `h_eff`.

**Tech Stack:** Rust CPU FEM reference solver, Rust source/behavior tests, Markdown audit docs.

---

### Task 1: Design Contract

**Files:**
- Create: `docs/superpowers/specs/2026-05-15-fem-cpu-dmi-loop-design.md`

- [x] **Step 1: Record physics boundary**

State that the slice preserves current strong-form P1 interfacial/bulk DMI and
does not implement weak residuals.

### Task 2: Regression Before Code

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Add source-level regression**

Add a test asserting the DMI element loop appears once in `fem.rs`.

- [x] **Step 2: Add behavior parity test**

Add a test comparing `dmi_fields_from_vectors` against the in-place add path for
interfacial + bulk DMI.

- [ ] **Step 3: Run RED where possible**

Run:

```bash
cargo test -p fullmag-engine dmi
```

Expected before implementation: source-level regression fails while both
functions still carry their own element loop. This was not re-run as a strict
red check because the implementation patch had already been applied before the
session interruption; the final targeted test was run after the regression was
added.

### Task 3: CPU DMI Loop Refactor

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Extend `FemFieldScratch`**

Add reusable `dmi_interfacial` and `dmi_bulk` buffers.

- [x] **Step 2: Add shared DMI computation helper**

Create one helper that computes interfacial and bulk DMI into caller-provided
buffers and owns the single element loop.

- [x] **Step 3: Route allocating and hot paths through the helper**

Update `dmi_fields_from_vectors` and `dmi_fields_add_into` to share the helper.

### Task 4: Verification And Audit Refresh

**Files:**
- Verify: `crates/fullmag-engine/src/fem.rs`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [x] **Step 1: Run targeted test**

Run:

```bash
cargo test -p fullmag-engine dmi
```

Result: passed, 7 DMI tests.

- [x] **Step 2: Run formatting/whitespace checks**

Run:

```bash
cargo fmt --check -p fullmag-engine
git diff --check
```

Result: both checks passed after `cargo fmt -p fullmag-engine`.

- [x] **Step 3: Update the audit**

Mark Etap 8.4 as closed for CPU Rust reference DMI loop duplication. Keep
future weak-residual DMI work open.
