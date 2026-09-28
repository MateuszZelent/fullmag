# Status realizacji całego planu refaktoryzacji

Data ostatniego przyrostu: 27.09.2026. Zintegrowany przyrost:
`master@bafd999e43f471a39062d8275f512e189aaa6d6b`; końcowe receipt'y przypinają
także hash treści sprzed commita. Receipt'y i starsze smoke'y zachowują własną
przypiętą tożsamość źródła.

Procenty poniżej opisują **zakres implementacyjny planu**, a nie gotowość
produkcyjną. Etap liczę jako wykonany tylko wtedy, gdy istnieje odpowiadający
mu kod lub kontrakt oraz adekwatny dowód. Zielony test jednego wycinka nie
zamyka całego etapu. Szacunek całości jest konserwatywnym przybliżeniem
ważonym liczbą pakietów roboczych z planu; nie jest metryką jakości ani
kwalifikacją wydania.

Najnowsze przyrosty P3-B dodają trwały intent admission przed projekcją
run catalog i resource lease oraz adapter claimu aplikacyjnego. Replay zachowuje
ten sam attempt/token, nie reaktywuje taska terminalnego ani starszego epochu,
a lokalne timestampy nie tworzą konfliktu ponowienia. Typed admission jest
objęty reachability/GC i eksportem/importem `.fms`. `just verify-session-persistence`:
**64 testy biblioteki, 9 archiwum i 13 storage PASS**, receipt
`828880b3fdac4cb0aa089fdd2e5f7f6e`; `just verify-api-project-runs`:
**4 PASS, 2 ignored**, receipt `2a9aa81834e1495f86c7d92de0ab01a6`; oba z
`source_changed_during_run=false`. Repo consistency i `git diff --check` PASS.
Kolejny przyrost dodał jawny API adapter allow-listy `RunResult` → typowane
payloady (`m_initial.json`, `m_final.json`, `total_energy`) oraz podłączył go w
accepted-run regresji przed publikacją do CAS i manifestu: **6 PASS, 2 ignored**,
receipt `b890b283aaeb4031a2f9e77f73404cbc`, `source_changed_during_run=false`.
Najnowszy przyrost dodaje `fullmag-api-accepted-supervisor`. Supervisor zajmuje
atomowy, pojedynczy slot w store, przechwytuje dokładny claim i lease, uruchamia
`fullmag-api-accepted-worker` jako proces potomny, obserwuje exit i zwalnia
lease wyłącznie po terminalnym `Succeeded`, completion barrier oraz trwale
zastosowanym `Start`. Pending effect zachowuje lease. Worker potrafi odzyskać
`pending Start` sprzed pierwszego side effectu lub z completed receipt/CAS bez
drugiego uruchomienia solvera. Binaria zostały dodane do instalacji CLI,
portable bundle i Windows MSI. `just verify-api-accepted-supervisor`: **4 PASS**,
receipt `bac92167c5cf4a7986b84c2287103873`; `just
verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt
`c4e405429dd2443e9689933d50a5061a`; `just check-api-accepted-worker`:
**PASS**, receipt `c7a4879dd6174b3d9c25f38f23309131`; wszystkie z
`source_changed_during_run=false`. Kolejny przyrost wymaga jawnego
`--worker-timeout-seconds`, odbiera stdout/stderr bez blokowania, kończy proces
po monotonicznym deadline, obowiązkowo czeka na potwierdzony exit i dopiero
potem uruchamia istniejącą rekoncyliację. `just verify-api-accepted-supervisor`:
**6 PASS**, receipt `c5ffb7ab7d474215b81bf6d40021e1b2`,
`source_changed_during_run=false`.
Zarządzana trasa `just verify-api-accepted-supervisor-e2e` buduje oba binaria i
uruchamia pełny accepted przepływ FDM CPU przez supervisor → worker → CAS/manifest →
terminalny barrier → potwierdzony exit → release dokładnego lease. Następny
przyrost dodaje supervisor-owned heartbeat aktywnego procesu, retry chwilowej
kontencji writera, publikację pod nowszą sekwencją tego samego właściciela,
zatrzymanie timera po terminalnym lifecycle i release ostatniej wersji lease:
**1/1 PASS**, receipt `9387e8bc595c47f7acc6d8ed9f257cd2`,
`source_changed_during_run=false`.
Poprzedni przyrost dodał same-space materializację magnetyzacji FDM, multilayer
i FEM H1 P1 — szczegóły w
[`p3/17-same-space-study-state.md`](p3/17-same-space-study-state.md).
Pełne process E2E anulowania ograniczonego FDM CPU potwierdza `Cancelled`,
release ostatniego lease, brak artefaktów sukcesu i trwały pending `Start`.
Osobna trasa potwierdza `Stop` po trwałym `Start`, lecz przed `Started`:
supervisor nie spawnuje workera, publikuje `Stopped`, zwalnia lease i kończy
task jako `Cancelled`.
Najnowszy przyrost dodaje limitowany automatyczny retry wyłącznie po
potwierdzonym wyjściu workera przed rezerwacją prywatnego katalogu attemptu.
Decyzja jest trwała i fenced, task wraca do `Queued`, a istniejąca rezerwacja
efektu nadal zachowuje lease i kończy fail-closed. E2E retry, sukcesu,
anulowania żywego procesu i anulowania przed spawnem przechodzą. Trwały,
fenced `worker_process_exit_receipt.v1` domyka także orphan window po
potwierdzonym exit i przed terminalnym eventem/decyzją: restart rekonstruuje
exact claim, zapisuje jedną decyzję, zwalnia lease i nie spawnuje workera.
Jawna pula RunId ma bounded round-robin, limit kolejnych pustych skanów i
process E2E dwóch runów. Store-discovery ponownie odczytuje trwałe intenty przy
każdym skanie. Opcjonalny `--pool-id` zapisuje sequence-fenced kursor fairness
i odtwarza następny RunId w kolejnym procesie. Resource-scoped sloty pozwalają
dwóm różnym CPU pracować równolegle pod globalnym bounded limitem; durable lease
nadal odrzuca drugi task na tym samym zasobie. Jeden scheduler przyjmuje też
statyczną listę typowanych ofert, centralnie wykonuje admission i równolegle
nadzoruje workery bez odłączania aktywnych nici przy błędzie. Jawny tryb
rezydentny utrzymuje store-discovery podczas pustych skanów i wykrywa run
utworzony po starcie procesu. `--max-tasks 0` jest dozwolone wyłącznie w tym
trybie, a sygnał systemowy zamyka admission i drenuje aktywne workery. Task z już
widocznym katalogiem, ale jeszcze bez preparation receiptu, jest ponownie
oceniany zamiast kończyć scheduler. Scheduler, supervisor i worker
ponawiają typowany `StoreWriterBusy` wyłącznie dla tej samej idempotentnej
publikacji; process E2E wymusza krótką kontencję natywnego locka. Trwały,
monotoniczny snapshot pozwala podmienić zasób A na B bez odebrania aktywnego
lease A. `run_spec.v2` wymaga teraz jawnego minimum CPU/RAM/VRAM/storage, a
scheduler odrzuca zbyt małą ofertę przed queue/claim/admission; minima są
widoczne w readbacku OpenAPI v2. Publikator puli wykrywa lokalne CPU, dostępny
RAM, wolne storage i wolny VRAM NVIDIA, wymaga jawnych rezerw i dzieli wspólną
pojemność bez podwójnego deklarowania jej ofertom CPU/GPU. Produkcyjny klient
CLI przyjmuje dokładny immutable accepted-run JSON, wykonuje publiczny Submit,
materializację i readback przez API v2, po czym procesowe E2E potwierdza
publikację puli, admission FDM CPU, wykonanie workera i zwolnienie dokładnego
lease. Legacy `run-json` nadal wymaga osobnego cutoveru. Immutable priority i
ograniczone okno kolejki mają process E2E. Atomowy limit publicznego Submitu
zachowuje replay przy pełnym backlogu, zwraca `429/run_backlog_full` przed
publikacją intentu i zwalnia pojemność po terminalnym katalogu. Durable
transport v3 wymaga teraz worker-originated `HeartbeatAck` i `Stopped`, a
`Completing` zamyka control plane przed `Completed`. Accepted worker wykonuje
także FDM GPU/double/strict: supervisor wiąże potomka z dokładnym UUID NVIDIA,
produkcyjny process E2E potwierdza `cuda_fdm`, brak fallbacku, publiczne
`succeeded` i zwolnienie dokładnego GPU lease. Nadal brakuje transportu
cross-host i kwalifikacji lane'ów FEM CPU/GPU. Scheduler wybiera
dependency-ready task dla jawnej oferty zasobu, publikuje durable
Prepare/Prepared/Start i wykonuje retry z kolejnym ownership epoch tylko na
podstawie jednej trwałej decyzji. Journal-first recovery domyka następnie oba okna po zapisie decyzji:
restart zwalnia zachowany lease i replayuje retry przed spawnem. P3 wynosi
**93%**, P5 około **87%**, a całość około **49%**. Szczegóły:
[`p3/18-durable-task-admission.md`](p3/18-durable-task-admission.md),
[`p3/19-runtime-control-admission-bridge.md`](p3/19-runtime-control-admission-bridge.md),
[`p3/26-durable-start-fdm-cpu-execution.md`](p3/26-durable-start-fdm-cpu-execution.md),
[`p3/27-durable-worker-execution-receipt.md`](p3/27-durable-worker-execution-receipt.md),
[`p3/28-one-shot-accepted-worker-process.md`](p3/28-one-shot-accepted-worker-process.md),
[`p3/29-accepted-worker-supervisor.md`](p3/29-accepted-worker-supervisor.md),
[`p3/30-supervisor-timeout.md`](p3/30-supervisor-timeout.md),
[`p3/31-supervisor-worker-e2e.md`](p3/31-supervisor-worker-e2e.md)
i [`p3/32-supervisor-process-heartbeat.md`](p3/32-supervisor-process-heartbeat.md)
[`p3/33-operator-task-cancellation.md`](p3/33-operator-task-cancellation.md)
[`p3/34-supervisor-cancel-e2e.md`](p3/34-supervisor-cancel-e2e.md)
[`p3/35-supervisor-prestart-cancel.md`](p3/35-supervisor-prestart-cancel.md)
[`p3/36-supervisor-automatic-retry.md`](p3/36-supervisor-automatic-retry.md)
[`p3/37-supervisor-retry-recovery.md`](p3/37-supervisor-retry-recovery.md),
[`p3/38-accepted-task-scheduler.md`](p3/38-accepted-task-scheduler.md) oraz
[`p3/39-supervisor-process-exit-receipt.md`](p3/39-supervisor-process-exit-receipt.md) oraz
[`p3/40-multi-run-scheduler-pool.md`](p3/40-multi-run-scheduler-pool.md) oraz
[`p3/41-scheduler-run-discovery.md`](p3/41-scheduler-run-discovery.md) oraz
[`p3/42-persistent-scheduler-cursor.md`](p3/42-persistent-scheduler-cursor.md) oraz
[`p3/43-parallel-resource-supervision.md`](p3/43-parallel-resource-supervision.md) oraz
[`p3/44-parallel-writer-contention.md`](p3/44-parallel-writer-contention.md) oraz
[`p3/45-bounded-static-resource-pool.md`](p3/45-bounded-static-resource-pool.md) oraz
[`p3/46-resident-scheduler-discovery.md`](p3/46-resident-scheduler-discovery.md) oraz
[`p3/47-resident-scheduler-drain.md`](p3/47-resident-scheduler-drain.md),
[`p3/48-solver-resource-budget-admission.md`](p3/48-solver-resource-budget-admission.md),
[`p3/49-writer-retry-jitter.md`](p3/49-writer-retry-jitter.md) i
[`p3/50-dynamic-resource-pool.md`](p3/50-dynamic-resource-pool.md) i
[`p3/51-task-resource-requirements.md`](p3/51-task-resource-requirements.md),
[`p3/52-local-resource-capacity-discovery.md`](p3/52-local-resource-capacity-discovery.md) i
[`p3/53-resource-discovery-process-e2e.md`](p3/53-resource-discovery-process-e2e.md) i
[`p3/54-cli-accepted-run-transport.md`](p3/54-cli-accepted-run-transport.md) i
[`p3/55-priority-and-bounded-queue.md`](p3/55-priority-and-bounded-queue.md) i
[`p3/56-public-submit-backpressure.md`](p3/56-public-submit-backpressure.md) i
[`p3/57-worker-control-ack.md`](p3/57-worker-control-ack.md) i
[`p3/58-accepted-fdm-gpu-runtime.md`](p3/58-accepted-fdm-gpu-runtime.md).

## Tabela zbiorcza

| Etap | Zakres planu | Postęp | Co jest zrealizowane | Co nadal blokuje zamknięcie |
|---|---|---:|---|---|
| **P0** | Baza, storage, identity, kontrakty i baseline | **85%** | Inventory P0-A: 304 operacje OpenAPI, 304 rozpoznane handlery, 0 unresolved; wcześniejsza minimalna bramka session/storage: 70 passed; najnowsza trasa po poprawce P0-C: 58 testów biblioteki + 19 integracyjnych PASS (0 doctestów), z receiptem przypiętym do dirty `master@93f11d…`; kontrakty ADR/capability i containment mają ograniczone regresje. | Pełna macierz P0-B/C/F, power-loss i profile innych systemów plików, bieżący baseline P0-E, runtime/API evidence oraz release gate. |
| **P1** | Projekt niezależny od solvera | **98%** | `fullmag-application`, repository `.fms`, lifecycle New/Open/Save/Close, bytes-only API, CLI/Python/desktop Open, browser project lifecycle, mounted-workspace reconnect, managed API/WS/active-run smoke, ikona chowania Inspektora. | Fizyczny smoke Tauri, pełna session-recovery, część runtime/release qualification. |
| **P2** | Authoring, Python i historia edycji | **59%** | P2-A: canonical bytes/digest, wersjonowany AST parametrów SI, `Problem.parameters`, flat/study facade, detekcja cykli, display metadata poza numerical hash i generated Python round-trip, niemutowalna projekcja `Problem.to_model_definition()` i read-only projekcja `SceneDocument` w Rust z wersjami `authoring_model.v1`, `component_definition.v1` i `physics_configuration.v1`, strict dekodery `from_ir()`/`from_value()` wire payloadu oraz source-level authoring float normalizer; wspólny fixture digestu przechodzi po stronie Python i Rust (12/12 Python, 104/104 Rust; receipt `5fd7f5da290345e6ad8ae3b0c26ef9cd`). P2-B: sekwencja cech geometrii, stable IDs/paths, CSG lineage, jawny transform, `resolved/ambiguous/empty`, selective invalidation oraz Python evaluator analityczny granic/CSG/affine. P2-C: izolowane konteksty Python, owner fencing i jawna materializacja. P2-D: revision-fenced semantic Undo/Redo przez `replace_scene`, wspólne menu/ribbon/shortcut, registry aktywnego formularza Inspectora dla Apply/Reset, wrapper historii dla staged session hooków oraz revision-fenced immediate mutations dla komend i paneli region/coupling, Physics Interaction, texture, absorbing boundary, antenna, material fields/parameters/assignment, biblioteki materiałów, przypisania presetowej magnetyzacji z partial ACK, spin/transport delete, spin interface delete, Spin Torque/Oersted Create/Replace, Current/Spin Transport Create/Replace, Spin Interface Create/Replace, planar monitors i Frozen Spins; nowe slice'y GeometryObjectPanel, ObjectGeneralPanel (identity/delete), `StudyInspectorPanel` oraz source-level przywracanie selection są zaimplementowane; regression suites dla workspace restore i Object General: **6/6 PASS**; focus pozostaje własnością layoutu. `RegionPatchRequest` ma jawny base-revision i 409. | Pełny canonical wire digest/lowering i browser/Rust round-trip poza zweryfikowanym wspólnym fixture; meshing producer/repair i selekcje po split/merge; provenance resolved/executed, study/run materialization, `fullmag-py-core`, równoległe capture/load; pozostałe wieloetapowe i bezpośrednie panele authoringu, testy browserowe Apply → Undo → Redo i stabilności focusu. |
| **P3** | Studies, RunSpec, durable Submit i katalog artefaktów | **93%** | `fullmag-authoring` ma wersjonowany `StudyPlan v2` z osobnymi referencjami model/solver/discretization/execution profile, typowane porty i źródła, walidację cykli, canonical digest, adapter primitive/macro/group, jawny per-step `until_seconds` dla TimeEvolution oraz zachowanie `Unsupported`; `fullmag-plan` ma `study_execution_plan.v2`, `study_problem_catalog.v1` i `lower_study_plan_with_catalog`, które wymagają dokładnego digestu planu, jednego zweryfikowanego immutable `ProblemIR` na każdy włączony krok, uruchamiają canonical planner/capability resolution i zachowują requested/resolved backend; `fullmag-application` ma immutable `RunSpecification`, jawne snapshot/study/dependencies/assets/requested execution, procesowy `RunIntentLedger`, typowane `TaskId`/`AttemptId`/`OwnershipEpoch`, fencing claimów, `ResolvedTaskInput.v2` z typowanym ref CAS/codec dla `StepOutput`, procesowy `ResourceLeaseRegistry`, `worker_protocol.v3` oraz `WorkerCoordinator` z outbox commandów, fenced event apply, terminal completion i explicit release; `fullmag-session` ma atomowy `FmsRunIntent`, monotoniczny `run_catalog.json`, restartowe `reconciling`, fenced `artifact_catalog.json` z CAS validation, `resource_lease.v1` z globalnym admission, heartbeat sequence i explicit release oraz fenced `apply_retry_decision`; źródłowy adapter koordynatora zapisuje watermark command/event do catalogu po każdym transitionie i recovery odrzuca journal krótszy niż watermark. Wersjonowane dekodery obsługują obecnie magnetyzację State FDM/FDM multilayer/FEM H1 P1 i scalar SI; publikacja dekoduje cały zestaw przed CAS, a completion i StepOutput dekodują dokładne bajty CAS. Resolver manifestu CAS, typowany payload v2, terminal barrier i immutable manifest freeze są skompilowane przez `just check-api-source` (**PASS**, receipt `7dc2d9e1051341728613ed0b69b6d536`); trzy nowe trasy regresyjne przechodzą: SessionStore freeze, fail-closed codec i accepted-run completion barrier (receipts: 11ff3056f4654fdfbe04d51129bb7c9b, c7561e2eeb2c4f7d8a3df54e8afb4292, 867f9153c9714377a8b3210be8806d77). Accepted runtime ma produkcyjne process E2E FDM CPU i FDM GPU; GPU jest związane z dokładnym UUID NVIDIA, kończy się `cuda_fdm` bez fallbacku i zwalnia dokładny lease. Szczegóły w [`p3/58-accepted-fdm-gpu-runtime.md`](p3/58-accepted-fdm-gpu-runtime.md). | Adapter archiwum, Submit/replay i idempotentna materializacja katalogu mają dowód testu routera HTTP 3/3 PASS (checkpoint `p3/04-http-submit-materialization.md`); równoległe Submit/materializacja oraz kontrolowany konflikt pisarza mają regresję HTTP PASS; restart procesu API z odczytem przed replayem i zachowaniem katalogu ma PASS (`p3/05-process-restart.md`); runner/CAS mają one-shot worker oraz resource-scoped supervisor z globalnym bounded limitem, obserwacją exit, jawnym timeoutem z potwierdzonym zakończeniem procesu, recovery pending Start, completion barrier i zwolnieniem dokładnego lease; zarządzane regresje obejmują spawn/wait/timeout, durable recovery, heartbeat procesu oraz pełne E2E sukcesu, automatycznego retry przed efektem, restartowego recovery decyzji, anulowania żywego procesu i anulowania przed spawnem dla FDM CPU/double/strict. Bounded scheduler jawnej puli RunId ma E2E dwóch runów, sukcesu i retry, a store-discovery odświeża listę trwałych intentów; `--pool-id` odtwarza sequence-fenced kursor fairness między procesami; statyczna pula typowanych ofert wykonuje centralny admission i równoległy nadzór wielu zasobów w jednym procesie; rezydentne discovery wykonuje run utworzony po starcie schedulera, a bezpieczny brak limitu tasków i drain kończą aktywne workery przed zwolnieniem lease; dynamiczna pula ma monotoniczne snapshoty i stabilne lease, a lokalne discovery wykrywa CPU/RAM/storage/VRAM z jawnymi rezerwami; procesowe E2E potwierdza publikację, admission, worker FDM CPU i release dokładnego lease; produkcyjny `fullmag submit-run-json` wykonuje publiczny Submit, materializację i readback immutable accepted runu przez API v2; immutable priority i bounded queue mają process E2E 5→2 z trzema runami chwilowo odsuniętymi, fairness klasy `0` i bez mutacji priorytetu `-10`; atomowy limit publicznego Submitu ma process E2E `200/429/201` bez publikacji odrzuconego intentu; lokalny heartbeat/Stop ACK ma process E2E; nadal brak transportu cross-host, process E2E FEM CPU/GPU i cutoveru legacy `run-json`; managed check writer-a runnera pozostaje `NOT VERIFIED` z powodu allow-list mismatch kolejki. |
| **P4** | Preparation, geometria/grid/mesh/space | **50%** | P4-A/P4-B mają `PreparationPlan`, pięć typowanych producerów, requested/resolved backend, FDM grid oraz jawne mesh/space identity; `PreparationCertificate` waliduje quality/marker/cell/space, a `PreparationReceipt` wymaga kompletu pięciu certyfikatów. Session store publikuje immutable receipt w `runs/<run_id>/preparation_receipt.json`; publiczny Live route wyprowadza `ProblemIR` i execution/display projection z fenced `SceneDocument`. Dodano source-level bezstanowy native FEM mesh/H1 P1 producer, ABI v1, niezależną walidację fingerprintów po stronie Rust, pięć certyfikatów FEM i osobną ścieżkę Live API. Control Room invaliduje Preparation po zmianie authoringu i udanej zmianie siatki; FEM Compute/Compute Fields/Compute Energies wymagają aktualnej sceny i shared-domain mesh, materializują receipt przed solver command, a startup overlay pokazuje accepted receipt identity/provenance. Korekta kontraktu OpenAPI ustawia `receipt_sha256` na maxLength 71 zgodnie z `sha256:<64 hex>`. SceneDocument fail-closed lowering zachowuje `table_autosave`, a API projekcja `SceneResource` zachowuje monitory i autosave; Python **58/58**, zarządzane API **5/5**, SceneResource **1/1**, adapter Rust **1/1**, OpenAPI/types/client/API hygiene/typecheck **PASS**; caller FEM preparation **89/89** oraz architektura/API hygiene **PASS**. | Nadal **NOT VERIFIED**: pełna golden parity wszystkich fizycznych pól, native C++/ABI i FEM mesh/space, automatyczny Live/browser runtime, kwalifikacja last-good, fizyka i release gate. `just runner-container-status` zgłosił brak odpowiedzi koordynatora, a dedykowany preflight zatrzymał się na istniejącym `.fullmag`, więc nie uruchomiono bramki FEM. Szczegóły source/API checkpointu są w [`p4/01-scene-document-to-problem-ir.md`](p4/01-scene-document-to-problem-ir.md) i [`p4/README.md`](p4/README.md). |
| **B** | Modularizacja backendu FDM/FEM/ABI/state/observables | **1%** | Pierwsza ekstrakcja Rust FDM CPU reference: energia i obserwable mają właścicieli `src/fdm/cpu/fields/energy.rs` oraz `fields/observables.rs`; dodano kontrakty source-layout dla wszystkich 16 przeniesionych metod. Nazwy, widoczność i ciała metod zachowano względem `HEAD` po normalizacji końców linii. | Testy kontraktu i build crate’u pozostają `NOT RUN`: runner nie odpowiada, a resolverowa trasa lokalna zatrzymała się na istniejącym zwykłym katalogu `.fullmag`, wymagającym osobnej inwentaryzacji migracji. Brak ekstrakcji natywnego FDM/FEM, dowodów czterech lane’ów, parity i kwalifikacji runtime/fizyki. |
| **P5** | Izolowany runtime, fencing, cancel/recovery, live steering | **87%** | Częściowa baza P5-B: `DurableWorkerInbox`, trwały pending/applied, resource-scoped sloty supervisora z globalnym limitem, spawn/wait procesu, wymagany jawny timeout, potwierdzone zakończenie potomka przed rekoncyliacją, reconciliation terminalnego ACK, worker-acknowledged durable heartbeat, completion fence, worker-originated Stop/Stopped, fenced operator Stop/Cancelled, anulowanie przed spawnem, limitowany automatyczny retry przed rezerwacją efektu, journal-first restart recovery decyzji, fenced process-exit receipt, orphan recovery sprzed decyzji, zwolnienie lease, bounded round-robin jawnej puli RunId, store-discovery, trwały kursor fairness między procesami, rezydentne wykrywanie późnego runu, bezpieczny brak limitu tasków, graceful drain z dołączeniem aktywnych workerów, statyczną oraz dynamiczną pulę typowanych ofert z centralnym admission, stabilnym resource_id i gwarantowanym joinem aktywnych nadzorców, bounded retry typowanego `StoreWriterBusy`, atomowy limit nieterminalnego backlogu publicznego Submitu, minima runu oraz lokalne fail-closed discovery CPU/RAM/storage/VRAM z jawnymi rezerwami i niepokrywającym się podziałem wspólnej pojemności; managed process E2E publikuje pulę, a produkcyjny klient CLI wykonuje accepted-run Submit/materializację/readback przed priority-ordered bounded admission, workerem FDM CPU oraz FDM GPU związanym z dokładnym UUID NVIDIA, bez fallbacku i ze zwolnieniem dokładnego lease. Pełny runtime pozostaje niezakwalifikowany. | `fullmag-cli RunJson` nadal omija accepted RunSpec i wywołuje solver bezpośrednio; brakuje cutoveru legacy `run-json`, transportu cross-host, process E2E FEM CPU/GPU i steering qualification. |
| **P6** | Trwałe wyniki, quantities, datasets i frontend analityczny | **0%** | Docelowe manifesty, dataset identity i wymagania Control Room są opisane. | Brak migracji artifact keys, evaluator/codec, bounded I/O i pełnej kwalifikacji wyników/viewportu. |
| **P7** | Studies złożone, wiele projektów i targety | **0%** | Zależności, case mapping i target contracts są zaplanowane. | Brak study compiler, wieloprojektowego runtime, target adapters i raportów reprodukowalnych. |
| **P8** | Cutover, dystrybucja, macierz CAE i wydanie | **2%** | Cutover, rollback, packaging i release gates są zdefiniowane; usunięto jawnie zaakceptowaną archiwalną kopię `_to_delete_legacy_web` (981 śledzonych plików), gdy aktywne skrypty root wskazują Control Room. | Brak usunięcia legacy writers backendu, pełnej kwalifikacji klientów/cutover, managed build/package, pełnej macierzy CAE, review/CI/merge i release qualification. |

Aktualizacja P4-C z 28.09.2026: Control Room ma jawne `Build Grid` dla FDM w
ribbonie i Explorerze. Obie powierzchnie wywołują `grid.build-fdm`, wymagają
kanonicznej rewizji sceny i wysyłają `fdm_grid_refresh` z revision fence.
Browser smoke potwierdził payload, granicę FDM/FEM, brak 404 i błędów konsoli
oraz zdrowy WebGL (`703×478`, `contextLost=false`). Przyrost realizuje część
P4-C, ale nie zamyka pełnego Operations/Problems ani bramki native/managed;
wskaźniki pozostają **P4 50%** i około **49%** dla całego planu. Szczegóły:
[`p4/17-explicit-fdm-build-grid.md`](p4/17-explicit-fdm-build-grid.md).

Aktualizacja P4-C z 28.09.2026: dolny panel ma wspólne Operations i Problems.
Operations projektuje kolejkę komend, preparation i Mesh Jobs, a Problems
diagnostykę geometrii, failure preparacji, błąd kandydata meshu z last-good
identity oraz nieudane komendy. Stare zapisane `mesh` migruje do `operations`;
nie dodano nowego store’a. Browser smoke potwierdził automatyczne otwarcie
Operations po Build Grid, zakończoną komendę, problem z rewizją 12, brak
404/błędów konsoli i zdrowy WebGL. Trwały journal komend Live opisuje następny
checkpoint; wspólna projekcja zdarzeń preparation/mesh oraz managed/native gate
pozostają otwarte, dlatego wskaźniki nadal
wynoszą **P4 50%** i około **49%** dla całego planu. Szczegóły:
[`p4/18-operations-problems-projection.md`](p4/18-operations-problems-projection.md).

Aktualizacja P4-C/P5-D z 28.09.2026: `simulation/commands` ma trwały, bounded i
sesyjnie odgrodzony journal w istniejącym `SessionStore`. Submit, reject,
dispatch, failure i rekoncyliacja publikują snapshot przed zmianą projekcji w
pamięci. Restart zachowuje terminalne wpisy, a operacje bez terminalnego ACK
oznacza jako przerwane bez automatycznego replayu. Rewizja zasobu jest teraz
monotoniczną rewizją journalu, więc sama zmiana statusu invaliduje Operations.
Produkcyjny `cargo check` API/session: **PASS**; regresje source dodano, lecz nie
uruchomiono zgodnie z aktywnym zakazem testów jednostkowych. Managed restart,
native FEM i wspólna projekcja zdarzeń preparation/mesh pozostają otwarte.
Wskaźniki: **P4 50%**, cały plan około **49%**. Szczegóły:
[`p4/19-live-command-journal.md`](p4/19-live-command-journal.md).

Uwaga do wiersza P3-B: trwałe wpisy `retry_decision.v1` oraz ich
[`coordinator_journal.v1`](p3/03-coordinator-journal.md) są już source-level PASS (`SessionStore` zapewnia
replay, claim/epoch fencing, contiguous command/event sequence, terminal
fencing, reachability i `.fms`). `SessionStore::apply_retry_decision` stosuje
`Retry` do durable snapshotu idempotentnie i blokuje przejście przy aktywnym
lease. Otwarty pozostaje rzeczywisty transport coordinatora, automatyczna
polityka retry oraz dowód zatrzymania procesu; dlatego nie jest to jeszcze
runtime proof.
Granica P3 worker `ResolvedTaskInput::validate()` sprawdza teraz także
zdeserializowane run/task/attempt IDs oraz dodatni ownership epoch, których
konstruktory można ominąć przez serde. Regresja jest zapisana, lecz `NOT RUN`;
parser Rust i diff check **PASS**. Nie dowodzi to adaptera resolvera ani
rzeczywistego transportu workera, więc procent P3 pozostaje bez zmian.

Przyrost P3/P5-B z 25.09 dodaje `FmsCoordinatorWatermark`, projekcję lifecycle,
observation i sequence po trwałym zapisie transitionu oraz high-water fence w
recovery. Dodatkowo `FmsCoordinatorGenesis` wiąże zerowy typed checkpoint z
claimem i aktywnym lease; adapter accepted `Prepare` publikuje go przed outboxem.
Pusty journal można odzyskać wyłącznie z takim genesisem i watermarkiem `(0,0)`;
legacy task bez genesis oraz strumień z dodatnim watermarkiem pozostają fail-closed.
`SessionStore::commit_run_catalog` nie pozwala cofnąć/wyczyścić
watermarku w tym samym epoch, zastąpić attemptu bez podniesienia epoch ani
usunąć taska z watermarkiem; retry może wyczyścić stary attempt, zachowując
watermark. Regresja obejmuje komendę, event, replay, uszkodzenie suffixu,
cofnięcie watermarku, zmianę attemptu i wyższy epoch. Status implementacji i
walidacji: [p3/11-coordinator-watermark.md](p3/11-coordinator-watermark.md).
Testy i kompilacja **NOT RUN** z powodu niedostępnego managed runnera; P3
pozostaje **49%**, P5 **0%**, całość około **27%**.

Przyrost P3-B z 25.09 dodaje dispatch-time walidację deklarowanych i wymaganych
portów oraz automatyczne wyprowadzenie wejść `StepOutput` z durable lineage
bieżącego, udanego attemptu. Store zachowuje immutable artefakty poprzednich
attemptów, ale odrzuca nowe wpisy bez aktualnego owner fence; study output
wymaga `Succeeded`. Regresje helpera i store są zapisane, lecz **NOT RUN**;
producent lineage i rzeczywisty runtime pozostają otwarte. Szczegóły:
[p3/12-study-dependency-dispatch.md](p3/12-study-dependency-dispatch.md).
Procenty bez zmian.

Aktualna próba ponowienia `pnpm --dir apps/control-room smoke:inspector` na
dev-serverze `http://localhost:3104/workspace` zatrzymała się przed testem,
ponieważ środowisko nie udostępnia modułu Playwright. To jest
`NOT VERIFIED`, a nie `PASS`; ręczna kontrola browserowa CUA potwierdziła
jedynie cykl `Hide Inspector` → `Panel/Inspector = 0` → `Inspector = 1`.

P3a-A i przyrosty P3a-B mają osobny opis w [`p3a/README.md`](p3a/README.md): trzy endpointy sceny,
enqueue komendy obliczeniowej, binarny odczyt FMRM, listę/pobranie/capture/restore checkpointu
oraz politykę events korzystają już z context-bound adaptera i odrzucają
zmieniony epoch po await.

## Wynik globalny

Rewalidacja P3a 22.09.2026 ujawniła brak wspólnego warunku transportu.
Dodano `x-fullmag-session-scope` z `sessionScopeKey`, sprawdzany przez serwer
przy przechwytywaniu kontekstu. Backendowe `SOURCE PASS` oznacza kontekst przypięty
w handlerze; nie dowodzi, że wieloetapowa operacja klienta trafi do sesji,
z której została rozpoczęta. Tekstowy epoch w statusie i wewnętrzny
licznik transition mają różną semantykę. Przyrost z 23.09 dodaje osobny
`request_scope_epoch` dla kolizji session_id/timestamp; kod i kontrakt są
zapisane, lecz backendowy build, realtime i browser nadal nie są potwierdzone.
Przyrost WebSocketu z 23.09 przypina połączenie do `request_scope_epoch`,
podaje je w `hello` i zamyka stary strumień po transition; klient odrzuca
niezgodny handshake. Typecheck, celowany lint, API/architecture hygiene,
składnia Rust i AsyncAPI przeszły po zapewnieniu odczytu zależności
frontendowych. Testy jednostkowe są `NOT RUN`; backend build, browserowe
A→B→A i pełny runtime realtime pozostają `NOT VERIFIED`.
Komendy eksportu/importu `.fms` przekazują teraz scope do API i kontrolują
spóźniony wybór pliku oraz odpowiedź eksportu; dialog inspekcji czyści stary
plik przy zmianie sesji. Frontend typecheck, celowany lint i API hygiene
przeszły. Regresje i browserowe A→B podczas importu są `NOT VERIFIED`, więc
licznik P3a i procent całości pozostają bez zmian.
Checkpointy i Save/Load Field State przekazują teraz scope we wszystkich
żądaniach swoich sekwencji; klient odrzuca spóźnione odpowiedzi przed
następnym żądaniem i invalidacją. Typecheck i celowany lint przeszły,
natomiast regresje jednostkowe, managed API i browserowy wyścig A→B są
`NOT VERIFIED`. [Szczegóły](p3a/07-request-scope-transport.md).
Szacunek P3a pozostaje roboczy; aktualny licznik 276/15/13 nie zastępuje weryfikacji.

Przyrost P3 z 23.09: trwała lista zaakceptowanych runów projektu (GET /v2/persistence/projects/{project_id}/runs) ma paginację cursor/limit, filtrację po projekcie, typowaną fasadę Control Room i sekcję w Study dla otwartego projektu oraz rozwijany szczegół runu z catalog revision, lifecycle i readiness tasków. Payloady Submit mają w OpenAPI object-root i generują `Record<string, unknown>`; managed source check, OpenAPI/type generation, frontend typecheck, scoped ESLint zmienionych plików, API hygiene, architecture hygiene i consistency checker: PASS. Pełny lint nadal ma otwarte błędy w szerszym checkoutcie. Test paginacji zapisany, lecz NOT RUN. HTTP po restarcie i browser smoke pozostają NOT VERIFIED; procenty etapów nie zmieniają się na podstawie samego source-level przyrostu.
Poprawiono blokadę importu assetów przed zapisem pliku; kontrola kompilacji
API przeszła, dwie nowe regresje Rust pozostają nieuruchomione.

**Około 49% zakresu implementacyjnego planu** jest zrealizowane w
zweryfikowanych przyrostach. Największa część pozostałej pracy to P3a,
przygotowanie, modularizacja backendów, lane'y FEM CPU/GPU, wyniki, analityka,
cutover i kwalifikacja wydania. Procent opisuje wykonanie planu, a nie gotowość
produktu do wydania.

## Dowody bieżącego checkpointu

| Przyrost | Dowód | Wynik |
|---|---|---|
| P3a oczekiwana sesja w HTTP i unieważnianie historii | `p3a/07-request-scope-transport.md`, middleware `session_scope`, `ControlRoomApi`, loadery zasobów i `AuthoringHistoryController` | Kontrola API **PASS**; generator JSON, typów i klienta **PASS** po odseparowaniu binarnego generatora od działającego API; kontrakt: **300 operacji / 285 deklaracji scope**. Końcowy frontend typecheck, API hygiene, consistency i celowany diff check **PASS**. Review poprawił brak scope w pomocniczym `meshIsStale`. Regresje parsera, stale mutation, importu, transportu i historii zapisane, **NOT RUN** z powodu aktualnego zakazu kompilacji testów jednostkowych. Browser/managed runtime i rozróżnienie identycznego session_id/timestamp po reopen nadal otwarte. |
| P2-A canonical bytes | `p2/02-canonical-ir.md` | PASS; stabilne bajty i digest ProblemIR. |
| P2-A parameter AST | `packages/fullmag-py/tests/test_parameter_ast.py` | **7 passed**; SI normalization, ProblemIR lowering, flat/study facade, generated-script round-trip, dimension/cycle diagnostics i display metadata. |
| P2-A Model/Component/PhysicsConfiguration | `final/p2/06-model-component-physics.md`, `model/authoring.py`, `Problem.to_model_definition()`, `authoring_model.rs` | **12 passed** projekcji + **33 passed** połączonej bramki AST/ProblemIR/scene; read-only nested payload, stabilne ID, display names/units poza Python numerical identity, strict `from_ir()` Python i `ModelDefinition::from_value()` Rust. Python zweryfikował golden fixture wspólny z Rust; test Rust tego digestu **NOT RUN**, a GUI/Python/Rust round-trip nadal otwarty. Poprzedni `cargo check --locked -p fullmag-authoring --lib` **PASS**. |
| P2-D Physics Interaction history | `PhysicsInteractionPanel.tsx`, `PhysicsInteractionPanel.dom.test.tsx`, `PhysicsInteractionPanelModel.test.ts` | **16 passed**; object/study writes używają captured base revision i wspólnej historii. |
| P2-D Spin/Oersted/Transport history | `SpinAuthoringInspector.tsx`, `TransportAuthoringInspector.tsx`, odpowiadające testy | **26 passed**; Create/Replace używają captured base revision i wspólnej historii. |
| P2-D Spin Interface history | `SpinInterfaceInspector.tsx`, `SpinInterfaceInspector.test.tsx` | **5 passed**; Create/Replace używa captured base revision właścicielskiego transportu. |
| P2-D magnetization/material history | `kernel/authoring/magnetization-texture/commands.ts`, `kernel/layout/MaterialLibraryDialog.tsx`, `ControlRoomApi.ts`, `RegionPatchRequest` | **5 passed**, typecheck + targeted ESLint **PASS**; dwa kroki preset assignment są revision-fenced, Save/Delete biblioteki materiałów korzysta z historii, region patch ma 409 dla konfliktu rewizji. |
| P2-A regresje Python | `test_problem_ir.py` + `test_execution_context.py` | **16 passed**. |
| P2-B geometry | `p2/03-geometry-feature-sequence.md`, `cargo check --locked -p fullmag-authoring --lib` | PASS kompilacji biblioteki; testy Rust geometrii pozostają nieuruchomione w tym checkpointcie. |
| P2-B Python geometry evaluator | `test_selection_geometry.py`, `test_selection_contract.py` | **75 passed**; zgodność granic/CSG/affine z kontraktem analitycznym, imported solid fail-closed. |
| P2-C context | `p2/01-context-isolation.md` | 6 testów izolacji/fencingu plus istniejące regresje API/script/mesh. |
| P3-A typed study contract + migration + catalog | `p3/01-study-contract.md`, `crates/fullmag-authoring/src/study_contract.rs`, `crates/fullmag-plan/src/study_catalog.rs` | `cargo check --locked -p fullmag-authoring --lib` oraz `cargo check --locked -p fullmag-plan --lib` **PASS**; `StudyPlan`, typed ports/sources, separate references, cycle/type validation, canonical digest, explicit legacy adapter, `Unsupported` preservation, immutable `study_problem_catalog.v1` i fail-closed `lower_study_plan_with_catalog` są zapisane. Celowany `cargo test --locked -p fullmag-plan study_catalog --lib`: **2 passed**; pozostałe testy lowering/kontraktu pozostają do uruchomienia. |
| P3-B RunSpecification + accepted intent + resolved input + catalogs + durable lease + protocol identity | `p3/README.md`, `p3/02-worker-protocol.md`, `crates/fullmag-application/src/run_spec.rs`, `execution.rs`, `coordinator.rs`, `crates/fullmag-session/src/types.rs`, `store.rs`, `reachability.rs`, `fms.rs` | `cargo check --locked -p fullmag-application --lib`, `cargo check --locked -p fullmag-plan --lib`, `cargo check --locked -p fullmag-session --lib` i `cargo check --locked -p fullmag-api` **PASS**; snapshot/study/dependency/assets, durable `run_intent.json`, monotoniczny `run_catalog.json`, restartowe `reconciling`, fenced `artifact_catalog.json`, Task/Attempt/Ownership fencing, `ResolvedTaskInput`, process registry, durable `resource_lease.v1`, `worker_protocol.v2` z identity/sequence/dedup/conflict/terminal fencing, `WorkerCoordinator` z explicit release po terminal event, `study_execution_plan.v2` + immutable `study_problem_catalog.v1` z fail-closed `Unsupported` i `SessionStore::apply_retry_decision` z idempotentnym `failed|interrupted -> queued` są typowane i walidowane źródłowo. Celowane testy: coordinator **2 passed**, retry/session **2 passed**; pełna macierz Rust nadal pozostaje do uruchomienia. Pełny resolver application/klienta oraz materializacja runu, rzeczywisty transport/supervisor, dowód zatrzymania starego workera/zwolnienia VRAM, adapter starego wykonawcy i pełna publication pozostają `NOT VERIFIED`. |
| P3-B adapter trwałego RunIntent — bieżący przyrost | `crates/fullmag-api/src/run_intent_persistence.rs`, `fullmag-application/src/run_spec.rs`, `fullmag-session/src/types.rs`, `store.rs`, `reachability.rs`, `p3/README.md` | RunSpec wiąże exact bytes definicji projektu, canonical SHA-256 `StudyPlan` i katalogu per-step `ProblemIR` oraz bajty wszystkich immutable assets; obiekty są zapisywane w CAS przed accepted intent i śledzone przez reachability/.fms. Wewnętrzny `commit_archived_run_intent` czyta dokładne bajty `.fms` przez kanoniczny adapter projektu i wymaga jawnej mapy asset ID → ścieżka; publiczny `POST /v2/persistence/projects/{project_id}/runs` przyjmuje te wejścia oraz typowany RunIntent/study/catalog i zwraca `pending_materialization`; nowy intent trafia wyłącznie do `FULLMAG_RUNS_ROOT/session-store` po walidacji zarządzanego storage, bez zapisu w legacy `.fullmag`. Replay odczytuje oryginalny rekord po restarcie. Zarządzany `just check-api-source` **PASS** (receipt `0de7fc89a2f241c1aaa0b0577cc5811f`, `source_changed_during_run=false`); testy HTTP zapisane lecz **NOT RUN**; worker i rzeczywisty run: **NOT VERIFIED**. `run_intent`, `study_plan` i katalog mają object-root w OpenAPI i `Record<string, unknown>` w typach TypeScript; szczegółowy schemat zagnieżdżonego `ProblemIR` pozostaje otwarty. Bieżący `just generate-api-openapi` PASS (receipt `85721129616549b6b1c5ca4f7dd03fcc`) oraz frontend typecheck i API hygiene **PASS**. |
| P3-B trwała lista i szczegóły runu w Control Room | `ProjectRunsSection.tsx`, `projectRunResources.ts`, `StudyInspectorPanel.tsx`, `ControlRoomApi.persistence.projects.listRuns/getRun`, `p3/README.md` | Sekcja Study odczytuje paginowaną listę runów bieżącego projektu; wybór runu pobiera trwały read model i pokazuje stan katalogu oraz lifecycle/readiness tasków. Zasoby są kluczowane przez `ProjectId`/`RunId`, a zmiana projektu remountuje lokalny selection. Typecheck, API hygiene, architecture hygiene, consistency i diff check **PASS**. Testy HTTP paginacji są zapisane, lecz **NOT RUN**; browser/restart **NOT VERIFIED**. Nie dowodzi to jeszcze worker execution ani publikacji outputów. |
| P3a-A immutable request context | `p3a/README.md`, `p3a/06-endpoint-owner-policy.md`, `scripts/audit_refactor_p3a.py`, `fullmag-api/src/main.rs`, `types.rs`, model/simulation/data/persistence/platform handlers, `router_v2/tests.rs` | Pięć rodzin przepływu ma context capture, rewalidację po await i epoch fencing; checkpoint capture/restore, field-state export/inspect/import, session export/commit oraz recovery list/clear mają fence przed synchronicznym I/O/publikacją; import czyści sesyjne replay/queue i zwiększa epoch przy podmianie; rodziny `current-transports`, `field-drives`, `couplings`, `spin-torques`, `oersted-fields`, `spin-transports`, `spin-interfaces`, `planar-monitors`, Frozen Spins CRUD/preview/activation, physics graph, material-field data, model readiness, authoring material fields, materials i magnetization assets, geometria, object/region CRUD, object interactions, `study`, `universe`, FMRM scoped, mesh-region-membership, `data/fields` catalog/availability/meta oraz wszystkie planar field endpoints oraz simulation preparation/run/stage read-models oraz solver status/energy, object metrics oraz command-detail oraz command-failure read/write paths mają transition-fenced context validation i publikację; dwanaście legacy odczytów data-plane ma wrapper context fence przed i po obliczeniu; polityki meshingu obiektu i universe oraz authoring script/sync mają dodatkowo context-aware load/commit i scoped typed callers; trzydzieści trzy proste odczyty meshingu oraz dwa odczyty diagnostyczne korzystają ze wspólnego current-snapshot fence; macierz obejmuje 304 operacje: 276 `SOURCE PASS`, 15 `OPEN`, 13 `GLOBAL`; `cargo check --locked -p fullmag-api` **PASS**, consistency checker **PASS**, źródłowe regresje sceny/compute/binary/checkpoint/field-state/session/persistence/events zapisane, lecz testy API pozostają nieuruchomione w tym checkpointcie. Browser/runtime i migracja operacji `OPEN` pozostają `NOT VERIFIED`. |
| P3a-B frontendowy slice data/cache/decode | `p3a/02-client-resource-context.md`, `sessionResourceIdentity.ts`, `ResourceRuntimeStore.ts`, `ControlRoomApi.ts`, `dataPreviewResources.ts`, `planarFieldResources.ts`, `modeFieldOverlayResources.ts`, `modeCompositionFieldLayerResources.ts`, `studyRuntimeResources.ts`, `ModeCompositionFieldLayerController.ts`, `ResourceInvalidationController.ts`, `binaryDecodeScheduler.ts` | Klucze cache/decode dla preview field-vector, planar field i metadata modalnych są sesyjnie opakowane; `ResourceRuntimeStore` przekazuje `sessionScopeKey` do fasady, a długie materialization/freshness requests nie są współdzielone między sesjami; zmiana scope czyści modalne bufory; prefix invalidation rozpoznaje suffix kanonicznej ścieżki za `session=...&epoch=...|`; scheduler sprawdza abort przed/po workerze. `pnpm --dir apps/control-room typecheck` **PASS**, `check:api-hygiene` **PASS**, wcześniejsze 91 testów resource hooks oraz 21 testów kontrolera/tożsamości **PASS**. Nowa regresja abort/scope i pełny browser/runtime pozostają **NOT VERIFIED**. |
| P3a-B model/runtime/workspace + meshing hooks | `p3a/03-client-resource-context-model-runtime.md`, `useSessionScopedResourceKey.ts`, `geometryLifecycleResources.ts`, `studyRuntimeResources.ts`, `communicationPolicyResource.ts`, `planarMonitorResources.ts`, `useVisualizationStateResource.ts`, `useVisualizationClientAcksResource.ts`, `ResourceInvalidationController.ts` | Wspólny wrapper wiąże model/geometrię, komendy, run/stage, checkpointy, politykę events, visualization, planar monitors i statusowe zasoby meshingu z `session_id + epoch`; exact invalidation kanonicznej ścieżki budzi aktywny scoped key, a prefix nadal obsługuje przyszłe subskrypcje. Typecheck, API hygiene, consistency i diff check **PASS**. Nowe testy źródłowe pozostają do uruchomienia w tym checkpointcie. Browser/runtime pozostaje `NOT VERIFIED`. |
| P3a-B membership/data/analysis/diagnostics | `p3a/04-client-resource-context-data-analysis.md`, `p3a/05-endpoint-coverage.md`, `geometryLifecycleResources.ts`, `crossSectionResources.ts`, `analysisResultResources.ts`, `spinAuthoringResources.ts`, `spinWaveResources.ts`, `frozenSpinsResources.ts`, `useSimulationPreparation.ts`, `studyRuntimeResources.ts`, `runtimeExplorerResources.ts`, `modeCompositionResources.ts`, `ModeCompositionController.ts` | Sesyjnie opakowano membership/domain metadata i binary decode, cross-section, field availability/drives, physics graph, artifacts, field/quantity/scalar/table data, analysis-result, analysis runtime, diagnostics/runtime explorer, spin-wave, Frozen Spins, preparation, spin authoring oraz mode-composition. Cache FMRM/multilayer/cross-section używa scoped keys; mode-composition odrzuca stary payload i pending PATCH po zmianie scope. Typecheck, API hygiene, consistency i diff check **PASS**; nowe testy są zapisane, lecz **NOT RUN**. Browser/managed runtime oraz recovery persistence write fencing pozostają **NOT VERIFIED**. |
| P2-D semantic history | `p2/05-semantic-history.md`, `AuthoringHistoryController.test.ts`, `authoringHistoryWorkspaceRestore.test.ts`, `objectGeneralMutation.test.ts`, `PendingFormRegistry.test.ts`, `InspectorHistoryBridge.test.ts`, `authoringHistoryMutation.test.ts`, `regionCommandContributions.test.ts`, `fieldMapCommands.test.ts`, testy Planar Monitor/Frozen Spins/Spin/Transport/Spin Interface i magnetization texture | **3 + 4 + 4 + 5 + 5 + 5 passed** w podstawowych kontrolerach; revision-fenced Undo/Redo przez `replace_scene`, rejestr aktywnego formularza, wrapper staged sesji oraz wspólny helper odczytu przed/po z base-revision dla immediate mutations. **238/238 testów** bieżącej 18-plikowej macierzy bazowej plus **26/26** testów Spin/Transport, **5/5** Spin Interface i **5/5** magnetization texture, 40 testów komend geometrii, 35 testów menu/skrótów i 28 testów bazowej bramki Inspectora. Suite'y helpera historii, komend Study/Run i presetowej magnetyzacji: **101/101**; ukierunkowane suite'y geometrii, Study Inspector, workspace restore i Object General: **106/106**; celowany ESLint i architecture hygiene **PASS**. Browser gate **NOT VERIFIED**; typecheck i pozostałe direct handlers są otwarte. |
| P1 UI | `pnpm --dir apps/control-room smoke:inspector` | Exit 0; hide/restore przez wspólną komendę layoutu. |
| Spójność dokumentacji | `python scripts/check_repo_consistency.py`, checker linków, `git diff --check` | PASS; ostrzeżenia diff dotyczą normalizacji LF/CRLF. |

Checkpoint P4: postęp etapu pozostaje **50%**. Publiczny Live materialization
route jest teraz powiązany z tym samym fenced use case'em co adapter wewnętrzny;
request przyjmuje tylko `preparation_id` i `scene_revision`. Zarządzana trasa
`just verify-api-preparation` wykonała **5 testów**, w tym pozytywną publikację
receipt przez router HTTP, przy `source_changed_during_run=false` i Pythonie
3.12.2. Receipt:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/dbc3ab0c918e4b76a08a441c76496331/receipt.json`.
Generacja OpenAPI, typów/klienta Control Room, typecheck oraz ukierunkowane
testy UI **PASS** (222/222 i 2/2). Browser, pełny Live runtime, automatyczny
producer pipeline, FEM mesh/space i walidacja fizyczna pozostają
`NOT VERIFIED`.

W następnym wycinku P4 dodałem ochronę ostatniego poprawnego meshu podczas
trwającej i nieudanej próby: podsumowanie oraz efektywne cele są zachowane,
a błąd trafia do osobnego `last_build_attempt`, używanego także przez projekcję
nieudanego etapu Preparation. Udany build jawnie zastępuje cele, w tym `null`,
aby nie odziedziczyć nieaktualnych metadanych poprzedniego meshu. Regresje są
zapisane, lecz **NOT RUN**. Direct
`windows-test-fem` jest blokowany przez politykę hosta wymagającą build runnera,
a `just runner-container-status` nie uzyskał odpowiedzi koordynatora; nie
uruchamiałem testu poza kolejką. Browser proof także pozostaje `NOT VERIFIED`:
`just control-room` zatrzymał się przed uruchomieniem na ochronie storage,
`Existing real path requires inventoried migration` dla `.fullmag`; nie
zmieniałem tej ścieżki ani jej mountów.

Pythonowy adapter `SceneDocument → ProblemIR` ma teraz fail-closed regułę dla
owner rotation/scale, zgodną z istniejącym Rustowym lowering. Test
`test_scene_document_problem_ir.py`: **3 passed**. Jest to source-level regresja;
nie zamyka golden parity wszystkich fizycznych pól ani UI/runtime proof.

Kolejna regresja wykazała, że magnetyzacja `sampled_field` w SceneDocument
była pomijana przez renderer i zastępowana stanem domyślnym. Renderer zachowuje
teraz źródłowe pole; brak ścieżki assetu `file`/`sampled`/`sampled_field`
kończy się jawnie przed próbą wczytania skryptu. Builder przenosi teraz nazwę
Study do SceneDocument i kanonicznego skryptu. Regresja porównuje canonical
bytes wspólnej projekcji fizycznej z niezależnym Python DSL, z osobną kontrolą
runtime selection i requested policy. Geometria pomocnicza zachowuje teraz
rodzaj DSL i translację; test porównuje jej geometrię i region z kanonicznym
Python DSL. Rozdzielone `id`/`name` auxiliary jest fail-closed, bo obecny
kontrakt ProblemIR nie potrafi zachować osobnej tożsamości. Adapter oraz
round-trip: **11/11 passed**; script-builder round-trip: **35 passed, 28
subtests passed**; consistency, rustfmt dla zmienionego pliku CLI i diff check
**PASS**. P4 pozostaje na **50%**:
pełny golden parity, automatyczny producer pipeline, native FEM mesh/space oraz
kwalifikacja last-good i runtime/browser/physics nadal są otwarte lub
`NOT VERIFIED`.

Najnowszy slice golden parity wykrył i naprawił utratę `field_drives` na
granicy SceneDocument → renderer: overrides przekazują teraz listę źródłową,
pusta lista jawnie czyści bazowe napędy, a błędna struktura SceneDocument
kończy się błędem. Fixture FEM porównuje canonical bytes fizycznego ProblemIR
dla geometrii/regionów, materiału, couplingu, mesh defaults, monitora, dwóch
napędów Gaussian i study pipeline. `test_scene_document_problem_ir.py`
**12/12**, `test_scene_document_roundtrip.py` **4/4**,
`test_script_builder_roundtrip.py` **35 passed + 28 subtests** oraz
repo consistency i diff check **PASS**. To jeden reprezentatywny fixture;
pełna macierz nadal otwarta, więc P4 pozostaje **50%**. Native FEM
mesh/space, browser/Live runtime i walidacja fizyczna pozostają
`NOT VERIFIED`.

## Czego nie należy z tego wyniku wnioskować

Checkpoint P3a z 22.09: usunięto publikację odpowiedzi sceny bez scope do
cache innych sesji oraz zabezpieczono zapis historii immediate mutations
po `clear()`, również dla pustego stosu. Szczegóły i ograniczenia są w
[`p3a/07-request-scope-transport.md`](p3a/07-request-scope-transport.md).
Kolejny przyrost dodaje scope przechwycony przez kontekst UI oraz kontrolę
aktualności wykonywanej komendy opartą na cache statusu, z obsługą A→B→A
i zwolnieniem obserwatora w `finally`. Komendy mapy pola i zapis historii
sprawdzają tę kontrolę przed publikacją lokalnych skutków. Typecheck,
architecture/API hygiene i diff check przeszły; regresje są zapisane,
lecz nieuruchomione. To nie zamyka migracji pozostałych komend ani
tożsamości ponownego otwarcia tej samej sesji.
Review wykazał i usunięto regresję otwierania pustego widoku 2D. Komendy
regionów i sprzężeń sprawdzają scope przed działaniem i po ACK; helper
historii anuluje zapis, jeżeli scope zmienił się podczas odczytu sceny.
Nowe regresje pozostają `NOT RUN`; bieżący typecheck i kontrole architektury/API
przeszły. Zakres dowodów jest opisany w tym samym checkpointcie P3a.
Następny przyrost obejmuje komendy geometrii: realization/validation,
antenę, commit draftu i usuwanie obiektu. Scoped API oraz kontrole po await
chronią publikację historii, invalidację i zaznaczenie; testy regresyjne
są zapisane, lecz nieuruchomione. Typecheck, API/architecture hygiene i diff
check **PASS**. Komendy meshingu mają już scope zlecenia i obserwacji oraz
kontrolę spóźnionych odpowiedzi; zakres i otwarte dowody są w
[`p3a/07-request-scope-transport.md`](p3a/07-request-scope-transport.md).
Nowe regresje są zapisane, lecz `NOT RUN`; typecheck i kontrole API/architektury
przeszły. Procenty i kwalifikacja pozostają bez zmian.
Osobny `request_scope_epoch` obejmuje obecnie źródłowo status API, nagłówek,
klucze zasobów, komendy i reset viewportu. Frontend typecheck, API/architecture
hygiene, parser Rust i kontrola JSON przeszły. Build runnera odrzucił migawkę
dirty mastera kodem HTTP 413 przed utworzeniem joba, więc kompilacja backendu
jest `NOT VERIFIED`; testy jednostkowe pozostają `NOT RUN`. Realtime i browser
pozostają otwarte. [Szczegóły](p3a/07-request-scope-transport.md).
Niezgodność katalogu profili klienta mastera wyjaśniono: dodatkowy profil
pochodzi z innej gałęzi i jest aktywnie używany. Zgodny, istniejący klient
odczytał zdrowie runnera bez zmiany konfiguracji. Aktualny odczyt pokazał
około 1,73 GiB wolnego storage przy wymaganych 8 GiB oraz aktywny build
innego zadania. Odczyt retention-plan zakończył się timeoutem; nie usuwano
danych. Szczegóły: [stan runnera](p3a/08-runner-client-status.md).
Wcześniejszy udany check API nie jest dowodem kompilacji późniejszej poprawki
polityk meshingu. Procenty realizacji pozostają bez zmian.
Komendy histerezy bookmark, eksport pętli CSV i użycie punktu jako stanu
początkowego przekazują teraz scope sesji i odrzucają spóźnione odpowiedzi
przed invalidacją lub dalszym skutkiem. Typecheck, celowany ESLint, API hygiene
i diff check **PASS**; nowa regresja jest zapisana, lecz `NOT RUN`.
Browser i managed runtime pozostają `NOT VERIFIED`.
Komendy Study odświeżają teraz preconditions i wysyłają komendy w jednym
przechwyconym zakresie sesji. Zmiana sesji pomiędzy tymi krokami anuluje
submit; spóźnione ACK nie publikuje invalidacji. Osobna komenda profilera ma
ten sam zakres. Typecheck, celowany ESLint oraz kontrole API/architektury
**PASS**; nowe regresje pozostają `NOT RUN`. Procenty nie zmieniają się.
GET polityk meshingu shared-domain i interface walidują teraz przechwycony
kontekst także przed odpowiedzią. Parser Rust i diff check **PASS**; pełny
rustfmt check ujawnia wcześniejsze różnice w tym pliku. PUT ma backendowy
scene load/commit fence, lecz migracja klienta i managed dowód pozostają
`OPEN`/`NOT VERIFIED`.
PATCH polityki komunikacji realtime waliduje scope, zmienia stan i publikuje
zdarzenie pod jedną blokadą przełączenia sesji; GET zachowuje tę samą kolejność
blokad. Regresja stale epoch jest zapisana, ale `NOT RUN`. Parser Rust i diff
check **PASS**; browser WebSocket i managed runtime nadal `NOT VERIFIED`.
Klient WebSocket odrzuca teraz wiadomości z `session_id` innej sesji przed
invalidacją. Nadal sprawdza epoch w `hello`. Dedykowana suite **8/8 PASS**;
browserowy scenariusz A→B pozostaje `NOT VERIFIED`.
Lokalny `/workspace` nie odpowiedział w krótkim limicie, dlatego scenariusz
browserowy A→B nadal `NOT VERIFIED`.
Pełne PUT display i visualization state mają teraz typowane metody fasady
z przekazaniem scope sesji; backend ma transition fence. Wiersze pozostają
`OPEN` bez konsumenta UI i managed dowodu. Typecheck, celowany ESLint bez
ostrzeżeń oraz kontrole API/architektury **PASS**; regresja `NOT RUN`.

- P0/P1 mają wysokie procenty zakresowe, ale nadal nie zamykają wszystkich
  dowodów produkcyjnych.
- P2-A/B/C to częściowe slice’y; nie są równoważne pełnemu authoringowi,
  meshingowi ani runtime.
- Nie wykonano kwalifikacji naukowej, parytetu FDM/FEM CPU/GPU, power-loss,
  pełnej session-recovery ani release qualification.
- Brakujące dowody mają status `NOT VERIFIED`, a nie `PASS`.

P2-D, 23.09: `GeometryObjectPanel` przechwytuje scope dla create/geometry
patch/translation, zapisuje historię przez wspólny wrapper i odrzuca efekty
spóźnionego ACK po zmianie sesji albo wyczyszczeniu historii. Są nowe regresje
DOM oraz helpera translation, ale Vitest i ESLint nie wystartowały z powodu
`EPERM` przy odczycie zainstalowanych pakietów Node; typecheck nadal nie ma
odebranego wyniku. Powiązany proces Node `297588` nadal działa; system odmówił
jego zatrzymania (`Access denied`), więc pozostawiłem go bez zmian, a właściciel
procesu jest niepotwierdzony. Przed kolejnym typecheckiem trzeba odebrać wynik
z sesji, która ten proces kontroluje. `check:architecture-hygiene` **PASS**.
Nie zmieniam procentu P2: ten przyrost nie ma jeszcze wymaganego dowodu
testowego. Następny kodowy slice został dopisany: `StudyInspectorPanel`
obejmuje wspólnym wrapperem historii `commitStageDrafts` i `commitGlobalDraft`,
a po przechwyceniu ACK sprawdza scope przed invalidacją i dalszymi skutkami UI;
wpis powstaje przed zależnym replanem FDM. `check:architecture-hygiene`
**PASS**, ale test integracyjny, typecheck i ESLint pozostają `NOT VERIFIED`.
Następnie należy przejść browserowy Apply → Undo → Redo i objąć pozostałe
direct handlers.

P2-D, 23.09: semanticzna historia zachowuje snapshot selection/fokusu po obu
stronach transakcji. Wspólne komendy Undo/Redo przywracają wcześniejszy wybór,
jeśli jest prawidłowy w odtworzonej scenie; usuwają wybór nieistniejącego
obiektu i respektują nowszy prawidłowy wybór/fokus. `GeometryObjectPanel`,
`ObjectGeneralPanel` oraz komendy create/delete geometry zapisują właściwe snapshoty. Dodano testy
kontrolera, workspace restore, helpera mutacji i routingu. Testy workspace
restore i Object General przeszły **6/6** po udostępnieniu runnerowi zainstalowanego
Vitest. Repo consistency, architecture
hygiene i diff check **PASS**. Typecheck, targeted ESLint i browserowy Apply →
Undo → Redo są **NOT VERIFIED**; lokalny browser nie połączył się z portem
3104 (`ERR_CONNECTION_REFUSED`). Procent P2 i całego planu pozostaje bez zmian.

P3a, 24.09: commit importu archiwum `.fms` przekazuje scope do requestu;
backendowy handler wiąże commit z transition fence. Po ACK frontend pobiera
globalną tożsamość sesji i dopiero przy zgodnym `session_id` stosuje UI state
oraz invalidacje. To zachowuje intencjonalną zmianę sesji wywołaną importem
i odrzuca odpowiedź, jeśli w międzyczasie aktywna stała się inna sesja. Suite
Study/Run: **84/84**, celowany ESLint, API hygiene i spójność repozytorium
**PASS**. W inventory: **276 SOURCE PASS / 15 OPEN / 13 GLOBAL**; browser/managed
cutover pozostaje `NOT VERIFIED`, P3a pozostaje **90%**.

P3a/P4, 24.09: odczyt preparation w Control Room czeka na pełną tożsamość
sesji, przekazuje `sessionScopeKey` i utrzymuje cache per
`session_id/session_epoch/request_scope_epoch`. Wymagana rewizja statusu jest
stosowana do tego samego scoped key, dzięki czemu wcześniejsza invalidacja
kanonicznej ścieżki nie pozostawia nowej sesji bez żądania i nie miesza danych
z poprzedniego wykonania. Geometry commands, startup overlay, zamontowane UI
preparation i hook: **88/88 PASS**; workspace history restore: **3/3 PASS**.
Control Room typecheck, celowany ESLint, API hygiene, architecture hygiene i
repository consistency: **PASS**. Typecheck ujawnił też stary fixture historii
authoringu, który używał niezgodnego pola `object_id`; dopasowano go do
kanonicznego `SceneResource.objects[].id`, a jego trzy testy przeszły. Nie
zmienia to procentów etapów: P3a pozostaje **90%** przy **276 SOURCE PASS / 15
OPEN / 13 GLOBAL**, P4 pozostaje **50%**, a globalny zakres około **27%**.
Przeglądarka na porcie 3104 zwróciła `ERR_CONNECTION_REFUSED`. Natywna bramka
jest zablokowana: `just runner-container-status` zwrócił
`Docker Desktop coordinator request failed`; nie uruchomiono natywnej
kompilacji poza kolejką.

P2-A, 24.09: ukierunkowana macierz Python projekcji authoringowej,
`SceneDocument`/`ProblemIR`, round-trip sceny i geometrii selekcji: **80/80
PASS**. Potwierdza to warstwę Python; Rust digest, zgodność Python/Rust,
browser round-trip i lowering przez `fullmag-py-core` nadal są
**NOT VERIFIED**. Procent P2 (**59%**) i globalny zakres (~**27%**) pozostają
bez zmian.

P2-D browser, 24.09: próba uruchomienia lokalnego Control Room na porcie 3104
zakończyła się przed startem aplikacji błędem Node `EPERM` przy odczycie
zainstalowanego entrypointu Next. Nie wykonano scenariusza browserowego; jego
status pozostaje **NOT VERIFIED**.

P2-D/P3a, 24.09: `ObjectAbsorbingBoundaryPanel` teraz przypina odczyt historii
i `PATCH` do tego samego session scope oraz `baseRevision`; brak tożsamości
blokuje zapis, a odpowiedź po zmianie A→B nie może dodać historii, invalidować
zasobu ani pokazać sukcesu. Dodano trzy regresje DOM. Typecheck, API hygiene i
architecture hygiene **PASS**; Vitest i ESLint pozostały **NOT RUN** przez
`EPERM` przy otwieraniu pakietów `node_modules`. P2 (**59%**), P3a (**90%**),
P4 (**50%**) i plan globalny (~**27%**) bez zmian.

P2-D/P3a, 24.09: analogiczny fencing obejmuje zapis i czyszczenie tekstury
magnetyzacji regionu w `ObjectRegionTexturePanel`. Brak tożsamości blokuje
mutację, wymagane są scope i skończona rewizja, a spóźniony ACK nie unieważnia
zasobów, nie uruchamia synchronizacji skryptu ani nie zmienia draftu/feedbacku.
Synchronizacja best-effort używa tego samego scope i po jej await ponownie
sprawdza aktualność; pending jest przypięty do sesji i identyfikatora operacji.
Dodano trzy regresje DOM. Typecheck, API hygiene, architecture hygiene, repo
consistency i diff check **PASS**. Testy DOM **NOT RUN**: Vitest zatrzymuje się
przed wykonaniem na `EPERM` przy otwieraniu
`node_modules/.pnpm/vitest.../vitest.mjs`; browser i managed runtime są
**NOT VERIFIED**. P2 (**59%**), P3a (**90%**), P4 (**50%**) i plan globalny
(~**27%**) bez zmian.

P2-D/P3a, 24.09: zapis pól materiałowych regionu w
`ObjectRegionMagneticParametersPanel` wymaga aktywnego `sessionScopeKey` i
finite `baseRevision`, a odczyt historii oraz zapis używają tego samego scope.
Po zmianie sesji lub generacji historii spóźniony ACK nie publikuje historii,
invalidacji ani feedbacku; znacznik pending jest przypięty do identyfikatora
operacji, żeby stary `finally` nie czyścił nowego zapisu. Dodano trzy regresje
DOM. Typecheck, API hygiene, architecture hygiene i diff check **PASS**.
Uruchomienie Vitest zakończyło się `EPERM` przy otwarciu
`node_modules/.pnpm/vitest.../vitest.mjs`, więc nowe testy są **NOT RUN**; browser
i managed runtime pozostają **NOT VERIFIED**. P2 (**59%**), P3a (**90%**), P4
(**50%**) i plan globalny (~**27%**) bez zmian.

P2-D, 24.09: `GeometryObjectPanel` jest zarejestrowany w `PendingFormRegistry`.
Globalny Apply dispatchuje jedną zmienioną domenę, a równoczesna edycja
geometrii i translacji blokuje tylko Apply; Reset pozostaje dostępny. Panel
oznacza callback jako `mutation-owned`, więc własny zapis historii nie jest
dublowany przez staged bridge. Bridge przekazuje scope do snapshotów i odrzuca
wykonanie po zmianie sesji; zmiana generacji przez callback omija wtórny wpis.
Typecheck Control Room, API hygiene, architecture hygiene, repository
consistency i `git diff --check` **PASS**. Dodane regresje rejestru, bridge'a i
panelu geometrii są **NOT RUN** z powodu `EPERM` przy otwieraniu Vitest;
browserowy Apply → Undo → Redo pozostaje **NOT VERIFIED**. P2 (**59%**) i plan
globalny (~**27%**) bez zmian.

P2-D/P3a, 24.09: `PlanarMonitorDraftInspectorPanel` teraz przypina utworzenie
nowego monitora do bieżącego session scope i generacji historii. Brak tożsamości
blokuje żądanie; request wymaga skończonej rewizji zamiast fallbacku `0`. ACK
po zmianie A→B nie czyści draftu, nie zmienia źródła wizualizacji, selection,
layoutu ani zasobów. Pending jest przypięty do scope i identyfikatora operacji.
Dodano dwie regresje DOM i zaktualizowano asercje request options. Typecheck,
API hygiene, architecture hygiene i diff check **PASS**; Vitest **NOT RUN** z
powodu błędu `EPERM` przy ładowaniu pakietu. Browser/managed runtime pozostają
**NOT VERIFIED**; procent P2 (**59%**) i planu (~**27%**) bez zmian.

P2-D/P3a, 24.09: edycja istniejącego Planar Monitora przekazuje do PATCH
session scope oraz skończoną rewizję i po ACK sprawdza zgodność sesji/generacji
historii przed zmianą draftu, invalidacją i refetch. Brak tożsamości zatrzymuje
zapis; pending jest przypięty do sesji i operacji. Rozszerzono DOM regresje o
scoped request, A→B przed ACK i brak identity. Typecheck, API hygiene,
architecture hygiene i diff check **PASS**; Vitest **NOT RUN** z powodu
`EPERM` w `node_modules`. Browser pozostaje **NOT VERIFIED**; procent P2
(**59%**) i globalny (~**27%**) bez zmian.

P2-D/P3a, 24.09: aktywny `CrossSectionDraftEditor` przypina odczyt granic
domeny i create Planar Monitora do tego samego scope. Brak identity zatrzymuje
obie operacje, a create wymaga skończonej rewizji zamiast fallbacku `0`. ACK po
zmianie sesji nie usuwa draftu ani nie publikuje wizualizacji, zasobów,
selection lub layoutu. Dodano trzy DOM regresje: scoped read/write, A→B przed
ACK i brak identity. Typecheck, API hygiene, architecture hygiene,
repo consistency i diff check **PASS**; Vitest **NOT RUN** z powodu `EPERM`
przy ładowaniu `vitest.mjs`; browser **NOT VERIFIED**. Procent P2 (**59%**) i
globalny (~**27%**) bez zmian.

P2-D/P3a, 24.09: `SpinAuthoringInspector`, `TransportAuthoringInspector` i
`SpinInterfaceInspector` przypinają walidację, zapis oraz odczyt historii do
`sessionScopeKey`. Create/Replace/Delete używają scoped request options i
`base_revision`; Spin Interface ponownie waliduje transport właścicielski
przed jego zastąpieniem. Zmiana sesji lub generacji historii podczas
oczekiwania odrzuca późną walidację/ACK przed publikacją historii, invalidacją
zasobów i feedbackiem. Stan pending jest przypisany do scope i identyfikatora
operacji. Asercje źródłowe sprawdzają użycie scope i fence. Control Room
typecheck, API hygiene, architecture hygiene, repo consistency i
`git diff --check` **PASS**. Vitest i celowany ESLint **NOT RUN**: środowisko
odmawia Node.js odczytu zainstalowanych entrypointów błędem `EPERM`
(`vitest.mjs`, `eslint.js`); browser i
managed runtime pozostają **NOT VERIFIED**. P2 (**59%**), P3a (**90%**), P4
(**50%**) i plan globalny (~**27%**) bez zmian.

P2-D, 24.09: ujednolicono deklarację właściciela historii dla staged
formularzy. `SpinAuthoringInspector`, `TransportAuthoringInspector`,
`SpinInterfaceInspector`, `StudyInspectorPanel`, `StudyStageInspectorRouter`
i wrapper Physics Interaction wybierają `mutation-owned`, ponieważ callbacki
zapisują własny wpis przez `runAuthoringMutationWithHistory`.
`GeometryObjectPanel` i `ObjectGeneralPanel` używają tego samego jawnego trybu.
Pozostałe staged formularze pozostają bridge-owned; most rejestruje zmianę
rewizji także po wyniku callbacku `false`, zachowując historię partial ACK, ale
nie zezwalając na dalszą zmianę selection. Dodano testy dla częściowego
commitu, invalidacji generacji oraz trybu `mutation-owned`. Control Room
typecheck, API hygiene, architecture hygiene, repository consistency i targeted
diff check **PASS**. Vitest **NOT RUN** z powodu `EPERM`; browserowy Apply → Undo
→ Redo i managed runtime **NOT VERIFIED**. P2 (**59%**) i plan globalny
(~**27%**) bez zmian.

P2-D/P3a, 24.09: `RegionalFieldDrivePanel` zapisuje create/replace przez
revision-fenced `runAuthoringMutationWithHistory`, przekazuje przechwycony
`sessionScopeKey` do POST/PUT i ignoruje ACK po zmianie sesji przed historią,
invalidacją oraz selection. Draft i pending są przypięte do scope; rejestr
Inspectora deklaruje `mutation-owned`, aby nie dublować wpisu. Dodano test
modelu forwarding options i dwa DOM przypadki (create, A→B przed ACK).
Typecheck **PASS**; Vitest i `react-doctor --scope changed` **NOT RUN** z powodu
`EPERM` przy otwieraniu entrypointów Node, browser i managed runtime
**NOT VERIFIED**. P2 (**59%**), P3a (**90%**) i plan globalny (~**27%**) bez
zmian.

P2-D/P3a, 24.09: `AirboxMeshParametersPanel` przypina draft, zapis policy,
odczyt sceny dla FDM oraz komendę budowy do bieżącego `sessionScopeKey`.
Bez aktywnej sesji Apply jest zablokowany; feedback i pending są kluczowane
przez sesję, a `finally` starszej operacji nie czyści nowszego stanu. Spóźniony
ACK po zmianie A→B nie unieważnia zasobów. Lokalny Apply i Apply & Build
korzystają z zarejestrowanej staged sesji, więc ten sam history bridge obsługuje
te akcje i globalny Apply. Dodano DOM regresje dla scoped write i late ACK.
Typecheck, API hygiene, architecture hygiene i diff check **PASS**;
Vitest oraz lint **NOT RUN** z powodu `EPERM` przy odczycie entrypointów w
`node_modules`. Browser pozostaje **NOT VERIFIED**: port 3104 zwrócił
`ERR_CONNECTION_REFUSED`, a testowy serwer nie został uruchomiony. P2 (**59%**),
P3a (**90%**), P4 (**50%**) i plan globalny (~**27%**) bez zmian.

P2-D, 24.09: `ObjectMeshPolicyPanel` wiąże szkic, pending, feedback i budowę z
tożsamością obiektu oraz sesji. Zapis i komenda budowy używają przechwyconego
command contextu; brak aktywnej sesji blokuje Apply/Build, a ACK po zmianie
sesji nie unieważnia cache ani nie publikuje feedbacku. Lokalne Apply/Build
korzystają z bridge'a historii staged session. Dodano DOM regresje dla scoped
write i późnego ACK. Typecheck, API hygiene, architecture hygiene, repo
consistency i diff check **PASS**. Vitest oraz lint pozostają **NOT RUN** z
powodu `EPERM` przy otwieraniu pakietów Node; browser **NOT VERIFIED** (lokalny
port 3104 odmawia połączenia). P2 (**59%**) i plan globalny (~**27%**) bez
zmian.

P2-D/P3a, 24.09: `ObjectRegionsPanel` używa `captureAuthoringMutationFence` i
`runAuthoringMutationWithHistory` dla lokalnego oraz globalnego Apply, a
duplicate/delete wymagają tego samego aktywnego scope i skończonego
`baseRevision`. ACK po zmianie sesji nie publikuje sceny, selection, invalidacji
ani feedbacku; pending i feedback są przypięte do sesji/regionu. Usunięto
syntetyczny fallback rewizji `Date.now()`, a akcje zapisu są wyłączone bez
sesji. Typecheck, API hygiene, architecture hygiene, repo consistency i diff
check **PASS**. Vitest/lint **NOT RUN** z powodu `EPERM` przy entrypointach
`node_modules`; browser **NOT VERIFIED**. Procenty P2 (**59%**), P3a (**90%**),
P4 (**50%**) i całości (~**27%**) pozostają bez zmian.

P3, 24.09: przegląd endpointu `materialize_run` wykrył, że brakujący run mógł
zainicjalizować pusty store przed odpowiedzią 404. Handler otwiera teraz tylko
istniejący store, a regresja sprawdza 404 bez utworzenia katalogu. Zmieniony
handler przechodzi `rustfmt --edition 2021 --check` i `git diff --check`.
Regresja kompilująca **NOT RUN**: `just runner-container-status` zwrócił
`Docker Desktop coordinator request failed`; nie użyto hostowego fallbacku.
Pełny `cargo fmt --check` nadal zgłasza formatowanie w innych plikach pakietu.
P3 (**49%**) i całość (~**27%**) bez zmian do czasu testu lub HTTP dowodu.

B/FDM, 24.09: metody całkowitej energii AoS/SoA, gęstości energii oraz dwie
metody obserwabli przeniesiono z `fields.rs` do `fields/energy.rs` i
`fields/observables.rs`; sygnatury i widoczność API pozostały bez zmian.
Porównanie wszystkich 16 przeniesionych ciał względem `HEAD` po normalizacji
końców linii potwierdziło niezmienioną treść i brak duplikatów. Dodano
regresje source-layout obejmujące wszystkie 16 metod.
Ukierunkowany `rustfmt --check`, `git diff --check` i
`scripts/check_repo_consistency.py` **PASS**. Test kontraktu/build crate’u
**NOT RUN**: `just runner-container-status` ponownie zwrócił
`Docker Desktop coordinator request failed`; resolverowa trasa lekkiego testu
zatrzymała się przed inicjalizacją storage na istniejącym zwykłym katalogu
`.fullmag`, który wymaga inwentaryzowanej migracji. Nie użyto hostowego
fallbacku ani nie zmieniano tego katalogu.
To wyłącznie ekstrakcja w Rust CPU reference, nie zmienia native solverów ani
nie kwalifikuje żadnego lane’u. B (**1%**) i całość (~**27%**) pozostają
konserwatywne do czasu zarządzanej weryfikacji.

P4-C, 24.09: przycisk `Build Shared-Domain Mesh` w Mesh Inspector korzysta
teraz z dostępności i `disabledReason` istniejącej komendy, zasilanych bieżącym
lane’em sesji oraz zasobem mesh capabilities. Stan niedostępny blokuje klik i
udostępnia powód przez etykietę dostępną i tooltip; reguły capability nie są
powielane w komponencie. Typecheck Control Room, architecture hygiene,
repository consistency i celowany diff check **PASS**. Celowany ESLint
**NOT RUN**: Node zgłosił `EPERM` przy otwieraniu istniejącego entrypointu
`eslint.js`; testów jednostkowych nie kompilowano zgodnie z tymczasową regułą
repozytorium. Browserowy stan FEM/capability i managed runtime pozostają
**NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.

P4-C, 24.09: badge `Build Pipeline` w Explorerze pokazuje teraz rewizję meshu
oraz rewizję sceny, z której pochodzi artefakt. Używa rewizji z manifestu,
a przy jej braku z provenance ostatniego udanego buildu; nieznane wartości
pozostają jawne jako `none`/`unknown`. Zmiana obejmuje tylko FEM mesh node i nie
zmienia strukturalnego FDM gridu. Typecheck Control Room, architecture hygiene,
repository consistency i celowany diff check **PASS**. Testów jednostkowych nie
kompilowano zgodnie z tymczasową regułą repozytorium; browserowy smoke pozostaje
**NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.

P4-B, 24.09: FEM preparation receipt otrzymuje teraz
`fem_mesh_source_evidence.v1`. Digest wejścia producenta `mesh` wiąże
kanoniczny fingerprint `MeshIR`, topologię zwróconą przez MFEM, digest
`FemSharedDomainBuildReportIR` (albo jawny brak) i fingerprint per-domain
quality wraz z licznikami markerów. Jacobian sample digest pozostaje osobnym
metrycznym dowodem. Obecny producer odrzuca `degraded=true`, brakujące lub
nadmiarowe markery, rozbieżność liczby komórek oraz niefinite/niespójne
podsumowania. Historyczne receipts ze schematem producer v1 nadal są
odczytywalne; nowe plany wymagają source evidence. Cztery regresje źródłowe
zapisano, ale **NOT RUN**. Bieżący `just runner-container-status` zakończył się
`Docker Desktop coordinator request failed`, więc kontrolowany test/build nie
wystartował; nie użyłem hostowego fallbacku. Samo powiązanie nie ustanawia
normatywnego mesher acceptance, zwłaszcza dla rodzin elementów bez per-domain
summary. P4 (**50%**) i całość (~**27%**) pozostają bez zmian do czasu
przejścia testów oraz bramki jakości/runtime.

P3a, 24.09: generator macierzy endpointów zachowuje UTF-8 przy uruchomieniu
CLI w Windows PowerShell nawet wtedy, gdy proces dziedziczy `cp1250`; dodano
regresję uruchamiającą CLI z takim kodowaniem. Test **1/1 PASS**, a odczytowa
generacja potwierdziła 304 operacje OpenAPI: 276 `SOURCE PASS`, 15 `OPEN` i
13 `GLOBAL`. Macierzy nie odświeżano ani nie zmieniano polityki endpointów.
Pozostałe `OPEN` dotyczą tras bez wykazanego aktywnego konsumenta lub decyzji
kontraktowej; nie usuwam ich bez potwierdzenia kompatybilności. Ponowienie
browser smoke `Hide Inspector` w tej rundzie jest **NOT VERIFIED**:
`localhost:3104` nie przyjmuje połączenia, a lokalny Next nie uruchomił się z
powodu Windows `EPERM` przy otwieraniu istniejącego pakietu `next`. Zachowuje
ważność wcześniejszy, zapisany w `p1/02-browser-smoke-inspector.md` dowód
hide/show; ta próba nie zastępuje go ani nie obniża jego statusu. Managed
runner również pozostaje niedostępny (`Docker Desktop coordinator request
failed`). P3a (**90%**),
P3 (**49%**), P4 (**50%**) i całość (~**27%**) bez zmian.

P3a-C, 24.09: dodano
[`rejestr klientów 15 operacji OPEN`](p3a/09-legacy-route-consumer-ledger.md).
Wskazuje właściciela i handler, faktycznie znalezione fasady/konsumentów,
politykę odczytu/zapisu oraz warunek deprecjacji dla każdej metody. Nie
zamieniono `OPEN` na `SOURCE PASS`: brak in-repo callera nie rozstrzyga
zewnętrznej kompatybilności, a route bez transportu klientowego scope nie
spełnia bramy P3a. P3a pozostaje **90%**; całość planu pozostaje ~**27%**.

P4-C, 24.09: ukierunkowane UI regresje historii siatki przeszły **9/9**:
helper nawigacji czeka na właściwy editor, emituje restore raz i anuluje go
przy zmianie selekcji (**6/6**), a widok pokazuje restore tylko dla wpisu z
policy snapshotem (**3/3**). To przywraca konfigurację do draftu z Apply jako
osobnym krokiem; nie cofa fizycznego artefaktu ani nie zastępuje testu
last-good. P4 (**50%**) i całość (~**27%**) bez zmian; kompilacja FEM i
runtime nadal czekają na managed runner.

P4-C, 24.09: suite'y `AirboxMeshBuildPanel.test.tsx` oraz
`airboxMeshInspectorModel.test.ts` przeszły **53/53**. Potwierdzają widok
bieżącego błędu/lifecycle degraded oraz prezentację `last_success` obok błędu;
nie dowodzą retencji artefaktu przez backend. Rustowa regresja
`record_manual_remesh_failure` sprawdzająca, że odrzucony kandydat nie zmienia
`last_build_summary`, istnieje, ale nie została skompilowana ani uruchomiona,
bo managed runner pozostaje niedostępny. P4 (**50%**) i całość (~**27%**) bez
zmian.

P4, 24.09: natywna walidacja po finalizacji porównuje współrzędne MFEM z
kanonicznym wejściem i dopasowuje każdy brzeg jeden-do-jednego po geometrii,
markerze oraz uporządkowanej łączności właściciela. Test kontraktowy rozszerzono
o współrzędne i jawne fasety zewnętrzne/okresowe. Managed runner zgłosił
`Docker Desktop coordinator request failed`, więc kontrakt i kompilacja nie
zostały uruchomione; status pozostaje **NOT VERIFIED** i nie zmienia P4
(**50%**) ani całości (~**27%**).

P4, 24.09: strict lowering `SceneDocument → ProblemIR` odrzuca nieznane i
nieobsługiwane pola, a `table_autosave` zachowuje kadencję, `table_id`,
quantities i expressions. Zarządzane testy materializacji API **5/5**,
`SceneResource` **1/1**, adapter Rust **1/1**, Python **58/58**, testy trasy
**13/13**; OpenAPI codegen, wygenerowane typy/klient, API hygiene i typecheck
**PASS**. Pierwszy test API wykrył i doprowadził do poprawki obsługi domyślnego
`field_drives: {}` po pominięciu pustego `drives` przez serde. Testowy fixture
`SceneDocument::default()` zastąpiono deserializacją kanonicznego `scene.v2`.
Receipt'y i ograniczenia source-level opisano w checkpointcie P4. Pełna
golden parity, FEM mesh/space, browser/Live runtime i walidacja fizyczna nadal
pozostają **NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.

P4, 24.09: current modules przechodzą fail-closed po obu stronach serde/Python;
unknown fields są odrzucane, a legacy `current_transport` i częściowe szkice
anteny zachowują dotychczasową migrację. Połączone suite'y SceneDocument,
table autosave i transportów: **122 testy + 45 subtestów**; kontrakty tras
**13/13**; zarządzane API preparation, SceneResource,
authoring i OpenAPI codegen **PASS**. Wygenerowane OpenAPI/typy/ścieżki,
API hygiene oraz Control Room typecheck **PASS**. Szczegółowe receipts i zakres
dowodów są w `p4/01-scene-document-to-problem-ir.md`. Pełna golden parity,
FEM mesh/space, browser/Live runtime i walidacja fizyczna pozostają
**NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.

P4, 24.09: legacy `current_transport` odrzuca nieznane pola w typowanym
payloadzie, w tym referencjach, materiałach, granicach, solverze, obwiedniach
i strukturach closure; `lead_mesh` jest zachowywany jako MeshIR payload.
Regresje sceny, autosave, current/spin transportów, closure i SOT: **159 testów
+ 66 subtestów PASS**. Zarządzane `verify-api-preparation`: **PASS**; receipt i
granice dowodów opisano w `p4/01-scene-document-to-problem-ir.md`. P4 pozostaje
**50%**, całość ~**27%**; golden parity, FEM mesh/space, Live/browser i
walidacja fizyczna nadal są **NOT VERIFIED**.

P4, 24.09: SceneDocument lowering dla FDM nie dopisuje już FEM hints z
domyślnego stanu edytora, kiedy `Problem.runtime` jawnie wybiera FDM bez
FEM discretization. Differential sprawdza zgodność `discretization_hints` i
`mesh_workflow` z bezpośrednim DSL; osobny przypadek potwierdza zachowanie
jawnych hintów FEM. FDM differential porównuje cały ProblemIR, pomijając tylko
teksty `script_source` i `source_hash`. Suite'y: **156 testów + 109 subtestów
PASS**; spójność repozytorium i celowany diff check **PASS**. Zarządzany
`verify-api-preparation` **PASS**, `source_changed_during_run=false`; receipt
`api-preparation-tests/5eb4edfb9ef142a4ab93233fc6a29ed7/receipt.json` wiąże
zmieniony plik źródłowy jego SHA-256. Nie zamyka to różnic domyślnych opcji
FEM `mesh_workflow` ani pełnej golden parity. Browser/Live, native FEM i
walidacja fizyczna pozostają **NOT VERIFIED**; P4 **50%**, całość ~**27%**.

24.09: pełny differential SceneDocument→ProblemIR dla FDM i bogatego przypadku
FEM przechodzi po zachowaniu `study_pipeline`/`wait_for_solve` oraz po pominięciu
wyłącznie domyślnych opcji mesh w bootstrapie SceneDocument. Jawne wartości
domyślne w zwykłym Python-builder round-trip nadal są emitowane. Połączone
suite'y SceneDocument, round-trip, table autosave, transportów, closure, SOT i
script builder: **193 testy + 137 subtestów PASS** (2 oczekiwane ostrzeżenia).
`check_repo_consistency.py`, `git diff --check` i managed
`just verify-api-preparation` **PASS**; nowy receipt
`api-preparation-tests/062cde9675a444769cb0b11b035f9637/receipt.json` wiąże
SHA obu modułów adaptera. To reprezentatywny golden differential source/API,
nie cała macierz ani kwalifikacja runtime. FEM mesh/space, Live/browser i
walidacja fizyczna pozostają **NOT VERIFIED**; P4 **50%**, całość ~**27%**.

24.09: kontynuacja P4 FEM mesh/space. `fullmag-plan` materializuje pięć
certyfikatów z H1 P1 evidence, wiąże receipt z kanonicznym fingerprintem
wejścia i odrzuca rebinding oraz nieobsługiwane H1 P2. `fullmag-application`
przechodzi od FEM `ProblemIR` przez planner do kompletnego walidowanego receipt'u
i odrzuca evidence z innej siatki. Testy source-level:
`cargo test --locked -p fullmag-plan --lib preparation::tests` **15/15 PASS**,
`cargo test --locked -p fullmag-application --lib preparation::tests` **7/7
PASS**; `rustfmt --check` dla obu modułów **PASS**. Fixture application używa
syntetycznego native evidence, więc wynik nie dowodzi kompilacji ani działania
MFEM/ABI. `just runner-container-status` nadal zwraca
`Docker Desktop coordinator request failed`; native contract, Live/API,
browser/WebGL i walidacja fizyczna pozostają **NOT VERIFIED**. P4 (**50%**) i
całość (~**27%**) bez zmian.

P4, 24.09: rozszerzono pokrycie FEM preparation o test `fullmag-runner`, który
wywołuje native mesh-space ABI dla Tet4 H1 P1 i odrzuca H1 P2. Dodano dedykowaną
receptę `just verify-fem-mesh-space-preparation-contract`: buduje i uruchamia
C++ contract w `fem-cpu`, a potem testuje wrapper FFI; `just --dry-run` **PASS**.
Próba pełnej recepty zatrzymała się przed Compose, ponieważ storage preflight
wykrył istniejący katalog `.fullmag` (`local`, `local-live`, `reports`) i wymaga
zinwentaryzowanej migracji; nie zmieniałem tej ścieżki. Odczytowy inventory
storage zakończył się **PASS**; `just runner-container-status` osobno zgłasza
`Docker Desktop coordinator request failed`. ABI/native pozostaje
**NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.

P4, 24.09: caller FEM preparation ma teraz regression na zmianę sesji podczas
oczekiwania na receipt. Test potwierdza anulowanie bez solver Compute i bez
lokalnej publikacji receipt'u. Ukierunkowane suite'y materializatora i komend
Control Room: **89/89 PASS**; `check:architecture-hygiene`, `check:api-hygiene`,
`typecheck` i celowany ESLint **PASS**. Podgląd browsera na porcie 3104 nadal zwraca
`ERR_CONNECTION_REFUSED`, więc caller runtime pozostaje **NOT VERIFIED**.
Natywny preflight nadal blokuje istniejący `.fullmag`; C++/ABI nie został
uruchomiony. P4 (**50%**) i całość (~**27%**) bez zmian.

P4-B, 24.09: w teście materializacji application utrwalono brak fałszywej
akceptacji jakości: brak build reportu i pusty `per_domain_quality` pozostają
jawne, `min_quality`/`max_aspect_ratio` nie są dopisywane, a natywne Jacobian
evidence zachowuje osobny kanał. `cargo test --locked -p fullmag-application
--lib preparation::tests`: **7/7 PASS**; `rustfmt --check`: **PASS**. To test
kontraktu z syntetycznym native evidence, nie produkcyjny quality gate ani
wykonanie MFEM. P4 (**50%**) i całość (~**27%**) bez zmian.

P0-C, 24.09: source audit objął writer entry points `SessionStore`, CAS,
checkpoint capture, import/eksport FMS i kopiowanie artefaktów API. Wykazał
okno read-modify-publish w `reconcile_run_catalog`; lease przesunięto przed
odczyt katalogu. Nowa regresja najpierw odtworzyła lukę, a po poprawce
`just verify-session-persistence` przeszło na dirty `master@93f11d…` z
`source_changed_during_run=false`: **58 testów biblioteki, 19 integracyjnych PASS (0 doctestów)**. Run `81a582e260214cdab02181e2805850f4`, source digest
`7d493829a29ed894aa20cf5c75bd569dc9cf4215b1a6d80365f24aba4d80b8a9`, receipt
SHA-256 `6F66575FF2321BFB3BA1C3D7A0D7E56C7B9E365FCCEC22E536634AFA617E3BED`, log
SHA-256 `DFC9FFD06535B3A5D50884E73CAB15851331DFFA1580548298B918E22234D66D`.
Power-loss, Windows directory durability i profile innych systemów plików
pozostają **NOT VERIFIED**; P0 (**85%**) i całość (~**27%**) bez zmian.

### Recovery bieżącej sesji — 24.09.2026

Odczyt i usuwanie recovery ograniczono do tożsamości aktywnej sesji. Dodano
walidację zgodności dokumentu, usuwanie pod blokadą pisarza i licznik faktycznie
usuniętych snapshotów. Testy session: **78/78 PASS**, kompilacja API: **PASS**,
testy skryptu weryfikacyjnego: **14/14 PASS**, testy HTTP: **2/2 PASS**. Szczegółowe
receipty: [raport izolacji recovery](p0/04-recovery-isolation.md).
Pełne odzyskiwanie po awarii i kwalifikacja runtime pozostają otwarte.
Procenty bez zmian: P0 85%, P1 98%, cały plan około 27%.

### Koordynator P3/P5 — 24.09.2026

Odrzucone zdarzenia i komendy nie zużywają już sekwencji, a żądanie release ma osobną nazwę `ReleaseRequested`. Bramka application **38/38 PASS**, run `cadc569917fd4027b8963bdb330078de`, niezmienione źródła podczas weryfikacji. [Raport](p3/06-coordinator-atomicity.md). Brak kwalifikacji transportu, workera i fizycznego zwolnienia zasobów; procenty etapów pozostają bez zmian.

### Izolacja strumieni dziennika P3 — 24.09.2026

Usunięto blokowanie drugiego taska i retry przez sekwencję lub terminalne
zdarzenie innego taska/próby. Dziennik rozdziela strumienie według task,
attempt, ownership epoch i kierunku; odrzuca zmianę tokenu w tym samym
strumieniu. Regresja najpierw odtworzyła błąd, następnie bramka session
przeszła **78/78**, run `d2d96b31323e40e59019a61fb3f30e4c`, exit 0,
źródła niezmienione podczas testu. [Dowody i ograniczenia](p3/03-coordinator-journal.md).
Proces testowy zakończony, artefakty zachowane w zarządzanym storage.
Następny krok: adapter zapisu i odtwarzania koordynatora. P3 49%, całość
około 27% — bez podnoszenia procentów za tę poprawkę kontraktu.

P3, 24.09: dodano spójny odczyt całego coordinator journal pod blokadą pisarza,
z walidacją ciągłości każdego strumienia i zachowaniem historycznych prób.
Regresja ponownego otwarcia, konfliktu pisarza i brakującego początku dziennika:
bramka session **78/78 PASS**, run `122c9d944e2346a3ab31d96ccbba0bc3`, exit 0,
`source_changed_during_run=false`. Proces zakończony; dowody zachowane w
zarządzanym storage. [Raport](p3/03-coordinator-journal.md). Następny krok:
adapter odtwarzania stanu application i trwały outbox; P3 49%, całość około 27%.

P3/P5, 24.09: rejestr worker protocol można odtworzyć z kompletnych strumieni
jednego claimu z zachowaniem deduplikacji, konfliktów i terminal fencing.
Application **38/38 PASS**, run `a4425e3204d148af8a8bc7c84cfe18f7`, exit 0,
źródła niezmienione podczas testu. Proces zakończony, receipt zachowany w
zarządzanym storage. Nadal brakuje checkpointu z granicami zastosowanych
komunikatów, adaptera recovery i transportu. [Dowody](p3/03-coordinator-journal.md).
Procenty bez zmian.

P5-B, 24.09: subprocess odbiorcy zapisuje pending, wykonuje kontrolowany efekt
plikowy i kończy się kodem 24 przed applied. Recovery blokuje ponowne wykonanie,
a po uzgodnieniu trwały applied deduplikuje retransmisję. API **4/4 PASS**, run
`b00c9fad310a4105bc4bcd2a0df69738`, exit 0, źródła niezmienione. Oba pomocnicze
procesy (koordynator i odbiorca) zostały jawnie uruchomione i zakończone;
dowody zachowane. Nadal brak wykonania solvera i produkcyjnego routingu CLI.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P5-B, 24.09: połączono typowany WorkerInboxCheckpoint z SessionStore.
Test zapisu pending, reopen, uzgodnienia applied i deduplikacji po kolejnym
odtworzeniu: API **4/4 PASS**, run `7fa63f8d1e0145f3b4a99dcb5225edee`,
exit 0, źródła niezmienione. Callback wykonany dokładnie raz. Procesy
zakończone, dowody zachowane. Nadal brak routingu CLI i solvera oraz testu
przerwania procesu odbiorcy. [Raport](p3/03-coordinator-journal.md).
Procenty bez zmian.

P5-B, 24.09: SessionStore zapisuje checkpoint inboxu atomowo z kontrolą
claimu, monotonicznych przejść pending/applied i integralności payloadu.
Dodano reachability oraz pełny FMS roundtrip snapshotu. Session **79/79 PASS**,
run `1b76cb4b24784401aba038b15cb580f4`, exit 0, źródła niezmienione; proces
zakończony, dowody zachowane. Kolejne kroki: adapter application↔store,
test procesu odbiorcy i CLI. [Raport](p3/03-coordinator-journal.md).
Procenty bez zmian.

P0/P3, 24.09: pełny FMS roundtrip dwóch tasków i retry zachowuje katalog
i wszystkie wpisy dziennika, pozwala kontynuować niezależny strumień po imporcie
i odrzuca stary claim. Session **79/79 PASS**, run
`86928c488cd64bd1afae1167255b80c2`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Zamknięto brak osobnego multi-task archive
roundtrip; storage inboxu i routing CLI nadal otwarte.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P0/P3, 24.09: ujednolicono walidację strumieni coordinator journal w magazynie
i archiwum. Usunięto wspólne liczenie sekwencji różnych tasków/prób w walkerze
eksportu; dodano archive continuity/terminal/token checks. Session **78/78 PASS**,
run `cb8ed5f95e8a4afaa55a96bed820b1bb`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Osobny multi-task archive roundtrip i adapter
storage inboxu nadal do wykonania. [Raport](p3/03-coordinator-journal.md).
Procenty bez zmian.

P5-B, 24.09: kontrakt worker_inbox.v1 oraz receive_durable zapisują pending
przed wywołaniem wykonawcy i applied przed ACK; odtworzony pending blokuje
automatyczne powtórzenie. Application **42/42 PASS**, run
`d2a2d0318d7549a6b5de7a430be2e266`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Do wykonania adapter SessionStore i routing CLI;
test dotyczy portu publikacji, nie zapisu tego checkpointu na dysku.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P5-B, 24.09: dodano WorkerCommandInbox z claim fencing, ciągłą sekwencją,
deduplikacją callbacku i blokadą po nieznanym wyniku wykonania. Application
**42/42 PASS**, run `22d03bd54ce34edeaadd78bee7450e8f`, exit 0,
źródła niezmienione; proces zakończony, dowody zachowane. Komponent jest
procesowy, nadal brak trwałego receipt odbiornika i podłączenia wykonawcy CLI.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: test osobnego procesu zapisuje Stop + checkpoint i kończy się
kodem 23 przed projekcją katalogu. Rodzic odtwarza Stopping z plików, naprawia
pozostawiony Running i potwierdza idempotencję. API **4/4 PASS**, run
`cbc361752c6848c2ba38384949e59ad3`, exit 0, źródła niezmienione. Pomocniczy
ignored test jest jawnie uruchamiany w subprocess; jego exit 23 jest wymagany.
Procesy zakończone, dowody zachowane. Brak jeszcze odbiornika worker_protocol
w CLI, wykonania solvera i testu power-loss. [Raport](p3/03-coordinator-journal.md).
Procenty bez zmian.

P3/P5, 24.09: dodano naprawę projekcji lifecycle/observation katalogu z trwałego
łańcucha koordynatora pod wspólną blokadą. Test katalogu pozostawionego przed
aktualizacją i idempotentnego powtórzenia: API **4/4 PASS**, run
`c24b7ec6d05947e7a1d2a1d49781f67c`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Nadal brak podłączenia produkcyjnej pętli workera
i testu ubicia procesu. [Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: DurableWorkerCoordinator zachowuje dokładną oczekującą transition
i blokuje nowe operacje po błędzie publikacji. Ponowienie nie zmienia UUID.
Application **42/42 PASS** (`05a23ba1069843f8aac4188f1964ca98`), API z zapisem
na dysku i symulowaną utratą ACK **4/4 PASS** (`9eb78fce52c3439aa7f4096f0f1e6c8f`).
Exit 0, źródła niezmienione, procesy zakończone, dowody zachowane. Nadal brak
produkcyjnej pętli workera, synchronizacji lifecycle katalogu i testu ubicia
procesu. [Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: replay wpisu koordynatora ponawia bariery trwałości zamiast
uznawać sam widoczny payload za sukces. Fault injection awarii po rename
i przy potwierdzaniu: session **78/78 PASS**, run
`f6f7bf1f689c4686adb5d870bb6eb6ba`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Nadal wymagane zachowanie niepewnej transition
w pętli koordynatora i blokowanie nowych komend do reconciliation.
Power-loss/Windows directory durability pozostają NOT VERIFIED.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: recovery wybiera checkpoint ze spójnego łańcucha transition,
sprawdza aktualny claim i zachowuje oryginalne komendy do reconciliation.
Odrzuca rozwidlenie z poprawnym checksumem, obcy token i starą epokę.
API **4/4 PASS**, run `3f7743cd35de41ee9cadf4329c0099b1`, exit 0,
źródła niezmienione. Proces zakończony, dowody zachowane w storage.
Następne kroki: niepewna publikacja, katalog lifecycle i pętla workera.
[Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: adapter API zapisuje transition (komunikat + checkpoint) jako
jeden atomowy payload dziennika SessionStore. Test rzeczywistych plików,
konkurencyjnego writera, reopen, replay i odtworzenia: **4/4 PASS**, run
`5b4d93b07dfb4a6aa5e2ae69b2ac7912`, exit 0, źródła niezmienione. Proces
zakończony; dowody zachowane. Nadal brak podłączenia pętli workera i kwalifikacji
awarii/niepewnej publikacji. [Raport](p3/03-coordinator-journal.md). Procenty bez zmian.

P3/P5, 24.09: dodano kontrakt checkpointu application i odtworzenie
WorkerCoordinator dla dokładnych granic obu strumieni. Regresje aktywnej
i terminalnej próby: application **40/40 PASS**, run
`c7d51b79c07d4910993ae21eba0ca0ac`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane w storage. Nadal do wykonania: atomowy zapis
checkpointu, recovery ogona dziennika i transport outbox. [Raport](p3/03-coordinator-journal.md).
Procenty etapów i całości bez zmian.

P3/P5, 24.09: granica publikacji application łączy komunikat i wynikowy
checkpoint w jeden rekord; błąd publishera zachowuje poprzedni stan i blokuje
wydanie komendy. Application **41/41 PASS**, run
`16701cae11d949a9a7c53b56630dbd94`, exit 0, źródła niezmienione. Proces
zakończony, dowody zachowane. Następny krok: adapter SessionStore zapisujący
transition atomowo oraz reconciliation niepewnego zapisu; test nie dowodzi
jeszcze trwałej publikacji tego rekordu. [Raport](p3/03-coordinator-journal.md).
Procenty bez zmian.


P3/P5, 24.09: adapter checkpointów odbiorcy i dziennika koordynatora
wydzielony do solver-free `fullmag-runtime-control`; API jest konsumentem.
Bramka API **4/4 PASS**, run `567ec6a73bc84714b63c4cc46fa6a710`, exit 0,
źródła niezmienione; obejmuje dwa jawnie uruchamiane subprocess fixtures.
Proces zakończony, dowody zachowane w storage. Integracja wykonawcy CLI
z immutable RunSpec pozostaje do wykonania. Procenty bez zmian.
Szczegóły i granice dowodu: [raport](p3/03-coordinator-journal.md).

P3/P5: API używa wspólnego resolvera immutable RunSpec/definition CAS. Do rozwiązania pozostaje różna semantyka task input fingerprint w materializacji i application. Szczegóły w [raporcie](p3/03-coordinator-journal.md).

Weryfikacja resolvera: API **4/4 PASS**, run `4f124ea472294ed2a0e1bb0eef881c4c`, exit 0, źródła niezmienione. Dwa fixtures procesów uruchamia test rodzica. Proces zakończony; dowody zachowane w storage. Nie jest to kwalifikacja solvera; procenty planu bez zmian.

P3/P5: wspólna tożsamość materializowanego kroku study; regresja potwierdza zgodność starego task_input.v1 i odrzucenie zmienionych wejść. [Raport](p3/03-coordinator-journal.md).

Wynik końcowy: API **4/4 PASS** (`a1bbf7a7734c41cab72e92c1a84c560d`),
application **42/42 PASS** (`f795e78a92df4439825bad79e983bde7`). Obie bramki:
exit 0, source_changed_during_run=false; procesy zakończone, dowody zachowane
w zarządzanym storage. Niespójność obliczania odcisku jest usunięta dla nowej
ścieżki resolved_study_input i materializacji. Produkcyjne podłączenie CLI,
sprawdzenie wejść planu/preparation oraz wykonanie solvera pozostają otwarte.
Procenty całego planu bez zmian.

P3/P5: odcisk planu wejścia study jest wyliczany z przypiętego ExecutionPlanIR; wywołujący nie może podać dowolnego SHA. Brak planu blokuje utworzenie wejścia. [Raport](p3/03-coordinator-journal.md).

API **4/4 PASS**, run `7524598f1d9b48d5ad369657e2c76627`, exit 0, source_changed_during_run=false. Proces zakończony; dowody zachowane w storage. Test potwierdza odcisk planu i odrzucenie braku planu; nie jest dowodem solvera. Procenty planu bez zmian.

P3/P5: resolved study input wymaga pełnego receipt, dokładnego ProblemIR i zgodnego planu z kanonicznego planera. [Raport](p3/03-coordinator-journal.md).

Wynik: API **4/4 PASS**, run `9ace6f805dc0406a9109df947f175942`, exit 0,
source_changed_during_run=false. Proces zakończony; dowody zachowane w storage.
Regresja potwierdza przyjęcie przygotowania przypiętego modelu FDM i odrzucenie
receipt wskazującego inny ProblemIR. Pozostaje produkcyjny resolver dla CLI,
kontrola dostępności artefaktów i transport wykonawcy; solver nie był uruchamiany.
Procenty całego planu bez zmian.


P3/P5-B, 25.09: immutable study snapshot (RunSpec, StudyPlan, ProblemIR
catalog, assets i walidacja requested execution) wydzielony do
`fullmag-runtime-control`; API używa wspólnego resolvera. Bramka
**4/4 PASS**, run `f8a899e4a1184a82bb2033fb9dc4776b`, exit 0,
`source_changed_during_run=false`; dowody zachowane w storage. CLI, proces
workera i publikacja zdarzeń nie są jeszcze podłączone. Procenty planu bez
zmian. [Raport](p3/03-coordinator-journal.md).

P3/P5-B, 25.09: wspólny `DurableWorkerInbox` zapisuje pending przed efektem,
applied przed ACK i wymaga istniejącego checkpointu przy recovery. Nowe zapisy
inboxu/dziennika są odrzucane po zwolnieniu lease; identyczny replay pozostaje
dozwolony. API **4/4 PASS** (`d157917e58444ee489dfe73ca9eec16a`), trwałość
sesji **79/79 PASS** (`19dd731378b0440e9dd415ba399bf698`), exit 0 i
`source_changed_during_run=false`; receipty zachowane w storage.
Nie dowodzi to produkcyjnego supervisora, transportu CLI, solvera ani
heartbeat-generation fencing. Procenty etapów bez zmian.
[Raport](p3/03-coordinator-journal.md).

P3/P5-B, 25.09: `AcceptedStudySnapshot::resolve_task_input` wybiera immutable
ProblemIR i krok, sprawdza digest i kanoniczny plan, wiąże receipt z RunSpec
i claimem, a `resolved_study_input` ponownie kontroluje wejście; Live API
odrzuca marker accepted-run. To sprawdzenie
tożsamości, nie podpis ani pełny producer siatki/meshu. Test regresyjny API
zapisano, ale **NOT RUN**: runner
zgłasza `Container profile allow-list mismatch`, a `runner-doctor` nie może
poświadczyć kontekstu Docker Desktop. Bezpośredni build hostowy jest zabroniony;
testy i kompilacja pozostają `NOT VERIFIED`. Otwarte: trusted preparation
producer z immutable snapshot, adapter CLI, claim/lease/coordinator i
uruchomienie workera. Procenty pozostają: **P3 49%, P4 50%, P5 0%, całość około
27%**. [Szczegóły i granice dowodu](p3/03-coordinator-journal.md).

P3/P5-A, 25.09: dodano `PreparationPlan` v2 ze źródłem `accepted_run_step`
(`run_id`, pełny RunSpec fingerprint, `step_id`) i materializację FDM wyłącznie
z `AcceptedStudySnapshot`; zgodność `ProblemIR` i `ExecutionPlanIR` jest
ponownie sprawdzana przez kanoniczny planner. V1 Live zachowuje dotychczasowy
wire shape, a niepowiązany Live receipt nie może zostać przepięty do RunSpec.
Dodano regresje serializacji, source binding, niepowiązanego Live i zgodnego
legacy v1 receipt. Testy **NOT RUN** z powodu blokady managed runnera opisanej w
raporcie; `rustfmt` parsuje zmienione moduły Rust. Nie ma jeszcze trwałego
receiptu per step, atomic admission claim/lease, CLI/workera ani materializatora
FEM z immutable run. Procenty bez zmian: **P3 49%, P4 50%, P5 0%, całość około
27%**. [Raport przyrostu](p3/06-accepted-run-preparation.md).

P3/P5-A, 25.09: dodano immutable `task_preparation_receipt.v1` pod ścieżką
per-task. Materiałizacja API publikuje receipt dla zaplanowanych FDM i na replay
uzupełnia brakujące zapisy; taski pozostają `Accepted/Blocked`, a FEM nie ma
fallbacku. Store, archiwum i reachability wiążą receipt z RunIntent, run catalog,
RunSpec, task ID i fingerprintem wejścia. Dodano regresje API, store replay /
replacement oraz `.fms` round-trip. `rustfmt --check` i `git diff --check`:
**PASS**; testy i kompilacja **NOT RUN / NOT VERIFIED** z powodu blokady
managed runnera. Worker nie odczytuje jeszcze tych receiptów, a readiness,
dependency resolution, admission, CLI/workers, FEM i solver pozostają otwarte.
Procenty bez zmian: **P3 49%, P4 50%, P5 0%, całość około 27%**.
[Raport przyrostu](p3/07-task-preparation-receipts.md).

P3/P5-A, 25.09: `AcceptedStudySnapshot::read_task_preparation_receipt` dodaje
typowany odczyt trwałego task receipt: SessionStore sprawdza envelope/catalog/
RunIntent, runtime-control waliduje application plan, certyfikaty i binding do
immutable study snapshot. Regresja API porównuje zapisany receipt z wynikiem
materializacji, a `resolve_task_input_from_store` wyprowadza task ID z kroku,
sprawdza attempt/epoch/resource, readiness, lifecycle oraz aktywny lease z
zgodnym heartbeat/kind/budget i buduje resolved input z durable receipt.
`rustfmt --check` oraz `git diff --check`: **PASS**; test i kompilacja
**NOT RUN / NOT VERIFIED** z
powodu niedostępnego managed runnera. Worker/admission nadal nie wywołuje tej
ścieżki; taski pozostają zablokowane, bez zmiany procentów (**P3 49%, P4 50%,
P5 0%, całość około 27%**). [Raport](p3/08-typed-task-preparation-reader.md).

P3/P5-B, 25.09: `publish_accepted_task_prepare` łączy zweryfikowany durable
receipt i resolved input z `DurableWorkerCoordinator`; publikuje dokładny
`WorkerCommand::Prepare` wraz z checkpointem w coordinator journal i zachowuje
pending transition po błędzie zapisu. Regresja sprawdza envelope i zapisany
transition, ale pozostaje **NOT RUN / NOT VERIFIED** z powodu blokady managed
runnera. To outbox adapter: transport CLI, supervisor, admission/readiness,
ACK po restarcie i solver pozostają otwarte. Procenty bez zmian (**P3 49%, P4
50%, P5 0%, całość około 27%**). [Raport](p3/09-durable-prepare-outbox.md).

P3/P5-B, 25.09: `load_current_task_claim` odtwarza typed claim wyłącznie z
gotowego run catalog i zgodnego aktywnego lease, z kontrolą attempt/epoch,
resource, tokenu i heartbeat. Regresja API porównująca pełny claim jest
zapisana, ale **NOT RUN / NOT VERIFIED** przez blokadę managed runnera. To
odczyt istniejącego właściciela; nie claimuje taska, nie przydziela zasobu,
nie odtwarza coordinator journal i nie uruchamia CLI/workera. `recover_coordinator`
wymaga transitionu, a brak initial coordinator marker uniemożliwia bezpieczne
odróżnienie nowego streamu od utraconej historii; inicjalizacja Prepare z
pustego journalu jest zabroniona, dopóki P5-B nie zapisze durable
admission/bootstrap. Procenty bez zmian (**P3 49%, P4 50%, P5 0%, całość
około 27%**).
[Raport](p3/10-current-task-claim-recovery.md).

P3/P5-B, 25.09: początkowy stan coordinatora jest teraz zapisywany jako
zahashowany `coordinator_genesis` przed pierwszym `Prepare`. Recovery pustego
journalu wymaga zgodnego claimu, checkpointu `(0,0)` i watermarku `(0,0)`;
ogólny zapis katalogu nie może opublikować genesis ani wstawić go do nowego
katalogu bez sprawdzenia aktywnego lease. Regresje pokrywają oba obejścia oraz
odmowę po utracie journalu, ale pozostają **NOT RUN / NOT VERIFIED** z powodu
blokady managed runnera. To domyka brak initial marker z raportu
[odtwarzania claimu](p3/10-current-task-claim-recovery.md), lecz nie tworzy
CLI/supervisora, nie claimuje taska i nie uruchamia workera. Procenty pozostają
bez zmian: **P3 49%, P4 50%, P5 0%, całość około 27%**. [Szczegóły](p3/11-coordinator-watermark.md).

P3/P5-B, 25.09: store-backed dispatch sprawdza, czy resolved inputs używają
wyłącznie portów zaakceptowanego kroku, wszystkie wymagane porty są obecne, a
każdy `StepOutput` pochodzi z taska zakończonego sukcesem z attempt/epoch.
Regresja obejmuje brak i nadmiar portu oraz nieukończone upstream; **NOT RUN /
NOT VERIFIED** z powodu blokady managed runnera. Dokładne powiązanie wejścia z
artefaktem, portem i case pozostaje otwarte, podobnie jak producent outputów i
CLI/supervisor. Procenty bez zmian (**P3 49%, P4 50%, P5 0%, całość około 27%**).
[Raport](p3/12-study-dependency-dispatch.md).

P3/P5-B, 25.09 — dalsze domknięcie wejść `StepOutput`: rozszerzono
`FmsArtifactCatalogEntry` o opcjonalną, zgodną wstecznie tożsamość outputu
`step_id`/`port_id`/`case_id`. Store-backed resolver dopasowuje tę tożsamość do
artefaktu, taska/attemptu/epoch źródła, statusu `Published`, artifact ID i
digestu wejścia; walidacja katalogu blokuje obcy task oraz duplikat outputu.
Regresje lineage (zły artifact ID/digest i `case_id`) zapisano;
`rustfmt --check` i `git diff --check` **PASS**,
testy/kompilacja **NOT RUN / NOT VERIFIED** przez `Container profile allow-list
mismatch`. Brak producenta publikującego lineage i brak automatycznego
resolvera wejść nadal blokują runtime. Procenty bez zmian (**P3 49%, P4 50%,
P5 0%, całość około 27%**). [Szczegóły](p3/12-study-dependency-dispatch.md).

P3/P5-B, 25.09: dodano `SessionStore::append_artifact_catalog_entries_for_lease`
oraz `fullmag-runtime-control::publish_study_outputs`. Nowe artefakty wymagają
aktywnego claimu i publikacji przed terminalnym `Completed`; dokładny replay
jest idempotentny, a nowe wpisy po completion lub release są odrzucane.
Regresja store sprawdza aktywny lease, CAS, append, idempotentny replay po
completion i odmowę nowych wpisów po zakończeniu/zwolnieniu lease. Test API
zaakceptowanego runu publikuje `final_state`, weryfikuje bajty w CAS i potwierdza,
że publikacja poprzedza terminalny lifecycle; wejście testu jest syntetyczne i
nie pochodzi z solvera.

Weryfikacja na niezmienionym w trakcie źródle: `just verify-session-persistence`
**83 PASS, 0 doctestów** (run `d334239eafc24cc4aa0f5d5bc789acb1`);
`just check-api-source` **PASS** (`aa957972d82d4c179246bfe14f12577f`);
`just verify-api-preparation` **6/6 PASS** (`f059ecad07c244bca39a8c3150e1145b`);
`just verify-api-project-runs` **4 PASS, 2 ignored**
(`e5fe74a1356f42308616a153cffde899`). `rustfmt --check`, `git diff --check`
i skan białych znaków **PASS**. Nadal brak call site w supervisorze/workerze,
bezpiecznej aktualizacji `artifact_ids` i dispatchu downstream; nie ma więc
pełnego wykonania runtime. Procenty bez zmian (**P3 49%, P4 50%, P5 0%, całość
około 27%**).
[Granice i następne kroki](p3/12-study-dependency-dispatch.md).

P3/P5-B, 25.09: `append_artifact_catalog_entries_for_lease` dopisuje także
identyfikatory do `FmsTaskCatalogEntry.artifact_ids`. Replay naprawia brakującą
projekcję, jeśli proces przerwał pracę po zapisie kanonicznego katalogu
artefaktów. Regresje store i API sprawdzają tę projekcję. Kontrola formatowania
`rustfmt --check` **PASS**. Test store uruchomiony przed poprawką potwierdził
regresję (**60 PASS, 1 oczekiwany FAIL**, run
`0514352fd3f84fb784f7e397e36da5ff`); testów po poprawce nie uruchomiono, bo
automatyczna kontrola zablokowała kompilację testów jednostkowych na podstawie
tymczasowego zakazu w `AGENTS.md`. Projekcja pozostaje **NOT VERIFIED**.
Po poprawce źródłowa trasa `just check-api-source` skompilowała binarium API
bez celów testowych: **PASS**, run `74904ea1146d45eab345a0b8cc945d0a`,
`source_changed_during_run=false`. Kompilacja kodu nie zastępuje weryfikacji
zachowania testami.
Supervisor/worker nadal nie wywołuje helpera; dispatch runtime, wykonanie
solvera i downstream output pozostają otwarte. Procenty bez zmian
(**P3 49%, P4 50%, P5 0%, całość około 27%**).

P3/P5-B, 25.09: `publish_study_outputs` odrzuca teraz brak któregokolwiek
zadeklarowanego portu przed przypięciem payloadów do CAS. Dodano regresję
niekompletnego i kompletnego zestawu `State`/`Scalar`; nie uruchomiono jej z
powodu zakazu kompilowania testów. Po tej zmianie `just check-api-source`
**PASS** (`3e0ecc8f69b342d7b408878856ff4f20`,
`source_changed_during_run=false`), `rustfmt --check` **PASS**. Produkcyjne
źródła kompilują się; nowa semantyka nadal **NOT VERIFIED** testem zachowania.
Pełne wykonanie pozostaje otwarte: helper nie jest wywoływany przez worker.

P3-B, 25.09: `ResolvedTaskInput.v2` niesie typowany ref artefaktu, CAS,
`data_kind` i wersję codec. Store-backed resolver odczytuje manifest bieżącej
udanej próby, sprawdza identity, kompletność deklarowanych portów i wszystkie
wpisy względem catalogu; worker inbox przyjmuje historyczne v1 i v2, ale nie
miesza ich w jednej próbie. Granica protokołu odrzuca nieznane data kind i
wszystkie codec tuple, bo produkcyjnych dekoderów nie ma. `rustfmt` **PASS**;
`just check-api-source` **PASS**, receipt `53eb3f4bb7104e108d423bea4fdb2b2a`. Durable `Completed` barrier weryfikuje accepted plan, attempt, manifest, artifacts i CAS; store zamraża output allow-listę po publikacji i dopuszcza exact replay.
Test regresyjny został zapisany, lecz **NOT RUN / NOT VERIFIED**. Brakuje
supervisora, completion barrier i dowodu runtime; procenty bez zmian (**P3 49%,
P4 50%, P5 0%, całość około 27%**).


P3-B, 25.09 — weryfikacja końcowa przyrostu ResolvedTaskInput.v2: just verify-session-persistence PASS (receipt 11ff3056f4654fdfbe04d51129bb7c9b), just verify-project-application PASS (a514d03c31364d13a325616edc48980f) i just verify-api-project-runs PASS (38bcca94e48a4ec1adaa113fc2b6772a). Testy obejmują zamrożenie listy outputów po manifeście, odrzucenie niezarejestrowanego codec oraz accepted-run completion barrier. Końcowe just check-api-source po ostatniej zmianie eksportu helpera PASS (07f91d8a4dab421ea4f2f14ed36943d4); rustfmt --check PASS. Nadal brak produkcyjnego codec/dekodera, call site supervisora i proof wykonania rzeczywistego workera/solvera. Procenty bez zmian (P3 49%, P4 50%, P5 0%, całość około 27%).

## Typowane kodeki artefaktów study — 25.09.2026

Dodano `fullmag.runner.field_json@v1` dla `state`/`initial_state` oraz
`fullmag.study.scalar_json@v1` dla skalarów SI. Stan wiąże próbki z layoutem
FDM, layoutem każdej warstwy multilayer albo topologią H1 P1 FEM; odrzuca
nieznany layout, niezgodny sample count i nieskończone wartości. Inne typy
portów nadal są fail-closed. Publication sprawdza komplet payloadów przed
pierwszym CAS, a completion fence i binding `StepOutput` sprawdzają bajty
odczytane z CAS.

Weryfikacja po zmianie: `just verify-project-application` PASS
(`c7561e2eeb2c4f7d8a3df54e8afb4292`), `just verify-api-project-runs` PASS
(`867f9153c9714377a8b3210be8806d77`) i `just check-api-source` PASS
(`7dc2d9e1051341728613ed0b69b6d536`). API scenariusz używa syntetycznego
artefaktu, nie solvera. Test nowego writer-a runnera jest **NOT RUN**:
`just runner-doctor` zgłosił aktywny BuildKit i `defer-existing-workload`, a
`just runner-list` zatrzymał się na `Container profile allow-list mismatch`.
Nie zastosowano hostowego ani równoległego fallbacku. Supervisor, rzeczywisty
worker, transfer stanu między przestrzeniami oraz solver/runtime/physics gates
pozostają otwarte. P3: **50%**; całość planu pozostaje około **27%**.
Szczegóły: [`p3/13-typed-study-artifact-codecs.md`](p3/13-typed-study-artifact-codecs.md).

## Horyzont TimeEvolution — 25.09.2026

`StudyPlan v2` i `study_execution_plan.v2` zapisują zaakceptowane
`until_seconds` per krok. Jawna migracja starego `Run` zachowuje legacy payload,
a lowering TimeEvolution bez skończonego dodatniego czasu kończy się błędem
przed dispatch. `StudyPlan v1` bez pola nadal jest czytelny; nie dostaje
domyślnej wartości.

`just verify-authoring-contracts`: **107/107 PASS** (receipt
`3b5a9bae3fc041e98d7c67d7947f7f82`); `just verify-api-project-runs`:
**4 PASS, 2 ignored** (receipt `44b40955149d40abb13b347d81a09f50`);
`just generate-api-openapi`: **PASS** (receipt
`0de8731b09244f12bb9173709f37d1e5`). Każda trasa miała
`source_changed_during_run=false`; `rustfmt --check` PASS. Testy nie uruchamiają
solvera. Supervisor, rzeczywisty worker, pełne runtime i walidacja fizyczna
pozostają **NOT VERIFIED**. Procenty bez zmian: **P3 50%, plan globalny około
27%**. Szczegóły w [checkpointcie P3](p3/14-time-evolution-horizon.md).

## P3-B — zależności przed kolejką ready — 25.09.2026

`queue_accepted_study_task` przeprowadza pojedynczy accepted task do durable
`Queued/Ready` po sprawdzeniu immutable identity, preparation receipt,
wymaganych wejść oraz exact `StepOutput` lineage/manifest/CAS. Replay ponownie
wykonuje walidację; błędny lub niezadeklarowany port nie zmienia rewizji
catalogu. Test accepted-run zastępuje ręczne przestawianie readiness helperem i
przechodzi dalej przez durable admission oraz `Prepare` outbox.

`just verify-api-project-runs`: **6 PASS, 2 ignored**, receipt
`e4cd6869dfdb40b8851d27b981e5640c`; `just check-api-source`: **PASS**, receipt
`57688c144f8344a3a79647ac82a39ce4`; obie trasy z
`source_changed_during_run=false`. Repository consistency checker **PASS**.
Pełny `rustfmt --check` nadal wskazuje wcześniejsze nieformatowane fragmenty w
szerszych dirty plikach; nie formatowano całych współdzielonych źródeł.

To nie jest jeszcze production scheduler: brakuje call site, alokacji zasobu,
limitów współbieżności, resolved-device provenance, supervisora/transportu,
rzeczywistego workera i uruchomienia solvera. Runtime i walidacja fizyczna
pozostają **NOT VERIFIED**; P3 **50%**, plan globalny około **27%**.
Szczegóły: [p3/21-dependency-gated-ready-queue.md](p3/21-dependency-gated-ready-queue.md).

## P3-B — device lane fence w durable admission — 25.09.2026

`commit_claimed_task_admission` odtwarza zaakceptowany RunSpec i study step przed zapisaniem claimu. Lease solvera musi być CPU albo GPU; jawny `RunSpec.device` oraz rozstrzygnięty FEM eigen device muszą zgadzać się z ofertą. Dla `auto` wybrana klasa zasobu jest zachowana w durable lease.

Regresja przed poprawką wykazała, że RunSpec `cpu` przyjmował GPU claim (receipt `8fb0b01c42ce45a99d6439e0cd5e13d2`). Końcowy `just verify-api-project-runs`: **6 PASS, 2 ignored**, receipt `380986ba0aca453996e7938261e9f899`; `just check-api-source`: **PASS**, receipt `114003e8c08d4b2f98e79bacb76c4290`. Obie trasy mają `source_changed_during_run=false`. `claim.rs` rustfmt, repository consistency i scoped API diff check **PASS**.

Fence odrzuca niezgodny lease przed mutacją catalogu, lecz nie wybiera zasobów ani nie potwierdza faktycznego urządzenia procesu solvera. Nadal brakuje schedulera produkcyjnego, puli zasobów, supervisora/transportu, workera i runtime/physics qualification. P3 pozostaje **50%**, plan globalny około **27%**. Szczegóły: [p3/22-device-lane-admission-fence.md](p3/22-device-lane-admission-fence.md).

## P3-B — CAS state do accepted planu worker-a — 25.09.2026

`AcceptedWorkerStep` niesie deklarowane input ports, a API adapter czyta stan po
typowanym ref CAS, sprawdza Run/Task/Attempt/Epoch, plan fingerprint, codec,
digest i exact layout, po czym podmienia magnetyzację początkową wyłącznie w
kopii `ExecutionPlanIR`. Brak wymaganego wejścia, nieobsługiwany scalar,
niezgodny typ/layout i wiele state inputów kończą się odmową. Authored initial
conditions pozostają w immutable ProblemIR/kanonicznym planie.

`just verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt
`1a36a59725664bccbe2dc544f0610259`; `just check-api-source`: **PASS**, receipt
`f1046d24fd864d6e81d8d990daef11f8`; obie trasy z
`source_changed_during_run=false`. Repository consistency i rustfmt adaptera
**PASS**. Regresja używa syntetycznego artefaktu CAS i nie uruchamia solvera.
Helper nie ma jeszcze produkcyjnego caller-a, więc P3 **50%**, a całość około
**27%**. Szczegóły: [p3/24-cas-input-to-runner-plan.md](p3/24-cas-input-to-runner-plan.md).
## P3-B — wyłączny katalog outputu attemptu — 25.09.2026

`create_private_attempt_output_dir` sprawdza bieżący claim oraz aktywny lease pod writer lockiem, odrzuca symlinkowe składniki ścieżki i rezerwuje dokładnie jeden katalog dla pary attempt/epoch. Accepted-run regresja odrzuca stary heartbeat bez mutacji ścieżki; aktywny claim tworzy prywatny katalog, a replay leaf jest odrzucany.

`just verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt `8e9cd7bcc1e14c2fbd2386b669419805`; `just check-api-source`: **PASS**, receipt `56f0964386bb471c9da2d3817634602b`; obie trasy `source_changed_during_run=false`. `rustfmt --check` adaptera i scoped diff check **PASS**. Helper nie jest jeszcze production call site i nie stanowi trwałego side-effect receipt. Bez zmian: **P3 50%, całość około 27%**; supervisor, transport, runtime i fizyka nadal **NOT VERIFIED**. Szczegóły: [p3/25-private-attempt-output-directory.md](p3/25-private-attempt-output-directory.md).

## P3-B — durable Start do rzeczywistego FDM CPU — 25.09.2026

Nowy testowy call site łączy durable Prepare/Start, pending inbox, accepted snapshot i
fenced claim z krótkim rzeczywistym przebiegiem FDM CPU oraz publikacją typed outputów
do CAS/manifestu. Przed uruchomieniem wymaga dokładnego claimu i aktywnego CPU lease;
weryfikuje requested/resolved CPU, FDM, double, brak fallbacku, terminal barrier
i replay Start bez ponownego side effectu. To jest dowód solvera w regresji API,
nie production supervisor/transport ani dowód restart recovery, GPU, innych lane'ów,
limitu całego katalogu attemptu lub walidacji naukowej. P3 pozostaje 50%, całość około 27%.

just verify-api-project-runs: 6 passed, 0 failed, 2 ignored; receipt
addbd9b004314543b6249e8f4ccb2ee9; source_changed_during_run=false.
just check-api-source: PASS; receipt a9d5019ba6384defa35549774fdae645;
source_changed_during_run=false. Adapter rustfmt check PASS. Szczegóły:
[p3/26-durable-start-fdm-cpu-execution.md](p3/26-durable-start-fdm-cpu-execution.md).

## P3-B — receipt wykonania i wznowienie publikacji — 25.09.2026

Wąski testowy worker zapisuje immutable started receipt przed solverem, a po
rzeczywistym FDM CPU zapisuje typed outputy do CAS i ukończony receipt. Drugie
wywołanie dla tego samego pending Start odtwarza zweryfikowane bajty z CAS i
pozwala kontynuować fenced publikację bez ponownego wykonania solvera. Gdy
ukończenia nie da się potwierdzić, replay pozostaje fail-closed. Brakuje
production supervisora, transportu, recovery procesu po restarcie, obsługi
osieroconych CAS pins, power-loss qualification i naukowego qualification.
Procenty bez zmian: **P3 50%, całość około 27%**.

`just verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt
`166e583a00154010bdb56f9537fd803a`; `source_changed_during_run=false`.
`just check-api-source`: **PASS**, receipt `50ab5033dddc4cacbe39bec14b6ec495`;
`source_changed_during_run=false`. Rustfmt adaptera oraz repository consistency
**PASS**. Szczegóły: [p3/27-durable-worker-execution-receipt.md](p3/27-durable-worker-execution-receipt.md).

## P3-B/P5-B — anulowanie zadania przez operatora — 26.09.2026

Dodano trwałą, fenced komendę `Stop`, idempotentny replay tej samej przyczyny,
terminalne `Cancelled` po potwierdzonym zatrzymaniu procesu oraz pierwszeństwo
wcześniej opublikowanego sukcesu. Supervisor rozróżnia cancel od timeoutu,
czeka na exit, zapisuje `Stopped` i zwalnia najnowszą wersję lease. Endpoint
projektowego runu oraz wygenerowany klient OpenAPI udostępniają tę operację w
Inspectorze z per-task pending/error i revision-driven refetch.

Managed dowody: runtime-control **3/3 PASS** (`2e95c96...`), project application
**PASS** (`d7ff33f...`), API source **PASS** (`31af500...`), OpenAPI **PASS**
(`14de31c...`) i supervisor **7/7 PASS** (`dabe48e...`). Frontend typecheck,
lint, API/architecture hygiene, 141 testów klienta, React Doctor changed-scope
oraz repository consistency zakończyły się bez nowej regresji. Pełne process
E2E cancel, router HTTP z rzeczywistym store, zdalny StopAck, pre-start cancel,
retry i orphan recovery pozostają otwarte. **P3 65%, P5 18%, całość około 29%**.
Szczegóły: [p3/33-operator-task-cancellation.md](p3/33-operator-task-cancellation.md).

## P3-B/P5-B — pełne process E2E anulowania — 26.09.2026

Dedykowana trasa buduje supervisor i worker, czeka na trwałe `Started`, zapisuje
operatorski `Stop`, potwierdza exit potomka, terminalne `Cancelled`, release
ostatniego lease, brak artefaktów sukcesu i pozostawiony pending `Start`.
Odpowiedź przyjętego `Stop` korzysta z rewizji zwróconej przez tę samą
publikację journalu i projekcji, więc konkurencyjny heartbeat nie może ukryć
skutecznej mutacji błędem dodatkowego odczytu po commicie.

Managed dowody: runtime-control **3/3 PASS** (`b86b7e9...`), cancel process E2E
**1/1 PASS** (`d84e4c1...`), kontrolna ścieżka sukcesu **1/1 PASS**
(`13484c1...`) i API source **PASS** (`83d7366...`). Testy konfiguracji tras:
**18/18 PASS**. Otwarte pozostają pre-start cancel, automatyczny retry, orphan
recovery, zdalny `StopAck`, scheduler/pula i pozostałe lane'y. **P3 66%, P5
21%, całość około 30%**. Szczegóły:
[p3/34-supervisor-cancel-e2e.md](p3/34-supervisor-cancel-e2e.md).

## P3-B/P5-B — anulowanie przed spawnem workera — 26.09.2026

`Stop` może teraz przeprowadzić task z `Preparing` do `Stopping`, jeśli journal
zawiera trwały `Start`. Supervisor odtwarza ten stan przed spawnem i przy braku
`Started` nie uruchamia procesu potomnego: publikuje `Stopped`, ustawia
`Cancelled`, zwalnia dokładny lease i globalny slot. Control Room pokazuje
Cancel dla `preparing` i `running`, a wygenerowany kontrakt odpowiedzi zawiera
`catalog_revision` dla revision-driven refetch.

Managed dowody: application **PASS** (`25c663d...`), runtime-control **PASS**
(`b55c755...`), pre-start cancel process E2E **1/1 PASS** (`7523e3d...`),
kontrolne cancel E2E **1/1 PASS** (`cf9931e...`) i success E2E **1/1 PASS**
(`c219a3e...`), supervisor **PASS** (`f780001...`), API source **PASS**
(`996ef7c...`) oraz OpenAPI **PASS** (`176c166...`). Typecheck i API hygiene
Control Room, React Doctor changed-scope **100/100**, 19 testów konfiguracji
tras oraz repository consistency także przechodzą. Nadal otwarte są
automatyczny retry, orphan recovery, zdalny
`StopAck`, scheduler/pula i pozostałe lane'y. **P3 67%, P5 24%, całość około
31%**. Szczegóły:
[p3/35-supervisor-prestart-cancel.md](p3/35-supervisor-prestart-cancel.md).

## P3-B/P5-B — automatyczny retry przed efektem — 26.09.2026

Supervisor ma jawny, domyślnie wyłączony limit automatycznych retry. Po
potwierdzonym wyjściu workera sprawdza prywatną rezerwację dokładnego attemptu.
Brak katalogu wykonania pozwala zapisać retryable `Failed`, zwolnić lease i
zastosować trwałą decyzję `Retry`; istniejący katalog nadal oznacza stan
niejednoznaczny i zachowuje lease. Task wraca do `Queued`, ale nowy attempt nie
jest wybierany bez schedulera. Worker ograniczenie ponawia tylko przejściową
kontencję writera podczas odczytów przed efektem.

Managed dowody: automatic-retry E2E **1/1 PASS** (`8728e721...`), success E2E
**1/1 PASS** (`5d7f89a8...`), cancel E2E **1/1 PASS** (`0e45731c...`),
pre-start cancel E2E **1/1 PASS** (`f9b68085...`), supervisor **PASS**
(`401ff0a6...`), session persistence **PASS** (`000cf93e...`) i API source
**PASS** (`aa663914...`). Testy konfiguracji tras: **20/20 PASS**. Nadal
otwarte są atomowe domknięcie okna release→decision, orphan recovery, zdalny
`StopAck`, scheduler/pula i pozostałe lane'y. **P3 68%, P5 27%, całość około
32%**. Szczegóły:
[p3/36-supervisor-automatic-retry.md](p3/36-supervisor-automatic-retry.md).

## P3-B/P5-B — restartowe recovery retry — 26.09.2026

Decyzja retry jest zapisywana przed release lease. Restart supervisora przy
terminalnym tasku odtwarza jedną decyzję dla dokładnego attempt/epoch, zwalnia
zachowany lease i idempotentnie ustawia `Queued` przed próbą spawnu. Brak
decyzji nie uprawnia do takeover. Process E2E wymusza awarię po journalu i
potwierdza recovery przez drugi supervisor z nieistniejącym worker executable.

Managed dowody: retry-recovery E2E **1/1 PASS** (`c4d5ac21...`), automatic
retry E2E **1/1 PASS** (`ef77e2d2...`), success E2E **1/1 PASS**
(`83207117...`), supervisor **PASS** (`c5b02c0e...`), session persistence
**PASS** (`b32fed48...`) i API source **PASS** (`9b4e2ac7...`). Testy tras:
**21/21 PASS**. Otwarte są orphan recovery sprzed trwałej decyzji, automatyczny
dispatch nowego attemptu, zdalny `StopAck`, scheduler/pula i pozostałe lane'y.
**P3 69%, P5 30%, całość około 33%**. Szczegóły:
[p3/37-supervisor-retry-recovery.md](p3/37-supervisor-retry-recovery.md).

## P3-B/P5-B — receipt wyjścia procesu i orphan recovery — 27.09.2026

Supervisor zapisuje `worker_process_exit_receipt.v1` dopiero po zreapowaniu
potomka i przed terminalnym eventem, decyzją retry lub release. Receipt wiąże
dokładny attempt/epoch, resource/token oraz ostatni heartbeat lease. Restart
może przejąć martwy slot na podstawie tego dowodu, odtworzyć claim i journal,
a następnie domknąć sukces, anulowanie albo retry bez ponownego spawnu.

Process E2E wymusza twardą awarię pierwszego supervisora natychmiast po
receipcie. Drugi proces dostaje nieistniejące binarium workera, zapisuje jedną
decyzję, zwalnia exact lease i przywraca `Queued`: **1/1 PASS**, receipt
`2cc7eed7314f48f6b7a11163c242257f`. Ponowione kontrole zwykłego sukcesu oraz
anulowania żywego procesu mają **1/1 PASS** (`7d6fb25844954b45a6311f0ceed15ab8`,
`81b3c2242b6c492db088a5aa7d0d2131`). Wszystkie trzy przypinają content
`689d19d7f8fd5e11828f04a3fc166a1d1a71c861c8bf24167ae0c5b9c6dd615f` i
`source_changed_during_run=false`. Worker ponawia chwilowy `StoreWriterBusy`
wyłącznie dla idempotentnych odczytów durable store i zapisu payloadu do CAS.
Błąd pollingu kontroli kończy i reapuje potomka, zachowując przyczynę; błąd
przed receiptem zachowuje slot fail-closed. Regresja tej ścieżki ma **1/1 PASS**.
Pełna bramka sesji, w tym fencing,
idempotencja, reachability i `.fms`: **65 + 9 + 13 PASS**, receipt
`c7768a2914ce4fe19dae02424d4894c5`, content
`08dbc187ee1665b2eeee733369dcc5907195ff556dbc1da25d1811d6003875bc`,
`source_changed_during_run=false`. Rejestr tras: **24/24 PASS**.

Lokalne orphan window sprzed decyzji jest zamknięte dla FDM CPU. Otwarte są
zdalny ACK/liveness, rezydentna pula wielu runów, fairness, dowód zwolnienia
urządzenia i process E2E pozostałych lane'ów. **P3 74%, P5 36%, całość około
35%**. Szczegóły:
[p3/39-supervisor-process-exit-receipt.md](p3/39-supervisor-process-exit-receipt.md).

## P3-B/P5-B — bounded pula wielu runów — 27.09.2026

Scheduler przyjmuje wiele jawnych RunId, odrzuca duplikaty i wybiera gotowe
taski z deterministycznym kursorem round-robin. Po każdym wykonaniu kursor
przechodzi do kolejnego runu. Limity łącznej liczby tasków i kolejnych pustych
skanów zapewniają skończone wykonanie; sukces resetuje okno bezczynności.

Managed E2E zapisuje i materializuje dwa runy, wykonuje oba przez jeden resource
ID, potwierdza kolejność A → B, terminalne `Succeeded`, artefakty, brak aktywnych
lease'ów oraz jedno ograniczone odpytywanie po wyczerpaniu pracy: **1/1 PASS**,
receipt `164acb699d794dafa882bb8cdbd2983e`, content
`c0c2917e34b81ddbd5a2a7e487d9016fcd63feae7e7309dee1358e6eda3031bc`,
`source_changed_during_run=false`. Rejestr tras: **25/25 PASS**. Implementacja:
`40e2475f66631587c26329004fbfa677e1457274`.

Pula pozostaje lokalna, statyczna i sekwencyjna. Rezydentna usługa, dynamiczne
discovery, trwały kursor fairness, wiele równoległych zasobów, zdalny
heartbeat/Stop ACK oraz pozostałe lane'y są otwarte. **P3 76%, P5 39%, całość
około 36%**. Szczegóły:
[p3/40-multi-run-scheduler-pool.md](p3/40-multi-run-scheduler-pool.md) oraz
[p3/41-scheduler-run-discovery.md](p3/41-scheduler-run-discovery.md).

## P3-B/P5-B — discovery zaakceptowanych runów — 27.09.2026

Opt-in `--discover-runs true` ponownie czyta trwałe `run_intent` przy każdym
skanie, waliduje i sortuje RunId, a kursor round-robin przechowuje jako
tożsamość następnego runu. Tryb jawny i store-discovery są wzajemnie wykluczające.

Managed E2E uruchamia scheduler bez ręcznych RunId, odkrywa dwa intenty,
wykonuje oba taski i potwierdza release lease: **1/1 PASS**, receipt
`ccb8f7f6e5a04b2bb976af262896da70`, content
`91bb5ee9b1fe140635f992525169ef165e7240b4e8b87d701e92fba29a2ca988`,
`source_changed_during_run=false`. Rejestr tras: **26/26 PASS**. Implementacja:
`e6b48e713eb3fe95e06b3411cb9d72c77426b622`.

Discovery pozostaje lokalne, ograniczone czasowo i sekwencyjne. Brakuje
trwałego kursora między restartami, rezydentnej pętli, priorytetów,
backpressure i dynamicznego discovery zasobów. **P3 77%, P5 41%, całość około
36%**. Szczegóły:
[p3/41-scheduler-run-discovery.md](p3/41-scheduler-run-discovery.md).

## P3-B/P5-B — trwały kursor fairness schedulera — 27.09.2026

Opcjonalny `--pool-id` zapisuje lokalny `scheduler_pool_checkpoint.v1` ze
źródłem runów, członkostwem, następnym RunId i monotoniczną sekwencją. Zapis
jest chroniony single-writer lease oraz compare-and-swap. Dla jawnej puli
istniejący checkpoint odrzuca zmianę członkostwa, a identyczne ponowienie jest
idempotentne. Checkpoint powstaje po powrocie supervisora i nie wchodzi do
przenośnego eksportu projektu `.fms`.

Managed E2E dwóch osobnych procesów wykonuje kolejno run A i run B z tym samym
pool ID: **1/1 PASS**, receipt `42ad24467d53494dabaffb3b1522bce7`, content
`81dce51a572b37228b7344610cc52b4cbda6632f4d3b6284fa1aa7feb2385018`,
`source_changed_during_run=false`. Pełna bramka SessionStore: **66 + 9 + 13
PASS**, receipt `ad768b85eda24b0bbdbb30f75b2269fb`; rejestr tras: **27/27 PASS**.
Implementacja: `6f2d2416b272f68f11165ea96f6e9b7325e4755e`.

Nadal otwarte są rezydentna pętla, priorytety, backpressure, dynamiczne
discovery zasobów, zdalny heartbeat/Stop ACK oraz pozostałe lane'y. **P3 78%,
P5 44%, całość około 37%**. Szczegóły:
[p3/42-persistent-scheduler-cursor.md](p3/42-persistent-scheduler-cursor.md).

## P3-B/P5-B — ograniczona statyczna pula zasobów — 27.09.2026

`fullmag-api-accepted-scheduler` przyjmuje powtarzalne, typowane
`--resource-offer`, centralnie wykonuje fenced admission dla wolnych zasobów i
uruchamia równoległe nadzory pod wspólnymi limitami `max_concurrency` oraz
`max_tasks`. Starszy interfejs jednej oferty pozostaje zgodny. Główny proces
sam zapisuje checkpoint fairness, a strażnik dołącza wszystkie aktywne nici
przy każdym wyjściu, także po błędzie.

Managed E2E jednego procesu z dwiema ofertami CPU przechodzi: **1/1 PASS**,
receipt `496cd7e28ee74d9b802df49fb9a6d109`. Końcowa regresja dwóch procesów,
same-resource fencing i kontencji writera: **1/1 PASS**, receipt
`cf71502a403641b98139bd4e6859fefc`. Oba receipty mają content
`504511447248ae44101f412be5036ce41d0e26e3af08633ebef420af4a2da1f5` i
`source_changed_during_run=false`. Rejestr tras: **29/29 PASS**. Implementacja:
`df69370d2`.

To nadal bounded, statyczny przebieg. Brakuje rezydentnej pętli, dynamicznego
discovery zasobów, priorytetów, backpressure, transportu CLI, zdalnego
heartbeat/Stop ACK, process E2E pozostałych lane'ów i dowodu zwolnienia
urządzenia. **P3 81%, P5 53%, całość około 39%**. Szczegóły:
[p3/45-bounded-static-resource-pool.md](p3/45-bounded-static-resource-pool.md).

## P3-B/P5-B — bezpieczny drain rezydentnego schedulera — 27.09.2026

`--max-tasks 0` oznacza brak limitu wyłącznie przy `--resident true`.
`SIGINT`/`SIGTERM` na Unix oraz `CTRL_C`/`CTRL_BREAK` na Windows zatrzymują nowe
admission, a scheduler dołącza aktywne nadzory, zapisuje checkpointy i zwalnia
lease przed wyjściem `status=drained`. Worker Windows działa w osobnej grupie
procesu, więc sygnał grupy schedulera nie przerywa aktywnego taska.

Managed drain E2E: **PASS**, receipt `35134cc2923e409bb174a2353fe2023f`.
Trwały kursor: **PASS**, receipt `90c10f0258d341969241aa3a8a8adcaf`.
Dwie kolejne próby statycznej puli: **PASS**, receipty
`19d19fe847d54ac39fc27bb8b3a1fddf` i `708db2cbb93545c691662e2e364baeac`.
Wszystkie przypinają content
`cf27b562fe77b7e597d5750c2c75ad6e88d90c500be2d115a71d4f8ac3df89b6` i
`source_changed_during_run=false`. Rejestr tras: **31/31 PASS**. Implementacja:
`78e747ee400a65158d3037b6831e714d97a55154`.

Dynamiczne członkostwo zasobów, priorytety/backpressure, zdalny heartbeat/Stop
ACK, process E2E pozostałych lane'ów i kwalifikacja release pozostają otwarte.
**P3 83%, P5 60%, całość około 41%**. Szczegóły:
[p3/47-resident-scheduler-drain.md](p3/47-resident-scheduler-drain.md).

## P3-B/P5-B — fail-closed budżet oferty solvera — 27.09.2026

Centralna granica zgodności claimu wymaga teraz kompletnego budżetu CPU/RAM/
storage dla CPU i GPU oraz VRAM zgodnego z lane'em. Niepełna oferta jest
odrzucana przed utworzeniem attemptu i lease'u. Test-first: RED **3 PASS / 2
FAIL**, receipt `22a25b308d5045d2af180be6b5023132`; końcowa bramka
`runtime-control` **5/5 PASS**, receipt
`e1db7ebf48674bab877249d6761ae0e9`, content
`f5f644c92a85c557916fa62b97c373efb3bd69f587e5c56ef0175615bbb14a6a`,
`source_changed_during_run=false`. Implementacja:
`07d2938891675f8bfb2d770672334c2cbda775d7`.

Procesowa bramka statycznej puli nie jest stabilna: jedna próba PASS, kolejne
FAIL przez `session store writer is busy` albo brak overlapu. Nie ma jeszcze
per-task minimum, agregacji pojemności ani egzekwowania limitów hosta/GPU.
Procenty pozostają bez zmian: **P3 83%, P5 60%, całość około 41%**. Szczegóły:
[p3/48-solver-resource-budget-admission.md](p3/48-solver-resource-budget-admission.md).

## P3-B/P5-B — stabilne współbieżne retry writera — 27.09.2026

Stałe 10-ms ponowienia ustawiały scheduler, supervisory i workery w lockstep.
Wspólna polityka zachowuje pięciosekundowy deadline i dokładną operację, lecz
stosuje jitter PID/wątek/próba. Inne błędy niż `StoreWriterBusy` nadal nie są
ponawiane. Diagnostyczny RED: oba workery `Failed`, receipt
`6df0cec6e8d74fcfadda92c684c6861e`. GREEN na identycznym końcowym źródle:

- `runtime-control` 5/5 PASS — `2405575ca3ca4929930bc08e598a1d9e`,
- supervisor 9/9 PASS — `5a85bf1e8d3b49469ede3b96b5072650`,
- statyczna pula 1/1 PASS dwa razy — `65becc3ffb0c4a35870fc5b18adb4a69`
  i `b0ed828fd2054ede8583ce2fab7ada80`,
- wymuszona kontencja dwóch zasobów 1/1 PASS —
  `4a44c4639e7d45808910d581348d17c0`.

Procesowe receipty przypinają content
`0e0521139d107f5b6c97a103b684a1018cf012aa7958ac7f950d86fa3b33c086`
i `source_changed_during_run=false`. Implementacja:
`7865603f07fb3ad9b52f70c6e67678a974121406`. Przyrost stabilizuje już
policzony zakres, więc pozostaje **P3 83%, P5 60%, całość około 41%**.
Szczegóły: [p3/49-writer-retry-jitter.md](p3/49-writer-retry-jitter.md).

## P3-B/P5-B — dynamiczna trwała pula zasobów — 27.09.2026

`scheduler_resource_pool.v1` zapisuje monotoniczne snapshoty członkostwa przez
compare-and-swap. Rezydentny scheduler odczytuje je przy każdym skanie i
kluczuje aktywne nadzory stabilnym `resource_id`. Usunięcie zasobu blokuje nowe
admission, lecz nie odbiera lease już uruchomionemu workerowi. Publikator puli
wchodzi do portable bundle i Windows MSI.

Końcowe process E2E publikuje pustą pulę, następnie A, a podczas `Running`
usuwa A i publikuje B. Oba taski kończą się na właściwych zasobach, oba lease'y
są zwolnione: **1/1 PASS**, receipt `aee0b2e7111f49fa85f05e591446e0eb`,
content `01f81e6636c4944eb52919452e19526e842fe24a17b07392eb13ff1051ddbec6`,
`source_changed_during_run=false`. Statyczna pula i resident run discovery
także przechodzą (`8ea59c9d44f64d868e6276268fba73b1`,
`f3e6e263d3a340e1a759873f4871dad3`), a kontrakt dystrybucji ma **12/12 PASS**.

Nadal otwarte są automatyczne discovery pojemności, priorytety/backpressure,
zdalny heartbeat/Stop ACK, process E2E GPU/FEM oraz dowód zwolnienia urządzenia.
**P3 84%, P5 64%, całość około 42%**. Szczegóły:
[p3/50-dynamic-resource-pool.md](p3/50-dynamic-resource-pool.md).

## P3-B/P5-B — minimalne wymagania zasobowe runu — 27.09.2026

`run_spec.v2` wymaga jawnego `minimum_resources` dla CPU, RAM, VRAM i storage.
Scheduler porównuje pełny budżet i klasę urządzenia przed pierwszą mutacją
queue/claim/admission; readback runu i lista runów udostępniają wymagania przez
wygenerowany kontrakt OpenAPI v2. Legacy `run_spec.v1` pozostaje czytelny bez
nowego pola.

Source-only API/application/runtime-control **PASS**, receipt
`206be62e3e324810874101b74477cb2c`. Generacja OpenAPI, typów i klienta,
Control Room typecheck oraz API hygiene **PASS**. Regresje Rust i process E2E
pozostają **NOT RUN** z powodu aktywnego zakazu kompilowania testów
jednostkowych; nie są zastępowane dowodem source-only. P3 wynosi **85%**, P5
**65%**, a całość około **42%**. Szczegóły:
[p3/51-task-resource-requirements.md](p3/51-task-resource-requirements.md).

## P3-B/P5-B — lokalne discovery pojemności zasobów — 27.09.2026

`fullmag-api-resource-pool` wykrywa logiczne CPU, dostępny RAM, wolne miejsce
na filesystemie store oraz wolny VRAM NVIDIA. Jawne rezerwy są odejmowane
przed równym podziałem CPU/RAM/storage między ofertę CPU i wykryte GPU; każde
GPU zachowuje własny UUID i VRAM. Brak wymaganej karty albo przekroczona rezerwa
kończy publikację fail-closed.

Source-only check binarki **PASS**, receipt
`bdbc2e6b74ff4f09ba55074b1e4509b1`. Managed `dry-run` na bieżącym hoście
wykrył 48 logicznych CPU, 96 988 733 440 B dostępnego RAM, 29 014 499 328 B
storage i jedną kartę NVIDIA z 8 987 344 896 B wolnego VRAM: **PASS**, receipt
`0689f7a754844492a208b379996b9e85`. Próba nie publikuje do SessionStore i nie
uruchamia solvera; pełne process E2E pozostaje otwarte. P3 wynosi **85%**, P5
**68%**, a całość około **43%**. Szczegóły:
[p3/52-local-resource-capacity-discovery.md](p3/52-local-resource-capacity-discovery.md).

## P3-B/P5-B — process E2E discovery i lease — 27.09.2026

Zarządzana recepta zbudowała rzeczywiste binaria API, publishera, schedulera i
workera bez targetów testowych. Publiczny Submit przyjął `run_spec.v2`,
publisher zapisał generację 1 wykrytej puli, scheduler wykonał dokładnie jeden
task FDM CPU na odkrytej ofercie, a ponownie uruchomione API zwróciło
`succeeded` z zachowanymi minimami. Trwały lease ma `released` i niepuste
`released_at`: **PASS**, receipt `61dc4f8fb04345e889207ca3aecaa47a`;
`source_changed_during_run=false`. P3 wynosi **87%**, P5 **72%**, a całość
około **44%**. Szczegóły:
[p3/53-resource-discovery-process-e2e.md](p3/53-resource-discovery-process-e2e.md).

## P3-B/P5-B — produkcyjny transport CLI accepted runu — 27.09.2026

`fullmag submit-run-json` odczytuje ograniczony rozmiarem immutable accepted-run
JSON, waliduje typowane identyfikatory projektu i runu, a następnie wykonuje
publiczny Submit, materializację oraz readback przez API v2. Zarządzane process
E2E użyło rzeczywistej binarki CLI przed publikacją puli, admission, wykonaniem
workera FDM CPU i zwolnieniem dokładnego lease: **PASS**, receipt
`3bc1a29aa19c42f396f2cb77ddb710ee`;
`source_changed_during_run=false`. Legacy `run-json` nadal wymaga osobnego
cutoveru. P3 wynosi **88%**, P5 **74%**, a całość około **45%**. Szczegóły:
[p3/54-cli-accepted-run-transport.md](p3/54-cli-accepted-run-transport.md).

## P3-B/P5-B — immutable priority i bounded queue — 27.09.2026

`run_spec.v2` zachowuje `scheduling_priority` w zakresie `-1000..1000`, a
publiczny readback pojedynczego runu i listy runów zwraca tę wartość. Scheduler
wybiera wyższy priorytet przed niższym i zachowuje round-robin w tej samej
klasie. `--max-queued-runs` ogranicza lokalne okno bez mutowania runów poza nim.

Managed E2E przyjęło pięć runów o priorytetach `10`, `0`, `0`, `0`, `-10`;
przy limicie `2` zaraportowało peak kolejki `5`, trzy runy odsunięte i wykonało
kolejno `10`, `0`, `0`, `0`. Run `-10` zachował `accepted`, a cztery lease'y
zostały zwolnione. Dodatkowy niematerializowany run priorytetu `100` pozostał
poza gotową kolejką: **PASS**, receipt `f36023b7219c4122ad3e1943cf376cac`;
`source_changed_during_run=false`. Managed OpenAPI codegen: **PASS**, receipt
`fc5c8a8086894cc6af08b4a531a973eb`. Limit/backpressure publicznego Submitu
pozostaje otwarty. P3 wynosi **89%**, P5 **76%**, a całość około **46%**.
Szczegóły:
[p3/55-priority-and-bounded-queue.md](p3/55-priority-and-bounded-queue.md).

## P3-B/P5-B — atomowy limit publicznego Submitu — 27.09.2026

`POST /v2/persistence/projects/{project_id}/runs` ma teraz dodatni, rozstrzygany
przy starcie limit nieterminalnych accepted runów. Idempotentny replay omija
admission, a nowe przyjęcie i kontrola pojemności używają tego samego writer
locka `SessionStore`. Pełny backlog zwraca `429/run_backlog_full` bez publikacji
`run_intent.json`; miejsce zwalnia dopiero niepusty katalog, którego wszystkie
taski są terminalne.

Managed process E2E przy limicie `6` potwierdziło sześć przyjęć, replay
`200/replayed`, odmowę siódmego payloadu `429`, brak jego intentu oraz późniejsze
`201/accepted` po terminalnym zakończeniu czterech runów: **PASS**, receipt
`407dc187d1b44d2cb8b8c04d4cd5699d`, `source_changed_during_run=false`.
Managed OpenAPI codegen: **PASS**, receipt
`1c4fe9ab6d34414a9e9dcd40b2ba2478`; generator typów i API hygiene także
przeszły. Zdalny heartbeat/Stop ACK, pozostałe lane'y i legacy `run-json`
cutover pozostają otwarte. **P3 90%, P5 78%, całość około 47%**. Szczegóły:
[p3/56-public-submit-backpressure.md](p3/56-public-submit-backpressure.md).

## P3-B/P5-B — durable worker control ACK — 27.09.2026

`worker_protocol.v3` wprowadza atomowy wspólny watermark command/event,
durable Heartbeat obsługiwany przez worker, fizyczne odnowienie lease dopiero
po `HeartbeatAck`, worker-originated `Stopped` oraz barierę `Completing` przed
outputami i `Completed`. Supervisor po Stop nie tworzy kolejnych heartbeat i
czeka na normalny exit przed release.

Source check: **PASS**, receipt `3467a65769be4235bf64e87bfcd1e2f3`.
Managed process E2E czterech sukcesów i osobnego publicznego anulowania:
**PASS**, receipt `ee5c9689c1af4be7b11797c3815d960b`. Testy jednostkowe
pozostają **NOT RUN** zgodnie z zakazem kompilowania targetów testowych.
Transport cross-host, FDM GPU, FEM CPU/GPU, dowód zwolnienia urządzenia i
release qualification pozostają otwarte. **P3 92%, P5 84%, całość około
48%**. Szczegóły: [p3/57-worker-control-ack.md](p3/57-worker-control-ack.md).

## P4-B — accepted-run native FEM preparation — 27.09.2026

`fullmag-plan` i `AcceptedStudySnapshot` tworzą FEM preparation plan/receipt
związany bezpośrednio z immutable RunSpec, krokiem i kanonicznym ProblemIR.
Nowe binarium `fullmag-api-accepted-fem-preparer` odtwarza krok z RunId/TaskId,
wymaga nieprzejętego accepted taska, uruchamia bezstanowy native mesh/H1
producer i idempotentnie publikuje task-scoped receipt. Istniejący receipt jest
walidowany i replayowany bez ponownej pracy native; Live state nie uczestniczy
w tej ścieżce.

Source check plan/runtime/API i osobnego binarium oraz scoped format/diff check:
**PASS**. Managed native build i process E2E pozostają **NOT VERIFIED** —
`just runner-container-status` zwrócił `Docker Desktop coordinator request
failed`; nie zastosowano hostowego obejścia. Automatyczny admission/supervisor
zasobu `Meshing` i accepted worker FEM CPU pozostają otwarte. **P4 50%, całość
około 49%**. Szczegóły:
[p4/03-accepted-run-fem-preparation.md](p4/03-accepted-run-fem-preparation.md).

## P4-B — preparation resource lease — 27.09.2026

ADR-0037 rozdziela własność zasobu meshowania od solverowego
`resource_lease.v1`. Implementacja `preparation_resource_lease.v1` utrwala
RunId/TaskId/preparation attempt, budżet, token i heartbeat, wymaga
nieprzejętego taska `Accepted/Blocked` oraz odrzuca task z gotowym receiptem.
Store egzekwuje globalną wyłączność resource_id między lease przygotowania i
solvera. Eksport FMS, store reachability i archive preflight walidują rekordy
także przed powstaniem solverowego run manifestu.

`cargo check --locked -p fullmag-session -p fullmag-api --bin
fullmag-api-accepted-fem-preparer` i diff check: **PASS**. Testów jednostkowych
nie kompilowano zgodnie z aktywnym zakazem. Pula, admission, supervisor,
process exit receipt i lease-fenced publikacja preparation receiptu pozostają
otwarte; managed native FEM i process E2E są **NOT VERIFIED**. **P4 50%, cały
plan około 49%**. Szczegóły:
[p4/04-preparation-resource-lease.md](p4/04-preparation-resource-lease.md).

## P4-B — lease-fenced FEM receipt — 27.09.2026

Accepted FEM preparer wymaga teraz resource_id, preparation attempt i tokenu.
Store odczytuje trwały lease ponownie pod writer lockiem i publikuje nowy
receipt tylko dla aktywnej, dokładnie zgodnej własności RunId/TaskId/attempt.
Replay identycznego receiptu pozostaje idempotentny i nie ponawia native pracy.

Source check session/API/preparera i diff check: **PASS**. Testów jednostkowych
nie kompilowano zgodnie z zakazem; managed native FEM i process E2E są **NOT
VERIFIED**. Pula, admission, supervisor, exit receipt, recovery i finalizacja
readiness pozostają otwarte. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/05-lease-fenced-fem-receipt.md](p4/05-lease-fenced-fem-receipt.md).

## P4-B — preparation resource pool — 27.09.2026

Osobny `preparation_resource_pool.v1` przechowuje generacyjny snapshot ofert
Meshing z dodatnimi CPU/RAM/storage i zerowym VRAM. Publisher obsługuje jawne
oferty, pustą pulę, dry-run i CAS. Admission preparation lease atomowo
sprawdza trwałą generację, resource_id i budżet przed kontrolą taska oraz
globalnej wyłączności z solverem.

Source check session/API, publishera i preparera, format nowego binarium oraz
diff check: **PASS**. Testów jednostkowych nie kompilowano; managed process i
native FEM E2E są **NOT VERIFIED**. Scheduler, supervisor, exit receipt i
recovery pozostają otwarte. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/06-preparation-resource-pool.md](p4/06-preparation-resource-pool.md).

## P4-B — preparation process exit receipt — 27.09.2026

`preparation_process_exit_receipt.v1` utrwala dowód zebrania procesu preparera
i jest fenced do RunId/TaskId/preparation attemptu, resource_id, tokenu oraz
ostatniej sekwencji heartbeat. Store publikuje go tylko przy aktywnym lease,
obsługuje identyczny replay i recovery. FMS pack, store reachability i archive
preflight zachowują typowany receipt także przed solverowym run manifestem.

Source check session/runtime-control/API i obu binariów oraz diff check:
**PASS**. Testów jednostkowych nie kompilowano. Supervisor, atomowa finalizacja
readiness/release, process E2E i native FEM pozostają otwarte. **P4 50%, cały
plan około 49%**. Szczegóły:
[p4/07-preparation-process-exit-receipt.md](p4/07-preparation-process-exit-receipt.md).

## P4-B — preparation exit finalization — 27.09.2026

Store finalizuje preparation attempt tylko z identycznym durable exit
receiptem i lease. Sukces wymaga immutable FEM preparation receiptu, zmienia
readiness na dependency resolution, podnosi rewizję katalogu i dopiero potem
zwalnia zasób. Awaria pozostawia task w stanie oczekiwania, lecz release nadal
wymaga exit receiptu. Replay naprawia przerwanie między projekcją katalogu i
lease; bezpośredni release po trwałym exit jest blokowany.

Source check session/runtime-control/API i obu binariów oraz diff check:
**PASS**. Testów jednostkowych nie kompilowano. Supervisor, process E2E i
native FEM pozostają **NOT VERIFIED**. **P4 50%, cały plan około 49%**.
Szczegóły:
[p4/08-preparation-exit-finalization.md](p4/08-preparation-exit-finalization.md).

## P4-B — preparation process launch intent — 27.09.2026

`preparation_process_launch.v1` jest immutable granicą przed spawnem i wiąże
task, preparation attempt, resource, token, sekwencję heartbeat oraz proces
supervisora. Tylko pierwszy zapis `Accepted` uprawnia do uruchomienia potomka;
identyczny replay po restarcie zachowuje niejednoznaczność i nie pozwala na
drugi spawn. Exit receipt wymaga dokładnie jednego zgodnego launch intentu.
FMS pack i oba walkery reachability walidują rekord także bez solverowego run
manifestu.

Source check session/runtime-control/API i obu binariów oraz diff check:
**PASS**. Globalny fmt check ma wcześniejszy baseline drift w wielu
niezmienionych plikach. Testów jednostkowych nie kompilowano. Supervisor,
process E2E i native FEM pozostają **NOT VERIFIED**. **P4 50%, cały plan około
49%**. Szczegóły:
[p4/09-preparation-process-launch-intent.md](p4/09-preparation-process-launch-intent.md).

## P4-B — accepted FEM preparation supervisor — 28.09.2026

`fullmag-api-accepted-fem-preparation-supervisor` wykonuje pojedynczy proces na
dokładnym preparation lease. Recovery finalizuje trwały exit bez ponownego
spawnu i odrzuca launch bez exit jako niejednoznaczny. Świeży przebieg wymaga
nowego `Accepted` launch intentu, odnawia heartbeat, egzekwuje timeout, czeka na
potwierdzony exit, publikuje fenced receipt i dopiero potem finalizuje
readiness/release.

Source check supervisora i preparera, rustfmt nowych plików oraz diff check:
**PASS**. Testów jednostkowych nie kompilowano. Rezydentny scheduler, managed
process E2E i native FEM pozostają **NOT VERIFIED**. **P4 50%, cały plan około
49%**. Szczegóły:
[p4/10-accepted-fem-preparation-supervisor.md](p4/10-accepted-fem-preparation-supervisor.md).

## P4-B — atomowy preparation admission i scheduler — 28.09.2026

Store atomowo rezerwuje task i resource z dokładnej generacji puli, odrzuca
drugi aktywny lease tego samego taska i udostępnia typowaną listę aktywnych
preparation lease do recovery. Rezydentny scheduler wykrywa accepted taski,
respektuje immutable priority, pulę i bounded concurrency, odzyskuje aktywne
lease, uruchamia supervisor oraz wykonuje drain po sygnale. Failed exit nie
powoduje automatycznej pętli retry.

Source check session i czterech binariów, rustfmt schedulera oraz diff check:
**PASS**. Testów jednostkowych nie kompilowano. Managed scheduler/process/native
FEM E2E pozostaje **NOT VERIFIED**. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/11-preparation-admission-scheduler.md](p4/11-preparation-admission-scheduler.md).

## P4-B — dystrybucja runtime preparacji FEM — 28.09.2026

Pakiety portable Linux i Windows MSI zawierają teraz preparer, supervisor,
scheduler oraz publisher generacyjnej puli zasobów preparacji FEM. Walidator
portable sprawdza obecność, zależności dynamiczne i RPATH każdego procesu, a
MSI obejmuje je stagingiem, manifestem i kontrolą kompletności. Kontrakt
źródłowy wydania pilnuje pełnej listy accepted-runtime.

Parsery Bash, PowerShell i Python, statyczna kontrola pokrycia pakowania oraz
diff check: **PASS**. Testów jednostkowych nie kompilowano. Build rzeczywistych
paczek oraz managed scheduler/process/native FEM E2E pozostają **NOT
VERIFIED**. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/12-preparation-runtime-distribution.md](p4/12-preparation-runtime-distribution.md).

## P4-B — trwały kursor fairness preparacji — 28.09.2026

Scheduler preparacji ma teraz osobny lokalny checkpoint puli z monotoniczną
sekwencją i następnym RunId. Priority pozostaje nadrzędne, a round-robin działa
wewnątrz równej klasy; zmiany membership są dozwolone dla store discovery.
Checkpoint jest publikowany dopiero po zakończeniu supervisora i chroniony
writer lockiem oraz CAS. Recovery aktywnego lease nie przesuwa kursora.

Source check session i schedulera, scoped rustfmt i diff check: **PASS**.
Regresja store została dodana, ale nie uruchomiona z powodu zakazu kompilacji
testów jednostkowych. Restart/process E2E i native FEM pozostają **NOT
VERIFIED**. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/13-preparation-scheduler-fairness.md](p4/13-preparation-scheduler-fairness.md).

## P4-B — jawna decyzja retry preparacji FEM — 28.09.2026

`preparation_retry_decision.v1` wiąże dokładny failed preparation attempt,
ciągły numer retry, stały `max_attempts` i przyczynę operatora. Store wymaga
trwałego failed exit oraz sfinalizowanego lease. Scheduler blokuje task do
czasu decyzji, a atomowy admission odrzuca kandydata wyliczonego dla starszej
sekwencji. Kolejna awaria ponownie wymaga nowej decyzji; limit nie może zostać
podniesiony po pierwszym retry.

CLI publikujące decyzję jest częścią portable Linux i Windows MSI, a FMS i
reachability zachowują jej typowaną tożsamość. Source check, scoped rustfmt,
parsery dystrybucji, statyczna kontrola pakowania i diff check: **PASS**.
Regresja store została dodana, lecz nie uruchomiona z powodu zakazu kompilacji
testów jednostkowych. Managed process/native FEM E2E i rzeczywiste paczki
pozostają **NOT VERIFIED**. **P4 50%, cały plan około 49%**. Szczegóły:
[p4/14-preparation-retry-decision.md](p4/14-preparation-retry-decision.md).

## P4-B — bramka procesu accepted FEM preparation — 28.09.2026

Commit `b1066e761` dodaje stałą bramkę produkcyjnego procesu oraz kanoniczny
fixture immutable RunSpec `FEM/CPU/double/strict`. Trasa buduje native FEM i
procesy API/CLI z jedną tożsamością źródeł, składa run przez publiczne HTTP,
publikuje osobny zasób `Meshing`, uruchamia scheduler/supervisor/preparer i
sprawdza zgodność preparation receiptu, launch/exit receiptów, zwolnionego lease
oraz publicznego readiness po sukcesie. Receipt bramki zachowuje hashe każdego
artefaktu i jawnie wyłącza solver, fizykę oraz release qualification.

Generacja fixture przez typy Rust, Python AST/help, dry-run recepty,
produkcyjny source check pięciu binariów i diff check: **PASS**. Managed native
process E2E jest **NOT VERIFIED**: `just runner-container-status` nadal kończy
się `Docker Desktop coordinator request failed`; hostowego obejścia nie użyto.
**P4 50%, cały plan około 49%**. Szczegóły:
[p4/15-accepted-fem-preparation-process-gate.md](p4/15-accepted-fem-preparation-process-gate.md).

## P4-C — zachowanie ostatniej poprawnej siatki w UI — 28.09.2026

Explorer i Mesh Inspector rozróżniają teraz nieudanego kandydata od ostatniej
opublikowanej siatki. UI pokazuje zachowaną nazwę, rewizję, build i generację,
ale deklaruje `retained` tylko przy kompletnej opublikowanej tożsamości. Przy
braku tej tożsamości przechodzi fail-closed do `identity unavailable`.

Typecheck, scoped ESLint i browser smoke: **PASS**. Smoke potwierdził zachowanie
panelu, focusu i pozycji przewijania oraz zdrowy canvas WebGL
(`contextLost=false`, drawing buffer `703×478`). Regresje jednostkowe zostały
dodane, lecz nie uruchomione zgodnie z aktywnym zakazem ich kompilacji.
Managed/native process E2E pozostaje **NOT VERIFIED**. **P4 50%, cały plan około
49%**. Szczegóły:
[p4/16-mesh-last-good-ui.md](p4/16-mesh-last-good-ui.md).
