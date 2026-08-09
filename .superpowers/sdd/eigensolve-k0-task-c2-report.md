# C2 — backend-neutral bias-field sweep — raport

## Zakres wykonany

- Dodano kanoniczne `BiasFieldSweepIR` dla `StudyIR::Eigenmodes`: niepusta uporządkowana lista wektorów `[Hx, Hy, Hz]` w A/m, `relax_each | continuation`, wymuszony `ordering: declared` i jawne źródło kontynuacji.
- Walidacja IR odrzuca pusty lub niefinitywny przebieg, inną kolejność oraz wszystko poza pojedynczym punktem Gamma. FDM odrzuca żądanie stabilnym tokenem `eigenmodes.bias_field_sweep_requires_fem_backend; fallback=none` przed rozstrzygnięciem wykonania.
- Plan FEM zachowuje indeks próbki, fizyczny wektor A/m, politykę równowagi i seed oraz istniejące requested/resolved execution provenance dla każdego planu.
- `k0_kittel_validation` emituje `DeprecationWarning` i pozostaje metadanymi powalidacyjnymi; usunięto plannerski wyjątek dla syntetycznego demagu.
- Dodano publiczny Python DSL `fm.BiasFieldSweep`, jego obniżenie do `ProblemIR`, API etapów `Eigenmodes` oraz model i edytor Study Inspector: `Bias field scan`, tabela wierszy `[Hx, Hy, Hz] A/m`, polityka równowagi, seed kontynuacji i walidacja inline.

## Dowody RED/GREEN

RED przed implementacją: nowy test Python kończył się `AttributeError: module 'fullmag' has no attribute 'BiasFieldSweep'`; nowy test IR serializował `bias_field_sweep` jako `null`.

GREEN:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_problem_ir.py::test_eigenmodes_bias_field_sweep_serializes_declared_si_samples
1 passed

env CARGO_TARGET_DIR=/dev/shm/fullmag-c2-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-ir --test ir_tests \
  eigenmodes_bias_field_sweep_deserializes_and_rejects_invalid_physical_samples --quiet
1 passed

env CARGO_TARGET_DIR=/dev/shm/fullmag-c2-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-plan \
  fem_eigen_bias_field_sweep_plans_declared_samples_with_resolved_execution --quiet
1 passed
```

`git diff --check` dla plików C2 jest czysty.

## Blokery i granica kwalifikacji

- Nie można uruchomić testów importujących `fullmag.runtime.script_builder`: plik `packages/fullmag-py/src/fullmag/runtime/script_builder.py` ma 0 B, a jego istniejący diff usuwa 7367 linii względem `HEAD`. To zmiana spoza C2; nie została odtworzona ani staged. W konsekwencji testy `test_scene_document_roundtrip.py` i `test_api.py` przerywają importem `export_builder_draft`.
- `pnpm` nie jest dostępny w środowisku, więc lokalny typecheck/test UI nie został wykonany.
- C2 nie dotyka runnera, artefaktów wynikowych ani natywnego CPU/GPU. Nie ma kwalifikacji runtime/device ani twierdzenia o produkcyjnej realizacji skanu; to wyłącznie zamknięcie kontraktu DSL/IR/planner/authoring.
- Współdzielony worktree zawiera niezwiązane, niestage’owane zmiany C1 w tych samych plikach planner/UI. Przed commitem trzeba wybrać wyłącznie hunki C2; pełne `git add` byłoby naruszeniem izolacji zadań.

## Stan commitu i pominięte hunki

Checkpoint C1+C2: `c3e18cf9a` (`feat(eigen): add canonical bias-field sweep contract`). Selektywny staging wymagał objęcia wspólnego hunku w `crates/fullmag-plan/src/fem.rs`, który łączy materializację C2 `bias_field_samples` z C1 `execution_resolution`. C2 korzysta również z dodanych przez C1 typów provenance w `crates/fullmag-ir/src/plan.rs`; commit C2 względem wcześniejszego `HEAD` bez nich nie kompilowałby się.

Celowo pominięte, niestage’owane hunki C1/niezależne to przede wszystkim: `FemEigenEngineIR`, `FemEigenExecutionResolutionIR`, `resolve_k0_periodic_airbox_execution`, zmiany `ProvenancePlanIR`, fixture `k0_periodic_airbox_fem_eigen_ir`, rozszerzenia testów runtime-device oraz współdzielone hunki UI w `StudyStageAuthoringModel.ts` i `StudyStageDraftEditor.tsx`. Bez uprzedniego commitu C1 albo zgody na commit zależny od C1 nie istnieje technicznie spójny commit „wyłącznie C2”.
