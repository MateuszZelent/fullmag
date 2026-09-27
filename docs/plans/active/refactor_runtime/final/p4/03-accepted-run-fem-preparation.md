# P4-B — przygotowanie FEM dla zaakceptowanego runu

Data: 27.09.2026
Implementacja: `88bea8d8e` (`feat(runtime): prepare accepted FEM tasks`)

## Problem

Trwały katalog accepted runu publikował przygotowanie automatycznie tylko dla
FDM. Task FEM pozostawał poprawnie zablokowany, ponieważ jedyna materializacja
FEM była związana z mutowalną sesją Live i `scene_revision`. Taki receipt nie
może zostać przepięty do `ProjectRun`: accepted runtime musi użyć wyłącznie
przypiętych `RunSpecification`, `StudyPlan`, `ProblemIR` i execution planu.

## Zaimplementowany kontrakt

- `fullmag-plan` tworzy teraz `preparation_plan.accepted_run.v2` także dla FEM.
  Wspólna implementacja FEM zachowuje wszystkie kontrole native mesh/space,
  ale wybiera rozłączną tożsamość Live albo accepted-run.
- `AcceptedStudySnapshot` materializuje FEM receipt dopiero po ponownym
  zaplanowaniu kanonicznego `ProblemIR` i porównaniu go z przypiętym execution
  planem. Źródło zawiera `run_id`, fingerprint RunSpec i `step_id`.
- Nowy proces `fullmag-api-accepted-fem-preparer` przyjmuje wyłącznie
  `--store-root`, `--run-id` i `--task-id`. Sam odnajduje krok po
  deterministycznym TaskId, wymaga nieprzejętego taska w stanie accepted,
  buduje native mesh/H1 evidence i publikuje istniejący
  `FmsTaskPreparationReceipt`.
- Replay istniejącego receiptu nie powtarza pracy native. Pełny payload jest
  ponownie walidowany przeciw immutable accepted snapshotowi. Wyścig dwóch
  producerów kończy się idempotentnym replayem albo konfliktem, bez podmiany
  receipt'u.
- Build bez `fem-native` zawiera binarium, lecz kończy próbę przygotowania
  fail-closed. Nie ma fallbacku na syntetyczne evidence ani na Live state.

Proces jest świadomym one-shot boundary. Nie wybiera zasobu, nie przydziela
`Meshing` lease i nie mutuje lifecycle taska. Automatyczne uruchamianie go przez
osobny admission/supervisor przygotowania jest następnym krokiem.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-plan -p fullmag-runtime-control -p fullmag-api --bin fullmag-api` | **PASS** |
| `cargo check --locked -p fullmag-api --bin fullmag-api-accepted-fem-preparer` | **PASS**; wariant bez native kompiluje fail-closed |
| `rustfmt --check` nowych plików i `git diff --check` | **PASS** |
| `just runner-container-status` | **NOT VERIFIED** — `Docker Desktop coordinator request failed` |

Nie uruchomiono targetów testów jednostkowych zgodnie z aktywnym zakazem ich
kompilowania. Nie wykonano hostowego builda FEM ani obejścia niedostępnej
kolejki. Build z `fem-native`, rzeczywiste ABI MFEM i procesowe E2E accepted FEM
pozostają `NOT VERIFIED`.

## Następne bramki

1. Zbudować binarium z `fem-native` przez zatwierdzony managed profil FEM CPU.
2. Wykonać accepted-run fixture przez native mesh/H1 producer i potwierdzić
   trwały receipt oraz idempotentny replay.
3. Dodać admission i supervision przygotowania na typowanym zasobie
   `Meshing`, bez używania solverowego CPU/GPU lease.
4. Dopiero po gotowym receipcie rozszerzyć accepted worker o FEM CPU i wykonać
   pełny Submit → prepare → schedule → worker → output → release E2E.
5. FEM GPU kwalifikować osobno, bez wyprowadzania jej z sukcesu FEM CPU.

P4 pozostaje na **50%**, a cały plan na około **49%**. Przyrost usuwa lukę
kontraktu i dodaje produkcyjny punkt wejścia, lecz nie dowodzi wykonania native
ani automatycznego pipeline'u.
