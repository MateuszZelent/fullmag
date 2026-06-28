# FMR k=0 / PBC / GPU Production Readiness Plan

Data: 2026-06-28
Status: aktywny plan naprawczy

## Cel produkcyjny

Doprowadzic Fullmag do stanu, w ktorym uzytkownik moze policzyc driven FMR dla
periodycznej komorki ferromagnetyka przy `k = 0` bez zgadywania, fallbackow i
recznej interpretacji artefaktow:

- Python DSL i UI autoruja ten sam `StudyIR::FrequencyResponse`,
- planner zachowuje requested intent i jawnie pokazuje resolved execution,
- runtime wykonuje tylko wspierane lane'y i nie spada po cichu na CPU/dense
  validation,
- artefakty `response/*`, `mesh/periodic_pairs.v1.json` i
  `frequency_domain/manifest.v1.json` sa kompletne,
- Control Room umie pokazac gotowosc, wyniki FMR, peak table i 3D response
  field overlay z zasobow v2.

## Definicja zakresu

### Release 1: produkcyjny k=0 PBC na FEM CPU

Pierwszy realny produkt dla krysztalu magnonicznego:

- FEM CPU/MFEM,
- P1 tetrahedra,
- `double`,
- magnetic-domain mesh,
- `spin_wave_bc=periodic`,
- `k = 0` / gamma,
- `include_demag=false`,
- exchange + Zeeman + uniform/nodal damping,
- deterministic periodic pair metadata.

Ten zakres jest fizycznie ograniczony: to magnetic-only driven response bez
dynamicznej demagnetyzacji. UI i provenance musza to powiedziec wprost.

### Release 2: produkcyjny GPU gamma/free

Osobny cel GPU:

- FEM GPU/CUDA,
- gamma/free-boundary,
- no-demag,
- no-DMI,
- no static-periodic projection,
- ten sam kontrakt artefaktow co CPU.

Ten release nie jest PBC. Jest potrzebny, bo bez kompletnego kontraktu
artefaktow GPU nie da sie pozniej bezpiecznie rozszerzyc na PBC.

### Release 3: GPU k=0 PBC

Dopiero po Release 1 i Release 2:

- static-periodic tangent projection w CUDA driven-response operatorze,
- walidacja `mesh.periodic_node_pairs` w payloadzie GPU,
- diagnostics z `static_periodic_*`,
- CPU/GPU parity dla k=0 PBC,
- dopiero wtedy capability matrix moze pokazac GPU static-periodic jako
  executable.

## Zrodla prawdy

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/architecture/backend-golden-masterplan.md`
- `justfile`

Jesli zmieniamy semantyke fizyczna, najpierw aktualizujemy `docs/physics/*`.
Jesli zmieniamy status lane'a, aktualizujemy `docs/specs/capability-matrix-v0.md`.
Jesli zmieniamy zasoby przegladarki, aktualizujemy OpenAPI v2, facade, hooks i
testy Control Room.

## Stan bazowy z audytu

### Potwierdzone

- `cargo +nightly test -p fullmag-runner --features fem-gpu --no-default-features production_gpu_frequency_response_is_narrower_than_cpu_and_never_falls_back -- --nocapture`
  przechodzi.
- Test potwierdza, ze GPU frequency response jest wezszy niz CPU i nie uzywa
  dense/CPU fallbacku dla wymuszonego GPU.
- Minimalny audytowy smoke `device("gpu")`, free-boundary, no-demag zakonczyl
  run statusem `completed`, a `metadata.json` pokazal
  `execution_engine = native_fem.frequency_domain.production_gpu` oraz
  `lossy_fallback_used = false`.
- Focused UI test:
  `pnpm --dir apps/control-room test src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
  przechodzi: 252 testy.

### Blokery

- `just verify-fem-frequency-domain-runtime` obecnie odpala
  `examples/fem_frequency_response_smoke.py`, ktory authoruje periodic FMR, ale
  wygenerowana siatka nie ma `mesh.periodic_node_pairs`. Efekt:
  `spin_wave_bc.kind='periodic' requires mesh.periodic_node_pairs metadata`.
- `verify-fem-fmr-periodic-k0-runtime` jest aliasem do free-boundary demag-airbox
  example. To nie weryfikuje k=0 PBC.
- Minimalny GPU smoke nie publikuje wymaganego kontraktu:
  `response/magnetic_response_sweep.v1.json`,
  `response/magnetic_response_sweep.v2.json`,
  `response/progress.v1.json`,
  `response/diagnostics/solver.v1.json`,
  `response/frequency_points/*`,
  `response/field_payloads.zarr/*`,
  `frequency_domain/manifest.v1.json`.
- Czesc container-backed runtime recipes zostawia artefakty jako
  `nobody:nogroup`; recipes musza miec `FULLMAG_HOST_UID/GID` i `trap chown`.
- UI pokazuje frequency-response lanes, ale obecny readback nadal zaklada
  `gpu=false` dla frequency-domain response i podsumowuje glownie
  `magnetic_cpu`.

## Reguly, ktorych plan nie moze lamac

- `completed` bez kompletnego `response/*` i `frequency_domain/manifest.v1.json`
  jest niepowodzeniem, nie sukcesem.
- Hostowy `cargo`, direct binary i reczny smoke sa diagnostyka. Produkcyjny
  dowod FEM/MFEM/CUDA idzie przez container-backed `just`.
- Wymuszony GPU nigdy nie spada cicho na CPU ani dense validation.
- Static-periodic PBC na GPU pozostaje `unsupported`, dopoki CUDA operator nie
  wymusza par i test parity tego nie potwierdzi.
- Dynamic demag dla frequency-response PBC i nonzero-k Floquet pozostaja poza
  Release 1. Musza miec osobny physics note i walidacje.

## Plan wdrozenia

### M0 - Uporzadkowac recipes i dowody

Cel: testy i smoke maja mierzyc wlasciwe rzeczy.

Zmiany:

- `justfile`
  - dodac `FULLMAG_HOST_UID`, `FULLMAG_HOST_GID` i `trap chown` do wszystkich
    `verify-fem-frequency-domain-*runtime` recipes,
  - zmienic `verify-fem-fmr-periodic-k0-runtime`, zeby odpalal rzeczywisty
    periodic k=0 smoke, nie free-boundary demag-airbox,
  - rozdzielic:
    - `verify-fem-frequency-domain-cpu-free-runtime`,
    - `verify-fem-frequency-domain-static-periodic-runtime`,
    - `verify-fem-frequency-domain-gpu-free-runtime`,
    - opcjonalnie suite alias `verify-fem-frequency-domain-runtime-suite`.
- `examples/`
  - dodac albo poprawic maly `fem_frequency_response_gpu_free_smoke.py`,
  - utrzymac `fem_frequency_response_static_periodic_smoke.py` jako CPU k=0
    PBC smoke z deterministycznym meshem,
  - przeniesc duzy film z dziura do osobnego example dopiero po tym, jak mesher
    generuje periodic pairs dla geometrii z otworem.
- `scripts/verify_fem_frequency_domain_runtime_artifacts.py`
  - traktowac brak manifestu/diagnostics/progress/field payloads jako fail,
  - dodac `--require-production-gpu`,
  - dodac `--require-static-periodic`,
  - sprawdzac `validation_fallback_used=false`.

Exit gate:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-cpu-free-runtime
just verify-fem-frequency-domain-static-periodic-runtime
just verify-fem-frequency-domain-gpu-free-runtime
```

M0 jest zakonczone dopiero, gdy kazdy recipe albo przechodzi, albo failuje na
rzeczywistym kontrakcie solvera, nie na prawach plikow albo zlym przykladzie.

### M1 - Zamknac artefaktowy kontrakt `FrequencyResponse`

Cel: CPU i GPU publikuja te same zasoby, a UI nie musi zgadywac.

Zmiany:

- `crates/fullmag-runner/src/frequency_response.rs`
  - dla produkcyjnego CPU i GPU zapisac `response/diagnostics/solver.v1.json`,
    `response/progress.v1.json`, `response/magnetic_response_sweep.v1.json`,
    `response/magnetic_response_sweep.v2.json`, per-frequency point JSON i
    Zarr field payloads,
  - nie pozwolic na `status=completed`, gdy response writer nie zapisal
    wymaganych artefaktow,
  - niedostepny wymuszony GPU ma pisac diagnostics z
    `resolved_execution_lane="unavailable"` i `unsupported_reason`, jezeli
    artifact dir istnieje.
- `crates/fullmag-runner/src/artifacts.rs`,
  `crates/fullmag-runner/src/artifact_pipeline.rs`
  - utrzymac jeden writer contract dla CPU/GPU.
- `docs/specs/frequency-domain-artifacts-v2.md`
  - zaktualizowac tylko wtedy, gdy implementacja ujawnia brak w specyfikacji.

Wymagane diagnostics:

- `requested_execution_lane`,
- `resolved_execution_lane`,
- `validation_fallback_used=false`,
- `dense_block_real_solver=false`,
- `matrix_free_solver=true`,
- `krylov_solver="gmres"`,
- `operator_terms_included[]`,
- `completed_frequency_point_count`,
- residuale.

Exit gate:

```bash
python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
  --require-production-gpu \
  .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts
python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
  --require-static-periodic \
  .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts
```

### M2 - Produkcyjny CPU k=0 PBC

Cel: pierwszy dzialajacy FMR krysztalu magnonicznego.

Zmiany:

- `packages/fullmag-py`
  - Python DSL musi eksportowac i importowac:
    - `fm.FrequencyResponse`,
    - `fm.PeriodicBC(["x_faces", ...])`,
    - `frequencies_hz`,
    - `excitation_field_au_per_m`,
    - `equilibrium_source`,
    - `include_demag=false`,
    - execution intent `device("cpu", precision="double")`.
- Meshing
  - deterministyczny smoke musi miec `periodic_boundary_pairs` i
    `periodic_node_pairs`,
  - dla generowanych siatek Gmsh dodac albo naprawic ekstrakcje par, ale nie
    blokowac Release 1, jesli stabilniejszy jest explicit mesh asset.
- `crates/fullmag-plan/src/fem.rs`
  - periodic k=0 bez par ma failowac z instrukcja naprawy,
  - unknown `pair_ids`, duplikaty source/destination i zla translacja musza
    failowac przed runtime.
- `crates/fullmag-runner/src/frequency_response.rs`
  - CPU static-periodic projection musi wypelniac diagnostics:
    - `static_periodic_projection=true`,
    - `static_periodic_node_pair_count > 0`,
    - `static_periodic_frame_max_mismatch`,
    - `static_periodic_drive_max_mismatch`.

Walidacja fizyczna:

- primitive periodic cell vs explicit supercell przy `k=0`,
- `Floquet(k=0) == Periodic`,
- zerowy mismatch par dla idealnego assetu,
- finite response amplitudes,
- tolerancje zapisane w verifierze i docs.

Exit gate:

```bash
just verify-fem-frequency-domain-static-periodic-runtime
cargo +nightly test -p fullmag-plan -- periodic --no-fail-fast
cargo +nightly test -p fullmag-runner --features fem-gpu --no-default-features \
  production_cpu_frequency_response_rejects_unimplemented_physics_without_dense_fallback \
  -- --nocapture
```

### M3 - API i Control Room dla k=0 PBC

Cel: UI jest pelnoprawna powierzchnia produktu, nie tylko viewer artefaktow.
Uzytkownik ma widziec, czy stage jest gotowy do uruchomienia, dlaczego GPU/PBC
jest odrzucone, ktory punkt czestotliwosci lub mod oglada, i jaki payload jest
wyslany do 3D.

#### M3.1 - Resource-first kontrakt UI

Zasoby v2, ktore musza byc jedynym zrodlem danych:

- `/v2/sessions/current/analysis/frequency-domain/manifest.v1`
- `/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1`
- `/v2/sessions/current/analysis/frequency-response/progress.v1`
- `/v2/sessions/current/analysis/frequency-response/diagnostics/solver.v1`
- `/v2/sessions/current/analysis/frequency-response/frequency-points/{id}.v1`
- `/v2/sessions/current/meshing/mesh/periodic_pairs.v1`
- data-plane vector samples dla `analysis:frequency-response:*`
- modal data-plane samples dla `analysis:eigen:*`, jezeli FMR modal comparison
  jest aktywne.

Frontend nie moze trzymac w `status` pelnego sweepa, punktow, field payloadow
ani periodic-pair tables. `status` moze trzymac tylko ids, revisions,
capabilities, summaries i diagnostics pointers.

Pliki/warstwy:

- `crates/fullmag-api/src/router_v2/*`
  - expose manifest, sweep, progress, diagnostics, point metadata i field ids,
  - brak opcjonalnego artefaktu ma zwracac jawny 404 z diagnostyka, nie pusty
    wykres.
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
  - facade methods dla manifest/sweep/progress/diagnostics/frequency point/field
    metadata.
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
  - resource hooks z revision selectorami:
    - `useFrequencyDomainManifestResource`,
    - `useFrequencyDomainResponseSweepResource`,
    - `useFrequencyDomainResponseProgressResource`,
    - `useFrequencyResponsePointResource`,
    - `useFrequencyResponseFieldMetaResource`,
    - `useMeshPeriodicPairsResource`.
- `apps/control-room/src/kernel/api/apiPaths.ts`
  - centralne path constants; moduly nie buduja `/v2/...` stringow.

#### M3.2 - Explorer i selection model

Explorer ma prowadzic uzytkownika przez ten sam workflow, ktory ma backend:

- `study.stage.frequency_response`
- `study.stage.frequency_response.setup`
- `study.stage.frequency_response.calculation_mode`
- `study.stage.frequency_response.equilibrium`
- `study.stage.frequency_response.operator`
- `study.stage.frequency_response.boundary`
- `study.stage.frequency_response.periodic_pairs`
- `study.stage.frequency_response.k_grid`
- `study.stage.frequency_response.excitation`
- `study.stage.frequency_response.sweep`
- `study.stage.frequency_response.solver`
- `study.stage.frequency_response.outputs`
- `study.stage.frequency_response.diagnostics`
- `resources.mesh.periodic_pairs`
- `results.frequency_response.sweep`
- `results.frequency_response.frequency_points`
- `results.frequency_response.frequency_point`
- `results.frequency_response.diagnostics`
- `results.frequency_domain.fmr`
- `results.frequency_domain.fmr_modal_spectrum`
- `results.frequency_domain.fmr_response_sweep`
- `results.frequency_domain.fmr_peaks`
- `results.frequency_domain.fmr_peak`
- `results.frequency_domain.comparison`.

Selection refs musza przenosic stabilne ids:

- dla modow: `sampleIndex`, `rawModeIndex`, `branchId`, `fieldId`,
  `modeFieldResourceKey`,
- dla response point: `frequencyPointId`, `frequencyHz`, `observableId`,
  `fieldId`, `phaseRad`, `resourceRef`,
- dla peakow: `source=modal|driven`, `fieldId`, `frequencyHz`,
  `fmrPeakIndex`.

Explorer nie importuje viewportu ani charts. Przekazuje tylko selection do
kernel selection store.

#### M3.3 - Stage authoring inspector

Stage authoring zostaje w module `inspector`, slot `panel-right`. Bazowy
komponent to `FrequencyResponseStageInspector.tsx`, ale trzeba go zmienic z
read-only `FieldRow` surface w prawdziwy authoring surface, zgodny z DSL i IR.

Widoki stage inspectora:

- `setup`
  - calculation workflow: `fmr_response` teraz, `response_map` disabled,
  - backend/discretization: `fem`,
  - device/precision: `cpu|gpu`, `double`,
  - execution mode: strict dla produkcyjnego smoke,
  - readiness badge: `ready`, `missing_periodic_pairs`, `unsupported_gpu_pbc`,
    `missing_artifacts`, `stale_mesh`.
- `calculation_mode`
  - segmented control: modal FMR / driven FMR / modal+driven comparison,
  - driven FMR mapuje do `StudyIR::FrequencyResponse`,
  - modal FMR mapuje do `StudyIR::Eigenmodes`; nie wolno mieszac solverow w
    jednym stage.
- `equilibrium`
  - source: `provided`, `relax`, `artifact`,
  - artifact selector dla relax result,
  - walidacja: equilibrium musi byc statyczne i zgodne z mesh/material revision.
- `operator`
  - linearized LLG,
  - `include_demag` jako jawnie gated toggle:
    - Release 1: disabled dla PBC response,
    - GPU/free: disabled,
    - enabled tylko gdy runtime/capability to wspiera.
  - DMI/magnetoelastic pokazane jako unsupported, nie ukryte.
- `boundary`
  - segmented control: `free`, `periodic`, `floquet` disabled for response,
  - dla `periodic`: wymagane `pair_ids`,
  - badge: CPU static-periodic available / GPU static-periodic unavailable.
- `periodic_pairs`
  - tabela z `periodic_pairs.v1`: `pair_id`, source/destination markers,
    translation, paired count, unpaired counts, max residual, validation status,
  - selector `pair_ids` dla stage,
  - error state, gdy selected pair nie istnieje albo residual przekracza
    tolerancje.
- `k_grid`
  - Release 1: locked `k=0`,
  - nonzero-k response disabled z linkiem do capability reason,
  - Floquet phase convention pokazany jako read-only reference.
- `excitation`
  - vector input `excitation_field_au_per_m` w A/m,
  - phase input `phase_rad`,
  - tangent projection preview i validation nonzero drive.
- `sweep`
  - lista Hz, range builder, deduplication preview,
  - count i estimated artifact count,
  - validation positive finite frequencies.
- `solver`
  - requested/resolved lane preview,
  - GMRES tolerance/max iterations jezeli IR/API je expose,
  - `validation_fallback_used=false` jako hard gate dla production lane.
- `outputs`
  - required: `susceptibility_tensor`, response amplitude/phase, response field
    payload,
  - optional: absorbed power tylko gdy backend publikuje observable,
  - output readiness pokazuje, czy 3D overlay bedzie mozliwy.
- `diagnostics`
  - planner reasons,
  - capability matrix status,
  - expected artifact checklist,
  - runtime stop reason po runie.

Kontrolki:

- segmented controls, selects, switches, checkboxes, number inputs i tables
  musza uzywac shared primitives/shadcn-style UI,
- stage draft zyje tylko jako inspector draft,
- commit idzie przez canonical model/study transaction albo istniejacy
  `onCommit`; zadna lokalna fizyka nie moze byc osobnym zrodlem prawdy,
- run idzie przez command registry (`study.run` albo dedicated frequency
  response command), nie callback laczacy inspector z runtime modulem.

#### M3.4 - Result inspectors

Result readback zostaje oddzielony od stage authoring. Gdy stage jest zapisany
i runtime publikuje artefakty, inspector ma dedykowane surfaces:

- `FrequencyResponseStudyInspectorPanel`
  - canonical study kind, requested/resolved lane, boundary support, artifact
    readiness, physics contract.
- `FrequencyResponseSweepInspectorPanel`
  - sweep summary, frequency range, solved/failed points, observable series,
    local maxima.
- `FrequencyResponseFrequencyPointsInspectorPanel`
  - tabela punktow: index/id, frequency, status, amplitude, phase, residual,
    `fieldId`, action `select`, action `plot in 3D`.
- `FrequencyResponsePointInspectorPanel`
  - point metadata, solver residual, payload paths, response vector availability,
    phase controls.
- `FrequencyResponseDiagnosticsInspectorPanel`
  - `requested_execution_lane`, `resolved_execution_lane`,
    `validation_fallback_used`, `matrix_free_solver`, `krylov_solver`,
    `operator_terms_included`, static-periodic diagnostics.
- `FrequencyDomainPeriodicPairsResourceInspectorPanel`
  - mesh pair diagnostics from `useMeshPeriodicPairsResource`.
- `FmrOverviewInspectorPanel`
  - combined workbench: modal spectrum preview, driven response preview, peak
    snapshot, modal-vs-driven comparison.

Kazdy selection kind z `inspectorRegistry.tsx` musi miec dedykowany panel. Brak
panelu dla nowego kind jest failing test, nie fallback do generic inspector.

#### M3.5 - Wykresy i analysis-plots

Inspector moze miec male preview charts, ale pelny charting ma byc w
`analysis-plots` jako center surface, slot `viewport-main` albo `panel-bottom`.

Chart model:

- `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`
  buduje:
  - modal spectrum,
  - response sweep,
  - FMR peaks,
  - modal-vs-driven comparison,
  - future response map.
- `magnetic_response_sweep.v2` jest preferowanym zrodlem driven response.
  `v1` jest compatibility path.
- Chart series ids zawieraja resource identity, stage/run id, observable i
  frequency point id.

Wymagane wykresy:

- FMR response sweep: amplitude/susceptibility/absorbed-power gdy dostepne,
- phase plot dla selected observable,
- peak table z local maxima,
- modal spectrum overlay dla porownania z eigenmodes,
- modal-vs-driven detuning table,
- diagnostics mini-chart: residual vs frequency, iterations vs frequency.

Interakcje:

- click na punkt sweepa ustawia `results.frequency_response.frequency_point`,
- double click albo button `Plot in 3D` odpala command registry,
- brush/zoom zostaje lokalnym state chart module i nie mutuje resource,
- chart nie importuje `viewport-3d` ani jego store.

Lifecycle:

- ECharts/SVG instance dispose on unmount,
- chart updates nie robia dirty renderu 3D,
- analysis-plots unmountuje sie po zmianie center tab zgodnie z viewport spec.

#### M3.6 - Wybor modow i punktow do wizualizacji 3D

3D handoff musi isc przez command registry i `AnalysisFieldOverlayController`,
nie przez bezposredni import viewportu.

Dla modow eigen:

- z chart/table wybieramy `results.eigen.mode`,
- selection niesie `sampleIndex`, `rawModeIndex`, opcjonalnie `branchId`,
  `fieldId`, `modeFieldResourceKey`,
- command:
  - `analysis.eigen.plot-mode-3d`,
  - payload: `fieldId`, `label`, `phaseRad`, `source="eigen-mode"`,
    `view="phase_rotated_real"`.

Dla driven response:

- z chart/table wybieramy `results.frequency_response.frequency_point`,
- selection niesie `frequencyPointId`, `frequencyHz`, `observableId`,
  `fieldId`, `phaseRad`, `resourceRef`,
- commands:
  - `analysis.frequency-response.plot-response-field-3d`,
  - `analysis.frequency-response.plot-response-field-3d-real`,
  - `analysis.frequency-response.plot-response-field-3d-imag`,
  - `analysis.frequency-response.plot-response-field-3d-abs`,
  - `analysis.frequency-response.plot-response-field-3d-phase`,
  - `analysis.frequency-response.plot-response-field-3d-phase-rotated-real`.

Overlay controls:

- phase slider: `analysis.frequency-domain.set-3d-phase`,
- phase animation: `analysis.frequency-domain.set-3d-animation`,
- stop animation: `analysis.frequency-domain.stop-3d-animation`,
- appearance: `analysis.frequency-domain.set-3d-appearance`,
- clear overlay: `analysis.frequency-domain.clear-3d-overlay`.

Viewport behavior:

- `viewport-3d` laduje pole przez data-plane field samples dla `fieldId`,
  nie przez status ani manifest,
- `phase_rotated_real`, `real`, `imag`, `abs`, `phase` sa projekcjami widoku,
  nie osobnymi zasobami fizycznymi,
- response field overlay ma pokazac label: source, frequency, observable,
  phase/view,
- jesli field payload nie istnieje, action jest disabled z reason,
- zmiana phase/view aktualizuje uniforms/buffers overlay, nie przeladowuje
  topology,
- overlay cleanup nastepuje przy clear, zmianie sesji, invalidacji field
  resource albo unmount `viewport-3d`.

Browser acceptance:

- select mode -> plot 3D mode field -> canvas nonblank,
- select response point -> plot 3D response field -> canvas nonblank,
- set phase -> visible field changes without topology reload,
- animate phase -> dirty-driven animation only while active,
- switch to analysis-plots tab -> `viewport-3d` unmounted, no WebGL leak.

#### M3.7 - Statusy i teksty gotowosci

UI musi uzywac roznych stannow, nie jednego `ok`:

- `ready`
- `running`
- `completed`
- `partial_artifacts`
- `missing_artifacts`
- `missing_periodic_pairs`
- `unsupported_gpu_pbc`
- `unsupported_nonzero_k`
- `unsupported_demag`
- `stale_mesh`
- `stale_equilibrium`
- `error`

Kazdy disabled control musi miec reason:

- forced GPU + PBC: static-periodic projection unavailable on GPU,
- PBC bez pairs: missing `mesh.periodic_node_pairs`,
- demag + response PBC: dynamic frequency-response demag unavailable,
- nonzero-k response: Floquet/Bloch driven response unavailable,
- no field payload: 3D overlay unavailable until response field payload exists.

#### M3.8 - Testy UI/API

Exit gate:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx
pnpm --dir apps/control-room test src/shared/domain/analysis/frequencyDomainChartModels.test.ts
pnpm --dir apps/control-room test src/kernel/visualization/analysisFieldOverlayCommandContributions.test.ts
pnpm --dir apps/control-room test src/kernel/visualization/AnalysisFieldOverlayPhaseAnimation.test.ts
pnpm --dir apps/control-room test src/modules/analysis-plots
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
```

Source hygiene:

```bash
rg "fetch\\(" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src --glob '!src/kernel/api/generated/**'
```

Browser smoke dla closure:

```bash
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:analysis-plots

CONTROL_ROOM_SCREENSHOT_SCENES=fdm \
CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room screenshot:viewport-3d
```

Dodac dedicated smoke/fixture dla:

- `.fullmag/reports/frequency-domain-static-periodic-runtime`,
- `.fullmag/reports/frequency-domain-gpu-free-runtime`,
- action path: select response point -> plot 3D -> set phase -> animate -> clear.

### M4 - Produkcyjny GPU gamma/free

Cel: GPU frequency response jest kompletny dla wspieranego zakresu.

Zakres:

- `device("gpu")`,
- gamma/free,
- `include_demag=false`,
- no DMI,
- no PBC,
- `validation_fallback_used=false`,
- kompletne response artifacts.

Zmiany:

- `backends/fem/gpu/cuda/frequency_domain/*`
  - operator application musi miec jawne wlascicielstwo CUDA lane,
  - bez ukrytych host sync w hot loop poza kontrolowanymi diagnostics.
- `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
  - payload i native request musza zachowac requested/resolved lane.
- `crates/fullmag-runner/src/frequency_response.rs`
  - GPU payload builder ma failowac na PBC/demag/DMI z konkretnym reason,
  - successful GPU run musi emitowac response artifacts z M1.

Exit gate:

```bash
just verify-fem-frequency-domain-gpu-free-runtime
cargo +nightly test -p fullmag-runner --features fem-gpu --no-default-features \
  production_gpu_frequency_response_is_narrower_than_cpu_and_never_falls_back \
  -- --nocapture
```

Promocja capability:

- GPU gamma/free moze byc `production_executable`, gdy runtime recipe przejdzie
  z artefaktami.
- Nie wolno oznaczac jako `validated`, dopoki nie ma parity/benchmarku z CPU
  dla co najmniej jednego analitycznie kontrolowanego przypadku.

### M5 - GPU k=0 PBC

Cel: rozszerzyc GPU na static-periodic driven response po zamknieciu CPU i
GPU/free.

Warunki startu:

- M1, M2, M4 zakonczone,
- CPU static-periodic ma artifact-backed validation,
- GPU/free ma artifact-backed validation,
- capability matrix nadal mowi, ze GPU PBC jest unsupported.

Zmiany:

- `backends/fem/gpu/cuda/frequency_domain/*`
  - static-periodic tangent projection,
  - pair-aware gather/scatter albo constrained DOF map,
  - drive vector projection zgodny z CPU,
  - diagnostics mismatch par.
- `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys`
  - ABI dla periodic pairs tylko jesli obecny payload nie wystarcza.
- `crates/fullmag-runner/src/frequency_response.rs`
  - budowa GPU payloadu z `static_periodic_node_pairs`,
  - reject na brak/duplikaty/zly residual par.
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`
  - zaktualizowac backend interpretation i validation limits.
- `docs/specs/capability-matrix-v0.md`
  - zmienic GPU static-periodic dopiero po przejsciu testow.

Walidacja:

- CPU/GPU parity dla identycznego mesh assetu i `x_faces`,
- primitive periodic cell vs supercell,
- zero/finiteness seam mismatch,
- `validation_fallback_used=false`,
- brak CPU response path w forced GPU.

Exit gate:

```bash
just verify-fem-frequency-domain-gpu-static-periodic-runtime
cargo +nightly test -p fullmag-runner --features fem-gpu --no-default-features \
  static_periodic_gpu_frequency_response_matches_cpu_reference \
  -- --nocapture
```

### M6 - Dokumentacja i release gate

Cel: stan produkcyjny jest utrzymywany przez CI i dokumentacje.

Wymagane aktualizacje:

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/resource-first-control-room-api-v2.md`, jesli endpointy lub
  payloady sie zmieniaja,
- examples README albo docs user-facing dla FMR k=0 PBC.

Release gate:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime-suite
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
```

Jesli pelny frontend suite ma pre-existing failures, closure wymaga:

- liste unrelated failures z aktualnego `git status`,
- focused tests dla zmienionych warstw,
- osobny follow-up issue/plan dla pozostalych failures.

## Kryteria 100% dla celu uzytkownika

Minimum produkcyjne dla FMR k=0 PBC:

- Python example `fem_frequency_response_static_periodic_smoke.py` przechodzi
  przez managed `just` recipe.
- Artefakty zawieraja manifest, sweep v1/v2, progress, solver diagnostics,
  frequency point JSON, Zarr response fields i periodic pair diagnostics.
- Verifier wymusza static-periodic diagnostics i nie akceptuje pustych wynikow.
- UI pokazuje gotowosc periodic pairs, lane CPU static-periodic, sweep, peaks,
  selectable frequency points, selectable modal modes, action `Plot in 3D`,
  phase/view controls i 3D overlay z data-plane field payloadow.
- Browser smoke potwierdza: select mode -> plot 3D, select response point ->
  plot 3D, set phase, animate phase, clear overlay, switch tab bez WebGL leak.
- Export/round-trip zachowuje `FrequencyResponse` i `PeriodicBC`.
- GPU static-periodic jest w UI opisane jako unavailable, chyba ze M5 zostal
  zakonczony.

Minimum produkcyjne dla GPU frequency response:

- Managed GPU recipe przechodzi.
- `response/diagnostics/solver.v1.json` ma
  `requested_execution_lane=production_gpu`,
  `resolved_execution_lane=production_gpu`,
  `validation_fallback_used=false`.
- Manifest i response artifacts sa kompletne.
- UI pokazuje GPU gamma/free jako osobny supported lane.
- PBC/demag/DMI/nonzero-k forced GPU odrzucaja z czytelnym reason i bez
  fallbacku.

Pelny produkcyjny GPU k=0 PBC:

- M5 exit gate przechodzi.
- Capability matrix promuje GPU static-periodic z jasnym statusem.
- Control Room pokazuje GPU static-periodic jako available tylko na podstawie
  manifest/capability payloadu z runtime, nie na podstawie hardcoded UI.

## Najblizszy konkretny krok

Zaczac od M0 i M1:

1. naprawic `justfile` recipes i ownership traps,
2. dodac prawdziwy `verify-fem-frequency-domain-gpu-free-runtime`,
3. sprawic, ze GPU/free `completed` publikuje pelne `response/*` i
   `frequency_domain/manifest.v1.json`,
4. dopiero potem domknac CPU k=0 PBC jako pierwszy uzywalny workflow dla
   krysztalu magnonicznego.
