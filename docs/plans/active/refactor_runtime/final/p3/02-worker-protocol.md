# P3-B — worker protocol identity

## Aktualny wire contract

Bieżące komendy używają `worker_protocol.v3`, a `Prepare` niesie
`resolved_task_input.v2`. `StepOutput` zawiera typowany CAS reference:
`artifact_id`, `object_ref`, digest, `data_kind` oraz identyfikator i wersję
codec. Session inbox zachowuje możliwość odczytu historycznego v1 i v2, ale
nie miesza wersji protokołu w ramach jednej próby. v1 nie jest interpretowany
jako typowane wejście, a nowy attempt używa v3.

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
`Started`, `HeartbeatAck`, `Progress`, `Completing`, `Stopped`, `Completed`,
`Failed` lub `Rejected`. `Completing` zamyka przyjmowanie nowego sterowania,
po czym worker drenuje durable inbox i dopiero publikuje outputy oraz
`Completed`. `Completed` nie oznacza samoczynnie zbieżności; musi zawierać
`ScientificAssessment`.

Przed przyjęciem `Prepare` kontrakt porównuje identity resolved input z
claimem. Obcy attempt lub ownership epoch kończy się `ProtocolFenceRejected`.
Sekwencja musi rosnąć, a ponowienie tego samego `message_id` z tym samym
payloadem jest `Replayed`. Ponowne użycie ID z innym payloadem jest konfliktem.
Po terminalnym evencie nowe komunikaty są odrzucane.

Każdy wpis journalu przechowuje checkpoint obu strumieni. Store wymaga
dokładnego wspólnego prefiksu command/event pod jednym writer lockiem.
`Heartbeat` zwiększa fizyczną sekwencję lease dopiero po odpowiadającym
`HeartbeatAck`. `Stop` jest applied przez worker i kończy się jego własnym
`Stopped`; supervisor nie interpretuje samego pollingu PID ani kill procesu
jako ACK.

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
Durable inbox, journal i lokalny supervisor realizują obecnie transport v3 dla
accepted FDM CPU. Nadal nie dowodzą zakończenia starego procesu na innym hoście
ani zwolnienia zdalnego urządzenia; ta granica wymaga osobnej izolacji i
kwalifikacji lane'u.

`cargo check --locked -p fullmag-application --lib` przechodzi. Test źródłowy
replay/conflict/terminal fencing jest zapisany, lecz nie został uruchomiony,
ponieważ repozytorium tymczasowo zabrania kompilowania testów jednostkowych
Rust.

Aktualizacja payloadu i dispatchu do `worker_protocol.v2` jest wdrożona
źródłowo. `just check-api-source` przeszedł po zmianie manifestu i completion
barrier (**PASS**, receipt `07f91d8a4dab421ea4f2f14ed36943d4`); regresja
odrzucenia niezarejestrowanego codec przechodzi przez
`just verify-project-application` (**PASS**, receipt
`a514d03c31364d13a325616edc48980f`). Późniejszy przyrost zarejestrował
kanoniczne kodeki magnetyzacji i skalarów SI; nieznany codec nadal jest
odrzucany fail-closed.

Aktualizacja 27.09.2026: produkcyjny transport `worker_protocol.v3` ma managed
process E2E dla sukcesu i publicznego Stop ograniczonego FDM CPU/double/strict.
Receipt `ee5c9689c1af4be7b11797c3815d960b` sprawdza dokładne pary
`Heartbeat`/`HeartbeatAck`, atomowy wspólny checkpoint, `Completing` przed
`Completed`, applied inbox, worker-originated `Stopped`, process-exit receipt i
release ostatniej potwierdzonej wersji lease. Source check: PASS, receipt
`3467a65769be4235bf64e87bfcd1e2f3`. Testy jednostkowe pozostają **NOT RUN** z
powodu aktywnego zakazu kompilowania targetów testowych.
