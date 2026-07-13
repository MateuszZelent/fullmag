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
- [ ] Dodać testy equal priority, unequal priority, three-way overlap, disabled region i conflicting texture; uruchomić Python/IR/FDM/FEM tests i potwierdzić obecny rozjazd.

### Task 2: canonical resolver

```rust
struct RegionConflictResolution { winner_region_id: String, policy: RegionConflictPolicy, candidates: Vec<String> }
```

- [ ] Przenieść resolver ponad backendami i użyć go dla mask/material/texture/mesh selection; brak legalnego winnera zwraca stable validation error.
- [ ] Zachować resolution entries w plan/provenance i zapewnić stabilność niezależną od kolejności serializacji.
- [ ] Usunąć implicit `(priority, region_id)` overwrite jako semantykę produktu.

### Task 3: round-trip i gates

- [ ] Uruchomić canonical Python export/ProblemIR round-trip, planner parity oraz Inspector tests dla każdej policy.
- [ ] Commit: `git add docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan apps/control-room && git commit -m "fix(regions): enforce canonical overlap policy"`.

**Exit:** ten sam zestaw regionów daje ten sam jawny wynik albo ten sam fail-closed reason w FDM i FEM.
