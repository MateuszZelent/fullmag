# P5-C — wspólny kontrakt `AcceptedStateRef`

Data: 28.09.2026

Status: **SOURCE CONTRACT PASS / RUNTIME MATERIALIZATION NOT VERIFIED**.

## Wynik

`fullmag-runner` eksportuje backend-neutralne typy przyjęte w ADR-0025:

- `AcceptedStateId` z dokładnie siedmioma polami: `run_id`, opcjonalnym
  `stage_id`, `accepted_step` oraz digestami zegara, stanu, domeny i planu;
- `AcceptedStateGeneration` z lokalnymi guardami `runtime_epoch` i
  `accepted_revision`;
- `AcceptedStateRef` jako parę trwałego ID i lokalnej generacji.

Deserializacja każdego rekordu odrzuca nieznane pola. Walidacja odrzuca pusty
`run_id`, pusty podany `stage_id` i digest inny niż kanoniczny
`sha256:<64 lowercase hex>`. Równość trwałego ID obejmuje run i stage, natomiast
zmiana generacji nie zmienia ID.

Kontrakt nie implementuje jeszcze wyliczania czterech digestów. Preimage musi
zostać dostarczony przez lane, który posiada pełny zaakceptowany zegar,
pierwotne nośniki, domenę i resolved plan; wspólny typ nie rekonstruuje tych
danych i nie podstawia brakujących wartości.

## Weryfikacja

- `cargo test -p fullmag-runner observation::tests --lib -- --nocapture`:
  trzy regresje kontraktu **PASS**; filtr objął również pięć istniejących testów
  observation, łącznie **8/8 PASS**.
- po dodaniu strict deserializacji:
  `cargo test -p fullmag-runner observation::tests::accepted_state_ref_round_trips_without_merging_generation_into_identity --lib -- --exact --nocapture`:
  **1/1 PASS**.
- scoped `rustfmt` i `git diff --check`: **PASS**.

## Granica dowodu

To jest wspólny typ źródłowy i walidator. Żaden backend nie publikuje jeszcze
kompletnego `AcceptedStateRef`, a API i checkpointy nie używają go jako
obowiązkowego fence. Brak runtime receiptów oznacza, że nie wolno traktować
tego przyrostu jako kwalifikacji FDM/FEM CPU/GPU ani jako ukończenia
`ObservationRuntime`. P5 pozostaje **90%**, a cały plan około **49%**.
