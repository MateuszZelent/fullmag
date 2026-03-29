# Design: Persistent InteractiveRuntime dla live backend sessions

**Data**: 2026-03-29  
**Status**: AKTYWNY  
**Powiązane dokumenty**:
- `docs/reports/fullmag_mumax_like_preview_plan.md`
- `docs/plans/active/interactive-session-mode-plan-2026-03-25.md`
- `docs/plans/active/MASTERPLAN-refactoring-2026-03-29.md`

---

## TL;DR

Żeby Fullmag zachowywał się jak `mumax` / `amumax` podczas przełączania `m`, `H_demag`, `H_ex`, `H_eff` i energii w interactive mode, nie wystarczy dalsze przyspieszanie cache preview.

Potrzebujemy jednego ruchu architektonicznego:

- sesja interactive musi trzymać **żywy backend** po zakończeniu komendy,
- preview i focused scalar muszą być liczone **na żądanie z aktualnego stanu backendu**,
- UI/API nie mogą już polegać na tym, że "kolejny step solvera kiedyś dostarczy właściwe preview".

Decyzja projektowa z tego dokumentu:

- **właścicielem `InteractiveRuntime` jest CLI**, bo to CLI materializuje problem, uruchamia runner i jest naturalnym hostem sesji,
- **API pozostaje control-plane i broadcast layer**, ale przechodzi z luźnych osobnych kanałów na **jeden uporządkowany strumień sterowania**,
- **runner dostaje trwały `InteractiveRuntime`** zbudowany na `SimulationBackend`, a nie tylko funkcje one-shot `run_problem(...)`.

To daje parity z `amumax` na poziomie zachowania produktu bez natychmiastowego przepisywania całej architektury na in-process host.

---

## 1. Problem do rozwiązania

Obecny interactive mode działa już dużo lepiej niż wcześniej, ale nadal ma fundamentalne ograniczenie:

- po zakończeniu `run` / `relax` nie istnieje żywy backend, tylko wynik i cache,
- preview pól `H_*` jest nadal pochodną step callbacka albo snapshot cache,
- przełączanie quantity po `awaiting_command` nie jest równorzędne z `mumax` / `amumax`,
- global scalar energies nie są first-class interactive selection,
- API nadal częściowo rekonstruuje preview z pośrednich danych zamiast dostać je od runtime jako gotowy wynik.

To prowadzi do trzech klas problemów:

1. **Responsywność**
   `m -> H_demag` bywa szybkie, ale nadal zależy od obejść i cache.

2. **Poprawność UX**
   selection i faktycznie pokazywany preview mogą się rozjechać.

3. **Architektura**
   preview jest skutkiem ubocznym solver loop, a nie pełnoprawną usługą runtime.

---

## 2. Cele

### Cele produktu

1. Zmiana wyświetlanej wielkości w interactive mode ma być odczuwalnie natychmiastowa.
2. Ma działać zarówno podczas `running`, jak i w `awaiting_command`.
3. Po zakończeniu symulacji użytkownik nadal może przełączać:
   - `m`
   - `H_ex`
   - `H_demag`
   - `H_ext`
   - `H_eff`
   - energie globalne: `E_ex`, `E_demag`, `E_ext`, `E_total`
4. Musi istnieć jawne `refresh`, tak jak w `amumax`.

### Cele architektury

1. Backend żyje dłużej niż pojedyncza komenda.
2. Preview jest liczone z backend state na żądanie.
3. Command ordering jest jednoznaczny i totalnie uporządkowany.
4. API nie rekonstruuje fizycznych pól z artefaktów, jeśli ma aktywny live runtime.
5. Rozwiązanie ma dać się wdrożyć etapami, FDM/CUDA first.

---

## 3. Non-goals dla pierwszej iteracji

Na start nie robimy jeszcze wszystkiego:

1. Nie przenosimy API in-process do CLI.
2. Nie budujemy osobnego daemon/service managera.
3. Nie rozwiązujemy od razu pełnej edycji wszystkich parametrów materiałowych w locie.
4. Nie wprowadzamy od razu binarnego transportu WS.
5. ~~Nie wymagamy pełnej parity dla FEM w pierwszym vertical slice.~~ **UPDATED**: FEM jest już zaimplementowane na równi z FDM — `InteractiveFemPreviewRuntime` obsługuje CPU reference i native GPU. Pierwszy vertical slice obejmuje FEM.

Pierwszy production-grade slice ma objąć:

- FDM CPU,
- FDM CUDA,
- **FEM CPU reference + FEM native GPU**,
- interactive preview i focused scalar,
- `run`, `relax`, `pause`, `break`, `resume`, `close`,
- `awaiting_command` z żywym backendem.

---

## 4. Decyzja architektoniczna

### 4.1 Właściciel runtime: CLI

`InteractiveRuntime` powinien żyć w procesie CLI, a nie w API.

Powody:

1. CLI już dziś:
   - materializuje skrypt,
   - planuje problem,
   - wybiera backend,
   - uruchamia runner,
   - zarządza lifecycle sesji.

2. API jest dziś lokalnym control-plane dla UI, ale nie jest naturalnym miejscem na:
   - materializację Pythona,
   - ownership GPU handle,
   - ownership artifact pipeline,
   - ownership continuation/runtime state.

3. Ta decyzja jest zgodna z istniejącym kierunkiem:
   - interactive session jako hostowana sesja CLI,
   - control room jako klient tej sesji.

### 4.2 Rola API

API zostaje, ale zmienia odpowiedzialność:

- przyjmuje komendy z UI,
- zapisuje je do jednego uporządkowanego strumienia control messages,
- broadcastuje publiczny snapshot i incremental preview updates,
- nie jest już głównym miejscem budowania `H_demag/H_ex/H_eff` dla live runtime.

### 4.3 Zasada główna

**Backend state jest źródłem prawdy.**  
Cache preview jest tylko optymalizacją pochodną.

---

## 5. Docelowy model komponentów

```text
Browser UI
   |
   | REST / WS
   v
fullmag-api
   - control queue
   - public session snapshot
   - WS/SSE broadcast
   |
   | long-poll wait / push-ack
   v
fullmag-cli
   - Orchestrator
   - InteractiveRuntimeHost (actor)
   - session artifacts
   |
   v
fullmag-runner
   - InteractiveRuntime
   - SimulationBackend
   - preview/scalar snapshots from live backend
```

### Kluczowa zmiana względem stanu obecnego

Zamiast:

- UI ustawia preview config,
- CLI czeka na config change,
- runner przy kolejnym solver stepie może wygenerować preview,
- API rekonstruuje co się da,

ma być:

- UI wysyła `SetDisplaySelection`,
- API enqueueuje command z numerem sekwencyjnym,
- CLI runtime konsumuje go natychmiast,
- runtime liczy preview lub focused scalar z aktualnego backend state,
- CLI publikuje gotowy wynik do API,
- API tylko broadcastuje.

---

## 6. Jeden uporządkowany strumień sterowania

To jest najważniejsza zmiana control-plane.

Dziś mamy osobno:

- command queue,
- preview config state,
- preview config wait,
- lokalne obejścia w frontendzie.

Docelowo ma być jeden strumień:

```rust
enum LiveControlCommand {
    ExecuteRun { until_seconds: f64 },
    ExecuteRelax,
    Pause,
    Resume,
    Break,
    Close,

    SetDisplaySelection(DisplaySelection),
    RefreshDisplay,

    SetExternalField { /* etap 2+ */ },
    SetCurrent { /* etap 2+ */ },
    RebuildRuntime { /* etap 3+ */ },
}

struct SequencedControlCommand {
    seq: u64,
    session_id: String,
    issued_at_unix_ms: u64,
    command: LiveControlCommand,
}
```

### Dlaczego to jest potrzebne

Bez jednego numerowanego strumienia kolejność bywa niejawna.

Przykład:

1. user klika `H_demag`,
2. user od razu klika `Run`,
3. user po chwili klika `H_ex`.

Bez total order łatwo zgubić poprawną semantykę.  
Z `seq` runtime widzi dokładnie:

1. `SetDisplaySelection(H_demag)`
2. `ExecuteRun(...)`
3. `SetDisplaySelection(H_ex)`

I może to zastosować w poprawnej kolejności.

### API contract

API powinno dostać nowy wait endpoint:

```text
GET /v1/live/current/control/wait?after_seq=123&timeout_ms=20000
```

Odpowiedź:

- `200` z następną komendą,
- `204` gdy timeout,
- `404` gdy brak aktywnej sesji,
- `409` gdy sesja zmieniła się lub seq jest spoza zakresu.

Obecne osobne preview wait/poll endpointy powinny zostać oznaczone jako transitional i docelowo zniknąć.

---

## 7. Model runtime po stronie runnera

### 7.1 Nowa warstwa

W `fullmag-runner` trzeba dodać nową warstwę obok batch execution:

```text
crates/fullmag-runner/src/
├── interactive/
│   ├── mod.rs
│   ├── commands.rs
│   ├── runtime.rs
│   ├── state.rs
│   ├── events.rs
│   └── cache.rs
```

### 7.2 Podstawowe abstrakcje

```rust
pub struct InteractiveRuntime {
    backend: Box<dyn InteractiveBackend>,
    state_revision: u64,
    display_revision: u64,
    last_step_stats: Option<StepStats>,
    selected_display: DisplaySelection,
    preview_cache: RuntimePreviewCache,
    supported_quantities: QuantityRegistry,
}

pub trait InteractiveBackend: Send {
    fn run_until(
        &mut self,
        target: RuntimeTarget,
        hooks: &mut dyn InteractiveHooks,
    ) -> Result<InteractiveSegmentResult, RunError>;

    fn snapshot_display(
        &mut self,
        selection: &DisplaySelection,
    ) -> Result<DisplayPayload, RunError>;

    fn snapshot_scalars(
        &mut self,
        ids: &[String],
    ) -> Result<Vec<ScalarMetric>, RunError>;

    fn export_continuation(&mut self) -> Result<Vec<[f64; 3]>, RunError>;

    fn shutdown(&mut self) -> Result<(), RunError>;
}
```

### 7.3 Dlaczego metody query mają brać `&mut self`

To jest ważny detal produkcyjny.

Dla backendów GPU snapshot preview często wymaga:

- synchronizacji device,
- użycia scratch bufferów,
- tymczasowego przeliczenia pochodnych pól,
- reuse wewnętrznych buforów.

Dlatego query APIs powinny brać `&mut self`, a nie `&self`.  
To dobrze współgra z architekturą actor/serial executor i eliminuje pokusę współbieżnego dotykania backendu z kilku wątków.

### 7.4 `DisplaySelection` i `DisplayPayload`

Dzisiejszy model vector-only nie wystarczy.

```rust
enum DisplayKind {
    VectorField,
    SpatialScalar,
    GlobalScalar,
}

struct DisplaySelection {
    revision: u64,
    quantity: String,
    kind: DisplayKind,
    component: String,
    layer: usize,
    all_layers: bool,
    x_chosen_size: usize,
    y_chosen_size: usize,
    every_n: usize,
    max_points: usize,
    auto_scale_enabled: bool,
}

enum DisplayPayload {
    VectorField(LivePreviewField),
    SpatialScalar(LiveSpatialScalarField),
    GlobalScalar(FocusedScalarValue),
}
```

To daje jeden wspólny model dla:

- `m`, `H_demag`, `H_ex`, `H_eff`,
- future energy density maps,
- `E_total` i innych scalar metrics.

### 7.5 Revision model

W runtime rozdzielamy dwa liczniki:

1. `state_revision`
   rośnie, gdy zmienia się stan backendu:
   - step solvera,
   - relax,
   - mutacja pola,
   - wznowienie po pause,
   - rebuild runtime.

2. `display_revision`
   rośnie, gdy zmienia się wybór albo wynik display snapshot.

To pozwala odróżnić:

- "ten sam stan fizyczny, inny widok",
- od "nowy stan fizyczny, trzeba unieważnić cache".

---

## 8. `InteractiveRuntimeHost` po stronie CLI

### 8.1 Model aktora

CLI nie powinno dotykać backendu bezpośrednio z kilku miejsc.  
Powinno istnieć jedno miejsce ownership:

```rust
struct InteractiveRuntimeHost {
    command_tx: std::sync::mpsc::Sender<RuntimeHostCommand>,
    event_rx: std::sync::mpsc::Receiver<RuntimeHostEvent>,
}
```

Dedykowany wątek hosta:

- posiada `InteractiveRuntime`,
- serialnie wykonuje wszystkie komendy,
- emituje step updates, preview updates, scalar updates, logs i completion events,
- publikuje public state do API.

### 8.2 Dlaczego actor zamiast wspólnego `Mutex<InteractiveRuntime>`

1. Czytelniejszy ownership.
2. Bezpieczniejsze dla GPU handles.
3. Łatwiejsze cancellation i pause/break.
4. Lepsze miejsce na kolejkę i checkpointy sterowania podczas aktywnego `run`.

### 8.3 Integracja z Orchestrator

`Orchestrator` przestaje traktować interactive mode jako serię one-shot runów z `continuation_magnetization`.

Zamiast tego:

1. materializuje problem,
2. buduje `InteractiveRuntimeHost`,
3. seeduje scripted stages jako komendy do runtime,
4. po scripted stages zostawia runtime żywy w `awaiting_command`,
5. po `close` zamyka runtime i dopiero wtedy kończy sesję.

`continuation_magnetization` może zostać jako mechanizm awaryjny lub eksportowy, ale nie powinien być już głównym spine interactive mode.

---

## 9. Cooperative control podczas `running`

To jest drugi krytyczny element po samym lifetime backendu.

Jeśli użytkownik podczas `running` kliknie `H_demag`, to runtime nie może czekać do końca segmentu.

### Docelowe zachowanie

Pętla integracji ma regularnie sprawdzać control inbox:

- co step,
- albo co najwyżej co `10-20 ms` wall clock,
- zależnie od tego, co nastąpi wcześniej.

W tych checkpointach runtime może:

- przyjąć `SetDisplaySelection`,
- przyjąć `RefreshDisplay`,
- zaznaczyć `Pause`,
- zaznaczyć `Break`,
- odrzucić komendy niedozwolone w biegu, jeśli nie są jeszcze wspierane.

### Semantyka

`SetDisplaySelection` podczas `running`:

1. aktualizuje selection,
2. jeśli backend jest w bezpiecznym checkpointcie, wykonuje `snapshot_display(...)`,
3. publikuje nowy preview/focused scalar bez czekania na koniec komendy.

To daje zachowanie zbliżone do `amumax`: selection sama może wymusić odświeżenie display.

---

## 10. API i public state

### 10.1 Co API ma przechowywać

API powinno przechowywać:

- ostatni publiczny snapshot sesji,
- ostatni display payload,
- ostatni potwierdzony `display_selection`,
- `runtime_status` z polami:
  - `alive: bool`
  - `state_revision: u64`
  - `last_applied_control_seq: u64`
  - `backend_kind: String`
- control queue z `seq`,
- ewentualnie krótki bufor ostatnich eventów dla reconnect.

API nie powinno być głównym miejscem dla:

- syntezy `H_demag` z artefaktów,
- file-backed `interactive_preview_cache` jako ścieżki podstawowej,
- ręcznego składania live preview z niepełnych danych.

### 10.2 Publiczny model odpowiedzi

Obecne `snapshot` / `preview` eventy można zachować, ale ich źródło ma się zmienić:

- `snapshot` jest publikowany przez CLI po istotnej zmianie stanu sesji,
- `preview` lub szerzej `display` jest publikowany po `SetDisplaySelection` / `RefreshDisplay`,
- payload jest już gotowy z runtime.

Docelowo warto rozszerzyć envelope:

```rust
enum LiveEventEnvelope {
    Snapshot(SessionStateResponse),
    Display(DisplayState),
    CommandAck(CommandAck),
    CommandFinished(CommandFinished),
    RuntimeStatus(RuntimeStatus),
}
```

### 10.3 `refresh`

Musi powstać jawny endpoint:

```text
POST /v1/live/current/preview/refresh
```

ale semantycznie ma on enqueueować:

- `LiveControlCommand::RefreshDisplay`

a nie tylko przepisywać config w API.

---

## 11. Frontend: model jak w `amumax`

Frontend nie powinien mieć już specjalnych hacków:

- lokalny powrót do `m` tylko w `awaiting_command`,
- scalar fallback tylko jako side effect z `scalar_rows`,
- domyślne "vector-only interactive dropdown".

### Docelowy model UI

1. `selectedDisplay` jest first-class selection.
2. UI wysyła selection do API.
3. UI dostaje `CommandAck` i nowy `DisplayState`.
4. `DisplayState.kind` decyduje o rendererze:
   - `vector_field` -> 3D glyph/streamline view,
   - `spatial_scalar` -> heatmap / scalar slice,
   - `global_scalar` -> focused metric panel.

### Konsekwencje

- `E_total` i podobne energie można przełączać również po `awaiting_command`,
- nie trzeba udawać preview 3D dla wszystkiego,
- frontend staje się prostszy semantycznie.

---

## 12. Cache, ale we właściwym miejscu

Cache nadal jest potrzebny, ale już nie jako obejście architektury.

### Cache docelowy

Cache powinien żyć **wewnątrz runtime**:

- key: `(state_revision, display_selection_without_revision)`,
- value: `DisplayPayload`,
- invalidacja: przy każdej zmianie `state_revision`.

To daje:

- bardzo szybkie `m <-> H_demag <-> H_ex` na tym samym idle state,
- brak potrzeby zapisywania cache jako źródła prawdy do pliku,
- możliwość wykorzystania cache zarówno w `running`, jak i `awaiting_command`.

### Co z aktualnym file cache

`interactive_preview_cache.json` powinien zostać potraktowany jako **transitional fallback** i zostać usunięty po wdrożeniu live runtime dla FDM.

---

## 13. Artefakty i provenance

Persistent runtime nie może rozwalić spójności artefaktów.

### Wymóg

Każda komenda wykonawcza (`run`, `relax`) nadal musi tworzyć:

- segment summary,
- step telemetry,
- artifacts zgodne z dzisiejszym układem sesji,
- provenance o backendzie i parametrach wykonania.

### Decyzja

Artifact writing pozostaje segmentowe.

Runtime żyje przez całą sesję, ale:

- każdy segment wykonania ma osobny `segment_id`,
- kończy się własnym zapisem artifacts,
- preview refresh i scalar refresh nie są artefaktami wykonywalnymi, tylko eventami runtime.

To pozwala zachować reproducibility bez sztucznego zabijania backendu po każdej komendzie.

---

## 14. Proponowany rollout

### Etap 1: Unified control stream

**Cel**: zlikwidować rozdział "commands vs preview config".

Zakres:

- `LiveControlCommand` + `seq`,
- API `control/wait`,
- CLI consumer dla jednego strumienia,
- preview endpoints mapowane do control commands.

Bez tego dalsze etapy nadal będą miały ukryte race conditions.

### Etap 2: `InteractiveRuntime` w runnerze, FDM first

**Cel**: backend żywy po `awaiting_command`.

Zakres:

- `InteractiveBackend`,
- `InteractiveRuntime`,
- `InteractiveRuntimeHost`,
- scripted stages uruchamiane już przez runtime,
- `snapshot_display(...)` dla:
  - `m`,
  - `H_ex`,
  - `H_demag`,
  - `H_ext`,
  - `H_eff`,
  - global scalars.

Po tym etapie można wyłączyć podstawową zależność od file-backed preview cache.

### Etap 3: Cooperative checkpoints i `pause/break/resume`

**Cel**: responsiveness podczas aktywnego segmentu.

Zakres:

- inbox polling co step / co 10-20 ms,
- mid-run `SetDisplaySelection`,
- mid-run `RefreshDisplay`,
- `Pause`, `Break`, `Resume`.

### Etap 4: Frontend parity

**Cel**: domknąć UX jak w `amumax`.

Zakres:

- `selectedDisplay` zamiast vector-only preview selection,
- global scalar jako first-class interactive display,
- usunięcie hacków `awaiting_command` dla `m`,
- usunięcie zależności od scalar fallback jako efektu ubocznego.

### Etap 5: Sprzątanie długu przejściowego

Usuwamy:

- `interactive_preview_cache.json`,
- API-side rekonstrukcję `H_*` z fallbacków,
- stare preview wait/poll ścieżki,
- frontendowe local-only obejścia.

### Etap 6: FEM / advanced runtime mutations

Dopiero po stabilnym FDM:

- FEM runtime,
- dynamiczne mutacje pola/materiału,
- ewentualne `RebuildRuntime`,
- spatial scalar densities.

---

## 15. Status wdrożenia

Stan po ostatnim slice:

1. control-plane preview i solver commands są już spięte do jednego sekwencjonowanego strumienia `seq`,
2. CLI przestało mieć osobny preview-poller obok command-pollera,
3. dla FDM w stanie `awaiting_command` istnieje już pierwszy **persistent preview runtime**:
   - trzyma backend CPU/CUDA po stronie CLI,
   - pozwala wielokrotnie wywoływać `snapshot_preview()` bez rematerializacji problemu,
   - jest synchronizowany nową magnetyzacją po zakończonych interactive commands,
4. interactive `run` / `relax` dla single-layer FDM potrafią już wykonać się **na tym samym runtime** zamiast zawsze odpalać one-shot runner:
   - CLI przed wykonaniem komendy sprawdza zgodność `FdmPlanIR`,
   - przy mismatchu odbudowuje runtime z nowego `stage.ir` i ładuje `continuation_magnetization`,
   - po zgodności wykonuje komendę bez rematerializacji backendu i bez utraty idle-preview state,
5. runtime-backed execute path zachowuje już output scheduling dla scalar rows i field snapshots, więc interaktywne etapy nie produkują już „okrojonych” artefaktów względem one-shot runnera,
6. stary file-backed preview cache nadal istnieje jako fallback / reconnect path, ale nie jest już jedyną drogą dla idle preview.

To jest już pierwszy prawdziwy `InteractiveRuntime` z własnym execute path dla FDM, a nie tylko "persistent preview cache". Fullmag przeszedł z modelu "cache-based preview" do modelu "live backend owned by CLI" także dla interactive commands.

Największe brakujące elementy:

- brak jednej actorowej pętli ownership dla całego backend lifecycle,
- brak first-class runtime queries dla global scalar / energy display,
- runtime host nadal żyje jeszcze w dużym `fullmag-cli/src/main.rs`, a nie w wydzielonym actorze / module ownership.

---

## 16. Zależność od masterplanu refaktoryzacji

Ten design jest wykonalny już teraz jako kierunek architektoniczny, ale technicznie najczyściej wejdzie w życie w następującej kolejności:

1. **Faza 1 masterplanu**
   rozbicie `fullmag-cli` tak, żeby interactive/session/control-room logic nie żyły w jednym pliku.

2. **Faza 2 masterplanu**
   ujednolicenie runnera wokół `SimulationBackend`, co tworzy naturalny fundament pod `InteractiveBackend`.

3. **Następnie ten design**
   czyli unified control stream + `InteractiveRuntime` + actor host.

Możliwy jest też szybszy vertical slice FDM before full cleanup, ale wtedy trzeba zaakceptować większy dług przejściowy w `main.rs` i `fullmag-api/src/main.rs`.

---

## 17. Kryteria sukcesu

### Responsywność

Na referencyjnym przypadku FDM CUDA `200 x 200 x 1`:

- `awaiting_command`: `m <-> H_demag <-> H_ex <-> H_eff` p95 <= 50 ms,
- `running`: selection ack p95 <= 50 ms,
- `running`: świeży display po zmianie selection p95 <= 100 ms,
- `awaiting_command`: przełączanie `E_ex/E_demag/E_total` p95 <= 16 ms.

### Funkcjonalność

1. Nie trzeba czekać na kolejny solver step, żeby zobaczyć nową quantity.
2. `POST /preview/refresh` działa zarówno w `running`, jak i `awaiting_command`.
3. Po zakończeniu komendy backend nadal żyje.
4. API nie musi budować live `H_*` z cache plikowego, gdy runtime jest aktywny.

### Utrzymywalność

1. Preview config nie żyje w osobnym bocznym kanale.
2. Runtime ma jednoznaczny ownership.
3. `continuation_magnetization` nie jest już głównym mechanizmem interactive session.

---

## 18. Ryzyka i mitygacja

| Ryzyko | Skutek | Mitygacja |
|--------|--------|-----------|
| Zbyt duży scope naraz | rozgrzebana architektura | wdrażać FDM-first w etapach 1-4 |
| GPU backend nie lubi współbieżnych snapshotów | niestabilność / deadlock | actor model + `&mut self` query APIs |
| API/CLI rozjadą się w kolejności komend | błędny stan UI | jeden `seq`-ordered control stream |
| Preview i execute commands będą walczyć o backend | lagi / race conditions | serial executor + cooperative checkpoints |
| Zbyt wczesne usunięcie starego cache | regresja UX | trzymać fallback do końca etapu 4 |

---

## 19. Alternatywy rozważone

### A. Trzymać runtime w API

Plusy:

- krótsza ścieżka UI -> runtime,
- mniej relay logic w CLI.

Minusy:

- API musiałoby przejąć materializację, backend ownership i artifact lifecycle,
- większy blast radius,
- słabo zgodne z obecną architekturą hostowanej sesji.

Decyzja: **odrzucamy na teraz**.

### B. Zostać przy cache-based preview

Plusy:

- mały koszt wdrożenia,
- szybka poprawa UX.

Minusy:

- nigdy nie daje pełnej parity z `amumax`,
- nie rozwiązuje poprawnie idle switching,
- nadal nie daje first-class energies.

Decyzja: **za słabe jako stan docelowy**.

### C. Osobny runtime daemon

Plusy:

- architektonicznie czyste rozdzielenie.

Minusy:

- nowy proces, nowy lifecycle, nowe IPC,
- zbyt duży scope na ten etap.

Decyzja: **nie teraz**.

---

## 20. Rekomendacja wykonawcza

Najrozsądniejsza kolejność wdrożenia:

1. Uporządkować control-plane do jednego `seq`-ordered streamu.
2. Wprowadzić `InteractiveRuntime` w runnerze dla FDM.
3. Podłączyć CLI actor host i zostawić backend żywy w `awaiting_command`.
4. Oprzeć preview i global scalar selection na runtime queries.
5. Dopiero potem usuwać cache-based obejścia.

To jest najkrótsza droga do zachowania produktu "jak w `amumax`", ale bez niepotrzebnego przewracania całego stacku naraz.
