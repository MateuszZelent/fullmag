# P5-C/P6 — publiczny readback trwałych ramek obserwacji

Data: 29.09.2026
Status: **SOURCE/API CHECK PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

API v2 udostępnia cienki katalog immutable observation frames dla aktualnego
trwałego runu:

- `GET /v2/sessions/current/data/observation-frames`,
- `GET /v2/sessions/current/data/observation-frames/{frame_id}`,
- `GET /v2/sessions/current/data/observation-frames/{frame_id}/magnetization`.

Lista i szczegół projektują wyłącznie manifest v3 bieżącego zakończonego
attemptu. Reader ponownie sprawdza artifact catalog, membership w
`task.artifact_ids`, ownership epoch, CAS references oraz zgodność pełnego
`AcceptedStateRef`. `frame_id` jest deterministyczny dla kanonicznego refa.
Cursor działa na immutable identity, a opcjonalny `run_id` jest exact
precondition wobec aktywnego runu.

Ciężka magnetyzacja nie trafia do JSON. Endpoint materializuje `m` przez
izolowany `load_study_observation_runtime`, bez odczytu ani podmiany
`LiveRuntime`, i zwraca kanoniczny binary data plane FMVP v4. Metadane v4
zachowują domain/topology/scope oraz dokładne `source_kind`, `source_id`,
`source_revision` i `field_generation_id`. Nagłówki HTTP powtarzają identity,
a klient porównuje je z payloadem fail-closed.

Control Room ma wygenerowany kontrakt OpenAPI, ścieżki w centralnym rejestrze,
metody `ControlRoomApi.data.observationFrames` oraz dekoder FMVP v4. Nie dodano
bezpośredniego `fetch`, drugiego klienta ani osobnego snapshot codec.

## Dowody

- `cargo check -p fullmag-api --bin fullmag-api`: **PASS**,
- generacja OpenAPI JSON/types/client: **PASS**,
- `pnpm --dir apps/control-room typecheck`: **PASS**,
- scoped ESLint kodeka i fasady API: **PASS**,
- strict resource-first gates: **PASS**,
- pozostałe reguły contract guard: **PASS**; wrapper Git Bash nie ma aliasu
  `python3`, więc kontrola dashboardu została wykonana dostępnym Windows Python:
  **PASS**,
- `git diff --check` dla przyrostu: **PASS**.

Regresje serializatora i dekodera FMVP v4 zostały zapisane, lecz nie są
uruchamiane z powodu aktywnego zakazu kompilacji testów jednostkowych.

## Granica

Przyrost kwalifikuje source/API contract wyłącznie dla trwałego źródła prostego
FDM CPU i quantity `m`. Nie stanowi managed process proof, nie kwalifikuje
FDM GPU ani FEM, nie dodaje ogólnego batch `ComputeQuantities`, skalarów,
autosave podczas aktywnego stage ani invalidacji realtime. Brak primary state
pozostaje jawnym `unsupported_missing_primary_state`.

P5 pozostaje na **99%**. P6 rozpoczyna się konserwatywnie na **1%**, a cały plan
pozostaje około **49%**.
