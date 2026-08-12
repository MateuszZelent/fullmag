# User-Owned Relaxation Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć ukrytą bramkę względnego momentu `1e-6` z FEM K0 eigensolve i zastąpić ją certyfikatem równowagi wynikającym dokładnie z kryterium relaksacji wybranego przez użytkownika, z pełnym round-tripem artefaktów, API/UI i dowodem CPU/GPU dla periodycznej warstwy z dziurą.

**Architecture:** `StageCompletionIR` pozostaje kanonicznym wynikiem relaksacji, a runner zamraża go w `AcceptedFemRelaxStageHandoff.v2`. Handoff albo certyfikowany import produkuje `equilibrium_artifact.v7`; natywny backend sprawdza integralność reprezentacji i zgodność digestów, lecz względny moment tylko mierzy. CPU i GPU konsumują ten sam backend-neutralny certyfikat, a Results pokazuje kryterium akceptacji oddzielnie od diagnostyki momentu.

**Tech Stack:** Rust (`fullmag-ir`, `fullmag-runner`, `fullmag-api`), C++17/MFEM ABI, Python validators, React/TypeScript Control Room, container-backed `just` managed FEM runtime.

## Global Constraints

- Kryterium `torque` albo `energy` może samodzielnie certyfikować zakończoną relaksację, jeżeli `status="completed"`, `converged=true`, metryka jest zgodna z powodem i `metric_value <= threshold`.
- `max_steps`, limit czasu, anulowanie, stagnacja bez spełnionego kryterium oraz błąd backendu nie tworzą certyfikatu.
- `max_torque_relative` jest zawsze diagnostyką bez progu akceptacji; nie może zmienić statusu relaksacji, handoffu, eigensolve ani kwalifikacji.
- Produkcyjne `equilibrium_source="artifact"` i `"provided"` wymagają certyfikatu; surowy wektor jest dozwolony tylko w jawnie oznaczonym adapterze testowym bez production implication.
- Nie wolno przebudować meshu między `relax` i `eigenmodes`; generation, topology, indexing, part registry, materiały, fizyka, BC, demag i magnetyzacja muszą zachować tożsamość.
- `equilibrium_artifact.v6` nie podlega automatycznej promocji; brak dowodu źródłowego kończy się fail-closed z komunikatem wymagającym ponownej relaksacji lub migracji.
- Natywne FEM/MFEM/CUDA buildy i dowody runtime używają wyłącznie kontenerowych receptur repozytorium `justfile` jako ścieżki autorytatywnej.
- Nie zmieniać publicznych `tolA`, `tolT`, `energy_tolerance` ani ich istniejącego loweringu do `ProblemIR`.

---

### Task 0: Kanoniczna publikacja semantyki torque OR energy

**Files:**
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json`
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Test: `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`

**Interfaces:**
- Consumes: zatwierdzoną decyzję, że jawne kryterium torque albo energy może samodzielnie zakończyć relaksację.
- Produces: jeden nadrzędny kontrakt dla FDM/FEM i wszystkich dalszych tasków.

- [ ] **Step 1: Zaktualizować równanie i tabelę stop policy**

Nota 0580 definiuje alternatywę logiczną kryteriów włączonych przez użytkownika,
deterministyczny priorytet raportowania `torque` przed `energy`, gdy oba spełniają
się w tej samej próbce, oraz zakaz certyfikowania przez `max_steps`, timeout,
anulowanie, stagnację lub błąd. Usunąć twierdzenia, że energy jest wyłącznie
dodatkowym warunkiem torque.

- [ ] **Step 2: Ujednolicić mapę źródeł i notę K0**

Source-map 0580 wiąże równanie z Rust `relaxation_stop_criteria_satisfied`,
natywnym `update_stage_completion_from_stats` i mapperem FFI
`stage_completion_from_ffi`. Nota 0830 odsyła do tego samego kontraktu bez
lokalnego redefiniowania relaksacji.

- [ ] **Step 3: Uruchomić walidację dokumentacji**

Run:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json --repo-root .
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

Expected: oba source-map validators PASS i 21 testów kontraktu PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/physics/0580-canonical-relaxation-equilibrium-contract.md docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json docs/physics/0830-fem-poisson-airbox-modal-eigen.md
git commit -m "docs(physics): define independent relaxation criteria"
```

---

### Task 1: Kanoniczny certyfikat ukończenia i handoff v2

**Files:**
- Modify: `crates/fullmag-runner/src/relaxation/convergence.rs`
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `backends/fem/cpu/mfem/runtime/stage_completion.cpp`
- Test: `crates/fullmag-runner/src/relaxation/convergence.rs` (moduł `tests`)
- Test: `crates/fullmag-runner/src/fem_eigen.rs` (moduł `tests`)
- Test: `backends/fem/tests/stage_completion_contract.cpp`

**Interfaces:**
- Consumes: `fullmag_ir::StageCompletionIR`, `StageStopReason::{Torque,Energy}`, `StageMetricKind::{MaxTorqueApm,TotalEnergyPlateauRangeJ}`.
- Produces: prywatny `AcceptedEquilibriumCriterion`, `AcceptedFemRelaxStageHandoff.v2`, `acceptance_json()` oraz digest obejmujący pełny snapshot completion.

- [ ] **Step 1: Dodać testy RED dla obu poprawnych kryteriów i odrzuconych terminacji**

Dodać osobne testy `relaxation_stop_criteria_satisfied` potwierdzające OR:
torque-pass przy niespełnionej energii oraz energy-pass przy momencie powyżej
progu. Następnie utworzyć completion torque i energy i wymagać:

```rust
assert_eq!(handoff.acceptance_json()["criterion"], "energy");
assert_eq!(handoff.acceptance_json()["metric_kind"], "total_energy_plateau_range_j");
assert_eq!(handoff.acceptance_json()["unit"], "J");
assert_eq!(handoff.provenance_json()["schema_version"], "AcceptedFemRelaxStageHandoff.v2");
```

oraz odrzucenia `MaxSteps`, anulowania i niespójnej pary reason/metric.

- [ ] **Step 2: Uruchomić testy i potwierdzić RED**

Run:

```bash
cargo test -p fullmag-runner --quiet relaxation
cargo test -p fullmag-runner --quiet fem_eigen
```

Expected: pierwszy test FAIL na obecnym `torque_ok && energy_ok`; drugi FAIL,
ponieważ v1 nie przechowuje kryterium ani snapshotu completion.

- [ ] **Step 3: Wprowadzić minimalny model certyfikatu**

W `fem_eigen.rs` dodać:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
struct AcceptedEquilibriumCriterion {
    criterion: String,
    metric_kind: fullmag_ir::StageMetricKind,
    metric_value: f64,
    threshold: f64,
    unit: String,
    status: String,
    converged: bool,
    stop_reason: fullmag_ir::StageStopReason,
}
```

`relaxation_stop_criteria_satisfied` wybiera pierwsze spełnione jawne kryterium
według kanonicznej kolejności raportowania i zwraca jego rodzaj do
`StageCompletionIR`; nie może zgłaszać torque, jeżeli spełniona była tylko
energia. `from_completed_relax` konstruuje certyfikat wyłącznie z zaakceptowanego
`StageCompletionIR`; handoff zachowuje również sklonowany completion i włącza
oba do length-prefixed SHA-256 v2. Nie dodawać nowej tolerancji.

Natywne `update_stage_completion_from_stats` stosuje identyczne OR i emituje
`FULLMAG_FEM_STAGE_STOP_REASON_ENERGY` z metryką
`total_energy_plateau_range_J`, jeżeli torque nie jest potwierdzone, a energy
plateau spełnia próg.

- [ ] **Step 4: Uruchomić testy GREEN**

Run:

```bash
cargo test -p fullmag-runner --quiet relaxation
cargo test -p fullmag-runner --quiet fem_eigen
just verify-fem-time-domain-native-contract
```

Expected: PASS, w tym torque, energy oraz terminacje odrzucone.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-runner/src/relaxation/convergence.rs crates/fullmag-runner/src/fem_eigen.rs backends/fem/cpu/mfem/runtime/stage_completion.cpp backends/fem/tests/stage_completion_contract.cpp
git commit -m "fix(runner): preserve authored equilibrium criterion"
```

---

### Task 2: Certyfikowany equilibrium_artifact.v7 i migracja fail-closed

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

**Interfaces:**
- Consumes: `AcceptedEquilibriumCriterion`, completion/content/mesh/material/physics/boundary digests.
- Produces: `equilibrium_artifact.v7`, `load_equilibrium_artifact_v7`, jednoznaczny błąd dla v6 i surowego wektora.

- [ ] **Step 1: Dodać testy RED formatu v7**

Fixture v7 musi zawierać:

```json
{
  "schema_version": "equilibrium_artifact.v7",
  "accepted_for_linearization": true,
  "acceptance_certificate": {
    "criterion": "energy",
    "metric_kind": "total_energy_plateau_range_j",
    "metric_value": 8e-13,
    "threshold": 1e-12,
    "unit": "J",
    "status": "completed",
    "converged": true,
    "stop_reason": "energy",
    "completion_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "observables": {
    "max_torque_Apm": 0.4,
    "max_torque_T": 5.026548245743669e-7,
    "max_torque_relative": 3.2e-5
  },
  "representation_integrity": {"m0_norm_tolerance": 1e-10}
}
```

Testy wymagają odrzucenia: v6, brakującego certyfikatu, niespójnego unit/metric, niespełnionego progu, niedopasowanego digestu oraz raw-vector payload.

- [ ] **Step 2: Potwierdzić RED validatora i runnera**

Run:

```bash
python3 -m unittest scripts.test_verify_fem_frequency_domain_eigen_artifacts
cargo test -p fullmag-runner --quiet fem_eigen
```

Expected: FAIL z powodu oczekiwania v6 i braku `acceptance_certificate`.

- [ ] **Step 3: Zaimplementować writer/loader v7**

Zastąpić wszystkie ścieżki `equilibrium_artifact.v6.json` przez v7. Loader waliduje certyfikat i wszystkie istniejące signature/digest checks przed odczytem `m0`; nie wykonuje relaksacji i nie wyprowadza kryterium z diagnostyki momentu. Komunikat v6:

```text
equilibrium_artifact_v6_uncertified: rerun relaxation or migrate with source completion evidence
```

- [ ] **Step 4: Uruchomić GREEN i sprawdzić brak aktywnych nazw v6**

Run:

```bash
python3 -m unittest scripts.test_verify_fem_frequency_domain_eigen_artifacts
cargo test -p fullmag-runner --quiet fem_eigen
rg -n "equilibrium_artifact\.v6|equilibrium_artifact_v6" crates/fullmag-runner scripts/verify_fem_frequency_domain_eigen_artifacts.py
```

Expected: testy PASS; `rg` znajduje wyłącznie jawny kod błędu/migracji v6 i test negatywny.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-runner/src/fem_eigen.rs scripts/verify_fem_frequency_domain_eigen_artifacts.py scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
git commit -m "feat(eigen): require certified equilibrium artifact v7"
```

---

### Task 3: Natywna linearyzacja bez fizycznej bramki względnego momentu

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `backends/fem/include/frequency_domain/linearization_state.hpp`
- Modify: `backends/fem/src/frequency_domain/linearization_state.cpp`
- Modify: `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`
- Test: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp`
- Test: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`

**Interfaces:**
- Consumes: v7 accepted flag, acceptance certificate digest oraz pola `m0/H_eff0`.
- Produces: ABI v19, native representation-integrity result i diagnostyczny `max_m0_cross_heff0_relative` bez porównania z progiem.

- [ ] **Step 1: Dodać RED test native energy-certified high-torque**

Fixture ustawia poprawny certyfikat energy, `accepted_for_linearization=true` i pole z `max_m0_cross_heff0_relative > 1e-6`. Test wymaga:

```cpp
check(status == FrequencyDomainStatus::ok,
      "relative torque diagnostic must not reject certified equilibrium");
check(diagnostics.max_m0_cross_heff0_relative > 1.0e-6,
      "fixture must exercise the removed hidden gate");
check(std::strlen(diagnostics.acceptance_certificate_sha256) > 0,
      "native diagnostics retain certificate identity");
```

- [ ] **Step 2: Uruchomić kontenerowy native gate i potwierdzić RED**

Run: `just verify-fem-frequency-domain-native-contract`

Expected: FAIL `equilibrium_torque_residual_too_large`.

- [ ] **Step 3: Podnieść ABI do v19 i usunąć tolerance field**

W `FullmagFemPoissonAirboxSharedDomainPayload` zastąpić `equilibrium_torque_relative_tolerance` polami:

```c
const char *acceptance_criterion;
const char *acceptance_metric_kind;
const char *acceptance_unit;
double acceptance_metric_value;
double acceptance_threshold;
const char *acceptance_certificate_sha256;
```

`LinearizationBuildOptions` zachowuje tylko tolerancje integralności reprezentacji. C++ nadal oblicza relative torque, sprawdza jego skończoność i publikuje go w diagnostics, ale usuwa porównanie oraz reject reason `equilibrium_torque_residual_too_large`.

- [ ] **Step 4: Dodać negatywne testy integralności certyfikatu**

Odrzucać brak digestu, nieskończoną wartość/prog, `metric_value > threshold`, niezgodną parę criterion/metric/unit oraz niezaakceptowany artifact. Zachować testy normy `m0`, pól finite, signature mismatch i static-demag presence bez luzowania.

- [ ] **Step 5: Uruchomić GREEN**

Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-exchange-runtime
```

Expected: oba PASS, layout ABI raportuje 19.

- [ ] **Step 6: Commit**

```bash
git add native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs crates/fullmag-runner/src/native_fem/frequency_domain.rs backends/fem/include/frequency_domain/linearization_state.hpp backends/fem/src/frequency_domain/linearization_state.cpp backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp backends/fem/tests/frequency_domain/frequency_domain_contract.cpp backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
git commit -m "fix(fem): make relative torque diagnostic only"
```

---

### Task 4: Spięcie runnera z ABI v19 i zakaz ukrytej relaksacji

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/fem/eigen_equilibrium.rs`
- Test: `crates/fullmag-runner/src/fem_eigen.rs`
- Test: `crates/fullmag-runner/src/fem/eigen_equilibrium.rs`

**Interfaces:**
- Consumes: handoff v2 lub artifact v7.
- Produces: jedną ścieżkę `SharedDomainLinearizationState` z certyfikatem, identyczną dla CPU/GPU; brak wewnętrznego `RELAX_*`.

- [ ] **Step 1: Dodać RED test braku samodzielnej relaksacji**

Test dla `RelaxedInitialState` bez handoffu wymaga błędu przed assembly:

```rust
assert!(error.message.contains("accepted relaxation handoff is required"));
```

Test dla `Provided` bez certyfikatu produkcyjnego wymaga `uncertified_provided_equilibrium`, natomiast jawny validation-only fixture pozostaje dostępny wyłącznie w `#[cfg(test)]`.

- [ ] **Step 2: Potwierdzić RED**

Run: `cargo test -p fullmag-runner --quiet fem_eigen`

Expected: FAIL, ponieważ `materialize_equilibrium` nadal wykonuje wewnętrzne 4000 kroków.

- [ ] **Step 3: Usunąć ukrytą relaksację i przepiąć certyfikat**

Usunąć `RELAX_DT`, `RELAX_MAX_STEPS`, `RelaxationControlIR` i pętlę pre-eigen z `eigen_equilibrium.rs`. `build_shared_domain_linearization_state` otrzymuje certyfikat zaakceptowanego źródła, zapisuje v7 i wypełnia ABI v19. Relative torque pozostaje w `observables`; komunikat z `> 1e-6` znika.

- [ ] **Step 4: Testy CPU/GPU semantic parity**

Ten sam fixture torque oraz energy należy przepuścić przez przygotowanie requestu CPU i GPU i porównać `acceptance_certificate_sha256`, criterion, metric, threshold i unit bit-for-bit.

- [ ] **Step 5: Uruchomić GREEN i wyszukać ukryte progi**

Run:

```bash
cargo test -p fullmag-runner --quiet fem_eigen
rg -n "equilibrium_torque_relative_tolerance|relative torque .*1e-6|RELAX_MAX_STEPS" crates/fullmag-runner backends/fem native/include/fullmag_fem.h
```

Expected: tests PASS; brak aktywnego pola/bramki/pętli, poza testem regresyjnym i opisem migracji.

- [ ] **Step 6: Commit**

```bash
git add crates/fullmag-runner/src/fem_eigen.rs crates/fullmag-runner/src/fem/eigen_equilibrium.rs
git commit -m "fix(runner): require certified eigen equilibrium"
```

---

### Task 5: Results API i Inspector kryterium równowagi

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Test: `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`

**Interfaces:**
- Consumes: v7 artifact/provenance resource.
- Produces: typed Results fields `acceptanceCriterion`, `metricKind`, `metricValue`, `threshold`, `unit`, torque observables i representation integrity.

- [ ] **Step 1: Dodać RED test serializacji API i renderu Inspectora**

Test UI wymaga osobnych grup:

```tsx
expect(screen.getByText("Acceptance criterion")).toBeInTheDocument();
expect(screen.getByText("Energy plateau")).toBeInTheDocument();
expect(screen.getByText("1.0e-12 J")).toBeInTheDocument();
expect(screen.getByText("Relative torque (diagnostic)")).toBeInTheDocument();
```

Nie wolno renderować etykiety `relative torque tolerance` ani statusu failure wyprowadzonego z diagnostyki.

- [ ] **Step 2: Potwierdzić RED**

Run:

```bash
pnpm --dir apps/control-room test -- FrequencyDomainInspectorPanel.test.tsx
```

Expected: FAIL, brak pól v7.

- [ ] **Step 3: Rozszerzyć typed resource i Inspector**

API czyta wyłącznie pola v7 i zachowuje jednostkę bez konwersji. Inspector pokazuje kryterium i wartość/prog jako decyzję użytkownika, a trzy torque observable w sekcji Diagnostic observables. Wartości brakujące renderuje jako unavailable, nie jako zero.

- [ ] **Step 4: Uruchomić GREEN, typecheck i React Doctor**

Run:

```bash
pnpm --dir apps/control-room test -- FrequencyDomainInspectorPanel.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec react-doctor
```

Expected: focused tests i typecheck PASS; React Doctor bez regresji score.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx
git commit -m "feat(results): expose equilibrium acceptance certificate"
```

---

### Task 6: Periodic antidot managed E2E i domknięcie dokumentacji

**Files:**
- Modify: `scripts/validate_fem_periodic_antidot_relax_eigenmodes_runtime.py`
- Modify: `scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py`
- Modify: `justfile`
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json`
- Modify: `docs/superpowers/specs/2026-08-12-user-owned-relaxation-acceptance-for-eigensolve-design.md`
- Test: `packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py`

**Interfaces:**
- Consumes: rzeczywisty `examples/fem_periodic_antidot_relax_eigenmodes.py`, v7, spectrum v2 i complex mode-field Zarr.
- Produces: autorytatywny managed dowód CPU relax → GPU K0 spectrum/modes bez remeshu oraz finalny status dokumentacji.

- [ ] **Step 1: Dodać RED walidatora v7/E2E**

Walidator wymaga:

```python
require(equilibrium["schema_version"] == "equilibrium_artifact.v7", "v7")
require(equilibrium["acceptance_certificate"]["criterion"] in {"torque", "energy"}, "criterion")
require(summary["equilibrium_source"]["handoff"] == "stage_continuation", "handoff")
require(relax_mesh_digest == eigen_mesh_digest, "no remesh")
require(len(spectrum["modes"]) >= 1, "nonempty spectrum")
require(mode_field_chunk.stat().st_size > 0, "nonempty complex mode field")
```

- [ ] **Step 2: Potwierdzić RED testów skryptowych**

Run:

```bash
python3 -m unittest scripts.test_validate_fem_periodic_antidot_relax_eigenmodes_runtime
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py -q
```

Expected: validator FAIL na fixture v6; test Python potwierdza niezmieniony publiczny authoring.

- [ ] **Step 3: Zaktualizować walidator, just gate i dokumentację**

`just verify-fem-periodic-antidot-relax-eigenmodes-runtime gpu` musi budować/uruchamiać managed runtime, a potem sprawdzać v7, completion criterion, digesty jednego meshu, spectrum i wszystkie żądane mode fields. Nota fizyczna i source-map dostają dokładne symbole v19/v7 oraz pozostają `unvalidated` do czasu świeżego przebiegu.

- [ ] **Step 4: Uruchomić managed CPU i GPU qualification**

Run sekwencyjnie:

```bash
just rebuild-fem-runtime
just verify-managed-fem-runtime-source-provenance
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-eigen-k0-kittel-runtime
just verify-fem-periodic-antidot-relax-eigenmodes-runtime cpu
just verify-fem-periodic-antidot-relax-eigenmodes-runtime gpu
```

Expected: wszystkie PASS; raport antidot zawiera ukończoną relaksację według autorskiego criterion, brak remeshu, niepuste spectrum oraz complex mode-field resources. GPU musi raportować rzeczywiście rozwiązany backend CUDA, bez fallbacku CPU.

Ten E2E domyka funkcjonalny kontrakt akceptacji równowagi. Nie podnosi samodzielnie
całego full-GPU eigensolve do statusu production-qualified: osobny plan full-GPU
wymaga jeszcze bramek T13/T14, w tym realnego matrix-free
`operator_dimension > 1024`, pomiaru transferów, synchronizacji i alokacji oraz
sanitizerów. Status dokumentacji musi zachować tę granicę.

- [ ] **Step 5: Walidacja naukowa i finalny audit**

Run:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
git diff --check
```

Po świeżych dowodach zmienić status noty tylko w zakresie faktycznie zaliczonych lane’ów; nie utożsamiać source/test GREEN z production qualification.

- [ ] **Step 6: Commit**

```bash
git add scripts/validate_fem_periodic_antidot_relax_eigenmodes_runtime.py scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py justfile docs/physics/0830-fem-poisson-airbox-modal-eigen.md docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json docs/superpowers/specs/2026-08-12-user-owned-relaxation-acceptance-for-eigensolve-design.md packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py
git commit -m "test(fem): qualify authored equilibrium for antidot modes"
```

## Finalna bramka ukończenia

Cel jest ukończony dopiero, gdy jednocześnie:

1. nie istnieje aktywna fizyczna bramka relative torque ani ukryta relaksacja pre-eigen;
2. torque i energy przechodzą pełny handoff/artefakt/native CPU/GPU contract;
3. uncertified artifact/provided i wszystkie niekonwergentne terminacje są fail-closed;
4. v7, API i Inspector zachowują units/provenance bez reinterpretacji;
5. managed Kittel oraz periodic-antidot CPU/GPU produkują zwalidowane spectrum i complex mode fields na tym samym meshu;
6. pełny branch review nie zgłasza otwartych Critical/Important findings.
