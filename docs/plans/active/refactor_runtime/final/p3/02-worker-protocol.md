# P3-B — worker protocol identity

## Aktualny wire contract

Bieżące komendy używają `worker_protocol.v2`, a `Prepare` niesie
`resolved_task_input.v2`. `StepOutput` zawiera typowany CAS reference:
`artifact_id`, `object_ref`, digest, `data_kind` oraz identyfikator i wersję
codec. Session inbox zachowuje możliwość odczytu historycznego v1, ale nie
miesza wersji protokołu w ramach jednej próby. v1 nie jest interpretowany jako
typowane wejście.

## Zakres

Worker nie może publikować ani odpowiadać na podstawie samego session-ID,
aktywnego projektu lub nazwy zasobu. Historyczny komunikat `worker_protocol.v1`
przypina `RunId`, `TaskId`, `AttemptId`, `OwnershipEpoch` i lease token przez
`ClaimIdentity`.

## Komunikaty i fencing

`WorkerCommandEnvelope` jest poleceniem coordinatora. Zawiera `message_id`,
monotoniczną sekwencję oraz jeden z jawnych commandów: `Prepare` z
`ResolvedTaskInput`, `Start`, `Heartbeat`, `Stop` albo `Release`.
`WorkerEventEnvelope` jest obserwacją workera: `Accepted`, `Prepared`,
`Started`, `HeartbeatAck`, `Progress`, `Stopped`, `Completed`, `Failed` lub
`Rejected`. `Completed` nie oznacza samoczynnie zbieżności; musi zawierać
`ScientificAssessment`.

Przed przyjęciem `Prepare` kontrakt porównuje identity resolved input z
claimem. Obcy attempt lub ownership epoch kończy się `ProtocolFenceRejected`.
Sekwencja musi rosnąć, a ponowienie tego samego `message_id` z tym samym
payloadem jest `Replayed`. Ponowne użycie ID z innym payloadem jest konfliktem.
Po terminalnym evencie nowe komunikaty są odrzucane.

## Trwała decyzja retry

`fullmag-session` zapisuje `retry_decision.v1` w
`runs/<run_id>/retry_decisions/<decision_id>.json`. Rekord zachowuje trigger,
akcję, uzasadnienie oraz dokładny `TaskId`/`AttemptId`/`OwnershipEpoch`, a
admission sprawdza ten claim względem durable `run_catalog.json`. Ten sam
`decision_id` z identycznym payloadem jest replayem; zmiana payloadu albo
stary epoch jest odrzucana. Wpis jest uwzględniony w reachability i eksporcie
`.fms`.

To jest trwały zapis decyzji po reconciliation, a nie jeszcze automatyczny
supervisor. Zapis nie tworzy sam nowego `AttemptId`; coordinator musi osobno
opublikować następną migawkę katalogu, a dopiero późniejszy claim może
zwiększyć `OwnershipEpoch`.

## Granica dowodu

`WorkerProtocolLedger` jest procesowym deduperem i walidatorem kontraktu.
Nie jest jeszcze kolejką, supervisorem ani dowodem, że stary proces zakończył
pracę. Trwały lease zachowuje się osobno w
`fullmag-session`; release po utracie heartbeat wymaga zewnętrznej kontroli
procesu lub izolacji urządzenia.

`cargo check --locked -p fullmag-application --lib` przechodzi. Test źródłowy
replay/conflict/terminal fencing jest zapisany, lecz nie został uruchomiony,
ponieważ repozytorium tymczasowo zabrania kompilowania testów jednostkowych
Rust.

Aktualizacja payloadu i dispatchu do `worker_protocol.v2` jest wdrożona
źródłowo. `just check-api-source` przeszedł po zmianie manifestu i completion
barrier (**PASS**, receipt `07f91d8a4dab421ea4f2f14ed36943d4`); regresja
odrzucenia niezarejestrowanego codec przechodzi przez
`just verify-project-application` (**PASS**, receipt
`a514d03c31364d13a325616edc48980f`). Obecnie żaden codec nie jest zarejestrowany,
więc worker boundary odrzuca każde typowane wejście study do czasu dostarczenia
dekodera i osobnej kwalifikacji.
