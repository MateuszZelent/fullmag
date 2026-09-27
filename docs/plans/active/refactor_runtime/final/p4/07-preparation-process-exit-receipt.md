# P4-B — trwały dowód zakończenia procesu przygotowania

Data: 27.09.2026
Implementacja: `f8417b8ebf82d9240b83a407adda995eee5ec3f3`

## Zaimplementowany kontrakt

`preparation_process_exit_receipt.v1` jest immutable dowodem, że supervisor
rzeczywiście zebrał proces preparera. Receipt utrwala RunId, TaskId,
preparation attempt, zasób, token, ostatnią sekwencję heartbeat, PID, opcjonalny
token startu procesu, exit code, timeout, wynik i ograniczoną przyczynę błędu.

Publikacja wymaga nadal aktywnego, dokładnie zgodnego preparation lease.
Idempotentny replay akceptuje wyłącznie identyczny payload; zmieniony wynik
procesu jest konfliktem. Store udostępnia typowany odczyt, listowanie i recovery
aktywnego lease dla istniejącego exit receiptu. Dzięki temu sam brak PID,
heartbeat timeout albo restart obserwatora nie stanowi dowodu zwolnienia
zasobu.

FMS pack, store reachability i archive preflight zachowują oraz walidują exit
receipty również dla accepted runu bez solverowego `run_manifest.json`.
Wspólny tekst powodu oczekiwania na dependency resolution ma teraz właściciela
w `fullmag-session`, dzięki czemu przyszła atomowa finalizacja nie tworzy
sprzecznego literału między warstwami.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-runtime-control -p fullmag-api --bin fullmag-api-preparation-resource-pool --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Supervisor/process E2E/native FEM | **NOT VERIFIED** |

Następny krok to atomowa, odtwarzalna finalizacja: przy exit zero i zgodnym
preparation receipcie zmienić readiness na dependency resolution, a następnie
zwolnić lease; po błędzie zachować task w stanie oczekiwania i zwolnić zasób
dopiero na podstawie trwałego exit receiptu. P4 pozostaje na **50%**, cały plan
na około **49%**.
