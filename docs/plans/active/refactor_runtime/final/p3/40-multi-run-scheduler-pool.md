# P3-B / P5-B — ograniczona pula wielu runów i round-robin

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego FDM CPU

## Cel przyrostu

Poprzedni scheduler wykonywał dependency-ready taski tylko jednego jawnie
wskazanego RunId. Nie mógł obsłużyć wspólnej kolejki kilku zaakceptowanych
runów ani zagwarantować, że stale gotowy pierwszy run nie zagłodzi kolejnego.

Przyrost rozszerza to samo binarium o jawną, uporządkowaną pulę RunId. Nie
wprowadza dynamicznego discovery ani klastra HPC.

## Kontrakt

- `--run-id` może wystąpić wielokrotnie; brak identyfikatora i duplikat są
  odrzucane przed schedulingiem;
- każdy skan zaczyna się od kursora round-robin, a po wyborze taska kursor
  przechodzi na run następujący po zwycięzcy;
- scheduler zachowuje jedną jawną ofertę zasobu i wykonuje najwyżej jeden
  supervisor naraz, zgodnie z istniejącym globalnym admission fence;
- `--max-tasks` ogranicza łączną liczbę uruchomień;
- `--max-idle-polls` i `--idle-poll-milliseconds` tworzą skończone okno
  oczekiwania. Wykonanie zadania resetuje licznik kolejnych pustych skanów;
- wynik JSON zachowuje pojedyncze `run_id` dla zgodności jednego runu, dodaje
  uporządkowane `run_ids`, `idle_poll_count` oraz RunId przy każdym wykonaniu.

## Dowód E2E

Zarządzana trasa `api-accepted-scheduler-pool-e2e`:

1. zapisuje dwa niezależne immutable RunSpec;
2. materializuje po jednym tasku w każdym runie;
3. uruchamia jedno binarium schedulera z dwoma `--run-id`;
4. potwierdza kolejność `run A -> run B` przy jednym resource ID;
5. sprawdza `Succeeded`, artefakty i brak aktywnego lease obu tasków;
6. żąda trzech tasków przy dostępnych dwóch i potwierdza dokładnie jedno
   ograniczone odpytywanie przed stanem idle.

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed multi-run scheduler pool E2E | **1 passed, 0 failed** | `164acb699d794dafa882bb8cdbd2983e`; content `c0c2917e34b81ddbd5a2a7e487d9016fcd63feae7e7309dee1358e6eda3031bc`; `source_changed_during_run=false` |
| Rejestr tras zarządzanych | **25 passed, 0 failed** | lokalny `pytest` |
| Format i integralność diffu | **PASS** | scoped scheduler format; `git diff --check` |

Receipt przypina dirty `master@9dbdf855842f4f236619863e4bcc05ce33e86fc2`
oraz pełny hash treści objętej trasą. Zweryfikowany zakres implementacji jest
zintegrowany w `40e2475f66631587c26329004fbfa677e1457274`.

## Granice

Pula ma jawny, statyczny zestaw RunId i kończy się po limicie pracy lub
bezczynności. Nie jest jeszcze rezydentną usługą z dynamicznym admission,
priorytetami, trwałym kursorem fairness między restartami ani wieloma
równoległymi zasobami. Dowód obejmuje FDM CPU/double/strict. FDM GPU, FEM
CPU/GPU, zdalny heartbeat/Stop ACK, VRAM release oraz kwalifikacja naukowa i
release pozostają osobnymi bramkami.

Ten przyrost podnosi P3 do około **76%**, P5 do około **39%**, a cały plan do
około **36%**.
