# Audyt obecnych ustawień CPU/GPU i punktów integracji

Data: 2026-10-04. Odczyt źródeł na współdzielonym `master` rozpoczęto przy
`6c0c76551b6095b064e996cbb4c80a4ba7952aa9`; w trakcie równoległa praca przesunęła
HEAD do `e62bb9258aef33904256c79a72c75b805f760cf6`, a przy zapisie manifestu do
`80e2b612e9075035ee386ac8dd89d3a809bbf6c9`. Ostatni commit zmienił ordinary
Python output roots i jego contract check, poza kontrolami compute tego audytu.
Checkout zawierał również
lokalne zmiany. Nie przywracano plików ani nie modyfikowano kodu wykonania.
Końcowe tożsamości badanych plików zapisuje sąsiedni `source-manifest.json`.
Późniejszy HEAD i ponowną kontrolę zgodności hashy opisuje raport weryfikacji
w tym folderze; współdzielony branch pozostawał aktywny podczas projektowania.
Numery linii są lokalizatorem z odczytu; stabilnym odwołaniem jest path + symbol.

Ten audyt dowodzi obecności i semantyki źródeł, **nie** wykonania wielokartowego,
skalowania ani kwalifikacji solverów. Nie uruchamiano buildów/testów jednostkowych
ani symulacji. Wcześniejsze dowody UI są opisane w
[Compute environment](../../../design/start-screen/docs/09-compute-environment.md).

## 1. Ustawienia, których szukał użytkownik

| ID | Wejście / obecna wartość | Rzeczywisty konsument i znaczenie |
|---|---|---|
| S01 | `just fullmag`: `backend=fem/fdm/auto`, `device=cpu/gpu/auto` | `justfile`, recepta `fullmag` (okolice 5649–5748) → `FULLMAG_FDM_EXECUTION` lub `FULLMAG_FEM_EXECUTION`/`FULLMAG_RELAX_DEVICE`. Ogólny parser nie ma własnego CPU threads, GPU UUID/count, affinity ani NUMA |
| S02 | Nazwane recepty FEM: `cpu_threads="auto"` lub liczba; także named FDM relax recipes | `justfile`, m.in. `run-permalloy-box-relax-fdm-*` (5995–6018), named FEM recipes (6295–6373) → `FULLMAG_CPU_THREADS`. Każda uruchamia jeden entrypoint, nie fan-out cases |
| S03 | `FULLMAG_CPU_THREADS`, `RAYON_NUM_THREADS`, ProblemIR threads | `crates/fullmag-runner/src/lib.rs` — `requested_cpu_threads`, `configured_cpu_threads`, `DEFAULT_AUTO_CPU_THREAD_CAP` (5162–5225). Jawne problem threads > FULLMAG > RAYON > dostępny parallelism; Auto uwzględnia host, zewnętrzne resolution albo cap 16. Konfiguruje Rayon używany przez runner |
| S04 | `OMP_NUM_THREADS` i `FULLMAG_CPU_THREADS` w FEM | `backends/fem/cpu/mfem/runtime/cpu_threads.cpp` — `configure_fem_host_runtime_threads` (131), helper logic (67–105). Auto ma własną logikę; w ścieżce numeric OMP może wyprzedzać FULLMAG. Dochodzą ograniczenia zależne od mesh/device. ProblemIR threads nie jest sam bezpośrednim limitem OpenMP |
| S05 | Managed FEM wrapper: Auto z cap 8, jeśli OMP nie ustawione; Windows Compose zawiera OMP=16 | `scripts/export_fem_gpu_runtime.sh`, generowany entrypoint (1193–1217); `compose.windows.yaml` (51–66, 144–157). To kolejne źródło resolution, zależne od odziedziczonego env |
| S06 | `study.threads(n)`, `.engine()`, `.device(spec, precision=...)`, `.mode()` | `packages/fullmag-py/src/fullmag/world.py` — `StudyBuilder` (5608–5653) i `device` (6453–6478). `cpu`, `gpu`, `cuda`, `cuda:N`; N jest ordinalem, nie liczbą zadań |
| S07 | `RuntimeSelection`: backend/device Auto, cpu_threads=None, index=None, strict, double | `packages/fullmag-py/src/fullmag/model/problem.py` — `RuntimeSelection` (1559–1601). `gpu_count > 1` jest odrzucane jako niewdrożone; nie można użyć tego pola jako batch concurrency |
| S08 | `FULLMAG_GMSH_THREADS`, często jawnie 1 w receptach | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` — `_resolve_gmsh_thread_count`, `_configure_gmsh_threads` (121–153). FULLMAG_GMSH > FULLMAG_CPU > requested_threads > os.cpu_count. Ustawia General.NumThreads i Mesh.MaxNumThreads1D/2D/3D; dotyczy mesh preparation |
| S09 | FDM/FEM/generic GPU indices, default 0 | `crates/fullmag-runner/src/dispatch.rs` — `runtime_device_index`, `apply_runtime_gpu_index` (2264–2307). Backend-specific env może wyprzedzić indeks problemu. FDM: `backends/fdm/api/c_api.cpp` (210–236); FEM: `backends/fem/cpu/mfem/runtime/availability.cpp` (32–52), `backends/fem/cpu/mfem/runtime/mfem_context.cpp` (187–205) |
| S10 | `just fem-gpu-headless` wymusza oba indeksy 0 | `justfile`, `fem-gpu-headless` (6816–6826). Sam wrapper eksportowanego runtime także domyślnie wybiera 0; `gpus: all` w Compose udostępnia urządzenia, nie rozdziela zadań |
| S11 | Windows FDM oraz FEM mają odrębne zarządzane launchery | `scripts/windows/run_fullmag.ps1`, lane env (1075–1084); `scripts/windows/run_fullmag_fem.ps1` deleguje do historycznie nazwanego `run_fullmag_wsl.ps1`, którego trasa używa Docker Desktop. Nie oznacza to uruchamiania WSL ani wspólnej obsługi index/thread controls |
| S12 | Build jobs: Cargo 8/16, native CMake często 2 | `FULLMAG_FEM_RUNTIME_CARGO_JOBS` w exporterze, `FULLMAG_NATIVE_BUILD_JOBS`/`CMAKE_BUILD_PARALLEL_LEVEL` w justfile, Cargo/CMake jobs w Compose. To liczba prac kompilacji, nie wątki solvera ani równoległe cases |
| S13 | NUMA jest tylko advisory w istniejącym helperze | `crates/fullmag-engine/src/hpc_runtime.rs` — `HpcRuntimeConfig`, `apply` (15–59). `apply` konfiguruje Rayon; nie jest dowodem affinity ani alokacji socketów |
| S14 | FEM pomocnik MPI używa serial wrapper | `backends/fem/cpu/mfem/runtime/mpi_init.hpp` (20–39): inicjalizacja FUNNELED i `MPI_COMM_SELF`. Nie dowodzi wdrożenia rozproszonego solve'a |

**Przykład rzeczywistej niespójności:** `FULLMAG_CPU_THREADS=12` i
`OMP_NUM_THREADS=8` mogą dać runner pool 12 i native FEM OpenMP 8. Auto ma
dodatkowo różne ograniczenia w runnerze i wrapperze. Dlatego jeden input
„CPU threads” w UI musi pokazywać requested, resolved i native effective;
nie może jedynie dopisywać kolejnej zmiennej środowiskowej.

## 2. Co już istnieje dla równoległych zadań

| ID | Istniejący element | Dowód i ograniczenie |
|---|---|---|
| S15 | Immutable study DAG | `crates/fullmag-authoring/src/study_contract.rs` — `StudyPlan`, `StudyStep`, `StudyExecutionProfileReference`; krok ma solver config, dyskretyzację, profil i porty/zależności |
| S16 | Niezależne źródła intentu | `crates/fullmag-plan/src/study_catalog.rs` — `StudyProblemCatalogEntry`; `crates/fullmag-plan/src/study_lowering.rs` — lowering kroku (224–267). Profil jest referencją przenoszoną obok immutable ProblemIR. Trzeba zdefiniować jego materializację, nie założyć, że już nadpisuje ProblemIR |
| S17 | Trwały RunSpec | `crates/fullmag-application/src/run_spec.rs` — `RunSpecification`, `RequestedExecution`, `RequestedResourceBudget`, `RunDependency`. Snapshot, catalog hash, parametry, seeds, priority, backend/device/precision/mode, minimum CPU/RAM/VRAM/storage |
| S18 | Istniejący scheduler i admission | `crates/fullmag-runtime-control/src/scheduler.rs` — dopasowanie resource kind do run-level device/minimum (129–137, 298–314). To punkt rozszerzenia placementu i concurrency, nie uzasadnienie nowej kolejki |
| S19 | Luka walidacji intentu | `crates/fullmag-runtime-control/src/study.rs` — `validate_requested_execution` (2784–2857): sprawdza explicit backend/mode/precision; explicit device ma szczególną kontrolę dla FEM eigen resolution. Potrzebna ogólna spójność device między RunSpec, profilem i każdym taskiem |
| S20 | Discovery ofert GPU po UUID | `crates/fullmag-api/src/resource_pool_main.rs` — `discover_local_resources`, `discover_nvidia_gpus` (118–246). NVIDIA UUID + free memory; oferty `<host>.gpu.<UUID>`. CPU/RAM/storage są dzielone równo między opcjonalną ofertę CPU i oferty GPU |
| S21 | Worker uruchamiany na przyznanym UUID | `crates/fullmag-api/src/accepted_study_supervisor.rs` — `spawn_worker` (739–779): `CUDA_VISIBLE_DEVICES=<lease UUID>`, `FULLMAG_FDM_GPU_INDEX=0`. Ordinal 0 po maskowaniu poprawnie oznacza wybraną fizyczną kartę |
| S22 | Niepełne oczyszczenie env i CPU enforcement | Ten sam `spawn_worker` ustawia FDM index, ale nie usuwa wszystkich FEM/generic overrides i nie wyprowadza limitu wątków CPU z lease. `crates/fullmag-api/src/accepted_study_worker.rs` (1070–1077) wpisuje device/precision; to nie dowód zastosowania wszystkich zasobów |
| S23 | Wyłączność lease w jednym store | `crates/fullmag-session/src/store.rs` — admission/commit zasobów (3285–3340, 3471–3513, 4010–4135). Wyłączność exact resource_id obejmuje runy i preparation/solve w tym store. Nie dowodzi fizycznej wyłączności między różnymi ID/store'ami |
| S24 | Istniejąca natywna usługa | `crates/fullmag-session/src/runtime_service.rs` — `RuntimeServiceConfig::for_application`; `crates/fullmag-api/src/runtime_service_main.rs` — publikacja pul i start schedulerów (240–390). Persisted APPLICATION.json jest reuse'owane, compute ma max-concurrency=1; preparation osobno 1 |
| S25 | Konfiguracja aplikacyjna puli | `crates/fullmag-runtime-control/src/local_resources.rs` — `application_service_config`, `LocalCpuCapacity::observe`. Odróżnić rzeczywiste discovery od zapisanej polityki; nie odświeżać trwałego budżetu z chwilowo wolnej pamięci przy każdym otwarciu UI |
| S26 | Wąski, sekwencyjny parameter macro | `crates/fullmag-cli/src/step_utils.rs` — materializacja `StudyMacroStageKind::ParameterSweep` (2698–2831). Ordered per-point stages dla ograniczonych parametrów; nie kolekcja niezależnie przyjętych RunIds |
| S27 | Wątki control-plane osobno | `crates/fullmag-cli/src/orchestrator.rs` — konfiguracja Rayon (6792–6832). Nie utożsamiać jej z native FEM OpenMP |

**Wniosek:** istnieje znaczna część trwałej orkiestracji i izolacji pojedynczego
GPU per worker. Brakuje pełnego produktu łączącego study intent, profiles,
topologię, fizyczny bilans CPU/RAM, politykę hosta, batch cases i UI.
Zwiększenie samego `max-concurrency` nie zamyka tych braków.

## 3. Istniejące punkty UI/API

| ID | Ścieżka + symbol | Znaczenie dla projektu |
|---|---|---|
| S28 | `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` — Global Study Settings; `StudyGlobalAuthoringModel.ts` — draft/patch requested fields | Backend/device/precision/mode/CPU threads są już edytowalne. Blank threads oznacza Auto; dodatnia liczba jest walidowana |
| S29 | `apps/control-room/src/modules/start/model/useComputeProbe.ts` — `useComputeProbe`; `computeTelemetry.ts` — `computeFromTelemetry`, `describeRuntimeLanes` | Wspólny odczyt telemetryczny rail/Settings; nie rezerwuje zasobów i nie zmienia study |
| S30 | `apps/control-room/src/modules/start/model/startSettings.ts` — `StartSettingsStore` | LocalStorage przechowuje domyślny widok list/grid; nie baza ustawień schedulera |
| S31 | `crates/fullmag-api/src/router_v2/handlers/platform/runtime_service.rs` — `get_runtime_service`; schema `RuntimeServiceStatusResource` | Read-only bounded stan ownera bez PID/tokenów/ścieżek. Nie istnieje tu edycja pool budget |
| S32 | `crates/fullmag-api/src/router_v2/mod.rs` — routes `/v2/persistence/projects/:project_id/runs`, `.../:run_id`, task cancellation | Przyjęcie i katalog trwałych runów: ten kontrakt należy rozszerzyć o batch/resource request |
| S33 | `apps/control-room/src/kernel/resources/runtimeExplorerResources.ts` — `usePlatformCapabilitiesResource`; `modules/explorer/builders/jobExplorerNodes.ts` | Miejsca rozszerzenia zasobów i widoku kolejki; nie nowe fetch w komponentach |
| S34 | ADR 0051 i `docs/specs/project-output-storage.md` | Równolegle przyjęta wspólna OutputStorage, defaults SQLite i platform resource. Compute ma ją referować, nie tworzyć drugich katalogów wyników/tmp |

## 4. Dokumenty istniejące przed projektem

- [ADR 0035](../../../adr/0035-typed-study-artifact-manifest-and-worker-boundary.md):
  typed outputs, immutable manifests, fencing przed terminalnym sukcesem.
- [ADR 0037](../../../adr/0037-accepted-preparation-resource-admission.md):
  odrębne preparation lease i solver lease, release po dowodzie exit.
- [ADR 0049](../../../adr/0049-native-runtime-owner-control.md) i
  [native-runtime-service-v1](../../../specs/native-runtime-service-v1.md):
  owner, resident schedulers, bootstrap gates, drain, discovery i config.
- Istniejący plan refaktoru runtime: P3-38/40/41/42/46/47 (accepted scheduler,
  pool, discovery, cursor, resident discovery/drain), P4-11/13 (preparation
  admission/fairness). Nowy plan rozszerza tych właścicieli.
- Dalsze bezpośrednie punkty reuse w `refactor_runtime/final/p3`:
  [43 — parallel supervision](../refactor_runtime/final/p3/43-parallel-resource-supervision.md),
  [45 — static pool](../refactor_runtime/final/p3/45-bounded-static-resource-pool.md),
  [50 — dynamic pool](../refactor_runtime/final/p3/50-dynamic-resource-pool.md),
  [51 — requirements](../refactor_runtime/final/p3/51-task-resource-requirements.md),
  [52 — discovery](../refactor_runtime/final/p3/52-local-resource-capacity-discovery.md),
  [55 — priority](../refactor_runtime/final/p3/55-priority-and-bounded-queue.md),
  [56 — backpressure](../refactor_runtime/final/p3/56-public-submit-backpressure.md),
  [58 — accepted FDM GPU](../refactor_runtime/final/p3/58-accepted-fdm-gpu-runtime.md).
  Ich obecność i dowody nie kwalifikują automatycznie FEM ani multiGPU.
- [FEM threading](../../../physics/0532-fem-demag-solver-policy-and-runtime-threading.md):
  requested/resolved/native effective, brak retuningu aktywnego solve'a.
- [Histereza](../../../physics/0930-hysteresis-sweep-semantics.md):
  kolejność i warm-start; ograniczenie równoległości jest naukowe.
- [Backend masterplan](../../../architecture/backend-golden-masterplan.md):
  cztery lane'y, native owners, fallback/provenance, osobne bramki dowodów.

## 5. COMSOL / CST — porównanie z dokumentacji producentów

Źródła sprawdzono 2026-10-04. Poniższe wzorce są inspiracją projektu UI
i orkiestracji, nie dowodem wsparcia tych możliwości przez Fullmag.

| Źródło | Udokumentowany wzorzec | Decyzja projektowa Fullmag |
|---|---|---|
| [COMSOL KB 1250](https://www.comsol.com/support/knowledgebase/1250) | Parametric, distributed parametric, batch i cluster sweep są odrębnymi sposobami organizacji przypadków. Batch używa niezależnych procesów | Rozróżniamy zależny sweep solvera, niezależne cases i distributed single solve; osobne wyniki/próby cases |
| [COMSOL 6.4 Batch / Job Configurations](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_solver.36.233.html) | Liczba jednoczesnych jobs oraz cores per job są osobnymi ustawieniami; model przyjętej pracy jest niezależny od późniejszej edycji desktopu | W UI dwa pola: resources per case i parallel cases; immutable snapshot po Submit, preview całego budżetu |
| [COMSOL 6.4 Windows commands](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_running.38.31.html) | `-np`, NUMA oraz `-gpuid` służą kontroli procesów i GPU; osobne procesy mogą dostać różne karty | Używamy typowanej konfiguracji i UUID allocation; interfejs nie każe użytkownikowi wpisywać flag |
| [CST hardware / distributed computing](https://www.3ds.com/support/hardware-and-software/simulia-systems-information/cst-studio-suite-opera-recommended-hardware) | Frontend, controller i solver servers mają różne role; niektóre solvery wspierają MPI | UI dołącza do ownera runtime; scheduler i numeryka zachowują własnych właścicieli i capability per workflow |
| [CST MPI Guide 2026, §1](https://updates.cst.com/downloads/MPI_Computing_Guide.pdf) | Distributed Computing przydziela niezależne zadania; MPI rozdziela zależne części jednej symulacji | Te tryby są osobne w modelu danych, formularzu i bramkach walidacji |
| [CST GPU Guide 2022, §9.8 i §9.13](https://updates.cst.com/downloads/GPU_Computing_Guide_2022.pdf) | Starszy oficjalny przewodnik opisuje wydzielenie GPU przez visibility mask/DC Solver Servers i jeden solve na kartę jako zalecany wzorzec | Domyślnie exclusive allocation na GPU. To historyczne źródło wzorca, nie bieżąca lista kart, sterowników ani licencji CST |
| [NVIDIA CUDA environment variables](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/environment-variables.html) | Maska widoczności zmienia enumerację CUDA; UUID może identyfikować urządzenie | Zachowujemy physical UUID oraz local ordinal osobno i sprawdzamy wykonanie po starcie |

Aktualny bezrocznikowy link GPU Guide ze strony CST zwrócił błąd pobrania;
dlatego nie przypisujemy przewodnikowi 2022 statusu aktualnego manuala GPU.
Nie kopiujemy ograniczeń licencyjnych ani kodu producentów do Fullmag.

## 6. Priorytety wynikające z audytu

1. Jeden resolver intentu: profile/ProblemIR/run request, wszystkie cztery
   pola backend/device/precision/mode dla każdego taska.
2. CPU allocation musi sterować rzeczywistymi pulami Rayon/OpenMP/Gmsh i
   affinity, z osobnym zakresem preparation oraz pomiarem native effective.
3. GPU UUID binding już istnieje; uzupełnić sanitization i per-backend receipt,
   nie usuwać poprawnego lokalnego ordinalu 0 po maskowaniu.
4. Rozszerzyć store-local exact-ID leases o wspólny bilans fizycznego hosta
   i jawny kontrakt wielu store'ów/kontenerów.
5. Dopiero potem rozszerzać concurrency w usłudze, batch expansion i UI.
6. MultiGPU pojedynczego solve'a ma własny planner/partition/collectives
   i kwalifikację; checkbox lub usunięcie walidatora `gpu_count > 1` nie wystarcza.
