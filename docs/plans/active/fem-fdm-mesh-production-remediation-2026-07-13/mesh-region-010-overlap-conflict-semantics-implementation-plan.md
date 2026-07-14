# MESH-REGION-010 — Region overlap conflict semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nakładające się regiony mają jedną, publiczną i deterministyczną semantykę konfliktów we wszystkich backendach.

**Architecture:** Physics note definiuje ownership osobno dla materiałów, texture i mesh size. `conflict_policy` jest canonical enumem w Python/ProblemIR/planner; resolver zwraca winner oraz provenance albo fail-closed, bez leksykograficznego tie-breaku ukrytego w implementacji.

**Tech Stack:** Physics docs, Python DSL, ProblemIR, FDM/FEM planners

## Global Constraints

- Równe priority bez jawnej polityki nie mogą mieć ukrytego zwycięzcy.
- Conformal overlapping volumes pozostają odrzucone, jeśli jednoznaczna partycja nie jest dowiedziona.
- Round-trip UI/Python zachowuje policy bez reinterpretacji.

---

**Finding:** MESH-REGION-010, P1.

### Task 1: publikacja i RED matrix

- [ ] Uzupełnić `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md` o truth table `error`, `higher_priority_wins`, `min_mesh_size_wins` dla material/texture/mesh.
- [x] Dodać regresję equal-priority FDM overlap; przed zmianą test był RED (planner wybierał region przez ukryty tie-break po ID), po zmianie jest GREEN.
- [ ] Dodać pełną macierz unequal priority, three-way overlap, disabled region i conflicting texture oraz testy Python/IR/FDM/FEM.

### Task 2: canonical resolver

```rust
struct RegionConflictResolution { winner_region_id: String, policy: RegionConflictPolicy, candidates: Vec<String> }
```

- [x] Dodać wspólny resolver `crates/fullmag-plan/src/region_conflict.rs` i użyć go w FDM region-mask oraz spatial material resolution; equal-priority konflikt kończy się stable fail-closed reason, bez wyboru po ID.
- [ ] Użyć resolvera również dla texture/mesh-size ownership i zachować resolution entries w plan/provenance.
- [x] Usunąć implicit `(priority, region_id)` overwrite jako semantykę FDM maski.

### Task 3: round-trip i gates

- [ ] Uruchomić canonical Python export/ProblemIR round-trip, planner parity oraz Inspector tests dla każdej policy.
- [ ] Commit: `git add docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan apps/control-room && git commit -m "fix(regions): enforce canonical overlap policy"`.

### Evidence (2026-07-14, partial)

- `cargo test -p fullmag-plan fdm_equal_priority_overlapping_regions_fail_closed_without_hidden_region_id_tie_break --lib` — PASS.
- `cargo test -p fullmag-plan --lib --no-fail-fast` — 200 passed, 0 failed.
- `FdmGridCertificateIR` rozdziela walidację bounded region-LUT od multilayer topology tokens (`new_with_topology_tokens`, `validate_against_topology_tokens`); to konieczne, bo tokeny topologii nie są indeksami LUT.
- Pozostaje otwarte: Python/IR round-trip, texture/mesh resolver, provenance resolution entries, pełna macierz polityk, UI/Inspector oraz managed/native gates.

**Exit:** ten sam zestaw regionów daje ten sam jawny wynik albo ten sam fail-closed reason w FDM i FEM.
