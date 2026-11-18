# Accepted FEM eigenmodes v1 — projekt kontraktu

- **Status:** propozycja do przeglądu, nie działająca capability.
- **Data:** 2026-11-18.
- **Bazowy commit weryfikacji kodu:** `origin/master` @ `e8402f3f6c`.
- **Decyzja:** [ADR 0084](../adr/0084-accepted-fem-eigenmodes.md).
- **Wzorzec architektoniczny:** [ADR 0082](../adr/0082-accepted-fem-driven-response.md) oraz [accepted FEM driven response v1](accepted-fem-driven-response-v1.md).
- **Fizyka i SI:** `docs/physics/0700-frequency-domain-linearized-llg.md`, `docs/physics/0828-fem-frequency-domain-floquet-demag.md`, `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.
- **Artefakty i projekcja produktu:** [eigenmode-artifacts-v1.md](eigenmode-artifacts-v1.md), `frequency-domain-artifacts-v2.md`, `frequency-domain-results-product-projection-v1.md`.

---

## 1. Cel i zaobserwowany stan na `origin/master`

Celem jest umożliwienie wykonania kroku `FemEigen` (pojedynczy punkt $k=0$ lub $k \neq 0$, ścieżka dyspersyjna $k$ oraz `BiasFieldSweep`) w trwałym runie zaakceptowanym (API v2 / Control Room / Docker DEV Workspace), w tym w kanonicznej sekwencji `Relax → FemEigen`, bez tworzenia osobnego backendu, bez obchodzenia certyfikacji równowagi i bez zmieniania fizyki lub tolerancji solvera.

Bezpośrednia kontrola źródeł na `origin/master` (`e8402f3f6c`) potwierdza, że dziś wykonanie `FemEigen` w runie zaakceptowanym jest zablokowane na siedmiu kolejnych granicach:

| Warstwa | Zweryfikowana lokalizacja w `origin/master` | Obecne zachowanie blokujące |
|---|---|---|
| **Preparer FEM** | `crates/fullmag-api/src/accepted_fem_preparer.rs:194-207`, `:473-484` (`accepted_preparation_mesh`, `prepare_accepted_fem_task`) | `match` obejmuje tylko `Fem`, `FemFrequencyResponse` i `AntennaExternalLeadInspection`; `FemEigen` kończy się `bail!`. |
| **Runtime-control (preparation)** | `crates/fullmag-runtime-control/src/study.rs:31-35` (`NativeFemPreparationKind`), `:114-159`, `:214-245` (`materialize_native_fem_preparation_receipt`) | Brak wariantu `FemEigen` oraz metody `materialize_fem_eigen_preparation_receipt`. |
| **Plan (preparation)** | `crates/fullmag-plan/src/preparation.rs:858-904` (`PreparationMaterialization`) | Istnieje `from_fem_frequency_response_execution_plan_for_accepted_run`, ale brak analogicznego `from_fem_eigen_execution_plan_for_accepted_run`. |
| **Worker (dispatch, horyzont, wyjścia)** | `crates/fullmag-api/src/accepted_study_worker.rs:2159-2196` (`expected_output_binding`), `:2736-2750` (`accepted_runner_horizon`), `:2975-2994` (`execute_accepted_worker_start_with_snapshot`), `:4875-4972` (`collect_runner_study_outputs`); `crates/fullmag-api/src/accepted_fem_study_worker.rs:85,445-447,595-607,633-655` | Odrzucenie `until_seconds <= 0.0` (dla `Eigenmodes` `resolve_script_until_seconds` zwraca `0.0` w `script_stage_materialization.rs:38`), odrzucenie portów `Artifact` na krokach solvera (`:2975`), wymóg `BackendPlanIR::Fem` (`:445,595`) i wyjścia `final_state` (`:633-655`), brak portu/kodeka `relax_handoff` w workerze relaksacji FEM. |
| **Application (kompilacja i kodeki)** | `crates/fullmag-application/src/script_pipeline_acceptance.rs:151-156,189-196,326-350`; `study_artifact.rs:219-227` (`DecodedStudyArtifact`) | Akceptacja pipeline'u dopuszcza tylko fizyczne kroki `relax`/`run` oraz `AntennaClosedLoopInspection`; brak kodeków dla `relax_handoff` i artefaktów `eigen`. |
| **Runner (layout wejścia i wywołanie interruptible)** | `crates/fullmag-runner/src/lib.rs:3257-3323` (`study_magnetization_layout_for_plan`), `:3325-3335` (`bind_live_magnetization_layout`), `:3504-3519` (`materialize_study_magnetization_input_with_overlay`), `:3522-3595` (`study_plan_state_sample_count`), `:5112-5135` (interruptible dispatch) | Brak gałęzi `BackendPlanIR::FemEigen` w materializacji layoutu (fallback do `artifacts::field_layout` zwraca `"fem_eigen"` z `artifacts.rs:6149` i failuje `:3303-3310`); interruptible dispatch `:5112-5135` nie przekazuje `relax_handoff`, `artifact_identity` ani `interrupt_requested`. |
| **API live admission** | `crates/fullmag-api/src/live_accepted_execution.rs:2755-2850` (`select_live_step`, `apply_live_accepted_observation_output_defaults`), `:2852-2920` (`bounded_gpu_scope`) | Komendy live i `bounded_gpu_scope` dopuszczają wyłącznie `Run`/`Relax` (i `TimeEvolution`/`LlgOverdamped`/`ProjectedGradientBb`). |

---

## 2. Zakres backendów, admission i statyczne PBC

| Realizacja | Zakres tej propozycji | Stan obecny na `origin/master` |
|---|---|---|
| **FDM CPU** | bez zmian — `StudyIR::Eigenmodes` jest dziś planowalne wyłącznie dla `backend='fem'` (`crates/fullmag-plan/src/lib.rs:311-314`) | odrzucane na etapie planowania |
| **FDM GPU** | bez zmian — nie dotyczy `FemEigen` | odrzucane na etapie planowania |
| **FEM CPU** | pełny zakres native `FemEigen` (K0 Poisson-airbox Schur, Floquet $k \neq 0$ shared-domain, k-path z opcjonalnym `eigen_k_worker` pod budżetem CPU lease) | brak accepted producer; działa wyłącznie w CLI headless |
| **FEM GPU** | wyłącznie jawnie wspierany zakres native GPU K0 (`periodic_airbox_k0`, Robin, `gauge_policy=none`, $\alpha=0$, double/strict, do 64 modów — `modal_petsc_slepc.cpp:2508-2530`), z lease GPU i weryfikacją UUID; Floquet $k \neq 0$ na GPU pozostaje jawnie `unavailable` (`modal_eigen_solver.cpp:2520`) bez fallbacku CPU | brak accepted producer; `bounded_gpu_scope` odrzuca `Eigenmodes` kodem `accepted_gpu_scope_unsupported` |

**Zasady admission:**
- `requested` i `resolved` backend/device/engine pozostają odrębne (`crates/fullmag-runtime-control/src/study.rs:3890,3918-3925` już weryfikuje `FemEigen` precision i `fem_eigen_execution_resolution`).
- Wymuszone GPU (`device="gpu"`) wymaga aktywnego GPU lease i autorytatywnego UUID; nigdy nie dostaje CPU lease ani cichego fallbacku CPU.
- **Krytyczna uwaga o statycznym PBC w poprzedzającym kroku `Relax`:** w `crates/fullmag-api/src/accepted_fem_study_worker.rs:598-607` funkcja `validate_native_fem_preflight` **odrzuca każdy plan `BackendPlanIR::Fem` z niepustym `periodic_node_pairs`** do czasu wyeksportowania przez runner niezmiennej atestacji `FemStaticPbcLane`. Oznacza to, że w runie zaakceptowanym pełna sekwencja `Relax → FemEigen` dla periodycznych modeli K0/Floquet (w tym `examples/fem_eigen_k0_poisson_airbox_production.py` z `x_faces`/`y_faces`) wymaga dodatkowo:
  1. albo osobnego przyrostu eksportującego natywną atestację `FemStaticPbcLane` dla etapu `Relax` (zalecane dla pełnego przepływu K0/Floquet w Control Room),
  2. albo wejścia do etapu `FemEigen` z już certyfikowanego artefaktu równowagi (`PinnedArtifact` w CAS) w modelach okresowych, przy jednoczesnym odblokowaniu `Relax → FemEigen` dla modeli otwartych (free/open) od pierwszego etapu wdrożenia.
  **Nie wolno usuwać strażnicy `:598-607` bez natywnej atestacji `FemStaticPbcLane`.**

---

## 3. Snapshot, preparation i materializacja wejść

1. **Planowanie preparation (`crates/fullmag-plan/src/preparation.rs`):**
   - Dodać metodę `PreparationMaterialization::from_fem_eigen_execution_plan_for_accepted_run(...)` wzorowaną na `from_fem_frequency_response_execution_plan_for_accepted_run` (`:858-904`).
   - Weryfikacje: zgodność `requested_backend`, `resolved_backend == BackendTarget::Fem`, dopasowanie wariantu `BackendPlanIR::FemEigen(eigen)`, `eigen.fe_order == 1` (w pierwszym zakresie H1/P1) oraz walidacja polityki `eigen.equilibrium` (dozwolone `RelaxedInitialState`, `Provided` z certyfikowanym wejściem lub `Artifact` przypięty w CAS; szczegóły w sekcji 4).
   - Delegacja do istniejącego `Self::from_native_fem_mesh_with_identity(..., &eigen.mesh, eigen.fe_order, eigen.mesh_build_report.as_ref(), native)` — współdzielenie tego samego kontraktu certyfikatów siatki i przestrzeni H1/P1.
2. **Runtime-control (`crates/fullmag-runtime-control/src/study.rs`):**
   - Rozszerzyć `enum NativeFemPreparationKind` (`:31-35`) o wariant `FemEigen`.
   - Dodać publiczną metodę `AcceptedStudySnapshot::materialize_fem_eigen_preparation_receipt(&self, preparation_id, step_id, native)` obok `materialize_fem_frequency_response_preparation_receipt` (`:131-143`) i gałąź `NativeFemPreparationKind::FemEigen` w `materialize_native_fem_preparation_receipt` (`:214-245`).
3. **Preparer (`crates/fullmag-api/src/accepted_fem_preparer.rs`):**
   - W `accepted_preparation_mesh` (`:473-484`) dodać gałąź `BackendPlanIR::FemEigen(eigen) => Ok((&eigen.mesh, eigen.fe_order))`.
   - W `prepare_accepted_fem_task` (`:194-207`) dodać gałąź `BackendPlanIR::FemEigen(_) => accepted.materialize_fem_eigen_preparation_receipt(preparation_id, &step.step_id, &native)`.
   - `publish_prepared_observation` (`:210-231`) pozostaje ograniczone do `BackendPlanIR::Fem(_)` — krok `FemEigen` nie publikuje time-domain prepared observation.
4. **Materializacja kanonicznego layoutu $M_0$ (`crates/fullmag-runner/src/lib.rs` i `artifacts.rs`):**
   - W `crates/fullmag-runner/src/artifacts.rs` dodać `fem_eigen_equilibrium_field_semantics(plan)` na wzór `fem_frequency_response_equilibrium_field_semantics` (`:1933-1975`).
   - W `crates/fullmag-runner/src/lib.rs`:
     - `study_magnetization_layout_for_plan` (`:3257-3323`): dodać gałąź `BackendPlanIR::FemEigen(eigen)` zwracającą kanoniczny layout wejściowy `"backend": "fem"` z `topology_fingerprint_v6()`, `n_nodes`, `n_elements` i `field_semantics` (nie używać layoutu wyjściowego `"fem_eigen"` z `artifacts.rs:6148-6165`);
     - `bind_live_magnetization_layout` (`:3325-3335`): dodać `BackendPlanIR::FemEigen(_)` do gałęzi zwracającej `None`, aby wejściowy layout $M_0$ nigdy nie wyciekł jako layout live/terminalnych modów;
     - `materialize_study_magnetization_input_with_overlay` (`:3504-3519`): dodać `BackendPlanIR::FemEigen(eigen) => copy_predecessor(&mut eigen.equilibrium_magnetization, 0)` (z zakazem częściowych nakładek `initial_state_overlay` łamiących certyfikat równowagi — overlay musi być `None`);
     - `study_plan_state_sample_count` (`:3522-3595`): dodać gałąź `(BackendPlanIR::FemEigen(eigen), Some("fem")) if eigen.fe_order == 1` sprawdzającą `n_nodes`, `equilibrium_magnetization.len()`, `topology_fingerprint_v6()` i `n_elements`.

---

## 4. Polityka równowagi: `Provided` vs `RelaxedInitialState` (i `Artifact`)

`EquilibriumSourceIR` (`crates/fullmag-ir/src/study.rs:1525-1529`) ma trzy warianty: `Provided`, `RelaxedInitialState` oraz `Artifact { path }`. Jedyną autorytatywną bramką w runnerze pozostaje `validate_eigen_equilibrium_certificate` (`crates/fullmag-runner/src/fem/eigen_shared_domain.rs:1585-1637`), której nie wolno osłabiać. W runie zaakceptowanym obowiązują następujące reguły:

| Wariant `EquilibriumSourceIR` | Dozwolone źródło wejścia w `StudyStep.inputs` | Wymagany certyfikat / dowód | Zachowanie w razie braku lub niezgodności |
|---|---|---|---|
| **`RelaxedInitialState`** | Obowiązkowe `StepOutput` na porcie `relax_handoff` (`StudyPortDataKind::Artifact`, kodek `fullmag.fem.relax_stage_handoff@v1`) oraz `completion_dependencies` na ten sam krok `Relax` FEM. (Opcjonalnie równoległy `initial_state` `State` jest weryfikowany pod kątem bitowej zgodności $m_0$ z handoffem, nie zastępuje handoffu). | Pełny `AcceptedFemRelaxStageHandoff.v3` z `completion.status == Converged`, niezmiennym kryterium momentu lub energii (nota `0830:416-449`) oraz zgodnymi podpisami `mesh`, `material`, `static_physics`, `boundary`, `static_demag_signature`. | **Fail-closed przed `Start`:** brak portu `relax_handoff`, niezbieżny krok `Relax` (`max_steps`/`cancelled`/`stagnated`), lub różnica podpisu/siatki blokuje zadanie bez wywołania solvera. Krok `FemEigen` **nigdy nie uruchamia wewnętrznej relaksacji**. |
| **`Provided`** | Wariant A (continuation po wcześniejszej relaksacji): `StepOutput` `relax_handoff` z poprzedniego kroku `Relax` → walidowany przez `handoff.validate_provided_continuation_plan(plan)` (`eigen_shared_domain.rs:1612-1618`).<br>Wariant B (importowany stan certyfikowany): `PinnedArtifact` z CAS o kodeku `fullmag.fem.equilibrium_certificate@v1` (zawierającym kanoniczny `equilibrium_artifact.v7` / `AcceptedFemEigenEquilibriumHandoff.v1`, por. `eigen_equilibrium_contract.rs:2419-2459`) + wejściowy `State` `m0` zweryfikowany bitowo przeciwko artefaktowi. | Zgodność z `validate_eigen_equilibrium_certificate` (`eigen_shared_domain.rs:1597-1604`). Surowy wektor `Provided` bez certyfikatu jest **odrzucony** (`uncertified_provided_equilibrium`), dokładnie tak jak w CLI. | **Fail-closed:** nie zezwalać na niejawne przejęcie surowego `m0` ze sceny ani na `validation_only_raw_provided_fixture_handoff` (`eigen_shared_domain.rs:1643`, tylko `#[cfg(test)]`). Ewentualny tryb pilotażowy na stanie przybliżonym (`equilibrium_verified=false`) pozostaje poza zakresem v1 i wymagałby osobnego ADR oraz jawnego pola provenance w artefaktach eigen. |
| **`Artifact { path }`** | W runie zaakceptowanym niedopuszczalny jest odczyt arbitralnej ścieżki hosta z `path`. Przy Submit/capture (analogicznie do `script_source_capture.rs`) plik `equilibrium_artifact.v7` musi zostać zmaterializowany do CAS i związany jako `PinnedArtifact` na porcie `equilibrium_artifact` (`StudyPortDataKind::Artifact`), a worker materializuje go w prywatnym attempt root lub przekazuje zdekodowany `AcceptedFemEigenEquilibriumHandoff`. | Pełna walidacja preimage `static_demag_signature`, replay pól na nośniku magnetycznym ($\epsilon_H \le 10^{-8}\,\mathrm{A/m}$, $\phi_0 \le 10^{-10}\,\mathrm{A}$ — nota `0830:1895-1960`) i zgodność podpisów z bieżącym planem. | **Fail-closed:** ścieżka hosta poza CAS lub niezgodny podpis odrzucane przy Submit i przed `Start`. |

---

## 5. Port i kodek przekazania `relax → eigen`

### 5.1. Rola i powód wydzielenia z `final_state`

W lokalnym orkiestratorze CLI (`crates/fullmag-cli/src/orchestrator.rs:2951-3074`) po ukończonym kroku `Relax` FEM budowany jest w pamięci `AcceptedFemRelaxStageHandoff` (konstruktorem `from_completed_relax_verified_with_exact_artifacts_and_provenance`, `:3052-3071`) z czterech plików zapisanych przez runner w katalogu etapu:
- `accepted_fields` (`CertifiedFemEquilibriumFields::accepted_artifact_path_for_material`, `:3022`),
- `certified_fields` i `recomputed_certificate` (`artifact_paths_for_material`, `:3027`),
- `producer_provenance` (`FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH`, `:3033`).

Zwykły port `final_state` (`fullmag.runner.field_json@v1`) przenosi wyłącznie wektor $m$, layout i metadane kroku — **nie zawiera** certyfikowanych pól $H_{\mathrm{eff},0}, H_{\mathrm{demag},0}, \phi_0$, certyfikatu `RecomputedFemLinearizationCertificateV1`, podpisów `equilibrium_material/static_physics/boundary_signature` ani `FemRelaxationProducerProvenance`.

### 5.2. Kontrakt portu i kodeka

- **Port wyjściowy w kroku `Relax` FEM:** `port_id = "relax_handoff"`, `data_kind = StudyPortDataKind::Artifact`.
  - Deklarowany przez `script_pipeline_acceptance.rs` (i `live_accepted_execution.rs` dla sekwencji zawierających `Eigenmodes`) wyłącznie na krokach `Relax` FEM, które zasilają downstream `FemEigen` (lub jawnie dla wszystkich zaakceptowanych kroków `Relax` FEM z kompletnym certyfikatem równowagi — bez wymagania tego portu dla kroków `Run` ani FDM).
  - Krok `Relax` nadal publikuje dotychczasowe porty `final_state` i (opcjonalnie) `total_energy`; `relax_handoff` jest dodatkowym portem `Artifact`, nie zamiennikiem `final_state`.
- **Port wejściowy w kroku `FemEigen`:** `port_id = "relax_handoff"`, `data_kind = StudyPortDataKind::Artifact`, `required = true`, `source = StudyInputSource::StepOutput { step_id: <relax_step_id>, port: "relax_handoff", case_id: "default" }`.
- **Kodek w `crates/fullmag-application/src/study_artifact.rs`:**
  - `STUDY_FEM_RELAX_HANDOFF_CODEC_ID = "fullmag.fem.relax_stage_handoff"`, `STUDY_FEM_RELAX_HANDOFF_CODEC_VERSION = "v1"`.
  - Nowy wariant w `DecodedStudyArtifact` (`study_artifact.rs:219-227`): `FemRelaxStageHandoff(FemRelaxStageHandoffBundle)`.
  - **Framing:** ograniczony pakiet binarny wzorowany na `antenna_inspection_bundle.rs` / `study_frequency_response_artifact.rs` (magik `FMRXH001`, kanoniczny manifest JSON z `schema_version = "fullmag.fem.relax_stage_handoff.v1"`, `source_run_id`, `source_step_id`, `source_attempt_id`, `ownership_epoch`, `topology_fingerprint`, `stage_fem_mesh_generation_id`, `handoff_v3_content_sha256` oraz jawna mapa payloadów z `byte_length` i `sha256`: `handoff_v3.json`, `accepted_fields.json`, `certified_fields.json`, `recomputed_certificate.json`, `producer_provenance.json`).
  - **Limity:** manifest $\le 1\,\mathrm{MiB}$, cały pakiet $\le 256\,\mathrm{MiB}$ i mieszczący się w `claim.lease.budget.storage_bytes` oraz w rezerwie RAM przed alokacją. Brak skanowania katalogu, brak ścieżek hosta, zakaz symlinków i path traversal.
- **Podział odpowiedzialności (bez cyklu zależności `application → runner`):**
  - `fullmag-application` waliduje framing, limity bajtów, integralność SHA-256 i strukturę koperty.
  - `fullmag-runtime-control` / `accepted_fem_eigen_worker` (które już zależą od `fullmag-runner`) rekonstruują i weryfikują pełny typ domenowy `fullmag_runner::AcceptedFemRelaxStageHandoff` z dokładnych bajtów odczytanych z CAS (analogicznie do `closed_loop_v2::verify` w ADR 0036:462-465).
- **Publikacja po stronie workera relaksacji (`accepted_fem_study_worker.rs`):**
  - W `validate_declared_outputs` (`:633-655`) dopuścić opcjonalny port `StudyPortDataKind::Artifact if output.port_id == "relax_handoff"` wyłącznie gdy `problem.study` to `StudyIR::Relaxation { .. }`.
  - Po zakończeniu relaksacji ze statusem `Completed` i zweryfikowaną zbieżnością (`result.completion`) zebrać dokładnie cztery jawne pliki ze zweryfikowanej listy ścieżek `CertifiedFemEquilibriumFields` (tak jak `orchestrator.rs:3021-3071`), zbudować `AcceptedFemRelaxStageHandoff`, zakodować `fullmag.fem.relax_stage_handoff@v1` i opublikować do CAS w `study_output_manifest` przed `Completed`. Jeśli relaksacja nie uzyskała certyfikowanej zbieżności (`max_steps` lub `cancelled`), port `relax_handoff` **nie powstaje** i krok nie przechodzi bramki publikacji jako gotowe źródło dla `FemEigen`.

---

## 6. Porty wyjściowe i kodek artefaktów eigen

### 6.1. Relacja do `eigenmode-artifacts-v1.md` i `frequency-domain-artifacts-v2.md`

Specyfikacja [eigenmode-artifacts-v1.md](eigenmode-artifacts-v1.md) definiuje logiczny układ artefaktów ścieżki `FemEigen`:
- `eigen/spectrum.json` oraz lustrzane `eigen/metadata/eigen_summary.json` (plus produkcyjne `eigen/spectrum.v2.json` / `eigen/spectrum.v3.json` z `frequency-domain-artifacts-v2.md`),
- `eigen/modes/mode_XXXX.json` (oraz binarne payloady modów f64 LE publikowane przez runner),
- `eigen/dispersion/branch_table.csv` (i `eigen/dispersion.csv` / `eigen/dispersion/path.json`),
- `eigen/metadata/normalization.json`, `eigen/metadata/equilibrium_source.json`,
- `eigen/diagnostics/solver.v1.json` i `eigen/diagnostics.v2.json`.

Tak jak w ADR 0082 (sekcja 4.1 dla `driven_response`), bezpośrednie wkładanie wielogigabajtowych wektorów DOF do jednego dokumentu JSON control-plane jest niedopuszczalne. Kontrakt v1 dla accepted `FemEigen` dzieli więc artefakty na **lekki indeks** oraz **ograniczone pakiety próbek**:

### 6.2. Porty wyjściowe kroku `FemEigen`

Plan kroku `FemEigen` deklaruje **jeden fizyczny `case_id`** (`"default"`) oraz z góry znaną, deterministyczną listę portów `StudyPortDataKind::Artifact`:
- **`eigen`** — obowiązkowy port indeksu globalnego (widmo zbiorcze, dyspersja CSV, gałęzie, metadane równowagi/normalizacji, globalna diagnostyka oraz uporządkowana lista portów próbek z ich `bundle_sha256`);
- **`eigen-sample-000000`, `eigen-sample-000001`, …** — jeden port na każdą z góry znaną próbkę $k$ (wynikającą z `expand_k_sampling(plan.k_sampling)`) lub próbkę `bias_field_samples` (dla pojedynczego $k=0$ jest dokładnie jeden port `eigen-sample-000000`).

Zabronione jest deklarowanie portu `final_state` lub `total_energy` na kroku `FemEigen` — analiza modalna nie publikuje nowego stanu magnetyzacji czasu rzeczywistego.

### 6.3. Kodeki i framing w `crates/fullmag-application`

Nowy moduł `crates/fullmag-application/src/study_eigen_artifact.rs` (wzorowany bezpośrednio na `crates/fullmag-application/src/study_frequency_response_artifact.rs:1-130`):

- **`fullmag.fem.eigen_index@v1`** (`EIGEN_INDEX_CODEC_ID = "fullmag.fem.eigen_index"`, wersja `"v1"`, magik `FMEGB001`):
  - Manifest JSON ($\le 1\,\mathrm{MiB}$): `schema_version = "fullmag.fem.eigen_index.v1"`, `status = "complete"`, `study_product = "modal_eigen"`, `identity` (`session_id`, `run_id`, `task_id`, `stage_id`, `runtime_id`, `attempt_id`, `ownership_epoch`, `case_id`, `plan_fingerprint`, `topology_fingerprint`, `equilibrium_sha256`, `equilibrium_source_kind`, `equilibrium_verified`, `requested_execution`, `resolved_execution`, `executed_engine`, `gpu_uuid`), `sample_count`, uporządkowana lista `samples[]` (`sample_index`, `k_vector_rad_m`, `bias_field_a_per_m`, `port_id`, `bundle_sha256`, `accepted_mode_count`, `spectrum_completeness`, `window_complete`) oraz mapa globalnych payloadów allow-listy (`eigen/spectrum.json`, `eigen/spectrum.v2.json`, `eigen/metadata/eigen_summary.json`, `eigen/metadata/normalization.json`, `eigen/metadata/equilibrium_source.json`, `eigen/dispersion/branch_table.csv`, `eigen/dispersion/path.json`, `eigen/diagnostics/solver.v1.json`, opcjonalnie `eigen/diagnostics.v2.json`, `metadata.json`).
- **`fullmag.fem.eigen_sample@v1`** (`EIGEN_SAMPLE_CODEC_ID = "fullmag.fem.eigen_sample"`, wersja `"v1"`, magik `FMEGB001`):
  - Manifest JSON ($\le 1\,\mathrm{MiB}$) + binarnie oprawione payloady danej próbki: metadane próbki (`sample_index`, `k_vector_rad_m`, `port_id`, lista zaakceptowanych częstotliwości, maksymalne residuum oryginalnego deskryptora `modal_original_unscaled_full_descriptor_backward_error`, `full_residual_certified`, `spectrum_completeness`, `window_complete`), kompaktowe podsumowania modów oraz dokładne bajty binarnych pól modów (f64 LE) i wymaganych przez [eigenmode-artifacts-v1.md](eigenmode-artifacts-v1.md) plików `eigen/modes/mode_XXXX.json` (jeśli żądane w `sampling.outputs`; docelowo po Etapie 5b / D5 z lekkim JSON bez duplikowania gęstych wektorów obecnych w payloadzie binarnym).
- **Budżety i zasady integralności:**
  - Limit pojedynczego pakietu: `256 MiB` (jak `FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES` w `study_frequency_response_artifact.rs:15`).
  - **Kontrola sumy przed `Start`:** estymator rozmiaru na podstawie liczby próbek, liczby żądanych modów `plan.count`, liczby węzłów siatki oraz aktywnych `sampling.outputs` sprawdza przed utworzeniem katalogu attemptu, że łączny rozmiar pakietów, buforów serializacji i kopii CAS mieści się w `claim.lease.budget.memory_bytes` i `claim.lease.budget.storage_bytes` (z rezerwą na pracę solvera native). Przekroczenie limitu kończy się jawnym błędem — nigdy obcięciem modów lub próbek.
  - Zakaz skanowania katalogu, symlinków, path traversal, duplikatów ścieżek i kolizji case-fold; źródłem listy plików jest wyłącznie jawna allow-lista zwrócona przez runner / `frequency_domain_artifact_generation.v2` (ADR 0058).
- **Publikacja dla Control Room API:**
  - Obok publikacji do CAS przez `study_output_manifest`, worker wiąże niezmienną generację `frequency_domain_artifact_generation.v2` w katalogu `published/` attemptu z prawdziwym `FrequencyDomainArtifactIdentity` (`session_id`, `run_id`, `stage_id`, `runtime_id` — bez aliasów `current`), dzięki czemu istniejące endpointy `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs:1146-1425` (widmo, dyspersja, gałęzie, diagnostyka i binary field data plane) odczytują wyniki bez tworzenia nowego drzewa endpointów. Odtworzenie z samego CAS odbudowuje dokładnie tę samą zamkniętą publikację `published/` z identycznymi hashami.

---

## 7. Wykonanie w workerze, horyzont czasu, `Stop` i recovery

1. **Horyzont czasu (`crates/fullmag-api/src/accepted_study_worker.rs:2736-2750`):**
   - `script_stage_materialization::resolve_script_until_seconds` (`:38`) zwraca `Ok(0.0)` dla `StudyIR::Eigenmodes`.
   - `accepted_runner_horizon` odrzuca dziś `until_seconds <= 0.0` (`:2743`).
   - Zmiana: wyodrębnić jawny warunek dla `StudyIR::Eigenmodes` (w którym `accepted_step.until_seconds` musi być `None` — podanie jawnego horyzontu na kroku eigen jest błędem walidacji, analogicznie do `ClosedLoopInspection` w `script_pipeline_acceptance.rs:474`), zwracając `0.0` wyłącznie dla `StudyIR::Eigenmodes` (lub nie wołając `accepted_runner_horizon` w dedykowanym `accepted_fem_eigen_worker.rs`). `TimeEvolution` nadal bezwzględnie wymaga skończonego `until_seconds > 0.0` (ADR 0036).
2. **Dedykowany worker `crates/fullmag-api/src/accepted_fem_eigen_worker.rs`:**
   - Rejestrowany w `main.rs` i `accepted_worker_main.rs` (obok `accepted_fem_study_worker.rs` i `accepted_fem_frequency_response_worker.rs`).
   - W `accepted_study_worker.rs:2957-2994` dodać wyraźny dispatch dla `BackendPlanIR::FemEigen(_)` **przed** gałęzią odrzucającą `StudyPortDataKind::Artifact` (`:2975`) oraz **przed** `execute_accepted_fem_worker_start` (`:2985`):
     1. Walidacja zadeklarowanych portów wyjściowych `validate_declared_outputs(&study_step.outputs, expected_sample_count)`.
     2. Walidacja `PreparationReceipt` (dokładnie jeden certyfikat przestrzeni H1/P1, zgodny `plan_fingerprint` i `PreparationBinding`).
     3. Walidacja żądanego urządzenia i lease (`resolve_accepted_fem_runtime`, UUID GPU przy `device == "gpu"`, brak override zmiennymi `FULLMAG_FEM_EXECUTION` / `FULLMAG_FEM_REQUIRE_GPU`).
     4. Materializacja wejść z CAS (`ExecutionPlanIR` + zdekodowany `Option<AcceptedFemRelaxStageHandoff>`).
     5. Preflight budżetu RAM/storage i `resolve_session_runtime_for_plan_and_preview` (brak cichego fallbacku).
     6. Dopiero po przejściu wszystkich sprawdzeń: utworzenie prywatnego katalogu attemptu, trwały `WORKER_EXECUTION_STARTED_RECEIPT`, wywołanie runnera z `FrequencyDomainArtifactIdentity`, `StageFemMeshIdentity`, `relax_handoff`, `interrupt_requested` i callbackiem postępu publikującym `SolverProgress::FemEigen` (`crates/fullmag-runner/src/lib.rs:3913,4112`).
3. **Naprawa entrypointu runnera (`crates/fullmag-runner/src/lib.rs:5112-5135`):**
   - Rozszerzyć interruptible entrypoint runnera dla `BackendPlanIR::FemEigen` o przekazanie:
     - `relax_handoff: Option<&AcceptedFemRelaxStageHandoff>` (jak w `:4430-4450`),
     - `artifact_identity: Option<&eigen::FrequencyDomainArtifactIdentity>` (propagowane do writera generacji v2 i `eigen/diagnostics/solver.v1.json`),
     - `interrupt_requested: Option<&AtomicBool>` (sprawdzane zarówno w `progress_callback` przez zwrot `StepAction::Cancel`, jak i na granicach próbek $k$ i w callbacku natywnym KSP/EPS).
4. **Kompletność, `Stop` i recovery:**
   - Sukces accepted `FemEigen` wymaga statusu `RunStatus::Completed`, wszystkich zadeklarowanych portów `eigen` + `eigen-sample-NNNNNN`, obecności `eigen/diagnostics/solver.v1.json` oraz spełnienia kryterium certyfikacji pełnego residualu (`full_residual_certified == true`; dla celu `frequency_window` jawny status `window_complete` trafia do manifestu, a niekompletne okno ze statusem błędu solvera oznacza failed attempt, nigdy fałszywy `complete`).
   - `Stop` przed pierwszą próbką lub w trakcie ścieżki $k$ kończy attempt jako `Cancelled`, zachowuje częściowe artefakty diagnostyczne w prywatnym katalogu attemptu, **nie publikuje** `fullmag.fem.eigen_index@v1` ze statusem `complete` i zwalnia lease dopiero po potwierdzonym wyjściu procesu (również ewentualnych procesów potomnych `eigen_k_worker`!).
   - Recovery po awarii (przed `Completed` lub po `Completing` przed ACK) stosuje dokładnie ten sam fence co ADR 0035 i ADR 0082: nigdy nie uruchamia solvera ponownie przy niejednoznacznym `WORKER_EXECUTION_STARTED_RECEIPT`, a przy kompletnym `WORKER_EXECUTION_COMPLETED_RECEIPT` rewaliduje wszystkie digesty, porty i `case_id` z CAS bez wymagania `accepted_state_ref`.

---

## 8. Mapa zmian plik po pliku (zweryfikowana na `origin/master` @ `e8402f3f6c`)

| Crate / plik | Zweryfikowane symbole i linie w `origin/master` | Wymagana zmiana |
|---|---|---|
| `crates/fullmag-plan/src/preparation.rs` | `PreparationMaterialization::from_fem_frequency_response_execution_plan_for_accepted_run` (`:858-904`), `from_native_fem_mesh_with_identity` (`:893`) | Dodać `from_fem_eigen_execution_plan_for_accepted_run` dla `BackendPlanIR::FemEigen`. |
| `crates/fullmag-application/src/study_eigen_artifact.rs` *(nowy)* | Wzorzec: `study_frequency_response_artifact.rs:1-130` | Kodeki i bounded binary framing `fullmag.fem.eigen_index@v1`, `fullmag.fem.eigen_sample@v1` oraz `fullmag.fem.relax_stage_handoff@v1`. |
| `crates/fullmag-application/src/study_artifact.rs` | `DecodedStudyArtifact` (`:219-227`), `decode_study_artifact_bytes` | Rejestracja 3 nowych kodeków (index eigen, sample eigen, relax handoff) i ich wariantów w `DecodedStudyArtifact`. |
| `crates/fullmag-application/src/script_pipeline_acceptance.rs` | `compile_accepted_closed_loop_pipeline` (`:25-137`), `bind_scene_study_physical_state_flow` (`:141-229`, szczególnie `:189-196`), `physical_step_contract` (`:326-350`), `validate_accepted_script_pipeline_source` (`:401-450`) | Dodać obsługę węzła `stage_kind == "eigenmodes"` (`StudyIR::Eigenmodes`), wiązanie `completion_dependencies` + portu `relax_handoff` z poprzedzającego `Relax` FEM (lub `PinnedArtifact` dla `Provided`/`Artifact`), deklarację portów `eigen` + `eigen-sample-NNNNNN` oraz zakaz `until_seconds` na kroku eigen. |
| `crates/fullmag-runtime-control/src/study.rs` | `NativeFemPreparationKind` (`:31-35`), `materialize_fem_frequency_response_preparation_receipt` (`:131-143`), `materialize_native_fem_preparation_receipt` (`:214-245`), `materialize_accepted_worker_execution_plan` (`:1200-1295`) | Dodać `NativeFemPreparationKind::FemEigen` + `materialize_fem_eigen_preparation_receipt`; w materializacji wejść dodać obsługę portu `relax_handoff` (`StudyPortDataKind::Artifact`, kodek `fullmag.fem.relax_stage_handoff@v1`) zwracanego obok zmaterializowanego `ExecutionPlanIR` bez nadpisywania `materialized_state`. |
| `crates/fullmag-runner/src/artifacts.rs` | `fem_frequency_response_equilibrium_field_semantics` (`:1933-1975`), `field_layout` (`:6148-6165`) | Dodać `fem_eigen_equilibrium_field_semantics` bez zmiany `field_layout` wyjściowego `"fem_eigen"`. |
| `crates/fullmag-runner/src/lib.rs` | `study_magnetization_layout_for_plan` (`:3257-3323`), `bind_live_magnetization_layout` (`:3325-3335`), `materialize_study_magnetization_input_with_overlay` (`:3504-3519`), `study_plan_state_sample_count` (`:3522-3595`), interruptible dispatch `BackendPlanIR::FemEigen` (`:5112-5135`) | Dodać gałąź `FemEigen` w 4 funkcjach layoutu/materializacji oraz przekazać `relax_handoff`, `artifact_identity` i `interrupt_requested` w interruptible dispatch `FemEigen`. |
| `crates/fullmag-api/src/accepted_fem_preparer.rs` | `prepare_accepted_fem_task` (`:194-207`), `accepted_preparation_mesh` (`:473-484`) | Dodać gałąź `BackendPlanIR::FemEigen` w obu `match`. |
| `crates/fullmag-api/src/accepted_fem_study_worker.rs` | `prepare_accepted_fem_execution` (`:71-155`), `execute_accepted_fem_attempt` (`:164-317`), `validate_declared_outputs` (`:633-655`) | Dodać opcjonalny port wyjściowy `relax_handoff` (`Artifact`) na kroku `Relax` FEM: budowa i publikacja `fullmag.fem.relax_stage_handoff@v1` z 4 zweryfikowanych artefaktów relaksacji. *(Uwaga: osobny przyrost dla atestacji `FemStaticPbcLane` w `:598-607`, jeśli celem jest relaksacja periodyczna w runie zaakceptowanym).* |
| `crates/fullmag-api/src/accepted_fem_eigen_worker.rs` *(nowy)* | Wzorzec: `accepted_fem_frequency_response_worker.rs:1-37` i `accepted_fem_study_worker.rs` | Walidacja portów `eigen` / `eigen-sample-NNNNNN`, preflight, budżety RAM/storage, wywołanie runnera z `relax_handoff` i `artifact_identity`, kodowanie pakietów CAS, recovery bez `accepted_state_ref`. |
| `crates/fullmag-api/src/accepted_study_worker.rs` | `expected_output_binding` (`:2159-2196`), `accepted_runner_horizon` (`:2736-2750`), `execute_accepted_worker_start_with_snapshot` (`:2957-2994`), `collect_runner_study_outputs` (`:4875-4972`) | Dodać powiązania kodeków `eigen` / `eigen-sample-*` / `relax_handoff`, obsługę horyzontu `0.0` dla `Eigenmodes` i dispatch `BackendPlanIR::FemEigen` do `accepted_fem_eigen_worker`. |
| `crates/fullmag-api/src/live_accepted_execution.rs` | `select_live_step` (`:2755-2818`), `apply_live_accepted_observation_output_defaults` (`:2824-2850`), `bounded_gpu_scope` (`:2890-2906`), `has_sequential_physical_pipeline` (`:4833-4844`) | Rozszerzyć wybór kroków live, domyślne porty `eigen` / `relax_handoff` oraz `bounded_gpu_scope` o zweryfikowany zakres `FemEigen` (K0 GPU double/strict) bez otwierania nieobsługiwanych kombinacji. |
| `crates/fullmag-api/src/main.rs` i `accepted_worker_main.rs` | Deklaracje modułów `mod accepted_fem_*` | Zarejestrować `mod accepted_fem_eigen_worker;`. |

---

## 9. Testy blokujące obecne zachowanie i plan ich aktualizacji

Poniższe testy istniejące na `origin/master` (`e8402f3f6c`) bezpośrednio utrwalają dzisiejsze ograniczenia lub wyliczają obsługiwane warianty — w trakcie implementacji ADR 0084 wymagają świadomej, precyzyjnej aktualizacji (**nigdy usuwania ani osłabiania asercji bezpieczeństwa**):

| Plik i linia (`origin/master`) | Nazwa testu | Co dziś blokuje / sprawdza | Jak zaktualizować (zachowując rygor) |
|---|---|---|---|
| `crates/fullmag-api/src/accepted_fem_preparer.rs:644-661` | `mesh_selection_preserves_magnetic_mesh_order_and_rejects_fdm` | Asertuje konkretny tekst komunikatu błędu `error.to_string().contains("frequency-response")` dla odrzuconego `Fdm` (`:660`). | Zachować odrzucenie `Fdm` i sprawdzenie `fe_order` bez wymuszania klamry tekstowej; dodać pozytywny przypadek dla `BackendPlanIR::FemEigen` (zachowanie `mesh` i `fe_order`). |
| `crates/fullmag-api/src/accepted_fem_study_worker.rs:768-776` | `cancellation_is_structured_before_common_stop_handling` | Source-contract sprawdzający obecność `AcceptedFemExecutionOutcome::Cancelled` i `"FemStaticPbcLane attestation"`. | **Nie usuwać** (strażnica `FemStaticPbcLane` zostaje do czasu osobnej atestacji PBC); dodać bliźniaczy test strukturalnego anulowania w `accepted_fem_eigen_worker.rs`. |
| `crates/fullmag-api/src/accepted_fem_study_worker.rs:779-783` | `fem_outputs_keep_the_fixture_public_port_names` | Sprawdza, że `accepted_fem_study_worker.rs` obsługuje `final_state` i `total_energy`. | Rozszerzyć o kontrolę opcjonalnego portu `relax_handoff` (`StudyPortDataKind::Artifact`) na kroku `Relax`, z jednoczesnym testem odrzucającym `relax_handoff` na kroku `Run` oraz port `eigen` w time-domain workerze. |
| `crates/fullmag-api/src/accepted_fem_study_worker.rs:818-827` | `both_api_binary_roots_register_the_fem_modules` | Sprawdza rejestrację modułów `accepted_fem_*` w `main.rs` i `accepted_worker_main.rs`. | Dopisać asercję obecności `mod accepted_fem_eigen_worker;` w obu rootach binarnych. |
| `crates/fullmag-api/src/accepted_study_worker.rs:5387-5392` | `gpu_lane_is_scoped_to_receipted_time_evolution_or_llg` | Weryfikuje zawartość źródła `accepted_fem_study_worker.rs` (ograniczenie GPU do time-domain / LLG / PG-BB). | Zachować bez zmian dla time-domain workera; dodać oddzielny test zakresu GPU w `accepted_fem_eigen_worker.rs` (akceptuje wyłącznie kwalifikowany zakres K0 GPU, odrzuca Floquet $k \neq 0$ GPU i zakazuje fallbacku CPU). |
| `crates/fullmag-api/src/live_accepted_execution.rs:4075-4181` | Test wywołujący `apply_live_accepted_observation_output_defaults` (krok `"eigenmodes"` w `:4118-4124`, asercja `:4175`) | **Jawnie asertuje `assert!(study.steps[4].outputs.is_empty())` dla kroku `Stage::Eigenmodes`!** | Zaktualizować asercję dla kroku `Eigenmodes` na deterministyczne domyślne porty `eigen` (+ `eigen-sample-*`), zachowując asercje, że `disabled-run`, `empty-antenna`, `macro`, `group` i `unsupported` nadal pozostają puste. |
| `crates/fullmag-api/src/live_accepted_execution.rs:4271-4290` | `accepted_gpu_scope_allows_only_explicit_fem_projected_gradient_bb` | Sprawdza zawężony zakres relaksacji GPU (`bounded_gpu_relaxation_algorithm`). | Pozostawić bez zmian dla relaksacji; dodać osobne testy dla `bounded_gpu_scope` dopuszczające wyłącznie kwalifikowany `StudyIR::Eigenmodes` (K0/Robin/double/strict) i odrzucające Floquet/non-Robin/single GPU. |
| `crates/fullmag-api/src/live_accepted_execution.rs:4848-4862` | `sequential_physical_pipeline_counts_only_enabled_physical_steps` | Liczy tylko włączone `Run`/`Relax` w `has_sequential_physical_pipeline`. | Rozszerzyć pomocnika (lub dodać równoległy detektor `has_accepted_eigen_pipeline`) i zaktualizować test o przypadek `Relax → Eigenmodes` (włączone i wyłączone). |
| `crates/fullmag-application/src/script_pipeline_acceptance.rs:596-610` | `physical_snapshots_bind_once_pinned_profile_and_exact_state_chain` | Asertuje, że każdy krok w sekwencji fizycznej ma dokładnie `vec![StudyOutputPort { port_id: "final_state", State }]` (`:608`). | Jeśli `relax_handoff` jest emitowany **tylko** wtedy, gdy kolejny krok to `Eigenmodes`, ten test pozostaje zielony bez zmian (zalecane!); dodać nowy test dla sekwencji `Relax → Eigenmodes` weryfikujący porty `relax_handoff` i `eigen` / `eigen-sample-000000`, `completion_dependencies`, brak `until_seconds` na eigen i odrzucenie podmienionego `relax_handoff`. |
| `crates/fullmag-runtime-control/src/study_tests.rs:315-373` | `accepted_frequency_response_preparation_binds_native_evidence_to_exact_run_problem_and_step` | Wzorzec testu dla FR; sprawdza, że ścieżka time-domain odrzuca FR. | Dodać analogiczny test dla `FemEigen`: `materialize_fem_preparation_receipt` nadal odrzuca `FemEigen`, `materialize_fem_eigen_preparation_receipt` wiąże `run_id`, `step_id`, `specification_fingerprint`, odrzuca rebinding na inny krok i odrzuca obcy `canonical_mesh_fingerprint`. |
| `crates/fullmag-runner/src/lib.rs:8098-8235` | `fem_frequency_response_materializes_exact_canonical_m0_without_changing_output_layout` i sąsiednie | Wzorzec testów layoutu wejścia $M_0$ dla FR. | Dodać bliźniacze testy dla `BackendPlanIR::FemEigen`: materializacja `equilibrium_magnetization` bez zmiany output layoutu `"fem_eigen"`, odrzucenie `fe_order != 1`, odrzucenie obcego `topology_fingerprint` i odrzucenie częściowego `initial_state_overlay`. |

---

## 10. Bramki dowodowe przed uznaniem capability za gotową

Zgodnie z `AGENTS.md` i wzorcem z `accepted-fem-driven-response-v1.md`:

1. **Testy źródeł i kontraktów (w kontrolowanym CI po zdjęciu zakazu kompilacji testów):**
   - niezgodny fingerprint/layout/hash siatki lub `relax_handoff`, brak/duplikat portu `eigen` / `eigen-sample-NNNNNN`, niecertyfikowane `Provided`, path traversal/symlink w pakiecie, przekroczenie łącznego limitu RAM/storage, niezgodny `case_id` i `gpu_uuid` — wszystkie odrzucane fail-closed.
2. **Managed runtime w grupie Docker DEV (CPU i GPU osobno):**
   - mały przypadek otwarty `Relax → FemEigen` na FEM CPU (pełna sekwencja dwóch tasków przez jeden scheduler, CAS `relax_handoff`, `eigen` + `eigen-sample-000000`, obecny `eigen/diagnostics/solver.v1.json`, `full_residual_certified == true`);
   - przypadek z `PinnedArtifact` dla periodycznego K0 CPU (oraz K0 GPU z realnym UUID i bez fallbacku CPU), z porównaniem częstotliwości i residuali do lokalnego CLI headless (`|\Delta f|/\max(|f|, 1\,\mathrm{Hz}) \le 10^{-12}` na CPU).
3. **Cykl życia i recovery:**
   - `Stop` przed pierwszą próbką i w trakcie wielopunktowej ścieżki $k$ (brak `complete` indeksu, brak osieroconych procesów `eigen_k_worker`, zwolnienie lease);
   - recovery po `Completing` bez ponownego uruchomienia solvera;
   - odtworzenie `published/` wyłącznie z CAS i potwierdzenie identycznych hashy.
4. **API i przeglądarka (Control Room):**
   - odczyt `spectrum`, `dispersion`, `diagnostics` i binarnego pola modu dla tego samego `session_id`/`run_id`/`stage_id` (bez aliasu `current`), widoczny canvas WebGL, niezagubiony kontekst, niezerowy drawing buffer oraz zachowanie tych samych hashy po reloadzie strony.

> **Granica kwalifikacji:** przejście powyższych bramek kwalifikuje wyłącznie integrację aplikacyjną `FemEigen` w durable Workspace; nie stanowi kwalifikacji fizycznej konkretnego modelu ani dowodu zbieżności siatki.
