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
7. [Fail-closed checkpoint compatibility](07-checkpoint-compatibility.md) —
   kompletne identity dla exact/logical resume, materialny backend state i
   odmowa restore magnetization-only bez mutacji live state.
8. [Izolowany rdzeń `ObservationRuntime`](08-observation-runtime-core.md) —
   jedna content-bound ramka, jawny allow-list quantity i atomowy batch/cache
   bez uchwytu do live runtime'u.
9. [Adapter prostego FDM CPU](09-fdm-cpu-observation-adapter.md) — zachowany
   primary-carrier preimage, osobny digest magnetyzacji i fail-closed
   materializacja historycznego `m`.
10. [Granica zastosowania komendy Live](../p4/20-live-command-application-boundary.md)
   — publiczny readback kroku, czasu i segmentu faktycznego zastosowania komendy.
11. [Trwałe źródło obserwacji w CAS](11-durable-fdm-cpu-observation-source.md)
    — manifest v3, systemowe nośniki niezależne od portów study, fenced
    publication, recovery i completion barrier.
12. [Loader historycznego `ObservationRuntime`](12-historical-observation-runtime-loader.md)
    — exact AcceptedStateRef precondition, odczyt manifestu i carrierów CAS,
    izolowana rekonstrukcja oraz fail-closed stale generation.
13. [Publiczny readback ramek obserwacji](13-public-observation-frame-readback.md)
    — cienki katalog immutable sources, source-qualified FMVP v4 i centralna
    fasada Control Room bez drugiego snapshot API.

Materializacja accepted state dla coupled/Frozen Spins i FEM, ogólna
checkpoint compatibility, ogólny coordinator/result batch `ComputeQuantities`,
adaptery pozostałych lane'ów, autosave frame oraz
zarządzana rekwalifikacja nowego refa GPU pozostają otwarte. P5 wynosi **99%**.
