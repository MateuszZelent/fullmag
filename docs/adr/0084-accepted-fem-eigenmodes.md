# ADR 0084 — wykonanie FEM Eigenmodes w runie zaakceptowanym (durable Workspace)

- **Status:** propozycja; brak implementacji i kwalifikacji runtime.
- **Data:** 2026-11-18.
- **Uwaga o numeracji:** pierwszy wolny numer na `origin/master` (`e8402f3f6c`); numer `0083` jest zajęty przez [ADR 0083](0083-material-library-and-self-contained-model-copies.md).
- **Powiązania:** [ADR 0034](0034-adaptive-dispersion-process-pool.md), [ADR 0035](0035-typed-study-artifact-manifest-and-worker-boundary.md), [ADR 0036](0036-study-step-runtime-horizon.md), [ADR 0045](0045-accepted-fem-cpu-state-producer.md), [ADR 0055](0055-petsc-slepc-process-serialization.md), [ADR 0058](0058-frequency-domain-content-generation.md), [ADR 0060](0060-accepted-fem-gpu-docker-workspace.md), [ADR 0082](0082-accepted-fem-driven-response.md).
- **Specyfikacja:** [accepted FEM eigenmodes v1](../specs/accepted-fem-eigenmodes-v1.md).
- **Kontrakt artefaktów:** [eigenmode artifacts v1](../specs/eigenmode-artifacts-v1.md) oraz [frequency-domain artifacts v2](../specs/frequency-domain-artifacts-v2.md).

## Kontekst

Native solver modalny `FemEigen` (K0 CPU/GPU Poisson-airbox Schur oraz Floquet $k \neq 0$ CPU) działa w lokalnym orkiestratorze CLI w trybie headless (`crates/fullmag-cli/src/orchestrator.rs:2951-3074`), ale **nie jest wykonywalny w runie zaakceptowanym (API / Control Room / Docker DEV Workspace)**. Audyt etapu 2 (`docs/audits/2026-11-18-eigensolve-performance-and-gpu-readiness-audit.md:466`) potwierdził, że przygotowanie zaakceptowanego modelu FEM odrzuca `FemEigen`, przez co etap modalny w ogóle nie uruchamia się w Docker DEV.

Bezpośrednia weryfikacja na `origin/master` (`e8402f3f6c`) pokazuje sześć luk blokujących wykonanie:

1. **Preparer i planowanie przygotowania:** `accepted_fem_preparer.rs:194-207,473-484` obsługuje wyłącznie `Fem`, `FemFrequencyResponse` i inspekcje antenowe; `crates/fullmag-runtime-control/src/study.rs:31-35,131-143,214-245` nie ma wariantu `NativeFemPreparationKind::FemEigen`; `crates/fullmag-plan/src/preparation.rs:858-904` ma wyłącznie `from_fem_frequency_response_execution_plan_for_accepted_run`.
2. **Materializacja wejścia $M_0$ w runnerze:** `study_magnetization_layout_for_plan` (`crates/fullmag-runner/src/lib.rs:3257-3323`), `materialize_study_magnetization_input_with_overlay` (`:3504-3519`) i `study_plan_state_sample_count` (`:3522-3595`) nie mają gałęzi `BackendPlanIR::FemEigen`; `artifacts::field_layout` zwraca `"fem_eigen"` (`artifacts.rs:6149`), co kończy się błędem.
3. **Worker i horyzont czasu:** `accepted_study_worker.rs:2975-2994` odrzuca porty `Artifact` na krokach solverowych i kieruje cały ruch FEM do `accepted_fem_study_worker.rs`, który wymaga `BackendPlanIR::Fem` (`:445-447,595-597`) i portu `final_state` (`:85,633-655`). Ponadto `resolve_script_until_seconds` zwraca `0.0` dla `StudyIR::Eigenmodes` (`script_stage_materialization.rs:38`), a `accepted_runner_horizon` (`accepted_study_worker.rs:2742-2748`) odrzuca `until_seconds <= 0.0`.
4. **Brak transportu certyfikowanej równowagi `relax → eigen`:** lokalny orkiestrator przekazuje w pamięci `AcceptedFemRelaxStageHandoff.v3` (`orchestrator.rs:2951-3074`, `eigen_equilibrium_contract.rs:872-931`), czego wymaga `validate_eigen_equilibrium_certificate` (`eigen_shared_domain.rs:1585-1637`). W runie zaakceptowanym worker relaksacji FEM (`accepted_fem_study_worker.rs:230-316`) publikuje jedynie `final_state` i `total_energy` — nie istnieje port ani kodek handoffu, a `script_pipeline_acceptance.rs:189-196,335-346` przyjmuje wyłącznie kroki fizyczne `relax`/`run`.
5. **Brak interruptible/identity entrypointu `FemEigen` w runnerze:** gałąź `BackendPlanIR::FemEigen` w interruptible runnerze (`crates/fullmag-runner/src/lib.rs:5112-5135`) nie przyjmuje ani `relax_handoff`, ani `artifact_identity`, ani atomowego `interrupt_requested`.
6. **Admission API i statyczne PBC:** `live_accepted_execution.rs:2755-2850,2890-2906` ogranicza live dispatch i `bounded_gpu_scope` do `TimeEvolution`/`Relaxation`; ponadto dla modeli okresowych K0/Floquet etap poprzedzającej relaksacji FEM jest dziś odrzucany w `accepted_fem_study_worker.rs:598-607` z powodu braku atestacji `FemStaticPbcLane`.

## Proponowana decyzja

Wzorem [ADR 0082](0082-accepted-fem-driven-response.md) wprowadzamy pełny, typowany, fail-closed kontrakt wykonania `FemEigen` w istniejącej infrastrukturze runów zaakceptowanych:

1. **Osobny accepted producent `FemEigen` na wspólnym cyklu życia:**
   - Scheduler, claim, lease, `Prepare`, `Start`, heartbeat, `Stop`, `Completing`, recovery i CAS pozostają jednym wspólnym mechanizmem (`accepted_study_worker.rs` + `accepted_study_supervisor.rs`). Nie powstaje druga kolejka ani alternatywny backend.
   - Dodajemy dedykowany adapter `accepted_fem_eigen_worker.rs` (oddzielny od time-domain `accepted_fem_study_worker.rs`), który konsumuje niezmienny `ProblemIR`, `PreparationReceipt` i certyfikowane wejście równowagi, **nie uruchamia relaksacji** i **nie publikuje `final_state` ani `accepted_state_ref`**.
2. **Osobna ścieżka preparation i materializacji layoutu dla `FemEigen`:**
   - Dodajemy `NativeFemPreparationKind::FemEigen` w `crates/fullmag-runtime-control/src/study.rs`, metodę `materialize_fem_eigen_preparation_receipt`, konstruktor `PreparationMaterialization::from_fem_eigen_execution_plan_for_accepted_run` w `crates/fullmag-plan/src/preparation.rs` oraz gałęzie `BackendPlanIR::FemEigen` w `accepted_fem_preparer.rs` (`accepted_preparation_mesh` i dispatch paragonów).
   - W `crates/fullmag-runner/src/lib.rs` dodajemy obsługę `FemEigen` w `study_magnetization_layout_for_plan`, `materialize_study_magnetization_input_with_overlay` i `study_plan_state_sample_count`, zachowując ścisłe rozdzielenie kanonicznego layoutu wejściowego $M_0$ (`"backend": "fem"` + `field_semantics`) od layoutu wyjściowego `"fem_eigen"` (`bind_live_magnetization_layout` zwraca `None`).
3. **Jawna polityka równowagi (`Provided` vs `RelaxedInitialState` vs `Artifact`):**
   - `RelaxedInitialState`: wymaga jawnej krawędzi danych `StepOutput` (port `relax_handoff`) oraz `completion_dependencies` z ukończonego w tym samym runie kroku `Relax` FEM; worker dekoduje z CAS niezmienny `AcceptedFemRelaxStageHandoff.v3` i przekazuje go wprost do runnera (`validate_eigen_equilibrium_certificate` w `eigen_shared_domain.rs:1585-1637` pozostaje nienaruszone).
   - `Provided`: nie obchodzi certyfikacji równowagi; zgodnie z `eigen_shared_domain.rs:1597-1604` wymaga jawnie związanego, niezmiennego certyfikowanego artefaktu/handoffu (`PinnedArtifact` lub zweryfikowanego continuation z wcześniejszej relaksacji). Przyjęcie niecertyfikowanego stanu przybliżonego wymagałoby osobnej, jawnej decyzji naukowej (analogicznie do `equilibrium_verified=false` w ADR 0082) — **domyślnie dla `FemEigen` obowiązuje fail-closed**.
   - `Artifact { path }`: w runie zaakceptowanym ścieżka hosta nie jest bezpośrednim źródłem bajtów; musi zostać przypięta jako niezmienny `PinnedArtifact` w CAS z pełną walidacją podpisów siatki, materiału, fizyki statycznej i `static_demag_signature` (nota `0830:1941-1960`).
4. **Port i kodek przekazania `relax → eigen`:**
   - Krok `Relax` FEM zadeklarowany jako poprzednik `FemEigen` (w `script_pipeline_acceptance.rs`) publikuje dodatkowy port wyjściowy `relax_handoff` o rodzaju `StudyPortDataKind::Artifact` i kodeku `fullmag.fem.relax_stage_handoff@v1` (rejestrowany w `crates/fullmag-application/src/study_artifact.rs`).
   - Payload kodeka jest ograniczonym binarnym/kanonicznym pakietem zawierającym `AcceptedFemRelaxStageHandoff.v3` wraz z dokładnymi bajtami artefaktów `accepted_fields`, `certified_fields`, `recomputed_certificate` oraz `producer_provenance` (`orchestrator.rs:3021-3071`) — przechowywanym w CAS i przekazywanym wyłącznie przez `StepOutput`, nigdy przez skanowanie katalogu roboczego.
5. **Porty wyjściowe i kodeki artefaktów eigen:**
   - Krok `FemEigen` deklaruje jeden fizyczny `case_id`, obowiązkowy port indeksu `eigen` (`StudyPortDataKind::Artifact`, kodek `fullmag.fem.eigen_index@v1`) oraz deterministyczne porty próbek `eigen-sample-000000`, `eigen-sample-000001`, … (po jednym na z góry znaną próbkę $k$ lub pola bias; kodek `fullmag.fem.eigen_sample@v1`).
   - Pakiet zachowuje logiczne ścieżki i semantykę z [eigenmode-artifacts-v1.md](../specs/eigenmode-artifacts-v1.md) i [frequency-domain-artifacts-v2.md](../specs/frequency-domain-artifacts-v2.md) (widmo `spectrum.json` / `spectrum.v2.json`, dyspersja `branch_table.csv` / `dispersion.csv`, metadane, diagnostyka `eigen/diagnostics/solver.v1.json` oraz binarne payloady modów f64 LE), unikając puchnięcia control-plane JSON o gęste wektory DOF.
   - Publikacja do `study_output_manifest` i CAS (oraz niezmiennej generacji `frequency_domain_artifact_generation.v2` z ADR 0058) jest atomowa i poprzedza `Completed`; obowiązuje łączny budżet RAM i rozmiaru wszystkich pakietów przed `Start`.
6. **Horyzont czasu, anulowanie, provenance i zakaz fallbacku:**
   - `accepted_runner_horizon` (`accepted_study_worker.rs:2736-2750`) rozróżnia brak horyzontu czasowego dla `StudyIR::Eigenmodes` (akceptuje `0.0` jako znacznik braku integracji czasowej, bez narzucania fikcyjnego `until_seconds > 0` w `StudyPlan`).
   - Runner otrzymuje jawne `FrequencyDomainArtifactIdentity` (bez aliasów `current` / `run:current`, zgodnie z ADR 0035 pkt 11 i ADR 0058), `StageFemMeshIdentity`, `Option<&AcceptedFemRelaxStageHandoff>` oraz `Option<&AtomicBool>` dla `Stop`.
   - Rozróżniamy `requested` i `resolved` backend/device/engine; wymuszone GPU nie dostaje CPU lease ani cichego fallbacku.
   - Dla modeli okresowych K0/Floquet etap poprzedzającej relaksacji FEM pozostaje zablokowany w `accepted_fem_study_worker.rs:598-607` do czasu wyeksportowania atestacji `FemStaticPbcLane` (albo użycia już certyfikowanego wejścia równowagi z CAS) — nie znosimy tej strażnicy bez dowodu native PBC.

## Obowiązki i weryfikacja

- Wdrożenie wymaga osobnej aktualizacji istniejących testów źródłowych i kontraktowych blokujących `FemEigen` (pełna lista w [sekcji 9 specyfikacji](../specs/accepted-fem-eigenmodes-v1.md#9-testy-blokujące-obecne-zachowanie-i-plan-ich-aktualizacji)) bez osłabiania ich ochrony dla nieobsługiwanych kroków i nieprawidłowych portów.
- Wymagane nowe regresje: niezgodność fingerprintu/layoutu/hasha siatki lub `relax_handoff`, podrobione lub brakujące pola w `AcceptedFemRelaxStageHandoff.v3`, odmowa niecertyfikowanego `Provided`, brak/duplikat portu `eigen` / `eigen-sample-NNNNNN`, przekroczenie łącznego budżetu RAM/storage, `Stop` przed pierwszą próbką i w trakcie ścieżki $k$, recovery po `Completing` bez drugiego uruchomienia solvera oraz zakaz fallbacku GPU→CPU.
- Zgodność źródeł, kompilacja i testy kontraktowe nie stanowią kwalifikacji fizycznej solvera ani dowodu zbieżności siatki; pełna kwalifikacja wymaga uruchomienia w grupie Docker DEV i weryfikacji residuali pełnego deskryptora.

## Wycofanie i zgodność

Do czasu wdrożenia wszystkich warstw zachowuje się obecne odrzucanie `FemEigen` w runie zaakceptowanym (fail-closed). Nowe kodeki (`fullmag.fem.relax_stage_handoff@v1`, `fullmag.fem.eigen_index@v1`, `fullmag.fem.eigen_sample@v1`) mają odrębne identyfikatory; dotychczasowe kodeki stanu, skalarów, inspekcji anten i driven response pozostają bez zmian. Wycofanie zamyka wyłącznie admission i dispatch `FemEigen`, zachowując istniejące runy, snapshoty, CAS i receipty.
