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
- ten sam kontrakt artefaktow co CPU.

Ten release nie jest PBC. Jest potrzebny, bo bez kompletnego kontraktu
artefaktow GPU nie da sie pozniej bezpiecznie rozszerzyc na PBC.

### Release 3: GPU k=0 PBC

Po Release 1 i Release 2 trzeba zamknac osobny static-periodic GPU gate:

- static-periodic tangent projection w CUDA driven-response operatorze,
- walidacja `mesh.periodic_node_pairs` w payloadzie GPU,
- diagnostics z `static_periodic_*`,
- managed runtime gate `just verify-fem-frequency-domain-gpu-static-periodic-runtime`,
- capability matrix moze pokazac GPU static-periodic jako executable dopiero
  dla k=0 no-demag static-periodic magnetic slice.

CPU/GPU parity dla k=0 PBC pozostaje osobnym validation gate. Dopoki go nie
ma, status moze byc `partial_production_executable`, ale nie `validated`.

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
- Static-periodic PBC na GPU moze byc `partial_production_executable` tylko
  dla k=0 no-demag magnetic response, gdy CUDA operator wymusza pary, managed
  runtime gate przechodzi i provenance pokazuje brak fallbacku. Parity test
  jest wymagany przed statusem `validated`.
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

### M3 - API i Control Room dla FMR k=0 PBC

Cel: Control Room ma byc produkcyjnym workflow authoring -> run -> analysis dla
FMR k=0 PBC. To nie moze byc viewer plikow JSON ani drugi, lokalny model
fizyki. Uzytkownik ma widziec:

- stage i canonical `StudyIR`, ktory zostanie zapisany,
- gotowosc `fem/cpu/double/periodic/k=0/include_demag=false`,
- explicit reason dla GPU static-periodic/PBC readiness, nonzero-k, demag i
  single precision,
- requested intent oraz resolved runtime reality,
- sweep, peak table, modal spectrum i diagnostics,
- aktualnie wybrany mode, peak albo frequency point,
- czy wybrany wynik ma data-plane field payload dla 3D,
- aktualna projekcje kompleksowego pola: `real`, `imag`, `abs`, `phase`,
  `phase_rotated_real`.

Granica architektoniczna:

- `inspector` w slocie `panel-right` odpowiada za stage authoring oraz
  read-only inspectors.
- `analysis-plots` w slocie `viewport-main` albo `panel-bottom` odpowiada za
  pelne wykresy i tabele analityczne.
- `viewport-3d` w slocie `viewport-main` pozostaje jedynym wlascicielem WebGL.
- Explorer publikuje tylko selection refs i command intents.
- Mutacje study ida przez canonical model transaction.
- Wyniki ida przez resource hooks i shared read models.
- 3D handoff idzie tylko przez command registry i
  `AnalysisFieldOverlayController`.

Moduly i sloty objete M3:

| Module | Slot | FMR responsibility | Must not own |
|---|---|---|---|
| `explorer` | `panel-left` | workflow tree, resource/result nodes, serializable selection refs | stage drafts, chart state, field payloads |
| `inspector` | `panel-right` | stage authoring, read-only resource/result inspectors, readiness reasons | full chart layout, WebGL, direct transport |
| `analysis-plots` | `viewport-main` or `panel-bottom` | FMR overview, sweep charts, modal spectrum, comparison, diagnostics tables | stage mutation, viewport renderer state |
| `viewport-3d` | `viewport-main` | magnetic mesh plus field overlays from `AnalysisFieldDisplayIntent` | stage drafts, result parsing, chart state |
| `ribbon` | `ribbon` | command registry rendering for Author/Plan/Run/Analysis/View groups | physics-specific state |
| `status-bar` | `status-bar` | compact session/backend/revision/runtime status | heavy diagnostics or sweep payloads |

Current implementation boundary:

- `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx`
  is an interim aggregate surface. It may stay as a compatibility router during
  migration, but it must not grow new authoring logic, chart option logic or
  viewport coupling.
- `apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx`
  is the stage-authoring target. New editable stage controls go there or into
  its section components, not into result inspectors.
- `apps/control-room/src/modules/inspector/panels/frequency-domain/*` is the
  target home for read-only result/resource inspectors. New dedicated panels
  should be created there instead of adding more selection branches to the
  aggregate panel.
- `apps/control-room/src/modules/analysis-plots/*` already owns ECharts
  lifecycle and analysis chart state. Frequency-domain charts must extend that
  module and its shared adapters; inspectors may link to charts or show compact
  previews, but they must not duplicate chart engines.
- `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`
  and `analysisFieldOverlayCommandContributions.ts` are the current command
  path for mode/response overlays. New mode, point and peak plotting must widen
  this command path instead of introducing inspector-to-viewport callbacks.

UI implementation doctrine:

- Stage authoring, result inspection, charting and 3D visualization are four
  separate workflows connected by selection refs and commands. They must not be
  collapsed into one "FMR panel".
- The shared object between these workflows is a serializable selection ref or
  command payload, never a React component prop chain and never a mutable
  "current FMR result" singleton.
- `inspector` renders compact, task-focused controls for the selected tree
  node. It may show small sparklines/previews, but it does not own full chart
  layout or WebGL resources.
- `analysis-plots` renders the full analytical surfaces: sweep, modal spectrum,
  peak tables, comparison and diagnostics. It selects resources and dispatches
  commands; it does not mutate stages.
- `viewport-3d` renders only display intents backed by data-plane field
  payloads. It never reads stage drafts and never infers physics settings from
  chart state.
- Explorer nodes are navigation and selection only. A node must not encode UI
  component state, resource payloads, chart zoom, phase animation or viewport
  renderer state.
- Every disabled command/control must expose a machine-readable reason from
  capabilities/resources, not a hardcoded prose-only message.
- Lane availability is capability/resource driven. Pre-M5 UI may show GPU
  static-periodic as unsupported, but after M5 it must become available only
  from runtime/capability payloads for `production_gpu + static_periodic +
  include_demag=false`; nonzero-k Floquet/Bloch and dynamic demag remain
  separate unsupported reasons until their own gates close.

First implementation target:

```text
Explorer selection ref
  -> inspectorRegistry explicit panel dispatch
  -> resource hooks / stage resource
  -> pure view model
  -> shared UI primitives
  -> command registry for mutation/run/plot actions
```

Forbidden first implementation target:

```text
Explorer selection ref
  -> generic JSON/result panel
  -> component-local fetch
  -> direct viewport callback
  -> hidden local stage model
```

Minimum user workflow that M3 must make possible:

```text
Select frequency-response stage
  -> edit canonical stage parameters in the right inspector
  -> validate readiness from capabilities/resources
  -> commit the draft through model transaction
  -> run the stage through command registry
  -> inspect manifest/progress/diagnostics/sweep resources
  -> open FMR overview / sweep / modal spectrum charts
  -> select a response point, eigen mode or peak
  -> plot the linked field in 3D through a display intent
  -> change projection/phase/animation without changing physics artifacts
```

The UI is production-ready only if each arrow above has a typed data contract,
an explicit disabled/error state, and a focused test. A screenshot or a green
status badge without these contracts is not enough.

M3 build units:

| Unit | Primary files | First RED test | Exit gate |
|---|---|---|---|
| Resource contract | API/OpenAPI/facade/resource hooks | missing/partial/stale resource fixture | hooks expose typed state without component `fetch()` |
| Explorer selections | `frequencyDomainExplorerNodes.ts`, `selectionTypes.ts` | every authoring/resource/result node serializes | no FMR node falls to generic selection |
| Stage inspector model | `frequencyResponseStageModel.ts` | draft init, validation and commit patch snapshots | no runtime/readback/display fields enter `StudyIR` |
| Stage inspector UI | `FrequencyResponseStageInspector.tsx` and section components | controlled input and stale-revision tests | commit/run state matches validation and capabilities |
| Read-only inspectors | `panels/frequency-domain/*` | registry rejects missing panel | each result/resource kind has a dedicated panel and non-happy state |
| Chart models | `frequencyDomainChartModels.ts` | empty/partial/stale/duplicate/peak fixtures | charts consume immutable read models only |
| Analysis plots | `modules/analysis-plots/*` | point/mode/peak selection dispatch tests | chart state is local and never mutates stage |
| 3D display intent | overlay commands/controller | field meta missing/stale/projection tests | viewport receives display intent only through command registry |
| Browser workflow | Playwright/smoke fixtures | mode/point plot path and WebGL lifecycle | nonblank canvas, no hidden WebGL mount, no overlapping controls |

Implementation rule: each build unit lands with its model test before React UI.
React components render already-normalized view models and dispatch commands;
they do not parse artifacts, infer capabilities or construct API paths.

M3 ownership map:

| Workflow concern | UI owner | Canonical data owner | State category | Commit or command path |
|---|---|---|---|---|
| stage parameters | `inspector` stage panel | study/stage model resource | inspector draft state | `model.commitTransaction(...)` |
| stage readiness | `inspector` stage panel | status/capability/mesh/resources | derived read model | no mutation; run command gating only |
| periodic pair inspection | read-only inspector | meshing periodic-pairs resource | server resource snapshot | selection/resource refresh only |
| sweep and point inspection | read-only inspector + `analysis-plots` | analysis response resources | immutable result read model | selection or export commands |
| modal mode inspection | read-only inspector + `analysis-plots` | eigenmode resources | immutable result read model | selection or plot commands |
| FMR peaks/comparison | `analysis-plots` + read-only inspector | peak model derived from analysis resources | chart-local view state + immutable model | selection/export/plot commands |
| 3D mode/point/peak overlay | `viewport-3d` + overlay controller | field meta + binary data-plane resources | display intent and renderer resources | command registry only |
| chart zoom/sort/pins | `analysis-plots` | none; user display preference | module-local UI state | no backend mutation |
| projection/phase/appearance | overlay controller / `viewport-3d` | none; display over existing field | display intent | no stage/artifact mutation |

M3 execution principle:

1. Build or widen the resource contract first.
2. Build a pure read/draft model with fixtures.
3. Add explicit Explorer selection refs and inspector registry routing.
4. Render the inspector/chart/viewport control as a thin UI over that model.
5. Wire actions through `commitTransaction` or the command registry.
6. Add focused tests for the happy path and at least one unavailable/stale
   path before browser smoke.

No M3 UI slice is accepted if it only renders a local mock. It must either use
the real resource hook/facade contract or carry a named fixture path and a
removal condition before the next slice starts.

#### M3.0 - Release 1 UI contract

Release 1 UI wspiera:

- FEM CPU, `double`, `bc=periodic`, `k=0`, `include_demag=false`,
  magnetic mesh,
- periodic pair readiness i stale mesh detection,
- driven response sweep z point table,
- modal spectrum tylko gdy modal artifacts sa dostepne,
- modal-vs-driven comparison tylko gdy oba result families sa dostepne,
- 3D plotting tylko gdy field meta i data-plane payload sa dostepne,
- GPU gamma/free jako supported lane dopiero po M4,
- GPU static-periodic/PBC jako capability-gated lane: unavailable przed M5,
  available po M5 tylko dla `k=0`, static-periodic pairs, no-demag i
  `production_gpu` bez fallbacku.

Zakazane uproszczenia:

- direct `fetch()` w komponentach,
- module-local stringi `/v2/...`,
- pelny sweep, periodic pair table, diagnostics albo field samples w
  `/status`,
- callback z inspectora/charta bezposrednio do viewportu,
- generic frequency-domain inspector dla wszystkich result kinds,
- local physics stage state niezalezny od Python DSL/ProblemIR,
- chart importujacy `viewport-3d` store/component,
- ukrywanie unsupported controls bez reason,
- traktowanie `completed` run jako dowodu, ze artifacts i field payload sa
  kompletne.

Canonical UI reason ids:

| Reason id | Used by | Meaning |
|---|---|---|
| `missing_periodic_pairs` | stage inspector, periodic-pairs inspector, run command | selected periodic boundary has no current pair resource |
| `stale_periodic_pairs` | stage inspector, periodic-pairs inspector | pair resource revision does not match current mesh/stage revision |
| `gpu_static_periodic_unavailable` | stage inspector, capability viewer, run command | production GPU static-periodic lane has not reached M5 evidence |
| `gpu_static_periodic_requires_no_demag` | stage inspector, run command | GPU static-periodic release lane is only valid with `include_demag=false` |
| `dynamic_demag_pbc_unavailable` | operator section, diagnostics panel | periodic dynamic demag frequency response is not production-ready |
| `floquet_bloch_nonzero_k_unavailable` | boundary/k-grid section, charts, result panels | nonzero-k Floquet/Bloch response remains unsupported |
| `single_precision_unqualified` | setup section, capability viewer | single precision lacks qualification evidence |
| `validation_fallback_forbidden` | solver section, diagnostics panel, chart markers | strict production run would rely on validation fallback |
| `partial_artifacts` | result inspectors, charts | manifest/progress exists but one or more required result resources are missing |
| `missing_field_payload` | point/mode/peak inspectors, charts, 3D commands | numeric result exists but no data-plane field payload is available |
| `stale_field_revision` | 3D commands, viewport overlay | field meta/payload revision no longer matches selected result |
| `webgl_unavailable` | 3D command result, viewport overlay | display path cannot create a valid WebGL canvas/context |

These ids must appear in fixtures/tests. Human text may be localized later, but
tests and command payloads assert the reason id, source resource and affected
selection ref.

#### M3.1 - Resource-first API dla UI

HTTP v2 jest zrodlem snapshotow, websocket sluzy do invalidation/eventow.
Status niesie tylko ids, revisions, capability summary i pointers.

Wymagane JSON resources. Docelowa rodzina dla driven response to
`analysis/frequency-domain/response/...`; nie dodawac drugiej rownoleglej
rodziny `analysis/frequency-response/...` poza krotkotrwalym aliasem z
removal criteria, jezeli obecny backend jeszcze go wymaga:

| Resource | Canonical path | Owner | Required fields |
|---|---|---|---|
| manifest | `/v2/sessions/current/analysis/frequency-domain/manifest.v1` | analysis | result families, artifact refs, lane, run/stage ids |
| response sweep | `/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep.v1` | analysis | points, observables, revisions, field refs, readiness |
| progress | `/v2/sessions/current/analysis/frequency-domain/response/progress.v1` | analysis | completed/failed point counts, current point, stop reason |
| solver diagnostics | `/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1` | diagnostics | requested/resolved lane, fallback flags, residuals, solver phases |
| frequency point | `/v2/sessions/current/analysis/frequency-domain/response/frequency-points/{frequency_index}` | analysis | frequency Hz, observable rows, field refs, point diagnostics |
| response field meta | `/v2/sessions/current/analysis/frequency-domain/response/field/{frequency_index}/meta` | data/analysis bridge | field id, basis, component layout, data-plane key, revision |
| modal spectrum | `/v2/sessions/current/analysis/eigenmodes/spectrum` | analysis | eigen frequencies, damping, mode refs, readiness |
| modal mode | `/v2/sessions/current/analysis/eigenmodes/modes/{mode_id}` | analysis | mode metadata, branch/sample ids, field refs |
| modal field meta | `/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta` | data/analysis bridge | field id, basis, data-plane key, revision |
| periodic pairs | `/v2/sessions/current/meshing/mesh/periodic_pairs.v1` | meshing | pair ids, axis/frame diagnostics, mesh revision, stale reason |

Wymagane binary/data-plane resources:

- vector samples dla `analysis:frequency-response:*`,
- modal field samples dla `analysis:eigen:*`,
- complex XYZ layout z jawna basis metadata,
- field revision/ETag compatible z manifest/sweep revision.

Kazdy resource musi miec:

- `resource_id`, `revision`, `session_generation`,
- `run_id`, `stage_id`, gdy dotyczy,
- `schema_version`,
- machine-readable `readiness`,
- `missing_reason` albo `unsupported_reason`, gdy nie jest `ready`.

Warstwy do zmiany w jednym slice:

| Warstwa | Pliki | Wymaganie |
|---|---|---|
| API routes | `crates/fullmag-api/src/router_v2/*` | endpoints dla manifest, sweep, progress, diagnostics, point, field meta, periodic pairs |
| OpenAPI | `crates/fullmag-api/src/openapi_v2.rs` | schemas dla wszystkich resources i error reasons |
| Generated frontend | `apps/control-room/src/kernel/api/generated/*` | regenerated after API change |
| Facade | `apps/control-room/src/kernel/api/ControlRoomApi.ts` | domain methods, no physics logic in generated client |
| Paths | `apps/control-room/src/kernel/api/apiPaths.ts` | jedyne reczne constants dla v2 paths |
| Hooks | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` albo dedicated analysis resource file | revision-aware resource hooks |

Required hooks:

- `useFrequencyDomainManifestResource`
- `useFrequencyResponseSweepResource`
- `useFrequencyResponseProgressResource`
- `useFrequencyResponseSolverDiagnosticsResource`
- `useFrequencyResponsePointResource`
- `useFrequencyResponseFieldMetaResource`
- `useFrequencyDomainEigenSpectrumResource`
- `useFrequencyDomainEigenModeResource`
- `useFrequencyDomainEigenModeFieldMetaResource`
- `useMeshPeriodicPairsResource`

Exit criteria M3.1:

- missing artifact daje typed `404`/resource state, nie throw w komponencie,
- `partial_artifacts` jest osobnym stanem,
- stale revisions sa widoczne w hook state,
- `rg "fetch\\(" apps/control-room/src` nie pokazuje nowych component fetchy,
- `rg '"/v2/' apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'`
  nie pokazuje nowych module-local endpoints.
- test OpenAPI/facade wymusza jedna canonical path dla response resources, a
  ewentualne aliasy maja explicit deprecation/removal note.

#### M3.2 - Explorer taxonomy i selection refs

Explorer ma byc mapa workflow, nie lista plikow. Node kinds:

| Grupa | Node kinds |
|---|---|
| Authoring | `study.stage.frequency_response`, `.setup`, `.calculation_mode`, `.equilibrium`, `.operator`, `.boundary`, `.periodic_pairs`, `.k_grid`, `.excitation`, `.sweep`, `.solver`, `.outputs`, `.diagnostics` |
| Resources | `resources.mesh.periodic_pairs`, `resources.frequency_domain.manifest`, `resources.frequency_response.sweep`, `resources.frequency_response.progress`, `resources.frequency_response.solver_diagnostics`, `resources.frequency_response.frequency_point`, `resources.frequency_response.field` |
| Results | `results.frequency_response.sweep`, `results.frequency_response.frequency_points`, `results.frequency_response.frequency_point`, `results.frequency_response.field`, `results.frequency_response.diagnostics`, `results.eigen.mode`, `results.frequency_domain.fmr`, `results.frequency_domain.fmr_modal_spectrum`, `results.frequency_domain.fmr_response_sweep`, `results.frequency_domain.fmr_peaks`, `results.frequency_domain.fmr_peak`, `results.frequency_domain.comparison` |

Selection refs sa serializowalne i nie zawieraja React state:

| Selection | Required fields |
|---|---|
| stage section | `stageId`, `stageKind`, `section`, `draftRevision` |
| periodic pair | `meshId`, `meshRevision`, `pairSetId`, `pairId` |
| response sweep | `runId`, `stageId`, `sweepResourceId`, `revision` |
| response point | `runId`, `stageId`, `frequencyPointId`, `frequencyHz`, `observableId`, `fieldId`, `resourceRef` |
| response field | `runId`, `stageId`, `fieldId`, `fieldRevision`, `basis`, `resourceRef` |
| eigen mode | `runId`, `stageId`, `sampleIndex`, `rawModeIndex`, optional `branchId`, `fieldId`, `modeFieldResourceKey` |
| FMR peak | `runId`, `stageId`, `source`, `frequencyHz`, `fmrPeakIndex`, optional `fieldId`, optional `peakFitId` |

Files:

- `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
  builds nodes and refs only.
- `apps/control-room/src/kernel/selection/selectionTypes.ts` owns shared
  selection type additions.
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` maps every
  kind explicitly.

Acceptance:

- tree builder test covers every node kind above,
- registry test fails if any frequency-domain kind falls to generic fallback,
- Explorer never imports `analysis-plots` or `viewport-3d`.

#### M3.3 - Four UI contracts that must not mix

M3 implementation uses four contracts:

| Model | Source | Owner | Mutable | Purpose |
|---|---|---|---|---|
| `FrequencyDomainSelectionRef` | Explorer/chart/inspector/ribbon action | kernel selection store | selection only | serializable identity for stage section, resource, result, point, mode or peak |
| `FrequencyResponseStageDraft` | committed study/stage document | `inspector` stage authoring | yes | canonical stage edits and commit patch |
| `FrequencyDomainResultReadModel` | manifest, sweep, progress, diagnostics, field meta, periodic pairs | resource hooks + shared domain adapters | no | readback/provenance/charts/tables |
| `AnalysisFieldDisplayIntent` | selection + command input + field meta | command registry + overlay controller | display only | 3D projection/phase/appearance/animation |

Rules:

- Selection ref never contains resource payloads, chart state, decoded fields or
  React-local state. It carries ids, revisions and enough provenance to refetch.
- Stage draft never initializes physics values from last result artifact.
- Result read model never writes stage params.
- Display intent never creates physical artifacts or mutates `fieldId`.
- Selection may connect stage, result, charts and 3D, but ownership stays
  separate and every transition is visible as either selection update or
  command dispatch.

Files:

- `apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx`
  renders stage authoring.
- `apps/control-room/src/modules/inspector/panels/stages/frequencyResponseStageModel.ts`
  builds draft, validation, commit patch and command enablement.
- `apps/control-room/src/modules/inspector/panels/frequency-domain/*`
  contains read-only result/resource inspectors.
- `apps/control-room/src/shared/domain/analysis/frequencyDomainReadModels.ts`
  builds result read models.
- `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`
  builds chart models only.
- `apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts`
  registers plot/phase/appearance commands.
- `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`
  owns overlay display intent lifecycle.

State ownership:

| State | Owner | Persisted | Notes |
|---|---|---|---|
| committed stage | resource hook/cache | no local persistence | snapshot from model/study resource |
| stage draft | `inspector` local draft state | no | exists only while inspector edit session is open |
| validation result | pure selector/model builder | no | recomputed from draft + capabilities + resource revisions |
| selected node | kernel selection store | optional workspace preference only | stores serializable selection ref, not data payload |
| chart zoom/sort/pins | `analysis-plots` local store | yes, user preference | never changes canonical sweep/stage |
| display projection/phase | `AnalysisFieldOverlayController` | optional pinned display intent only | display state, not physics |
| field samples/topology | data-plane resource/cache/renderer | no | never copied into Zustand/React context |

Model invariants:

- `FrequencyDomainSelectionRef` is stable across reloads when the underlying
  run/stage/resource revision still exists, and it degrades to `not_found`
  rather than rendering stale cached data.
- `FrequencyResponseStageDraft` has canonical SI values and canonical enum names.
- `FrequencyDomainResultReadModel` has no setters and no commit helpers.
- `AnalysisFieldDisplayIntent` can be serialized, replayed and cleared without
  touching `StudyIR`.
- Any UI surface that needs both stage and result data receives them as two
  inputs and must not merge them into one mutable object.

#### M3.4 - Stage authoring inspector

Stage authoring lives in `inspector`, slot `panel-right`.
`StudyStageInspectorRouter` chooses `FrequencyResponseStageInspector`; the
stage inspector does not become a runtime/result panel.

Input model:

- committed study/stage resource,
- session capabilities,
- mesh periodic pairs resource,
- mesh/material/equilibrium revisions,
- optional planner diagnostics preview.

Output model:

- `FrequencyResponseStageDraft`,
- `FrequencyResponseStageValidation`,
- `FrequencyResponseStageCommitPatch`,
- command enablement for `simulation.run-stage`,
- disabled reasons with source resource.

Pure model API target:

```typescript
export interface FrequencyResponseStageModelInput {
  committedStage: CommittedStudyStageSnapshot;
  capabilities: FrequencyDomainCapabilitySnapshot;
  periodicPairs: PeriodicPairsResourceState;
  equilibrium: EquilibriumResourceState;
  diagnostics: PlannerDiagnosticsSnapshot | null;
  sourceRevision: string;
}

export interface FrequencyResponseStageModel {
  draft: FrequencyResponseStageDraft;
  validation: FrequencyResponseStageValidation;
  readiness: FrequencyResponseReadinessCell[];
  sections: FrequencyResponseStageSectionModel[];
  footer: FrequencyResponseStageFooterModel;
}

export function buildFrequencyResponseStageModel(
  input: FrequencyResponseStageModelInput,
): FrequencyResponseStageModel;

export function buildFrequencyResponseStageCommitPatch(
  draft: FrequencyResponseStageDraft,
  committed: CommittedStudyStageSnapshot,
): FrequencyResponseStageCommitPatch;
```

The exact type names may be adjusted to existing project conventions during
implementation, but the boundary is fixed: model builders are pure, React
components render model output, and commit helpers produce canonical study
patches only.

Commit/run path:

- draft is inspector-local,
- validation is pure derived state,
- commit uses `kernel.api.model.commitTransaction(...)` with
  `buildStudyStagesMergePatch(...)` or existing canonical commit helper,
- commit invalidates study/stage/status/resources,
- run uses command registry, not a callback to a runtime component.

Stage draft state machine:

| State | Trigger | UI behavior | Exit |
|---|---|---|---|
| `clean` | selected committed stage loaded | fields enabled according to capability gates | edit, validate, run |
| `dirty` | user edits draft field | commit/revert visible; run blocked until committed or explicit run-with-draft exists | commit, revert |
| `invalid` | pure validation has blocking errors | run disabled; section badges link to first error | fix draft, revert |
| `committing` | commit command submitted | fields read-only; progress shown in section header | committed, commit_failed |
| `commit_failed` | API transaction rejected | draft preserved; canonical snapshot unchanged; error attached to field/section | retry, revert |
| `committed_stale` | resource revision changed during edit | show diff/stale banner; run disabled until refresh or rebase | refresh, rebase |
| `runnable` | committed stage valid and resources fresh | run command enabled through command registry | run-stage command |

Inspector component structure:

```text
FrequencyResponseStageInspector
  FrequencyResponseStageHeader
  FrequencyResponseReadinessStrip
  FrequencyResponseStageSectionNav
  FrequencyResponseSetupSection
  FrequencyResponseCalculationSection
  FrequencyResponseEquilibriumSection
  FrequencyResponseOperatorSection
  FrequencyResponseBoundarySection
  FrequencyResponsePeriodicPairsSection
  FrequencyResponseExcitationSection
  FrequencyResponseSweepSection
  FrequencyResponseSolverSection
  FrequencyResponseOutputsSection
  FrequencyResponseDiagnosticsSection
  FrequencyResponseStageFooterActions
```

Component rules:

- `FrequencyResponseStageInspector` owns draft lifecycle only. Section
  components receive `draft`, `validation`, `capabilities` and section-specific
  change handlers; they do not call API methods directly.
- `FrequencyResponseStageHeader` shows selected stage id, calculation family,
  requested lane, resource revision and dirty/stale status.
- `FrequencyResponseReadinessStrip` has fixed cells for `Mesh`, `Pairs`,
  `Equilibrium`, `Lane`, `Artifacts`, `Run`. Each cell has
  `ready | stale | missing | unsupported | failed`.
- `FrequencyResponseStageSectionNav` is a compact section list with badges and
  keyboard focus. It does not switch workspace modules.
- Section components render controlled inputs bound to the draft. They do not
  use `defaultValue` for editable fields.
- `FrequencyResponseStageFooterActions` exposes `Commit`, `Revert`,
  `Validate`, `Run stage`, and `Open diagnostics`. `Run stage` goes through the
  command registry and is disabled while the draft is dirty unless an explicit
  run-with-draft command is added later.

Stage sections:

| Section | UI | Canonical fields | Release 1 behavior |
|---|---|---|---|
| `setup` | compact summary + segmented/select controls | discretization, device, precision, execution mode | `fem`, CPU, double, strict in Release 1; GPU static-periodic visible and gated by capability/runtime reason |
| `calculation_mode` | segmented control | frequency response vs eigenmodes | driven enabled, modal enabled only when solver path exists, comparison requires both result families |
| `equilibrium` | artifact/source selector | equilibrium source/ref | stale mesh/material blocks strict run |
| `operator` | term table + gated switches | linearized LLG terms, `include_demag` | demag/DMI/spin torque visible unsupported unless capability says ready |
| `boundary` | segmented `free/periodic/floquet` | boundary condition, pair ids | periodic release path; `floquet(k=0)` displayed as periodic-equivalent; nonzero-k disabled |
| `periodic_pairs` | resource table + pair selector | pair ids | selected ids only; rows always come from resource revision |
| `k_grid` | read-only vector + roadmap controls | k vector / sampling | locked `[0,0,0]`; nonzero-k controls disabled with `floquet_bloch_nonzero_k_unavailable` |
| `excitation` | vector input + phase input | drive field A/m, phase rad | finite nonzero tangent drive required |
| `sweep` | frequency list/range editor | frequency list Hz | positive finite unique points; GHz display is presentation only |
| `solver` | lane table + tolerance/iters if exposed | solver opts, execution intent | validation fallback is a hard failure for production |
| `outputs` | output checklist | requested artifacts | charts/points/3D readiness derived from resources |
| `diagnostics` | planner/runtime reason list | diagnostics refs | links to solver diagnostics and artifact checklist |

Release 1 stage inspector must expose these concrete controls:

| Control group | Required controls | Disabled-state source |
|---|---|---|
| lane | discretization, device, precision, execution mode | capability matrix + runtime availability |
| boundary | free/periodic/floquet selector, k-vector row, pair selector | periodic pairs resource + Floquet capability |
| operator | exchange, zeeman, demag, DMI rows | operator capability diagnostics |
| excitation | `Hx`, `Hy`, `Hz`, phase, optional display helper in mT | local finite/tangent validation |
| sweep | explicit frequency list, range generator, units toggle Hz/GHz display | local validation + max point capability |
| solver | tolerance/iterations only if public API exposes them | capability/provenance; no hidden backend knobs |
| outputs | response table, per-point fields, field payload request, diagnostics | requested outputs vs published artifacts |

Every control group must have a read-only summary state for committed stages
and an edit state for draft mode. A section is incomplete if it can render the
happy path but cannot explain why a control is disabled.

Stage parameter matrix:

| Field | UI control | Stored value | Validation |
|---|---|---|---|
| discretization | segmented/select | `fem` | mismatch blocks commit |
| device | segmented `cpu/gpu/auto` | canonical device request | unsupported lane blocks strict run |
| precision | segmented | `double` | `single` disabled until qualified |
| execution mode | segmented | `strict` | strict cannot use fallback |
| calculation family | segmented | `frequency_response` or `eigenmodes` | compare is display-only, not a hybrid stage |
| equilibrium source | select | artifact/ref/source enum | stale revision blocks strict run |
| include_demag | switch | bool | disabled for PBC response until capability ready |
| boundary | segmented | `periodic` release path | requires periodic pairs |
| pair ids | table selector | pair id list | ids must exist in current mesh revision |
| k vector | read-only numeric vector | `[0,0,0]` | nonzero-k unavailable |
| excitation | vector editor | SI A/m | finite, nonzero tangent component |
| phase | numeric input/slider | radians | finite |
| frequencies | list/range editor | SI Hz list | positive finite unique |
| solver tolerances | numeric if API exposes | canonical solver opts | finite positive |
| output field payload | checklist | requested output flags | missing field disables 3D, not chart |

Canonical stage patch contract:

| Draft path | Commit payload field | Unit/enum stored | Notes |
|---|---|---|---|
| `setup.discretization` | `stage.execution.discretization` | `fem` | Release 1 rejects non-FEM for this workflow |
| `setup.device` | `stage.execution.device` | `cpu | gpu | auto` | requested intent; resolved device comes only from runtime/provenance |
| `setup.precision` | `stage.execution.precision` | `double` | `single` visible but disabled until validation |
| `calculation.family` | `stage.kind` | `frequency_response` or `eigenmodes` | comparison is analysis UI, not a mixed stage kind |
| `equilibrium.source` | `stage.frequency_response.equilibrium_source` | resource/ref enum | stores ids/revisions, not copied field values |
| `operator.include_demag` | `stage.frequency_response.include_demag` | bool | PBC response remains gated until dynamic demag exists |
| `boundary.kind` | `stage.frequency_response.spin_wave_bc.kind` | `free | periodic | floquet` | Release 1 saves `periodic`; nonzero-k Floquet disabled |
| `boundary.pair_ids` | `stage.frequency_response.spin_wave_bc.pair_ids` | string ids | ids must resolve in current `periodic_pairs.v1` |
| `k_grid.k_vector` | `stage.frequency_response.k_vector_si` | 1/m vector | fixed `[0,0,0]` for k=0 release |
| `excitation.field` | `stage.frequency_response.excitation_field_au_per_m` | A/m vector | UI may show mT helper, but commit stores A/m |
| `excitation.phase` | `stage.frequency_response.excitation_phase_rad` | rad | finite scalar |
| `sweep.frequencies` | `stage.frequency_response.frequencies_hz` | Hz array | sorted unique positive finite values |
| `solver.tolerance` | `stage.frequency_response.solver.tolerance` | dimensionless | only if public API exposes it |
| `outputs.field_payload` | `stage.frequency_response.outputs.response_field` | bool/output enum | requested output, not readiness proof |

Draft-to-commit rules:

- Commit payload must be minimal: include changed canonical fields and required
  revision guards, not the whole inspector view model.
- Commit must carry the source study/stage revision. If the committed resource
  changed, the inspector enters `committed_stale` and preserves the draft.
- Display-only choices such as chart zoom, selected point, selected mode,
  projection, phase animation and 3D appearance never appear in the stage patch.
- Runtime readback fields such as resolved lane, residuals, artifact paths,
  completed point counts and fallback flags never appear in the stage patch.
- Any helper display conversion must be reversible before commit: GHz display
  converts to Hz, mT helper converts to A/m, degrees display converts to rad.

Field-level inspector behavior:

| Field group | Edit behavior | Blocking reasons shown inline |
|---|---|---|
| execution lane | segmented controls update draft immediately; no commit until user saves | unsupported lane, missing GPU runtime, `gpu_static_periodic_unavailable`, `gpu_static_periodic_requires_no_demag`, single precision unqualified |
| calculation family | switching family preserves shared setup fields but clears family-specific invalid draft fields after confirmation | modal backend unavailable, response backend unavailable |
| periodic boundary | selecting periodic requires current pair resource; selecting Floquet exposes k row but nonzero-k remains disabled | missing pairs, stale pairs, nonzero-k unsupported |
| pair selection | table selection stores pair ids only; table rows are never copied into draft | pair id absent in current revision, residual over tolerance |
| excitation | vector editor stores SI A/m; display helpers may show mT-equivalent only as presentation | zero tangent component, NaN/inf, incompatible basis |
| sweep | range/list editor normalizes to sorted unique Hz in commit patch | nonpositive frequency, duplicate after tolerance, too many points for capability |
| outputs | requested outputs are saved, but actual readiness is read back from artifacts | field payload unavailable, artifact family unsupported |

Stage-parameter build order:

1. Add `FrequencyResponseStageDraft` and `FrequencyResponseStageCommitPatch`
   snapshots for an existing committed stage with periodic k=0 no-demag setup.
2. Add pure validation fixtures for missing pairs, stale equilibrium, GPU
   static-periodic before/after capability evidence, demag PBC, nonzero-k and
   single precision.
3. Implement section view models with canonical SI values and display helpers
   as separate fields, for example `frequencyHz` plus `frequencyDisplayGhz`.
4. Render controlled section components from the view models. No section calls
   `kernel.api` directly.
5. Wire footer actions to `commit`, `revert`, `validate`, `run stage` and
   `open diagnostics` through the model transaction and command registry.
6. Add stale-revision behavior: incoming resource changes mark the draft stale
   but never overwrite user edits until refresh/rebase/revert.
7. Add keyboard and focus tests for section navigation, inline errors and
   footer actions.

The stage inspector is done only when a test proves this negative contract:
selected point, selected mode, chart zoom, projection, phase, animation,
resolved backend, residuals and artifact paths are absent from the commit
patch.

Stage parameter implementation is accepted only when each section exposes all
four layers below:

| Layer | Requirement |
|---|---|
| committed summary | read-only rows from current study/stage resource with source revision |
| draft controls | controlled inputs using canonical SI values plus display helpers |
| validation rows | blocking/warning reason ids with source resource and affected field |
| commit patch | minimal canonical patch with revision guard and no display/readback fields |

If a section lacks any layer above, it is not production-ready even if the
visual form appears usable.

Stage section layout details:

- `Setup`: single compact lane strip showing requested
  `discretization/device/precision/execution_mode` and resolved support from
  capabilities. GPU static-periodic is visible and its state is taken from
  capability/runtime resources: disabled before M5 with
  `gpu_static_periodic_unavailable`, enabled after M5 only for k=0 no-demag
  production GPU artifacts with `validation_fallback_used=false`.
- `Calculation`: segmented `Driven response | Eigenmodes`; `Compare` is a
  chart/readback tab and cannot be saved as a mixed stage.
- `Boundary`: segmented `Free | Periodic | Floquet`; Release 1 saves
  `periodic` with `k=[0,0,0]`. Nonzero-k inputs are visible in a collapsed
  roadmap row and disabled with `floquet_bloch_nonzero_k_unavailable`.
- `Periodic pairs`: resource table columns are `pair_id`, `axis`, `minus_ref`,
  `plus_ref`, `node_count`, `frame_residual`, `drive_residual`, `revision`.
  Selection stores pair ids only.
- `Operator`: term rows are `exchange`, `zeeman`, `demag`, `dmi`,
  `spin_torque`, `magnetoelastic`. Unsupported rows stay visible and show the
  capability blocker; they are not hidden.
- `Excitation`: vector editor stores SI A/m and may show mT-equivalent helper
  values; phase controls store radians. These helpers are presentation only.
- `Sweep`: editor stores Hz values; duplicate/NaN/negative entries are local
  validation errors before API commit.
- `Solver`: lane table separates requested intent from resolved backend and
  includes `validation_fallback_used`. Any fallback is a red production badge
  for strict mode.
- `Outputs`: output checkboxes request artifacts, but readiness is read back
  from published resources after run.

UI controls:

- segmented controls for mode, boundary, device, precision and projection,
- switches for demag and animation,
- tables for periodic pairs and frequency points,
- numeric/vector inputs for excitation, phase, sweep and tolerances,
- icon buttons with tooltips for select, inspect, plot, pin, export, clear,
- shadcn-style shared primitives only,
- CSS classes prefixed `fm-`,
- colors through `--fm-*` tokens,
- no nested cards in the inspector,
- every disabled control has inline reason or tooltip.

Acceptance:

- draft init from committed stage,
- validation for missing pairs, stale equilibrium, GPU static-periodic
  readiness, demag PBC, nonzero-k and single precision,
- commit patch contains canonical SI/canonical names,
- commit path uses model transaction,
- controlled-input tests prove edits survive rerender and resource refresh
  until explicit commit/revert/rebase,
- run command is disabled/enabled from validation state,
- no result artifact is used as default physics input,
- stale committed stage during draft edit is tested and keeps user edits
  visible instead of silently overwriting them.
- commit-patch snapshot test proves no result/readback/display fields are
  written into `StudyIR`.
- keyboard test covers section navigation, field focus, error summary links and
  footer actions without requiring hover.

#### M3.5 - Result and resource inspectors

Result/resource inspectors are read-only. They can change selection and display
intent, but cannot edit committed physics.

Panel pattern:

- `use...Resource()` fetches resource and resource state,
- `build...InspectorModel(...)` is a pure normalizer,
- React panel renders model, actions and error states,
- actions are selection updates or command dispatches,
- no endpoint strings, no direct transport, no direct `fetch()`.

Required panels:

| Panel | Selection kinds | Required resources | Primary actions |
|---|---|---|---|
| `FrequencyResponseStageSummaryPanel` | `study.stage.frequency_response.*` when read-only summary needed | study/stage/capabilities | open authoring section, validate, run |
| `FrequencyResponseManifestInspectorPanel` | `resources.frequency_domain.manifest` | manifest | open linked resources |
| `FrequencyResponseSweepInspectorPanel` | `resources.frequency_response.sweep`, `results.frequency_response.sweep` | sweep/progress/manifest | open chart, select point |
| `FrequencyResponseFrequencyPointsInspectorPanel` | `results.frequency_response.frequency_points` | sweep/progress/point summaries | select point, plot point in 3D |
| `FrequencyResponsePointInspectorPanel` | `resources.frequency_response.frequency_point`, `results.frequency_response.frequency_point` | point/field meta/diagnostics | plot field, set phase/display intent |
| `FrequencyResponseFieldInspectorPanel` | `resources.frequency_response.field`, `results.frequency_response.field` | field meta/data-plane ref | plot, copy field id, inspect payload readiness |
| `FrequencyResponseDiagnosticsInspectorPanel` | `resources.frequency_response.solver_diagnostics`, `results.frequency_response.diagnostics` | solver diagnostics/progress | open failed point, copy diagnostics |
| `FrequencyDomainPeriodicPairsResourceInspectorPanel` | `resources.mesh.periodic_pairs` | periodic pairs | select pair, copy pair id, show stale reason |
| `EigenModeInspectorPanel` | `results.eigen.mode` | eigen spectrum/mode field meta | plot mode in 3D |
| `FmrOverviewInspectorPanel` | `results.frequency_domain.fmr` | sweep/spectrum/peaks/manifest | open overview plots, select peak |
| `FmrPeakInspectorPanel` | `results.frequency_domain.fmr_peak` | peak model + linked point/mode | plot linked field when present |
| `FrequencyDomainComparisonInspectorPanel` | `results.frequency_domain.comparison` | sweep/spectrum/peaks | select unmatched/paired peaks |

Migration rule for inspectors:

- Existing `FrequencyDomainInspectorPanel` branches must be moved out one
  selection family at a time.
- Each extraction adds a model test first, then a panel test, then a registry
  route. The aggregate panel can keep delegating to the new panel during the
  transition.
- The aggregate panel is removed or reduced to a thin compatibility router only
  after all frequency-domain result/resource selections have dedicated routes.
- A route is not complete until the generic fallback test proves that selection
  kind cannot render raw JSON as its primary view.

Per-panel model contract:

```typescript
export interface FrequencyDomainInspectorModelInput {
  selection: FrequencyDomainSelectionRef;
  resources: FrequencyDomainResourceBundle;
  capabilities: FrequencyDomainCapabilitySnapshot;
  overlay: AnalysisFieldOverlaySnapshot | null;
}

export interface FrequencyDomainInspectorModel {
  title: string;
  subtitle: string;
  readiness: FrequencyDomainInspectorReadiness;
  primaryRows: InspectorMetricRow[];
  tables: InspectorTableModel[];
  linkedResources: InspectorLinkModel[];
  actions: InspectorActionModel[];
  diagnostics: InspectorDiagnosticRow[];
}
```

Panel model builders must return structured rows/actions even for
`partial_artifacts`, `missing_field_payload`, `stale_resource`, `unsupported`
and `failed_run`. Returning only raw JSON or a prose-only message is a failed
implementation.

Inspector build order:

1. Implement `frequencyDomainInspectorStates.ts` with shared state labels,
   reason ids and small helpers for `loading`, `ready`, `empty`, `not_found`,
   `unsupported`, `partial_artifacts`, `missing_field_payload`,
   `stale_resource` and `failed_run`.
2. Add explicit `inspectorRegistry.tsx` routes for every selection prefix in
   the routing table below. The test must fail if a frequency-domain selection
   reaches the generic fallback.
3. Build pure panel models for manifest, sweep, point, field, diagnostics,
   periodic pairs, eigen mode, FMR overview, FMR peak and comparison.
4. Render panels with one shared shell pattern:
   header, readiness banner, dense rows/tables, linked resources, actions and
   collapsed diagnostics disclosure.
5. Add actions as selection updates or command dispatches only. No panel calls
   a viewport method, imports chart modules or builds endpoint strings.
6. Add one non-happy fixture per panel before marking the panel complete.

Read-only panel completion requires useful structured content for partial or
failed artifacts. A blank panel with a raw JSON disclosure is not accepted.

Inspector routing rules:

| Selection prefix | Routed component family | Editable | Reason |
|---|---|---|---|
| `study.stage.frequency_response.*` | `FrequencyResponseStageInspector` section route | yes | canonical study authoring through transaction |
| `resources.frequency_domain.*` | frequency-domain resource inspectors | no | runtime/artifact readback |
| `resources.frequency_response.*` | response resource inspectors | no | runtime/artifact readback |
| `resources.mesh.periodic_pairs` | periodic-pairs resource inspector | no | mesh resource readback; stage stores ids only |
| `results.frequency_response.*` | response result inspectors | no | analysis readback and selection |
| `results.eigen.*` | modal result inspectors | no | modal readback and mode selection |
| `results.frequency_domain.fmr*` | FMR overview/peak/comparison inspectors | no | derived analysis readback |

The registry must reject ambiguous routing. If a selection could be both an
authoring node and a result node, the selection type is wrong and the test must
fail before rendering.

Panel composition contract:

```text
<Panel>
  <PanelHeader selection/resource/status>
  <ReadinessBanner missing/stale/unsupported/partial/fallback>
  <PrimaryMetrics dense rows/tables>
  <LinkedResources resource links and revisions>
  <Actions command buttons and selection links>
  <DiagnosticsDisclosure optional raw ids/reasons, not raw JSON by default>
</Panel>
```

Per-panel required content:

| Panel | Must show | Must not do |
|---|---|---|
| `FrequencyResponseManifestInspectorPanel` | artifact families, schema versions, run/stage ids, requested/resolved lanes, missing resources | parse arbitrary local files in the browser |
| `FrequencyResponseSweepInspectorPanel` | point count, completed/failed counts, frequency range, observable list, peak readiness, linked chart command | edit sweep frequencies |
| `FrequencyResponseFrequencyPointsInspectorPanel` | paged frequency-point table, status per point, field readiness column, residual/iteration summaries | load all field payloads eagerly |
| `FrequencyResponsePointInspectorPanel` | selected frequency Hz, observable values, complex component summary, linked field meta, residual/solver state | infer unavailable field payloads from numeric sweep values |
| `FrequencyResponseFieldInspectorPanel` | field id, basis, component layout, data-plane key, revision, sample count/budget | decode heavy binary payload inside inspector render |
| `FrequencyResponseDiagnosticsInspectorPanel` | fallback flags, operator terms, solver phases, failed points, static-periodic diagnostics | hide fallback behind a green completed state |
| `FrequencyDomainPeriodicPairsResourceInspectorPanel` | pair count, mesh revision, axis/frame residuals, stale reason, selected pair links | write pair tables into stage drafts |
| `EigenModeInspectorPanel` | mode frequency, damping, sample/branch ids, mode-field readiness, projection options | treat modal index as stable without run/stage/sample identity |
| `FmrOverviewInspectorPanel` | combined readiness, dominant peak, available result families, lane/status strip | fabricate comparison if only one family exists |
| `FmrPeakInspectorPanel` | peak frequency, amplitude/fit score, source family, linked point/mode when available | enable 3D plot for analytical-only peak |
| `FrequencyDomainComparisonInspectorPanel` | paired/unmatched peaks, detuning, source provenance | silently pair by nearest frequency without tolerance/provenance |

Implementation map:

| Concern | File | Test |
|---|---|---|
| panel dispatch | `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` | `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx` |
| shared panel state | `apps/control-room/src/modules/inspector/panels/frequency-domain/frequencyDomainInspectorStates.ts` | `apps/control-room/src/modules/inspector/panels/frequency-domain/frequencyDomainInspectorStates.test.ts` |
| response sweep panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyResponseSweepInspectorPanel.tsx` | matching `.test.tsx` |
| response point panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyResponsePointInspectorPanel.tsx` | matching `.test.tsx` |
| response field panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyResponseFieldInspectorPanel.tsx` | matching `.test.tsx` |
| diagnostics panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyResponseDiagnosticsInspectorPanel.tsx` | matching `.test.tsx` |
| periodic pairs panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainPeriodicPairsResourceInspectorPanel.tsx` | matching `.test.tsx` |
| eigen mode panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.tsx` | matching `.test.tsx` |
| FMR peak panel | `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrPeakInspectorPanel.tsx` | matching `.test.tsx` |
| pure read models | `apps/control-room/src/shared/domain/analysis/frequencyDomainReadModels.ts` | `apps/control-room/src/shared/domain/analysis/frequencyDomainReadModels.test.ts` |

Every panel state distinguishes:

- `loading`,
- `ready`,
- `empty`,
- `not_found`,
- `unsupported`,
- `partial_artifacts`,
- `missing_field_payload`,
- `stale_resource`,
- `failed_run`.

Panel action rules:

- `Open chart` selects or opens `analysis-plots`; it does not pass chart props
  through inspector.
- `Plot in 3D` dispatches an analysis/viewport command with a selection ref; it
  does not call a viewport method.
- `Inspect linked resource` changes kernel selection to the linked resource
  ref; it does not duplicate the linked panel inline.
- `Copy id` copies stable ids/resource keys only, not raw JSON blobs.
- `Retry` or `refresh` commands target resource invalidation/reload only; they
  do not rerun the solver unless the command is explicitly `Run stage`.
- Raw JSON can appear only in a collapsed diagnostics disclosure for debugging;
  the primary panel content must be structured rows, tables and reason badges.

Diagnostics panel must show these as first-class fields when present:

- `requested_execution_lane`,
- `resolved_execution_lane`,
- `validation_fallback_used`,
- `assembled_mfem_operator_solver`,
- `dense_block_real_solver`,
- `matrix_free_solver`,
- `krylov_solver`,
- `operator_terms_included`,
- `completed_frequency_point_count`,
- residual norms and failed point ids,
- static-periodic diagnostics.

Acceptance:

- `inspectorRegistry.tsx` maps every selection kind explicitly,
- test fails for generic fallback on frequency-domain result/resource kinds,
- partial artifacts render useful read-only state, not blank panels,
- `validation_fallback_used=true` renders as production failure,
- every panel has at least one action that is either a selection update,
  command dispatch or resource link; no panel action calls a viewport method
  directly.
- each panel test covers at least one non-happy state from its required
  resources: `not_found`, `partial_artifacts`, `missing_field_payload`,
  `stale_resource`, `unsupported`, or `failed_run`.

#### M3.6 - Wykresy i `analysis-plots`

Inspector may show compact preview charts. Full charting lives in
`analysis-plots` as the center analysis surface or bottom dock surface.
Charts are selection tools, not decorative widgets.

Module composition:

```text
AnalysisPlotsModule
  AnalysisPlotsTabHost
  FmrOverviewPlotPanel
  DrivenSweepPlotPanel
  FrequencyPointDetailPanel
  ModalSpectrumPlotPanel
  ModeDetailPanel
  ModalDrivenComparisonPanel
  FrequencyDomainDiagnosticsPlotPanel
```

Chart build order:

1. Build `FrequencyDomainChartModel` from immutable read models without React,
   DOM, ECharts or viewport imports.
2. Add fixtures for response-only, modal-only, both families, partial fields,
   stale revisions, duplicate frequencies, failed points and no peaks.
3. Implement tab panels as thin renderers of chart model sections. Chart panels
   own only active tab, observable, zoom, pinned series, table sort and export
   selection.
4. Wire chart interactions to kernel selection refs and command registry:
   point click, mode click, peak click, paired-row click, plot selected, export
   table, open diagnostics.
5. Add keyboard coverage for table row selection and plot/export commands.
6. Add screenshot/browser smoke for desktop and narrow viewports so axes,
   legends, tables and disabled reasons do not overlap.

Chart acceptance is model-first: if the pure chart model cannot explain the
state, the React chart must not invent a display fallback.

Existing chart stack to extend:

- `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
  remains the ECharts owner. New frequency-domain panels pass option/data
  models into this surface; they do not instantiate ECharts directly.
- `apps/control-room/src/modules/analysis-plots/frequencyDomainSeriesAdapter.ts`
  is the current frequency-domain adapter seam. It should be widened or
  replaced by `frequencyDomainChartModels.ts` only with tests proving the old
  spectrum/dispersion/response behavior still routes through the new model.
- `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
  owns chart-local state and kernel selection dispatch. It may consume the new
  chart model, but it must not import inspector panel internals.
- Inspector preview charts, when needed, must reuse the same chart model and a
  lightweight preview renderer. They must not create a second series-building
  implementation.

Frequency-domain chart model must expose stable ids for:

| Entity | Stable chart id | Why |
|---|---|---|
| response series | `response:<runId>:<stageId>:<observableId>` | same observable across re-render/resource refresh |
| response point marker | `point:<runId>:<stageId>:<frequencyPointId>` | selection independent of rounded frequency label |
| modal series | `modal:<runId>:<stageId>:<sampleIndex>:<branchId>` | branch/sample-aware spectrum rows |
| eigen mode marker | `mode:<runId>:<stageId>:<sampleIndex>:<rawModeIndex>` | stable mode identity for sorting/filtering |
| FMR peak marker | `peak:<runId>:<stageId>:<source>:<fmrPeakIndex>` | derived/backend peak provenance |
| diagnostic marker | `diag:<runId>:<stageId>:<frequencyPointId>:<reason>` | failed-point and fallback markers |

`AnalysisPlotsModule` owns chart-local state only: active tab, selected
observable, zoom range, pinned series, table sorting and export selection. It
receives result models from resource hooks/shared adapters and emits selection
refs/commands.

Shared chart model:

- file: `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`,
- input: driven sweep, modal spectrum, progress, diagnostics, peak model,
- output: pure `FrequencyDomainChartModel`,
- no React, no DOM, no viewport imports.

Chart model fields:

- `series[]` with stable id, units and axis role,
- `markers[]` for peaks, failed points, partial/stale points,
- `tables[]` for peak, mode and frequency-point tables,
- `selectionTargets[]` mapping rows/points/markers to selection refs,
- `commands[]` for plot, pin, export, open inspector,
- `readiness` in `ready | empty | partial_artifacts | missing_artifacts |
  stale_resource | unsupported`.

Minimum chart model shape:

```typescript
export interface FrequencyDomainChartModel {
  title: string;
  readiness: FrequencyDomainChartReadiness;
  lane: RequestedResolvedLaneSummary;
  series: FrequencyDomainChartSeries[];
  markers: FrequencyDomainChartMarker[];
  tables: FrequencyDomainChartTable[];
  selectionTargets: FrequencyDomainSelectionTarget[];
  commands: FrequencyDomainChartCommand[];
  diagnostics: FrequencyDomainChartDiagnostic[];
}
```

This type is the contract between resource adapters and React/ECharts. ECharts
options are derived from it; they are not the model and cannot be the only
tested output.

Chart panel state contract:

| State | User-visible behavior | Required command behavior |
|---|---|---|
| `empty` | show the missing result family and linked run/stage ids if known | plot/export disabled with `missing_artifacts` |
| `partial_artifacts` | numeric series render if present; missing series/fields marked inline | 3D actions disabled only for missing payloads |
| `stale_resource` | stale badge on affected series and tables | plot disabled until refresh resolves revision |
| `unsupported` | show capability/runtime reason | run/authoring links remain available when appropriate |
| `failed_run` | failed points and solver stop reason are visible | failed point can open diagnostics inspector |
| `ready` | charts, tables and commands are active from resource evidence | commands carry selection refs and revisions |

Required surfaces:

| Surface | Contents | Interactions |
|---|---|---|
| `FMR Overview` | response amplitude, phase, residual, peak table, lane/status strip | select peak/point, plot selected, open diagnostics |
| `Driven Sweep` | amplitude/susceptibility/absorbed power when available, phase plot, point status markers | click selects point, double-click plots default 3D projection when field exists |
| `Frequency Point` | selected point observables, complex components, residual and field readiness | step through previous/next point, plot field, pin point |
| `Modal Spectrum` | eigen frequencies, damping/stiffness if available, mode table | click selects mode, plot mode in 3D |
| `Mode Detail` | selected mode metadata, branch/sample ids, field readiness, component basis | change projection, plot mode, pin mode |
| `Modal vs Driven` | modal peaks over driven peaks, detuning table | select paired/unmatched peaks; no fabricated correspondences |
| `Diagnostics` | residual vs frequency, iterations vs frequency, failed point markers, fallback indicators | select failed point, open diagnostics inspector |

Chart interaction contract:

| User action | Output |
|---|---|
| click sweep point | sets `results.frequency_response.frequency_point` selection ref |
| double-click sweep point | dispatches plot command only when field meta is ready |
| click modal row/marker | sets `results.eigen.mode` selection ref |
| click FMR peak | sets `results.frequency_domain.fmr_peak` selection ref |
| click paired comparison row | sets comparison selection and exposes linked point/mode commands |
| brush/zoom | updates chart-local state only |
| export table | dispatches export command or downloads resource-backed table, not DOM scrape |
| open diagnostics marker | sets diagnostics selection or command, no stage mutation |

Chart data contract:

| Series kind | X axis | Y axis | Source resource | Selection target |
|---|---|---|---|---|
| response amplitude | frequency Hz | amplitude/susceptibility/power with units | sweep | response point |
| response phase | frequency Hz | rad or deg display | sweep/point | response point |
| residual | frequency Hz | residual norm | diagnostics/progress | failed or completed point |
| iterations | frequency Hz | iteration count | diagnostics | failed or completed point |
| modal eigenfrequency | mode/sample index or k sample | Hz | spectrum | eigen mode |
| modal damping/stiffness | mode/sample index | backend-published units | spectrum | eigen mode |
| FMR peak | frequency Hz | peak amplitude/fit score | peak model | FMR peak |

Chart model derivations:

- Peak detection is a pure read-model operation with explicit tolerance and
  provenance. If backend publishes peaks, the UI shows backend peak provenance;
  if UI derives peaks, it labels them as derived UI analysis and never writes
  them into runtime artifacts.
- Modal-vs-driven pairing requires an explicit detuning tolerance. Unmatched
  modes and unmatched driven peaks remain visible instead of being hidden.
- Duplicate frequencies are grouped or rejected by the chart model according to
  the resource schema; the chart must not silently overwrite points with the
  same display label.
- Observables keep their units and source ids through the model; tooltips must
  show SI values even when axes use GHz or normalized display.
- Failed points stay in the x-axis domain with failed markers so the response
  sweep does not visually imply a complete solve.

Chart-local state that may persist:

- selected observable,
- zoom/brush range,
- pinned series,
- table sort,
- panel layout.

Chart-local state that must not persist as physics:

- generated sweep edits,
- selected backend/device,
- boundary/k/demag settings,
- field projection/phase except as display intent.

Lifecycle/performance:

- chart instance is disposed on unmount,
- active center tab is the only mounted heavy surface,
- only the active chart tab owns an ECharts instance; inactive tabs keep model
  state but do not keep hidden canvases mounted,
- chart updates are memoized by resource revision,
- chart state never triggers topology rebuild or WebGL dirty render,
- stale resources show a stale badge instead of mixing revisions.

Acceptance:

- tests cover empty, partial, stale, multi-observable, duplicate frequency,
  local maxima, detuning and failed point markers,
- interaction test dispatches selection for point/mode/peak,
- plot action dispatches command registry command, not viewport callback,
- unmount test disposes chart resources,
- screenshot smoke covers desktop/mobile label overlap,
- keyboard test can select point/mode/peak rows and trigger plot/export without
  hover,
- modal-vs-driven test proves unmatched peaks remain visible with provenance,
- chart fixture with only sweep and no field payload still renders numeric
  charts and disables 3D actions with `missing_field_payload`.

#### M3.7 - Mode/point/peak selection for 3D

3D plotting is a display workflow. It must not mutate stage, artifacts or
field ids.

UI surfaces for 3D selection:

| Surface | Visible controls | Writes |
|---|---|---|
| mode table in `Modal Spectrum` | `Plot`, projection menu, pin, inspect | selection ref + plot command |
| mode inspector | projection segmented control, phase input, animation toggle, plot/clear buttons | display command only |
| response point table | `Plot` icon when field meta ready, disabled reason when not ready | selection ref + plot command |
| response point inspector | component/projection controls, phase input, appearance menu | display command only |
| FMR peak table | plot linked field when peak has linked mode/point, inspect linked resource | selection ref + delegated plot command |
| viewport overlay toolbar | projection, phase, animation, appearance, clear | `AnalysisFieldDisplayIntent` only |
| ribbon `Analysis/View` groups | plot selected, phase animation, clear overlay | command registry only |

There is no inspector-to-viewport callback prop. Every plot action dispatches a
command that resolves field meta and creates or updates
`AnalysisFieldDisplayIntent`.

3D selection build order:

1. Add command-contribution tests for mode, response point and FMR peak plot
   commands with ready, missing-field, stale-field and unsupported-lane inputs.
2. Implement field-meta resolution in the command layer. Peak commands must
   resolve to a linked mode or response point before reaching viewport code.
3. Add `AnalysisFieldDisplayIntent` controller tests for idempotency,
   projection/phase changes, pin/clear behavior and resource invalidation.
4. Wire `viewport-3d` to consume display intents and data-plane field payloads
   by `fieldId`/`dataPlaneKey`. It does not read chart state or stage drafts.
5. Add overlay controls for projection, phase, animation, appearance and clear
   as command-backed controls with disabled reasons.
6. Add browser smoke for mode -> 3D, response point -> 3D, linked peak -> 3D,
   phase change, projection change, animation stop, clear and tab unmount.

Mode/point/peak selection rule: selection is allowed without field payload;
plotting is not. The UI must keep the row inspectable while disabling `Plot in
3D` with `missing_field_payload`.

Minimal `AnalysisFieldDisplayIntent`:

- `sourceKind`: `eigen-mode | frequency-response | fmr-peak`,
- `fieldId`,
- `resourceRef`,
- `resourceRevision`,
- `dataPlaneKey`,
- `basis`,
- `component`: `x | y | z | vector | transverse | backend_default`,
- `projection`: `real | imag | abs | phase | phase_rotated_real`,
- `phaseRad`,
- `animation`: `{ enabled, rateHz, respectsReducedMotion }`,
- `appearance`,
- `label`,
- `selectionRef`.

Current compatibility rule:

- The existing `AnalysisFieldOverlaySource` currently covers eigen-mode and
  frequency-response overlays. For Release 1, an FMR peak should normally
  delegate to its linked eigen mode or response point and create one of those
  two overlay kinds.
- Add `fmr-peak` as a first-class overlay source only if there is a real
  peak-specific field resource. That change requires controller equality tests,
  command-contribution tests, viewport label tests and browser smoke for linked
  and analytical-only peaks.
- Analytical-only peaks never create an overlay. They remain selectable in
  charts/inspectors and expose linked diagnostics/comparison actions.

Display intent provenance:

| Field | Source | Required for |
|---|---|---|
| `sourceKind` | command input from selected result | routing labels and command idempotency |
| `sourceResourceId` | manifest/sweep/spectrum/point resource | stale checks and debug display |
| `runId` / `stageId` | result resource | provenance label and invalidation |
| `fieldId` | field meta resource | data-plane lookup |
| `resourceRevision` | field meta/resource hook | stale detection |
| `dataPlaneKey` | field meta resource | binary payload load |
| `basis` | field meta resource | projection/component validation |
| `projection` / `phaseRad` | command/display controls | render uniforms only |
| `appearance` | command/display controls | render style only |
| `selectionRef` | kernel selection | inspector/chart synchronization |

Selection-to-3D state machine:

| State | Trigger | Behavior |
|---|---|---|
| `selection_only` | user selects mode/point/peak | inspector/charts update; viewport unchanged |
| `metadata_checked` | plot command resolves field meta | command either creates display intent or returns disabled reason |
| `overlay_loading` | viewport receives display intent | data-plane field samples load by field id/data-plane key |
| `overlay_ready` | samples decoded and buffers uploaded | vector/scalar overlay rendered; label and controls active |
| `metadata_only` | meta exists but payload missing | 3D action disabled or overlay shows nonblank reason panel |
| `stale` | field/resource revision changes | overlay marked stale; user can refresh or clear |
| `cleared` | clear/session change/unmount | overlay resources released; base mesh remains |

Mode picker behavior:

- Mode rows are identified by `runId + stageId + sampleIndex + rawModeIndex`
  plus optional `branchId`. Display labels may be `Mode 1`, `Mode 2`, but labels
  are not ids.
- The default sort is frequency ascending, then damping if available, then
  raw mode index. User sort is chart-local state.
- The mode picker can filter by result family, branch, frequency window,
  damping availability and field-payload readiness.
- Filters never remove the currently selected mode without showing a filtered
  selection banner and a clear-filter action.
- A mode row with no field payload remains selectable for inspector/chart
  context, but `Plot in 3D` is disabled with `missing_field_payload`.
- A mode row must show field readiness, mode id tuple, frequency, damping when
  present, branch/sample ids, and linked resource revision.
- Projection presets are `Real`, `Imag`, `Abs`, `Phase`,
  `Phase rotated real`. The chosen preset is display state and never changes
  the artifact.
- Phase controls are enabled for complex fields. For real-only fields, phase
  controls are disabled with `real_field_has_no_phase`.
- Pinning a mode keeps the display intent across chart tab changes only when
  `resourceRevision` remains current.
- Clearing selection does not clear an intentionally pinned overlay; clearing
  overlay does not clear selected chart row.

Mode picker layout contract:

```text
ModePicker
  toolbar: result family, branch, frequency window, payload-ready filter
  table: mode id, frequency, damping, branch/sample, field readiness, revision
  detail strip: selected mode provenance and linked resource ids
  actions: inspect, plot real, plot imag, plot abs, plot phase, pin, export
```

The mode picker is part of `analysis-plots` and read-only inspectors. It is not
a viewport widget. Viewport overlay controls can change projection/phase after
plotting, but selecting which mode to plot stays chart/inspector selection.

Selection synchronization rules:

- Selecting a mode in the chart updates kernel selection to `results.eigen.mode`
  and updates the right inspector.
- Plotting a mode keeps the same selection ref and adds or updates display
  intent. It does not create a separate "viewport selected mode".
- Changing projection in the viewport updates display intent only. It must not
  change selected table row or chart filters.
- Clearing overlay leaves the selected mode/point/peak intact.
- Session/run/stage change invalidates pinned display intent unless the field
  meta resource revision still matches exactly.

Mode plotting:

- source: modal spectrum chart or mode table,
- selection: `results.eigen.mode`,
- payload: `runId`, `stageId`, `sampleIndex`, `rawModeIndex`, optional
  `branchId`, `fieldId`, `modeFieldResourceKey`, optional `frequencyHz`,
  `phaseRad`, `projection`,
- commands:
  - `analysis.eigen.plot-mode-3d`,
  - `analysis.eigen.plot-mode-3d-real`,
  - `analysis.eigen.plot-mode-3d-imag`,
  - `analysis.eigen.plot-mode-3d-abs`,
  - `analysis.eigen.plot-mode-3d-phase`,
  - `analysis.eigen.plot-mode-3d-phase-rotated-real`.

Driven response point plotting:

- source: response sweep chart or frequency point table,
- selection: `results.frequency_response.frequency_point`,
- payload: `runId`, `stageId`, `frequencyPointId`, `frequencyHz`,
  `observableId`, `fieldId`, `resourceRef`, `phaseRad`, `projection`,
- commands:
  - `analysis.frequency-response.plot-response-field-3d`,
  - `analysis.frequency-response.plot-response-field-3d-real`,
  - `analysis.frequency-response.plot-response-field-3d-imag`,
  - `analysis.frequency-response.plot-response-field-3d-abs`,
  - `analysis.frequency-response.plot-response-field-3d-phase`,
  - `analysis.frequency-response.plot-response-field-3d-phase-rotated-real`.

Response point picker behavior:

- Point rows are identified by `runId + stageId + frequencyPointId`, not by
  rounded frequency label.
- Default sort follows sweep order. User sort is chart-local state.
- Each row shows frequency Hz, display GHz, status, selected observable,
  residual/iterations when available, field readiness, and resource revision.
- A point without field payload remains selectable for numeric inspection but
  disables `Plot in 3D` with `missing_field_payload`.
- A failed point can still open diagnostics; it cannot plot stale or missing
  field ids.

Peak plotting:

- source: peak table or modal-vs-driven comparison,
- selection: `results.frequency_domain.fmr_peak`,
- if linked `fieldId` exists, `Plot in 3D` dispatches the linked mode/point
  command,
- if peak is analytical only, action is disabled with `missing_field_payload`.

Peak picker behavior:

- Peak ids include `runId + stageId + source + fmrPeakIndex` and optional
  `peakFitId`.
- Peaks show frequency, amplitude/score, source family, linked mode/point ids,
  detuning when paired, and provenance (`backend_published | ui_derived`).
- Analytical-only peaks stay selectable for inspection and comparison, but 3D
  plot is enabled only through a linked mode/point with field payload.
- Pairing controls never auto-persist to artifacts; they are analysis view
  state unless a later backend artifact schema explicitly supports peak pairs.

Projection semantics:

- `real`: real component of complex XYZ response,
- `imag`: imaginary component,
- `abs`: vector/component magnitude of complex response,
- `phase`: phase field/scalar only when backend exposes meaningful phase,
- `phase_rotated_real`: `Re(response * exp(i phaseRad))`; default for
  phasor animation.

Command input validation:

- command refuses `fieldId` without matching `resourceRevision`,
- command refuses stale field meta unless user explicitly refreshes,
- command refuses basis not supported by the selected projection,
- peak command must resolve to a linked response point or eigen mode before it
  reaches `viewport-3d`,
- display commands are idempotent by `sourceKind + fieldId + resourceRevision`.

Overlay controls:

| Control | Command | Behavior |
|---|---|---|
| projection segmented control | `analysis.frequency-domain.set-3d-projection` | changes display projection only |
| phase slider/input | `analysis.frequency-domain.set-3d-phase` | updates uniforms/buffers, not topology |
| animation toggle/rate | `analysis.frequency-domain.set-3d-animation` | active only while viewport and overlay are mounted |
| stop button | `analysis.frequency-domain.stop-3d-animation` | stops phase animation |
| appearance controls | `analysis.frequency-domain.set-3d-appearance` | glyph scale, vector budget, opacity, colormap, geometry scope |
| clear button | `analysis.frequency-domain.clear-3d-overlay` | removes overlay, keeps base mesh |

3D readiness states:

- `overlay_ready`,
- `metadata_only`,
- `missing_field_payload`,
- `unsupported_component_basis`,
- `stale_field_revision`,
- `viewport_unmounted`,
- `webgl_unavailable`.

3D command result contract:

```typescript
export type AnalysisFieldDisplayCommandResult =
  | { status: "ready"; intent: AnalysisFieldDisplayIntent }
  | { status: "disabled"; reasonId: string; selection: FrequencyDomainSelectionRef }
  | { status: "stale"; reasonId: "stale_field_revision"; currentRevision: string; requestedRevision: string }
  | { status: "error"; reasonId: string; message: string };
```

The command layer returns one of these states before viewport code runs. The
viewport renders only `ready` intents or explicit nonblank reason panels.

Viewport behavior:

- `viewport-3d` loads field samples by `fieldId` through data-plane resources,
- `viewport-3d` validates drawing-buffer dimensions and WebGL context before
  reporting overlay ready,
- projection/phase changes do not reload topology,
- overlay label shows source, run/stage, frequency/mode, observable, lane,
  projection and phase,
- stale/missing payload shows reason instead of blank canvas,
- clear, session change, field invalidation and viewport unmount clean overlay
  runtime resources.

Overlay rendering options:

| Option | Allowed values | Notes |
|---|---|---|
| geometry scope | `magnetic_mesh`, `selected_object`, `periodic_cell` | unavailable scopes disabled by resource readiness |
| glyph mode | `arrows`, `cones`, `streamlines`, `surface_color` | Release 1 may ship arrows + surface color first |
| component | `x`, `y`, `z`, `vector`, `transverse`, `backend_default` | must match field basis metadata |
| projection | `real`, `imag`, `abs`, `phase`, `phase_rotated_real` | unsupported projections disabled with reason |
| normalization | `none`, `per_field`, `per_frame` | display only |
| vector budget | bounded numeric control | stable layout; no text overflow |
| opacity | slider | affects overlay only |
| colormap | token-backed option list | no raw hardcoded colors in component CSS |
| animation rate | bounded numeric Hz | respects reduced motion |

Viewport failure handling:

- If WebGL is unavailable, commands remain visible but report
  `webgl_unavailable`.
- If field meta exists but payload download fails, viewport shows the failed
  resource key and retry action, not a blank canvas.
- If the viewport tab is not mounted, plot command may pin the display intent
  and offer "Open 3D View"; it must not mount hidden WebGL.
- If resource revision changes under an active overlay, the overlay gets a
  stale badge and stops animation until refreshed.
- If a mode/point is from an unsupported lane, the plot command is disabled even
  if stale local field ids exist.

Browser acceptance:

- select mode -> plot 3D mode field -> canvas nonblank,
- select response point -> plot 3D response field -> canvas nonblank,
- select linked peak -> plot linked field,
- phase slider visibly changes field without topology reload,
- projection switch changes visible values/colors without changing selected
  field id or reloading topology,
- animation runs only while overlay is visible and viewport mounted,
- clear removes overlay and keeps base mesh,
- switching to `analysis-plots` unmounts `viewport-3d` without WebGL leak,
- switching back does not resurrect stale overlay unless display intent is
  intentionally pinned,
- field payload missing path is screenshot-tested so the UI shows a readable
  reason instead of a blank canvas.

#### M3.8 - UX, visual system and workflow

First-screen workflow:

1. Explorer shows `Study > Frequency response` and `Results > Frequency
   Domain` with readiness badges.
2. Right inspector shows stage authoring for stage selections and read-only
   inspectors for result/resource selections.
3. Center tabs are `3D View`, `FMR Overview`, `Driven Sweep`,
   `Modal Spectrum`, `Comparison`, `Diagnostics`.
4. Ribbon command groups are `Author`, `Plan`, `Run`, `Analysis`, `View`.
5. Bottom dock shows jobs, logs and diagnostics; it does not duplicate the
   stage form.

Ribbon commands:

- `Author`: commit draft, revert draft, validate stage,
- `Plan`: inspect capabilities, check periodic pairs,
- `Run`: run stage, cancel run, open job,
- `Analysis`: open plots, export table, plot selected in 3D,
- `View`: projection, phase, animation, appearance, clear overlay.

Inspector UX:

- compact sections: `Setup`, `Calculation`, `Equilibrium`, `Operator`,
  `Boundary`, `Periodic pairs`, `Excitation`, `Sweep`, `Solver`, `Outputs`,
  `Diagnostics`,
- stable row heights and tabular numeric columns,
- one primary action per section,
- destructive/re-run commands require dialog,
- table actions are icon buttons with tooltips,
- empty state names the missing resource/command.

Chart UX:

- axis units are always visible,
- raw SI values appear in tooltip,
- legend order is stable: modal, driven, peaks, diagnostics,
- hover shows point status and stale/partial markers,
- export goes through command/resource path, not DOM scraping.

3D UX:

- overlay controls are near viewport, inspector may show summary,
- projection switch does not reset camera,
- phase animation has visible stop and respects reduced motion,
- overlay label avoids axes/legend and collapses to compact status strip on
  narrow viewport,
- missing/stale payload explains reason.

Responsive behavior:

- desktop: left Explorer, center tabbed surface, right Inspector, bottom dock;
- laptop narrow: Inspector can collapse to right drawer but selection and
  draft state remain mounted only once;
- mobile/small viewport smoke: chart tabs remain usable, tables scroll inside
  their own region, no text overlaps controls, 3D overlay label collapses to
  a status strip;
- no UI surface relies on hover-only access to `Plot in 3D`, diagnostics or
  disabled reasons.

Design constraints:

- no marketing hero layouts,
- no nested cards in inspector/docks,
- no decorative gradients/orbs/glass panels,
- no oversized headings in inspector/docks,
- all module CSS classes use `fm-*`,
- components consume `--fm-*` tokens only,
- shared shadcn-style primitives for tabs, dialogs, dropdowns, switches,
  segmented controls, tooltips and menus,
- icon buttons have accessible labels and tooltips,
- keyboard order and focus rings are preserved.

Workflow-level acceptance:

- A user can reach every required action from Explorer, Inspector, chart table
  and ribbon without hidden hover-only controls.
- Stage authoring and result inspection are visually distinct: editable fields
  appear only for stage selections, while result/resource panels use read-only
  rows, links, actions and diagnostics.
- The same selected point/mode/peak is reflected consistently in Explorer,
  Inspector, charts and viewport overlay label through the kernel selection ref.
- Unsupported GPU/PBC, demag, nonzero-k, single precision and missing field
  payload states all have stable machine-readable reason ids in tests.
- No UI surface shows GPU static-periodic as available before capability/runtime
  evidence from M5.

#### M3.9 - Implementation slices and gates

Slice order:

1. API/OpenAPI/facade/resource hooks for FMR resources, including canonical
   `analysis/frequency-domain/response/...` paths and stale/partial states.
2. Shared frequency-domain read models, so inspectors and charts consume the
   same immutable result model.
3. Explorer taxonomy and serializable selection refs for every authoring,
   resource and result node.
4. Stage authoring draft model and `FrequencyResponseStageInspector` wired to
   canonical model transaction.
5. Dedicated read-only result/resource inspectors with explicit registry
   mapping and no generic fallback.
6. Shared chart models and `analysis-plots` tabs for overview, driven sweep,
   point detail, modal spectrum, mode detail, comparison and diagnostics.
7. 3D command contributions, display-intent controller, phase/projection
   controls and data-plane readiness gates.
8. Visual polish, accessibility, responsive screenshots and browser smoke.

Required tests by slice:

| Slice | Tests |
|---|---|
| API/resource | OpenAPI generation, facade tests, hook loading/stale/not_found/partial tests |
| Explorer | tree builder test, selection ref serialization test |
| Stage inspector | draft init, validation, commit patch, command enablement, unsupported reasons |
| Result inspectors | registry mapping, no generic fallback, partial artifacts, fallback failure |
| Charts | chart model empty/partial/stale/multi-observable/peaks/detuning tests |
| 3D overlay | command contribution tests, field meta readiness, projection/phase/animation tests |
| Cross-surface workflow | selection sync across Explorer, Inspector, charts and 3D overlay |
| Visual/browser | desktop/mobile screenshots, keyboard/focus smoke, nonblank WebGL canvas smoke |

Commands:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test src/modules/explorer/builders/frequencyDomainExplorerNodes.test.ts
pnpm --dir apps/control-room test src/modules/inspector/panels/stages/FrequencyResponseStageInspector.test.tsx
pnpm --dir apps/control-room test src/modules/inspector/inspectorRegistry.test.tsx
pnpm --dir apps/control-room test src/modules/inspector/panels/frequency-domain
pnpm --dir apps/control-room test src/shared/domain/analysis/frequencyDomainChartModels.test.ts
pnpm --dir apps/control-room test src/kernel/visualization/analysisFieldOverlayCommandContributions.test.ts
pnpm --dir apps/control-room test src/kernel/visualization/AnalysisFieldOverlayController.test.ts
pnpm --dir apps/control-room test src/modules/analysis-plots
pnpm --dir apps/control-room test src/modules/workspace/frequencyDomainWorkflow.test.tsx
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
```

Source hygiene:

```bash
rg "fetch\\(" apps/control-room/src
rg '"/v2/' apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src --glob '!src/kernel/api/generated/**'
rg "from ['\\\"]\\.\\./" apps/control-room/src/modules
rg "apps/web|ControlRoomContext|normalizeSession|mergeSession" apps/control-room/src
```

Browser smoke fixtures:

- `.fullmag/reports/frequency-domain-static-periodic-runtime`,
- `.fullmag/reports/frequency-domain-gpu-free-runtime`,
- `.fullmag/reports/frequency-domain-gpu-static-periodic-runtime` once M5 is
  closed,
- author stage -> validate readiness -> run command disabled/enabled,
- select response point -> plot 3D -> set phase -> animate -> clear,
- select eigen mode -> plot 3D -> switch to `analysis-plots` -> switch back
  without WebGL leak,
- partial artifacts: manifest exists, field payload missing, charts render
  numeric data and 3D action is disabled with reason.
- stale resource: sweep revision differs from field meta revision, inspector
  and charts show stale state and plot command is disabled until refresh.
- unsupported lane fixture: pre-M5 GPU PBC selected in stage inspector, run
  disabled with exact reason, result panels do not imply GPU PBC support.
- supported lane fixture after M5: GPU static-periodic selected with no demag,
  run enabled only from capability/resource evidence and result panels show
  `requested=production_gpu`, `resolved=production_gpu`,
  `validation_fallback_used=false`.

M3 completion definition:

- API/OpenAPI/facade/hooks expose all resources above,
- Explorer has all node kinds and stable selection refs,
- stage inspector authors driven FMR k=0 PBC through canonical transaction,
- result inspectors are dedicated per selection kind,
- `analysis-plots` selects modes, peaks and response points,
- 3D overlay path works only through command registry/data-plane payloads,
- UI uses `fm-*`, `--fm-*`, shared primitives and dense instrument layout,
- tests and browser smoke pass, or unrelated pre-existing failures are
  documented with exact file/test evidence.

#### M3.10 - UI execution backlog and done matrix

This is the execution order for the UI part. Do not start from visual React
panels. Start from contracts and pure models, then render.

| Step | Deliverable | Must include | Done when |
|---|---|---|---|
| 1 | resource facade slice | manifest, sweep, progress, solver diagnostics, point, field meta, periodic pairs hooks | hooks expose `ready`, `missing`, `partial`, `stale`, `unsupported` without component `fetch()` |
| 2 | frequency-domain read models | immutable manifest/sweep/point/field/diagnostics/mode/peak models | inspectors and charts can consume the same model fixtures |
| 3 | Explorer taxonomy | authoring/resource/result nodes and serializable refs | every node routes to a specific inspector or analysis surface |
| 4 | stage draft model | `FrequencyResponseStageDraft`, validation, commit patch snapshots | patch contains only canonical stage fields and revision guards |
| 5 | stage inspector UI | sectioned authoring panel with controlled inputs | edit/commit/revert/stale/invalid/run-disabled states are tested |
| 6 | read-only inspectors | dedicated manifest/sweep/point/field/diagnostics/pairs/mode/peak/comparison panels | no frequency-domain selection reaches generic JSON fallback |
| 7 | chart models | FMR overview, driven sweep, point detail, modal spectrum, mode detail, comparison, diagnostics | empty/partial/stale/failed/duplicate/peak fixtures render predictably |
| 8 | `analysis-plots` UI | tabbed analysis surface and optional bottom dock view | point/mode/peak clicks emit selection refs and plot commands |
| 9 | 3D display commands | plot mode, plot response point, plot linked peak, projection/phase/animation/clear | commands resolve field meta and fail with reason before viewport code |
| 10 | viewport overlay | `AnalysisFieldDisplayIntent` consumption and data-plane field rendering | canvas is nonblank for ready fields and shows reason for missing/stale fields |
| 11 | cross-surface sync | Explorer, inspector, charts, viewport label share one selection identity | selecting point/mode/peak updates all surfaces without direct module imports |
| 12 | visual/accessibility pass | dense layout, focus order, tooltips, responsive behavior | desktop/mobile screenshots show no overlap and no hover-only required action |

Stage inspector must ship these groups as separate, testable components:

| Group | Edits canonical stage? | Reads runtime/resource state? | Primary tests |
|---|---|---|---|
| `Setup` | yes | capabilities/status | requested vs resolved lane, GPU gated reason |
| `Calculation` | yes | capabilities | driven/modal availability, comparison is display-only |
| `Equilibrium` | yes | equilibrium/resource revisions | stale equilibrium blocks strict run |
| `Operator` | yes | capabilities | demag/DMI unsupported reasons remain visible |
| `Boundary` | yes | periodic pairs/k capability | periodic k=0 allowed, nonzero-k disabled |
| `Periodic pairs` | yes, pair ids only | periodic-pairs resource | table rows are not copied into draft |
| `Excitation` | yes | basis/material context if exposed | SI A/m/rad commit values |
| `Sweep` | yes | stage capability limits | Hz normalization, duplicate and invalid values |
| `Solver` | yes if public opts exist | diagnostics/capabilities | strict mode rejects fallback |
| `Outputs` | yes, requested artifacts only | artifact readiness | missing field disables 3D only |
| `Diagnostics` | no | planner/runtime diagnostics | links and reason ids, no mutation |

Read-only inspector done matrix:

| Inspector | Required non-happy state | Required action | Hard failure |
|---|---|---|---|
| manifest | `partial_artifacts` | open linked sweep/progress/diagnostics | raw JSON as primary view |
| sweep | `failed_run` or `stale_resource` | open chart, select point | editing frequencies |
| frequency points | `missing_field_payload` | select point, plot if ready | eager field payload load |
| point | `missing_field_payload` | plot field, open diagnostics | deriving field ids from numeric values |
| field | `stale_resource` | plot/copy id/refresh | decoding binary payload in render |
| diagnostics | `validation_fallback_used=true` | open failed point/copy reason | green completed state with fallback |
| periodic pairs | `stale_resource` | select/copy pair id | writing pair rows into stage |
| eigen mode | `missing_field_payload` | plot mode if ready | unstable id based on display label |
| FMR peak | analytical-only peak | inspect linked point/mode if present | enabling 3D without linked field |
| comparison | unmatched peaks | select paired/unmatched entries | silent nearest-frequency pairing |

Chart done matrix:

| Chart surface | Selection output | 3D action | Required degraded case |
|---|---|---|---|
| FMR overview | FMR peak or response point | plot linked field only when ready | peak exists without field payload |
| driven sweep | response point | plot selected point field | failed point remains visible |
| frequency point detail | response point/field | projection/phase plot | field meta ready, payload missing |
| modal spectrum | eigen mode | plot selected mode field | mode has no field payload |
| mode detail | eigen mode | projection/phase plot | real-only mode disables phase |
| modal vs driven | comparison row / peak / mode / point | plot linked mode or point | unmatched modes/peaks stay visible |
| diagnostics | failed point / diagnostics ref | no plot unless field exists | fallback flag highlighted |

3D mode-selection done matrix:

| Source | Required identity | Field readiness | Command result |
|---|---|---|---|
| response point | `runId + stageId + frequencyPointId + fieldId + revision` | point field meta + data-plane key | `analysis.frequency-response.plot-response-field-3d*` creates display intent |
| eigen mode | `runId + stageId + sampleIndex + rawModeIndex + fieldId + revision` | mode field meta + data-plane key | `analysis.eigen.plot-mode-3d*` creates display intent |
| FMR peak | `runId + stageId + source + fmrPeakIndex` plus linked point/mode | linked field readiness | delegates to response-point or eigen-mode plot command |

3D display controls must be command-backed:

- projection: `real`, `imag`, `abs`, `phase`, `phase_rotated_real`,
- component: `x`, `y`, `z`, `vector`, `transverse`, `backend_default`,
- phase: finite radians; disabled for real-only fields,
- animation: respects reduced motion and stops on stale resource/unmount,
- appearance: glyph mode, vector budget, opacity, normalization and colormap,
- clear: releases overlay resources without clearing selected chart row.

Final M3 frontend acceptance requires these proofs together:

```bash
pnpm --dir apps/control-room test src/modules/inspector/panels/stages/FrequencyResponseStageInspector.test.tsx
pnpm --dir apps/control-room test src/modules/inspector/inspectorRegistry.test.tsx
pnpm --dir apps/control-room test src/modules/inspector/panels/frequency-domain
pnpm --dir apps/control-room test src/shared/domain/analysis/frequencyDomainReadModels.test.ts
pnpm --dir apps/control-room test src/shared/domain/analysis/frequencyDomainChartModels.test.ts
pnpm --dir apps/control-room test src/kernel/visualization/AnalysisFieldOverlayController.test.ts
pnpm --dir apps/control-room test src/modules/analysis-plots
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Browser proof must include desktop and narrow viewport screenshots for:

- stage authoring with missing pairs,
- completed sweep with at least one point selectable,
- modal spectrum with one mode selectable,
- FMR peak table with linked and analytical-only peaks,
- 3D overlay ready, stale, missing-payload and WebGL-unavailable states,
- tab switch from `viewport-3d` to `analysis-plots` and back without hidden
  WebGL mount or leaked overlay animation.

#### M3.11 - UI PR breakdown

Implement M3 as small reviewable slices. Each PR must leave
`apps/control-room` shippable and must not introduce local mocks as a permanent
data source.

| PR | Scope | Must change | Must prove |
|---|---|---|---|
| UI-1 | Resource and selection spine | OpenAPI/facade/hooks, `FrequencyDomainSelectionRef`, Explorer nodes | hooks expose typed `ready/missing/partial/stale/unsupported`; every node serializes |
| UI-2 | Stage draft model | `frequencyResponseStageModel.ts`, fixtures, commit patch snapshots | canonical SI commit patch, stale revision handling, no result/display fields |
| UI-3 | Stage inspector UI | `FrequencyResponseStageInspector.tsx` and section components | controlled fields, disabled reasons, commit/revert/run command states |
| UI-4 | Read-only inspectors | inspector registry and dedicated `panels/frequency-domain/*` | no frequency-domain route hits generic JSON fallback; partial artifacts render useful rows |
| UI-5 | Chart/read model integration | `frequencyDomainReadModels.ts`, `frequencyDomainChartModels.ts`, `analysis-plots` panels | point/mode/peak selection, degraded fixtures, no chart-to-stage mutation |
| UI-6 | 3D display commands | overlay command contributions, controller, viewport display intent consumption | ready/missing/stale/unsupported command results before viewport code |
| UI-7 | Workflow/browser proof | Playwright/smoke fixtures and screenshots | author -> run -> inspect -> plot point/mode/peak -> phase/clear/tab-switch without WebGL leak |

Per-PR non-negotiables:

- No direct component `fetch()`.
- No module-local `/v2/...` endpoint strings.
- No cross-module imports between `inspector`, `analysis-plots`, `explorer`
  and `viewport-3d`.
- No hidden WebGL mount for inactive chart/viewport tabs.
- No raw artifact JSON as primary user experience.
- No GPU/PBC support claim without capability/runtime evidence.

UI-1 is the prerequisite for all later UI PRs. UI-5 and UI-6 may proceed in
parallel only after UI-1, UI-2 and UI-4 expose stable selection refs and result
read models.

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
- capability matrix nadal mowi, ze GPU static-periodic jest unsupported albo
  partial-only przed zamknieciem tego gate'u.

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
- UI pokazuje gotowosc periodic pairs, requested/resolved lane, sweep, peaks,
  selectable frequency points, selectable modal modes, action `Plot in 3D`,
  phase/view controls i 3D overlay z data-plane field payloadow. CPU
  static-periodic jest minimum Release 1; GPU static-periodic pojawia sie
  tylko po M5 i tylko z capability/runtime evidence.
- Browser smoke potwierdza: select mode -> plot 3D, select response point ->
  plot 3D, set phase, animate phase, clear overlay, switch tab bez WebGL leak.
- Export/round-trip zachowuje `FrequencyResponse` i `PeriodicBC`.
- GPU static-periodic jest w UI capability-gated: unavailable przed M5,
  available po M5 tylko gdy manifest/capability payload potwierdza
  `production_gpu`, static-periodic, no-demag i brak fallbacku.

Minimum produkcyjne dla GPU frequency response:

- Managed GPU recipe przechodzi.
- `response/diagnostics/solver.v1.json` ma
  `requested_execution_lane=production_gpu`,
  `resolved_execution_lane=production_gpu`,
  `validation_fallback_used=false`.
- Manifest i response artifacts sa kompletne.
- UI pokazuje GPU gamma/free jako osobny supported lane.
- PBC forced GPU jest dozwolone tylko dla k=0 static-periodic no-demag
  magnetic response z kompletnymi periodic pairs. Demag/DMI/nonzero-k forced
  GPU odrzucaja z czytelnym reason i bez fallbacku.

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
