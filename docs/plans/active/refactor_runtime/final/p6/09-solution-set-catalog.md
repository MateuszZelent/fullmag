# P6-A — fundament katalogu SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

Nowy moduł `fullmag_quantities::solution_set` definiuje backendowo neutralny,
wersjonowany manifest wyników runu. Kontrakt obejmuje:

- stabilne `solution_set_id`, `run_id`, rewizję i stan open/closed,
- osobny status wykonania i ocenę naukową,
- provenance RunSpec, modelu, fizyki, dyskretyzacji, rozstrzygniętego planu,
  akwizycji oraz opcjonalnego seeda,
- członków dla task/attempt/ownership epoch, case i stage,
- identity-only referencje artefaktów w istniejącym CAS,
- opcjonalne przypięcie artefaktu do dokładnego `AcceptedStateId`,
- jawne `complete`, `partial` albo `unknown` coverage,
- niezmienne segmenty z zakresem próbek i obiektem CAS.

Ocena naukowa nie wynika ze statusu procesu. `Succeeded` może zachować
`tolerance_not_met`, a nieudany albo nieoceniony wynik wymaga przyczyny. Dowody
oceny wskazują istniejące artefakty quality/diagnostic zamiast osadzać dowolne
metryki bez provenance.

Walidacja wymaga kanonicznych digestów provenance, nieroutowalnych bare SHA-256
dla CAS, unikalnych ID oraz prawidłowego `AcceptedStateId`. Zamknięty manifest
nie może mieć statusu `running`. Coverage odrzuca nakładające się lub odwrócone
zakresy, błędny licznik próbek i `complete`, które nie pokrywa dokładnie
`0..expected_samples`.

## Dowody

- `rustfmt` dla zmienionych plików: **PASS**.
- `cargo check -p fullmag-quantities --lib`: **PASS**.
- `cargo clippy -p fullmag-quantities --lib -- -D warnings -A
  clippy::manual_is_multiple_of`: **PASS**. Wyjątek dotyczy istniejącego kodu
  `eval.rs`, poza zakresem przyrostu.
- `git diff --check`: **PASS**.
- Dwie regresje zostały zapisane, lecz pozostają **NOT RUN** zgodnie z
  tymczasowym zakazem budowania i uruchamiania testów jednostkowych w
  `AGENTS.md`.

## Otwarte elementy

Nie ma jeszcze writerów runnera/session, durable catalogu, publikacji
dwufazowej, migracji legacy resource keys, copy-on-write ani publicznego API.
CAE-04/37/61/70, reopen bez solvera oraz kwalifikacja czterech lane'ów pozostają
**NOT VERIFIED**.
