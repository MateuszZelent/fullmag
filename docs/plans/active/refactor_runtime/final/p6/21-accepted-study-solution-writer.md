# P6-A — produkcyjny writer SolutionSet dla accepted study

Data: 29.09.2026

Status: **SOURCE VERIFIED / INTEGRATION TEST AUTHORED, NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`publish_study_outputs` po trwałym, lease-fenced zapisie kompletnego
`study_output_manifest.v3` publikuje teraz otwartą rewizję `SolutionSet` dla
dokładnego attemptu. Mapper przenosi wszystkie zadeklarowane outputy, manifest
oraz opcjonalne artefakty observation source do identity-only CAS references z
pełną długością obiektu. Wyniki są grupowane według `case_id`; metadata attemptu
pozostają osobnym memberem bez sztucznego case'a.

Provenance jest wyliczane z sześciu rzeczywistych, zaakceptowanych wejść:

- pełnego fingerprintu `RunSpecification`,
- SHA-256 definicji projektu wraz z referencją modelu kroku,
- dokładnego `ProblemIR` z immutable `StudyProblemCatalog`,
- referencji dyskretyzacji zaakceptowanego kroku,
- dokładnego obniżonego `ExecutionPlanIR`,
- polityki akwizycji i deklaracji outputów.

Jeżeli `RunSpec` zawiera seedy, otrzymują osobny digest. Mapper nie zastępuje
brakujących faktów innymi hashami. Ponieważ obecne codec manifests nie
deklarują liczby próbek dla każdego artefaktu, coverage jest jawnie `unknown`
z zerową liczbą zadeklarowanych próbek; nie powstaje fałszywe `complete`.

Po terminalnym wpisie journala `reconcile_coordinator_catalog` zwalnia
transakcję katalogu runu i domyka `SolutionSet` drugą immutable rewizją.
`Succeeded` zachowuje dokładną ocenę naukową koordynatora, a failed,
cancelled i interrupted pozostają `unassessed` z jawną przyczyną. Replay po
utracie ACK albo przerwaniu między journal/catalog i publikacją rozwiązania
odbudowuje brakującą rewizję. Zamknięty wynik nie może zostać ponownie otwarty,
zmienić provenance ani podmienić immutable artefaktów.

## Dowody

- `cargo check -p fullmag-runtime-control --lib`: **PASS**.
- Scoped Clippy `--no-deps -D warnings` z allow-listą trzech wcześniejszych
  lintów crate'u: **PASS**; nowy writer nie wymaga dodatkowego wyjątku.
- `rustfmt` zmienianych plików i `git diff --check`: **PASS**.
- Istniejący accepted-worker E2E został rozszerzony o kontrakt: jedna zamknięta
  rewizja `2`, komplet pięciu referencji CAS w fixture, dwa wpisy coverage
  `unknown`, sześć digestów provenance i idempotentne terminalne reconciliation.
  Test pozostaje **NOT RUN** zgodnie z tymczasowym zakazem budowania i
  uruchamiania testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Bezpośredni writers `runner/eigen/artifacts`, `fmr.rs` i pozostałe trasy poza
accepted-study nadal wymagają przejścia na ten katalog. Otwarte pozostają
migracja legacy resource keys copy-on-write, publiczne API/generated client,
process/power-loss fault injection oraz kwalifikacja reopen bez solvera i
czterech lane'ów CAE-37/61. Ocena naukowa ma obecnie status przekazany przez
worker; osobne artefakty evidence wymagają późniejszego kontraktu writera.
