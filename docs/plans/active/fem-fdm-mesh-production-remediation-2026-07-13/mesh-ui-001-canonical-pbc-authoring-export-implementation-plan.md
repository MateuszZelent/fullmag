# MESH-UI-001 — Canonical PBC authoring and Python export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zapewnić round-trip UI -> authoring scene -> ProblemIR.pbc/periodic mesh -> canonical Python -> ten sam ProblemIR.

**Architecture:** SceneDocument przechowuje physics-first PBC request, nie backend config. Authoring adapter i script builder są jedynymi canonicalization paths dla UI i Pythona.

**Tech Stack:** Rust authoring/API, Python script builder, React commands

## Global Constraints

- UI nie tworzy drugiego modelu PBC.
- Requested discretization/device/precision/PBC pozostają jawne.
- Eksport używa canonical Python DSL i ma semantic equality test.

---

**Finding:** MESH-UI-001, P0.

### Task 1: ADR/RED round-trip

- [ ] Zaktualizować ADR `0012-canonicalization-backbone.md` i physics note 0600 o authored PBC fields i periodic pair IDs.
- [ ] Dodać fixtures static FDM PBC, FEM periodic mesh i Bloch vector; `UI scene -> IR -> Python -> IR` musi dziś FAIL.

### Task 2: canonical fields

```rust
pub struct ScenePbc { pub axes: [bool; 3], pub demag: String, pub image_counts: Option<[u32; 3]>, pub wavevector_per_m: Option<[f64; 3]> }
```

- [ ] Dodać typ/validation/adapters w `crates/fullmag-authoring`; mapowanie API commands; Python `scene_document.py` i `script_builder.py`.
- [ ] Włączyć Export Python command w Ribbon tylko gdy canonicalization resource jest valid; surfaced validation errors zamiast disabled bez reason.
- [ ] Uruchomić Rust/Python/UI round-trip tests; PASS.

### Task 3: full gates

- [ ] Uruchomić generated API, typecheck, lint, test, API/architecture hygiene.
- [ ] Commit: `git add docs/adr/0012-canonicalization-backbone.md docs/physics/0600-periodic-boundary-conditions.md crates/fullmag-authoring crates/fullmag-api packages/fullmag-py apps/control-room && git commit -m "feat(authoring): round-trip canonical PBC to Python"`.

**Exit:** wszystkie trzy fixtures wracają do semantycznie identycznego ProblemIR; UI export nie traci PBC ani mesh pairing intent.

### Evidence update (2026-07-14, Python canonical export slice)

- [x] Canonical script rendering now emits the authored problem-level PBC via
  `study.pbc(...)` or `fm.pbc(...)`, including active axes, demag realization
  and truncated-image counts; PBC is no longer represented only as a mesh
  `periodic_pair_ids` option.
- [x] Added a UI-adjacent authoring round-trip fixture: load a FEM study with
  `x/y` periodic airbox demag, render canonical Python, reload it, and compare
  `ProblemIR.pbc` — focused test passed 1/1.
- [ ] Rust SceneDocument/API adapters, browser export command gating and the
  full UI/OpenAPI gates remain open.
- [ ] The broader `test_api.py -k "pbc or script_rewrite"` selection still has
  one pre-existing dispersion-k-path expectation failure unrelated to PBC
  rendering; it is not counted as a pass for the full suite.
