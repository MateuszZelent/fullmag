# MASTERPLAN: Refaktoryzacja fullmag

**Data**: 2026-03-29  
**Status**: AKTYWNY  
**Szacowany budżet pracy**: 12–15 dni roboczych  
**Cel**: Zmniejszenie długu technologicznego, poprawa utrzymywalności i czytelności kodu

---

## Podsumowanie stanu bieżącego

| Warstwa | LOC | Największy monolit | Problem |
|---------|-----|---------------------|---------|
| Rust (crates/) | 38k | cli/main.rs (4600) | God Object, 15+ odpowiedzialności |
| API (fullmag-api) | 2622 | main.rs | Pasywny relay, redundancja SSE+WS |
| Runner | 7400+ | dispatch.rs (1438), multilayer_cuda.rs (2549) | 16 ścieżek dispatch, duplikacja f32/f64 |
| Frontend (apps/web) | 15k | ControlRoomContext.tsx (1180) | Martwe zależności, monolityczny kontekst |
| Python (fullmag-py) | 4000 | world.py (400) | Podwójna walidacja, podwójne API |
| Native C/CUDA | 12.7k | — | Stabilny, nie wymaga zmian |

**Łącznie**: ~74k LOC w ~190 plikach

## Powiązany aktywny design

Równolegle do tego masterplanu powstał dedykowany projekt architektoniczny dla persistent interactive runtime:

- `docs/plans/active/interactive-runtime-design-2026-03-29.md`

Ten dokument nie zastępuje faz refaktoryzacji z tego masterplanu. Jest ich logicznym rozszerzeniem po stronie live session / control room i powinien być traktowany jako kierunek docelowy dla:

- trwałego backend lifetime w interactive mode,
- mumax-like preview refresh,
- interactive display selection dla pól i energii.

---

## Faza 0: Przygotowanie infrastruktury (1 dzień)

### 0.1 Snapshot testów regresyjnych

**Cel**: Przed jakąkolwiek zmianą upewnić się, że mamy bazę testową.

**Działania**:
1. Uruchomić pełen zestaw testów: `cargo test --workspace --exclude fullmag-fdm-sys --exclude fullmag-fdm-demag`
2. Uruchomić testy fizyczne: `cargo test -p fullmag-runner --test physics_validation`
3. Zapisać wyniki do pliku `docs/reports/test-baseline-pre-refactor.txt`
4. Uruchomić smoke test Pythona: `scripts/run_python_ir_smoke.py`
5. Sprawdzić kompilację z feature `cuda`: `cargo check -p fullmag-cli --features cuda`

### 0.2 Git branch strategy

**Działania**:
1. Utworzyć branch `refactor/masterplan` z aktualnego `main`
2. Każda faza = osobny PR z code review
3. Każdy PR musi przechodzić pełen CI (testy + `cargo check --workspace`)

---

## Faza 1: Rozbicie cli/main.rs — God Object (3–4 dni)

**Cel**: Rozbicie monolitycznego pliku 4600 LOC na 8 modułów o jasnych odpowiedzialnościach.

### Stan obecny

`crates/fullmag-cli/src/main.rs` zawiera:
- 25+ struktur, 4 enumy
- 50+ funkcji (w tym `run_script_mode()` — ~2500 LOC)
- 15 logicznych odpowiedzialności w jednym pliku
- 14× powtórzonych wywołań `build_session_manifest()` z 12 argumentami
- 20+ niemal identycznych closurów `live_workspace.update(|state| {...})`

### Docelowa struktura modułów

```
crates/fullmag-cli/src/
├── main.rs                  (~120 LOC)  — entry point + routing
├── args.rs                  (~100 LOC)  — Cli, ScriptCli, Command, BackendArg, ModeArg, PrecisionArg
├── types.rs                 (~250 LOC)  — wszystkie DTOs: manifests, live state, publishing payloads
├── control_room.rs          (~900 LOC)  — ControlRoomGuard, spawn_control_room, API lifecycle, port mgmt
├── live_workspace.rs        (~350 LOC)  — LocalLiveWorkspace, CurrentLivePublisher, publisher loop
├── python_bridge.rs         (~400 LOC)  — Python subprocess, script export, progress parsing, materialization
├── diagnostics.rs           (~400 LOC)  — initial state warnings, FDM/FEM/multilayer diagnosis
├── interactive.rs           (~350 LOC)  — preview polling, command handling, field refresh workers
├── orchestrator.rs          (~1200 LOC) — run_script_mode() rozbity na metody struct Orchestrator
├── formatting.rs            (~300 LOC)  — format_length_m, execution_plan_log_lines, artifact_layout
└── tests/                   (~300 LOC)  — przeniesione testy
```

### Graf zależności między modułami (DAG — brak cykli!)

```
args.rs          ←── (standalone, brak zależności wewnętrznych)
types.rs         ←── args.rs (dla BackendArg, etc.)
formatting.rs    ←── types.rs
control_room.rs  ←── types.rs (dla CurrentLivePublishRequest)
live_workspace.rs←── types.rs, control_room.rs (dla publish_current_live_state)
python_bridge.rs ←── types.rs (dla ScriptExecutionConfig, PythonProgressEvent)
diagnostics.rs   ←── types.rs, formatting.rs (dla format_length_m)
interactive.rs   ←── types.rs, control_room.rs (dla API GET /commands/next)
orchestrator.rs  ←── WSZYSTKIE powyższe + fullmag_runner, fullmag_plan
main.rs          ←── args.rs, orchestrator.rs (routing only)
```

**Kluczowe zależności krzyżowe:**
- `live_workspace.rs` → `control_room.rs`: publisher loop woła `publish_current_live_state()` (HTTP POST)
- `interactive.rs` → `control_room.rs`: polling `next_current_live_command()` i `preview_config` (HTTP GET)
- `orchestrator.rs` → wszytkie moduły (kompozycja)

**Brak cykli**: Żaden moduł niżej w grafie nie zależy od modułu wyżej. `orchestrator.rs` jest jedynym "hubem".

### Konkretne działania

**Strategia**: Wydzielamy moduły bottom-up wg grafu zależności — liście najpierw, hub (orchestrator) ostatni. Po **każdym** kroku: `cargo check -p fullmag-cli` musi przejść.

#### 1.1 Wydzielenie `args.rs` (liść — brak zależności)
- **Przenieś**: `Cli`, `ScriptCli`, `Command`, `BackendArg`, `ModeArg`, `PrecisionArg` (linie 24-114)
- **Przenieś**: `From<BackendArg>`, `From<ModeArg>`, `From<PrecisionArg>` (linie 315-340)
- **Przenieś**: `backend_target_name()`, `execution_mode_name()`, `execution_precision_name()` (linie 342-367)
- **Eksportuj** z `main.rs`: `pub mod args; use args::*;`
- **Test**: `cargo check -p fullmag-cli`

#### 1.2 Wydzielenie `types.rs`
- **Przenieś**: Wszystkie struktury DTO (linie 115-350): `ScriptRunSummary`, `SessionManifest`, `RunManifest`, `LiveStateManifest`, `EngineLogEntry`, `LiveStepView`, `CurrentLiveScalarRow`, `CurrentLivePublishPayload`, `CurrentLiveLatestFields`, `CurrentLivePublishRequest`, `PythonProgressEvent`, `ScriptExecutionConfig`, `ScriptExecutionStage`, `ResolvedScriptStage`, `SessionCommand`
- **Przenieś**: type alias `PythonProgressCallback`
- **Nie przenoś**: importów specyficznych dla innych modułów
- **Test**: `cargo check -p fullmag-cli`

#### 1.3 Wydzielenie `live_workspace.rs`
- **Przenieś**: `LocalLiveWorkspaceState`, `LocalLiveWorkspace` + impl blocks (linie ~500-700)
- **Przenieś**: `CurrentLivePublisher`, `current_live_publisher_loop()` (linie ~600-700)
- **Przenieś**: `bootstrap_live_state()`, `set_live_state_status()`, `scalar_row_from_update()`, `set_latest_scalar_row_if_due()` (linie ~750-820)
- **Przenieś**: stałe `MAX_ENGINE_LOG_ENTRIES`, `CURRENT_LIVE_MIN_PUBLISH_INTERVAL`
- **Zależności**: `types.rs`, `reqwest`
- **Test**: `cargo check -p fullmag-cli`

#### 1.4 Wydzielenie `control_room.rs`
- **Przenieś**: `ControlRoomGuard` + Drop impl (linie ~3150-3180)
- **Przenieś**: `spawn_control_room()` (~200 LOC, linie ~3200-3400)
- **Przenieś**: Cała sekcja port management: `resolve_web_port()`, `port_is_listening()`, `port_is_bindable()`, `frontend_is_ready()`, `frontend_is_ready_for_bootstrap()`, `static_control_room_is_ready()` (linie ~3600-3685)
- **Przenieś**: Process lifecycle: `stop_control_room_frontend_processes()`, `api_is_ready()`, `stop_fullmag_api_processes()`, `spawn_fullmag_api()`, `configure_repo_local_library_env()` (linie ~3690-3880)
- **Przenieś**: API client: `current_live_api_client()`, `publish_current_live_state()`, `publish_current_live_latest_fields()`, `wait_for_api_ready()` (linie ~3920-4005)
- **Przenieś**: `which_opener()`, `command_exists()`, `repo_root()`, `unix_time_millis()` (linie ~4010-4055)
- **Przenieś**: Stałe: `LOCALHOST_HTTP_HOST`, `LOCALHOST_API_BASE`, `LOOPBACK_V4_OCTETS`, `LOCAL_API_PORT`
- **Kluczowe**: `OnceLock<reqwest::blocking::Client>` zostaje w tym module jako `pub(crate)`
- **Test**: `cargo check -p fullmag-cli`

#### 1.5 Wydzielenie `python_bridge.rs`
- **Przenieś**: `export_script_execution_config_via_python()` (linie ~2850-2900)
- **Przenieś**: `check_script_syntax_via_python()` (linie ~2910-2930)
- **Przenieś**: `materialize_script_stages()`, `resolve_script_until_seconds()` (linie ~2940-3020)
- **Przenieś**: `apply_continuation_initial_state()` (linie ~3020-3040)
- **Przenieś**: `run_python_helper()`, `run_python_helper_with_progress()` (~150 LOC, linie ~3740-3850)
- **Przenieś**: `PythonProgressEnvelope`, `parse_python_progress_event()` (linie ~3700-3730)
- **Przenieś**: Stałe `PYTHON_PROGRESS_PREFIX`, `PYTHON_PROGRESS_JSON_PREFIX`
- **Test**: `cargo check -p fullmag-cli`

#### 1.6 Wydzielenie `diagnostics.rs`
- **Przenieś**: `InitialStateDiagnostic` (struct)
- **Przenieś**: Predykaty: `integrator_for_plan()`, `relaxation_uses_pure_damping()`, `has_nonzero_external_field()`, `magnetization_is_uniform()`, `near_zero()` (linie ~3350-3405)
- **Przenieś**: `add_initial_state_warnings()` (linie ~3410-3470)
- **Przenieś**: `diagnose_initial_fdm_plan()`, `diagnose_initial_fem_plan()`, `diagnose_initial_multilayer_plan()`, `diagnose_initial_backend_plan()` (linie ~3475-3675)
- **Przenieś**: `emit_initial_state_warnings()` (linie ~3680-3695)
- **Test**: `cargo check -p fullmag-cli`

#### 1.7 Wydzielenie `interactive.rs`
- **Przenieś**: `InteractivePreviewStatus`, `InteractivePreviewSourceState` (linie ~3050-3065)
- **Przenieś**: `refresh_interactive_preview_snapshot()`, `refresh_interactive_latest_fields()` (linie ~3070-3120)
- **Przenieś**: `spawn_interactive_latest_fields_refresh()`, `spawn_interactive_preview_refresh_worker()` (linie ~3125-3210)
- **Przenieś**: `next_current_live_command()`, `build_interactive_command_stage()` (linie ~3215-3310)
- **Przenieś**: `current_live_preview_config()`, `wait_for_current_live_preview_config()` (linie ~3240-3275)
- **Przenieś**: `CurrentLivePreviewConfigHandle` + Drop impl (linie ~3185-3240)
- **Test**: `cargo check -p fullmag-cli`

#### 1.8 Wydzielenie `formatting.rs`
- **Przenieś**: `format_length_m()`, `format_extent()`, `fem_mesh_bbox()` (linie 369-397)
- **Przenieś**: `log_execution_plan()`, `plan_summary_json()` (linie 399-414)
- **Przenieś**: `execution_plan_log_lines()` (~200 LOC, linie ~940-1150)
- **Przenieś**: `current_artifact_layout()` (~150 LOC, linie ~1000-1150)
- **Przenieś**: `current_meshing_capabilities()` (~200 LOC, linie ~1150-1350)
- **Test**: `cargo check -p fullmag-cli`

#### 1.9 Refaktor `run_script_mode()` → struct `Orchestrator`
- **Zamień** monolityczną funkcję ~2500 LOC na struct z metodami:

```rust
// orchestrator.rs
pub(crate) struct Orchestrator {
    args: ScriptCli,
    session_id: String,
    workspace_dir: PathBuf,
    artifact_dir: PathBuf,
    live_workspace: LocalLiveWorkspace,
    preview_config: CurrentLivePreviewConfigHandle,
    control_room_guard: ControlRoomGuard,
    global_step_offset: u64,
    global_time_offset: f64,
    continuation_magnetization: Option<Vec<[f64; 3]>>,
}

impl Orchestrator {
    pub fn new(args: ScriptCli) -> Result<Self> { ... }        // ~50 LOC: session setup
    pub fn bootstrap(&mut self) -> Result<()> { ... }          // ~80 LOC: control room, Python syntax check
    pub fn materialize(&mut self) -> Result<Vec<ResolvedScriptStage>> { ... }  // ~80 LOC
    pub fn execute_stages(&mut self, stages: &[ResolvedScriptStage]) -> Result<()> { ... }  // ~300 LOC
    fn execute_single_stage(&mut self, stage: &ResolvedScriptStage, idx: usize) -> Result<StageResult> { ... }  // ~200 LOC
    pub fn run_interactive(&mut self) -> Result<()> { ... }    // ~200 LOC
    pub fn finalize(&self) -> Result<ScriptRunSummary> { ... } // ~60 LOC
}
```

- **Wyekstrahuj** powtarzalny pattern `live_workspace.update(|state| {...})` do helper metod:
  ```rust
  impl Orchestrator {
      fn update_stage_progress(&self, update: &StepUpdate) { ... }
      fn set_status(&self, status: &str) { ... }
      fn push_engine_log(&self, level: &str, msg: &str) { ... }
  }
  ```

- **Wyekstrahuj** `build_session_manifest()` — zamiast 14 wywołań z 12 argumentami, metoda na Orchestrator:
  ```rust
  fn build_manifest(&self) -> SessionManifest { ... }  // korzysta z self.session_id, self.args, etc.
  ```

- **Test**: `cargo check -p fullmag-cli` + uruchomienie `examples/exchange_relax.py`

#### 1.10 Przeniesienie step utilities i IR I/O
- **Przenieś** do `orchestrator.rs` lub osobnego `step_utils.rs`:
  - `initial_step_update()`, `final_stage_step_update()`, `flatten_magnetization()`
  - `live_state_manifest_from_update()`, `running_run_manifest_from_update()`
  - `offset_step_update()`, `offset_step_stats()`, `stage_artifact_dir()`
  - `read_ir()`, `validate_ir()`, `join_errors()`

**Wynik fazy 1**: `main.rs` zmniejszony z 4600 LOC do ~120 LOC (entry point + mod declarations).

### Ryzyka fazy 1 i mitygacja

| Ryzyko | Mitygacja |
|--------|-----------|
| Callback closures w runner calls wymagają `'static` lifetimes | `Orchestrator` trzyma wszystko w `self` — closures mogą pożyczyć z `&self` |
| Publisher thread potrzebuje dostępu do HTTP client z control_room | `publish_current_live_state()` export z control_room jako `pub(crate)` |
| Visibility: `pub(crate)` obejmuje cały crate — nie da się ograniczyć do jednego modułu | Akceptowalne w binary crate; dokumentować za pomocą komentarzy |
| `#[cfg(test)]` inline w run_script_mode() | Przenieść testy do `tests/` directory lub `#[cfg(test)] mod tests` w odpowiednim module |

---

## Faza 2: Deduplikacja dispatch.rs — trait Backend (2–3 dni)

**Cel**: Zmniejszenie 16 wewnętrznych ścieżek wykonania do ~4 z użyciem traita i generics. Redukcja dispatch.rs z 1438 do ~500 LOC.

**Ważne**: Publiczne API runnera (3 entry points w lib.rs) NIE zmienia się:
- `run_problem()`, `run_problem_with_callback()`, `run_problem_with_live_preview()`
- `resolve_runtime_engine()`, `snapshot_problem_preview()`

CLI nigdy nie woła dispatch bezpośrednio — lib.rs deleguje do dispatch wewnętrznie.

### Stan obecny (wewnętrzny)

```
// 16 pub(crate) funkcji w dispatch.rs:
execute_fdm()                          → execute_fdm_streaming(None)
execute_fdm_streaming()                → match engine { Cpu → ..., Cuda → ... }
execute_fdm_with_callback()            → execute_fdm_with_callback_streaming(None)
execute_fdm_with_callback_streaming()  → match engine { Cpu → ..., Cuda → ... }
execute_fdm_with_live_preview()        → execute_fdm_with_live_preview_streaming(None)
execute_fdm_with_live_preview_streaming() → match engine { Cpu → ..., Cuda → ... }
// + FEM (6 analogicznych)
// + Multilayer (4 analogiczne)
= 16 pub(crate) ścieżek
```

### Docelowa architektura

#### 2.1 Definicja traita `SimulationBackend`

```rust
// crates/fullmag-runner/src/backend.rs (NOWY PLIK, ~80 LOC)

pub(crate) trait SimulationBackend {
    /// Perform one integration step. Returns per-step statistics.
    fn step(&mut self) -> Result<StepStats, RunError>;
    
    /// Snapshot current magnetization for live preview.
    fn snapshot_preview(
        &self, request: &LivePreviewRequest
    ) -> Result<LivePreviewField, RunError>;
    
    /// Snapshot vector fields for UI multi-quantity display.
    fn snapshot_vector_fields(
        &self, quantities: &[String]
    ) -> Result<Vec<(String, Vec<[f64; 3]>)>, RunError>;
    
    /// Extract current magnetization (for continuation between stages).
    fn extract_magnetization(&self) -> Vec<[f64; 3]>;
    
    /// Current simulation time.
    fn current_time(&self) -> f64;
    
    /// Current step index.
    fn current_step(&self) -> u64;
    
    /// Provenance info (engine name, precision, device).
    fn provenance(&self) -> ExecutionProvenance;
}
```

#### 2.2 Implementacje traita

- **`CpuFdmBackend`** w `cpu_reference.rs` — wrapper nad istniejącym `ExchangeLlgProblem` + `ExchangeLlgState`
- **`CudaFdmBackend`** w `native_fdm.rs` — wrapper nad `NativeFdmBackend` (FFI do C/CUDA)
- **`NativeFemBackend`** w `native_fem.rs` — wrapper nad istniejącym FEM runtime (feature-gated `fem-gpu`)
- **`MultilayerCudaBackend`** w `multilayer_cuda.rs` — wrapper nad multilayer execution context

Każda implementacja: ~80-150 LOC (thin wrapper delegujący do istniejącego kodu).
Stan wewnętrzny (State) jest własnością backendu — nie potrzeba associated type.
Backend sam zarządza swoim stepper/solver/GPU handle.

#### 2.3 Generyczny executor

```rust
// crates/fullmag-runner/src/executor.rs (NOWY PLIK, ~200 LOC)

pub(crate) struct SimulationExecutor<B: SimulationBackend> {
    backend: B,
    artifact_writer: Option<ArtifactPipelineSender>,
    live_consumer: Option<LiveStepConsumer>,
    schedules: OutputSchedules,
}

impl<B: SimulationBackend> SimulationExecutor<B> {
    pub fn new(backend: B) -> Self { ... }
    pub fn with_artifacts(mut self, writer: ArtifactPipelineSender) -> Self { ... }
    pub fn with_live_consumer(mut self, consumer: LiveStepConsumer) -> Self { ... }
    
    pub fn run(&mut self, until: f64) -> Result<ExecutedRun, RunError> {
        // Jedna pętla zamiast 16 kopii:
        // 1. backend.step()
        // 2. advance_due_schedules() + record outputs (istniejące z schedules.rs)
        // 3. live_consumer.on_step() jeśli Some
        // 4. preview snapshot jeśli preview_request i due
        // 5. artifact_writer.send() jeśli Some 
        // 6. sprawdź convergence (max_dm_dt < tol)
        // 7. sprawdź until time
    }
}
```

#### 2.4 Uproszczony dispatch

```rust
// dispatch.rs (~200 LOC zamiast 1438)

/// Jedyny pub(crate) entry point do dispatch — wywoływany z lib.rs
pub(crate) fn execute(
    plan: &ExecutionPlanIR,
    options: ExecutionOptions,
) -> Result<ExecutedRun, RunError> {
    match &plan.backend {
        BackendPlan::Fdm(fdm) => {
            let engine = resolve_fdm_engine(fdm)?;
            match engine {
                FdmEngine::CpuReference => {
                    let backend = CpuFdmBackend::new(fdm)?;
                    run_with_executor(backend, options)
                }
                FdmEngine::CudaFdm => {
                    let backend = CudaFdmBackend::new(fdm)?;
                    run_with_executor(backend, options)
                }
            }
        }
        BackendPlan::Fem(fem) => {
            let engine = resolve_fem_engine(fem)?;
            match engine {
                FemEngine::CpuReference => run_with_executor(CpuFemBackend::new(fem)?, options),
                FemEngine::NativeGpu => run_with_executor(NativeFemBackend::new(fem)?, options),
            }
        }
        BackendPlan::FdmMultilayer(ml) => {
            let backend = MultilayerCudaBackend::new(ml)?;
            run_with_executor(backend, options)
        }
    }
}

fn run_with_executor<B: SimulationBackend>(
    backend: B,
    options: ExecutionOptions,
) -> Result<ExecutedRun, RunError> {
    SimulationExecutor::new(backend)
        .with_artifacts_opt(options.artifact_writer)
        .with_live_consumer_opt(options.live_consumer)
        .run(options.until)
}
```

#### 2.5 Eliminacja martwych wrapperów

- **Usuń**: 5 funkcji `#[allow(dead_code)]` (linie 397, 422, 540, 627, 683)
- **Usuń**: 12 feature-gated stubów — zastąp jednym makrem:
  ```rust
  macro_rules! feature_gate {
      ($feat:literal, $body:expr) => {
          #[cfg(feature = $feat)] { $body }
          #[cfg(not(feature = $feat))] { Err(RunError { message: concat!("Not compiled with ", $feat) }) }
      }
  }
  ```

#### 2.6 Ujednolicenie snapshot functions

- **Połącz**: `snapshot_fdm_preview()`, `snapshot_fem_preview()` → `snapshot_preview()` (dispatchuje po BackendPlan)
- **Połącz**: `snapshot_fdm_vector_fields()` → `snapshot_vector_fields()`

**Wynik fazy 2**: dispatch.rs: 1438 → ~300 LOC. executor.rs: ~200 LOC (nowy). backend.rs: ~80 LOC (nowy). Eliminacja 16 pub(crate) ścieżek → 1 generyczny `execute()` + 5 backend impl (FDM-CPU, FDM-CUDA, FEM-CPU, FEM-GPU, Multilayer-CUDA).

**Publiczne API lib.rs**: BEZ ZMIAN — `run_problem()`, `run_problem_with_callback()`, `run_problem_with_live_preview()` zachowują sygnatury. Wewnętrznie lib.rs buduje `ExecutionOptions` i woła `dispatch::execute(plan, options)`.

---

## Faza 3: Redukcja duplikacji precision f32/f64 w multilayer_cuda.rs (1.5 dnia)

**Cel**: Redukcja multilayer_cuda.rs z 2549 do ~2000 LOC. Wyciągnięcie wspólnej logiki bez naruszania FFI boundary.

### Ograniczenie: FFI wymusza osobne ścieżki f32/f64

Warstwa C/CUDA (fullmag-fdm-sys) eksportuje **osobne symbole** dla każdej precyzji:
```c
fullmag_fdm_backend_copy_field_f64(...)
fullmag_fdm_backend_copy_field_f32(...)
fullmag_fdm_backend_upload_magnetization_f64(...)
fullmag_fdm_backend_upload_magnetization_f32(...)
```

Generyczny trait `FloatPrecision<F>` **NIE jest możliwy** bez przeprojektowania warstwy C.
Duplikacja `execute_*_double()` vs `execute_*_single()` jest **wymuszona przez FFI** — nie da się jej wyeliminować traitem.

### Co MOŻNA zrobić (redukcja ~500 LOC)

#### 3.1 Wyciągnięcie wspólnej logiki pętli do makra

Obie wersje (double/single) mają identyczną strukturę pętli:
```rust
loop {
    // 1. compute_demag_fields → update exchange
    // 2. observe state → emit StepStats
    // 3. call on_step callback
    // 4. check convergence
    // 5. advance timestep
    // 6. record outputs if due
}
```

**Makro `simulation_loop!`** wyekstrahuje wspólny control flow:
```rust
macro_rules! simulation_loop {
    ($self:expr, $observe_fn:ident, $step_fn:ident, $demag_fn:ident, $($body:tt)*) => {
        loop {
            let stats = $observe_fn(&$self.contexts, &$self.gpu_contexts, ...)?;
            // shared: callback, convergence check, scheduling
            $step_fn(&mut $self.states, ...)?;
            $demag_fn(&$self.gpu_contexts, ...)?;
            // shared: output recording, time advancement
        }
    }
}
```

**Szacowana redukcja**: ~200 LOC (strukturalny control flow)

#### 3.2 Wyciągnięcie wspólnych helperów wektorowych

Funkcje `add()` / `add_f32()`, `scale()` / `scale_f32()`, `zero_outside_active()` / `zero_outside_active_f32()` — te **nie dotyczą FFI** i mogą być generyczne:

```rust
fn vec_add<T: Copy + std::ops::Add<Output = T>>(dst: &mut [[T; 3]], src: &[[T; 3]]) { ... }
fn vec_scale<T: Copy + std::ops::Mul<Output = T>>(dst: &mut [[T; 3]], factor: T) { ... }
fn zero_outside_active<T: Default + Copy>(field: &mut [[T; 3]], mask: &[bool]) { ... }
```

**Szacowana redukcja**: ~100 LOC (eliminiacja _f32 wariantów helperów)

#### 3.3 Wyciągnięcie observe logic do wspólnego modułu

`observe_multilayer_cuda()` i `observe_multilayer_cuda_single()` różnią się tylko w:
- `backend.copy_m()` vs `backend.copy_m_f32()`
- Konwersja `[f32; 3] → [f64; 3]` dla scalar metrics

Wyekstrahować `compute_scalar_metrics_from_observables()` jako wspólną funkcję (już operuje na f64):
```rust
fn compute_scalar_metrics(
    magnetization_f64: &[[f64; 3]],
    h_ex_f64: &[[f64; 3]],
    h_demag_f64: &[[f64; 3]],
    ...,
) -> StepStats { ... }
```

**Szacowana redukcja**: ~80 LOC

#### 3.4 Rozbicie pliku na podmoduły

```
crates/fullmag-runner/src/
├── multilayer_cuda/
│   ├── mod.rs              (~100 LOC) — pub(crate) API + dispatch double/single
│   ├── context.rs          (~200 LOC) — LayerContext, LayerGpuContext, builders
│   ├── execute_double.rs   (~500 LOC) — double-precision main loop
│   ├── execute_single.rs   (~460 LOC) — single-precision main loop
│   ├── stacked.rs          (~300 LOC) — NativeStackedCudaPlan optimization
│   ├── observe.rs          (~200 LOC) — observe + scalar metrics
│   └── vector_math.rs      (~80 LOC)  — generic add/scale/zero helpers
```

**Wynik fazy 3**: multilayer_cuda łącznie: 2549 → ~1840 LOC (7 czytelnych plików zamiast 1 monolitu). Duplikacja f32/f64 pozostaje tam, gdzie wymusza ją FFI, ale jest izolowana w osobnych plikach i nie zaśmieca reszty kodu.

> **UWAGA**: Pełna eliminacja duplikacji f32/f64 wymagałaby przeprojektowania warstwy C/CUDA na generyczne templaty + jeden symbol `fullmag_fdm_backend_copy_field(precision_enum, ...)`. To jest poza zakresem tego planu ale flagujemy jako przyszłe ulepszenie.

---

## Faza 4: Refaktoryzacja fullmag-api (2–3 dni)

**Cel**: Redukcja API z 2622 LOC, eliminacja redundancji, przygotowanie do przyszłego osadzenia in-process.

### 4.1 Wydzielenie modułów API

```
crates/fullmag-api/src/
├── main.rs           (~100 LOC)  — router setup + server start
├── state.rs          (~100 LOC)  — AppState, stałe
├── dto.rs            (~400 LOC)  — wszystkie structs Request/Response
├── handlers/
│   ├── mod.rs        (~20 LOC)
│   ├── meta.rs       (~30 LOC)   — healthz, vision
│   ├── session.rs    (~150 LOC)  — bootstrap, publish, commands, artifacts
│   ├── preview.rs    (~100 LOC)  — wszystkie preview mutation endpoints
│   └── websocket.rs  (~80 LOC)   — ws_live, ws_current_live, handle_ws
├── preview/
│   ├── mod.rs        (~20 LOC)
│   ├── builder.rs    (~250 LOC)  — build_preview_state, build_from_live_field
│   ├── sampling.rs   (~200 LOC)  — grid resampling, fit_preview_grid, candidate_sizes
│   └── fields.rs     (~80 LOC)   — field parsing, component min/max
├── assets.rs         (~250 LOC)  — import pipeline, summarizers (STL/MSH/JSON)
└── state_merge.rs    (~100 LOC)  — apply_current_live_publish, merge_latest_fields
```

### 4.2 Konsolidacja 8 preview mutation endpoints

**Obecny pattern** (powtórzony 8×):
```rust
async fn set_current_preview_quantity(State(state): ..., Json(body): ...) -> ... {
    mutate_current_preview(&state, |config| { config.quantity = body.quantity.clone(); }).await
}
```

**Docelowy pattern** — jeden generyczny handler + enum:
```rust
enum PreviewMutation {
    Quantity(String),
    Component(String),
    XChosenSize(usize),
    YChosenSize(usize),
    EveryN(u32),
    AutoScale(bool),
    MaxPoints(usize),
    Layer(usize),
    AllLayers(bool),
}

async fn mutate_preview(
    State(state): State<Arc<AppState>>,
    Json(mutation): Json<PreviewMutation>,
) -> Result<Json<CurrentPreviewConfig>, ApiError> {
    let config = state.current_preview_config.write().await;
    mutation.apply(&mut config);
    // ...
}
```

Alternatywnie (mniej inwazyjne): zachowaj osobne endpointy, ale wyekstrahuj ciało do `mutate_current_preview()` z jednym parametrem closurowym — **to już istnieje**, wystarczy przenieść do `handlers/preview.rs`.

### 4.3 Eliminacja redundancji SSE + WebSocket

**Obecny problem**: API utrzymuje zarówno SSE (`/v1/live/current/events`) jak i WebSocket (`/ws/live/current`) — frontend używa tylko WebSocket.

**Działania**:
1. Zweryfikować w `apps/web`: czy SSE endpoint jest gdzieś używany
2. Jeśli nie → oznaczyć `#[deprecated]` i dodać komentarz `// TODO: remove in v0.3`
3. Nie usuwać od razu — zachować backward compatibility na 1 release cycle

### 4.4 Usunięcie martwego `POST /v1/run`

**Obecny stan**: Endpoint `start_run()` (linie 740-791) spawnuje simulation task — ale **cała logika uruchamiania symulacji jest w CLI**, nie w API. Endpoint nie jest wywoływany nigdzie.

**Działanie**: Usunąć handler + route. Zmniejszenie: ~50 LOC.

### 4.5 Optymalizacja rozmiaru broadcast

**Problem**: `publish_current_live_state()` broadcastuje pełen `SessionStateResponse` (200-500KB JSON) przy każdym timer tick (50ms).

**Działanie** (faza 4, nie blokuje):
1. Zmienić broadcast na delta-encoded updates:
   ```rust
   enum LiveBroadcast {
       FullSnapshot(SessionStateResponse),  // tylko na bootstrap
       StepDelta(StepUpdateView),           // normalny tick
       PreviewUpdate(PreviewState),         // po zmianie preview config
   }
   ```
2. Frontend reaguje na typ wiadomości i merguje stan lokalnie

**Wynik fazy 4**: API z 2622 → ~1500 LOC (8 plików zamiast 1). Usunięty dead code. Czytelna struktura modułowa.

---

## Faza 5: Uproszczenie warstwy Python (1 dzień)

### 5.1 Eliminacja duplikatu walidacji Python

**Problem**: `_validation.py` (65 LOC) waliduje typy i zakresy, ale Rust i tak waliduje te same dane po deserializacji JSON.

**Działanie**:
1. Zachować walidację Pythona — daje lepsze komunikaty błędów **w momencie wywołania API** (feedback przy pisaniu skryptu)
2. Dodać komentarz w `_validation.py`: `# Early feedback only — Rust re-validates after IR serialization`
3. **Nie usuwać** walidacji Python — jest wartościowa jako "fail fast at the point of call"

### 5.2 Ukrycie class-based API

**Problem**: Dwa publiczne API — `fm.geometry(fm.Box(...))` (flat/world.py) i `Problem(magnets=[Ferromagnet(...)])` (class-based).

**Działanie**:
1. Przenieść class-based API do `fullmag.advanced` namespace
2. W `__init__.py` zachować re-export z deprecation warning:
   ```python
   # __init__.py
   from .world import *  # flat API (primary)
   
   # backward-compatible re-exports from advanced module
   from .model.problem import Problem  # deprecated, use fm.* flat API
   ```
3. Zaktualizować docstrings i README z wyraźnym wskazaniem flat API jako primary
4. Oznaczyć class API jako `@typing.deprecated("Use fm.* flat API instead")`

### 5.3 Eliminacja round-trip JSON overhead

**Problem**: Python → JSON string → CLI reads file → serde_json::from_str → ProblemIR.

**Stan**: To jest konieczny mechanizm ponieważ Python i Rust to osobne procesy. Overhead JSON serializacji jest pomijalny w punkcie startowym symulacji (milliseconds per run). **Nie zmieniać** — to nie jest wąskie gardło.

**Przyszłość**: Jeśli kiedyś osadzisz Python (PyO3 in-process), wtedy zamienisz na zero-copy. Na razie: zostawić.

---

## Faza 6: Frontend cleanup (1 dzień)

### 6.1 Usunięcie framer-motion

**Problem**: `framer-motion` (~50KB) w package.json, ale nie jest importowane w żadnym komponencie.

**Działanie**:
1. `grep -r "framer-motion" apps/web/` — potwierdzić brak użycia
2. `cd apps/web && pnpm remove framer-motion`
3. Sprawdzić build: `pnpm build`

### 6.2 Rozbicie ControlRoomContext.tsx

**Problem**: 1180 LOC w jednym context providerze — zarządza stanem sesji, WebSocket, preview, commands.

**Docelowa struktura**:
```
components/runs/control-room/
├── ControlRoomContext.tsx     (~200 LOC) — kompozycja podkontekstów
├── SessionStateContext.tsx    (~300 LOC) — session/run state, scalar rows
├── PreviewContext.tsx         (~300 LOC) — preview config, mutations, rendering state
├── CommandContext.tsx         (~200 LOC) — interactive commands, execution control
└── WebSocketProvider.tsx      (~200 LOC) — WS connection, message routing
```

### 6.3 Usunięcie SSE client code (jeśli frontend nie używa)

**Działanie**:
1. Sprawdzić `useSessionStream.ts` (735 LOC) — czy używa SSE czy WS
2. Jeśli SSE → usunąć SSE client, zachować WS only
3. Jeśli oba → zostawić, ale dodać TODO

### 6.4 Analiza dead imports w package.json

**Działanie**:
1. `npx depcheck` w `apps/web/`
2. Usunąć nieużywane zależności
3. Sprawdzić build po usunięciu

---

## Faza 7: Porządki w testach i dead code (0.5 dnia)

### 7.1 Usunięcie `#[allow(dead_code)]` w dispatch.rs

Po fazie 2 (trait Backend) — usunąć wszystkie `#[allow(dead_code)]` anotacje które nie będą potrzebne.

### 7.2 Usunięcie semantic-only examples

**Problem**: 6 przykładów w `examples/` które się nie kompilują/nie uruchamiają (wymagają nieistniejących feature'ów).

**Działanie**:
1. Przenieść do `examples/showcase/` z README: "These examples demonstrate future API directions"
2. Lub usunąć i przenieść do `docs/specs/future-api-examples.md`

### 7.3 Konsolidacja plików planów

**Problem**: 18 plików w `docs/plans/active/` — wiele z nich jest nieaktualne.

**Działanie**:
1. Przegląd każdego pliku
2. Przeniesienie zakończonych do `docs/plans/completed/`
3. Archiwizacja nieaktualnych do `docs/plans/archived/`

---

## Faza 8: Dokumentacja architektury (0.5 dnia)

### 8.1 Zaktualizowanie `docs/2_repo_blueprint.md`

Po refaktoryzacji — zaktualizować blueprint o nową strukturę modułów.

### 8.2 Arch Decision Record

Opisać w `docs/adr/` decyzję o trait Backend, rozbicia CLI, eliminacji duplikacji.

---

## Podsumowanie budżetu pracy

| Faza | Działanie | Dni | Ryzyko |
|------|-----------|-----|--------|
| 0 | Przygotowanie infrastruktury | 0.5 | Niskie |
| 1 | Rozbicie cli/main.rs | 3–4 | **Średnie** — duży plik, wiele zależności wewnętrznych |
| 2 | Trait Backend + generyczny executor | 2–3 | **Wysokie** — zmiana architektury runnera |
| 3 | Rozbicie multilayer_cuda + redukcja duplikacji | 1.5 | Średnie — FFI wymusza część duplikacji |
| 4 | Refaktoryzacja API | 2–3 | Niskie — wydzielenie modułów bez zmiany logiki |
| 5 | Python cleanup | 1 | Niskie |
| 6 | Frontend cleanup | 1 | Niskie |
| 7 | Dead code & testy | 0.5 | Niskie |
| 8 | Dokumentacja | 0.5 | Niskie |
| **ŁĄCZNIE** | | **12–15** | |

---

## Kolejność realizacji i zależności

```
Faza 0 (przygotowanie)
  │
  ├── Faza 1 (CLI split) ←── PRIORYTET NAJWYŻSZY
  │     │
  │     └── Faza 8 (docs update)
  │
  ├── Faza 2 (trait Backend) ←── zależna od stabilnego CLI
  │     │
  │     └── Faza 3 (rozbicie multilayer_cuda) ←── zależna od trait Backend
  │
  ├── Faza 4 (API refactor) ←── niezależna, można robić równolegle z Fazą 2
  │
  ├── Faza 5 (Python cleanup) ←── niezależna
  │
  ├── Faza 6 (Frontend cleanup) ←── niezależna
  │
  └── Faza 7 (dead code) ←── po wszystkich fazach
```

**Ścieżka krytyczna**: Faza 0 → Faza 1 → Faza 2 → Faza 3  
**Równoległa praca**: Fazy 4, 5, 6 mogą biec równolegle z Fazą 2/3

---

## Kryteria sukcesu (Definition of Done)

- [ ] `cargo test --workspace` przechodzi bez nowych failures
- [ ] `cargo check -p fullmag-cli --features cuda` kompiluje
- [ ] Żaden plik źródłowy nie przekracza 1500 LOC (wyjątek: multilayer_cuda/* ze względu na FFI)
- [ ] dispatch.rs ma 1 publiczny `execute()` + generyczny executor (zamiast 16 pub(crate) wariantów)
- [ ] cli/main.rs ma ≤150 LOC
- [ ] Brak `#[allow(dead_code)]` w dispatch.rs (poza cfg-gated stubami)
- [ ] `examples/exchange_relax.py` uruchamia się poprawnie end-to-end
- [ ] Frontend buduje się bez warningów: `pnpm build`
- [ ] Łączna redukcja LOC: ≥10% (z ~74k do ≤66k) + znaczna poprawa czytelności (mniejsze pliki)

---

## Czego NIE robimy (poza zakresem)

1. **Osadzenie API in-process w CLI** — to przyszłościowe, wymaga zmiany architektury frontendowej
2. **Zmiana formatu komunikacji Python ↔ Rust** — JSON jest wystarczający
3. **Przepisywanie native C/CUDA** — stabilny, działa poprawnie
4. **Zmiana stacku frontendowego** — Next.js/React/Three.js jest dobrym wyborem
5. **Refaktoryzacja fullmag-engine** — dobrze zaprojektowany, ~2500 LOC, nie wymaga zmian
6. **Refaktoryzacja fullmag-ir** — dobrze zaprojektowany schema, nie wymaga zmian
7. **Refaktoryzacja fullmag-plan** — mały i spójny, ~950 LOC
