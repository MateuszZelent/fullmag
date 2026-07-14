# MESH-REGION-011 — Region realization revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** System rozróżnia identity grid/topology, region membership, coefficient realization i initial state, aby unieważniać dokładnie zależne zasoby.

**Architecture:** Session publikuje jawne monotoniczne revisions/digests i dependency graph. Region mutation classifier z MESH-REGION-001 zwiększa odpowiedni węzeł; API resources i runtime plan zapisują wszystkie consumed revisions.

**Tech Stack:** Rust session/runtime/API, OpenAPI resources, TypeScript cache keys

## Global Constraints

- Scene revision nie może udawać mesh revision.
- Każdy wynik zapisuje exact consumed revision tuple.
- Stara generacja może być wyświetlana jako stale, lecz nie może uruchomić nowego runu.

---

**Finding:** MESH-REGION-011, P1.
**Dependencies:** MESH-REGION-001.

### Task 1: RED dependency matrix

- [ ] Dodać session tests dla metadata-only, texture-only, coefficient-only, membership-only i topology mutations; sprawdzić minimalny oczekiwany zestaw zmienionych revisions.
- [ ] Dodać run precondition tests dla stale membership/coefficient/topology; obecny wspólny scene revision ma dać RED.

### Task 2: canonical revision tuple

```rust
struct RegionRealizationRevisions {
    topology: u64,
    membership: u64,
    coefficients: u64,
    initial_state: u64,
}
```

- [ ] Dodać tuple do session state, plans, artifacts i thin status summary; szczegóły są named resources.
- [ ] Zdefiniować dependency graph: topology -> membership -> coefficients/initial state -> results; commit aktualizuje atomowo.
- [ ] Zmienić cache keys/ETags tak, aby używały właściwego revision zamiast całej scene revision.

### Task 3: verification

- [ ] Uruchomić session/runner/API tests, OpenAPI hygiene oraz Control Room resource tests; udowodnić brak grid rebuild dla FDM material rename i wymagany block dla FEM conformal shape edit.
- [ ] Commit: `git add crates/fullmag-session crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-api apps/control-room && git commit -m "feat(runtime): version region realizations independently"`.

**Exit:** każdy resource i run precondition może jednoznacznie stwierdzić, której realizacji regionów używa.

## Evidence update (2026-07-14)

- [x] Dodano backend-neutralny classifier `classify_region_realization_impact` oraz tuple `RegionRealizationRevisions` w `crates/fullmag-authoring/src/region_revisions.rs`.
- [x] Classifier rozdziela metadata-only, membership, coefficients, initial-state/texture i topology; `advance` zwiększa wyłącznie wskazane monotoniczne rewizje.
- [x] Testy jednostkowe: `cargo test -p fullmag-authoring region_revisions --lib` — 3 passed.
- [ ] Session/API status, plans, artifacts, ETags/cache keys i run preconditions nie konsumują jeszcze tuple; pozostają do wdrożenia w Tasks 2–3.
- [ ] Brak jeszcze atomicznego commit/classifiera używanego przez istniejące API mutacji regionów; obecny moduł jest kontraktem backend-neutralnym i nie zmienia dotychczasowego lifecycle.

## Evidence update (2026-07-14, API/session slice)

- [x] `SessionStateResponse` oraz persisted live snapshot przechowują niezależny tuple rewizji; pierwszy commit sceny zwiększa wszystkie lane'y, a kolejne commity używają classifiera i aktualizują tylko zależne lane'y.
- [x] Thin status publikuje `region_topology_revision`, `region_membership_revision`, `region_coefficients_revision` i `region_initial_state_revision`; `RegionOwnedArtifactProvenance` zapisuje ten sam tuple.
- [x] OpenAPI v2 JSON i wygenerowane typy Control Room zawierają cztery pola rewizji.
- [x] `cargo test -p fullmag-api router_v2::tests::authoring_scene_put_commits_scene_document --no-fail-fast -- --nocapture` — 1 passed.
- [x] `cargo test -p fullmag-api router_v2::tests::status_returns_200_with_live_session --no-fail-fast -- --nocapture` — 1 passed.
- [x] `cargo check -p fullmag-api` — passed; only pre-existing `FrequencyResponseProgressMetadata` dead-code warning.
- [ ] Cache keys/ETags, plans, runtime artifacts and Control Room consumers do not yet consume the tuple; managed/API hygiene and browser gates remain open.

### Evidence update (2026-07-14, stale-run preconditions)

- [x] `RuntimeCommandPrecondition` now accepts independent topology, membership, coefficients and initial-state revision expectations; command validation rejects mismatches with explicit conflict diagnostics.
- [x] `commands_endpoint_rejects_resource_revision_precondition_mismatches` covers a membership mismatch; focused API test — 1 passed.
- [x] OpenAPI v2 JSON and generated Control Room types include the four optional precondition fields.
- [ ] Plan cache keys/ETags and runtime artifact consumers still need exact consumed tuple propagation; UI/browser and managed gates remain open.

### Evidence update (2026-07-14, membership cache identity)

- [x] `resolveMeshRegionMembershipRevision` now includes the authoritative `region_membership_revision` in addition to mesh generation identity, region ID and source.
- [x] RED/GREEN frontend evidence: the focused resource test failed before the change because two membership revisions produced the same cache revision; after the change `geometryLifecycleResources.test.ts` passed 6/6, Control Room typecheck passed, and focused ESLint passed.
- [ ] Coefficient/initial-state cache lanes, runtime artifact consumed tuple and managed/browser gates remain open.
