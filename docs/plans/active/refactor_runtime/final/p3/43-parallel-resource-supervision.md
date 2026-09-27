# P3-B / P5-B — równoległy supervisor zasobów

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Supervisor procesu miał globalny slot `slot-0`, a publiczny parametr
`--max-concurrency` przyjmował wyłącznie wartość `1`. Uniemożliwiało to
jednoczesne wykonanie dwóch niezależnych tasków nawet wtedy, gdy miały różne,
trwale przydzielone zasoby. Ten przyrost wprowadza ograniczone sloty per
`resource_id` i zachowuje globalny limit współbieżności dla całego store.

## Zachowanie

- nazwa slotu jest wyprowadzana z SHA-256 zwalidowanego `resource_id`; jeden
  fizyczny zasób nie może należeć jednocześnie do dwóch supervisorów;
- owner slotu v3 zapisuje `resource_id`, `max_concurrency`, PID, start token,
  RunId i TaskId. Starszy slot v2 pozostaje czytelny jako limit `1`;
- akwizycja wszystkich slotów jest serializowana writer lease magazynu;
  efektywny limit jest minimum żądania i limitów aktywnych ownerów, więc drugi
  proces nie może poszerzyć wcześniej ustanowionej granicy;
- brak ownera, symlink, nieznany schema albo niepoprawna tożsamość kończą się
  fail-closed. Slot nie jest odzyskiwany na podstawie wieku heartbeat;
- ten sam `resource_id` jest dodatkowo chroniony przez durable resource lease;
  test procesowy potwierdza odmowę drugiego przydziału;
- chwilowa kontencja single-writer jest ponawiana najwyżej przez 5 sekund tylko
  dla operacji idempotentnych albo dokładnie zachowanej publikacji. Outbox
  ponawia ten sam komunikat i message ID; inbox ten sam checkpoint; admission,
  outputy, claim recovery i release używają tej samej tożsamości taska/lease.
  Nie jest ponawiany cały dispatch ani side effect solvera;
- po potwierdzonym zakończeniu oba workery publikują artefakty, terminalny event
  i zwalniają dokładne lease oraz sloty.

## Dowody

Managed process E2E uruchamia scheduler A na `cpu-parallel-a`, sprawdza odmowę
konkurencyjnego schedulera na tym samym zasobie, a następnie uruchamia scheduler
B na `cpu-parallel-b`. Test obserwuje oba taski jednocześnie w `Running`, czeka
na dwa terminalne sukcesy i potwierdza brak aktywnych lease'ów oraz slotów.

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed parallel-resource process E2E | **1 passed, 0 failed** | `2650df727cbd4359b51c7a0286f32382`; content `b257f47cf6a13170b98a3d016d8fd09ec644a18f26108a49f61254a4ac0ce3cf`; `source_changed_during_run=false` |
| Skupione testy supervisora | **9 passed, 0 failed** | `940b79ad3ff04006b58455569e37e38d`; content `b257f47cf6a13170b98a3d016d8fd09ec644a18f26108a49f61254a4ac0ce3cf`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **28 passed, 0 failed** | lokalny `pytest` |
| Integralność diffu | **PASS** | `git diff --check` |

Receipty przypinają dirty
`master@ef13ecb60d6acdf569c2f99b7c3e6bcc0d22b674`. Zweryfikowana implementacja
jest zintegrowana w `ce39157e25fff1bca6c0c6906cd10730b5899926`.

## Granice

Dowód obejmuje dwa lokalne procesy, dwa jawne zasoby CPU i ograniczoną ścieżkę
FDM CPU double strict. Nie tworzy rezydentnej usługi, kolejki priorytetowej,
backpressure ani dynamicznego discovery zasobów. Nie kwalifikuje transportu
zdalnego, heartbeat/Stop ACK przez sieć, zwalniania urządzenia GPU, VRAM,
pozostałych lane'ów, fizyki ani wydania. Single-writer nadal serializuje krótkie
publikacje metadanych; współbieżne są procesy solvera i zasoby, nie transakcje
magazynu.

Ten przyrost podnosi P3 do około **79%** i P5 do około **48%**. Globalny wynik
wynosi konserwatywnie około **38%**.
