# P5-C — kanoniczne digesty zaakceptowanego stanu

Data: 28.09.2026

Status: **CANONICAL SOURCE CONTRACT PASS / LANE MATERIALIZATION NOT VERIFIED**.

## Wynik

`fullmag-runner` udostępnia teraz `ObservationClock` i
`accepted_state_digests`. Builder:

- odrzuca niefinitywny czas oraz niepoprawny dodatni `dt`;
- rozróżnia brak `dt` od każdej wartości przez jawny znacznik;
- ramkuje każde pole jako `u64_be(length) || bytes`;
- sortuje primary carriers leksykograficznie po `carrier_id`;
- odrzuca pusty lub powtórzony identyfikator nośnika;
- wiąże `state_digest` z tym samym kanonicznym zegarem i kompletem payloadów.

`AcceptedStateId::from_canonical_state` używa jednego wyniku buildera do
`clock_digest` i `state_digest`, zachowuje `accepted_step` z tego samego zegara
oraz waliduje przekazane digesty domeny i planu. Nie przyjmuje preview ani
częściowego zestawu nośników jako substytutu accepted state.

## Known vector i weryfikacja

Dla kroku 42, czasu `2.5e-12 s`, `dt=1.0e-15 s` oraz nośników
`magnetization.f64le.v1=[1,2,3,4]` i `thermal_rng.v1=[9,8,7]`:

- `clock_digest = sha256:261d0b553b39c3df26e5190ea8c7454378708dceea3c85f84ff92425961bc98b`,
- `state_digest = sha256:c55aa55ee9c67629dd15e1b9634b99e59edbbbddc6b63fcebd98b505866a35c2`.

Wartości obliczono niezależnie w Pythonie z tego samego opisanego preimage i
zamrożono w regresji Rust.

- `cargo test -p fullmag-runner observation::tests --lib -- --nocapture`:
  **11/11 PASS** w filtrowanym przebiegu, w tym sześć testów kontraktu.
- ukierunkowany known vector po zamrożeniu wartości: **1/1 PASS**.
- scoped `rustfmt` i `git diff --check`: **PASS**.

## Granica dowodu

Builder nie tworzy `domain_digest` ani `plan_digest` z niepełnych danych.
Każdy lane nadal musi dostarczyć pełne primary carriers, kanoniczną domenę i
resolved plan oraz opublikować `AcceptedStateRef` na granicy zaakceptowanego
kroku. API, checkpoint fencing, rejected-step rollback i managed runtime
pozostają **NOT VERIFIED**. P5 rośnie do **91%**, a cały plan pozostaje około
**49%**.
