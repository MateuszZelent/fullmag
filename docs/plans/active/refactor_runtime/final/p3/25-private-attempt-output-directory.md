# Prywatny katalog outputu accepted worker attemptu

Data: 25.09.2026

## Zmiana

`fullmag-api::accepted_study_worker::create_private_attempt_output_dir` rezerwuje
katalog `runs/<run_id>/worker-attempts/<task_id>/<attempt_id>/epoch-<n>` dla
jednego accepted claimu. Przed utworzeniem ścieżki odtwarza bieżący claim z
run catalogu i aktywnego resource lease pod session-store writer lockiem.
Identyfikatory ścieżki przechodzą walidację store ID, każdy istniejący katalog
jest sprawdzany jako rzeczywisty katalog bez symlinka, a leaf attemptu powstaje
wyłącznie raz. Zastany leaf wymaga reconciliation i nie może służyć do ponownego
uruchomienia solvera.

Accepted-run regresja używa tego katalogu dla syntetycznego `m_final.json`:
przeterminowany heartbeat jest odrzucony przed utworzeniem `worker-attempts`,
aktywny claim tworzy ścieżkę w obrębie session store, a ponowne wywołanie odrzuca
istniejący leaf. Dalsza allow-lista i fenced CAS publication pozostają
sprawdzane w tym samym scenariuszu.

## Dowody i granice

- `just verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt
  `8e9cd7bcc1e14c2fbd2386b669419805`; `source_changed_during_run=false`.
- `just check-api-source`: **PASS**, receipt
  `56f0964386bb471c9da2d3817634602b`; `source_changed_during_run=false`.
- `rustfmt --check` adaptera oraz scoped diff check regresji: **PASS**.
- Pierwsza próba regresji przed implementacją zakończyła się oczekiwanym
  błędem kompilacji z powodu brakującego helpera; po implementacji cały route
  przeszedł.

Rezerwacja katalogu nie jest trwałym receipt side effectu i nie zastępuje
`DurableWorkerInbox`. Nie ma jeszcze production call site, procesu supervisora,
heartbeat/reconciliation workera ani rzeczywistego wykonania solvera. Nie
kwalifikuje też limitu storage dla pełnego drzewa artefaktów runnera. CAS,
manifest i completion barrier nadal muszą zostać połączone z wynikiem
rzeczywistego worker procesu. P3 pozostaje **50%**, całość planu około **27%**;
runtime, browser, device oraz walidacja fizyczna pozostają **NOT VERIFIED**.
