# P5-C — publiczny readback `AcceptedStateRef`

Data: 28.09.2026

Status: **SOURCE/HTTP IN-PROCESS PASS / MANAGED RUNTIME NOT VERIFIED**.

## Wynik

Backend-neutralne typy `ObservationClock`, `AcceptedStateId`,
`AcceptedStateGeneration` i `AcceptedStateRef` mają teraz jednego właściciela
w `fullmag-quantities`. Runner zachowuje kompatybilny reexport, a session,
runtime-control i API konsumują dokładnie ten sam typ.

`study_output_manifest.v2` ma opcjonalne `accepted_state_ref`. Publikacja
outputów waliduje zgodność refa z RunId, stage i ownership epoch przed zapisem
do CAS. Manifest, typed outputy i wpisy katalogu są publikowane pod tym samym
aktywnym lease. Czytnik zachowuje kompatybilność z `study_output_manifest.v1`,
ale v1 nie może deklarować nowego pola.

Istniejący `GET /v2/persistence/projects/{project_id}/runs/{run_id}` odczytuje
manifest bieżącego attemptu z CAS i projektuje ref w
`tasks[].accepted_state_ref`. Nie skanuje prywatnego katalogu workera i nie
tworzy drugiego katalogu accepted state. Brak refa w historycznym lub
nieobsługiwanym manifeście pozostaje `null`; uszkodzony, niejednoznaczny lub
źle ogrodzony manifest daje błąd zamiast częściowej projekcji.

OpenAPI v2 oraz generowane typy TypeScript zawierają struktury ID i generacji.

## Weryfikacja

- produkcyjny `cargo check` session/runtime-control/API: **PASS**;
- accepted-run HTTP submit → worker → manifest v2 → GET run: **1/1 PASS**;
- readback zachowuje identyczne `run_id`, `stage_id`, `state_digest` i
  `runtime_epoch`;
- kompatybilność v1 oraz odmowa refa w v1: **1/1 PASS**;
- filtrowane regresje accepted state runnera po przeniesieniu ownera: **10/10
  PASS**;
- generowanie OpenAPI/types/client oraz typecheck Control Room: **PASS**.

## Granica dowodu

Publiczny readback istnieje wyłącznie dla lane'ów, które faktycznie publikują
pełny ref; obecnie jest to prosty FDM CPU. Coupled/Frozen Spins, FDM GPU i FEM
nie materializują jeszcze kompletu primary carriers. `ObservationRuntime`,
ComputeQuantities, checkpoint compatibility, browser flow oraz managed runtime
pozostają **NOT VERIFIED**.

P5 rośnie do **94%**. Cały plan pozostaje około **49%**.
