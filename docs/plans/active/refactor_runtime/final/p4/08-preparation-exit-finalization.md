# P4-B — finalizacja zakończenia przygotowania FEM

Data: 27.09.2026
Implementacja: `51a534fe442358b21f9e4169cf2cc5455d812049`

## Kontrakt finalizacji

Store finalizuje preparation attempt dopiero po odczytaniu identycznego,
trwałego `preparation_process_exit_receipt.v1` i dokładnego lease. Sprawdza
RunId, TaskId, preparation attempt, resource_id, token oraz ostatnią sekwencję
heartbeat pod jednym writer lockiem.

Przy exit zero finalizacja wymaga immutable task preparation receiptu. Następnie
zmienia readiness z `accepted_task_awaiting_preparation` na wspólny powód
dependency resolution, podnosi rewizję katalogu i dopiero potem zwalnia lease.
Brak receiptu lub niezgodna readiness kończy się fail-closed bez zwolnienia.

Przy awarii procesu task pozostaje `Accepted/Blocked` i może otrzymać nowy
preparation attempt, ale zasób jest zwalniany wyłącznie na podstawie trwałego
exit receiptu. Bezpośrednie zwolnienie po opublikowaniu exit receiptu jest
odrzucane; caller musi użyć finalizacji.

Kolejność katalog → lease jest celowa. Jeżeli proces hosta przerwie się między
zapisami, ponowiona finalizacja rozpoznaje już przesuniętą readiness, kończy
zwolnienie lease i zwraca replay. Heartbeat pozostaje dozwolony po publikacji
preparation receiptu aż do zebrania procesu, ponieważ sam receipt nie dowodzi
jeszcze zwolnienia zasobów.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-runtime-control -p fullmag-api --bin fullmag-api-preparation-resource-pool --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Supervisor/process E2E/native FEM | **NOT VERIFIED** |

Następny krok to supervisor, który uruchamia dokładne binarium preparera,
odnawia lease, czeka na potwierdzony exit, publikuje exit receipt i wywołuje tę
finalizację. P4 pozostaje na **50%**, cały plan na około **49%**.
