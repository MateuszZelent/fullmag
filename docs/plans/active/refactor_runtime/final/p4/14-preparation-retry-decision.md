# P4-B — jawna decyzja retry preparacji FEM

Data: 28.09.2026
Implementacja: `5c6a4be99`

## Kontrakt

Nieudana preparacja accepted FEM pozostawia task zablokowany i nie uruchamia
automatycznej pętli. Operator może teraz zapisać immutable
`preparation_retry_decision.v1`, która wskazuje dokładny failed
`preparation_attempt_id`, monotoniczny numer retry, stały limit wszystkich prób
oraz przyczynę decyzji. Limit obejmuje próbę początkową.

Store przyjmuje decyzję dopiero po trwałym failed process exit i finalizacji
dokładnego preparation lease. Wymaga ciągłej historii: każda wcześniejsza
awaria ma dokładnie jedną decyzję, kolejne numery nie mają luk, a
`max_attempts` nie zmienia się po pierwszej decyzji. Identyczny replay zachowuje
pierwotny zapis; konflikt tego samego `decision_id` kończy się fail-closed.

Scheduler wylicza sekwencję autoryzacji z trwałych exit receiptów i decyzji.
Sekwencja `0` oznacza pierwszą próbę. Po awarii task nie jest kandydatem do
chwili publikacji decyzji; po kolejnej awarii ponownie wymaga nowej decyzji.
Atomowy zapis lease porównuje sekwencję odczytaną przez scheduler z aktualnym
stanem pod writer lockiem, więc przestarzały kandydat nie może wykorzystać
nowszej autoryzacji.

CLI `fullmag-api-preparation-retry` publikuje decyzję do istniejącego store.
Jeżeli operator nie poda `decision_id`, proces wyprowadza stabilny identyfikator
z immutable payloadu. Binarium jest wymagane przez portable Linux, jego
walidator oraz staging i manifest Windows MSI.

Decyzje są zachowywane pod
`runs/<run_id>/preparation_retry_decisions/<decision_id>.json`. Store
reachability i portable `.fms` walidują typ oraz tożsamość ścieżki zarówno dla
pełnego run manifestu, jak i dla wybranego runu eksportowanego bez niego.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-preparation-retry --bin fullmag-api-accepted-fem-preparation-scheduler` | **PASS** |
| Scoped `rustfmt --check` obu zmienionych binariów | **PASS** |
| Parser Git Bash dla skryptów portable | **PASS** |
| Parser PowerShell skryptu MSI i AST kontraktu Python | **PASS** |
| Statyczne pokrycie trzech punktów pakowania nowego binarium | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Regresja źródłowa pełnego failed attempt → decision → retry oraz odrzucenia starej sekwencji | dodana, **NOT RUN** — aktywny zakaz kompilacji testów jednostkowych |
| Managed scheduler/process/native FEM E2E | **NOT VERIFIED** — Docker Desktop coordinator nie odpowiada |
| Rzeczywisty portable/MSI | **NOT VERIFIED** |

Przyrost domyka trwałą i limitowaną autoryzację retry, lecz nie dowodzi
wykonania procesu ani poprawności native FEM. P4 pozostaje na **50%**, a cały
plan na około **49%** do czasu wykonania regresji i managed process/native E2E.
