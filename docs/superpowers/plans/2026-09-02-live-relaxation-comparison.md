# Live Relaxation Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, scalar-only comparison of the post-relaxation `mx`, `my`, and `mz` values for MuMax3 and all six in-scope Fullmag lanes, including Fredkin–Köhler CPU/GPU once their qualification reports pass.

**Architecture:** Keep the existing static-file server and dynamic charts. Extend each source definition with relaxation-table paths, read the completed relaxation table before live stage probing, and render a separate three-chart section from each source's last relaxation row. MuMax3 continues to use its existing `table.txt` parser; FK definitions remain pending until a validator-produced qualification report has status `PASS`.

**Tech Stack:** Plain HTML/CSS/JavaScript, Python `unittest`, `http.server`.

## Global Constraints

- Compare only MuMax3, Fullmag FDM CPU/GPU, Fullmag FEM Poisson–Robin CPU/GPU, and Fullmag FEM Fredkin–Köhler CPU/GPU.
- Keep the page scalar-only; do not read magnetization field snapshots.
- Preserve one-second polling, no-cache requests, legend toggles, and existing dynamic/energy charts.
- Use the current benchmark artifact names, require qualification reports for FK,
  and mark unavailable or unqualified sources as waiting.
- Do not commit or overwrite unrelated dirty-worktree changes.

---

### Task 1: Add relaxation data contracts and rendering

**Files:**
- Modify: `tests/fem_fdm_mumax3_sinc_layer/live-results.html`

**Interfaces:**
- Each Fullmag source definition exposes `relaxLiveCsv`, `relaxCsv`, and `relaxRoots`.
- `readBackend(definition, stage)` returns the same normalized scalar row shape for `stage="relaxation"` and `stage="dynamic"`.
- The page renders `#relaxation-grid` using the existing `chartCard` and legend toggle behavior.

- [ ] Add relaxation artifact candidates for each Fullmag lane, including `artifacts/tables/relaxation/table.csv`, `tables/relaxation/table.csv`, and the stage-table fallback; keep FK qualification paths alongside them.
- [ ] Add a relaxation-stage Zarr reader that probes `stages/stage_NNNN_relax/table` and tolerates incomplete last chunks.
- [ ] Load relaxation data independently from dynamic data during each polling pass.
- [ ] Render three relaxation cards whose series values are the last available row per source, using the same source colors and line styles as the dynamic plots.
- [ ] Keep the existing dynamic cards and latest dynamic table unchanged.

### Task 2: Extend contract tests

**Files:**
- Modify: `tests/fem_fdm_mumax3_sinc_layer/test_live_results.py`

- [ ] Assert that relaxation artifact paths, FK qualification paths, relaxation-stage probing, and the `relaxation-grid` are present.
- [ ] Assert that the page still contains no field-snapshot reader.
- [ ] Run the focused test file and then the complete benchmark contract suite.

### Task 3: Verify runtime and browser

**Files:**
- Read: `scripts/analysis/serve_fdm_fem_mumax3_live.py`
- Read: `tests/fem_fdm_mumax3_sinc_layer/live-results.html`

- [ ] Start the static monitor with `python scripts/analysis/serve_fdm_fem_mumax3_live.py` when port 8765 is free.
- [ ] Open `http://127.0.0.1:8765/live-results.html` and verify the relaxation section, all five in-scope legends, waiting states, and polling behavior.
- [ ] Record the exact server command and whether current artifacts are complete or still pending.
