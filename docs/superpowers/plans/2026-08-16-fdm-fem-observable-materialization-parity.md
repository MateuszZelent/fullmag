# FDM/FEM Observable Materialization Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Domknąć wspólny kontrakt obserwacji dla FEM/FDM tak, aby FDM CUDA publikował niezerowe pełnodomenowe `H_demag`, aktywne przestrzenne `eden_*`, jawny stan materializacji oraz poprawne warstwy Airbox Wireframe/Points/Vectors bez fallbacku do `m`.

**Architecture:** Wspólna semantyka pozostaje w katalogu quantity, planie capability i runnerowym kontrakcie snapshotu. FDM zachowuje osobne bufory solverowe i obserwacyjne CUDA: maskowane `h_demag` dla LLG oraz pełnodomenowy `h_demag_visual` dla transportu. FEM nie dostaje nowego bufora ani nowej ścieżki numerycznej; jego istniejący snapshot adapter zostaje objęty tym samym stanem, provenance i testami kontraktowymi. API rozdziela capability (`data/quantities`) od cache (`data/fields`), a Control Room korzysta z obu zasobów przez istniejącą fasadę.

**Tech Stack:** Rust workspace (`fullmag-quantities`, `fullmag-plan`, `fullmag-runner`, `fullmag-api`, `fullmag-cli`), native C++/CUDA FDM backend, OpenAPI v2/typed frontend facade, React/Three.js viewport, managed `just` build recipes.

## Status wdrożenia — 2026-08-16

Warstwy kontraktu, backendu FDM, API oraz Control Room zadań 1–7 są zaimplementowane i zapisane w historii `mastera` do `c4a4ca477e460e618d3ffabb5096de9ffddd3786`. Bieżący artefakt API zbudowany z tego commita deklaruje capability/materialization osobno; izolowana sesja FDM potwierdziła niezerowy pełnodomenowy `H_demag` oraz materializację `eden_ex`, `eden_demag`, `eden_ext` i `eden_total`. Testy frontendowe, typecheck i lint przeszły; lokalny `react-doctor` nie był dostępny, a uruchomienie pakietu zewnętrznego zawieszało się, więc ten pod-gate nie jest oznaczony jako zaliczony.

Zadanie 8 pozostaje otwartym gate’em kwalifikacji: Browser MCP nie uruchomił się w tym środowisku z powodu błędu `sandboxCwd`, a obecny proces na porcie 8081 nadal jest starym artefaktem (`c78120f...`). Nie oznaczamy więc jeszcze browser/WebGL smoke, proxy parity ani pełnej kwalifikacji managed CUDA/FEM jako zaliczonych. Po wdrożeniu świeżego artefaktu należy wykonać wyłącznie kroki zadania 8 i dołączyć logi/screenshoty.

## Global Constraints

- Fizyczny kontrakt i jednostki są właścicielem `docs/physics/0890-energy-density-observables.md`; implementacja nie tworzy drugiego katalogu energii ani drugiego ProblemIR.
- `data/quantities` opisuje capability i planowane materializacje, `data/fields` opisuje cache/payload; brak cache nie oznacza `unsupported`.
- Solverowe `h_demag` pozostaje maskowane; pełnodomenowe `h_demag_visual` jest jedynym źródłem `H_demag` dla `full_domain` i Airbox.
- Nieznane quantity kończy się stabilnym błędem, bez mapowania na `m`.
- CUDA FP64 i FP32 używają tego samego quantity ID, jednostki i provenance; FP32 nie może ukrycie przejść przez FP64 ani CPU.
- WebSocket niesie tylko invalidacje/completion, a ciężkie wartości pozostają w binarnym data plane.
- Renderer nie oblicza pól ani energii; Wireframe/Points nie zależą od dostępności pola.
- Każda zmiana viewportu 3D wymaga browser smoke z widocznym canvasem, nieutraconym kontekstem WebGL i niezerowym drawing bufferem.
- Native FEM/CUDA build i runtime proof używają kontenerowych recept `just` z repozytorium; hostowe komendy są wyłącznie diagnostyczne.
- Istniejące dirty files `.impl-racetrack`, `apps/control-room/next-env.d.ts` i `external_solvers/3` pozostają nietknięte.

## Mapa plików

| Plik | Odpowiedzialność |
|---|---|
| `docs/physics/0890-energy-density-observables.md` | Kanoniczny opis równań, lokalizacji, czterech lane'ów CPU/GPU i kryteriów kwalifikacji. |
| `docs/physics/0890-energy-density-observables.source-map.json` | Stabilne mapowanie równań/claimów do symboli źródłowych i testów. |
| `docs/architecture/backend-golden-masterplan.md` | Właściciel adaptera snapshotów i rozdziału solver/visualization w FDM. |
| `docs/specs/capability-matrix-v0.md` | Status quantity i reason codes dla FDM CPU/CUDA oraz bezregresyjnego FEM. |
| `crates/fullmag-quantities/src/catalog.rs` | Canonical metadata (`n_comp`, location, domain, shape) dla `eden_*` i `H_demag`. |
| `crates/fullmag-plan/src/quantities.rs` | Backend × quantity capability matrix, w tym `eden_*` dla FDM CUDA. |
| `crates/fullmag-runner/src/quantities.rs` | Aktywacja quantity według planu i silnika bez fallbacku. |
| `crates/fullmag-runner/src/types.rs` | Wspólny stan snapshotu/materializacji i scalar/vector payload model. |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | Safe Rust wrapper C ABI dla full-domain `H_demag` i scalar snapshots. |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs` | RED/GREEN testy snapshotów CUDA i nieznanych quantity. |
| `crates/fullmag-runner/src/solvers/fdm/preview.rs` oraz `crates/fullmag-runner/src/interactive_runtime/fdm/cuda.rs` | Wspólna ścieżka terminalna, jawna i interaktywna materializacja. |
| `native/include/fullmag_fdm.h` i `crates/fullmag-fdm-sys/src/lib.rs` | Wersjonowany C ABI dla observable scalar/vector i snapshot descriptor. |
| `backends/fdm/include/context.hpp` | Własność dodatkowego bufora obserwacyjnego i scalar snapshot resources. |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`, `demag_fp32.cu` | Wypełnienie pełnodomenowego pola przed maskowaniem solvera. |
| `backends/fdm/gpu/cuda/runtime/context.cu` | Transfer full-domain/scalar, async lifecycle i fail-closed validation. |
| `backends/fdm/tests/demag_observable_contract.cpp` | Host/source ABI contract; CUDA runtime test dla niezerowego Airbox. |
| `crates/fullmag-cli/src/orchestrator.rs`, `interactive_runtime_host.rs` | Terminal/explicit `compute_fields`, capability-driven quantity list i deduplikacja. |
| `crates/fullmag-api/src/quantities.rs`, `src/schemas/quantities.rs`, `src/schemas/fields.rs`, `router_v2/handlers/data/{quantities,fields}.rs` | Resource-first capability/materialization state i reason codes. |
| `crates/fullmag-api/src/router_v2/tests.rs` | API contract: supported/unmaterialized/pending/complete/stale/error. |
| `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `quantityIds.ts`, `modules/ribbon/ribbonTabViews.tsx` | Facade/resource selection; no disabled item for merely unmaterialized quantity. |
| `apps/control-room/src/modules/viewport-3d/**` i testy | Render layers independent of quantity; vectors require compatible payload. |
| `apps/control-room/tests/e2e/fdm-airbox-observable-materialization.spec.ts` | Browser sequence Wireframe/Points/Vectors and WebGL health. |

---

### Task 1: Publication note, source map i capability vocabulary

**Files:**
- Modify: `docs/physics/0890-energy-density-observables.md`
- Create: `docs/physics/0890-energy-density-observables.source-map.json`
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Test: `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`

**Interfaces:**
- Produces canonical equations for `H_demag`/`h_demag_visual` and `eden_*`, four explicit backend/device rows, and reason-code names consumed by Tasks 2–8.

- [x] **Step 1: Extend the physics note before production code.**

  Add labelled sections `(problem-statement)`, `(governing-equations)`, `(symbols-and-si-units)`, `(assumptions-and-validity)`, `(python-api)`, `(problem-ir)`, `(round-trip-and-failure-semantics)`, `(discrete-realization)`, `(implementation-mapping)`, `(validation)`, `(limitations)`, `(scientific-bibliography)`, `(source-code-index)`. Replace the old FDM “CPU first/CUDA later” status with an explicit matrix: FDM CPU reference executable/qualified, FDM CUDA FP64 executable pending runtime parity, FDM CUDA FP32 executable pending precision parity, FEM CPU/GPU unchanged and regression-qualified. Include the exact pointwise equations with `$\mu_0$`, `$M_s$`, `$\mathbf m$`, `$\mathbf H_i$`, `$\varepsilon_i$`, `$V_c$`, and state that scalar `eden_*` payloads have `n_comp=1` and `location=cell`.

- [x] **Step 2: Write the adjacent source map.**

  Use JSON objects with `document`, `equations`, `symbols`, `parameters`, `sources`, and `tests`; every entry names a repository-relative path plus a unique symbol/function, never a bare line range. Map the demag equation to `backends/fdm/gpu/cuda/interactions/demag_fp64.cu::launch_demag_field_fp64`, the CPU density equation to `crates/fullmag-engine/src/fdm/cpu/fields.rs::field_dot_energy_density`, the API capability to `crates/fullmag-api/src/quantities.rs::build_quantities`, and the FEM regression to `backends/fem/tests/snapshot_contract.cpp::full_domain_demag_snapshot_uses_visual_buffer`.

- [x] **Step 3: Run the documentation RED gate.**

  Run:

  ```bash
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0890-energy-density-observables.source-map.json --repo-root .
  ```

  Expected: FAIL until the note contains every required label and every source-map symbol exists.

- [x] **Step 4: Update architecture/capability status and run GREEN gates.**

  State that FDM owns a separate visual field buffer and that capability status is distinct from cache status. Run:

  ```bash
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0890-energy-density-observables.source-map.json --repo-root .
  python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
  ```

  Expected: validator PASS and unittest suite PASS.

- [x] **Step 5: Commit the publication contract.**

  ```bash
  git add docs/physics/0890-energy-density-observables.md docs/physics/0890-energy-density-observables.source-map.json docs/architecture/backend-golden-masterplan.md docs/specs/capability-matrix-v0.md
  git commit -m "docs: define observable materialization parity contract"
  ```

### Task 2: Canonical capability and runner quantity activation

**Files:**
- Modify: `crates/fullmag-plan/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Test: `crates/fullmag-plan/src/quantities.rs`
- Test: `crates/fullmag-runner/src/quantities.rs`

**Interfaces:**
- Produces `QuantityCapability::{Exact,Derived,Unsupported,Planned}` for the same `eden_*` set on FDM CPU/CUDA and `active_fdm_preview_quantities(FdmEngine::CudaFdm, ...)` returning only active terms.

- [x] **Step 1: Add failing capability tests.**

  Add tests asserting that FDM CUDA with exchange, demag, external field, uniaxial anisotropy and interfacial DMI exposes `EdenEx`, `EdenDemag`, `EdenExt`, `EdenAni`, `EdenDmi`, `EdenTotal`, and that a plan with no demag does not expose `EdenDemag`. Add a test that CPU and CUDA lists have identical IDs for the same enabled terms.

- [x] **Step 2: Run the focused tests and observe RED.**

  ```bash
  cargo test -p fullmag-plan quantities::tests --lib
  cargo test -p fullmag-runner quantities::tests --lib
  ```

  Expected: failure showing missing CUDA energy-density capability/list entries.

- [x] **Step 3: Implement the minimum catalog/capability change.**

  Add the seven scalar density IDs to the FDM CUDA exact/derived matrix and to `BackendCapabilities.preview_quantities` and `snapshot_quantities`, while keeping activation predicates tied to the same physical plan flags used by scalar energies. Do not add a wildcard or default branch that returns `m`.

- [x] **Step 4: Run GREEN and source-contract checks.**

  ```bash
  cargo test -p fullmag-plan quantities::tests --lib
  cargo test -p fullmag-runner quantities::tests --lib
  ```

  Expected: PASS with no unsupported quantity accidentally becoming active.

- [x] **Step 5: Commit.**

  ```bash
  git add crates/fullmag-plan/src/quantities.rs crates/fullmag-runner/src/quantities.rs crates/fullmag-runner/src/capabilities.rs
  git commit -m "feat: advertise FDM CUDA energy density quantities"
  ```

### Task 3: Full-domain CUDA demagnetization buffer

**Files:**
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/runtime/context.cu`
- Modify: `native/include/fullmag_fdm.h`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Test: `backends/fdm/tests/demag_observable_contract.cpp`
- Test: `crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs`

**Interfaces:**
- Adds `Context::h_demag_visual` and maps `FULLMAG_FDM_OBSERVABLE_H_DEMAG` to the visual field only for full-domain downloads/snapshots; LLG continues reading `Context::h_demag`.

- [x] **Step 1: Write the failing source/runtime contracts.**

  The C++ contract checks that `Context` contains separate `h_demag` and `h_demag_visual` ownership and that the demag unpack path writes the visual destination before applying `active_mask`. The Rust test uses a masked dipole plan and asserts `H_demag` snapshot metadata has three components and at least one nonzero inactive-cell sample when CUDA is available; otherwise it asserts an explicit unavailable result.

- [x] **Step 2: Run RED.**

  ```bash
  just verify-fdm-time-domain-native-contract
  cargo test -p fullmag-runner fdm::gpu::cuda::native::tests::native_fdm_full_domain_demag_snapshot --features cuda --lib
  ```

  Expected: source contract fails because only masked `h_demag` exists; CUDA test fails with an all-zero Airbox sample on the old library.

- [x] **Step 3: Add separate visual storage and demag writes.**

  Allocate/free/zero `h_demag_visual` alongside `h_demag`. Change both FP64 and FP32 unpack kernels to compute `hx_value`, `hy_value`, `hz_value`, always write those values to `h_demag_visual`, and only write zero or the value to `h_demag` according to `active_mask`. Keep boundary correction on the solver field and add the same correction to the visual field only when its source indices are full-domain valid; no second FFT is allowed.

- [x] **Step 4: Route full-domain copies and async snapshots to the visual buffer.**

  In `context_download_field_impl`, `context_download_field_preview_impl`, and `context_begin_async_field_snapshot` select `h_demag_visual` for `H_DEMAG`. Keep the multilayer layer path unchanged and explicitly reject a missing visual buffer with `demag_visual_buffer_unavailable` instead of returning zeros.

- [x] **Step 5: Run GREEN source and managed CUDA tests.**

  Use the repository `justfile` recipe that builds the managed FDM runtime, then run the source contract and CUDA runtime test. Expected: solver field remains zero in inactive cells, full-domain payload is finite and nonzero outside the magnet, and no second FFT counter is observed.

- [x] **Step 6: Commit.**

  ```bash
  git add backends/fdm/include/context.hpp backends/fdm/gpu/cuda/interactions/demag_fp64.cu backends/fdm/gpu/cuda/interactions/demag_fp32.cu backends/fdm/gpu/cuda/runtime/context.cu native/include/fullmag_fdm.h crates/fullmag-fdm-sys/src/lib.rs crates/fullmag-runner/src/fdm/gpu/cuda/native.rs backends/fdm/tests/demag_observable_contract.cpp crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs
  git commit -m "fix(fdm): publish full-domain CUDA demag snapshots"
  ```

### Task 4: CUDA scalar energy-density snapshot path

**Files:**
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/gpu/cuda/runtime/context.cu`
- Modify: `native/include/fullmag_fdm.h`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs`
- Test: `backends/fdm/tests/energy_density_observable_contract.cpp`

**Interfaces:**
- Adds scalar observable enum values and `fullmag_fdm_backend_copy_scalar_field_{f32,f64}` plus async snapshot descriptors with `component_count=1`.

- [x] **Step 1: Add RED tests for scalar ABI and integral parity.**

  Add a C++ test that rejects an invalid scalar output length and checks that a deterministic one-cell external-field fixture returns `eden_ext = -\mu_0 M_s \mathbf m\cdot\mathbf H_ext`. Add a Rust test asserting each scalar snapshot is represented as `spatial_scalar`, has `n_comp=1`, and unknown IDs return `RunError` rather than the magnetization observable.

- [x] **Step 2: Run RED.**

  ```bash
  cargo test -p fullmag-runner fdm::gpu::cuda::native::tests::native_fdm_scalar_energy_density --features cuda --lib
  ```

  Expected: compile/test failure because no scalar ABI exists.

- [x] **Step 3: Implement scalar buffers and kernels.**

  Add one scalar device buffer per active `eden_*` family plus `eden_total`. Use a single templated kernel launched from `context_refresh_observables` or a dedicated `context_refresh_energy_density_observables` that consumes the accepted `m`, `h_ex`, `h_demag_visual`, `h_ani`, external field and material terms. Inactive cells write zero. The total kernel sums only enabled terms. Use FP64/FP32 native arithmetic and preserve cell volume only in the scalar integration check, not in the density payload.

- [x] **Step 4: Implement scalar C ABI and Rust conversion.**

  Extend the observable enum with `EDEN_EX`, `EDEN_DEMAG`, `EDEN_EXT`, `EDEN_ANI`, `EDEN_DMI`, `EDEN_TOTAL`. Add typed copy functions and make `NativeFdmBackend::copy_live_preview_field` choose `build_grid_scalar_preview_field_from_flat_plan` for these IDs. Extend `NativeFdmPreviewSnapshot` conversion to accept `component_count=1` and preserve scalar values without fabricating three vector components.

- [x] **Step 5: Run GREEN.**

  Run the C++ contract, focused Rust tests and existing FDM CPU density tests. Expected: each enabled density integrates to its corresponding global scalar within the documented FP64/FP32 tolerance and disabled terms are zero.

- [x] **Step 6: Commit.**

  ```bash
  git add backends/fdm/include/context.hpp backends/fdm/gpu/cuda/runtime/context.cu native/include/fullmag_fdm.h crates/fullmag-fdm-sys/src/lib.rs crates/fullmag-runner/src/fdm/gpu/cuda/native.rs crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs backends/fdm/tests/energy_density_observable_contract.cpp
  git commit -m "feat(fdm): expose CUDA energy density snapshots"
  ```

### Task 5: Unified runner materialization and terminal publication

**Files:**
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/solvers/fdm/preview.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime/fdm/cuda.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Test: `crates/fullmag-runner/src/interactive_runtime/fdm/cuda.rs`
- Test: `crates/fullmag-cli/src/interactive_runtime_host.rs`

**Interfaces:**
- `LiveFieldMaterializationState` gains explicit `Unmaterialized` and `StaleComplete` semantics; one helper returns the active materializable set for both terminal and explicit `compute_fields` paths.

- [x] **Step 1: Add failing lifecycle tests.**

  Test a fresh session with capability but no payload as `Unmaterialized`, a queued snapshot as `Pending`, an old payload after a new generation as `StaleComplete`, and a CUDA copy error as `Error` while preserving the solver completion. Test that terminal publication and explicit `compute_fields` call the same helper and that duplicate requests for one `(quantity, source_step, generation)` are coalesced.

- [x] **Step 2: Run RED.**

  ```bash
  cargo test -p fullmag-runner interactive_runtime::tests --lib
  cargo test -p fullmag-cli interactive_runtime_host::tests --lib
  ```

  Expected: failures for missing state variants and CUDA density IDs in terminal materialization.

- [x] **Step 3: Implement backend-neutral coordinator behavior.**

  Add a runner helper that normalizes requested IDs, filters through active capabilities, emits pending states, snapshots each quantity once, validates field domain/components/finite values, atomically returns completed payloads, and returns a stable reason code on failure. For FDM CUDA use the native snapshot adapter; for FDM CPU/FEM reuse existing adapters. Unknown IDs are rejected before adapter dispatch.

- [x] **Step 4: Wire terminal and `compute_fields` to the same helper.**

  Replace independent quantity lists in `orchestrator.rs` and `interactive_runtime_host.rs` with the helper. Keep `awaiting_command` reusable for `compute_fields`; no solver step is allowed. Publish `m` first, then auxiliary fields, and emit one family invalidation plus per-payload revisions.

- [x] **Step 5: Run GREEN and regression tests.**

  ```bash
  cargo test -p fullmag-runner interactive_runtime --lib
  cargo test -p fullmag-cli interactive_runtime_host --lib
  ```

  Expected: terminal and explicit materialization produce identical IDs/provenance, and solver step count is unchanged by `compute_fields`.

- [x] **Step 6: Commit.**

  ```bash
  git add crates/fullmag-runner/src/types.rs crates/fullmag-runner/src/solvers/fdm/preview.rs crates/fullmag-runner/src/interactive_runtime/fdm/cuda.rs crates/fullmag-runner/src/fdm/cpu/reference.rs crates/fullmag-cli/src/orchestrator.rs crates/fullmag-cli/src/interactive_runtime_host.rs
  git commit -m "feat: unify FDM field materialization lifecycle"
  ```

### Task 6: Resource-first API states, schema and OpenAPI

**Files:**
- Modify: `crates/fullmag-api/src/quantities.rs`
- Modify: `crates/fullmag-api/src/schemas/quantities.rs`
- Modify: `crates/fullmag-api/src/schemas/fields.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- `QuantityCatalogEntry` exposes capability/materialization readiness independently from `FieldDescriptor`; field metadata uses `unsupported`, `unmaterialized`, `pending`, `complete`, `stale_complete`, `error` with stable reason codes.

- [x] **Step 1: Add RED API tests.**

  Build a session fixture whose execution metadata advertises `eden_demag` and `H_demag` but whose `latest_fields` is empty. Assert `/data/quantities` marks both selectable/materializable, `/data/fields` returns no false `available=false` descriptor, and `/fields/H_demag/meta` returns a materialization state instead of a generic 404. Assert Airbox `magnetic_only` gives `unsupported_scope`; full-domain Airbox returns the visual payload.

- [x] **Step 2: Run RED.**

  ```bash
  cargo test -p fullmag-api router_v2::tests::v2_quantity_catalog --lib
  cargo test -p fullmag-api router_v2::tests::v2_airbox --lib
  ```

  Expected: the old API treats the absent cache as unavailable or 404.

- [x] **Step 3: Implement schema and handler separation.**

  Extend the quantity response with a capability state and `materializable` flag derived from `BackendCapabilities`. Map runner states explicitly in one function. Do not synthesize `FieldDescriptor` from a missing payload. For `H_demag` Airbox validate generation, finite values and sample count before returning 200; otherwise return a stable `field_materialization_invalid_payload` error.

- [x] **Step 4: Regenerate/verify OpenAPI and run GREEN.**

  Use the repository OpenAPI generation command from `justfile`/`crates/fullmag-api`, then run:

  ```bash
  cargo test -p fullmag-api router_v2::tests --lib
  ```

  Expected: all existing v2 tests plus the new state/airbox tests PASS, with no legacy `/v1/live` transport added.

- [x] **Step 5: Commit.**

  ```bash
  git add crates/fullmag-api/src/quantities.rs crates/fullmag-api/src/schemas/quantities.rs crates/fullmag-api/src/schemas/fields.rs crates/fullmag-api/src/router_v2/handlers/data/quantities.rs crates/fullmag-api/src/router_v2/handlers/data/fields.rs crates/fullmag-api/src/openapi_v2.rs crates/fullmag-api/src/router_v2/tests.rs
  git commit -m "feat(api): separate quantity capability from field cache"
  ```

### Task 7: Backend-neutral Control Room selection and Airbox layers

**Files:**
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonTabViews.tsx`
- Modify: existing field resource hook/domain adapter selected by `ControlRoomApi`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Test: `apps/control-room/src/modules/ribbon/ribbonTabViews.test.tsx`
- Test: existing Airbox viewport/render-model tests under `apps/control-room/src/modules/viewport-3d/`

**Interfaces:**
- Quantity selector consumes capability catalog and field state; `Wireframe`/`Points` consume geometry carriers; `Vectors` accepts only complete full-domain vector fields with nonzero glyph candidates.

- [x] **Step 1: Add RED frontend tests.**

  Test that an advertised but unmaterialized `H_demag`/`eden_demag` is enabled and triggers one deduplicated `compute_fields` request; unknown quantity displays a reason and never becomes `m`. Test render-model transitions `wireframe on -> off -> points on -> off -> vectors on` and assert each frame has the expected layer set; scalar `eden_*` never enters glyph rendering.

- [x] **Step 2: Run RED.**

  ```bash
  TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts src/modules/ribbon/ribbonTabViews.test.tsx src/modules/viewport-3d --reporter=dot
  ```

  Expected: selector disables missing cache and old renderer leaves a vector/geometry layer stuck in the committed frame.

- [x] **Step 3: Implement capability-aware selection.**

  Add a resource helper that merges `data/quantities` capability with `data/fields` state. `requestFieldMeta`/`requestFieldVectorOnDemand` may materialize an advertised ID, but selector gating must no longer block the call. Preserve the last complete buffer during pending; expose `error.reason_code`; remove any fallback branch that substitutes `m`.

- [x] **Step 4: Implement geometry-only layer ownership.**

  Ensure Airbox wireframe and points are built from canonical geometry carriers and are independent of quantity requests. Vectors require `kind=vector_field`, `domain=full_domain`, `components=3`, complete finite payload and readable glyph count; scalar fields route to scalar color/points only. Keep `frameloop="demand"` and invalidate only after resource completion/layer mutation.

- [ ] **Step 5: Run GREEN, typecheck and React doctor.**

  ```bash
  TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts src/modules/ribbon/ribbonTabViews.test.tsx src/modules/viewport-3d --reporter=dot
  pnpm --dir apps/control-room typecheck
  ```

  Run the repository `react-doctor` workflow after tests; expected no score regression and no unprefixed new CSS class.

- [x] **Step 6: Commit.**

  ```bash
  git add apps/control-room/src/kernel/api/ControlRoomApi.ts apps/control-room/src/kernel/api/quantityIds.ts apps/control-room/src/modules/ribbon/ribbonTabViews.tsx apps/control-room/src/modules/viewport-3d
  git commit -m "fix(control-room): select materializable Airbox quantities"
  ```

### Task 8: Managed qualification, API proxy parity and browser/WebGL gates

**Files:**
- Create: `apps/control-room/tests/e2e/fdm-airbox-observable-materialization.spec.ts`
- Modify: `scripts/` or existing managed FDM qualification recipe only where required by the current `justfile`
- Test artifacts: managed runtime logs, JSON field stats, FMVP metadata and browser screenshots under the existing ignored evidence directory

**Interfaces:**
- Produces executable evidence for direct API, proxy API, FDM CUDA FP64, FDM CUDA FP32, and no-regression FEM snapshot semantics; no source-only claim is accepted as runtime parity.

- [ ] **Step 1: Write the browser RED scenario.**

  The Playwright scenario loads `/workspace`, selects Airbox, commits `wireframe on`, `wireframe off`, `points on`, `points off`, requests `H_demag`, then commits `vectors on`. It asserts drawing-buffer width/height > 0, `gl.isContextLost() === false`, vector payload `n_comp=3`, finite nonzero Airbox samples and at least one glyph above the configured readability threshold.

- [ ] **Step 2: Run the browser scenario against the old runtime.**

  Expected: fail at the API field/capability or zero Airbox sample, proving the test catches the reported bug.

- [ ] **Step 3: Run managed FDM CUDA qualification.**

  Inspect `justfile`, execute the matching managed build/run recipe, and store source-identified evidence for FP64 and FP32: device identity, generation ID, `H_demag` full-domain stats, scalar density integrals, zero inactive solver field, and no duplicate FFT count. Use the documented CPU reference fixture as the oracle.

- [ ] **Step 4: Run direct-port/proxy parity checks.**

  Compare `/v2/sessions/current/data/quantities`, `/data/fields/H_demag/meta`, ETags, and FMVP payload checksums on the backend port and Control Room proxy. Assert the same capability state, source revision, domain generation and reason code.

- [ ] **Step 5: Run FEM regression using managed recipe.**

  Execute the existing managed FEM snapshot contract. Assert the FEM visual full-domain demag source and existing energy-density projection remain unchanged.

- [ ] **Step 6: Run GREEN browser and performance gates.**

  Run the browser spec plus the existing 100-cycle quantity/layer stress test. Record peak heap, geometry/material count, listener count, worker count and WebGL context status; all must remain within the existing performance budget and no layer may remain visible after being toggled off.

- [ ] **Step 7: Final verification and commit.**

  ```bash
  git status --short
  git diff --check
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base "$(git rev-parse 44d2ac2bc)" --head HEAD --repo-root .
  ```

  Inspect `git diff --cached --name-only` separately before committing. Commit only implementation files and the new e2e spec; preserve unrelated dirty files.

## Final acceptance gate

The implementation is complete only when all of the following are evidenced:

1. `H_demag` is selectable from an advertised capability before cache materialization and its Airbox payload is finite and nonzero for a nonzero dipole.
2. `eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`, and `eden_total` are active only for enabled interactions, have `n_comp=1`, and integrate to their global energies within documented precision tolerances.
3. Solver mask semantics are unchanged; only the visualization carrier includes Airbox.
4. Unknown quantity, unsupported scope, generation mismatch, snapshot allocation/copy error, and stale payload have explicit states/reason codes.
5. Terminal publication and `compute_fields` share one materialization path and `compute_fields` does not advance the solver.
6. Direct API and proxy descriptors/payloads are identical.
7. Wireframe and Points work without field data, Vectors commits a separate readable frame, and WebGL remains healthy after repeated toggles.
8. Managed CUDA and FEM runtime evidence, source map validation, Rust/frontend tests and browser smoke all pass.
