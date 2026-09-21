# P2 — authoring, Python i historia edycji

Ten katalog rejestruje wykonane przyrosty P2. P2 nie jest jeszcze ukończone: P2-A (biblioteki parametrów, display/provenance i roundtrip), P2-B (geometria/selekcje) i P2-D (Inspector/Undo/Redo) pozostają osobnymi zakresami.

## Aktualny checkpoint — 21.09.2026

Wykonano implementacyjne slice'y P2-A i P2-C. P2-A ma wspólny kontrakt deterministycznych bajtów/digestu ProblemIR; P2-C ma per-context binding oparty na `ContextVar`, zachowuje dotychczasowe wywołania modułowe i udostępnia jawny `fm.ExecutionContext` / `fm.execution_context()`. `ExecutionContext.materialize_problem()` tworzy immutable `Problem` dopiero na jawnej granicy, w aktywnym ownerze, bez uruchamiania solwera. Zagnieżdżenie przywraca poprzedni binding także po wyjątku. Wartości odziedziczone przez nowy task asyncio są rozdzielane po identyfikatorze właściciela tasku, a praca w osobnym wątku ma własny binding; worker pool powinien otaczać każdy niezależny dokument jawnym `execution_context()`. Uchwyty geometrii, meshingu, magnetyzacji i regionów mają dodatkowo owner fencing: spóźniona mutacja jest odrzucana zamiast trafiać do aktualnego kontekstu.

Implementacja nie tworzy pseudoklasy `fm.Project`, nie zmienia semantyki fizyki ani formatu `ProblemIR`, nie uruchamia meshera przy wejściu do kontekstu i nie obiecuje jeszcze pełnej izolacji requestu Rust/API po `await`. To jest granica P2-C; fencing requestów i trwała tożsamość projektu należą do P3a.

## Dowody

- `packages/fullmag-py/tests/test_execution_context.py`: **6 passed** — nesting/exception, odziedziczony stan asyncio, thread isolation z jawnym contextem, przywrócenie capture state, fencing spóźnionych uchwytów i jawna materializacja.
- `packages/fullmag-py/tests/test_problem_ir.py` i `test_scene_document_roundtrip.py`: **13 passed** po zmianie bindingu.
- `packages/fullmag-py/tests/test_api.py -k "study_stage_builder or flat_api or script_builder"`: **33 passed, 272 deselected**.
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`: **35 passed, 28 subtests passed**.
- `packages/fullmag-py/tests/test_mesh_persistence.py`: **25 passed**.
- `packages/fullmag-py/tests/test_api.py -q --maxfail=1`: **304 passed, 1 skipped, 45 warnings, 9 subtests passed**.
- `p2/02-canonical-ir.md`: canonical JSON/digest slice **3 passed**; pełny ProblemIR/scene **14 passed**.
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

P2-A nadal wymaga versioned libraries, AST/SI parameter normalization, jawnej
polityki display/provenance poza numerical hash oraz pełnego GUI/Python/Rust
roundtripu. Wykonany canonical-bytes slice nie zamyka tych warunków.
