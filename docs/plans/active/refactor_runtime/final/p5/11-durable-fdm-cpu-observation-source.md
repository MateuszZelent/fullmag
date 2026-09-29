# P5-C — trwałe źródło obserwacji prostego FDM CPU

Data: 29.09.2026

Status: **SOURCE CHECK PASS / TEST NOT RUN / MANAGED RUNTIME NOT QUALIFIED**.

## Wynik

`study_output_manifest.v3` ma opcjonalny `observation_source.v1`. Descriptor
wiąże dokładny `AcceptedStateRef` z dwoma systemowymi artefaktami CAS:

- strict snapshotem accepted state z preimage primary carriera;
- terminalną magnetyzacją `m` w `fullmag.runner.field_json@v1`.

Zachowuje również grid, adapter, artifact IDs i allow-listę quantity. Nośniki
nie są deklarowanymi portami `StudyOutput`, dlatego istnieją także wtedy, gdy
study nie deklaruje portu `State`. Są publikowane z manifestem pod tym samym
aktywnym lease i ownership epoch. Po publikacji immutable freeze dopuszcza
wyłącznie dokładny replay całego zestawu.

Accepted worker prostego FDM CPU przed zapisaniem completed receiptu ponownie
dekoduje snapshot i terminalny stan oraz buduje z nich rzeczywisty,
odizolowany `ObservationRuntime`. Receipt przechowuje CAS refs i rozmiary obu
nośników. Recovery odczytuje dokładne bajty z CAS, sprawdza budżet unikalnych
obiektów, clock, digesty, grid i codec. Completion barrier wykonuje tę samą
walidację i odrzuca systemowy artefakt spoza descriptor allow-list.

Manifesty v1 i v2 pozostają dekodowalne. Nie mogą zawierać
`observation_source`, więc historyczny manifest nie jest fałszywie promowany do
źródła obserwacji.

## Weryfikacja

- `cargo check -p fullmag-session -p fullmag-runtime-control --lib`: **PASS**;
- `cargo check -p fullmag-api --bin fullmag-api-accepted-worker`: **PASS**;
- `git diff --check`: **PASS** po finalnym przeglądzie;
- zapisana regresja procesu workera sprawdza descriptor, oba catalog entries,
  CAS bytes, digest snapshotu i zgodność terminalnego `m`;
- testów jednostkowych/integracyjnych nie budowano ani nie uruchamiano zgodnie
  z tymczasową regułą repozytorium.

## Granica dowodu

Przyrost obejmuje wyłącznie prosty FDM CPU. Nie kwalifikuje coupled/Frozen
Spins, FDM GPU, FEM CPU/GPU, autosave frames, publicznej operacji
`ComputeQuantities`, managed runtime, browsera ani zgodności naukowej pól
pochodnych. `ObservationRuntime` publikuje z tego źródła tylko quantity `m`.

P5 rośnie do **99%**. Cały plan pozostaje około **49%**.
