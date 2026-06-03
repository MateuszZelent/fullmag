# Audyt Backendów Po Relokacji

- Status: audyt etapu 2 po relokacji `native/backends/* -> backends/*`
- Data: 2026-06-03
- Zakres: `backends/fem`, `backends/fdm`, aktywne kontrakty source/layout
- Poza zakresem: zmiany fizyki, długie solve'y runtime, kwalifikacja GPU

## Cel

Ten dokument zamyka etap inwentaryzacji po relokacji. Ma opisać, co faktycznie
jest teraz właścicielem kompilowanych backendów, gdzie są subsystemy FEM/FDM i
które miejsca wymagają ostrożnego dalszego podziału.

Aktualny root implementacji solverów:

```text
backends/
  fdm/
  fem/
```

`native/` pozostaje technicznym rootem CMake, wspólnych nagłówków i pakowania.
Nie jest rootem implementacji solverów. Nie wolno odtwarzać
`native/backends/*` jako aktywnego drzewa implementacji.

## Metoda

Audyt opiera się na bieżącym worktree i mechanicznych skanach:

- `find backends/fem -maxdepth 3 -type d`
- `find backends/fdm -maxdepth 4 -type d`
- `find backends/fem backends/fdm -type f | wc -l`
- `wc -l` dla plików C++/CUDA/header poza `tests`
- przegląd istniejących kontraktów `fdm_source_layout_contract` i
  `fem_source_facade*`

## Inwentaryzacja FEM

`backends/fem` zawiera 428 plików.

| Subsystem | Pliki | Rola |
|---|---:|---|
| `backends/fem/core` | 12 | backend-neutral struktury FEM: mesh, state, material fields, field buffers, plan fields, context builder |
| `backends/fem/cpu/mfem` | 163 | realizacja CPU MFEM/hypre: runtime, integratory, interaction modules |
| `backends/fem/gpu/cuda` | 193 | realizacja GPU CUDA/libCEED/hypre-device: state, transfer, kernels, integratory, demag Poisson, observables |
| `backends/fem/include` | 5 | publiczne/natywne nagłówki ABI i wspólne typy |
| `backends/fem/src` | 5 | fasady C ABI, Context facade, error facade, DMI weak-residual facade, MFEM bridge |
| `backends/fem/tests` | 48 | kontrakty source/layout, kontrakty fizyki i runtime ownerów |
| `backends/fem/examples` | 1 | lokalny przykład/benchmark natywnego backendu |

Rozkład CPU MFEM:

| Subsystem | Pliki | Rola |
|---|---:|---|
| `cpu/mfem/integrators` | 17 | jawne implementacje kroków czasu i adaptive dt |
| `cpu/mfem/interactions` | 115 | właściciele interaction modules CPU MFEM |
| `cpu/mfem/runtime` | 31 | lifecycle, device policy, state IO, snapshot, availability, metrics |

Rozkład GPU CUDA:

| Subsystem | Pliki | Rola |
|---|---:|---|
| `gpu/cuda/integrators` | 108 | GPU RK, stage scheduling, stats, reductions, field refresh |
| `gpu/cuda/interactions` | 22 | lokalne interaction kernels i workspace state |
| `gpu/cuda/state` | 17 | device memory, magnetization state, residency, runtime coefficients |
| `gpu/cuda/demag_poisson` | 11 | GPU demag Poisson owner |
| `gpu/cuda/exchange` | 7 | GPU exchange owner |
| `gpu/cuda/fields` | 7 | field-buffer memory/upload/kernels |
| `gpu/cuda/transfer` | 6 | component transfer i transfer audit |
| `gpu/cuda/mesh` | 5 | mesh geometry/metrics/regions state |
| `gpu/cuda/reductions` | 5 | reduction kernels i workspace |
| `gpu/cuda/runtime` | 2 | GPU runtime facade |
| `gpu/cuda/observables` | 2 | observable kernels |
| `gpu/cuda/materials` | 1 | material state |
| `gpu/cuda/kernels` | 0 | pusty katalog przejściowy; nie jest właścicielem runtime |

Ocena FEM po relokacji:

- `src/api.cpp`, `src/context.cpp`, `src/error.cpp` i
  `src/dmi_weak_residual.cpp` są fasadami. Ich rozmiar był już ograniczany
  kontraktami `fem_source_facade*`; nie są miejscem na nową fizykę.
- `cpu/mfem/interactions/*` i `gpu/cuda/interactions/*` są poprawnymi
  miejscami dla dalszych prac interaction-specific.
- `gpu/cuda/integrators/*` jest największym właścicielem GPU FEM i powinien
  być dzielony tylko po stabilnych granicach integrator/runtime, nie przez
  przenoszenie do Rust runnera.
- `gpu/cuda/kernels` jest puste. Nie usuwam go w tym etapie, ale nie należy
  traktować go jako właściciela bez osobnego ADR/kontraktu.

## Inwentaryzacja FDM

`backends/fdm` zawiera 48 plików.

| Subsystem | Pliki | Rola |
|---|---:|---|
| `backends/fdm/api` | 2 | C ABI i error glue |
| `backends/fdm/gpu/cuda` | 31 | produkcyjny CUDA FDM runtime, interactions, integratory, demag |
| `backends/fdm/include` | 2 | wewnętrzne nagłówki FDM |
| `backends/fdm/tests` | 12 | source-layout, ABI, parity i smoke contracts |
| `backends/fdm/core` | 0 | pusty placeholder; nie jest właścicielem zachowania |
| `backends/fdm/src` | 0 | pusty po wyprowadzeniu flat source layout |

Rozkład CUDA FDM:

| Subsystem | Pliki | Rola |
|---|---:|---|
| `gpu/cuda/runtime` | 5 | context, telemetry, streams, reductions, device info |
| `gpu/cuda/interactions` | 11 | exchange, DMI, anisotropy, demag field kernels |
| `gpu/cuda/integrators` | 12 | LLG, RK, ABM, Heun i multilayer time stepping |
| `gpu/cuda/demag` | 3 | Newell kernels i multilayer convolution |

Największe pliki poza testami:

| Plik | Linie | Ocena |
|---|---:|---|
| `backends/fdm/gpu/cuda/runtime/context.cu` | 3518 | za duży właściciel runtime; kandydat do dalszego podziału po kontraktach |
| `backends/fdm/api/c_api.cpp` | 1436 | fasada ABI; podział możliwy tylko przy zachowaniu ABI tests |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | 1305 | runtime reductions; kandydat do podziału po funkcji/reduction family |
| `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu` | 1058 | wyspecjalizowany demag owner; nie przenosić do API ani Rust |
| `backends/fdm/gpu/cuda/integrators/multilayer_explicit_rk.cu` | 827 | integrator owner; dzielić tylko wewnątrz CUDA FDM |

Ocena FDM po relokacji:

- Największe ryzyko dalszego bałaganu jest w `context.cu`, nie w samym root
  `backends`.
- `api/c_api.cpp` może pozostać dużą fasadą ABI, dopóki testy ABI i
  source-layout chronią, że nie przejmuje runtime/interactions.
- Puste `core` i `src` są pozostałością po porządkowaniu. Nie tworzą problemu
  wykonawczego, ale nie powinny dostawać nowego kodu bez jawnej decyzji.

## Kontrakty Chroniące Aktualną Strukturę

Aktualne bramki lokalne:

- `fdm_source_layout_contract`
- `fem_source_facade_contract`
- `fem_source_facade_gpu_state_contract`
- `fem_source_facade_gpu_rk_contract`
- `fem_source_facade_cuda_kernels_contract`
- `fem_source_facade_export_progress_contract`

W tym etapie kontrakty zostały wzmocnione o regułę, że:

- root FDM musi być `backends/fdm`,
- root FEM musi być `backends/fem`,
- `native/backends/fdm` i `native/backends/fem` nie mogą zostać odtworzone jako
  drzewa implementacji.

## Decyzje Na Kolejny Etap

1. Prace FEM pozostają wewnątrz `backends/fem`.
2. Prace FDM pozostają wewnątrz `backends/fdm`.
3. Rust runner może być sprzątany tylko jako orkiestracja i ABI facade.
4. Nie dodajemy nowej fizyki do `src/api.cpp`, `src/context.cpp`,
   `mfem_bridge.cpp` ani `backends/fdm/api/c_api.cpp`.
5. Dalszy podział powinien zacząć się od kontraktów dla największych plików:
   `backends/fdm/gpu/cuda/runtime/context.cu`,
   `backends/fdm/api/c_api.cpp`,
   `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`.

## Start Etapu 3: Wzmocnienie FEM

Pierwszy krok następnego etapu nie zmienia fizyki ani runtime. Wzmacnia
kontrakty wokół istniejącego właściciela MFEM/hypre/libCEED:

- `backends/fem/tests/interaction_docs_contract.cpp` używa teraz
  kanonicznego rootu `backends/fem`, a nie historycznej ścieżki
  `native/backends/fem`.
- Kontrakt sprawdza, że interakcje CPU MFEM są czytane z
  `backends/fem/cpu/mfem/interactions`.
- Kontrakt blokuje odtworzenie
  `native/backends/fem/cpu/mfem/interactions` jako aktywnego drzewa
  implementacji.
- `backends/fem/CMakeLists.txt` musi nadal wskazywać źródła interakcji przez
  lokalne ścieżki `cpu/mfem/interactions/*`, bez zależności od starego rootu.

To jest bramka organizacyjna przed dalszym dzieleniem operatorów FEM. Nie jest
to nowy solver i nie przenosi odpowiedzialności FEM do `crates`.

## Start Etapów 4-5: Runner I Powierzchnie Produktowe

Pierwszy krok etapów 4-5 dotyczy orkiestracji i readbacku, nie implementacji
solvera:

- `crates/fullmag-runner/src/lib.rs` ma kontrakt, że `dispatch.rs` nie importuje
  `fullmag_fem_sys`, nie używa symboli `fullmag_fem_*` i nie omija
  `native_fem.rs` jako wrappera ABI.
- `crates/fullmag-runner/src/native_fem/availability.rs` jest właścicielem
  availability probing (`GpuAvailability`, `native_availability`,
  `is_cpu_available`, `is_gpu_available`).
- `crates/fullmag-runner/src/native_fem/plan.rs` jest właścicielem polityki
  planu runnera: detekcji device string, precession flag, single-precision
  rejection, STT mode helpers i wyboru GPU demag mode przed wywołaniem ABI.
- `crates/fullmag-runner/src/native_fem/runtime_info.rs` jest właścicielem
  bezpiecznych typów telemetrycznych mapowanych z FFI (`DeviceInfo`,
  `NativeFemDataResidency`, `NativeFemGpuStateInfo`,
  `NativeFemGpuRkPlanInfo`) oraz mapowania native stage-completion do
  `StageCompletionIR`.
- `crates/fullmag-runner/src/native_fem/eigen.rs` jest właścicielem samodzielnego
  wrappera ABI dla natywnego dense GPU eigensolve (`gpu_eigen_dense_solve`,
  `GpuEigenResult`).
- Testy runnera kompilowane z `fem-gpu` używają `include_str!` do aktualnego
  drzewa `backends/fem`, nie poprzedniej ścieżki `native/backends/fem`.
- Aktywne powierzchnie etapu 5 poza runnerem (`Makefile` freshness gate,
  `scripts/analysis/fem_gpu_benchmark.py`, testy benchmark config) wskazują na
  aktualne `backends/fem`, nie poprzednie `native/backends/fem`.
- `Makefile` freshness gate śledzi aktualny `compose.yaml`, a nie nieistniejący
  `docker-compose.yml`.
- `native_fem.rs` pozostaje fasadą dla C ABI i helperów runtime call, a
  availability, eigen, plan-policy i runtime-info tylko re-eksportuje.
- `CurrentRunResource` wystawia `resolved_fallback`, mapowany z manifestu
  sesji, żeby requested/resolved backend strategy nie gubiła decyzji o
  fallbacku.
- `run_problem`, `run_problem_with_callback` i
  `run_problem_with_live_preview_interruptible_with_initial_snapshot` dopinają
  `EngineResolution.fallback` do `ExecutionProvenance` przed zapisem artefaktów,
  żeby fallback FEM GPU -> CPU nie był widoczny tylko w zasobie sesji.
- `InteractiveFemPreviewRuntime::create` zachowuje `EngineResolution.fallback`
  w proweniencji persistent FEM runtime, więc artefakty zapisane przez
  `run_problem_with_interactive_fem_runtime_live_preview*` i unified
  `InteractiveRuntime` też nie gubią decyzji fallbacku.
- `metadata.json` ma skupiony test, że
  `execution_provenance.resolved_fallback` zachowuje `original_engine`,
  `fallback_engine` i `reason`.
- Wygenerowane OpenAPI i typy klienta zawierają `ResolvedFallbackResource`.
- Status bar control-room pokazuje fallback jako widoczny detail silnika i
  zachowuje oryginalny engine, fallback engine, reason oraz message w tytule.
- `apps/control-room/scripts/smoke-study-authoring-ui.mjs` fixture'uje
  `/v2/sessions/current/simulation/runs/current` z `resolved_fallback` i
  asercją browserową na widoczny status bar fallback (`FEM CPU`, `fallback to
  native MFEM/hypre`, title z `original_engine`, `fallback_engine` i `reason`).

To zamyka lokalny kontrakt widoczności fallbacku oraz focused browser smoke dla
tej powierzchni UI. Nie jest to jeszcze runtime proof dla każdego trybu
native ani pełna kwalifikacja prawdziwej sesji z żywym backendem.

Świeża weryfikacja etapu 5 z 2026-06-03:

- `cargo test -p fullmag-api current_run_endpoint_returns_runtime_summary`
  potwierdza `resolved_fallback` w zasobie current run.
- `cargo test -p fullmag-api openapi` potwierdza, że OpenAPI v2 nadal zawiera
  aktualny kontrakt runtime.
- `pnpm --dir apps/control-room test statusBarModel openapiV2GeneratedContract`
  potwierdza wygenerowany kontrakt klienta i model status bara.
- `CONTROL_ROOM_URL=http://localhost:3102/workspace pnpm --dir apps/control-room
  smoke:study-authoring-ui` przeszedł poza sandboxem Playwright po znanym
  błędzie Chromium sandbox. Ten smoke używa fixture current-run i dowodzi
  renderowanej powierzchni UI, nie pełnej sesji live backendu.

Świeży runtime proof managed FEM z 2026-06-03:

- `just ensure-managed-fem-runtime` wykrył przestarzały bundle przez nowszy
  plik `crates/fullmag-runner/src/artifacts.rs` i przebudował
  `.fullmag/runtimes/fem-gpu-host`.
- Nowy manifest bundle ma `created_at: 2026-06-03T09:43:16Z` i wskazuje
  launcher `bin/fullmag-fem-gpu`.
- `fullmag-fem-gpu validate-json` przechodzi dla minimalnego IR z
  `requested_backend="fem"`.
- `fullmag-fem-gpu plan-json --backend fem` zwraca
  `requested_backend="fem"` oraz `resolved_backend="fem"`.
- `fullmag-fem-gpu run-json --until 1e-13` na minimalnym IR z inline
  `geometry_assets.fem_domain_mesh_asset.mesh` z
  `examples/assets/box_40x20x10_coarse.mesh.json` zakończył się
  `status="completed"` i `total_steps=1`.
- Log runtime potwierdził aktywny natywny FEM:
  `engine=fem_cpu_native`, `device='mfem_cpu_mesh_ready'`,
  `mfem_device=cpu`, `assembly_mode=legacy_sparse`.
- Artefakty runtime zostały zapisane w `/tmp/fullmag-fem-run-json.kd7jqv/artifacts`:
  `metadata.json`, `scalars.csv`, `m_initial.json`, `m_final.json`,
  `fields/m/step_000001.json`, `fields/H_ex/step_000001.json`.
- `metadata.json.execution_provenance` potwierdza
  `execution_engine="fem_cpu_native"`, `fem_execution_mode="cpu_native"`,
  `mfem_device="cpu"`, `effective_fem_omp_threads=8`.
- `metadata.json.execution_provenance.resolved_fallback` jest `null` w tym
  przebiegu, bo test wymusił CPU przez managed wrapper i nie wykonywał ścieżki
  GPU -> CPU fallback.

Ograniczenia tego proofu:

- To jest proof świeżego managed bundle i realnego `run-json` przez natywny
  FEM CPU/MFEM, a nie pełna kwalifikacja GPU.
- Próba script-mode na `examples/fem_exchange_zeeman.py --backend fem
  --headless` zatrzymała się przed solverem w Python materializerze:
  `preset_texture` wymagał mesh/grid assetów do pre-samplingu. Ten błąd dotyczy
  przygotowania wejścia przez Python helper, nie samego `backends/fem`.

Aktualna bramka zamknięcia etapów 4-5 z tej samej rundy:

- `cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=OFF` przeszedł.
- `cmake --build native/build --target source_layout_contract
  fem_source_facade_contract fem_source_facade_gpu_state_contract
  fem_source_facade_gpu_rk_contract fem_source_facade_cuda_kernels_contract
  fem_source_facade_export_progress_contract` przeszedł.
- `ctest --test-dir native/build/backends/fdm -R
  '^fdm_source_layout_contract$' --output-on-failure` przeszedł.
- `ctest --test-dir native/build/backends/fem -R '^fem_source_facade.*$'
  --output-on-failure` przeszedł.
- `cargo check -p fullmag-fdm-sys -p fullmag-fem-sys` przeszedł.
- `cargo test -p fullmag-runner fallback` przeszedł, obejmując między innymi
  `interactive_fem_runtime_attaches_fallback_to_provenance`,
  `resolved_fallback_is_attached_to_execution_provenance_before_artifacts`,
  `metadata_execution_provenance_persists_resolved_fallback` i
  `session_runtime_registry_uses_native_fem_engine_ids_for_auto_gpu_fallback`.
- `cargo test -p fullmag-runner
  native_fem_c_abi_calls_stay_behind_native_fem_wrapper` przeszedł.
- `cargo test -p fullmag-api current_run_endpoint_returns_runtime_summary`
  przeszedł.
- `cargo test -p fullmag-api openapi` przeszedł.
- `pnpm --dir apps/control-room test statusBarModel
  openapiV2GeneratedContract` przeszedł.
- `CONTROL_ROOM_URL=http://localhost:3102/workspace pnpm --dir
  apps/control-room smoke:study-authoring-ui` przeszedł poza sandboxem i
  potwierdził renderowaną powierzchnię status-bara fallbacku:
  `Study authoring UI smoke passed at http://localhost:3102/workspace with 2
  model transactions.`

## Status Etapu

Etap audytu jest zamknięty lokalnie, gdy przechodzą:

```bash
cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=OFF
cmake --build native/build --target source_layout_contract fem_source_facade_contract fem_source_facade_gpu_state_contract fem_source_facade_gpu_rk_contract fem_source_facade_cuda_kernels_contract fem_source_facade_export_progress_contract
ctest --test-dir native/build/backends/fdm -R '^fdm_source_layout_contract$' --output-on-failure
ctest --test-dir native/build/backends/fem -R '^fem_source_facade.*$' --output-on-failure
cargo check -p fullmag-fdm-sys -p fullmag-fem-sys
git diff --check
```
