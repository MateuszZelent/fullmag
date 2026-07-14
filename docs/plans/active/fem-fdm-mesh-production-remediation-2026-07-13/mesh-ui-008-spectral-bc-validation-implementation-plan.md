# MESH-UI-008 — Semantic spectral boundary validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walidować Bloch/Floquet wavevector, jednostki i zgodność z authored PBC mesh przed build/run.

**Architecture:** Authoring model przechowuje typed `k_vector_rad_per_m`; backend canonical validator sprawdza skończoność, aktywne osie, reciprocal-cell interpretation i wymagany current v6. UI wyświetla generated validation reasons.

**Tech Stack:** Rust authoring/ProblemIR validation, TypeScript Inspector model, OpenAPI

## Global Constraints

- Publiczna jednostka to `rad/m`; UI label i export są jawne.
- Komponent na nieperiodycznej osi jest odrzucany, jeśli physics note nie definiuje innej semantyki.
- k=0 nie omija wymogu poprawnego periodic mesh dla problemu okresowego.

---

**Finding:** MESH-UI-008, P1.
**Dependencies:** MESH-UI-001, MESH-PBC-FEM-002 i capability gating.

### Task 1: physics/RED validation matrix

- [x] Uściślić w `docs/physics/0600-periodic-boundary-conditions.md` jednostki, aktywne osie i k=0.
- [x] Dodać RED→GREEN tests dla NaN/Inf, złej liczby składowych, nonperiodic component, missing/stale v6, k=0 valid i nonzero valid.

### Task 2: typed authoring contract

```rust
pub struct BlochWavevectorIR { pub k_vector_rad_per_m: [f64; 3] }
```

- [ ] Zastąpić `String` w `crates/fullmag-authoring/src/builder.rs` typed vector i canonical validation; adapters/export używają tego samego pola.
- [x] Dodać backendowy typed contract `fullmag_ir::BlochWavevectorIR` i walidator przeciw accepted `periodic_mesh_certificate.v6`; walidator jest gotowy do podpięcia w plannerze/runtime.
- [ ] `StudyStageAuthoringModel.ts` parsuje trzy skończone liczby, ale backend reason pozostaje autorytatywny; UI nie wysyła raw string.
- [ ] Uruchomić authoring/API/UI focused tests; PASS.

### Task 3: gates

- [ ] Regenerować OpenAPI client; uruchomić typecheck, lint, test i API hygiene.
- [ ] Commit: `git add docs/physics/0600-periodic-boundary-conditions.md crates/fullmag-authoring crates/fullmag-api apps/control-room/src/modules/inspector/panels && git commit -m "fix(authoring): validate spectral PBC wavevectors"`.

### Bounded slice evidence (2026-07-14)

- `cargo test -p fullmag-ir spectral_validation` — 5 passed.
- Zakres celowo nie obejmuje jeszcze zamiany legacy `String` w authoringu,
  Python script-export, OpenAPI/generated types, Inspectora ani wywołania
  walidatora z planner/runtime; te gate'y wymagają osobnego round-trip i
  fixture'ów UI z aktualnym certyfikatem v6.

**Exit:** niepoprawny wavevector nie dociera do planner/runtime; valid k=0/nonzero round-tripuje w `rad/m` i jest związany z current certificate.
