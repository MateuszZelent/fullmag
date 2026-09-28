# Checkpoint P5 — bezpieczny runtime i live steering

Status: **P5 IN PROGRESS**.

P5 obejmuje fencing i recovery workerów, sterowanie na granicach
zaakceptowanego stanu, trwałą tożsamość źródła oraz rozdzielenie authoringu od
aktywnego runtime'u.

## Przyrosty

1. [Kontrakt `AcceptedStateRef`](01-accepted-state-ref-contract.md) — dokładny
   siedmiopolowy trwały identyfikator, osobna generacja runtime'u, strict
   deserializacja i walidacja kanonicznych digestów.
2. [Kanoniczne digesty accepted state](02-accepted-state-canonical-digests.md) —
   jednoznaczne ramkowanie zegara i kompletnego zbioru primary carriers oraz
   zamrożony known vector.
3. [Snapshot zaakceptowanego stanu FDM CPU](03-fdm-cpu-accepted-state-snapshot.md)
   — rzeczywisty terminalny stan prostego lane'u CPU związany z jego receipt'em
   transakcyjnym, z fail-closed dla brakujących nośników sprzężonych.
4. [Granica zastosowania komendy Live](../p4/20-live-command-application-boundary.md)
   — publiczny readback kroku, czasu i segmentu faktycznego zastosowania komendy.

Pełna materializacja digestów przez wszystkie lane'y, publikacja
`AcceptedStateRef` w runtime/API, checkpoint compatibility, observation runtime
i managed qualification pozostają otwarte. P5 wynosi **92%**.
