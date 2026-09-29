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
4. [Trwały `AcceptedStateRef` prostego FDM CPU](04-durable-fdm-cpu-accepted-state-ref.md)
   — powiązanie snapshotu z accepted RunId/stage, preparation, planem i
   ownership epoch w immutable worker receipt oraz jego recovery.
5. [Publiczny readback `AcceptedStateRef`](05-public-accepted-state-readback.md)
   — manifest outputów v2, jeden wspólny typ i projekcja refa przez istniejący
   zasób GET run oraz generowany kontrakt TypeScript.
6. [Accepted state prostego FDM GPU](06-fdm-gpu-accepted-state.md) — terminalny
   snapshot magnetyzacji urządzenia, trwały ref i rozszerzona zarządzana bramka
   publicznego readbacku.
7. [Granica zastosowania komendy Live](../p4/20-live-command-application-boundary.md)
   — publiczny readback kroku, czasu i segmentu faktycznego zastosowania komendy.

Materializacja dla coupled/Frozen Spins i FEM, checkpoint compatibility,
observation runtime oraz zarządzana rekwalifikacja nowego refa GPU pozostają
otwarte. P5 wynosi **95%**.
