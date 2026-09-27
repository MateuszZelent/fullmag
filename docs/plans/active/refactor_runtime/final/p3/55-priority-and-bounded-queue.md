# P3/P5 — immutable priority i ograniczone okno kolejki

Data checkpointu: 27.09.2026.

## Zakres

`run_spec.v2` ma addytywne pole `scheduling_priority` w zakresie od `-1000` do
`1000`. Wartość domyślna `0` nie jest serializowana, dlatego istniejące payloady
i ich fingerprinty pozostają zgodne. Priorytet jest częścią immutable accepted
runu; publiczny readback pojedynczego runu i listy runów zwraca go jawnie.

Rezydentny scheduler:

- porządkuje gotowe runy malejąco po immutable priorytecie;
- zachowuje trwały round-robin między runami o tym samym priorytecie;
- przyjmuje dodatni `--max-queued-runs`, nie mniejszy niż `--max-concurrency`;
- ogranicza lokalne okno rozpatrywanych runów i raportuje
  `peak_queued_run_count` oraz `peak_backpressured_run_count`;
- nie mutuje runów odsuniętych poza okno.

## Dowody

Managed process E2E przyjęło przez produkcyjne CLI sześć runów tego samego
projektu. Run priorytetu `100` zatrzymał się po durable Submit bez
materializacji i nie wszedł do gotowej kolejki. Pozostałe pięć miało priorytety
`10`, `0`, `0`, `0` i `-10`. Przy
`--max-queued-runs 2` scheduler zaobserwował pięć gotowych runów, zaraportował
trzy odsunięte i wykonał kolejno priorytet `10` oraz wszystkie trzy runy klasy
`0`. Publiczny readback pokazał `succeeded` dla wykonanych runów oraz
niezmienione `accepted` dla priorytetu `-10`. Wszystkie cztery dokładne lease'y
zostały zwolnione.

| Bramka | Wynik | Dowód |
|---|---:|---|
| Build CLI/API/publisher/scheduler/worker | PASS | pięć binariów z SHA-256 |
| Immutable priority w Submit/readback | PASS | `10`, `0`, `0`, `0`, `-10` zachowane przez API v2 |
| Readiness przed oknem | PASS | niematerializowany priorytet `100` pozostał poza kolejką |
| Ścisła kolejność i fairness | PASS | kolejność `10`, następnie trzy równorzędne runy `0` |
| Lokalne bounded backpressure | PASS | queue peak `5`, limit `2`, backpressured peak `3` |
| Brak mutacji runu poza wykonanym zakresem | PASS | priorytet `-10` pozostał `accepted` |
| Worker i lease | PASS | worker `completed`, lease `released` |
| Tożsamość źródeł | PASS | `source_changed_during_run=false` |
| OpenAPI v2 i typy TypeScript | PASS | managed codegen receipt `fc5c8a8086894cc6af08b4a531a973eb` |

Runtime receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-api-runtime\resource-discovery-runtime\f36023b7219c4122ad3e1943cf376cac\receipt.json`.

## Granica checkpointu

To jest lokalne backpressure okna schedulera. Publiczny Submit nadal nie ma
limitu backlogu ani odpowiedzi `429`, a operator nie otrzymuje jeszcze trwałego
zasobu ze stanem kolejki. Brakuje również aging/deadline policy, rozproszonej
kolejki między hostami, zdalnego heartbeat/Stop ACK i process E2E pozostałych
lane'ów. Priorytet nie zmienia resource admission i nie omija wymagań
CPU/RAM/VRAM/storage.

Po tym przyroście: **P3 89%, P5 76%, całość około 46%**.
