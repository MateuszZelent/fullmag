# P3-B/P5-B — automatyczny retry przed efektem workera

Data checkpointu: 26.09.2026. Baza źródeł:
`master@8f5bd1f05ca0af740fdbca7eba0a5d1909d1fbb4`; bieżący przyrost jest
przypięty hashami treści w receiptach.

## Zrealizowany kontrakt

`fullmag-api-accepted-supervisor` przyjmuje opcjonalny limit
`--max-automatic-retries`. Wartość domyślna `0` zachowuje dotychczasową
politykę bez automatycznych ponowień. Dodatnia wartość jest limitem wszystkich
decyzji `Retry` dla taska w danym runie, niezależnie od attemptu.

Po niezerowym wyjściu workera supervisor rozróżnia dwa stany oczekującej
komendy `Start`:

- brak prywatnego katalogu `worker-attempts/<task>/<attempt>/epoch-<n>` dowodzi,
  że worker nie zarezerwował jeszcze wykonania; supervisor może trwale zapisać
  retryable `Failed`, zwolnić dokładny lease i zastosować fenced decyzję
  `Retry`;
- istniejący, rzeczywisty katalog attemptu oznacza, że efekt mógł się zacząć;
  supervisor zachowuje lease i kończy fail-closed z obowiązkiem rekoncyliacji.

Automatyczna decyzja ma deterministyczne ID z task/attempt/epoch, trigger
`WorkerDisconnected`, zachowuje przyczynę procesu i przechodzi przez istniejący
`SessionStore::apply_retry_decision`. Task wraca do `Queued`, a attempt i
przypisanie zasobu są czyszczone dopiero po zwolnieniu lease. Store udostępnia
bezpieczne, stabilnie sortowane `list_retry_decisions`, używane do egzekwowania
limitu i audytu.

Worker ponawia przez maksymalnie pięć sekund wyłącznie przejściowy
`StoreWriterBusy` podczas odczytu aktywnego claimu i accepted step przed
efektem. Inne błędy nie są ponawiane. Supervisor nadal ponawia krótką kolizję
heartbeat bez zabijania potomka.

## Weryfikacja

- `just verify-api-accepted-supervisor-automatic-retry-e2e`: **1/1 PASS**,
  receipt `8728e7210f0049649736b1053948cb3e`;
- `just verify-api-accepted-supervisor-e2e`: **1/1 PASS**, receipt
  `5d7f89a873214c80bc2d641a6492a17f`;
- `just verify-api-accepted-supervisor-cancel-e2e`: **1/1 PASS**, receipt
  `0e45731c322f44359aee836cbeb27aeb`;
- `just verify-api-accepted-supervisor-prestart-cancel-e2e`: **1/1 PASS**,
  receipt `f9b68085093a47929992101293763bc0`;
- `just verify-api-accepted-supervisor`: **PASS**, receipt
  `401ff0a6749c4818ada2e175890e4f58`;
- `just verify-session-persistence`: **PASS**, receipt
  `000cf93e962b40318deb7bf7b1b1799c`;
- `just check-api-source`: **PASS**, receipt
  `aa663914b2b04fecbf9e986de707a1eb`;
- `python -m pytest -q scripts/test_verify_session_persistence.py`:
  **20/20 PASS**;
- `python -m py_compile` dla skryptu tras i jego testu oraz scoped
  `git diff --check`: **PASS**.

## Granica dowodu

Dowód obejmuje jeden lokalny proces FDM CPU/double/strict i retry tylko przed
rezerwacją efektu. Supervisor nie wybiera jeszcze automatycznie kolejnego
ready taska, więc decyzja pozostawia task `Queued`; jej wykonanie wymaga
następnego dispatchu. Zwolnienie lease i zastosowanie decyzji są dwiema
fenced operacjami, ponieważ `apply_retry_decision` wymaga braku aktywnego lease.
Awaria supervisora pomiędzy nimi pozostawia terminalne `Failed` bez
automatycznej decyzji i wymaga orphan/retry reconciliation. Nadal otwarte są
zdalny heartbeat/`StopAck`, konfigurowalna pula oraz process E2E FDM GPU i obu
lane'ów FEM.

Ten przyrost podnosi P3 do około **68%**, P5 do około **27%**, a cały plan do
około **32%**.
