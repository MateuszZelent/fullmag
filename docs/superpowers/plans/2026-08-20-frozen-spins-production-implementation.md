# Frozen Spins Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wdrożyć produkcyjne frozen spins od ergonomicznego Python DSL i typed `ProblemIR`, przez planner oraz FDM/FEM CPU/GPU, po wersjonowane API v2 i Control Room z ribbonem, podgałęzią regionu, dedykowanym Inspectorem oraz overlayem maski.

**Architecture:** Użytkownik przypisuje frozen spins do ferromagnetyka lub jego regionu w sposób analogiczny do MuMax3, ale lowering tworzy osobny top-level `MagnetizationConstraintIR::FrozenSpins` wskazujący typed `SelectionExprIR`. Jeden kompilator selekcji materializuje niezależną `frozen_mask` dla solvera i preview UI; runtime zeruje pełny RHS, odtwarza referencję po każdym stanie kandydującym i wykonuje normy po swobodnych DOF.

**Tech Stack:** Python 3 typed dataclasses, Rust/Serde/OpenAPI, FDM Rust reference, CUDA C++/C ABI, MFEM/hypre/libCEED, Next.js 16, React, TypeScript, Zustand, Three.js/R3F, Vitest/Playwright, container-backed `just` recipes.

## Global Constraints

- Dokumentacja fizyczna jest nadrzędna względem implementacji i musi spełnić `scientific-documentation-contract`.
- `FrozenSpins` jest constraintem stopni swobody, nie materiałem, `alpha=0`, zerowym `H_eff` ani rozszerzeniem `region_mask`.
- Zamrożone spiny pozostają źródłem pól i składnikiem pełnej energii.
- Pełny RHS jest maskowany dopiero po złożeniu LLG, STT, SOT, termiki i pozostałych momentów.
- Referencja jest twardo odtwarzana po każdym podkroku, stanie próbnym, normalizacji, retrakcji i zaakceptowanym kroku.
- Normy sterujące, redukcje BB/NCG i kryteria stopu obejmują wyłącznie swobodne DOF; telemetry publikuje wartości `free` i `all`.
- Domyślne polityki V1: `capture_current_at_activation`, geometry `static`, state `snapshot_at_activation`, boundary `inclusive`, empty selection `error`, inactive selection `warn_and_intersect`.
- `live_accepted_step_membership`, dowolne lambdy/string expressions, częściowe zamrażanie składowych i niekwalifikowane imported CAD pozostają poza V1.
- Control Room pozostaje resource-first: komponenty nie tworzą endpointów ręcznie, status JSON pozostaje cienki, ciężkie maski używają data plane.
- Wszystkie klasy CSS w `apps/control-room` używają prefiksu `fm-`; komponenty korzystają z tokenów `--fm-*` oraz wspólnych shadcn/ui-style primitives.
- Inspector używa field-scoped pending state, nie remountuje się podczas ACK/invalidation i zachowuje focus, scroll oraz drafty.
- Każda zmiana viewportu przechodzi rzeczywisty browser smoke: widoczny canvas, `gl.isContextLost() == false`, niezerowy drawing buffer.
- Native FEM/MFEM/CUDA/hypre/libCEED buduje się i kwalifikuje wyłącznie przez container-backed receptury repozytorium `just`.
- Istniejące niezwiązane zmiany `apps/control-room/next-env.d.ts`, `external_solvers/3` i cudze dokumenty pozostają nietknięte.
- Nie commitować ani nie pushować bez osobnej zgody użytkownika; kroki checkpoint zastępują automatyczne commity.

---

## Faza I — Kontrakt naukowy, geometria, Python i ProblemIR

### Task 1: ADR, publikacyjny kontrakt fizyczny i macierz kwalifikacji

**Files:**
- Create: `docs/adr/0026-frozen-spins-constraint-and-selection-model.md`
- Create: `docs/physics/0996-frozen-spins-constraint.md`
- Create: `docs/physics/0996-frozen-spins-constraint.source-map.json`
- Create: `docs/specs/selection-expr-v1.md`
- Create: `docs/specs/frozen-spins-v1.md`
- Create: `docs/validation/frozen-spins-qualification-matrix.md`

**Interfaces:**
- Consumes: zatwierdzony projekt `docs/superpowers/specs/2026-08-20-frozen-spins-production-design.md`.
- Produces: zamknięte decyzje `frozen_spins.v1`, `selection_expr.v1`, capture timing, free/all metrics, all-frozen i capability vocabulary używane przez wszystkie kolejne zadania.

- [ ] **Step 1: Uruchomić wymagane umiejętności dokumentacyjne**

Przeczytać w całości `.agents/skills/physics-publication/SKILL.md`, `.agents/skills/scientific-documentation-contract/SKILL.md` i `.agents/skills/adr-check/SKILL.md`; utworzyć checklisty wskazane przez te umiejętności.

- [ ] **Step 2: Napisać failing validation fixture**

W `docs/validation/frozen-spins-qualification-matrix.md` utworzyć macierz lane z kolumnami `IR`, `planner`, `runtime`, `scientific`, `managed`, `browser`, a wszystkie lane rozpocząć jako `UNQUALIFIED`.

- [ ] **Step 3: Zapisać równania i inwarianty**

W nocie fizycznej zdefiniować `F`, `U`, `m*`, constrained energy `E(m_U, m_F*)`, final-RHS masking, candidate restore, free-domain reductions, termikę, STT/SOT, TPI i `all_active_dofs_frozen` wraz z jednostkami SI i ograniczeniami ważności.

- [ ] **Step 4: Zamknąć decyzje ADR**

ADR ma jawnie przyjąć: top-level definitions + activation scope, osobny constraint zamiast region property w IR, `disk` lowering do skończonego cylindra, brak float `==`, true-DOF preview FEM, dense runtime reference, snapshot V1 i relaksacja+dynamika od początku.

- [ ] **Step 5: Uruchomić walidatory dokumentacji**

Run: receptury dokumentacyjne wskazane przez `scientific-documentation-contract` oraz skan niedomkniętych znaczników przez `rg -n "T[B]D|T[O]DO|do ustalenia" docs/adr/0026-frozen-spins-constraint-and-selection-model.md docs/physics/0996-frozen-spins-constraint.md docs/specs/selection-expr-v1.md docs/specs/frozen-spins-v1.md`.

Expected: walidatory PASS; `rg` bez wyników.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- docs/adr docs/physics docs/specs docs/validation`.

Expected: exit 0; brak zmian poza plikami zadania.

### Task 2: Kanoniczny evaluator predykatów geometrycznych

**Files:**
- Create: `crates/fullmag-plan/src/selection/mod.rs`
- Create: `crates/fullmag-plan/src/selection/geometry.rs`
- Create: `crates/fullmag-plan/src/selection/tests.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/geometry.rs`
- Modify: `crates/fullmag-plan/src/regional_field_drive.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs`

**Interfaces:**
- Consumes: `GeometryEntryIR`, `ObjectRegionIR`, scene translation/quaternion/scale/pivot.
- Produces: `GeometryPredicate`, `AffineTransform3`, `BoundaryMembership`, `contains_point(predicate, world_point_m) -> Result<bool, SelectionError>`.

- [ ] **Step 1: Napisać failing property and parity tests**

Testy obejmują Box, Cylinder, Sphere, Union, Intersection, Difference, inclusive boundary, inverse translation/rotation/nonuniform scale/pivot oraz identyczne wyniki regional-field, FDM region i API preview dla wspólnego corpusu punktów.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-plan selection::tests -- --nocapture`.

Expected: FAIL, ponieważ moduł `selection` i `contains_point` nie istnieją.

- [ ] **Step 3: Wprowadzić minimalny kontrakt evaluatora**

```rust
pub(crate) fn contains_point(
    predicate: &GeometryPredicate,
    world_point_m: [f64; 3],
) -> Result<bool, SelectionError>;

pub(crate) struct AffineTransform3 {
    pub translation_m: [f64; 3],
    pub rotation_xyzw: [f64; 4],
    pub scale: [f64; 3],
    pub pivot_m: [f64; 3],
}
```

Implementacja odwraca transformację punktu świata dokładnie raz przed testem prymitywu. Nieodwracalna skala, nieznany CSG i imported solid zwracają typed error.

- [ ] **Step 4: Przepiąć istniejących konsumentów**

`regional_field_drive`, FDM membership i `mesh_region_membership` używają `contains_point`; usunąć ich lokalne rozbieżne gałęzie tylko w zakresie zastąpionym wspólnym kontraktem.

- [ ] **Step 5: Potwierdzić GREEN**

Run: `cargo test -p fullmag-plan selection::tests && cargo test -p fullmag-plan regional_field_drive && cargo test -p fullmag-api mesh_region_membership`.

Expected: wszystkie wskazane testy PASS; unsupported CSG/world-frame zwracają błąd, nie pustą maskę.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- crates/fullmag-plan crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs`.

Expected: exit 0.

### Task 3: Python geometry parity i convenience `disk`

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/geometry.py`
- Modify: `packages/fullmag-py/src/fullmag/shapes.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Create: `packages/fullmag-py/tests/test_selection_geometry.py`

**Interfaces:**
- Consumes: kanoniczne geometry predicate variants i affine contract z Task 2.
- Produces: `disk(...)`, `rotate(...)`, `scale(...)`, `affine(...)` budujące serializowalny AST bez wykonywania selekcji w Pythonie.

- [ ] **Step 1: Napisać failing Python tests**

```python
def test_disk_lowers_to_finite_cylinder() -> None:
    shape = fm.shapes.disk(radius=25e-9, thickness=3e-9)
    assert shape.to_ir() == {
        "kind": "cylinder",
        "center_m": [0.0, 0.0, 0.0],
        "axis": [0.0, 0.0, 1.0],
        "radius_m": 25e-9,
        "height_m": 3e-9,
    }
```

Testy negatywne: `radius <= 0`, `thickness <= 0`, zerowa normalna, nieodwracalna skala i `through_object` bez jawnego obiektu.

- [ ] **Step 2: Potwierdzić RED**

Run: `pytest -q packages/fullmag-py/tests/test_selection_geometry.py`.

Expected: FAIL z brakiem `disk`.

- [ ] **Step 3: Zaimplementować typed geometry builders**

API zwraca istniejące typy shape/geometry; `disk` obniża do cylindra, a `through_object` zachowuje typed extrusion policy do czasu rozstrzygnięcia bounds obiektu w loweringu.

- [ ] **Step 4: Potwierdzić GREEN i round-trip**

Run: `pytest -q packages/fullmag-py/tests/test_selection_geometry.py packages/fullmag-py/tests/test_api.py`.

Expected: PASS.

- [ ] **Step 5: Checkpoint review**

Run: `git diff --check -- packages/fullmag-py`.

Expected: exit 0.

### Task 4: Typed `SelectionExprIR` i Python selection DSL

**Files:**
- Create: `crates/fullmag-ir/src/selection.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`
- Create: `packages/fullmag-py/src/fullmag/model/selection.py`
- Create: `packages/fullmag-py/src/fullmag/select.py`
- Modify: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Create: `packages/fullmag-py/tests/test_selection_contract.py`

**Interfaces:**
- Produces: `SelectionDefinitionIR`, `SelectionExprIR`, `SelectionScalarExprIR`, `ComparisonOpIR`, `SelectionFrameIR`, `SelectionLimits`, `canonical_selection_sha256` oraz Python `Selection`, `select.in_object`, `select.in_region`, `select.inside`, `select.m`, `select.between`.

- [ ] **Step 1: Napisać failing Rust serde/validation tests**

Testować round-trip każdego wariantu, `deny_unknown_fields`, brak lambd/string expressions, cykle refs, maksymalną głębokość 32, maksymalnie 1024 węzły, niepusty `And/Or/Xor`, znormalizowaną oś dot product i deterministyczny hash.

- [ ] **Step 2: Potwierdzić Rust RED**

Run: `cargo test -p fullmag-ir selection -- --nocapture`.

Expected: FAIL z brakiem modułu `selection`.

- [ ] **Step 3: Zdefiniować typed Rust AST**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionExprIR {
    AllMagnetic {},
    InObject { object_id: String },
    InRegion { object_id: String, region_id: String },
    InsideGeometry { geometry: GeometryPredicateIR, frame: SelectionFrameIR,
        sampling: SelectionSamplingIR, boundary: BoundaryMembershipIR },
    Compare { lhs: SelectionScalarExprIR, op: ComparisonOpIR,
        rhs: SelectionScalarExprIR, tolerance: ComparisonToleranceIR },
    Between { value: SelectionScalarExprIR, lower: f64, upper: f64,
        closed: ClosedIntervalIR },
    And { expressions: Vec<SelectionExprIR> },
    Or { expressions: Vec<SelectionExprIR> },
    Xor { expressions: Vec<SelectionExprIR> },
    Not { expression: Box<SelectionExprIR> },
    Ref { selection_id: String },
}
```

- [ ] **Step 4: Napisać failing Python DSL tests**

```python
selector = (
    sel.in_region(magnet, pinning)
    & (sel.m.z > 0.5)
    & sel.between(sel.m.x, -0.4, 0.4)
)
assert selector.to_ir()["kind"] == "and"
```

Sprawdzić deterministyczne ID/ref, odrzucenie callable i string expression oraz zgodność JSON z Rust fixture.

- [ ] **Step 5: Zaimplementować Python AST builders i potwierdzić GREEN**

Run: `pytest -q packages/fullmag-py/tests/test_selection_contract.py && cargo test -p fullmag-ir selection`.

Expected: PASS; Python i Rust generują zgodne fixtures.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- crates/fullmag-ir packages/fullmag-py`.

Expected: exit 0.

### Task 5: `MagnetizationConstraintIR`, stage activation i ergonomiczne API regionu

**Files:**
- Create: `crates/fullmag-ir/src/constraint.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Modify: `crates/fullmag-ir/src/model.rs`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`
- Create: `packages/fullmag-py/src/fullmag/model/constraints.py`
- Modify: `packages/fullmag-py/src/fullmag/model/structure.py`
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Create: `packages/fullmag-py/tests/test_frozen_spins_contract.py`

**Interfaces:**
- Consumes: `SelectionExprIR` i Python `Selection` z Task 4.
- Produces: `MagnetizationConstraintIR::FrozenSpins`, reference/membership/activation policies, `ObjectRegion.freeze_spins(...)`, `Ferromagnet.freeze_spins(...)`, stage `constraints=[...]`, top-level lowering.

- [ ] **Step 1: Napisać failing IR tests**

Testy obejmują serde, previous-version migration do pustych kolekcji, brak obiektu/regionu/stage, duplikat ID, conflict referencji na nakładającej się masce, domyślne polityki i `deny_unknown_fields`.

- [ ] **Step 2: Zdefiniować typed constraint contract**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MagnetizationConstraintIR {
    FrozenSpins(FrozenSpinsIR),
}

pub struct FrozenSpinsIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub selector: SelectionExprIR,
    pub reference: FrozenReferencePolicyIR,
    pub membership: SelectionMembershipPolicyIR,
    pub activation: ConstraintActivationIR,
    pub empty_selection: EmptySelectionPolicyIR,
    pub inactive_selection: InactiveSelectionPolicyIR,
}
```

- [ ] **Step 3: Napisać failing ergonomic Python test**

```python
pinning = magnet.add_region(region_id="pinned_edge", shape=fm.Box(...))
pinning.freeze_spins(stage_ids=["relax"])
ir = problem.to_ir()
assert ir["magnetization_constraints"][0]["selector"] == {
    "kind": "in_region",
    "object_id": magnet.object_id,
    "region_id": "pinned_edge",
}
```

Jawny `fm.FrozenSpins(...)` i convenience API muszą generować identyczny kanoniczny JSON.

- [ ] **Step 4: Zaimplementować lowering i stage activation**

Convenience method rejestruje typed definition w `Problem`, a stage sugar tworzy lub referuje top-level constraint; constraint nie jest zapisywany jako materiał regionu.

- [ ] **Step 5: Potwierdzić GREEN**

Run: `cargo test -p fullmag-ir frozen_spins && pytest -q packages/fullmag-py/tests/test_frozen_spins_contract.py packages/fullmag-py/tests/test_study_stages.py`.

Expected: PASS.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- crates/fullmag-ir packages/fullmag-py`.

Expected: exit 0.

## Faza II — Planner, resolved mask i API v2

### Task 6: Kompilator selekcji FDM/FEM i resolved plan certificate

**Files:**
- Create: `crates/fullmag-plan/src/selection/certificate.rs`
- Create: `crates/fullmag-plan/src/selection/fdm.rs`
- Create: `crates/fullmag-plan/src/selection/fem.rs`
- Modify: `crates/fullmag-plan/src/selection/mod.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Produces: `ResolvedFrozenSpinsPlanIR`, `SelectionCertificateIR`, `compile_fdm_frozen_spins`, `compile_fem_frozen_spins`, dense `frozen_mask`, counts, bounds, source revision i hashes.

- [ ] **Step 1: Napisać failing exact-mask fixtures**

FDM fixture używa małego gridu z aktywnymi/nieaktywnymi komórkami i nakładającymi się regionami. FEM fixture obejmuje P1 oraz P2, współdzielone true DOF i airbox. Oczekiwane maski są zapisane literalnie.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-plan frozen_spins -- --nocapture`.

Expected: FAIL z brakiem compiler functions.

- [ ] **Step 3: Zdefiniować resolved plan**

```rust
pub struct ResolvedFrozenSpinsPlanIR {
    pub schema_version: String,
    pub constraint_ids: Vec<String>,
    pub frozen_mask: Vec<bool>,
    pub frozen_dof_count: u64,
    pub free_dof_count: u64,
    pub mask_sha256: String,
    pub grid_or_mesh_fingerprint: String,
    pub source_state_revision: Option<u64>,
    pub all_active_dofs_frozen: bool,
    pub certificate: SelectionCertificateIR,
}
```

- [ ] **Step 4: Zaimplementować candidate compilation i overlap rules**

Wspólna kolejność: resolve refs → geometry candidates → state predicate marker → active intersection → union zgodnych capture policies → hard error dla konfliktujących referencji → counts/hash/certificate.

- [ ] **Step 5: Zaimplementować true-DOF policy FEM**

P1/P2 mapują punkty magnetycznych true DOF; airbox jest wykluczony. Shared true DOF stosuje jawnie udokumentowaną any-incident magnetic policy zgodną z ADR.

- [ ] **Step 6: Potwierdzić GREEN**

Run: `cargo test -p fullmag-plan frozen_spins && cargo test -p fullmag-ir resolved_frozen_spins`.

Expected: exact fixtures PASS, all-frozen rozpoznane bez NaN.

- [ ] **Step 7: Checkpoint review**

Run: `git diff --check -- crates/fullmag-plan crates/fullmag-ir/src/plan.rs`.

Expected: exit 0.

### Task 7: Resource-first API v2 dla definitions, preview i resolved mask

**Files:**
- Create: `crates/fullmag-api/src/schemas/frozen_spins.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/model/frozen_spins.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/data/frozen_spins.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/session.rs`
- Modify: `crates/fullmag-authoring/src/scene.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/src/validation.rs`
- Modify: `crates/fullmag-authoring/src/region_revisions.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Produces: model CRUD resource, revision-safe preview, resolved metadata resource i binary compressed mask resource; OpenAPI schemas generowane do centralnego klienta.

- [ ] **Step 1: Napisać failing route/OpenAPI tests**

Testować create/read/update/delete, stale `expected_revision`, AST depth/node limits, missing target, bounded preview response, data-plane mask content type i brak maski w thin status.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-api frozen_spins -- --nocapture`.

Expected: FAIL z brakiem tras/schemas.

- [ ] **Step 3: Zdefiniować schemas**

```rust
pub struct FrozenSpinsPreviewResponse {
    pub revision: u64,
    pub current: bool,
    pub frozen_dof_count: u64,
    pub free_dof_count: u64,
    pub fraction: f64,
    pub bounds_m: Option<[[f64; 3]; 2]>,
    pub mask_sha256: String,
    pub warnings: Vec<FrozenSpinsWarning>,
    pub mask_resource: String,
}
```

- [ ] **Step 4: Podłączyć ten sam compiler co planner**

Handler preview nie implementuje geometrii; wywołuje compiler z Task 6 i publikuje jego certificate/hash.

- [ ] **Step 5: Wygenerować i zweryfikować OpenAPI**

Run: repozytoryjna receptura generowania OpenAPI odnaleziona przez `rg -n "openapi.*generate|generate.*openapi" justfile apps/control-room/package.json`.

Expected: generated transport/types zawiera nowe schemas bez ręcznych endpoint strings w komponentach.

- [ ] **Step 6: Potwierdzić GREEN**

Run: `cargo test -p fullmag-api frozen_spins && cargo test -p fullmag-api openapi_v2_contract`.

Expected: PASS.

- [ ] **Step 7: Checkpoint review**

Run: `git diff --check -- crates/fullmag-api crates/fullmag-authoring apps/control-room/src/kernel/api`.

Expected: exit 0.

## Faza III — FDM CPU i CUDA

### Task 8: FDM CPU/reference — LLG, wszystkie integratory i telemetry free/all

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs`
- Create: `crates/fullmag-engine/src/fdm/shared/frozen_spins.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/mod.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference/tests.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Test: `crates/fullmag-runner/tests/physics_validation/fdm_relaxation.rs`

**Interfaces:**
- Consumes: `ResolvedFrozenSpinsPlanIR`.
- Produces: `FrozenSpinsState`, `mask_final_rhs`, `restore_reference`, `max_norm_free`, free/all step stats i all-frozen completion.

- [ ] **Step 1: Napisać failing two-cell and MuMax semantics tests**

Test 1: jedna komórka frozen pozostaje bitowo identyczna, druga porusza się przez exchange. Test 2: frozen nadal wpływa na demag/exchange. Test 3: STT/SOT/thermal nie poruszają frozen. Test 4: all-frozen wykonuje zero kroków.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-runner frozen_spins_fdm_cpu -- --nocapture`.

Expected: FAIL, ponieważ plan nie jest egzekwowany.

- [ ] **Step 3: Dodać wspólny runtime state**

```rust
pub struct FrozenSpinsState {
    frozen_mask: Vec<bool>,
    reference: Vec<[f64; 3]>,
    frozen_dof_count: usize,
    free_dof_count: usize,
}

pub fn mask_final_rhs(&self, rhs: &mut [[f64; 3]]);
pub fn restore_reference(&self, candidate: &mut [[f64; 3]]);
pub fn max_norm_free(&self, values: &[[f64; 3]]) -> f64;
```

- [ ] **Step 4: Zastosować constraint we wszystkich CPU integrator stages**

Po pełnym RHS wywołać maskowanie; po każdym Euler/Heun/RK23/RK4/DP45/ABM candidate oraz normalizacji wywołać restore. Zmiana maski resetuje historię ABM.

- [ ] **Step 5: Dodać free/all telemetry i all-frozen stop**

Legacy aliases wskazują wartości `free`; nowe pola zachowują diagnostykę `all` oraz `frozen_reference_max_drift`.

- [ ] **Step 6: Potwierdzić GREEN i no-mask regression**

Run: `cargo test -p fullmag-runner frozen_spins_fdm_cpu && cargo test -p fullmag-runner physics_validation::fdm_relaxation && cargo test -p fullmag-engine fdm`.

Expected: PASS; istniejące no-mask fixtures bez zmian numerycznych.

- [ ] **Step 7: Checkpoint review**

Run: `git diff --check -- crates/fullmag-engine crates/fullmag-runner`.

Expected: exit 0.

### Task 9: FDM CPU direct minimizers i multilayer

**Files:**
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs`
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/solvers/fdm/workflows/relaxation/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/multilayer_reference/construction.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/multilayer_reference/math.rs`
- Test: `crates/fullmag-runner/tests/physics_validation/fdm_relaxation.rs`

**Interfaces:**
- Consumes: `FrozenSpinsState` z Task 8.
- Produces: masked tangent gradient/direction, free-domain dot products BB/NCG, restored trial states i flattened/per-layer multilayer mapping.

- [ ] **Step 1: Napisać failing PG-BB/NCG tests**

Testować literalne wykluczenie frozen entries z `g·g`, `s·s`, `s·y`, `p·g`, Armijo i stop norm; przypadki 0 oraz 1 free DOF; line-search trial zawsze odtwarza referencję.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-runner frozen_spins_direct_minimizer -- --nocapture`.

Expected: FAIL.

- [ ] **Step 3: Wprowadzić free-domain algebra i trial restore**

Wspólne helpery przyjmują `&FrozenSpinsState`; gradient i kierunek na frozen są zerowane, ale energia trial obejmuje pełny stan.

- [ ] **Step 4: Dodać multilayer offsets**

Plan mapuje per-layer masks do flattened solver layout z testami nierównych wymiarów, offsetów i coupling frozen↔free.

- [ ] **Step 5: Potwierdzić GREEN**

Run: `cargo test -p fullmag-runner frozen_spins_direct_minimizer && cargo test -p fullmag-runner frozen_spins_multilayer`.

Expected: PASS bez NaN i bez zerowania frozen reference.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- crates/fullmag-runner`.

Expected: exit 0.

### Task 10: FDM CUDA ABI, LLG, integratory, minimizatory i multilayer

**Files:**
- Modify: `native/include/fullmag_fdm.h`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`
- Modify: `backends/fdm/api/c_api.cpp`
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/gpu/cuda/runtime/context.cu`
- Modify: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
- Create: `backends/fdm/gpu/cuda/runtime/frozen_spins.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_rk4_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_rk4_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_abm3_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/multilayer_heun.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/multilayer_explicit_rk.cu`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- Create: `backends/fdm/tests/frozen_spins_abi_contract.cpp`
- Create: `backends/fdm/tests/frozen_spins_cuda_runtime.cu`

**Interfaces:**
- Consumes: dense mask/reference and hashes from planner.
- Produces: append-only C ABI fields, device-resident mask/reference, final-RHS kernel, restore kernel, masked reductions i null fast path.

- [ ] **Step 1: Napisać failing ABI layout and symbol tests**

Test utrwala `sizeof`, `offsetof`, version/capability bit i null semantics nowych pól. Stary caller z null mask musi pozostać legalny.

- [ ] **Step 2: Napisać failing CUDA invariant matrix**

Macierz obejmuje FP64/FP32 × Heun/RK23/RK4/DP45/ABM3 × STT/SOT/thermal × 0%, częściowe i 100% frozen oraz multilayer.

- [ ] **Step 3: Dodać append-only ABI i device ownership**

```c
const uint8_t *frozen_mask;
uint64_t frozen_mask_len;
const double *frozen_reference_xyz;
uint64_t frozen_reference_len;
```

FP32 context konwertuje referencję raz przy uploadzie. Null mask uruchamia istniejący fast path bez dodatkowych hot-loop synchronizacji.

- [ ] **Step 4: Zastosować final-RHS masking i candidate restore**

Każdy kernel/integrator z macierzy ma jawny punkt maskowania i restore; adaptacyjne redukcje ignorują frozen. ABM history jest resetowana po aktualizacji maski.

- [ ] **Step 5: Dodać direct minimizer i multilayer**

PG-BB/NCG reductions liczą free DOF; multilayer respektuje offsets i zachowuje coupling frozen↔free.

- [ ] **Step 6: Uruchomić managed FDM CUDA gates**

Run: istniejące container-backed GPU recipes wskazane przez `rg -n "fdm.*gpu|cuda.*fdm" justfile`, rozszerzone o dedykowany `verify-frozen-spins-fdm-cuda`.

Expected: ABI PASS, exact backend-precision invariant PASS, CPU/CUDA parity w opublikowanych tolerancjach, brak hidden CPU fallback.

- [ ] **Step 7: Zmierzyć null-mask overhead**

Run: dedykowany benchmark 0% frozen względem bazowego commita.

Expected: wynik zapisany w qualification matrix; brak niezaakceptowanego regresu i brak nowego host sync w hot loop.

- [ ] **Step 8: Checkpoint review**

Run: `git diff --check -- native/include/fullmag_fdm.h crates/fullmag-fdm-sys backends/fdm crates/fullmag-runner/src/fdm/gpu`.

Expected: exit 0.

## Faza IV — FEM CPU/GPU

### Task 11: FEM true-DOF materialization i native descriptor

**Files:**
- Modify: `crates/fullmag-plan/src/selection/fem.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-runner/src/fem_reference.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `backends/fem/src/api.cpp`

**Interfaces:**
- Produces: magnetic true-DOF mask/reference descriptor, P1/P2 coordinates, local→true mapping, serial/parallel certificate i append-only native ABI.

- [ ] **Step 1: Przeczytać `fem-native-backend-architecture` i `backend-golden-masterplan`**

Zastosować ich granice odpowiedzialności; nie dodawać cross-cutting physics do `mfem_bridge.cpp` ani nie rozszerzać `Context` poza uzgodniony subsystem contract.

- [ ] **Step 2: Napisać failing manufactured-mesh tests**

P1/P2, współdzielone true DOF, serial/parallel mapping, object/world affine, CSG oraz magnetic domain z airboxem. Literalnie oczekiwane true-DOF IDs i hash.

- [ ] **Step 3: Potwierdzić RED**

Run: `cargo test -p fullmag-plan frozen_spins_fem_true_dof -- --nocapture`.

Expected: FAIL.

- [ ] **Step 4: Zaimplementować mapping i descriptor**

Descriptor przenosi maskę true DOF, referencję, counts, hashes i all-frozen flag. Preview aktywacyjny korzysta z tego samego wyniku, nie node-only approximation.

- [ ] **Step 5: Potwierdzić planner GREEN**

Run: `cargo test -p fullmag-plan frozen_spins_fem_true_dof && cargo test -p fullmag-api frozen_spins_fem_preview`.

Expected: PASS; airbox wykluczony.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- crates/fullmag-plan crates/fullmag-runner/src/fem_reference.rs native/include/fullmag_fem.h crates/fullmag-fem-sys backends/fem/src/api.cpp`.

Expected: exit 0.

### Task 12: FEM CPU/MFEM frozen constraint

**Files:**
- Create: `backends/fem/cpu/mfem/constraints/frozen_spins.hpp`
- Create: `backends/fem/cpu/mfem/constraints/frozen_spins.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/cpu/mfem/runtime/mfem_context.hpp`
- Modify: `backends/fem/cpu/mfem/runtime/backend_step.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/snapshot.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/stage_completion.cpp`
- Modify: `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- Modify: `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`
- Modify: `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs`
- Modify: `crates/fullmag-runner/src/fem/relax/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/fem/relax/finalize.rs`
- Modify: `crates/fullmag-runner/src/fem/relax/stop.rs`

**Interfaces:**
- Consumes: native descriptor z Task 11.
- Produces: CPU mask/restore/free reductions, TPI essential true DOF enforcement, free/all stats i checkpoint payload.

- [ ] **Step 1: Napisać failing native semantic tests**

Testować LLG overdamped, PG-BB, NCG, TPI, P1/P2, Poisson-airbox source retention, all-frozen no solve i exact reference invariant.

- [ ] **Step 2: Zaimplementować focused constraints subsystem**

`frozen_spins.{hpp,cpp}` posiada mask/restore/reductions i nie definiuje publicznej fizyki. Context posiada wyłącznie owned runtime state wymagany przez descriptor.

- [ ] **Step 3: Zastosować maskowanie i restore we wszystkich CPU paths**

Finalny RHS po STT/SOT; candidates/retractions; BB/NCG mass-metric reductions; TPI essential true DOF elimination przed solve.

- [ ] **Step 4: Zachować pola i demag source**

Frozen values pozostają w `m_xyz` używanym przez exchange/demag; Poisson-airbox source i pełna energia nie są maskowane.

- [ ] **Step 5: Uruchomić managed FEM CPU gate**

Run: dodać i wykonać `just verify-frozen-spins-fem-cpu`, zbudowane na istniejącym `ensure-managed-fem-runtime`.

Expected: wszystkie native semantic tests PASS; profiler contract zachowany; all-frozen `executed_steps=0`.

- [ ] **Step 6: Checkpoint review**

Run: `git diff --check -- backends/fem crates/fullmag-runner/src/fem`.

Expected: exit 0.

### Task 13: FEM GPU device-resident frozen constraint

**Files:**
- Create: `backends/fem/gpu/cuda/constraints/frozen_spins.cu`
- Create: `backends/fem/gpu/cuda/constraints/frozen_spins.hpp`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/backend_step.cpp`
- Modify: `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs`
- Modify: `crates/fullmag-runner/src/fem/relax/direct_minimizer.rs`

**Interfaces:**
- Consumes: backend-neutral descriptor i CPU oracle.
- Produces: device-resident mask/reference, GPU mask/restore/reductions, capability-gated TPI paths, parity telemetry i qualification metadata.

- [ ] **Step 1: Napisać failing GPU parity and residency tests**

Macierz: partial/all frozen × supported LLG/direct/TPI lanes × P1/P2 × demag-airbox. Test wykrywa host fallback i host sync w hot loop.

- [ ] **Step 2: Dodać device ownership**

Mask/reference są uploadowane przy activation epoch i zwalniane przez relaxation memory owner. Brak per-step H2D/D2H poza jawnie ograniczoną telemetrią.

- [ ] **Step 3: Zastosować GPU mask/restore/reductions**

Każdy capability-advertised GPU algorithm egzekwuje constraint; pozostałe fail closed zamiast przechodzić na CPU.

- [ ] **Step 4: Uruchomić managed FEM GPU gate**

Run: dodać i wykonać `just verify-frozen-spins-fem-gpu` przez zarządzany runtime.

Expected: CPU/GPU parity PASS, exact backend-precision invariant PASS, brak hidden fallback i brak nowego hot-loop host sync.

- [ ] **Step 5: Checkpoint review**

Run: `git diff --check -- backends/fem/gpu backends/fem/src/api.cpp crates/fullmag-runner/src/interactive_runtime/fem crates/fullmag-runner/src/fem`.

Expected: exit 0.

## Faza V — Snapshot, persistence, telemetry i Control Room

### Task 14: Atomowy state snapshot, checkpoint/restart i provenance

**Files:**
- Create: `crates/fullmag-runner/src/constraints/mod.rs`
- Create: `crates/fullmag-runner/src/constraints/activation.rs`
- Create: `crates/fullmag-runner/src/constraints/checkpoint.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-session/src/types.rs`
- Modify: `crates/fullmag-api/src/session_persistence.rs`
- Modify: `crates/fullmag-cli/src/live_workspace.rs`
- Modify: `crates/fullmag-cli/src/step_utils.rs`
- Modify: `crates/fullmag-quantities/src/step_data.rs`
- Modify: `crates/fullmag-api/src/schemas/status.rs`
- Modify: `crates/fullmag-runner/src/scalar_metrics.rs`

**Interfaces:**
- Produces: atomic activation transaction, state predicates `m.x/y/z`, norm, dot, persisted mask/reference, activation epoch, topology hard check, free/all telemetry i runtime provenance.

- [ ] **Step 1: Napisać failing activation race tests**

Preview revision, source state revision i capture muszą należeć do jednej transakcji. Interaktywna komenda w trakcie aktywacji nie może zmienić maski bez nowego epoch.

- [ ] **Step 2: Napisać failing checkpoint parity tests**

Save/resume zachowuje literalną maskę i referencję; zmieniony grid/mesh fingerprint zwraca hard error; state selector nie jest ponownie oceniany przy restarcie.

- [ ] **Step 3: Zaimplementować activation transaction**

```rust
pub struct FrozenSpinsActivation {
    pub activation_epoch: u64,
    pub source_state_revision: u64,
    pub mask_sha256: String,
    pub reference_sha256: String,
    pub topology_fingerprint: String,
}
```

Predykaty NaN zwracają false i typed diagnostic; invalid magnetization może eskalować do solver error zgodnie z notą fizyczną.

- [ ] **Step 4: Zaimplementować checkpoint codec i provenance**

Maska jest bitset/compressed binary z hashem, referencja zachowuje backend precision, restart waliduje schema i topology przed użyciem.

- [ ] **Step 5: Rozszerzyć telemetry**

Publikować `max_rhs_free`, `max_rhs_all`, `max_torque_free_Apm`, `max_torque_all_Apm`, counts, drift i stop reason; legacy aliases mapują na `free`.

- [ ] **Step 6: Potwierdzić GREEN**

Run: `cargo test -p fullmag-runner frozen_spins_activation && cargo test -p fullmag-session frozen_spins_checkpoint && cargo test -p fullmag-api frozen_spins_persistence`.

Expected: PASS.

- [ ] **Step 7: Checkpoint review**

Run: `git diff --check -- crates/fullmag-runner crates/fullmag-session crates/fullmag-api crates/fullmag-cli crates/fullmag-quantities`.

Expected: exit 0.

### Task 15: Control Room — ribbon, Explorer, dedykowany Inspector i overlay

**Files:**
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Create: `apps/control-room/src/kernel/resources/frozenSpinsResources.ts`
- Create: `apps/control-room/src/kernel/resources/frozenSpinsResources.test.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Create: `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/selection/SelectionExpressionBuilder.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/selection/SelectionExpressionBuilder.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/layers/FrozenSpinsOverlay.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/layers/FrozenSpinsOverlay.test.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Create: `apps/control-room/e2e/frozen-spins.spec.ts`

**Interfaces:**
- Consumes: generated OpenAPI/resource facade z Task 7, revisions i binary mask.
- Produces: capability-gated `Frozen Spins` command, contextual Explorer nodes, dedicated route/Inspector, typed selector builder i FDM/FEM overlay.

- [ ] **Step 1: Przeczytać wymagane frontend skills**

Przeczytać w całości `resource-first-api-check`, `frontend-v2-module-architecture`, `frontend-v2-api-hygiene`, `frontend-v2-state-hygiene`, `frontend-v2-viewport-lifecycle`, `frontend-v2-performance-gates`, `react-doctor` i `verification-before-completion` przed edycją.

- [ ] **Step 2: Napisać failing ribbon test**

Polecenie jest dostępne tylko dla zaznaczonego ferromagnetyka/regionu i wspieranego capability. Wywołanie tworzy `InObject` albo `InRegion` przez command registry, nie lokalny component mutation.

- [ ] **Step 3: Napisać failing Explorer tests**

Oczekiwane drzewa:

```text
Ferromagnet/Regions/pinned_edge/Frozen Spins
Ferromagnet/Frozen Spins
```

Node posiada stabilny `constraint_id`, nie duplikuje zasobu i znika dopiero po revision-confirmed delete.

- [ ] **Step 4: Napisać failing Inspector stability tests**

Sprawdzić dedykowaną trasę, field-scoped pending, zero unrelated disabled/opacity changes, brak aktywnych opacity animations, stabilną root identity, zachowany focus/scroll/draft oraz bounded render/request counts podczas pending i ACK.

- [ ] **Step 5: Zaimplementować resource facade i command**

Komponenty korzystają wyłącznie z `frozenSpins` resource hooks/facade. Ribbon dispatchuje centralną komendę; brak ręcznych endpoint strings.

- [ ] **Step 6: Zaimplementować Explorer i dedykowany Inspector**

Inspector edytuje name/enabled/target/stages/reference/membership/policies i typed expression builder. Preview wyświetla counts, fraction, bounds, hash, current/stale oraz warnings.

- [ ] **Step 7: Napisać failing overlay test i zaimplementować warstwę**

Overlay dekoduje binary mask resource, nie zmienia material layer, działa dla FDM cells i FEM true-DOF carrier, ma osobne on/off i legendę. Brak render loop podczas idle i poprawne dispose resources.

- [ ] **Step 8: Uruchomić focused frontend gates**

Run: `pnpm --dir apps/control-room test -- ribbonStructure buildModelTree FrozenSpinsInspectorPanel FrozenSpinsOverlay`.

Expected: PASS.

Run: `pnpm --dir apps/control-room typecheck`.

Expected: PASS.

- [ ] **Step 9: Uruchomić React Doctor**

Postępować dokładnie według `.agents/skills/react-doctor/SKILL.md`; naprawiać wyłącznie diagnostykę wprowadzoną przez frozen-spins diff.

- [ ] **Step 10: Uruchomić rzeczywisty browser E2E**

Run: repozytoryjny launcher Control Room i `apps/control-room/e2e/frozen-spins.spec.ts` w prawdziwej przeglądarce.

Expected: command tworzy constraint; podgałąź i Inspector są widoczne; preview hash odpowiada activation artifact; save/reload zachowuje dane; canvas widoczny; WebGL context zdrowy; drawing buffer niezerowy; overlay zawiera niezerowe próbki.

- [ ] **Step 11: Checkpoint review**

Run: `git diff --check -- apps/control-room`.

Expected: exit 0; `apps/control-room/next-env.d.ts` pozostaje zmianą użytkownika i nie wchodzi do diffu zadania.

## Faza VI — Kwalifikacja i gradacja produkcyjna

### Task 16: Scientific qualification, managed recipes, public docs i completion audit

**Files:**
- Create: `scripts/verify_frozen_spins_ir.py`
- Create: `scripts/verify_frozen_spins_python.py`
- Create: `scripts/verify_frozen_spins_qualification.py`
- Modify: `justfile`
- Modify: `docs/validation/frozen-spins-qualification-matrix.md`
- Modify: `docs/physics/0996-frozen-spins-constraint.md`
- Create: `public_docs/frozen_spins.md`
- Create: `examples/frozen_spins/pinned_region_relaxation.py`
- Create: `examples/frozen_spins/pinned_region_dynamics.py`
- Modify: `.github/workflows/contract-guard.yml`

**Interfaces:**
- Consumes: wszystkie wcześniejsze warstwy.
- Produces: jednoznaczne `just verify-frozen-spins-*` gates, scientific artifacts, public examples, capability graduation i requirement-by-requirement completion evidence.

- [ ] **Step 1: Dodać dedykowane receptury**

```text
just verify-frozen-spins-ir
just verify-frozen-spins-python
just verify-frozen-spins-fdm-cpu
just verify-frozen-spins-fdm-cuda
just verify-frozen-spins-fdm-multilayer
just verify-frozen-spins-fem-cpu
just verify-frozen-spins-fem-gpu
just verify-frozen-spins-api
just verify-frozen-spins-ui
just verify-frozen-spins-qualification
```

FEM recipes składają istniejący managed runtime zamiast uruchamiać host build.

- [ ] **Step 2: Zaimplementować scientific scenarios**

Macierz zawiera: semantykę MuMax3 relax/run, two-spin exchange, pinned domain wall, pinned vortex/core, STT, SOT, thermal deterministic RNG, all-frozen, checkpoint parity oraz no-mask regressions.

- [ ] **Step 3: Zdefiniować parity tolerances i artifacts**

Każdy lane zapisuje requested/resolved backend, precision, constraint IDs, counts, mask/reference hashes, max drift, stop reason i porównanie z CPU oracle. Tolerancje pochodzą z noty fizycznej, nie są dobierane po wyniku.

- [ ] **Step 4: Dodać publiczne przykłady MuMax-like API**

Oba przykłady używają:

```python
pinning = magnet.add_region(region_id="pinned_edge", shape=...)
pinning.freeze_spins(stage_ids=["relax"])
```

oraz pokazują jawny odpowiednik `fm.FrozenSpins` i eksport kanonicznego IR.

- [ ] **Step 5: Uruchomić pełną kwalifikację**

Run: `just verify-frozen-spins-qualification`.

Expected: wszystkie lane deklarowane jako produkcyjne PASS; lane niewspierane pozostają jawnie `UNSUPPORTED`, nigdy cicho pominięte.

- [ ] **Step 6: Uruchomić regresje przekrojowe**

Run: pełne odpowiednie testy workspace Rust, Python, Control Room, managed FEM CPU/GPU i browser zgodnie z repozytoryjnymi recipes.

Expected: PASS albo pre-existing failures udokumentowane z dowodem, że nie są powodowane przez diff; żadna nowa regresja.

- [ ] **Step 7: Wykonać completion audit**

Dla każdego checkboxa z `docs/validation/frozen-spins-qualification-matrix.md` wskazać autorytatywny test/artifact. Źródło, narrow unit test lub obecność capability nie wystarcza jako dowód runtime/production/browser.

- [ ] **Step 8: Final diff hygiene**

Run: `git diff --check`.

Run osobno: `git diff --cached --name-only`.

Expected: brak staged files bez osobnej zgody użytkownika; unrelated dirty files nietknięte.

## Execution checkpoints

Po każdej fazie:

1. uruchomić wszystkie gates fazy;
2. zaktualizować macierz kwalifikacji dowodami, nie deklaracjami;
3. przeprowadzić code review zgodnie z `google-eng-review-practices` i `requesting-code-review`;
4. pokazać użytkownikowi wynik oraz jawne lane `PASS`, `PARTIAL`, `UNSUPPORTED`, `BLOCKED`;
5. nie oznaczać pełnego celu jako ukończony przed Gate F i rzeczywistym browser smoke.
