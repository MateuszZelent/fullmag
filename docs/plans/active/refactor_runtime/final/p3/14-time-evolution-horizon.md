# P3-B — zaakceptowany horyzont TimeEvolution

Data: 2026-09-25
ADR: [0036](../../../../../adr/0036-study-step-runtime-horizon.md)

## Cel

Runner przyjmuje `until_seconds` osobno od `ProblemIR`. Supervisor nie może
więc uruchomić zaakceptowanego kroku TimeEvolution, dopóki czas zakończenia nie
jest częścią niezmiennego planu study.

## Zmiana źródłowa

- `StudyPlan` emituje `study_plan.v2` i przenosi opcjonalne `until_seconds` na
  poziomie kroku. Przejście z `StudyPipelineDocument` mapuje wyłącznie jawne
  `Run.until_seconds`, pozostawiając oryginalny legacy payload.
- `study_plan.v1` bez tego pola jest nadal odczytywany dla kompatybilności;
  v1 z polem v2 jest odrzucany. Stare rekordy nie są przepisywane.
- `study_execution_plan.v2` zachowuje dokładny horyzont z wejściowego
  `StudyPlan`. Lowering dowolnego `ProblemIR::TimeEvolution` bez dodatniego,
  skończonego czasu odrzuca krok przed wykonaniem solvera.
- Sampling i autosave nie są zastępczym źródłem horyzontu. Pozostałe rodzaje
  badań nadal używają własnych stop controls.

## Kryteria dalszego dispatchu

Supervisor ma odczytać zaakceptowany `StudyStepExecutionPlan`, użyć dokładnego
`until_seconds` w istniejącym wejściu `fullmag_runner::run_problem` i zachować
ten sam backend, urządzenie oraz requested/resolved provenance. Brak lub
niezgodność wersji planu musi zakończyć się `blocked` przed uruchomieniem.

Niniejszy wycinek nie dodaje procesu supervisora, transportu workerów ani
wykonania solvera. Do czasu przejścia tych bramek runtime oraz walidacja
fizyczna pozostają `NOT VERIFIED`.

## Weryfikacja

- `just verify-authoring-contracts`: **107/107 PASS**, receipt
  `3b5a9bae3fc041e98d7c67d7947f7f82`, `source_changed_during_run=false`.
  Obejmuje migrację czasu, kontrolę wartości oraz zgodność odczytu planu v1.
- `just verify-api-project-runs`: **4 PASS, 2 ignored**, receipt
  `44b40955149d40abb13b347d81a09f50`, `source_changed_during_run=false`.
  Dodatkowa regresja sprawdza, że lowering TimeEvolution bez czasu jest
  odrzucony, a pełny zaakceptowany submit z czasem pozostaje poprawny.
- `just generate-api-openapi`: **PASS**, receipt
  `0de8731b09244f12bb9173709f37d1e5`, `source_changed_during_run=false`;
  wygenerowany opis requestu wskazuje bieżące `study_plan.v2`.
- Celowany `rustfmt --check`: **PASS**.

Testy obejmują kontrakt i przyjęcie API; nie uruchamiają solvera. Supervisor,
rzeczywisty worker, runtime oraz walidacja fizyczna pozostają **NOT VERIFIED**.
