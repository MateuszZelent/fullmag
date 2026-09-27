# P3-B / P5-B — odkrywanie zaakceptowanych runów ze store

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Jawna pula wielu `--run-id` usuwała zagłodzenie w obrębie podanej listy, ale
operator nadal musiał znać każdy run przed uruchomieniem schedulera. Ten
przyrost dodaje opt-in `--discover-runs true`, którego źródłem jest wyłącznie
trwały rejestr zaakceptowanych intentów w `SessionStore`.

## Zachowanie

- tryb jawny i discovery są rozłączne; brak źródła albo ich połączenie kończy
  się błędem przed schedulingiem;
- każdy skan ponownie wykonuje `list_run_intents`, więc nowy intent może wejść
  podczas ograniczonego okna polling;
- RunId są walidowane i sortowane deterministycznie;
- kursor round-robin jest przechowywany jako tożsamość następnego RunId, dzięki
  czemu zmiana długości listy nie przesuwa go przypadkowo na inny istniejący
  run w obrębie procesu;
- wynik rozróżnia `run_source=explicit` oraz `run_source=store` i raportuje
  wszystkie RunId zaobserwowane w czasie pracy.

## Dowody

Managed trasa `api-accepted-scheduler-discovery-e2e` tworzy dwa intenty o
deterministycznych RunId, materializuje oba taski i uruchamia scheduler bez
żadnego `--run-id`. Oba taski przechodzą przez istniejący admission,
supervisor, worker, publikację i release lease.

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed store-discovery scheduler E2E | **1 passed, 0 failed** | `ccb8f7f6e5a04b2bb976af262896da70`; content `91bb5ee9b1fe140635f992525169ef165e7240b4e8b87d701e92fba29a2ca988`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **26 passed, 0 failed** | lokalny `pytest` |
| Format schedulera i integralność diffu | **PASS** | scoped rustfmt; `git diff --check` |

Receipt przypina dirty
`master@ae82042e5ae3c7056fc9b33890704f5616d81ba2`. Zweryfikowana implementacja
jest zintegrowana w `e6b48e713eb3fe95e06b3411cb9d72c77426b622`.

## Granice

Discovery działa w granicach jednego store i jednego procesu schedulera. Nie ma
jeszcze trwałego kursora między restartami, rezydentnej pętli bez limitu,
priorytetów, backpressure ani dynamicznego odkrywania zasobów. Wykonanie nadal
jest sekwencyjne dla jednej jawnej oferty zasobu. Pozostałe lane'y, zdalny
transport i release urządzenia wymagają odrębnych dowodów.

Ten przyrost podnosi P3 do około **77%** i P5 do około **41%**. Globalny wynik
pozostaje konserwatywnie na poziomie około **36%**.
