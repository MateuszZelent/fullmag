# P3-B / P5-B — ograniczona statyczna pula zasobów schedulera

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Dotychczas jeden proces `fullmag-api-accepted-scheduler` obsługiwał jedną
ofertę zasobu. Równoległość była możliwa przez uruchomienie osobnych procesów,
ale nie istniała centralna, procesowa granica przydziału kilku zasobów. Ten
przyrost dodaje ograniczoną statyczną pulę jako krok przed rezydentną usługą.

## Zaimplementowane zachowanie

- scheduler przyjmuje powtarzalne `--resource-offer <JSON>` z typowanym
  `resource_id`, `kind` i pełnym `ResourceBudget`;
- nowe oferty są rozłączne ze starszym zestawem `--resource-id`,
  `--resource-kind` i flag budżetu; stary interfejs pozostaje obsługiwany;
- identyfikatory zasobów muszą być unikalne, a każda oferta przechodzi tę samą
  walidację co trwały `ResourceLease`;
- jeden proces centralnie wykonuje fenced admission dla wolnych zasobów,
  zachowuje round-robin RunId i dopiero po przydziale partii uruchamia
  równoległe nadzory workerów;
- `max_concurrency` pozostaje globalnym limitem, a `max_tasks` ogranicza cały
  przebieg. Liczba aktywnych workerów nie może przekroczyć żadnej z tych granic;
- główny proces pozostaje jedynym właścicielem aktualizacji checkpointu puli;
- każdy wynik wskazuje dokładny `resource_id`, a summary dodaje
  `resource_count` i uporządkowane `resource_ids`;
- otwarcie store ponawia wyłącznie typowany, krótkotrwały `StoreWriterBusy`;
- strażnik aktywnych workerów dołącza wszystkie nici przy każdym wyjściu z
  procesu, także po błędzie discovery, admission albo checkpointu. Scheduler
  nie pozostawia odłączonego supervisora.

## Dowody

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed E2E jednego procesu z dwoma ofertami CPU | **1 passed, 0 failed** | `496cd7e28ee74d9b802df49fb9a6d109`; content `504511447248ae44101f412be5036ce41d0e26e3af08633ebef420af4a2da1f5`; `source_changed_during_run=false` |
| Managed E2E dwóch procesów, same-resource fencing i kontencja writera | **1 passed, 0 failed** | `cf71502a403641b98139bd4e6859fefc`; ten sam content `504511447248ae44101f412be5036ce41d0e26e3af08633ebef420af4a2da1f5`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **29 passed, 0 failed** | lokalny `pytest` |
| Integralność diffu | **PASS** | `git diff --check` |

Test puli obserwuje oba taski jednocześnie w `Running`, następnie dwa
terminalne sukcesy, dwa różne `resource_id` w summary i brak aktywnych lease.
Test niezależnych procesów nadal potwierdza odmowę drugiego przydziału tego
samego zasobu oraz równoległość różnych zasobów pod wymuszoną kontencją
single-writer. Implementacja: `df69370d2`.

## Granice

To statyczny, ograniczony przebieg. Nie jest jeszcze rezydentną usługą:
brakuje ciągłej pętli operatora, dynamicznego dołączania i usuwania zasobów,
priorytetów, backpressure, zdalnego heartbeat/Stop ACK, transportu CLI,
process E2E pozostałych lane'ów oraz dowodu zwolnienia urządzenia. Dowody nie
kwalifikują fizyki ani wydania.

Po tym przyroście P3 wynosi około **81%**, P5 około **53%**, a cały plan około
**39%**.
