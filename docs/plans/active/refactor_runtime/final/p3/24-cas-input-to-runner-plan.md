# CAS input do planu wykonawczego worker-a — P3-B

Data: 25.09.2026

## Zmiana

`AcceptedWorkerStep` udostępnia teraz deklaracje wejść immutable kroku obok
claimu, planu i `ResolvedTaskInput`. Nowy adapter
`fullmag-api::accepted_study_worker::materialize_resolved_study_inputs`:

- sprawdza spójność run/task/attempt/epoch oraz digest accepted planu;
- wymaga, aby każdy przekazany port był zadeklarowany; brak wymaganego
  zewnętrznego wejścia blokuje wykonanie;
- odczytuje dane wyłącznie po typowanym ref CAS i ponownie waliduje bajty,
  codec oraz digest;
- mapuje tylko `State` i `InitialState` na magnetyzację początkową planu
  FDM, FDM multilayer lub FEM H1 P1. Runner wymaga identycznego layoutu i
  liczby próbek; nie ma interpolacji ani cichego użycia wartości domyślnych;
- tworzy kopię `ExecutionPlanIR`, nie mutując immutable accepted planu.

Authored initial conditions pozostają częścią pinned `ProblemIR` i jego
kanonicznego planu. Wymagane porty scalar i inne nieobsługiwane bindy solvera
kończą się błędem do czasu jawnego adaptera. Regressja wykorzystuje syntetyczny
typowany artefakt CAS, sprawdza identyczność próbek w planie worker-a, brak
mutacji źródła oraz odmowę brakującego i nieobsługiwanego wejścia.

## Weryfikacja

`just verify-api-project-runs`: **6 PASS, 0 FAIL, 2 ignored**, receipt
`1a36a59725664bccbe2dc544f0610259`, `source_changed_during_run=false`.
`just check-api-source`: **PASS**, receipt
`f1046d24fd864d6e81d8d990daef11f8`, `source_changed_during_run=false`.
Repository consistency **PASS**; rustfmt nowego adaptera **PASS**, zmieniony
hunk testu bez różnicy rustfmt.

## Granica odbioru

To jest testowany adapter materializacji danych wejściowych, lecz żaden
production supervisor/worker nie wywołuje go jeszcze. Test nie uruchamia
solvera; jego CAS state jest syntetycznym fixture. Nadal trzeba podłączyć
durable Start do prywatnego katalogu próby, wykonać solver w ramach aktywnego
claimu, zebrać jawne outputy i opublikować je przed terminalnym `Completed`.
Nie ma runtime ani kwalifikacji fizycznej. P3 pozostaje **50%**, a plan globalny
około **27%**.
