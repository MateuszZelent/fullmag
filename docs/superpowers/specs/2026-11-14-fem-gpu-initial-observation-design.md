# Początkowe obserwacje FEM GPU bez powtórnej ewaluacji CPU

Status: projekt wykonawczy w zakresie zleconej optymalizacji FEM GPU; kolejne dowody runtime pozostają wymagane. Nie stanowi kwalifikacji całego SP4 ani publikacji wyników pomiarów.

## Cel i granice

Każdy krok fizyczny żądanego toru FEM GPU, także ewaluacja początkowego pola na potrzeby obserwacji, ma korzystać z natywnego kontekstu GPU. Zachowujemy fizykę, warunki brzegowe, tolerancje Poissona i minimizera, torque, certyfikat rzeczywistego residuum oraz pełny zapis Zarr. Cztery realizacje FDM/FEM CPU/GPU i referencja MuMax3 GPU pozostają osobnymi torami.

Obecna automatyczna obserwacja preparera tworzy drugi backend FEM CPU pod leasem przygotowania CPU. Jest jawnie opisana w ADR 0071, lecz powtarza fizykę przed biegiem GPU. Samo zastąpienie `FemCpu` przez `FemGpu` w tym miejscu naruszałoby przydział urządzenia i nadal tworzyłoby drugi backend.

## Rozważone rozwiązania

1. Osobna ewaluacja GPU podczas przygotowania: wymaga osobnego GPU admission i nowego cyklu backendu; nie usuwa powtórnej ewaluacji.
2. Przechwycenie istniejącego początkowego stanu w workerze GPU: decyzja implementacyjna w zakresie bieżącego zlecenia. Worker ma już claim, Start, GPU UUID i compute lease. Native relaxation wylicza początkowe pole przed pierwszym krokiem.
3. Samo usunięcie obserwacji CPU: pozostawia brak równoważnej obserwacji początkowego stanu, więc nie spełnia całego zadania.

## Trwałe pomiary przygotowania

Czasy ewaluacji pól, zapisu bundle/CAS oraz commitu obserwacji muszą być rozłączne. Nie dodajemy zegara do niezmiennego task preparation payload ani obserwacji, ponieważ retry mógłby wtedy zmienić jej immutable identity.

Metryki należą do konkretnego procesu/próby. Dziecko przekazuje je w ograniczonym podsumowaniu, supervisor sprawdza tożsamość i zapisuje opcjonalne `phase_timings` w istniejącym `FmsPreparationProcessExitReceipt`. Stare rekordy bez tego pola pozostają poprawne; wszystkie ścisłe czytniki muszą obsługiwać nową, walidowaną strukturę. Metryki nie udzielają uprawnień ani nie zmieniają wyniku wykonania. Brak/niepoprawne metryki nie mogą zostać uznane za pomiar z zerowym kosztem.

## Obserwacja GPU

- Produkcyjnym punktem wejścia jest `dispatch::execute_native_fem`; niepodpięty `fem/execution.rs` nie jest źródłem wykonania.
- Początkowe stats pochodzą z kontekstu po `begin_stage_with_waveform_origin`. Nie zakładamy globalnie czasu równego zeru.
- Nowy, jawny tryb obserwacji żąda jednego GPU capture przed pętlą; `initial_snapshot=true` pozostaje oddzielnym trybem legacy. Nie włączamy kopii pól na hosta przy każdym kroku.
- Jeden `StepUpdate` zawiera m, pola i rzeczywistą mapę węzłów z tego samego kontekstu i zegara. Istniejący binder, writer, reader i projector sprawdzają layout, run/task/stage/attempt/ownership epoch i mesh generation.
- Początkowy frame ma `finished=false` oraz `terminal_field_snapshot=false`. Nie używa finalnego `AcceptedStateRef` ani terminalnego spoola.
- Stop/Pause zwrócone na początkowym callbacku blokuje pierwszy zaakceptowany krok.
- Budżet/podparcie nośnika może ograniczać obserwację live; nie upoważnia to do ewaluacji CPU ani publikacji niepełnego pakietu jako kompletnego.
- Początkowe i końcowe pola oraz tabela Zarr pozostają zachowane przez istniejący tor artefaktów. Obserwacja live nie jest jedyną kopią danych naukowych.

## Zgodność i dokumentacja

Publiczny Python DSL, ProblemIR, wybór toru, SI i równania nie zmieniają się. Polityka automatycznych obserwacji ADR 0071 wymaga jawnego uaktualnienia dla żądanego GPU: pola przed przyznaniem compute GPU lease nie mogą powstawać na CPU. Stan ten pozostaje rozróżniony od początkowego frame już działającego workera.

Źródła fizyki i polityki solvera: `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md` z jej source-map; architektura: `docs/architecture/backend-golden-masterplan.md`. Nowe opisy obserwacji i źródła należy uzupełnić razem z implementacją.

## Odbiór

Wymagane są testy zgodności starych/nowych receiptów, walidacji czasów i powiązań próby, odrzucania obcego frame/clock/map oraz jednokrotnego initial capture bez legacy per-step kopii. Managed SP4 na rzeczywistym GPU musi zachować energie, torque, residuum, authored m0 i wszystkie dotychczasowe tablice liczbowe Zarr. Czasy runnera i całego publicznego polecenia mierzymy oddzielnie. Zmierzony zysk nie zastępuje pięciu naprzemiennych par ani porównania wszystkich solverów i dynamiki A/B.
