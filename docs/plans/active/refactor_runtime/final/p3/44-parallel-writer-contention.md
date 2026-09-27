# P3-B / P5-B — odporność na równoległą kontencję writera

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Procesowe E2E dwóch zasobów ujawniło, że poprawny single-writer store może
chwilowo odrzucić publikację jednego schedulera, supervisora albo workera, gdy
drugi proces zapisuje heartbeat lub transition. Część operacji miała bounded
retry, lecz nie obejmowała wszystkich bezpiecznych granic. Skutkiem mógł być
błąd zdrowego workera albo schedulera mimo braku konfliktu claimu i zasobu.

## Zaimplementowane zachowanie

- heartbeat ponawia publikację dokładnie tej samej, podniesionej wersji lease;
- supervisor zachowuje ten sam event envelope i `message_id`; po
  `StoreWriterBusy` używa `retry_publication` i sprawdza, że opublikowano
  dokładnie oczekiwany event;
- recovery decyzji retry ponawia exact release lease i zastosowanie tej samej
  durable decyzji;
- scheduler ponawia dokładnie to samo queue materialization oraz checkpoint
  puli z tym samym expected sequence; konflikt CAS nadal kończy się błędem;
- ponowne otwarcie store dla inboxu i receipt recovery jest objęte tym samym
  ograniczonym retry;
- retry trwa najwyżej 5 sekund i dotyczy wyłącznie typowanego
  `StoreWriterBusy`. Błędy semantyczne, fencing, CAS i publication uncertainty
  nie są maskowane;
- test procesowy trzyma natywny writer lock przez 250 ms podczas startu
  drugiego schedulera. Po zwolnieniu locka oba taski osiągają równoległe
  `Running` i kończą się sukcesem. Test nie opiera się na przypadkowej kolizji
  ani na zagłodzeniu writera przez nierealistycznie częsty heartbeat.

## Dowody

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed parallel-resource process E2E z wymuszoną kontencją | **1 passed, 0 failed** | `52d3c67d2fa94c0d95bdfbb1bdd628f4`; content `c52da19e6ddd7ef1a1d32f4091592dbe9bc360d47776ea564d72287f6947ef50`; `source_changed_during_run=false` |
| Skupione testy supervisora | **9 passed, 0 failed** | `c19554ce606d4c419739abed582a067f`; content `c52da19e6ddd7ef1a1d32f4091592dbe9bc360d47776ea564d72287f6947ef50`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **28 passed, 0 failed** | lokalny `pytest` |
| Integralność diffu | **PASS** | `git diff --check` |

Oba receipty przypinają ten sam dirty snapshot
`master@6dbdf2fcebe1303d08cc775b591bc1bc76413588`. Zweryfikowana implementacja
jest zapisana w `741f1f19171f9b02c904385dfb8f6154d030bcbe`.

## Granice

Dowód obejmuje lokalny single-writer store, dwa procesy schedulera i dwa zasoby
ograniczonej ścieżki FDM CPU double strict. Nie dowodzi rezydentnej usługi,
priorytetów, backpressure, rozproszonego lock managera, zdalnego heartbeat/Stop
ACK, pozostałych lane'ów, fizyki ani wydania. Bounded retry nie ponawia solvera,
nie tworzy nowego command/event envelope i nie interpretuje timeoutu jako
sukcesu.

Przyrost domyka poprawność już zaliczonego zakresu równoległego supervisora,
więc procenty pozostają bez zmian: P3 około **79%**, P5 około **48%**, a cały
plan około **38%**.
