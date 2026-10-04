# P3a — macierz pokrycia tożsamości zasobów

Data checkpointu: 21.09.2026. Dokument jest macierzą source-level dla
frontendowego P3a-B i backendowego pilota P3a-A. Nie jest dowodem wykonania
browser/runtime ani dowodem, że każda metoda zapisu ma już immutable request
context.

## Reguła klasyfikacji

Ścieżka pod `/v2/sessions/current/...` jest **session-bound**, jeśli jej payload
zależy od sceny, runu, meshu, wyników, diagnostyki sesji albo stanu workspace.
Hook session-bound musi:

1. wyprowadzać klucz przez `useSessionScopedResourceKey()` albo równoważny
   jawny `sessionScopedResourceKey()`;
2. mieć `enabled` zależne od kompletnego `session_id + session_epoch`;
3. używać tego samego klucza dla `useResource`, `ResourceCache`, decoded
   buffers i kontrolerów, które zatrzymują wynik poza Reactem;
4. pozostawiać platform health/capabilities oraz listę sesji jako zasoby
   globalne;
5. traktować realtime jako invalidation-only — canonical path może być
   invalidowany, ale nie może zastępować sesyjnego klucza cache.

## Macierz rodzin

| Rodzina | Główny właściciel | Klucz scoped | Stan źródłowy | Pozostały dowód |
|---|---|---|---|---|
| model/geometry | `geometryLifecycleResources.ts` | tak | PASS | browser przełączenia sesji, pełne write fencing |
| meshing/domain/membership | `geometryLifecycleResources.ts` | tak, także FMRM/FMBM i cross-section cache | PASS | decode podczas zmiany sesji, managed evidence |
| simulation/runtime | `studyRuntimeResources.ts` | tak, przez wrapper i ręczne ścieżki | PASS | pełna macierz command/write/persistence |
| checkpoints | `studyRuntimeResources.ts` | tak | PASS | browser restore/import smoke |
| session archive | `session_persistence.rs` | context-bound dla export/commit | PASS | recovery cleanup i browser archive switch |
| recovery list/clear | `session_persistence.rs` | context-bound przez transition fence | PASS | browser recovery switch; pełna izolacja snapshotów recovery |
| data fields/tables/artifacts | `studyRuntimeResources.ts`, `dataPreviewResources.ts` | tak | PASS | spóźniony binary response w browserze |
| planar field/monitor | `planarFieldResources.ts`, `planarMonitorResources.ts` | tak | PASS | canvas/object URL/worker lifecycle |
| analysis results | `analysisResultResources.ts` | tak | PASS | history/live separation i browser smoke |
| analysis runtime | `studyRuntimeResources.ts` | tak | PASS | endpoint inventory i managed run |
| diagnostics/runtime explorer | `studyRuntimeResources.ts`, `runtimeExplorerResources.ts` | tak; platform health/capabilities globalne | PASS | stale detail store i browser selection |
| spins/transport/physics graph | `spinAuthoringResources.ts`, `spinWaveResources.ts`, `physicsGraphResources.ts` | tak | PASS | mutation fencing i restore |
| Frozen Spins/preparation | `frozenSpinsResources.ts`, `useSimulationPreparation.ts` | tak | PASS | preview decode i reconnect |
| visualization/mode composition | `useVisualizationStateResource.ts`, `useVisualizationClientAcksResource.ts`, `ModeComposition*` | tak; kontroler resetuje scope | PASS | WebGL/browser context loss |
| communication policy | `communicationPolicyResource.ts` | tak | PASS | backend events write fencing |
| long field materialization/freshness | `ControlRoomApi.ts`, `ResourceRuntimeStore.ts` | `sessionScopeKey` z klucza zasobu | PASS | pełny inventory metod i browser stale-session smoke |
| session list/status | `useSessionCollection.ts`, `useSessionStatus.ts` | global identity source | INTENTIONAL | nie opakowywać ponownie |
| platform health/capabilities | `runtimeExplorerResources.ts` | global host resource | INTENTIONAL | potwierdzić etykietę host/session w UI |

## Backendowy pilot P3a-A

Context-bound adapter jest dowiedziony source-level dla pięciu rodzin oraz
recovery persistence:

- scene GET/PUT/PATCH;
- przyjęcie compute command i enqueue;
- FMRM JSON/binary read, w tym wariant regionu;
- checkpoint list/get/create/restore;
- recovery list/clear;
- events communication policy GET/PATCH i publikacja realtime.

Każdy z tych handlerów przechwytuje `CurrentLiveRequestContext` przed pierwszym
wolnym `await`, sprawdza epoch po wolnym odczycie i ponownie przed odpowiedzią,
a mutacje dodatkowo pod blokadą przejścia sesji. Testy źródłowe są zapisane,
ale zgodnie z `AGENTS.md` nie są kompilowane ani uruchamiane.

## Otwarte w P3a-B/C

Inspekcja bajtów importowanego `.fms` jest operacją bez aktywnej sesji. Klient
Control Room używa teraz `POST /v2/persistence/imports/inspections`. Dawny
alias `POST /v2/sessions/current/persistence/imports/inspections` usunięto po
sprawdzeniu konsumentów w repozytorium; testy źródłowe wskazują nową ścieżkę.
Write fencing odrębnego import commit pozostaje otwarty.

GET `/v2/sessions/current/events/ws` ma `SOURCE PASS`: backend przypina
kontekst przy upgrade i ponownie sprawdza go przed `hello`, replay, zdarzeniami
i heartbeat; klient nie przekazuje do invalidacji wiadomości z obcego
`session_id` lub `request_scope_epoch`. `RealtimeClient.test.ts` przeszło **8/8**.
Browserowy handshake, replay i przełączenie A→B pozostają `NOT VERIFIED`.

Source-level inventory operacji jest zapisany w
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md); macierz nie zamyka
jeszcze:

- migracji 15 operacji oznaczonych `OPEN` oraz usunięcia legacy aliasów
  `/sessions/current` tam, gdzie kontrakt docelowy może być jawnie sesyjny;
- browserowego scenariusza CAE-42/FINAL-02: A→B w trakcie fetch/decode,
  z asercją braku wpisu w cache/render B;
- managed runtime proof i release qualification.

Ostatni przyrost zamknął źródłowo PUT polityki meshingu obiektu i universe oraz
12 odczytów data-plane pól:
handler używa context-aware scene load/commit, a Object Mesh Policy i Airbox
Inspector przekazują `sessionScopeKey`; data-plane używa wrappera capture/validate
przed i po obliczeniu, a resource hooks przekazują ten sam scope. Browser/runtime
proof pozostaje otwarty.

Commit importu archiwum `.fms` został źródłowo zamknięty: frontend przekazuje
`sessionScopeKey`, backend rewaliduje kontekst i utrzymuje transition fence przy
podmianie `current`, a klient po ACK potwierdza, że aktywna jest właśnie
zaimportowana sesja, zanim zastosuje jej UI state i invalidacje. Testy komendy
przeszły **84/84**; browser/managed proof pozostają otwarte.

Następny krok P3a to przeprowadzenie wierszy `OPEN` przez migrację handlera,
klienta i regresję stale-context. Deduplikacja długich operacji jest już
sesyjna na granicy `ResourceRuntimeStore → ControlRoomApi`; przed managed
runtime evidence pozostaje jeszcze dowód browserowy, pełna izolacja recovery
snapshotów i kwalifikacja pozostałych write paths.
