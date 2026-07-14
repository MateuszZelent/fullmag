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

### Evidence update (2026-07-14, status revision selector)

- [x] `resolveSessionStatusRevision` now includes all four region realization lanes (`region_topology_revision`, `region_membership_revision`, `region_coefficients_revision`, `region_initial_state_revision`) so status refreshes cannot miss an independent region mutation.
- [x] RED/GREEN frontend evidence: `useSessionStatus.test.ts` failed before the change (region-only revisions resolved to `0`); after the change the focused suite passed 3/3, Control Room typecheck passed, and focused ESLint passed.
- [ ] Resource DTO lane fields, exact coefficient/initial-state consumers, ETags, runtime artifact tuple and managed/browser gates remain open.

### Evidence update (2026-07-14, runtime command preconditions)

- [x] Study runtime command construction now copies all available region realization revisions from the authoritative session-status resource into `RuntimeCommandPrecondition`.
- [x] Submission refreshes the same lanes through `api.sessions.current.status()` when the command already carries region preconditions, preventing a stale cached status from authorizing a new run.
- [x] RED/GREEN frontend evidence: `studyRuntimeCommandContributions.test.ts` failed before the change because the four lane fields were omitted; after the change the focused suite passed 65/65, Control Room typecheck passed, and focused ESLint passed.
- [ ] Backend resource DTOs, exact lane-specific consumers/ETags, initial-state resource identity, runtime artifact tuple and managed/browser gates remain open.

### Evidence update (2026-07-14, resource DTO and UI cache slice)

- [x] API authoring resources expose the independent tuple on `model/regions`, `model/realized-regions`, `model/region-diagnostics`; material resources and model/data material-field resources expose the coefficient lane.
- [x] `authoring_region_owned_resources_expose_authored_payloads` asserts topology/membership/coefficient/initial-state values and material coefficient identity; focused API test passes 1/1.
- [x] OpenAPI v2 was regenerated through `pnpm --dir apps/control-room generate:api`; generated types keep the new lane fields optional for backward-compatible fixtures while active responses publish numeric values.
- [x] Control Room resource resolvers now key region-owned resources by the independent tuple/coefficient revision; focused Vitest passes 7/7, typecheck passes, and focused ESLint passes.
- [ ] Exact ETags, initial-state resource identity, consumed tuple in all runtime artifacts/plans, managed/native/browser gates and full inspector propagation remain open.

### Evidence update (2026-07-14, initial-state resource identity)

- [x] `MagnetizationAssetResource` now publishes `region_initial_state_revision` for GET and PATCH responses, sourced from the live session tuple rather than the scene journal revision.
- [x] RED/GREEN evidence: `authoring_magnetization_asset_patch_commits_transform_and_params` asserts the initial-state lane on the GET resource; focused API test passes 1/1.
- [x] OpenAPI v2 JSON and generated Control Room types were regenerated with the optional initial-state lane field.
- [ ] A dedicated initial-state resource hook/ETag, consumed tuple in run artifacts/plans, managed/browser gates and full Inspector propagation remain open.
