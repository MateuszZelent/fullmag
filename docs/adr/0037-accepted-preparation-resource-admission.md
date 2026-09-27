# ADR-0037: Admission zasobów dla przygotowania accepted runu

- Status: accepted for implementation
- Data: 2026-09-27
- Decydenci: Fullmag core
- Powiązany plan: `docs/plans/active/refactor_runtime/final/03-plan-refaktoryzacji.md` (P4-B, P5-B)
- Powiązane decyzje: [ADR-0034](0034-coordinator-watermark-recovery.md), [ADR-0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)

## Kontekst

Accepted scheduler uruchamia solver dopiero po obecności trwałego preparation
receiptu. FDM tworzy go deterministycznie z execution planu, natomiast FEM musi
wykonać kosztowny native producer, który buduje i waliduje `mfem::Mesh` oraz
`FiniteElementSpace`. Dodany proces `fullmag-api-accepted-fem-preparer` potrafi
wykonać tę pracę wyłącznie z immutable snapshotu, ale nie ma jeszcze
automatycznego admission ani nadzoru zasobu.

Istniejący `resource_lease.v1` jest kontraktem workera solvera. Wymaga
`attempt_id`, `ownership_epoch` i `resource_id` już zapisanych w run catalogu
przez atomowe task admission; task przechodzi wtedy do `Preparing`, a następnie
`Running`. Użycie tego samego lease dla meshowania oznaczałoby fałszywy claim
solvera, pomieszanie heartbeatów i możliwość uruchomienia workera przed
ukończeniem przygotowania. Sam enum `ResourceKind::Meshing` nie zmienia tego
kontraktu; solverowa pula celowo przyjmuje tylko CPU/GPU.

## Decyzja

1. Przygotowanie accepted runu otrzymuje osobny, wersjonowany
   `preparation_resource_lease.v1`. Lease ma tożsamość zasobu, budżet, RunId,
   TaskId, `preparation_attempt_id`, token, stan, czas pozyskania/heartbeat,
   monotoniczną sekwencję heartbeat i jawny czas zwolnienia. Rodzaj zasobu jest
   zawsze `Meshing`; GPU solvera nie jest domyślnym zasobem przygotowania.
2. Admission przygotowania nie claimuje taska solverowego i nie zapisuje
   `attempt_id`, `ownership_epoch` ani `resource_id` w `FmsTaskCatalogEntry`.
   Task pozostaje `Accepted/Blocked`. FEM bez receiptu używa jawnego powodu
   `accepted_task_awaiting_preparation`; FDM i FEM po ukończonym przygotowaniu
   przechodzą do istniejącego rozwiązywania zależności.
3. Pozyskanie lease jest atomowe pod writer lockiem. Wymaga immutable run
   catalogu, odpowiadającego taska FEM, braku preparation receiptu, braku
   solverowego claimu i właściwego powodu blokady. Powtórzenie identycznej
   tożsamości jest replayem; inny aktywny lease dla tego samego
   `resource_id` jest konfliktem.
4. Wyłączność `resource_id` obejmuje zarówno lease solvera, jak i lease
   przygotowania. Operator musi publikować rozłączne, stabilne identyfikatory
   ofert, ale store nadal odrzuca przypadkowe współdzielenie identyfikatora
   między pulami. Usunięcie oferty nie zwalnia aktywnego lease.
5. Pula przygotowania jest osobnym `preparation_resource_pool.v1`. Nie
   rozszerza `scheduler_resource_pool.v1`, którego semantyka pozostaje
   solverowa CPU/GPU. Oferta `Meshing` wymaga dodatnich CPU, RAM i storage oraz
   zerowego VRAM w pierwszej implementacji FEM CPU.
6. Preparer otrzymuje pełną tożsamość lease. Publikacja
   `FmsTaskPreparationReceipt` dla automatycznej ścieżki wymaga dokładnego,
   aktywnego lease, zgodności TaskId/RunId/preparation attempt oraz ponownej
   walidacji immutable accepted snapshotu. Manualny zapis bez admission nie
   jest produkcyjną ścieżką automatycznego FEM.
7. Sukces procesu nie jest wnioskowany z obecności pliku. Supervisor musi
   uruchomić dokładne binarium, obserwować exit i zapisać
   `preparation_process_exit_receipt.v1`. Dopiero potwierdzony exit zero,
   zgodny preparation receipt i aktywny lease pozwalają atomowo zwolnić lease
   oraz zmienić powód blokady na dependency resolution.
8. Niezerowy exit, timeout albo kontrolowany Stop zachowuje fail-closed stan
   taska i publikuje ograniczoną przyczynę. Lease można zwolnić dopiero po
   trwałym dowodzie zakończenia procesu. Wiek heartbeat, brak PID lub restart
   obserwatora nie są dowodem zwolnienia zasobu.
9. Recovery zawsze sprawdza trwały exit receipt przed nowym spawnem. Brak
   receiptu zachowuje lease jako niejednoznaczny. Idempotentny replay gotowego
   preparation receiptu nie uruchamia native producer'a drugi raz.
10. Solver scheduler nie tworzy preparation lease i nie uruchamia preparera.
    Osobny preparation scheduler/supervisor publikuje receipty; solver widzi
    task dopiero po finalizacji przygotowania. Dzięki temu CPU/GPU claim,
    coordinator journal i worker protocol zachowują jedno znaczenie.
11. Lane FEM GPU pozostaje osobną kwalifikacją. Sukces meshowania na CPU nie
    rozstrzyga requested/resolved urządzenia solvera ani nie uprawnia do
    fallbacku GPU→CPU.
12. Failed preparation nie jest automatycznie ponawiane. Operator publikuje
    immutable `preparation_retry_decision.v1`, przypięte do dokładnego failed
    `preparation_attempt_id`, monotonicznego numeru retry i stałego limitu
    wszystkich prób. Decyzja jest dozwolona dopiero po trwałym exit receipcie i
    zwolnieniu dokładnego lease. Scheduler dopuszcza następną próbę wyłącznie,
    gdy każdy dotychczasowy failed attempt ma jedną decyzję; kolejna awaria
    ponownie blokuje task. Zwiększenie limitu po pierwszej decyzji jest
    odrzucane.

## Konsekwencje

- Task ma rozłączne fazy durable preparation i solver execution bez
  przeciążania istniejącego lifecycle ani ownership epoch.
- Store zyskuje drugi typ lease i osobny katalog, ale globalna wyłączność
  zasobu pozostaje egzekwowana w jednym writer transaction.
- Preparation receipt jest nadal immutable. Finalizacja zmienia wyłącznie
  projekcję readiness i stan lease; nie przepisuje RunSpec, ProblemIR ani
  payloadu receiptu.
- Awaria po publikacji receiptu, lecz przed exit receipt/release, pozostawia
  task zablokowany. Recovery kończy dokładny attempt zamiast uruchamiać native
  producer ponownie.
- Model nie jest schedulerem HPC ani gwarancją limitów OS. Budżet i lease są
  admission/provenance; egzekwowanie limitów procesu wymaga osobnej warstwy.
- Retry preparation pozostawia pełny łańcuch wcześniejszych attemptów i ich
  exit receiptów. Decyzja nie usuwa artefaktów, nie zmienia RunSpec i nie
  autoryzuje solvera; jedynie otwiera admission jednego kolejnego preparation
  attemptu w ramach ustalonego limitu.

## Weryfikacja

- Dwa procesy konkurujące o jeden `resource_id` nie uzyskują równocześnie
  lease solvera i przygotowania ani dwóch preparation lease'ów.
- Admission taska z receiptem, solverowym claimem, innym RunId/TaskId albo
  niewłaściwym readiness kończy się przed spawnem.
- Preparer bez aktywnego lease nie publikuje receiptu; stary token i inny
  preparation attempt są odrzucane.
- Crash przed exit receiptem zachowuje lease. Recovery z poprawnym receiptem
  finalizuje dokładnie raz; utrata ACK nie wykonuje native producer'a drugi raz.
- Retry bez failed exit, przed zwolnieniem lease, dla już zdecydowanego attemptu,
  z luką sekwencji albo ponad `max_attempts` jest odrzucane. Po nowej awarii
  wcześniejsza decyzja nie autoryzuje kolejnej próby.
- Solver scheduler nie wybiera FEM taska przed finalizacją przygotowania, a po
  finalizacji otrzymuje ten sam immutable receipt.
- Managed FEM CPU E2E obejmuje Submit → preparation admission → native
  mesh/H1 → receipt → reap/release → solver admission → worker → output.
  Build, process E2E, walidacja fizyczna i release qualification pozostają
  odrębnymi bramkami.
