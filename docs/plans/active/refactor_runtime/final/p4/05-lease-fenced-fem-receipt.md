# P4-B — publikacja FEM receipt pod preparation lease

Data: 27.09.2026
Implementacja: `2f7e1f45f669096ef53e43567e65c6b81fb46307`

## Zmiana

Proces `fullmag-api-accepted-fem-preparer` wymaga teraz poza RunId i TaskId
także `resource_id`, `preparation_attempt_id` oraz `lease_token`. Przed pracą
sprawdza, że trwały preparation lease należy do dokładnego taska i attemptu.
Nowa materializacja wymaga aktywnego lease.

Publikacja receiptu używa osobnej metody store. Pod writer lockiem store
ponownie odczytuje lease z jego kanonicznej ścieżki, sprawdza RunId/TaskId,
attempt, token i aktywny stan, a dopiero potem zapisuje immutable receipt.
Argument procesu nie jest źródłem prawdy o własności. Idempotentny replay
identycznego receiptu dla tej samej trwałej tożsamości nie uruchamia native
producer'a drugi raz i nie pozwala zastąpić payloadu.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Managed native FEM/process E2E | **NOT VERIFIED** |

Nadal brakuje preparation pool, admission, supervisora, exit receiptu,
recovery oraz atomowej finalizacji readiness i zwolnienia lease. P4 pozostaje
na **50%**, a cały plan na około **49%** do czasu dowodu procesowego i native.
