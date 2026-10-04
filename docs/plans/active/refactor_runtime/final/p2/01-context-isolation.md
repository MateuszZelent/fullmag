# P2-C — izolacja kontekstu Python

Data: 21.09.2026. Zakres: implementacyjny slice P2-C na `master`, bez zmiany fizyki i bez nowego `fm.Project`.

## Problem

Dotychczasowy flat DSL przechowywał `_WorldState` jako mutowalny singleton modułu. Samo podmienienie singletonu na `ContextVar` byłoby niewystarczające, ponieważ Python dziedziczy wartość `ContextVar` do nowego tasku asyncio przez referencję. Dwa dokumenty mogłyby wtedy dopisywać magnety, stage i cache do tej samej listy.

## Zmiana

`packages/fullmag-py/src/fullmag/world.py` używa teraz:

- `_WorldStateBinding`, który zachowuje kompatybilny symbol `world._state` dla istniejącego kodu i testów;
- `ContextVar` z lazy-created `_WorldState`, więc zwykły flat script nie potrzebuje migracji;
- owner stamp `(thread_id, task_id)`, który rozdziela odziedziczony mutable state przy pierwszym dostępie nowego tasku lub wątku;
- `ExecutionContext` / `execution_context()` do jawnego właścicielskiego zakresu dokumentu. Tokeny są resetowane w `__exit__`, także gdy ciało bloku rzuca wyjątek;
- analogiczny context-bound state dla capture scriptów, aby `begin_script_capture`, `finish_script_capture` i lightweight asset mode nie były globalnym przełącznikiem między dokumentami.
- owner fencing dla `MagnetHandle`, `MagnetizationHandle`, `GeometryMeshHandle` i `ObjectRegion`, aby mutacja uchwytu po wyjściu z jego kontekstu kończyła się jawnym błędem.
- `ExecutionContext.materialize_problem()` jako jawna granica definition → immutable `Problem`; metoda wymaga aktywnego ownera i nie uruchamia solwera ani buildera assetów mesh.

`packages/fullmag-py/src/fullmag/__init__.py` eksportuje tylko te dwa jawne punkty wejścia. Nie dodano `fm.Project`: plan traktuje tę nazwę jako pseudokod i nie wolno udawać gotowego publicznego API.

## Zachowane granice

- `ProblemIR`, jednostki SI, requested/resolved runtime i istniejące `fm.study(...).stages` pozostają bez zmian.
- Wejście do `ExecutionContext` nie buduje geometrii, siatki ani solvera.
- `reset()` działa lokalnie dla aktualnego bindingu.
- Praca bez jawnego bloku zachowuje kompatybilność legacy; w worker poolach niezależny dokument powinien jawnie użyć `with fm.execution_context()`.
- Request context przez granice Rust/API pozostaje osobnym zakresem P3a; Python handle fencing jest objęty tym slice'em.

## Kryteria odbioru i wynik

| Kryterium | Dowód | Wynik |
|---|---|---|
| Zagnieżdżenie i wyjątek przywracają outer state | `test_nested_context_restores_outer_state_after_exception` | PASS |
| Dziedziczenie `ContextVar` do async tasku nie współdzieli listy magnetów | `test_async_tasks_fork_inherited_mutable_state` | PASS |
| Niezależny thread/document context | `test_threads_get_independent_legacy_contexts` | PASS |
| Capture state nie przecieka przez nested exception | `test_capture_state_is_restored_with_nested_context` | PASS |
| Mutacja uchwytu po zamknięciu kontekstu jest odrzucona | `test_handles_reject_mutation_after_their_context_is_closed` | PASS |
| Materializacja jest jawna i związana z aktywnym kontekstem | `test_context_materialization_is_explicit_and_context_bound` | PASS |
| Dotychczasowe roundtripy Python/IR/scene | `test_problem_ir.py`, `test_scene_document_roundtrip.py` | 13 PASS |
| Builder/script compatibility | `test_api.py` focused/full, `test_script_builder_roundtrip.py` | 33 PASS; 304 PASS/1 skipped; 35 PASS + 28 subtests |
| Mesh persistence compatibility | `test_mesh_persistence.py` | 25 PASS |

Wynik jest **P2-C slice PASS / P2 overall IN PROGRESS**. Nie jest to dowód managed runtime, pełnej session recovery, browser/WebGL ani release qualification.
