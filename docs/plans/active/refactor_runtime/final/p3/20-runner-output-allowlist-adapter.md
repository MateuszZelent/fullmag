# P3-B — jawna allow-lista wyjść runnera

Data: 25.09.2026

## Zmiana

`fullmag-api::accepted_study_worker::collect_runner_study_outputs` przygotowuje
typowane `StudyOutputPayload` z wyniku `Completed` i jawnych artefaktów runnera.
Adapter nie skanuje katalogu:

- `InitialState` czyta wyłącznie `m_initial.json`;
- `State` czyta wyłącznie `m_final.json`;
- `Scalar` obsługuje wyłącznie jawnie zarejestrowany port `total_energy`,
  mapując końcowe `StepStats.e_total` na `E_total` w dżulach;
- inne porty skalarne i pozostałe typy danych są odrzucane do czasu dodania
  jawnego, wersjonowanego bindingu.

Case ID i porty przechodzą walidację identyfikatora. Katalog próby musi być
rzeczywistym katalogiem, wybrany plik zwykłym plikiem bez symlinku, a jego
kanoniczna ścieżka musi pozostać bezpośrednio pod katalogiem próby. Adapter
egzekwuje łączny limit bajtów, waliduje każdy payload przez istniejący codec i
dopiero wtedy zwraca kompletną listę do `publish_study_outputs`.

Regresja `explicit_project_run_submit_is_durable_and_replays_without_live_session`
używa adaptera przed publikacją. Sprawdza bajty state i scalar w CAS, typed
manifest, pełny zestaw declared ports oraz terminal completion barrier. Osobne
regresje pokrywają fail-closed dla nieobsługiwanego bindingu, nieukończonego
runnera, brakującego artefaktu, przekroczenia limitu, niepoprawnego case ID i
braku końcowego kroku dla `total_energy`.

## Weryfikacja

`just verify-api-project-runs` — **6 PASS, 2 ignored**, receipt
`b890b283aaeb4031a2f9e77f73404cbc`, branch `master`, źródło
`master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`,
`source_changed_during_run=false`. Test przed implementacją zakończył się
oczekiwanym błędem `accepted runner output adapter is not implemented`.
`just check-api-source` — PASS, receipt `c7fdff0fb8fd401992d7b89b7c3d8ed9`,
`source_changed_during_run=false`. `rustfmt --edition 2024` dla nowego adaptera
oraz `git diff --check` — PASS.

## Granica odbioru

To jest adapter danych, nie worker ani supervisor. W kodzie produkcyjnym nadal
brakuje schedulera, wyboru i claimu taska, procesu wykonującego zaakceptowany
`ProblemIR`/plan w prywatnym katalogu próby, transportu zdarzeń, fizycznego
release zasobów oraz call site, który opublikuje payloady przed terminalnym
`Completed`. Nie wykonano solwera ani kwalifikacji runtime/fizyki; P3 pozostaje
**50%**, a całość planu około **27%**.
