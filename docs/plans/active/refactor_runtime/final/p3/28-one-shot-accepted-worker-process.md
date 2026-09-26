# P3-B — jednorazowy proces accepted worker

Data: 26.09.2026. Baza checkoutu: lokalny `master`, HEAD
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9` z niezatwierdzonymi zmianami.

## Zrealizowane

- Dodano binarny punkt wejścia `fullmag-api-accepted-worker` z wymaganymi
  argumentami `--store-root`, `--run-id` i `--task-id`. Nie wybiera taska ani
  zasobu i nie tworzy nowego claimu.
- Wspólna orkiestracja odtwarza RunSpec, immutable Study i aktualny claim z
  durable storage. Wymaga jednej ostatniej komendy `Start`, dokładnie jednego
  uprzednio zastosowanego `Prepare`, braku pending inboxa oraz aktywnego claimu.
- Wspierany lane ogranicza się do FDM CPU, double, strict, polityki
  acceptance `Any`, pustych parametrów/seedów i case `default`. Nierozpoznane
  semantyki kończą się błędem.
- Dla fazy `Preparing` worker trwale zapisuje `Started`; wykonanie używa
  wyłącznego katalogu attemptu i zapisuje receipt przed side effectem solvera
  oraz immutable receipt ukończenia z typowanymi refami CAS.
- Przed publikacją do fenced katalogu study worker otwiera świeży uchwyt
  `SessionStore`, odtwarza payloady z completion receipt i CAS, porównuje je z
  wynikiem runnera, publikuje dokładnie odczytane bajty, sprawdza completion
  barrier i zapisuje `Completed`.
- Test API wywołuje tę samą funkcję orkiestracji i potwierdza FDM CPU, provenance,
  typed outputy, publikację CAS oraz replay `Start` bez ponownego solvera.

## Weryfikacja

- `just check-api-accepted-worker` — **PASS**, receipt
  `e81b8634529f45e1abc0ae64746ba7d1`, `source_changed_during_run=false`.
- `just verify-api-project-runs` — **6 PASS, 0 FAIL, 2 ignored**, receipt
  `20028ecacd96470080cbfd6060f1bee6`, `source_changed_during_run=false`.
- `python -m pytest -q scripts/test_verify_session_persistence.py` —
  **15 passed**.
- `rustfmt --edition 2021` dla `accepted_study_worker.rs` i
  `accepted_worker_main.rs` — **PASS**.

Trasa API i test wywołują wspólną funkcję wewnątrz procesu testowego. Binarium
worker skompilowano, lecz nie uruchomiono go jako procesu potomnego nad
rzeczywistą usługą supervisora.

## Pozostałe bramki

To nie zamyka P3-B ani P5-B. Nadal brakuje schedulera i supervisora, który
wybiera gotowe zależności, stosuje jawny limit współbieżności, uruchamia i
obserwuje proces oraz zwalnia lease dopiero po potwierdzeniu jego wyjścia.
Pending inbox po awarii jest odrzucany do reconciliation; ten slice nie
rozstrzyga, czy solver rozpoczął side effect przed awarią, i nie wznawia takiej
komendy. Brakuje recovery dla okien między receipt, CAS, catalogiem, `Completed`
i `applied`, ścieżek cancel/retry, pozostałych lane'ów oraz managed runtime,
browser i kwalifikacji fizycznej.

Następny krok P3-B/P5-B: supervisor powinien uruchamiać dokładnie jeden worker
dla aktywnego claimu, obserwować terminalny exit, a po awarii uzgadniać receipt,
journal, inbox i lease. Nie wolno ponawiać solvera ani zwalniać zasobu na
podstawie timeoutu lub wieku procesu.
