# Plan: Refaktoryzacja Interactive Runtime do prawdziwej parity z amumax

**Data**: 2026-03-30  
**Status**: AKTYWNY  
**Priorytet**: KRYTYCZNY  
**Horyzont**: 3-5 tygodni skoncentrowanej pracy  
**Powiązane dokumenty**:
- `docs/plans/active/MASTERPLAN-refactoring-2026-03-29.md`
- `docs/plans/active/interactive-runtime-design-2026-03-29.md`
- `docs/plans/active/interactive-session-mode-plan-2026-03-25.md`
- `docs/plans/active/comsol-web-local-live-refactor.md`
- `docs/plans/active/script-model-builder-runtime-resolution-2026-03-29.md`
- `docs/specs/fullmag-application-architecture-v2.md`

---

## 1. Cel dokumentu

Ten dokument definiuje **bezkompromisowy plan** doprowadzenia interactive runtime Fullmag do stanu, w którym:

1. zmiana display selection (`m`, `H_demag`, `H_ex`, `H_eff`, energie) jest szybka i semantycznie poprawna,
2. `pause`, `break`, `resume`, `run`, `relax`, `refresh` działają jako prawdziwe komendy runtime, a nie jako obejścia oparte o "zatrzymaj segment przy najbliższej okazji",
3. podczas `running` UI **nie czeka na koniec długiego solver step**, jeśli backend da się bezpiecznie checkpointować,
4. backend state, display state i control-plane mają jeden spójny model ownership i kolejności,
5. produkt zachowuje się jak `amumax`, a nie tylko "sprawia wrażenie interaktywnego".

To nie jest plan kosmetyczny. To jest plan usunięcia architektonicznego źródła laga i niespójności.

### 1.1 Miejsce tego planu w docelowym produkcie

Docelowy produkt Fullmag nie jest samym `amumax clone`.

Docelowy produkt to **hybryda**:

- `amumax`-style runtime responsiveness,
- `COMSOL`-style application workflow,
- Python jako publiczna warstwa authoringowa,
- jeden launcher, jeden live workspace, jeden model prawdy.

Ten dokument jest **trackiem runtime/control-room** w tym szerszym celu.

To oznacza dwie rzeczy:

1. ten plan jest **konieczny**, bo bez niego Fullmag nie uzyska prawdziwie natychmiastowego interactive runtime,
2. ten plan **nie jest samowystarczalny** dla pełnej hybrydy produktu, jeśli nie zostanie wykonany razem z:
   - live app spine i root workspace z `comsol-web-local-live-refactor.md`,
   - semantic model-builder workflow z `script-model-builder-runtime-resolution-2026-03-29.md`.

Sukces tego planu nie może być więc oceniany wyłącznie jako "preview działa szybciej".
Musi być oceniany jako dostarczenie runtime layer, którą da się bezpośrednio osadzić w:

- jednej lokalnej aplikacji webowej,
- command console,
- model-builder driven workflow,
- docelowym `fullmag script.py`.

---

## 2. Prawda o stanie obecnym

### 2.1 Co działa

- `awaiting_command` ma już live runtime ownership dla części ścieżek.
- istnieje unified control stream z `seq`.
- display sync nie idzie już przez legacy `preview_update` / `preview_refresh`;
  host obserwuje kanoniczne `display_revision` i budzi refresh przez wewnętrzny `display_sync`.
- FDM i FEM potrafią wykonać część interactive flow bez pełnej rematerializacji problemu.

### 2.2 Co nadal nie działa jak w amumax

1. **Podczas `running` zmiana quantity jest nadal step-gated**  
   Runner odczytuje zmianę selection tylko przed `backend.step(...)` albo po nim.  
   To oznacza, że długi krok solvera blokuje reakcję UI.

2. **`pause` nie jest prawdziwym `pause`**  
   Obecna semantyka jest bliższa "przerwij bieżący segment i wróć do hosta" niż "zatrzymaj runtime w stanie paused i pozwól wznowić".

3. **Brakuje wewnętrznych cooperative checkpoints w backend loop**  
   Nie ma jeszcze gwarantowanego pollingu inboxu co step albo co 10-20 ms wall-clock.

4. **Actor ownership nie jest jeszcze pełny**  
   `interactive_runtime_host.rs` istnieje, ale runtime lifecycle nadal jest częściowo spleciony z orchestration flow.

5. **API nadal jest zbyt monolityczne i zbyt pasywne**  
   `crates/fullmag-api/src/main.rs` łączy routing, state, mutation logic, preview logic i broadcast.

### 2.3 Główna przyczyna problemu

Architektura jest dziś "interactive na checkpointach callbacka", a nie "interactive przez runtime z własną pętlą sterowania".

To jest różnica fundamentalna.

---

## 3. Zasady projektowe bez kompromisów

### 3.1 Zasady obowiązkowe

1. **Backend state jest jedynym źródłem prawdy**
2. **Każda komenda ma total order i jawny ack**
3. **Runtime ma jednego właściciela**
4. **Display nie może być produktem ubocznym kolejnego solver step**
5. **Pause/resume muszą być stanami runtime, nie side-effectem `Stop`**
6. **UI nie może zgadywać semantyki na podstawie heurystyk**
7. **Stare file-backed preview paths muszą zniknąć po migracji**
8. **Energie są P0 i muszą mieć ten sam kontrakt co pola**

### 3.1.1 Konsekwencja dla energii

`E_ex`, `E_demag`, `E_total` i inne `GlobalScalar` nie są dodatkiem do viewportu.

Są first-class display selection i mają spełniać te same reguły co `m`, `H_demag`, `H_ex`, `H_eff`:

- ten sam `SetDisplaySelection`,
- ten sam `CommandAck`,
- ten sam canonical display publish przez `display_revision`,
- ten sam ownership przez runtime,
- brak fallbacków z `scalar_rows`,
- brak osobnego toru semantycznego w UI lub API.

### 3.2 Zasady wdrożeniowe

1. Najpierw semantyka i ownership, potem optymalizacja.
2. Najpierw FDM CPU + CUDA, potem FEM CPU + GPU, ale model musi być wspólny.
3. Każda faza ma mierzalne kryteria sukcesu.
4. Każdy etap musi zostawić system w stanie produkcyjnie spójnym.
5. Żadnych nowych obejść "na chwilę", które podważają model końcowy.

---

## 4. Docelowa architektura

```text
Browser
  |
  | REST + WS
  v
fullmag-api
  - command ingest
  - session state store
  - event fanout
  - ack / error / status surfaces
  |
  | sequenced control + runtime events
  v
fullmag-cli
  - SessionOrchestrator
  - InteractiveRuntimeSupervisor
  - RuntimeActor
  - artifact/session lifecycle
  |
  v
fullmag-runner
  - InteractiveRuntime
  - InteractiveBackend
  - backend-specific checkpoint hooks
  - display snapshot engine
```

### 4.1 Własność

- **API**: control-plane i broadcast layer
- **CLI**: supervisor sesji i właściciel runtime actor
- **Runner**: semantyka runtime, backend checkpoints, snapshotting, pause/resume

### 4.2 Model sterowania

Jeden uporządkowany strumień:

- `ExecuteRun`
- `ExecuteRelax`
- `Pause`
- `Resume`
- `Break`
- `Close`
- `SetDisplaySelection`

Każda komenda ma:

- `seq`
- `session_id`
- `issued_at`
- `ack_state`
- `completion_state`

### 4.3 Model runtime state

Jawne stany:

- `materializing`
- `awaiting_command`
- `running`
- `paused`
- `breaking`
- `closing`
- `failed`

Niedopuszczalne jest ukrywanie `paused` jako "segment został anulowany, a host udaje pause".

### 4.4 Integracja z hybrydą `amumax + COMSOL`

Ten plan musi zostać dowieziony tak, aby mógł zostać bezpośrednio podpięty pod docelową aplikację:

- live workspace pod `/`,
- in-memory `LocalLiveAppState`,
- bootstrap + WebSocket jako primary live path,
- runtime console mapowany do `LiveCommand`,
- session-local `script_builder`,
- `UI -> canonical Python rewrite`.

To oznacza, że runtime protocol projektowany w tym planie nie może być zależny od:

- file-backed session polling,
- legacy `/runs/:id` assumptions,
- preview cache jako canonical truth,
- jednorazowej materializacji bez dalszej ciągłości runtime.

---

## 5. Zakres zmian w kodzie

### 5.1 Runner

Pliki istniejące:

- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/interactive_runtime.rs`
- `crates/fullmag-runner/src/interactive/`
- `crates/fullmag-runner/src/cpu_reference.rs`
- `crates/fullmag-runner/src/native_fdm.rs`
- `crates/fullmag-runner/src/fem_reference.rs`
- `crates/fullmag-runner/src/native_fem.rs`

Nowe docelowe moduły:

```text
crates/fullmag-runner/src/interactive/
├── mod.rs
├── commands.rs
├── runtime.rs
├── actor_protocol.rs
├── state.rs
├── display.rs
├── events.rs
├── checkpoints.rs
├── pause.rs
└── cache.rs
```

### 5.2 CLI

Pliki istniejące:

- `crates/fullmag-cli/src/orchestrator.rs`
- `crates/fullmag-cli/src/interactive_runtime_host.rs`
- `crates/fullmag-cli/src/live_workspace.rs`
- `crates/fullmag-cli/src/control_room.rs`
- `crates/fullmag-cli/src/types.rs`

Nowe docelowe moduły:

```text
crates/fullmag-cli/src/
├── interactive_runtime_host.rs      -> tylko host bootstrap i public facade
├── runtime_actor.rs                 -> dedykowana pętla ownership
├── runtime_supervisor.rs            -> restart/rebuild/session semantics
├── command_bridge.rs                -> consume/publish ack/completion
└── session_state_bridge.rs          -> publish public state do API
```

### 5.3 API

`crates/fullmag-api/src/main.rs` musi zostać rozbite.

Docelowo:

```text
crates/fullmag-api/src/
├── main.rs
├── state.rs
├── dto.rs
├── commands.rs
├── display.rs
├── broadcast.rs
├── session.rs
└── handlers/
    ├── commands.rs
    ├── display.rs
    ├── session.rs
    └── websocket.rs
```

### 5.4 Frontend

Pliki krytyczne:

- `apps/web/components/runs/control-room/ControlRoomContext.tsx`
- `apps/web/lib/useSessionStream.ts`
- `apps/web/components/runs/control-room/ViewportPanels.tsx`

Frontend ma przejść z modelu "best effort preview state" na model:

- `selected_display`
- `display_ack`
- `display_payload`
- `runtime_status`
- `command_status`

---

## 6. Fazy realizacji

## Faza 0: Freeze semantyki i instrumentacja

**Cel**: skończyć zgadywanie i ustawić twarde metryki.

### Działania

1. Wprowadzić dokumentowany runtime state machine.
2. Dodać metryki:
   - `command_ack_latency_ms`
   - `display_fresh_latency_ms`
   - `energy_display_fresh_latency_ms`
   - `pause_ack_latency_ms`
   - `pause_effective_latency_ms`
   - `resume_latency_ms`
3. Dodać trace points:
   - command enqueued
   - command consumed by CLI
   - command applied by runtime
   - display snapshot started
   - display snapshot published
4. Dodać jawne pole `runtime_status` do live public state.

### Pliki

- `crates/fullmag-runner/src/types.rs`
- `crates/fullmag-cli/src/types.rs`
- `crates/fullmag-api/src/main.rs`
- `apps/web/lib/useSessionStream.ts`

### Exit criteria

- potrafimy zmierzyć obecne lagi dla `selection`, `pause`, `resume`, `refresh`.
- każdy interactive command ma `seq`, `ack`, `completed`, `failed`.

---

## Faza 1: Formalny protokół komend i eventów

**Cel**: zbudować kontrakt, którego później nie trzeba będzie obchodzić.

### Działania

1. Zdefiniować wspólny `LiveControlCommand`.
2. Zdefiniować `RuntimeEventEnvelope`:
   - `CommandAck`
   - `CommandRejected`
   - `CommandCompleted`
   - `RuntimeStatusChanged`
   - `StepDelta`
3. Rozdzielić:
   - ack przy przyjęciu,
   - completion po faktycznym wykonaniu,
   - fresh display publish po snapshot.
4. Usunąć semantyczny rozjazd między "preview change" i "solver command".
5. Wymusić wspólny kontrakt dla:
   - `VectorField`,
   - `SpatialScalar`,
   - `GlobalScalar`.

### Pliki

- `crates/fullmag-runner/src/interactive/commands.rs`
- `crates/fullmag-runner/src/interactive/events.rs`
- `crates/fullmag-cli/src/types.rs`
- `crates/fullmag-api/src/dto.rs`

### Exit criteria

- UI nie czyta już "czy coś się może wydarzyło"; dostaje jawny ack/completion/event type.
- API nie przechowuje preview config jako osobnej pół-pasywnej ścieżki.

---

## Faza 2: Actorizacja ownership po stronie CLI

**Cel**: runtime ma jednego właściciela i jeden serial execution lane.

### Działania

1. Wydzielić `RuntimeActor` z `interactive_runtime_host.rs`.
2. Wydzielić `RuntimeSupervisor` z `orchestrator.rs`.
3. Orchestrator przestaje bezpośrednio zarządzać detalami runtime control.
4. Actor:
   - konsumuje komendy,
   - trzyma `InteractiveRuntime`,
   - publikuje eventy,
   - wykonuje checkpoint-aware transitions.
5. Supervisor:
   - tworzy runtime,
   - decyduje o rebuild,
   - pilnuje lifecycle sesji i segmentów,
   - integruje artifacts.

### Pliki

- `crates/fullmag-cli/src/interactive_runtime_host.rs`
- `crates/fullmag-cli/src/orchestrator.rs`
- nowe:
  - `crates/fullmag-cli/src/runtime_actor.rs`
  - `crates/fullmag-cli/src/runtime_supervisor.rs`
  - `crates/fullmag-cli/src/command_bridge.rs`

### Exit criteria

- `interactive_runtime_host.rs` nie zawiera już logiki "pause == StepAction::Stop".
- runtime actor może pozostać żywy przez wiele segmentów bez splątania z `run_script_mode()`.

---

## Faza 3: Prawdziwe cooperative checkpoints w runnerze

**Cel**: usunąć step-gating jako źródło laga.

### Działania

1. Wprowadzić backend-neutral interface:
   - `poll_runtime_control()`
   - `checkpoint_if_due()`
   - `snapshot_display_if_requested()`
2. Zmienić pętle wykonawcze tak, by nie wykonywały jednego "dużego, nieprzerywalnego kroku" bez pollingu.
3. Ustalić regułę:
   - checkpoint co step,
   - lub jeśli pojedynczy step jest długi: dodatkowy wall-clock checkpoint nie rzadziej niż 10-20 ms.
4. Rozdzielić:
   - solver micro-step,
   - public step publication,
   - display snapshot publication.
5. Wprowadzić `RuntimeControlOutcome`:
   - `continue`
   - `pause_requested`
   - `break_requested`
   - `display_updated`
   - `close_requested`
6. Zapewnić, że `GlobalScalar` selection podczas `running` przechodzi przez ten sam checkpoint path co pola przestrzenne.

### Pliki

- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/interactive_runtime.rs`
- `crates/fullmag-runner/src/cpu_reference.rs`
- `crates/fullmag-runner/src/native_fdm.rs`
- `crates/fullmag-runner/src/fem_reference.rs`
- `crates/fullmag-runner/src/native_fem.rs`
- nowe:
  - `crates/fullmag-runner/src/interactive/checkpoints.rs`
  - `crates/fullmag-runner/src/interactive/pause.rs`

### No-compromise rules

1. Żaden backend interactive nie może być "responsive" tylko przed/po `backend.step(...)`.
2. Jeśli backend nie umie checkpointować dostatecznie często, musi być jawnie oznaczony jako niespełniający SLA.
3. Brak zgody na "to działa szybko dla małego `dt`".

### Exit criteria

- `SetDisplaySelection` podczas `running` nie czeka na koniec segmentu.
- display sync podczas `running` działa przez `display_revision`, bez legacy preview commandów.
- `E_ex <-> E_demag <-> E_total` podczas `running` nie czeka na koniec segmentu.
- `pause` daje runtime state `paused`, a nie `awaiting_command` po cancelu segmentu.

---

## Faza 4: Prawdziwe `pause`, `break`, `resume`

**Cel**: komendy wykonawcze mają prawdziwą semantykę runtime.

### Działania

1. Wprowadzić `paused` jako first-class state.
2. Zdefiniować semantykę:
   - `pause`: zatrzymaj integrację, zachowaj runtime state, nie kończ segmentu jako cancel,
   - `resume`: wznowienie z tego samego backend state,
   - `break`: zakończ bieżący segment i przejdź do `awaiting_command`,
   - `stop`: anuluj segment,
   - `close`: zamknij runtime i sesję.
3. Artifact pipeline:
   - `pause` nie tworzy fałszywego "completed segment",
   - `break` kończy segment jawnie jako przerwany,
   - `resume` kontynuuje istniejący runtime lineage.
4. Dodać publiczny status i UI semantics.

### Pliki

- `crates/fullmag-runner/src/types.rs`
- `crates/fullmag-cli/src/live_workspace.rs`
- `crates/fullmag-cli/src/orchestrator.rs`
- `crates/fullmag-api/src/session.rs`
- `apps/web/components/runs/control-room/ControlRoomContext.tsx`

### Exit criteria

- `pause` i `resume` nie używają już `StepAction::Stop`.
- UI potrafi odróżnić `paused`, `awaiting_command`, `running`, `breaking`.

---

## Faza 5: Runtime-owned display engine

**Cel**: display selection ma być usługą runtime, nie skutkiem ubocznym solver callbacka.

### Działania

1. Wprowadzić `DisplaySelection` i `DisplayPayload` jako kanoniczny model.
2. Runtime ma umieć snapshotować:
   - `VectorField`
   - `SpatialScalar`
   - `GlobalScalar`
3. Snapshot display musi być jawnie wywoływany przez canonical display sync:
   - `SetDisplaySelection`
   - `display_revision` -> internal `display_sync`
4. Dodać runtime-local cache:
   - key: `(state_revision, display_selection_without_revision)`
   - invalidacja przy zmianie `state_revision`
5. Usunąć zależność od "następny step wyśle właściwe preview".
6. Traktować `GlobalScalar` jako P0:
   - nie jako telemetry side-channel,
   - nie jako fallback z ostatniego `scalar_row`,
   - nie jako osobny widget poza command/display contract.

### Pliki

- `crates/fullmag-runner/src/interactive/display.rs`
- `crates/fullmag-runner/src/interactive/cache.rs`
- `crates/fullmag-runner/src/preview.rs`
- `crates/fullmag-cli/src/runtime_actor.rs`

### Exit criteria

- `m <-> H_demag <-> H_ex <-> H_eff` działa w `awaiting_command` i `running` przez ten sam kontrakt.
- energie są first-class display, a nie fallbackiem z `scalar_rows`.
- `E_ex <-> E_demag <-> E_total` mają ten sam `ack -> snapshot -> display_updated` flow co pola 3D.

---

## Faza 6: Refaktoryzacja API pod command/display runtime

**Cel**: API przestaje być monolitem i przestaje utrzymywać pół-pasywne preview semantics.

### Działania

1. Rozbić `crates/fullmag-api/src/main.rs`.
2. Oddzielić:
   - command ingest,
   - session state store,
   - display state store,
   - broadcast layer,
   - websocket handlers.
3. Preview endpoints mapować semantycznie do control commands.
4. Dodać jawne surfaces:
   - `POST /control/command`
   - `GET /control/wait`
   - `POST /display/refresh`
   - `GET /session/state`
5. Broadcastować typed envelopes zamiast mieszać pełny snapshot i pół-lokalne preview eventy bez kontraktu.

### Exit criteria

- `fullmag-api/src/main.rs` nie jest już monolitem.
- API nie przechowuje osobnego "preview config truth" obok runtime command truth.

---

## Faza 7: Frontend parity i usunięcie hacków

**Cel**: frontend przestaje maskować brakujące semantyki backendu.

### Działania

1. Rozbić `ControlRoomContext.tsx` na:
   - session state
   - commands
   - display
   - stream transport
2. Zastąpić lokalne heurystyki:
   - local fallback do `m`,
   - local scalar fallback,
   - inferred preview freshness
3. UI ma reagować na:
   - `CommandAck`
   - zmianę `display_revision` / display resource
   - `RuntimeStatusChanged`
   - `CommandCompleted`
4. Dodać jawne stany przycisków:
   - `run`
   - `pause`
   - `resume`
   - `break`
   - `close`

### Exit criteria

- UI nie ukrywa już problemów backendu heurystyką.
- selection displayed == selection acknowledged == display payload.

---

## Faza 8: Wycięcie długu przejściowego

**Cel**: usunąć ścieżki, które podtrzymują dawny model.

### Usuwamy

- `interactive_preview_cache.json` jako primary path,
- API-side preview reconstruction fallback,
- stare preview wait/poll semantics,
- `pause -> Stop`,
- backend-specific obejścia w UI,
- wszystko, co utrzymuje dwa różne modele prawdy.

### Exit criteria

- system ma jeden model runtime interaction.
- reconnect path nie zależy od starego file cache jako canonical source.

---

## Faza 9: Walidacja, benchmarki, rollout

**Cel**: udowodnić parity, a nie tylko ją deklarować.

### Test matrix

1. FDM CPU
2. FDM CUDA
3. FEM CPU
4. FEM GPU

### Scenariusze

1. `awaiting_command`: `m -> H_demag -> H_ex -> H_eff`
2. `running`: zmiana selection podczas aktywnego segmentu
3. `running`: `refresh`
4. `running`: `pause`
5. `paused`: `resume`
6. `running`: `break`
7. `awaiting_command`: energie globalne
8. reconnect po zmianach display

### SLA produktu

- `running`: command ack p95 <= 50 ms
- `running`: świeży display po selection p95 <= 100 ms
- `running`: świeży `GlobalScalar` po selection p95 <= 50 ms
- `pause`: ack p95 <= 50 ms
- `pause`: effective stop p95 <= 100 ms lub <= 1 checkpoint interval
- `awaiting_command`: quantity switch p95 <= 50 ms
- `awaiting_command`: global scalar switch p95 <= 16 ms

### Exit criteria

- testy automatyczne przechodzą,
- benchmarki potwierdzają SLA,
- ręczny smoke test potwierdza brak czekania "na koniec solver step".

---

## 7. Ryzyka i mitygacje

| Ryzyko | Skutek | Mitygacja |
|--------|--------|-----------|
| Rozgrzebanie wszystkiego naraz | chaos architektoniczny | twarda kolejność faz 0-9 i definicja done |
| Backend GPU będzie trudny do checkpointowania | niestabilne pause/display refresh | actor model, serial ownership, jawne checkpoint contracts |
| API i UI utrzymają stare heurystyki | semantyczny dualizm | faza 7 dopiero po fazach 1-6, ale obowiązkowo przed zakończeniem |
| "Tymczasowe" obejścia zostaną na stałe | utrwalenie długu | faza 8 jako obowiązkowa, nie opcjonalna |
| Różne backends będą miały różne semantyki | nierówny UX | wspólny runtime contract i test matrix cross-backend |

---

## 8. Kolejność krytyczna

```text
Faza 0 -> Faza 1 -> Faza 2 -> Faza 3 -> Faza 4 -> Faza 5 -> Faza 6 -> Faza 7 -> Faza 8 -> Faza 9
```

### Rzeczy, których nie wolno odwrócić

1. Nie wolno robić frontend parity przed runner semantics.
2. Nie wolno usuwać starego cache przed runtime-owned display.
3. Nie wolno deklarować parity przed prawdziwym `pause/resume` i mid-run display refresh.

---

## 9. Definition of Done

Plan jest zrealizowany dopiero wtedy, gdy wszystkie poniższe warunki są prawdziwe:

- [ ] `running` display selection nie czeka na koniec długiego solver step
- [ ] `pause` nie jest implementowane przez `StepAction::Stop`
- [ ] `resume` wznawia ten sam runtime state
- [ ] display i command semantics mają jeden wspólny protokół
- [ ] energie mają ten sam protokół i ten sam SLA co pozostałe display selection
- [ ] API jest rozbite modułowo i nie utrzymuje starego dualizmu preview/config
- [ ] frontend nie ma heurystyk maskujących backend lag
- [ ] stare file-backed preview paths zostały zdegradowane do fallbacku albo usunięte
- [ ] SLA responsywności są zmierzone i spełnione
- [ ] parity z amumax można pokazać na żywym scenariuszu, a nie tylko zadeklarować w docs
- [ ] runtime contract działa wewnątrz docelowego live workspace, a nie tylko w legacy session path
- [ ] plan jest zintegrowany z live app spine i `script_builder`, zgodnie z architekturą jednej aplikacji

---

## 10. Rekomendacja wykonawcza

To zadanie jest trudne, ale nie jest niejasne.

Najbardziej kosztowny technicznie element nie leży w UI ani w API. Leży w tym, że trzeba przestać traktować interactive mode jako batch runner z callbackami i zacząć traktować go jako **runtime z własnym stanem, własnym ownershipem i własnymi checkpointami sterowania**.

Dopiero po wykonaniu tego ruchu reszta systemu upraszcza się naturalnie:

- API staje się czystszym control-plane,
- frontend przestaje zgadywać,
- pause/resume przestają być hackiem,
- quantity switching staje się realnie natychmiastowe.

To jest właściwa droga do pełnej parity z `amumax`.
