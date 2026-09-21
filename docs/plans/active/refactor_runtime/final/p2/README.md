# P2 — authoring, Python i historia edycji

Ten katalog rejestruje wykonane przyrosty P2. P2 nie jest jeszcze ukończone: P2-A ma częściowy AST/bibliotekę parametrów, ale pełne podpięcie display/provenance i roundtrip, P2-B ma częściową geometrię/selekcje, P2-C nie ma jeszcze pełnej granicy materializacji, a P2-D ma revision-fenced Undo/Redo, rejestr aktywnego formularza Inspectora, wspólny wrapper historii staged sesji oraz helper dla wielu immediate mutations, lecz nie ma jeszcze pełnej rejestracji mutacji.

## Aktualny checkpoint — 21.09.2026

Wykonano implementacyjne slice'y P2-A, P2-B, P2-C oraz kolejne slice'y P2-D. P2-A ma wspólny kontrakt deterministycznych bajtów/digestu ProblemIR oraz wersjonowany AST parametrów z normalizacją SI, referencjami, diagnostyką cykli i rozdzieleniem display metadata od numerical identity; P2-B ma stabilną sekwencję cech geometrii z lineage wejść CSG, osobną cechą transformacji, jawny wynik `resolved/ambiguous/empty` dla selekcji oraz selective invalidation domeny; P2-C ma per-context binding oparty na `ContextVar`, zachowuje dotychczasowe wywołania modułowe i udostępnia jawny `fm.ExecutionContext` / `fm.execution_context()`. `ExecutionContext.materialize_problem()` tworzy immutable `Problem` dopiero na jawnej granicy, w aktywnym ownerze, bez uruchamiania solwera. Zagnieżdżenie przywraca poprzedni binding także po wyjątku. Wartości odziedziczone przez nowy task asyncio są rozdzielane po identyfikatorze właściciela tasku, a praca w osobnym wątku ma własny binding; worker pool powinien otaczać każdy niezależny dokument jawnym `execution_context()`. Uchwyty geometrii, meshingu, magnetyzacji i regionów mają dodatkowo owner fencing: spóźniona mutacja jest odrzucana zamiast trafiać do aktualnego kontekstu. P2-D ma revision-fenced semantic Undo/Redo przez `replace_scene`, wspólne menu/ribbon/shortcut, `PendingFormRegistry` dla aktywnego formularza Inspectora oraz wrapper, który bracketsuje każdą staged sesję wspólnym odczytem sceny przed i po Apply.

Implementacja nie tworzy pseudoklasy `fm.Project`, nie zmienia semantyki fizyki ani formatu `ProblemIR`, nie uruchamia meshera przy wejściu do kontekstu i nie obiecuje jeszcze pełnej izolacji requestu Rust/API po `await`. To jest granica P2-C; fencing requestów i trwała tożsamość projektu należą do P3a.

Immediate authoring mutations korzystają teraz z `authoringHistoryMutation.ts`:
komendy i panele region/coupling, texture, absorbing boundary, antenna,
material fields, spin/transport delete, spin interface delete oraz tworzenie
monitora przekroju przekazują uchwyconą `base_revision` i zapisują jedną
semantyczną historię po potwierdzeniu nowej sceny. Odpowiedź zawierająca samą
rewizję powoduje dodatkowy odczyt pełnego snapshotu, więc nie trafia do Undo
niekompletna scena.

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
- `AuthoringHistoryController.test.ts`: **3 passed**; revision-fenced Undo/Redo i odmowa nadpisania zewnętrznej rewizji.
- `PendingFormRegistry.test.ts`: **4 passed**; rejestracja aktywnego formularza, gating Apply/Reset, lock/applying guard i obsługa błędu callbacku.
- `InspectorHistoryBridge.test.ts`: **4 passed**; snapshot przed/po staged Apply, brak wpisu dla no-op/live/immediate i bezpieczne zachowanie przy niedostępnym snapshotcie.
- `authoringHistoryMutation.test.ts`: **4 passed**; base-revision fencing, cache fallback, no-op oraz refetch pełnej sceny po ACK zawierającym tylko rewizję.
- `regionCommandContributions.test.ts`: **5 passed**; region/coupling immediate commands zapisują historię i przekazują `baseRevision`.
- `geometryLifecycleCommandContributions.test.ts`: **40 passed**; create/delete rejestrują semantic history po ACK.
- testy komend/menu/skrótów: **35 passed**; wspólne surfaces dla Undo/Redo oraz Apply/Reset Inspectora.
- połączona bramka Inspectora: **28 passed**; PendingFormRegistry, shell commands, menu, edit session i routing Apply/Reset.
- macierz paneli Inspectora z wrapperem: **8 plików / 116 passed**; staged sesje, SSR/hydration, resource hooks i stabilność ACK.
- `check:architecture-hygiene`: **PASS**; `typecheck`: **PASS**; targeted ESLint: **PASS**.
- `pnpm --dir apps/control-room typecheck`: **PASS** po podpięciu historii.
- `python -m py_compile` dla `world.py`, `__init__.py` i nowego testu: **PASS**.

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

P2-A nadal wymaga podpięcia biblioteki do Model/Component/PhysicsConfiguration,
pełnego GUI/Python/Rust roundtripu i loweringu do rzeczywistego ProblemIR. P2-B
nadal wymaga ewaluacji selekcji, ambiguity/repair i integracji z producerem
mesha. P2-D nadal wymaga objęcia pozostałych wieloetapowych i direct handlerów,
stabilnego zachowania selection/focus i browserowego Apply → Undo → Redo.
Wykonane slice'y nie zamykają tych warunków.
