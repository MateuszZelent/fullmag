# P3-B / P5-B — trwały kursor fairness schedulera

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Bounded scheduler zachowywał round-robin tylko w pamięci procesu. Restart
zaczynał wybór od początku listy i mógł systematycznie faworyzować pierwszy run.
Ten przyrost zapisuje lokalny, trwały kursor puli po każdym zakończonym
wywołaniu supervisora i odtwarza go w kolejnym procesie schedulera.

## Zachowanie

- `--pool-id` identyfikuje jeden lokalny checkpoint
  `scheduler_pool_checkpoint.v1` w `SessionStore`;
- checkpoint przechowuje źródło runów, znaną listę RunId, następny RunId oraz
  monotoniczną sekwencję;
- zapis jest chroniony single-writer lease, ciągłością sekwencji i CAS;
  identyczne ponowienie jest idempotentne, a konkurencyjna lub przestarzała
  aktualizacja kończy się błędem;
- dla jawnej puli zmiana członkostwa albo kolejności RunId jest odrzucana;
  store-discovery może aktualizować obserwowaną listę;
- kursor jest publikowany dopiero po powrocie supervisora. Awaria przed tym
  zapisem może cofnąć fairness o jeden wybór, ale nie pozostawia nowo
  przyjętego taska bez supervisora;
- checkpoint jest lokalnym stanem operacyjnym objętym reachability i walidacją
  ścieżek. Nie wchodzi do przenośnego eksportu projektu `.fms`.

## Dowody

Managed E2E uruchamia dwa osobne procesy schedulera z tym samym `--pool-id`.
Pierwszy wykonuje run A i zapisuje sekwencję 1 wskazującą run B. Drugi odtwarza
checkpoint, wykonuje run B i zapisuje sekwencję 2 wskazującą run A. Oba taski
kończą się sukcesem, a oba lease'y są zwolnione.

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed persistent-cursor process E2E | **1 passed, 0 failed** | `42ad24467d53494dabaffb3b1522bce7`; content `81dce51a572b37228b7344610cc52b4cbda6632f4d3b6284fa1aa7feb2385018`; log `35906c6f7cf9ca9cade3a71eb992e5e8bb9e0e687a1ef8d729b6a9e89b369012`; `source_changed_during_run=false` |
| Pełna zarządzana bramka SessionStore | **66 biblioteki + 9 archiwum + 13 storage PASS, 0 failed** | `ad768b85eda24b0bbdbb30f75b2269fb`; content `13e6346eccf45cd6e61965f3d3d8f24780245e438ff0cece0b6afce6b5df9f96`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **27 passed, 0 failed** | lokalny `pytest` |
| Format i integralność diffu | **PASS** | scoped rustfmt; `git diff --check` |

Receipty przypinają dirty
`master@564e79e063a9a15c352b4b1b056c30b462a5a9d3`. Zweryfikowana implementacja
jest zintegrowana w `6f2d2416b272f68f11165ea96f6e9b7325e4755e`.

## Granice

Checkpoint nie tworzy rezydentnej usługi ani równoległego schedulera wielu
zasobów. Nadal brakuje priorytetów, backpressure, dynamicznego discovery
zasobów, zdalnego heartbeat/Stop ACK, dowodu release urządzenia i process E2E
pozostałych lane'ów. Cofnięcie kursora po awarii między terminalnym wynikiem a
jego zapisem wpływa tylko na fairness, ponieważ stan workloadu pozostaje
źródłem prawdy.

Ten przyrost podnosi P3 do około **78%** i P5 do około **44%**. Globalny wynik
wynosi konserwatywnie około **37%**.
