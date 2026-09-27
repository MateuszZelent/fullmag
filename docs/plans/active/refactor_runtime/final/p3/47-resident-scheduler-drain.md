# P3/P5 — bezpieczny drain rezydentnego schedulera

Data checkpointu: 27.09.2026.

Implementacja: `78e747ee400a65158d3037b6831e714d97a55154`.

## Zakres

`fullmag-api-accepted-scheduler` może działać bez limitu tasków przez
`--max-tasks 0`, ale wyłącznie razem z `--resident true`. W trybie ograniczonym
zero pozostaje błędem konfiguracji. Rezydentny proces obsługuje:

- `SIGINT` i `SIGTERM` na Unix,
- `CTRL_C` i `CTRL_BREAK` na Windows.

Po odebraniu sygnału scheduler przestaje wykonywać nowe admission, czeka na
zakończenie aktywnych nadzorów, zapisuje checkpoint puli, zwalnia dokładny lease
i kończy summary ze statusem `drained`. Summary ujawnia również
`shutdown_requested` oraz `max_tasks`; brak limitu jest serializowany jako
`null`.

Na Windows worker otrzymuje własną grupę procesu. Dzięki temu `CTRL_BREAK`
skierowany do grupy schedulera nie kończy aktywnego workera przed zakończeniem
drain. Supervisor nadal obserwuje worker, publikuje receipt wyjścia i zachowuje
dotychczasowe fencing oraz release po terminalnym wyniku.

## Dowody

| Bramka | Wynik | Receipt | Content SHA-256 |
|---|---:|---|---|
| Resident drain E2E | PASS | `35134cc2923e409bb174a2353fe2023f` | `cf27b562fe77b7e597d5750c2c75ad6e88d90c500be2d115a71d4f8ac3df89b6` |
| Statyczna pula zasobów, próba 1 | PASS | `19d19fe847d54ac39fc27bb8b3a1fddf` | `cf27b562fe77b7e597d5750c2c75ad6e88d90c500be2d115a71d4f8ac3df89b6` |
| Statyczna pula zasobów, próba stabilności | PASS | `708db2cbb93545c691662e2e364baeac` | `cf27b562fe77b7e597d5750c2c75ad6e88d90c500be2d115a71d4f8ac3df89b6` |
| Trwały kursor fairness | PASS | `90c10f0258d341969241aa3a8a8adcaf` | `cf27b562fe77b7e597d5750c2c75ad6e88d90c500be2d115a71d4f8ac3df89b6` |
| Rejestr tras Python | 31/31 PASS | lokalna bramka kontraktu | bieżący diff |
| `git diff --check` | PASS | lokalna kontrola | bieżący diff |

Wszystkie managed receipty mają `source_changed_during_run=false` i identyczny
hash treści przed i po wykonaniu. Test drain potwierdza aktywny task zakończony
`Succeeded`, drugi task pozostawiony w `Accepted`, brak aktywnego lease oraz
summary `status=drained`, `shutdown_requested=true`, `max_tasks=null`.

Praca była prowadzona test-first. Pierwsza próba odrzuciła `--max-tasks 0`,
następna ujawniła zakończenie schedulera przez `CTRL_BREAK`, a kolejna propagację
tego sygnału do workera. Dopiero osobna grupa procesu workera pozwoliła
zachować kontrolowany drain. Jedna regresja puli zasobów zakończyła drugi task
stanem `Failed`; po rozszerzeniu diagnostyki dwie kolejne próby na identycznym
źródle przeszły. Ulepszony komunikat zachowuje lifecycle i process-exit
receipty przy przyszłym niepowodzeniu.

## Granica checkpointu

Checkpoint zamyka zaplanowany brak graceful shutdown/drain oraz bezpiecznego
trybu bez limitu tasków dla lokalnego rezydentnego schedulera. Nie dowodzi:

- dynamicznego członkostwa puli zasobów,
- priorytetów, limitów per kolejka ani backpressure,
- zdalnego heartbeat/Stop ACK i potwierdzenia zwolnienia urządzenia,
- process E2E pozostałych lane'ów,
- kwalifikacji fizycznej ani release.

Po tym przyroście P3 wynosi około **83%**, P5 około **60%**, a cały plan około
**41%**. Procenty opisują wykonany zakres planu, nie gotowość produkcyjną.
