# Fullmag — finalny audyt i plan refaktoryzacji

Data audytu: 20.09.2026. Rewalidacja checkpointu: 21.09.2026. Baza audytu: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, lokalny `master`.

**Werdykt:** zachować projektowy kierunek CAE, ale wdrażać go po zabezpieczeniu persystencji, uzgodnieniu istniejących kontraktów i ustaleniu jednej tożsamości wykonania. Refaktoryzacja obejmuje authoring, Python/IR, planowanie, wykonanie, FDM/FEM CPU/GPU, storage, API, Control Room, desktop oraz kwalifikację. Nie oznacza przepisywania wszystkich solverów ani automatycznego rozszerzenia zakresu fizyki.

Aktualny checkpoint implementacyjny na `masterze`: **P0 około 85%**, z minimalną bramką przejścia zaliczoną; **P1 około 98%**, z wykonanym A/B, zarządzanym runtime-free smoke CLI i Python bindingu dla wejścia Open D oraz rozszerzonym C (produkcyjny shell zachowuje workspace po pierwszym zamontowaniu, API ma bytes-only adapter projektu, UI ma New/Open/Save/Close projektu rozdzielone od Restore Runtime State, Tauri ma hostowy adapter trwałego Save z kontrolą rewizji, browserowy smoke potwierdził no-session shell, lifecycle projektu, aktywny canvas WebGL i zachowanie tego samego workspace/canvasu po reconnect, managed API smoke sprawdził ponowne otwarcie tych samych bytes po kontrolowanym restarcie procesu, reconnect transportowy wymusza ponowne pobranie autorytatywnego stanu HTTP, managed smoke potwierdził handshake i reconnect WebSocket na pustej sesji, a nowy managed active-run smoke potwierdził zachowanie tego samego session/run podczas pracy FDM CPU). **P2 jest rozpoczęte i ma około 50% zakresu: P2-A ma canonical bytes, wersjonowany AST parametrów SI podpięty do `ProblemIR` i flat/study generated-script round-trip, P2-B ma geometry feature sequence/lineage/transform/selective invalidation, P2-C ma context-bound Python DSL i owner fencing uchwytów, a P2-D ma revision-fenced semantic Undo/Redo przez `replace_scene`, wspólne menu/ribbon/shortcut, registry aktywnego formularza Inspectora, wrapper staged session hooków oraz revision-fenced immediate mutations dla głównych komend i paneli authoringu; pełny Model/Component/PhysicsConfiguration, browser/Rust round-trip, meshing, study/run materialization, pozostałe direct handlers, selection/focus, browserowy Apply → Undo → Redo i inne granice pozostają otwarte.** Są to wskaźniki zakresu planu, nie kwalifikacji produkcyjnej. Globalnie daje to około **21–22%** planu, zaokrąglane operacyjnie do **21%**.

## Dokumenty finalne

1. [Finalny audyt](01-finalny-audyt.md) — ustalenia, rozstrzygnięcia Gemini/Claude, ryzyka i granice dowodów.
2. [Architektura i kontrakty](02-architektura-i-kontrakty.md) — docelowi właściciele, tożsamości, transakcje i decyzje migracyjne.
3. [Produkcyjny plan refaktoryzacji](03-plan-refaktoryzacji.md) — kolejność, pakiety pracy, zależności, bramki i rollback.
4. [Kwalifikacja i scenariusze](04-kwalifikacja-i-scenariusze.md) — zachowane CAE-01–60, skorygowane CAE-61–70 i dodatkowe testy przekrojowe.
5. [Dowody, źródła i uzgodnienie ADR](05-dowody-i-adr.md) — aktualne źródła, rozliczenie wszystkich dokumentów wejściowych i istniejących decyzji.
6. [Checkpoint P2](p2/README.md) — wykonane slice'y izolacji kontekstu Python, kanonicznych bajtów IR oraz sekwencji cech geometrii.
7. [Tabela statusu całego planu](06-status-realizacji.md) — procenty etapów, wykonane zakresy, dowody i blokery.
8. [Semantic history P2-D](p2/05-semantic-history.md) — revision-fenced Undo/Redo i granice obecnego slice'u.

## Jak używać pakietu

Ten pakiet jest scaloną wersją planistyczną. Materiały w katalogu nadrzędnym oraz `raport_gemini` i `raport_claude` pozostają materiałami wejściowymi; rozstrzygnięcia finalne wskazują, które rekomendacje przyjęto, zmieniono lub odrzucono. Nie należy wykonywać sprzecznej rekomendacji starszego raportu równolegle z finalnym planem.

Nowe kontrakty mają status **PROPOSED — finalna rekomendacja do wdrożenia**. Istniejące ADR i reguły projektu nadal obowiązują; wymagane zmiany normatywne mają osobne zadania przed zależną implementacją. Ten katalog nie nadaje numerów nowym ADR i nie deklaruje ich formalnej akceptacji.

Plan jest przeznaczony do produkcyjnego wdrożenia, ale **produkt nie został tu zakwalifikowany produkcyjnie**. Główne dokumenty są zapisem audytu statycznego i kontroli dokumentów z chwili powstania pakietu; późniejsze wykonanie P0/P1 jest rejestrowane osobno w podkatalogach [`p0`](p0/README.md) i [`p1`](p1/README.md). Nie należy przenosić ich receiptów na pełną kwalifikację wydania: nadal brakuje m.in. power-loss, pełnej rekonsyliacji runtime/session-recovery, ścieżek naukowych i release gate.

Pierwszy krok realizacyjny był P0-A; bieżący checkpoint przeszedł minimalną bramkę P0 i rozszerzył P1-C o lokalny lifecycle dokumentu, browserowy wybór i pobieranie archiwum, hostowy adapter Tauri Save oraz ikonę komendową do chowania Inspektora przez `panelVisible.right`. Dodano też zarządzany smoke runtime-free API z kontrolowanym restartem procesu, zarządzane smoke CLI `fullmag project open` i Python `_fullmag_core.open_project_json`, managed handshake/reconnect WebSocket na pustej sesji, managed active-run reconnect z rzeczywistym FDM CPU oraz browserowy smoke zachowania tego samego workspace/canvasu po reconnect, wszystkie z przypiętą tożsamością źródła tam, gdzie dotyczy to managed runtime. W kolejnym kroku P2 dodano context-bound flat DSL z jawnym `fm.ExecutionContext`, owner fencing uchwytów, wspólne bajty/digest ProblemIR, wersjonowany AST parametrów SI, opisową sekwencję cech geometrii z lineage CSG, revision-fenced semantic Undo/Redo, rejestr aktywnego formularza Inspectora, wrapper staged sessions oraz helper revision-fenced immediate mutations; szczegóły są w [P2](p2/README.md). Pozostaje podpięcie parametrów do pełnego Model/Component/PhysicsConfiguration i roundtrip IR, ewaluacja selekcji/ambiguity, pozostałe bezpośrednie/multistep mutacje, selection/focus, fizyczny desktop smoke, runtime Tauri, pełna session-recovery, nauka i release gate. Dokumentacja nie upoważnia do przeskoczenia tych bramek.

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
