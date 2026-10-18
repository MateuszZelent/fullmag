# P8-53CK — fixture anteny w dwóch wersjach IR

Baza: `c106fd3e3ad6f851d2bb81b0a06867a8d2165dea`.
CI Rust dla `5e99782acbb7fb3f65d0cad872e102bf67733103` zatrzymało się w
`crates/fullmag-ir/tests/ir_tests.rs:1937`: `StudyIR` przypisano do `StudyIRV04`.
Job: https://github.com/MateuszZelent/fullmag/actions/runs/38544583160/job/115787374590.

Poprawka rozdziela dwa rzeczywiste kontrakty, bez zmiany produkcyjnego IR:

- V03 przyjmuje `antenna_field_solve`, ale waliduje brakujące selection reference.
- V04 nie reprezentuje tego study; test pełnego dokumentu sprawdza odrzucenie
  `/study/kind: unsupported study kind 'antenna_field_solve'` przez deserializator.

Źródła: `ProblemIRV04::deserialize` w `crates/fullmag-ir/src/physics_object.rs`
wywołuje `validate_v04_study_wire` przed parsowaniem wire; jego zamknięty dispatch
w `crates/fullmag-ir/src/study_v04.rs` odrzuca nieobsługiwany kind.
`ProblemIR::validate` zachowuje istniejącą kontrolę selection V03.
Nie rozszerzono enum, migracji, publicznego API ani solvera.

Root przejrzał pełny diff, rzeczywiste typy i parser; `git diff --check` PASS.
Lokalnej kompilacji testów Rust/native nie uruchomiono. Wykonanie dwóch nowych
fixture i dalszych kontraktów Rust czeka na zatwierdzoną trasę CI: **NOT RUN**.
Naprawa źródłowa nie jest dowodem zamknięcia P8 ani kwalifikacji runtime.
