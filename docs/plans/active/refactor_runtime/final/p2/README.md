# P2 — authoring, Python i historia edycji

Ten katalog rejestruje wykonane przyrosty P2. P2 nie jest jeszcze ukończone: P2-A ma AST/bibliotekę parametrów, niemutowalny kontrakt `ModelDefinition`/`ComponentDefinition`/`PhysicsConfiguration` po stronie Python, parser wersjonowanego payloadu `authoring_model.v1`, projekcję tego kontraktu po stronie Rust oraz shared canonical digest fixture (Python 12/12 PASS, Rust 104/104 PASS; checkpoint 24.09 w `02-canonical-ir.md`), ale pełne podpięcie display/provenance i GUI/Python/Rust round-trip pozostają otwarte; P2-B ma częściową geometrię/selekcje, P2-C nie ma jeszcze pełnej granicy materializacji, a P2-D ma revision-fenced Undo/Redo, rejestr aktywnego formularza Inspectora, staged history bridge i helper dla wielu immediate mutations. `GeometryObjectPanel` i `ObjectGeneralPanel` są zarejestrowane jako staged formularze; przegląd pozostałych rejestracji i direct handlers nadal pozostaje otwarty.

## Aktualny checkpoint — 24.09.2026

Wykonano implementacyjne slice'y P2-A, P2-B, P2-C oraz kolejne slice'y P2-D. P2-A ma wspólny kontrakt deterministycznych bajtów/digestu ProblemIR, wersjonowany AST parametrów z normalizacją SI, referencjami, diagnostyką cykli i rozdzieleniem display metadata od numerical identity oraz niemutowalną projekcję `Problem.to_model_definition()` z wersjami `authoring_model.v1`, `component_definition.v1` i `physics_configuration.v1`; P2-B ma stabilną sekwencję cech geometrii z lineage wejść CSG, osobną cechą transformacji, jawny wynik `resolved/ambiguous/empty` dla selekcji, selective invalidation domeny oraz Pythonowy evaluator analityczny zgodny z polityką granicy; P2-C ma per-context binding oparty na `ContextVar`, zachowuje dotychczasowe wywołania modułowe i udostępnia jawny `fm.ExecutionContext` / `fm.execution_context()`. `ExecutionContext.materialize_problem()` tworzy immutable `Problem` dopiero na jawnej granicy, w aktywnym ownerze, bez uruchamiania solwera. Zagnieżdżenie przywraca poprzedni binding także po wyjątku. Wartości odziedziczone przez nowy task asyncio są rozdzielane po identyfikatorze właściciela tasku, a praca w osobnym wątku ma własny binding; worker pool powinien otaczać każdy niezależny dokument jawnym `execution_context()`. Uchwyty geometrii, meshingu, magnetyzacji i regionów mają dodatkowo owner fencing: spóźniona mutacja jest odrzucana zamiast trafiać do aktualnego kontekstu. P2-D ma revision-fenced semantic Undo/Redo przez `replace_scene`, wspólne menu/ribbon/shortcut, `PendingFormRegistry` dla aktywnego formularza Inspectora oraz wrapper, który bracketsuje każdą staged sesję wspólnym odczytem sceny przed i po Apply.

Implementacja nie tworzy pseudoklasy `fm.Project`, nie zmienia semantyki fizyki ani formatu `ProblemIR`, nie uruchamia meshera przy wejściu do kontekstu i nie obiecuje jeszcze pełnej izolacji requestu Rust/API po `await`. Projekcja Rust nie tworzy drugiego mutable writer truth i jawnie pozostawia parametry bez wspólnego AST. To jest granica P2-C; fencing requestów i trwała tożsamość projektu należą do P3a.

Immediate authoring mutations korzystają teraz z `authoringHistoryMutation.ts`:
komendy i panele region/coupling, Physics Interaction, texture, absorbing boundary, antenna,
material fields/parameters/assignment, bibliotekę materiałów, wieloetapowe
przypisanie presetowej magnetyzacji, spin/transport delete, spin interface
delete, Spin Torque/Oersted Create/Replace oraz Current/Spin Transport
Create/Replace oraz Spin Interface Create/Replace przekazują uchwyconą
`base_revision` i zapisują jedną
semantyczną historię po potwierdzeniu nowej sceny. Utworzenie monitora z
draftu, Apply monitora, rename/duplicate/delete z komend field-map oraz
Apply/Commit/Delete Frozen Spins są objęte tą samą granicą. Przypisanie
magnetyzacji zachowuje rewizję pomiędzy zapisem assetu i regionu/obiektu oraz
`sessionScopeKey` dla odczytu i obu zapisów; spóźniony ACK kończy komendę bez
drugiego zapisu, historii i invalidacji. API regionu deklaruje 409 dla
niezgodnej rewizji. Wieloetapowe
create→assign materiału zapisuje jeden wpis po pełnym sukcesie, a częściowy ACK
po utworzeniu materiału zapisuje stan częściowy jako osobną zmianę odwracalną.
Odpowiedź zawierająca samą rewizję powoduje dodatkowy odczyt pełnego snapshotu,
więc nie trafia do Undo niekompletna scena.
Komendy `study.add-*`, `hysteresis.continue-to-next-stage` i
`study.remove-selected-stage` również zapisują historię po ACK z tą samą
uchwyconą rewizją. Usunięcie etapu czyści jego zaznaczenie; spóźniony ACK po
zmianie scope nie publikuje invalidacji ani nowego selection. Ukierunkowane
suite'y helpera, komend Study/Run i presetowej magnetyzacji przeszły **101/101**, celowany ESLint oraz
`check:architecture-hygiene` **PASS**.

Ukierunkowane suite'y geometrii, Study Inspector, przywracania selection i
Object General przeszły **106/106**; celowany ESLint bez ostrzeżeń oraz
`check:architecture-hygiene` **PASS**. Typecheck i browserowy Apply → Undo →
Redo pozostają `NOT VERIFIED`.

P2-D/P3a, 24.09: `SpinAuthoringInspector`, `TransportAuthoringInspector` i
`SpinInterfaceInspector` przypinają walidację, zapis i odczyt historii do
`sessionScopeKey`. Zapis oraz usunięcie spin torque/Oersted/current transport/
spin transport i interfejsu używają tego samego scope oraz `base_revision`.
Zmiana sesji lub generacji historii podczas oczekiwania odrzuca spóźnione
skutki lokalne; walidacja nie aktualizuje stanu po zmianie sesji, a znacznik
pending należy do scope i identyfikatora operacji. Dodano asercje źródłowe
dla opcji API i fencing contextu. Typecheck, API hygiene, architecture hygiene
i `git diff --check` **PASS**. Vitest i celowany ESLint **NOT RUN** z powodu
`EPERM` przy ładowaniu pakietów `node_modules`; browser i managed runtime pozostają
**NOT VERIFIED**. P2-D nadal wymaga pełnego audytu pozostałych formularzy oraz
browserowego Apply → Undo → Redo.

## Dowody

- `packages/fullmag-py/tests/test_execution_context.py`: **6 passed** — nesting/exception, odziedziczony stan asyncio, thread isolation z jawnym contextem, przywrócenie capture state, fencing spóźnionych uchwytów i jawna materializacja.
- `packages/fullmag-py/tests/test_problem_ir.py` i `test_scene_document_roundtrip.py`: **13 passed** po zmianie bindingu.
- `packages/fullmag-py/tests/test_api.py -k "study_stage_builder or flat_api or script_builder"`: **33 passed, 272 deselected**.
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`: **35 passed, 28 subtests passed**.
- `packages/fullmag-py/tests/test_mesh_persistence.py`: **25 passed**.
- `packages/fullmag-py/tests/test_api.py -q --maxfail=1`: **304 passed, 1 skipped, 45 warnings, 9 subtests passed**.
- `p2/02-canonical-ir.md`: canonical JSON/digest slice **3 passed**; pełny ProblemIR/scene **14 passed**.
- `packages/fullmag-py/tests/test_parameter_ast.py`: **7 passed** — SI normalization, ProblemIR lowering, flat/study facade, generated-script round-trip, dimension/cycle diagnostics i display metadata poza numerical hash.
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`: **35 passed, 28 subtests passed**.
- `packages/fullmag-py/tests/test_problem_ir.py`, `test_execution_context.py` oraz `test_scene_document_roundtrip.py`: **20 passed** po podpięciu publicznego AST parametrów do `Problem`.
- `p2/03-geometry-feature-sequence.md`: biblioteka `fullmag-authoring` przechodzi `cargo check --locked -p fullmag-authoring --lib`; testy Rust są zapisane, lecz nieuruchomione zgodnie z bieżącą polityką buildów.
- `packages/fullmag-py/tests/test_selection_geometry.py` + `test_selection_contract.py`: **75 passed**; Python evaluator granic, CSG, affine i fail-closed dla importowanych brył.
- `AuthoringHistoryController.test.ts`: **3 passed**; revision-fenced Undo/Redo i odmowa nadpisania zewnętrznej rewizji.
- `PendingFormRegistry.test.ts`: **4 passed**; rejestracja aktywnego formularza, gating Apply/Reset, lock/applying guard i obsługa błędu callbacku.
- `InspectorHistoryBridge.test.ts`: **4 passed**; snapshot przed/po staged Apply, brak wpisu dla no-op/live/immediate i bezpieczne zachowanie przy niedostępnym snapshotcie.
- `authoringHistoryMutation.test.ts`: **5 passed**; base-revision fencing, cache fallback, no-op, refetch pełnej sceny po ACK zawierającym tylko rewizję oraz zapis częściowego ACK.
- `fieldMapCommands.test.ts`: **13 passed**; rename/duplicate/delete monitorów z revision fence oraz zapis historii po ACK.
- `PlanarMonitorDraftInspectorPanel.test.tsx`: **7 passed**; utworzenie monitora z draftu, kolizje tożsamości, konflikt 409 i zapis historii.
- `PlanarMonitorInspectorPanel.test.tsx`: **5 passed**; edycja committed monitora i stabilność panelu po ACK.
- `FrozenSpinsInspectorPanel.test.tsx`: **18 passed**; preview pozostaje spekulatywny, a Apply zapisuje authored history po pełnym ACK.
- `regionCommandContributions.test.ts`: **5 passed**; region/coupling immediate commands zapisują historię i przekazują `baseRevision`.
- `geometryLifecycleCommandContributions.test.ts`: **40 passed**; create/delete rejestrują semantic history po ACK.
- testy komend/menu/skrótów: **35 passed**; wspólne surfaces dla Undo/Redo oraz Apply/Reset Inspectora.
- połączona bramka Inspectora: **28 passed**; PendingFormRegistry, shell commands, menu, edit session i routing Apply/Reset.
- macierz paneli Inspectora i komend authoringu: **18 plików / 238 passed**; staged sesje, SSR/hydration, resource hooks, monitor/Frozen Spins/material ACK oraz stabilność paneli.
- `SpinAuthoringInspector.test.tsx` + `TransportAuthoringInspector.test.tsx`: **26 passed**; Create/Replace dla czterech rodzin authoringu korzysta z captured `baseRevision` i wspólnej historii.
- `SpinInterfaceInspector.test.tsx`: **5 passed**; Create/Replace interfejsu jest revision-fenced przez właścicielski transport.
- `check:architecture-hygiene`: **PASS**; `typecheck`: **PASS**; targeted ESLint: **PASS**.
- `pnpm --dir apps/control-room typecheck`: **PASS** po podpięciu historii.
- `python -m py_compile` dla `world.py`, `__init__.py` i nowego testu: **PASS**.
- `p2/06-model-component-physics.md`: `test_authoring_model_projection.py` **12 passed**, połączona bramka projekcji/AST/ProblemIR/scene **33 passed** oraz wcześniejszy `cargo check --locked -p fullmag-authoring --lib` **PASS**; Python zweryfikował golden fixture wspólny z Rust, ale Rustowy test tego digestu nadal jest **NOT RUN**.

Nie uruchamiano pełnej macierzy solverów ani managed qualification dla tego fragmentu. Testy dowodzą izolacji authoringu i braku regresji wskazanych ścieżek, nie dowodzą jeszcze równoległego runtime ani kwalifikacji wydania.

## Kontrakt API

```python
import fullmag as fm

with fm.execution_context():
    study = fm.study("document-a")
    # istniejące fm.geometry(...), fm.run(...), fm.relax(...)

with fm.ExecutionContext():
    # drugi dokument ma świeży, niezależny stan
    ...
```

`fm.reset()` resetuje tylko aktualny binding. Wyjście z bloku przywraca stan zewnętrzny; nie przenosi jego mutowalnych list, cache ani capture stages do kontekstu wewnętrznego. Legacy flat script poza blokiem nadal działa w jednym bindingu bieżącego wykonania.

## Pozostałe P2-C

1. Przenieść granicę definicja → materializacja do jawnych operacji study/run, z pomiarem kosztownej budowy assetów.
2. Uzgodnić private bridge `fullmag-py-core` z canonical IR dla typed path; obecny bridge pozostaje walidatorem/runnerem i nie tworzy drugiego modelu projektu.
3. Rozszerzyć testy o równoległe capture/load scriptów oraz kontrolowany test awarii procesu. Ten ostatni nie jest jeszcze dowodem power-loss.

P2-A ma typed projection slice po stronie Python i Rust, read-only dekodery
wersjonowanego payloadu po obu stronach oraz Rust canonical digest, ale nadal
wymaga fixture zgodności Python/Rust (zwłaszcza liczb), pełnego
GUI/Python/Rust roundtripu i loweringu do rzeczywistego ProblemIR.
P2-B nadal wymaga ewaluacji selekcji, ambiguity/repair i integracji z producerem
mesha. P2-D ma teraz source-level przywracanie selection dla Undo/Redo; focus
pozostaje stanem layoutu i nie podlega historii. Wynik nowych testów i
browserowego Apply → Undo → Redo pozostaje **NOT VERIFIED**; nadal trzeba objąć
pozostałe wieloetapowe i direct handlers.
Wykonane slice'y nie zamykają tych warunków.

## P2-A — fixture digestu authoringowego Python ↔ Rust (24.09.2026)

`ModelDefinition.canonical_sha256()` ma osobny serializer floatów po stronie
Python i Rust: wartości skończone są zapisywane najkrótszym round-trip zapisem
wykładniczym, a `canonical_json_sha256()` dla ProblemIR pozostaje bez zmian.
Wspólny fixture obejmuje granice formatowania wykładników, ujemne zero i
Unicode. Połączone testy authoring projection i ProblemIR: **21 passed**;
Rust test jest dodany,
lecz **NOT RUN**, bo storage preflight blokuje istniejące rzeczywiste katalogi
`.fullmag` i `target`. Digest Python↔Rust pozostaje **NOT VERIFIED** i nie
zmienia procentu P2.

## P2-D — historia geometrii obiektu i scope sesji (23.09.2026)

`GeometryObjectPanel` przekazuje utworzenie obiektu, zmianę geometrii i
przesunięcie przez wspólny wrapper historii authoringu. Każde żądanie używa
przechwyconego scope sesji; spóźniony ACK ani wyczyszczona generacja historii
nie dopisują wpisu, nie unieważniają zasobów aktywnej sesji i nie zmieniają jej
zaznaczenia. Serwer nadal dostaje pierwotne `base_revision` szkicu, więc
konflikt i rebase pozostają rozstrzygane przez revision fence.

Regresje DOM obejmują poprawny zapis historii i zmianę sesji przed ACK;
adapter przesunięcia ma regresję przypięcia żądania do sesji i odrzucenia
spóźnionego ACK. Vitest i celowany ESLint nie wystartowały, bo Node otrzymał
`EPERM` przy otwieraniu zainstalowanych plików pakietów.
`check:architecture-hygiene` **PASS**. Tego wycinka nie liczę jeszcze jako
zweryfikowanego; nadal otwarta jest bramka browserowa P2-D Apply → Undo → Redo.

`AuthoringHistoryController` zachowuje snapshot selection po obu stronach
transakcji. Wspólne komendy Undo/Redo przywracają poprzedni wybór, jeśli jest
prawidłowy w odtworzonej scenie, czyszczą wybór obiektu usuniętego przez Undo i
nie nadpisują nowszego prawidłowego wyboru. Focus pozostaje stanem layoutu.
Core geometry create/delete oraz `ObjectGeneralPanel` zapisują właściwe
snapshoty dla utworzenia, usunięcia i edycji tożsamości obiektu; przy usuwaniu
after-snapshot powstaje tylko wtedy, gdy mutacja sama wyczyściła zaznaczenie.
Dodano regresje controller, workspace restore, helpera, Object General i
command routing; Vitest nie wystartował z powodu `EPERM` przy dostępie do
plików pakietów. Repo consistency, architecture hygiene i `git diff --check`
**PASS**; typecheck, targeted ESLint i browser pozostają **NOT VERIFIED**.
Lokalny browser nie połączył się z portem 3104 (`ERR_CONNECTION_REFUSED`).
Procent P2 bez zmian do czasu zaliczenia tych bramek.

`StudyInspectorPanel` przekazuje `commitStageDrafts` i `commitGlobalDraft`
przez ten sam wrapper. Wpis historii powstaje po ACK zmiany sceny, przed
zależnym replanem FDM; scope i generacja historii są sprawdzane przed
invalidacją oraz aktualizacją feedbacku i draftu. `check:architecture-hygiene`
**PASS**, lecz test integracyjny, typecheck i celowany ESLint nie mają wyniku
z powodu odmowy dostępu do lokalnych plików pakietów Node. Ten source slice
pozostaje niezweryfikowany i nie zmienia procentu P2. Kolejne bramki to test
Apply → Undo → Redo w browserze, zachowanie selection i stabilność focusu oraz pozostałe
direct handlers Inspectora.

## P2-A — weryfikacja Python round-trip (24.09.2026)

Uruchomiono **80 testów Python** dla projekcji authoring modelu, konwersji
`SceneDocument` → `ProblemIR`, round-trip dokumentu sceny, bazowych kontraktów
`ProblemIR` i geometrii selekcji; wszystkie przeszły. To potwierdza wyłącznie
ścieżkę Python. Zgodność digestu Python/Rust, test Rust, round-trip browsera
oraz pełny lowering przez `fullmag-py-core` pozostają **NOT VERIFIED**.
Procent P2 pozostaje bez zmian.

## P2-D / P3a — scope zapisu granicy tłumiącej (24.09.2026)

`ObjectAbsorbingBoundaryPanel` przypina odczyt historii i `PATCH` do tego
samego aktywnego `sessionScopeKey`, wysyła `baseRevision`, wymaga załadowanej
tożsamości sesji i pomija historię, invalidację oraz feedback po zmianie sesji
przed ACK. Dodano regresje DOM dla poprawnego zapisu, spóźnionego ACK A→B i
braku tożsamości. Typecheck, API hygiene i architecture hygiene **PASS**;
Vitest i ESLint są **NOT RUN** z powodu `EPERM` przy odczycie zainstalowanych
pakietów Node. Ten slice nie zamyka browserowej bramki P2-D/P3a i nie zmienia
procentów.

## P2-D / P3a — zakres sesji pól materiałowych regionu (24.09.2026)

`ObjectRegionMagneticParametersPanel` wymaga aktywnego `sessionScopeKey` i
finite `baseRevision`; odczyt historii i PATCH są przypięte do tego samego
scope. Odpowiedź po zmianie sesji albo generacji historii nie publikuje historii,
invalidacji ani feedbacku, a pending jest identyfikowane per operacja i sesja.
Dodano trzy regresje DOM dla poprawnego zapisu, spóźnionego ACK A→B i braku
tożsamości. Typecheck, API hygiene, architecture hygiene i diff check
**PASS**. Vitest zakończył się `EPERM` przy otwarciu pakietu `vitest.mjs`, więc
testy pozostają **NOT RUN**; browser/managed runtime pozostają **NOT VERIFIED**.
Procenty P2/P3a/P4 i całego planu bez zmian.

## P2-D / P3a — zakres sesji tekstury regionu (24.09.2026)

`ObjectRegionTexturePanel` wymaga aktywnego `sessionScopeKey` oraz skończonego
`baseRevision` przy zapisie i czyszczeniu tekstury. Spóźniony ACK po zmianie
sesji/generacji nie wywołuje invalidacji ani synchronizacji skryptu i nie
zmienia draftu lub komunikatu. Synchronizacja best-effort jest scoped, a
pending ma własność sesji i identyfikator operacji. Dodano trzy regresje DOM.
Typecheck, API hygiene, architecture hygiene, repo consistency i diff check
**PASS**. Testy DOM pozostają **NOT RUN**, ponieważ Vitest kończy się `EPERM`
przy otwieraniu zainstalowanego `vitest.mjs`; browser/managed runtime pozostają
**NOT VERIFIED**. Procenty nie ulegają zmianie.

## P2-D / P3a — session fence tworzenia Planar Monitora (24.09.2026)

`PlanarMonitorDraftInspectorPanel` przypina create do aktywnego
`sessionScopeKey` i generacji historii, odrzuca brak tożsamości i wymaga
skończonego `baseRevision` zamiast `0`. Spóźniony ACK po A→B nie usuwa draftu,
nie zmienia wizualizacji, selection, layoutu ani zasobów; pending jest
identyfikowane przez sesję i operację. Dodano regresje DOM dla scoped requestu,
zmiany sesji przed ACK i braku tożsamości. Typecheck, API hygiene,
architecture hygiene i diff check **PASS**; Vitest **NOT RUN** z powodu
`EPERM` przy ładowaniu pakietu. Browser/managed runtime pozostają
**NOT VERIFIED**. Procenty bez zmian.

## P2-D / P3a — session fence CrossSection draft (24.09.2026)

Aktywny `CrossSectionDraftEditor` wysyła odczyt domain metadata i utworzenie
Planar Monitora z jednym `sessionScopeKey`, wymaga skończonego `baseRevision`
i odrzuca skutki ACK po A→B. Dodano DOM regresje scoped read/write, spóźnionej
odpowiedzi i braku tożsamości. Typecheck, API hygiene, architecture hygiene,
repo consistency i diff check **PASS**; Vitest **NOT RUN** z powodu `EPERM`
przy ładowaniu `vitest.mjs`, browser **NOT VERIFIED**. Procenty pozostają bez
zmian.

## P2-D / P3a — sesyjny zapis edycji Planar Monitora (24.09.2026)

`PlanarMonitorInspectorPanel` przekazuje session scope i `baseRevision` do
PATCH, odrzuca brak identity oraz po ACK pomija draft, invalidację i refetch,
jeśli zmieniła się sesja albo generacja historii. Pending jest wiązany z
sesją/operacją. Rozszerzono regresje DOM o scoped request, A→B przed ACK i brak
identity. Typecheck, API hygiene, architecture hygiene i diff check **PASS**;
Vitest **NOT RUN** z powodu `EPERM` podczas ładowania `vitest.mjs`, browser
pozostaje **NOT VERIFIED**. Procenty bez zmian.

## P2-D — staged Apply geometrii i scope mostu historii (24.09.2026)

`GeometryObjectPanel` rejestruje draft w `PendingFormRegistry`. Globalny Apply
uruchamia pojedynczy zapis create/geometry/translation; przy jednocześnie
zmienionej geometrii i translacji blokuje tylko Apply i pozostawia dostępny
Reset, dzięki czemu każda zmiana zachowuje własną granicę historii. Reset
przywraca wartości bazowe, a stan pending jest przypisany do klucza draftu,
sesji i identyfikatora operacji. Panel oznacza callback jako
`mutation-owned`, bo jego bezpośrednie zapisy już rejestrują historię.

Staged history bridge przekazuje `sessionScopeKey` do odczytu przed/po Apply i
sprawdza scope przed wywołaniem oraz po odpowiedzi. Generacja historii jest
sprawdzana przed i po callbacku. Formularze zapisujące historię przez
`runAuthoringMutationWithHistory` deklarują `historyMode: "mutation-owned"` i
omijają drugi bracket. Dla callbacku bridge-owned zmiana rewizji jest
rejestrowana również wtedy, gdy callback zwróci `false` po częściowym zapisie;
wynik `false` nadal blokuje dalszą zmianę selection. `pnpm --dir
apps/control-room typecheck`, API hygiene, architecture hygiene, repository
consistency i diff check **PASS**. Nowe testy
bridge, rejestru Inspectora (w tym `InspectorEditSession.dom.test.tsx`) i panelu
geometrii są **NOT RUN**: Node otrzymuje
`EPERM` przy otwieraniu `node_modules/.pnpm/vitest.../vitest.mjs`. Browserowy
Apply → Undo → Redo pozostaje **NOT VERIFIED**; procent P2 pozostaje bez zmian.

## P2-D / P3a — session-fenced Apply Regional Field Drive (24.09.2026)

`RegionalFieldDrivePanel` przypina draft do `sessionScopeKey`, a zapis prowadzi
przez `runAuthoringMutationWithHistory`: snapshot sceny wyznacza
`base_revision`, POST/PUT przekazuje ten sam session scope, a ACK po zmianie
sesji nie publikuje historii, invalidacji ani nowego selection. Historia ma
jednego właściciela (`mutation-owned`), a pending jest przypięty do sesji,
draftu i identyfikatora operacji. Test modelu sprawdza przekazanie request
options; test DOM obejmuje udany create i spóźniony ACK. Control Room typecheck
**PASS**. Vitest i `react-doctor --scope changed` **NOT RUN**: Node otrzymuje
`EPERM` przy otwieraniu zainstalowanych entrypointów. Browser i managed runtime
pozostają **NOT VERIFIED**; P2 (**59%**), P3a (**90%**) i plan globalny
(~**27%**) bez zmian.
