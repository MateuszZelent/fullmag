# P3-B/P5-B — supervisor procesu accepted worker

Data: 26.09.2026. Baza checkoutu: lokalny `master`, HEAD
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9` z niezatwierdzonymi zmianami.

## Zrealizowane

- Dodano binarium `fullmag-api-accepted-supervisor`. Przyjmuje jawne
  `--store-root`, `--run-id`, `--task-id` oraz limit współbieżności. Bieżący
  kontrakt obsługuje wyłącznie `--max-concurrency 1` i odrzuca inne wartości.
- Supervisor atomowo zajmuje pojedynczy slot w danym `SessionStore`. Drugi
  proces nie może uruchomić workera równolegle. Slot zawiera record ownera;
  pozostałość po awarii jest fail-closed i wymaga jawnego orphan reconciliation,
  bez przejęcia na podstawie wieku pliku.
- Przed spawnem odtwarzany jest dokładny aktywny claim i lease. Supervisor
  uruchamia sąsiednie binarium `fullmag-api-accepted-worker` z dokładnym
  store/run/task, czeka na exit i ponownie odtwarza journal oraz inbox.
- Lease jest zwalniany wyłącznie po terminalnym `Succeeded`, poprawnym
  completion barrier i trwale zastosowanym `Start`. Non-zero exit po trwałym
  `Completed`, ale przed ACK inboxa, może zostać uzgodniony bez ponownego
  solvera. Niejednoznaczny pending effect zachowuje lease.
- Worker potrafi teraz podjąć `pending Start` pozostawiony po trwałym zapisie
  pending. Brak katalogu attemptu pozwala wykonać efekt po raz pierwszy;
  istniejący completed receipt prowadzi wyłącznie do recovery. Katalog z samym
  receipt `started`, bez completion receipt, nadal zatrzymuje wykonanie do
  dalszej rekoncyliacji.
- Binaria workera i supervisora dodano do instalacji CLI, portable bundle oraz
  manifestu Windows MSI. Supervisor domyślnie rozwiązuje worker jako sąsiedni
  plik wykonywalny.

## Weryfikacja

- `just verify-api-accepted-supervisor` — **4 PASS**, receipt
  `bac92167c5cf4a7986b84c2287103873`,
  `source_changed_during_run=false`. Testy obejmują wyłączność i ponowne użycie
  slotu, fail-closed limit oraz rzeczywisty spawn i obserwację wyjścia procesu
  potomnego.
- `just verify-api-project-runs` — **6 PASS, 0 FAIL, 2 ignored**, receipt
  `c4e405429dd2443e9689933d50a5061a`,
  `source_changed_during_run=false`. Regresja pozostawia `Start` jako pending po
  symulowanym wyjściu procesu przed efektem, a następnie kończy dokładny attempt
  i replay nie uruchamia solvera ponownie.
- `just check-api-accepted-worker` — **PASS**, receipt
  `c7a4879dd6174b3d9c25f38f23309131`.
- `python -m pytest -q scripts/test_verify_session_persistence.py` —
  **16 passed**.
- `rustfmt --check`, parser PowerShell dla MSI oraz `bash -n` dla skryptów
  portable/validation — **PASS**.

## Granica dowodu

Test procesu potwierdza granicę spawn/wait, a regresja accepted-run potwierdza
recovery durable pending. Nie wykonano jeszcze pełnego E2E, w którym zbudowany
supervisor uruchamia zbudowany worker nad rzeczywistym accepted store. Nie ma
automatycznego wyboru gotowego taska, konfigurowalnej puli większej niż jeden,
heartbeatów podczas długiego procesu, anulowania, retry policy ani orphan
reconciliation po awarii samego supervisora. Stary slot i niejednoznaczny lease
pozostają bezpiecznie zablokowane, lecz wymagają przyszłego reconciler-a P5-B.

Ten przyrost podnosi P3 do około **58%**, P5 do około **5%**, a cały plan do
około **28%**. Nie stanowi kwalifikacji runtime, fizyki ani wydania.
