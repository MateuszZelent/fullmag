# Fullmag — finalny audyt i plan refaktoryzacji

Data audytu: 20.09.2026. Rewalidacja checkpointu: 23.09.2026. Baza audytu: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, lokalny `master`.

**Werdykt:** zachować projektowy kierunek CAE, ale wdrażać go po zabezpieczeniu persystencji, uzgodnieniu istniejących kontraktów i ustaleniu jednej tożsamości wykonania. Refaktoryzacja obejmuje authoring, Python/IR, planowanie, wykonanie, FDM/FEM CPU/GPU, storage, API, Control Room, desktop oraz kwalifikację. Nie oznacza przepisywania wszystkich solverów ani automatycznego rozszerzenia zakresu fizyki.

Aktualny checkpoint implementacyjny na `masterze`: **P0 około 85%**, **P1 około 98%**, **P2 około 59%**, **P3 około 59%**, **P3a około 90%**, **P4 około 50%**, **P5 około 8%**. P3 obejmuje typed `StudyPlan v2`, jawne `study_execution_plan.v2` z przypiętym per-step `until_seconds`, immutable `study_problem_catalog.v1` i lowering do canonical `fullmag-plan`, RunSpec, durable catalogs/leases, worker protocol, `WorkerCoordinator`, idempotentne zastosowanie retry, ograniczony one-shot worker dla FDM CPU oraz supervisor procesu z pojedynczym slotem, obserwacją exit, wymaganym jawnym timeoutem, potwierdzonym zakończeniem potomka przed rekoncyliacją, completion reconciliation i zwolnieniem dokładnego lease. P4 ma source-level `PreparationPlan`, pięciu producerów, certyfikaty quality/marker/space, selective reuse, jawny state transfer, materializację FDM z resolved `ExecutionPlanIR`, application `PreparationReceipt`, hashujący `PreparationBinding` w `ResolvedTaskInput`, wymaganie pełnego receiptu na granicy `WorkerCoordinator::prepare`, niezmienną publikację receiptu per run, provenance UI, revision-fenced akcje Geometry oraz status Mesh z tożsamością ostatniego poprawnego artefaktu i jego rewizjami. Nadal otwarte są automatyczny scheduler ready-task, pełne subprocess E2E, heartbeat/operator cancel/retry/orphan reconciliation, walidacja pełnej parzystości wszystkich pól authoringu, native FEM mesh/space, pozostałe endpointy P3a oraz pełna kwalifikacja backendów i release. Są to wskaźniki zakresu planu, nie kwalifikacji produkcyjnej. Globalnie daje to około **28%** planu.

## Dokumenty finalne

W rewalidacji 21.09.2026 dodano także trwały, fenced journal
`retry_decision.v1`; wcześniejsze sformułowanie o otwartej decyzji retry należy
czytać jako brak zastosowania decyzji do durable snapshotu i brak automatycznej
polityki supervisora.

Najnowszy checkpoint P3a-A obejmuje także context-bound przyjęcie komendy
obliczeniowej, binarny odczyt FMRM, listę/pobranie/capture/restore checkpointu i politykę events;
przyrosty P3a-B opakowują cache/decode data preview, planar field, pola modalne,
model/runtime/workspace, meshing, membership/domain, katalogi data-plane,
analysis-result, analysis runtime, diagnostics/runtime explorer, spin-wave,
Frozen Spins, preparation i mode-composition w `session_id + epoch`, a scheduler
odrzuca spóźniony wynik decode po abort, a export/commit archiwum sesji rewalidują
context przed transakcją/publikacją. Recovery list/clear również jest
context-bound. `ResourceRuntimeStore` przekazuje `sessionScopeKey` do
`ControlRoomApi`, więc deduplikacja materializacji pól i sprawdzenia świeżości
meshu jest izolowana per sesja. Odczyty GET wizualizacji oraz istniejące mutacje
PATCH/POST mają teraz backendowy transition fence, a hooki stanu, ACK i
kontrolery mutacji przekazują `sessionScopeKey`; PUT display/state pozostają
otwarte bez typed konsumenta. Status P3a wynosi obecnie **90%**.
Source-level macierz rodzin jest w [`p3a/05-endpoint-coverage.md`](p3a/05-endpoint-coverage.md),
a pełny inventory 300 operacji OpenAPI z ownerem/write policy i statusem
context migration w [`p3a/06-endpoint-owner-policy.md`](p3a/06-endpoint-owner-policy.md).
Migracja 18 operacji `OPEN`, legacy semantics recovery/persistence/events oraz
browser/runtime nadal pozostają otwarte.

1. [Finalny audyt](01-finalny-audyt.md) — ustalenia, rozstrzygnięcia Gemini/Claude, ryzyka i granice dowodów.
2. [Architektura i kontrakty](02-architektura-i-kontrakty.md) — docelowi właściciele, tożsamości, transakcje i decyzje migracyjne.
3. [Produkcyjny plan refaktoryzacji](03-plan-refaktoryzacji.md) — kolejność, pakiety pracy, zależności, bramki i rollback.
4. [Kwalifikacja i scenariusze](04-kwalifikacja-i-scenariusze.md) — zachowane CAE-01–60, skorygowane CAE-61–70 i dodatkowe testy przekrojowe.
5. [Dowody, źródła i uzgodnienie ADR](05-dowody-i-adr.md) — aktualne źródła, rozliczenie wszystkich dokumentów wejściowych i istniejących decyzji.
6. [Checkpoint P2](p2/README.md) — wykonane slice'y izolacji kontekstu Python, kanonicznych bajtów IR, sekwencji cech geometrii i projekcji Model/Component/PhysicsConfiguration.
7. [Checkpoint P3](p3/README.md) — typed studies, `study_execution_plan.v2` i lowering do `fullmag-plan`, RunSpecification, durable catalogs, leases, worker identity, retry decision, coordinator journal, przypięty horyzont TimeEvolution, one-shot worker oraz supervisor pojedynczego procesu z jawnym timeoutem i durable recovery; scheduler i pełne crash/orphan recovery pozostają otwarte.
8. [Checkpoint P3a](p3a/README.md) — pilot immutable request context oraz kolejne przyrosty sesyjnej tożsamości klienta dla data-plane i resource hooks; pełny inventory endpointów jest w [macierzy owner/write policy](p3a/06-endpoint-owner-policy.md).
9. [Checkpoint P4](p4/README.md) — `PreparationPlan`, typed producers, FDM materialization z resolved planu, adaptery grid/mesh, application receipt, `PreparationBinding` w wejściu `Prepare` i durable publikacja tożsamości per run.
10. [Tabela statusu całego planu](06-status-realizacji.md) — procenty etapów, wykonane zakresy, dowody i blokery.
11. [Semantic history P2-D](p2/05-semantic-history.md) — revision-fenced Undo/Redo i granice obecnego slice'u.

## Jak używać pakietu

Ten pakiet jest scaloną wersją planistyczną. Materiały w katalogu nadrzędnym oraz `raport_gemini` i `raport_claude` pozostają materiałami wejściowymi; rozstrzygnięcia finalne wskazują, które rekomendacje przyjęto, zmieniono lub odrzucono. Nie należy wykonywać sprzecznej rekomendacji starszego raportu równolegle z finalnym planem.

Nowe kontrakty mają status **PROPOSED — finalna rekomendacja do wdrożenia**. Istniejące ADR i reguły projektu nadal obowiązują; wymagane zmiany normatywne mają osobne zadania przed zależną implementacją. Ten katalog nie nadaje numerów nowym ADR i nie deklaruje ich formalnej akceptacji.

Plan jest przeznaczony do produkcyjnego wdrożenia, ale **produkt nie został tu zakwalifikowany produkcyjnie**. Główne dokumenty są zapisem audytu statycznego i kontroli dokumentów z chwili powstania pakietu; późniejsze wykonanie P0/P1 jest rejestrowane osobno w podkatalogach [`p0`](p0/README.md) i [`p1`](p1/README.md). Nie należy przenosić ich receiptów na pełną kwalifikację wydania: nadal brakuje m.in. power-loss, pełnej rekonsyliacji runtime/session-recovery, ścieżek naukowych i release gate.

Pierwszy krok realizacyjny był P0-A; bieżący checkpoint przeszedł minimalną bramkę P0 i rozszerzył P1-C o lokalny lifecycle dokumentu, browserowy wybór i pobieranie archiwum, hostowy adapter Tauri Save oraz ikonę komendową do chowania Inspektora przez `panelVisible.right`. Dodano też zarządzany smoke runtime-free API z kontrolowanym restartem procesu, zarządzane smoke CLI `fullmag project open` i Python `_fullmag_core.open_project_json`, managed handshake/reconnect WebSocket na pustej sesji, managed active-run reconnect z rzeczywistym FDM CPU oraz browserowy smoke zachowania tego samego workspace/canvasu po reconnect, wszystkie z przypiętą tożsamością źródła tam, gdzie dotyczy to managed runtime. W kolejnym kroku P2 dodano context-bound flat DSL z jawnym `fm.ExecutionContext`, owner fencing uchwytów, wspólne bajty/digest ProblemIR, wersjonowany AST parametrów SI, opisową sekwencję cech geometrii z lineage CSG, niemutowalną projekcję Model/Component/PhysicsConfiguration, revision-fenced semantic Undo/Redo, rejestr aktywnego formularza Inspectora, wrapper staged sessions oraz helper revision-fenced immediate mutations; szczegóły są w [P2](p2/README.md). Pozostaje trwały Rust/browser roundtrip modelu, ewaluacja selekcji/ambiguity, pozostałe bezpośrednie/multistep mutacje, selection/focus, jawna materializacja study/run, fizyczny desktop smoke, runtime Tauri, pełna session-recovery, nauka i release gate. Dokumentacja nie upoważnia do przeskoczenia tych bramek.

Lokalny probe aktywnego FDM wykazał dodatkowo zachowanie `session_id`/`run_id`
i wzrost kroków po zerwaniu i reconnect WebSocket; jest to opisane w
[`p1/06-active-run-reconnect-diagnostic.md`](p1/06-active-run-reconnect-diagnostic.md)
jako historia diagnostyczna. Aktualny dowód zarządzany active-run, z przypiętym
source snapshotem i receipt SHA-256, znajduje się w
[`p1/07-active-run-reconnect-managed.md`](p1/07-active-run-reconnect-managed.md).
Browserowy smoke na aktywnej sesji wykonał przez menu `File` pełny cykl
`New Project → Save Project → Open Project → Save Project → Close Project`,
porównał 942 bajty archiwum 1:1 i potwierdził pustą listę mutacji runtime;
szczegóły są w
[`p1/08-browser-lifecycle-runtime.md`](p1/08-browser-lifecycle-runtime.md).
Kontrolowane zerwanie pierwszego WebSocketu w osobnym smoke zachowało ten sam
`#fm-main-content` i canvas WebGL (`703×478`, `contextLost=false`) po
reconnect z `after_seq=14`; dowód znajduje się w
[`p1/09-browser-mounted-workspace-reconnect.md`](p1/09-browser-mounted-workspace-reconnect.md).
Pozostają statusy Tauri, pełna session-recovery i release gate.

Bieżący browserowy smoke potwierdził również pełny cykl tej ikony: `Hide Inspector` ukrywa `panel-right`, menu `Panel` pokazuje `Inspector = 0`, a ponowna pozycja `Inspector` przywraca panel (`Inspector = 1`).

Ten scenariusz został następnie włączony do automatycznego Playwright smoke
`apps/control-room/scripts/smoke-inspector.mjs`; rewalidacja 21.09.2026 na
`http://localhost:3100/workspace` zakończyła się `exit 0` z wynikiem
`inspectorPanelToggle: verified; header icon and ribbon restore`. Jedyny zliczony
błąd konsoli był oczekiwanym pojedynczym `409 Conflict` z ochrony dirty-selection;
nieoczekiwane błędy oraz powtarzające się konflikty są przez smoke odrzucane.

Dodano także wykonywalny smoke lifecycle projektu
`apps/control-room/scripts/smoke-project-lifecycle.mjs`: `New → Open → Save → Close`
bez sesji, z file chooserem, dwoma downloadami `.fms` i pustą listą mutacji
runtime. Wykonanie zakończyło się `exit 0`.

Po tej zmianie przeprowadzono końcową kontrolę spójności repozytorium, API/architektury Control Room oraz kompilację i testy desktopowego adaptera Tauri: wszystkie kontrole zakończyły się `PASS`. Fizyczny smoke w zbudowanym oknie Tauri pozostaje osobnym gate'em; testy Rust/TS potwierdzają kontrakt mostu, ale nie zastępują interakcji z hostem.

Kontrola pakietu z 21.09.2026: parsery `inventory.json`, `02-baseline-manifest.json` i wygenerowanego OpenAPI przeszły; wszystkie względne linki Markdown w `final/` wskazują istniejące pliki; `python scripts/check_repo_consistency.py` i `git diff --check` zakończyły się powodzeniem. Ostrzeżenia `git diff --check` dotyczą wyłącznie normalizacji LF→CRLF na Windows.
