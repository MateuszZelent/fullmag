# P3/P5 — stabilne współbieżne retry writera

Data checkpointu: 27.09.2026.

Implementacja: `7865603f07fb3ad9b52f70c6e67678a974121406`.

## Problem

Scheduler, dwa supervisory i dwa procesy workerów ponawiały `StoreWriterBusy`
co 10 ms. Identyczne okresy ustawiały konkurentów w lockstep: heartbeat jednego
procesu mógł przez całe pięciosekundowe okno wygrywać z odczytem/recovery
drugiego workera. Procesowa bramka kończyła wtedy taski jako `Failed` przed
rezerwacją side effectu. Diagnostyczny receipt
`6df0cec6e8d74fcfadda92c684c6861e` zachował oba process-exit receipty i
jednoznacznie wskazał `load accepted worker step ... StoreWriterBusy`.

## Rozwiązanie

`fullmag-runtime-control` udostępnia jedną politykę bounded retry używaną przez
scheduler, supervisor i worker. Granice bezpieczeństwa nie zmieniły się:

- retry obejmuje wyłącznie typowany `StoreWriterBusy`,
- ponawiana jest ta sama idempotentna operacja albo zachowany envelope,
- łączny deadline nadal wynosi pięć sekund,
- błędy semantyczne, fencing, CAS i publication uncertainty nadal kończą się
  fail-closed.

Stałe 10 ms zastąpił przedział 5–40 ms z deterministycznym jitterem zależnym od
PID, wątku i numeru próby. Dzięki temu niezależne procesy i wątki nie próbują
ponownie przejąć natywnego locka w tych samych chwilach. Wczesne granice
recovery supervisora otrzymały też dokładny kontekst błędu.

## Dowody

| Bramka | Wynik | Receipt | Content SHA-256 |
|---|---:|---|---|
| `runtime-control` | 5/5 PASS | `2405575ca3ca4929930bc08e598a1d9e` | `f62204bff9425ac63f3000e012f2e3eaf2e9ad503759e5a1f96ead7382ad5c94` |
| Supervisor | 9/9 PASS | `5a85bf1e8d3b49469ede3b96b5072650` | `0e0521139d107f5b6c97a103b684a1018cf012aa7958ac7f950d86fa3b33c086` |
| Statyczna pula, próba 1 | 1/1 PASS | `65becc3ffb0c4a35870fc5b18adb4a69` | `0e0521139d107f5b6c97a103b684a1018cf012aa7958ac7f950d86fa3b33c086` |
| Statyczna pula, próba 2 | 1/1 PASS | `b0ed828fd2054ede8583ce2fab7ada80` | `0e0521139d107f5b6c97a103b684a1018cf012aa7958ac7f950d86fa3b33c086` |
| Wymuszona kontencja dwóch zasobów | 1/1 PASS | `4a44c4639e7d45808910d581348d17c0` | `0e0521139d107f5b6c97a103b684a1018cf012aa7958ac7f950d86fa3b33c086` |

Wszystkie receipty mają kod wyjścia 0, identyczny hash źródła przed i po
wykonaniu oraz `source_changed_during_run=false`. Scoped `git diff --check`
przeszedł.

## Granica checkpointu

Dowód obejmuje lokalny store, scheduler, supervisor i workery ograniczonego
FDM CPU double strict. Nie dowodzi rozproszonej kolejki, zdalnego heartbeat/Stop
ACK, dynamicznej pojemności, pozostałych lane'ów ani braku starego workera na
GPU. Przyrost stabilizuje już policzony zakres P5-B, dlatego procenty pozostają
bez zmian: **P3 83%, P5 60%, całość około 41%**.
