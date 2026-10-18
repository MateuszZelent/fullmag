# P8-53CR — brakujące typy i inventory w fixture aplikacji

Data: 15.10.2026. Weryfikacja CI źródeł
`720fcda2765029911ee66965541666c978272e0f`: run `38578366031`,
job `115901370257` zakończył się **FAIL**. Wcześniejsze zielone kroki
udokumentowane w 53CP pozostają dowodami wyłącznie swojego zakresu.

Kolejne pięć błędów kompilacji pochodzi z dwóch fixture:

| Fixture | Błąd i przyczyna | Poprawka |
|---|---|---|
| `execution_profile_reference_tests.rs` | 4× E0422: `ExecutionRequestLayerIR` i `ExecutionFieldOriginIR` nie są importowane przez nadrzędny moduł; samo `use super::*` ich nie udostępnia | Jawny import dwóch typów z `fullmag_ir` w fixture |
| `script_stage_materialization.rs::pipeline_eigen_solver_policy_tests::eigenmode_pipeline_stage` | E0063: initializer `ScriptExecutionConfig` pomija wymagane pole `antenna_inventory` | `ScriptAntennaAuthoringInventory::default()`, zgodnie z innym initializerem w tym module; fixture nie definiuje anten |

Zmiana obejmuje dwie dodane linie, bez zmiany produkcyjnych typów,
walidatorów, zakresu wsparcia ani asercji. Sprawdzono definicje typów
w `fullmag-ir/src/execution_profile.rs` oraz pole i jego deserializer
w `fullmag-application/src/script_stage_contract.rs`.

`git diff --check`: **PASS**. Scoped `rustfmt --check --config skip_children=true`
pliku referencji: **PASS**. Drugi moduł ma istniejące różnice formatowania
poza zmianą, więc jego format check zwraca 1; nie formatowano pobocznego kodu.
Nie kompilowano ani nie uruchamiano lokalnie testów jednostkowych Rust.
Odbiór nowego commita przez CI pozostaje **NOT RUN**.

Cały plan P0–P8 pozostaje **IN PROGRESS**. Ta naprawa fixture nie kwalifikuje
native runtime, solvera ani wydania.
