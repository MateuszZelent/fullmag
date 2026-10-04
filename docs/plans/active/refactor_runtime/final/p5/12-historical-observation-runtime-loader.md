# P5-C — fail-closed loader historycznego `ObservationRuntime`

Data: 29.09.2026
Status: **SOURCE CHECK PASS, REGRESJA ZAPISANA / NOT RUN**

## Zakres

`load_study_observation_runtime` przyjmuje dokładny `AcceptedStateRef` i
odtwarza evaluator wyłącznie z trwałego katalogu runu, manifestu v3 oraz CAS.
Nie czyta bieżącej sesji, nie posiada uchwytu do workera ani publishera i nie
podmienia `LiveRuntime`.

Loader wymaga:

- zakończonego bieżącego attemptu i zgodnego ownership epoch,
- dokładnie jednego opublikowanego manifestu należącego do `task.artifact_ids`,
- identycznego pełnego `AcceptedStateRef`, włącznie z generation,
- obu systemowych artifactów descriptor-a o zgodnych typach, hashach i lineage,
- dostępnych bajtów CAS, poprawnego primary snapshotu, codec, gridu i digestu
  terminalnej magnetyzacji.

Dopiero po tych kontrolach tworzy
`ObservationRuntime::from_fdm_cpu_accepted_state`. Zmieniona generacja, obcy
attempt, brak artefaktu lub rozbieżność carrierów kończą się błędem przed
materializacją quantity.

## Dowody

- `cargo check -p fullmag-runtime-control --lib`: **PASS**,
- `cargo check -p fullmag-api --bin fullmag-api-accepted-worker`: wymagany po
  zakończeniu przyrostu,
- regresja accepted-run odtwarza runtime po przejściu tasku do `Succeeded`,
  liczy atomowy batch `m` i odrzuca zmieniony epoch; pozostaje **NOT RUN** z
  powodu tymczasowego zakazu budowania testów jednostkowych.

## Granica

To jest loader źródła dla przyszłego koordynatora. Nie publikuje jeszcze
`observation-results`, nie rozszerza source-aware field data plane, nie dodaje
publicznej komendy `ComputeQuantities` ani invalidacji HTTP/WS. Te elementy
muszą wejść razem, aby nie utworzyć drugiego ownera pól lub ciężkich tablic JSON.

P5 pozostaje na **99%**. Cały plan pozostaje około **49%**.
