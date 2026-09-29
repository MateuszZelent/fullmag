# P6-A — jawna tożsamość bezpośredniego writera modal-eigen

Data: 29.09.2026

Status: **SOURCE VERIFIED / REGRESSION TESTS AUTHORED, NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`FrequencyDomainArtifactIdentity` przenosi dokładne `session_id`, `run_id`,
`stage_id` i `runtime_id` od właściciela wykonania do bezpośredniego writera
modal-eigen. Konstruktor i ponowna walidacja na granicy zapisu odrzucają puste
wartości, znaki sterujące oraz mutable aliasy `current`, `run:current`,
`*:current` i `runtime:not_provided`.

`run_path_or_single` wymaga identity, gdy caller żąda trwałego `output_dir`.
Brak kontekstu zatrzymuje publikację przed utworzeniem
`frequency_domain/manifest.v1.json`. Manifest rodziny oraz
`eigen/field_sweep.v1.json` zachowują dokładne session/run/stage/runtime ID;
ścieżka FEM, która zbiera artefakty osobno i przekazuje `output_dir=None`, nie
otrzymuje sztucznej tożsamości.

Stare dokumenty nie są modyfikowane. Ten przyrost nie zgaduje właściciela z
aktywnej sesji, nazwy katalogu ani ustawień procesu.

## Dowody

- `cargo check -p fullmag-runner --lib`: **PASS**; ostrzeżenia pochodzą z
  wcześniejszych, nieskopowanych miejsc runnera i engine.
- Dodano regression checks dla odrzucenia mutable aliases, odmowy zapisu bez
  identity oraz zachowania dokładnych ID w manifeście i field-sweep.
- Testy pozostają **NOT RUN** zgodnie z tymczasowym zakazem budowania i
  uruchamiania testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Trwałe `mode_field_resource_key` i indeks `resources` nadal zawierają
transportowe `/v2/sessions/current`; ich zamiana wymaga identity-only field
references oraz projekcji route po stronie API. Identity-aware pochodny Kittel
fit jest opisany w checkpointcie 23; jego stare adaptery pozostają legacy.
Writer FMR nie otrzymuje tożsamości wykonania z głównego runner context,
dlatego pozostaje legacy zamiast konstruować fałszywy run. Osobno otwarte są
generatory FEM, copy-on-write migrator starych plików, publiczne API/generated
client oraz runtime i czterolane qualification.
