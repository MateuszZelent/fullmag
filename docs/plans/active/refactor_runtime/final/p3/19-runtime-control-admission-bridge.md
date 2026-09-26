# P3-B — adapter trwałego admission do claimu aplikacyjnego

Data: 25.09.2026

## Zmiana

`fullmag-runtime-control::commit_claimed_task_admission` łączy claim utworzony
przez warstwę aplikacji z trwałą granicą `SessionStore::commit_task_admission`.
Waliduje zgodność identyfikatorów, fingerprintu, lifecycle `Preparing`, attemptu,
epochu i świeżego lease'u. Przyjmuje wyłącznie task `Queued/Ready` bez claimu
albo dokładny replay istniejącego claimu. Po zapisie odczytuje claim z katalogu
i lease'u i wymaga pełnej zgodności z wejściowym claimem aplikacji.

Adapter mapuje typ zasobu, budżet i token do `FmsResourceLease`. Replay
porównuje tożsamość oraz politykę lease'u; różne lokalne znaczniki czasu
`acquired_at`/`heartbeat_at` nie tworzą konfliktu, a store zachowuje pierwotne
czasy z immutable admission record.

Test accepted-run zastępuje ręczne zapisywanie projected claimu i resource
lease wywołaniem tego adaptera. Sprawdza pierwsze przyjęcie oraz ponowienie tego
samego claimu przed publikacją trwałego `Prepare`.

## Weryfikacja

`just verify-api-project-runs` — **4 PASS, 2 ignored**, receipt
`2a9aa81834e1495f86c7d92de0ab01a6`, `source_changed_during_run=false`.
Test `explicit_project_run_submit_is_durable_and_replays_without_live_session`
przechodzi przez adapter.

`just verify-session-persistence` — **64 testy biblioteki, 9 archiwum i 13
storage PASS**, receipt `828880b3fdac4cb0aa089fdd2e5f7f6e`,
`source_changed_during_run=false`. Obejmuje replay admission przy nowych
znacznikach czasu, naprawę przerwanej projekcji oraz round-trip `.fms`.

`python scripts/check_repo_consistency.py` i `git diff --check` — PASS.

## Granica odbioru

To jest adapter claimu i durable admission, a nie scheduler ani supervisor.
Nadal brakuje produkcyjnego wyboru gotowych tasków, zależności od portów,
limitów współbieżności, transportu/process supervision, uruchomienia solvera
w prywatnym katalogu attemptu oraz obowiązkowej publikacji output manifestu
przed stanem `Completed`. P3 pozostaje **50%**, całość planu około **27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
