# 06. Rejestr dowodów — odczyty wykonane w tej sesji

**Metoda.** Wszystkie pozycje sprawdzone bezpośrednio w drzewie roboczym
`C:\git\fullmag\fullmag` przez powłokę na komputerze użytkownika (`cat`, `sed -n`, `grep`,
`awk`, `git show`, `git rev-list`). Żaden odczyt nie pochodzi z pamięci modelu ani z
zewnętrznego serwisu. **Nie uruchamiano aplikacji, nie kompilowano, nie wykonywano testów
ani symulacji.** Istnienie struktury, enumu lub funkcji jest dowodem kontraktu w źródle,
a nie dowodem produkcyjnego działania.

**Baza.** Lokalny `HEAD = 33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8` (14.09.2026).
Deklarowana baza planu `31bac350a15c0af070287de92d4e0c1a6dabab0e` (15.09.2026).
Dla każdego pliku kluczowego porównano liczbę linii na obu commitach (D-00) — identyczne,
więc cytowania linia-w-linię są ważne dla obu stanów. Cytaty poniżej pochodzą z drzewa
roboczego.

---

## D-00 — porównanie bazy planu i lokalnego checkoutu

```text
git rev-parse HEAD                              -> 33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8
git log -1 31bac350a…                           -> Tue Sep 15 12:48:31 2026 +0200
                                                   "Merge pull request #94 …bimeron-rdmi-frozen-spins"
git merge-base --is-ancestor 31bac350a… HEAD    -> NO
git merge-base --is-ancestor HEAD 31bac350a…    -> YES
git rev-list --count HEAD..31bac350a…           -> 18
```

Porównanie `git show 31bac…:<plik> | wc -l` vs lokalne `wc -l` — **wszystkie identyczne**:

| plik | base | local |
|---|---:|---:|
| `crates/fullmag-authoring/src/scene.rs` | 1373 | 1373 |
| `crates/fullmag-authoring/src/builder.rs` | 1239 | 1239 |
| `crates/fullmag-authoring/src/physics_graph.rs` | 855 | 855 |
| `crates/fullmag-session/src/types.rs` | 552 | 552 |
| `crates/fullmag-cli/src/scratch_runtime.rs` | 469 | 469 |
| `crates/fullmag-cli/src/orchestrator.rs` | 16658 | 16658 |
| `crates/fullmag-runner/src/lib.rs` | 9647 | 9647 |
| `crates/fullmag-api/src/router_v2/handlers/persistence/session.rs` | 227 | 227 |
| `packages/fullmag-py/src/fullmag/world.py` | 9274 | 9274 |
| `packages/fullmag-py/src/fullmag/model/problem.py` | 3133 | 3133 |
| `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx` | 641 | 641 |
| `apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx` | 88 | 88 |
| `apps/control-room/src/kernel/layout/ViewportTabHost.tsx` | 89 | 89 |
| `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts` | 1101 | 1101 |
| `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` | 865 | 865 |
| `apps/control-room/src/kernel/events/EventBus.ts` | 37 | 37 |
| `crates/fullmag-runner/src/autosave_zarr.rs` | 485 | 485 |
| `Cargo.toml` | 42 | 42 |


### D-00a — stan drzewa roboczego w trakcie audytu

`crates/fullmag-api/src/main.rs` jest jedynym plikiem zmodyfikowanym względem `HEAD`
w drzewie roboczym w czasie audytu (`git diff --stat` → `5441 insertions(+), 5441
deletions(-)`, mtime `2026-09-20 09:12`). Liczba linii (**5441**) oraz numery linii
sprawdzanych fragmentów są **identyczne** z wersją na commicie bazowym planu
(`git show 31bac350a…:crates/fullmag-api/src/main.rs` → `normalize_scene_document_
study_pipeline_labels` w linii 3871, `let next_revision = snapshot` w linii 3947), co
wskazuje na zmianę zakończeń wierszy (CRLF↔LF), a nie na zmianę treści.
`git config core.autocrlf` nie jest ustawione; `.gitattributes` wymusza `eol=lf` tylko dla
wybranych wzorców. Pozostałe pliki cytowane w tym rejestrze (`store.rs`,
`scratch_runtime.rs`, `ViewportTabHost.tsx` i inne sprawdzone) nie wykazują różnic
względem `HEAD`.

**Praktyczna konsekwencja:** przy odtwarzaniu tych odczytów należy porównywać treść,
a nie sumy kontrolne pliku; numery linii pozostają ważne.

---

## D-01 — `Cargo.toml` (42 linie)

`members` (linie 2–19): `apps/desktop/src-tauri`, `crates/fullmag-authoring`,
`fullmag-api`, `fullmag-bench`, `fullmag-build-info`, `fullmag-cli`, `fullmag-engine`,
`fullmag-fdm-demag`, `fullmag-fdm-sys`, `fullmag-fem-sys`, `fullmag-ir`, `fullmag-plan`,
`fullmag-py-core`, `fullmag-quantities`, `fullmag-runner`, `fullmag-session`.
**Brak `fullmag-application`.** Potwierdza E16; koryguje zakres linii (plan podaje 1–160).

---

## D-02 — `SceneDocument`

`crates/fullmag-authoring/src/scene.rs:14-55`. Pola m.in.: `version`(16), `revision`(18),
`scene`(20), `universe`(22), `objects`(24), `couplings`(26), `materials`(28),
`magnetization_assets`(30), `field_drives`(32), `monitors`(34), `selections`(36),
`magnetization_constraints`(38), `current_modules`(40), `current_transports`(42),
`spin_transports`(44), `spin_torques`(46), `oersted_fields`(48), **`study`(50)**,
`outputs`(52), **`editor`(54)**.

---

## D-03 — `SceneStudyState`

`scene.rs:290-333`. Zawiera jednocześnie: `backend`, `requested_backend`,
`requested_device`, `requested_precision`, `requested_mode`, `requested_cpu_threads`,
`fem_demag_solver_policy`, `exchange_enabled`, `demag_enabled`, `demag_realization`,
`fdm`, `external_field`, `rotated_interfacial_dmi`, `solver`, `universe_mesh`,
`shared_domain_mesh`, `mesh_defaults`, `mesh_interfaces`, `stages`, `study_pipeline`,
`initial_state`.

---

## D-04 — `SceneEditorState` i preferencje widoku

`scene.rs:567-591` — `selected_object_id`, `gizmo_mode`, `transform_space`,
`selected_entity_id`, `focused_entity_id`, `object_view_mode`, `air_mesh_visible`,
`air_mesh_opacity`, `mesh_entity_view_state`, `visualization_presets`,
`active_visualization_preset_ref`, `active_transform_scope`.

`VisualizationPresetFemState` — `scene.rs:420`; `opacity`(423), `clip_pos`(429),
`arrow_mono_color`(437), `air_mesh_visible`(448), `air_mesh_opacity`(449).
`VisualizationPreset` — `scene.rs:543`, `pub camera: VisualizationCameraState`(559).
`VisualizationCameraState` — `scene.rs:400`.

**Koryguje** cytowanie Gemini („SceneEditorState w liniach 419–453”).

---

## D-05 — bezwarunkowa inkrementacja rewizji sceny

`crates/fullmag-api/src/main.rs:3947-3953`
```rust
let next_revision = snapshot.scene_document.as_ref()
    .map(|current_scene| current_scene.revision.saturating_add(1))
    .unwrap_or_else(|| scene_document.revision.saturating_add(1));
scene_document.version = "scene.v2".to_string();
scene_document.revision = next_revision;
```
Handler zwraca też `ApiError::not_found("no active local live workspace")` (`main.rs:3925`)
i sprawdza `scene_stale_revision` (`main.rs:3927-3932`).
Klasyfikator wpływu: `main.rs:3935-3945` →
`fullmag_authoring::classify_region_realization_impact`.

---

## D-06 — `Transform3D` vs `GeometryEntryIR`

`scene.rs:165-174`: `translation`, `rotation_quat`, `scale`, `pivot`.
`crates/fullmag-ir/src/model.rs:40-130`: `ImportedGeometry`(40), `Box`(47), `Cylinder`(51),
`SinWaveguide`(57), `ArchWaveguide`(69), `Ellipsoid`(78), `Sphere`(82), `Ellipse`(86),
`Difference`(91), `Union`(96), `Intersection`(101), `Translate`(106).
**Brak `Rotate` i `Scale`.**

---

## D-07 — `StudyPrimitiveStageKind` / `StudyMacroStageKind` / payloady

`crates/fullmag-authoring/src/builder.rs`:
- `StudyPrimitiveStageKind` — **325-342**: `Relax`, `Run`, `Eigenmodes`,
  `FrequencyResponse`, `Hysteresis`, `ChangeDevice`, `AddFieldDrive`, `RemoveFieldDrive`,
  `TableAutosave`, `Autosave`, `FftResponse`, `SetField`, `SetCurrent`, `SaveState`,
  `LoadState`, `Export`.
- `StudyMacroStageKind` — **367-374**: `HysteresisLoop`, `FieldSweepRelax`,
  `FieldSweepRelaxSnapshot`, `RelaxRun`, `RelaxEigenmodes`, `ParameterSweep`.
- `StudyPipelineNodeSource` — 378-382.
- `PrimitiveStageNode.payload: BTreeMap<String, Value>` — **396**.
- `MacroStageNode.config` — **411**.

---

## D-08 — endpointy persystencji

`crates/fullmag-api/src/router_v2/handlers/persistence/session.rs` — 12 ścieżek
w liniach 22, 39, 55, 75, 90, 109, 127, 149, 167, 185, 203, 217; wszystkie
`/v2/sessions/current/persistence/*`; odpowiedzi zawierają `404 "No active workspace"`.

---

## D-09 — skala powierzchni API v2

```text
grep -rh 'path = "/v2/' crates/fullmag-api/src/router_v2/handlers --include=*.rs
  /v2/sessions/current/*          288
  /v2/sessions/<inne>               0
  /v2/platform/*                    5
  razem                           293
```

---

## D-10 — rozkład literału `sessions/current` w repozytorium

```text
apps/control-room/src        : 22 pliki / 1235 wystąpień
   z tego produkcyjne, nie-generowane: 2
     kernel/api/apiPaths.ts
     kernel/visualization/VisualizationRegistrySyncController.ts
   pozostałe: generated/openapi-v2-{json,types,paths} (3×239) i pliki *.test.*
crates/ (*.rs)               : 59 plików
   w tym crates/fullmag-runner/src: 54 wystąpienia
scripts/                     : 64 pliki
apps/control-room/scripts/   : 43 pliki
```

`kernel/api/apiPaths.ts` — 995 linii, zasilany z `generated/openapi-v2-paths.ts`.

---

## D-11 — `PhysicsGraphIR`

`crates/fullmag-authoring/src/physics_graph.rs`:
`PhysicsScopeRef` — 19-39 (`Global`, `Object`, `Region`, `Interface`, `CrossObject`,
`Unresolved { reason, source_path }`);
`PhysicsActivation` — 43-50 (`Configured`, `Active`, `Inactive`, `Blocked`, `Unsupported`,
`Unresolved`); `PhysicsModulePresentation` — 53.

---

## D-12 — `fullmag-session/src/types.rs`

`SaveProfile`(15), `RestoreClass`(33), `FmsSessionManifest`(48),
**`run_refs: Vec<String>`(67)**, `CheckpointCompatibility`(304),
`TensorDescriptor`(373-382), **`TensorDtype`(408-414): `U8, I32, U32, F32, F64`**,
`TensorChunk`(427-433: `object_ref`, `offset`, `length`, `sha256: Option<String>`),
`FieldRef.tensor_descriptor_ref`(442), `FieldRole`(447-453),
`BackendStatePayload`(459).

---

## D-13 — API `SessionStore`

`crates/fullmag-session/src/store.rs` (481 linii): `open`(33), `cas`(46),
`commit_session`(53), `current_session`(67), `commit_run`(89), `read_run`(99),
`commit_checkpoint`(115), `latest_checkpoint`(138), `list_checkpoints`(144),
`read_checkpoint`(168), `store_magnetization`(190), `load_magnetization`(196),
`store_blob`(204), `write_document`(211), `read_document`(220), `write_recovery`(231),
`list_recovery`(241), `clear_recovery`(260), `try_lock`(274), `unlock`(304),
`collect_live_refs`(315), `gc`(343).

---

## D-14 — defekt GC

`store.rs:315-338` — `collect_live_refs` czyta wyłącznie
`runs/<run>/checkpoints/<cp>/checkpoint.json` i wstawia `field_ref.tensor_descriptor_ref`.
Nie dereferencjonuje `TensorDescriptor.chunks[].object_ref` (`types.rs:381, 428`).

`cas.rs:92-107` — `gc` usuwa **każdy** plik z `objects/sha256/`, którego nazwa nie jest
w `live_refs`.

Ścieżka użytkownika: `crates/fullmag-cli/src/main.rs:467-472`
(`SessionSubcommand::Gc { store } => { … ss.gc()?; println!("Garbage collection complete …") }`)
— brak `--dry-run`, brak potwierdzenia.

---

## D-15 — brak `fsync`

`store.rs:352-358`
```rust
fn atomic_write(dest: &Path, data: &[u8]) -> Result<()> {
    let temp = dest.with_extension("part");
    fs::write(&temp, data)?;
    fs::rename(&temp, dest)?;
    Ok(())
}
```
`cas.rs:36-46` — `File::create` → `write_all` → **`flush()`** → `rename`.
Brak `sync_all()` na pliku i brak fsync katalogu w obu miejscach.
`commit_checkpoint` (`store.rs:115-136`) — dwa niezależne `atomic_write`
(`checkpoint.json`, potem `common_state.json`).

---

## D-16 — `CasStore` — model kosztu

`cas.rs:1-5` — układ `objects/sha256/<hex>`.
`cas.rs:29-47` — `put(&self, data: &[u8])`, `hex_sha256(data)` — cały blob w pamięci.
`cas.rs:56-68` — `get` wykonuje `fs::read` całości **i ponownie liczy SHA-256**
przy każdym odczycie (`"CAS integrity error: expected {hash}, got {actual}"`).
`cas.rs:115-117` — `hex_sha256` przez `sha2::Sha256::digest`.

---

## D-17 — blokada workspace

`store.rs:274-301` — `try_lock` czyta `LOCK`, deserializuje `SessionFileLock`,
sprawdza `is_pid_alive(lock.pid)`; przy martwym PID **usuwa blokadę** („removing stale
session lock”), mimo że struktura przechowuje także `host`.

---

## D-18 — `scratch_runtime`

`crates/fullmag-cli/src/scratch_runtime.rs`:
- 130-139 — `session_changed` / `backend_changed` / `scene_changed`
  (`attached_scene_revision.zip(scene_revision).is_some_and(|(a,c)| a != c)`).
- 140-165 — `terminate_child(&mut child)` + `pending_failure = "scratch runtime ownership
  changed while a command was active"` / `"… before command acknowledgement"`.
- 195-228 — spawn tylko gdy `child.is_none()`, backend `fdm|fem` i istnieje
  `pending_compute_command`; podwójne sprawdzenie `current_session_matches`.
- 421-434 — `render_current_scene` = `POST {api_base}/v2/sessions/current/model/syncs`.
- 436-461 — `spawn_attached_runtime` = `Command::new(executable).arg(script_path)
  .arg("--interactive")…spawn()`.
- 463-469 — `terminate_child` = `kill()` + `wait()`.

Miejsca uruchomienia: `crates/fullmag-cli/src/main.rs:507-513` (UI bez skryptu),
`crates/fullmag-cli/src/orchestrator.rs:6933-6935` (sesja script-backed; komentarz
w kodzie 6929-6931: *„The bridge ignores this script-backed session and only attaches a
fresh runtime after the browser explicitly replaces it with a runnable scene.”*).

---

## D-19 — pętla render→dysk→Python (dwa starty interpretera)

`crates/fullmag-api/src/router_v2/handlers/model/authoring.rs:3392-3409` —
`path = "/v2/sessions/current/model/syncs"`, opis odpowiedzi:
*„Canonical Python rewritten from authoring state”*.

`crates/fullmag-api/src/script.rs:36-96` — `sync_current_live_script_with_request`;
404 `"no active local live workspace"`(45); ścieżka wyjściowa
`workspace_root.join("scene_document.py")`(51); wywołanie
`rewrite_script_via_python_helper`(78) albo `render_scene_document_via_python_helper`(90).

`script.rs:205-245` — `render_scene_document_via_python_helper`:
zapis `scene-export-<uuid>.json` na dysk (213-219), argumenty
`["-m", "fullmag.runtime.helper", "render-scene-document", "--scene-json", …, "--output", …]`
(220-228), `run_python_helper`(229).
`script.rs:306`, `343` — `run_python_helper` → `ProcessCommand::new(&candidate)`.

**Łańcuch:** SceneDocument → JSON na dysk → **proces Pythona #1** (render `.py`) →
`scratch_runtime` → **proces Pythona #2** (`fullmag <script>.py --interactive`) →
`ProblemIR` → runner.

---

## D-20 — `resource_key` w manifestach runnera

`crates/fullmag-runner/src/eigen/artifacts/common.rs:346-350`
```rust
pub(super) fn eigen_mode_field_resource_key(mode_field_id: &str) -> String {
    format!("/v2/sessions/current/data/fields/{mode_field_id}/samples/vector?view=phase_rotated_real&phase_rad=0")
}
```
`common.rs:226-235` — dziesięć pól `*_resource_key` w strukturze manifestu.
`field_sweep.rs:35, 172-173` — `mode_field_resource_key` zapisywany do artefaktu.
`fmr.rs:1363-1380` — `spectrum_resource_key`, `branches_resource_key`,
`dispersion_resource_key`, `diagnostics_resource_key`, `eigen_diagnostics_resource_key`,
`response_sweep_resource_key` i dalsze, wypełniane literałami `/v2/sessions/current/…`.
`crates/fullmag-runner/src/lib.rs:9031` — asercja testowa potwierdzająca obecność takiego
klucza w `family_manifest["resources"]`.

---

## D-21 — gate startowy i powłoka

`apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx` (641 linii):
`WorkspaceStartupGateView` — **594-616**; `preparationDuringRealtimeDisruption` — 583-592;
`SimulationStartupDiagnosticsDock` — 618-635; `isVisible` używane w 74, 117, 448, 454, 502,
526, 601.

`apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx` (88 linii):
`if (sessions.state !== "ready")` — 17-28; `EmptyWorkspace` — 21;
`ActiveWorkspaceShell` — 70-88, `<WorkspaceStartupGateView state={startupState}>` — 76,
dzieci: `SlotHost "ribbon"`(77), `WorkspaceDockLayout`(79), `SlotHost "status-bar"`(81),
host overlayów(82-84).

`apps/control-room/src/kernel/layout/EmptyWorkspace.tsx:7-26` — jedyną treścią jest
nagłówek „Create a simulation” i przycisk uruchamiający komendę `workspace.new-problem`.

---

## D-22 — `ViewportTabHost` i ADR-0016

`apps/control-room/src/kernel/layout/ViewportTabHost.tsx` (89 linii):
`selectActiveViewportModule` — 13-22; render aktywnego modułu — **74-81**
(`<MountedModule key={activeModule.id} … manifest={activeModule} slotId="viewport-main" />`).
Renderowany jest **wyłącznie** `activeModule`, nie lista modułów.

`docs/adr/0016-center-viewport-tabbed-surfaces.md`, status **accepted** (2026-05-30,
amended 2026-08-03):
- *Decision:* „`viewport-main` becomes a tabbed center surface host. The active center
  surface is the only mounted heavy visualization module.”
- *Consequences:* „Switching to a non-3D center tab **must unmount** `Viewport3DModule`;
  hiding it with CSS is **not sufficient**.” / „Inactive center tabs must not keep resource
  hooks, WebGL canvases, animation frames, object URLs, workers, or large render buffers
  alive.”
- *Implementation Obligations:* „Add a generic `ViewportTabHost` … **mounts only the active
  manifest**.”
- *Rollback:* „Reintroducing live WebGL 2D rendering would require a new ADR and the same
  active-only lifecycle proof as `viewport-3d`.”

Strażnik CI: `apps/control-room/scripts/audit-viewport-main-tab-memory.mjs`
- `THREE_D_CANVAS_SELECTOR = ".fm-viewport-3d canvas"` (20)
- `assertInactiveTabObservation` — **397-430**; warunek błędu:
  `if (observation.canvasCount > 0 || observation.rootCount > 0)` → `"3D DOM remains
  mounted (canvas=…, root=…)"` (404-408); dalej `threeDRequests`(409),
  `viewport3DRenderMeasuresDelta`(416), `clientAckRequestsDelta`(421),
  `workerJobsDelta`(426).

---

## D-23 — architektura stanu Control Room

`apps/control-room/package.json`: brak `zustand`; `next` 16.2.11 (93),
`react` 19.2.4 (95), `react-dom` 19.2.4 (96), `three` ^0.183.2 (100).
`kernel/resources/ResourceRuntimeStore.ts` — 865 linii.
`kernel/events/EventBus.ts` — 37 linii.
`modules/explorer/builders/sceneModelTreeAdapter.ts` — 1101 linii.

`kernel/resources/sessionResourceIdentity.ts:3-6, 31-36`
```ts
export interface SessionResourceIdentity { readonly sessionId: string; readonly sessionEpoch: string; }
export function sessionScopedResourceKey(identity, resourceKey) {
  return `session=${encodeURIComponent(identity.sessionId)}&epoch=${encodeURIComponent(identity.sessionEpoch)}|${resourceKey}`;
}
```

---

## D-24 — Python

`packages/fullmag-py/src/fullmag/world.py:2488-2489`
```python
# Module-level singleton
_state = _WorldState()
```
`world.py:3596-3598` — `def reset(): global _state; _state = _WorldState()`.
Plik: 9274 linie.

`packages/fullmag-py/src/fullmag/model/problem.py:161-194` —
`_fem_cache_contract_identity()` zwraca `source_snapshot_sha256`,
`source_compatibility_epoch = "fullmag.fem.meshing.production-closure.2026-08-31.v1"`,
`gmsh_version`, `gmsh_threads`, `repair_algorithm_id`, `repair_method`,
`repair_iterations`, `certifier_algorithm_id`, `artifact_schema`,
`topology_fingerprint_version = "v3"`, opcjonalnie `resolved_policy_sha256`.
Użycia: `problem.py:705`, `problem.py:1194`.

---

## D-25 — `fullmag-plan` i `fullmag-quantities`

`crates/fullmag-plan/src/` — 27 modułów, **51 082 linie** łącznie (m.in. `fdm.rs`,
`fem.rs`, `geometry.rs`, `mesh.rs`, `physics_graph.rs`, `quantities.rs`, `selection/`,
`validate.rs` 1046 linii).

`crates/fullmag-quantities/src/` — **3 033 linie**: `catalog.rs`, `descriptor.rs`,
`eval.rs`, `id.rs`, `lib.rs`, `provider.rs`, `reduction.rs`, `registry.rs`,
`schema_version.rs`, `step_data.rs`, `transport.rs`.
**Nie występuje w mapie pakietów `03-migracja.md` §2.**

---

## D-26 — istniejący klasyfikator unieważnień

`crates/fullmag-authoring/src/region_revisions.rs:23-33`
```rust
pub struct RegionRealizationImpact {
    pub topology: bool,
    pub membership: bool,
    pub coefficients: bool,
    pub initial_state: bool,
}
```
`region_revisions.rs:57` — `pub fn classify_region_realization_impact(...)`.
Wywołanie produkcyjne: `crates/fullmag-api/src/main.rs:3935-3945`.

---

## D-27 — korpus ADR

`docs/adr/` — **34 pliki**. Statusy (odczytane z nagłówków): 0001-0012 accepted,
0013 proposed, 0014 proposed, 0015 „Accepted for active migration only”, 0016 accepted,
0017 proposed, 0018 accepted, 0019(×2: accepted / proposed), 0020 accepted,
0021(×2: „accepted for implementation” / accepted), 0022 accepted,
0023(×2: accepted / accepted), 0024 accepted, 0025 accepted,
0026 „zaakceptowany projekt implementacyjny”, 0027-0031 „accepted for implementation”.

**Zduplikowane numery:** 0019, 0021, 0023.

Cytaty istotne dla planu:
- **ADR-0009** (accepted), macierz *Region edits*:
  `material override → FDM grid: unchanged | FEM mesh: unchanged | membership: unchanged |
  coefficients: stale | initial state: unchanged`.
- **ADR-0010** (accepted), *Exception*: *„If a future magnetization feature affects
  discretization requirements … that specific feature must opt-in to mesh invalidation
  explicitly. The default path does not invalidate mesh.”*
- **ADR-0025** (accepted), D-04: definicje `AcceptedStateId { run_id, stage_id,
  accepted_step, clock_digest, state_digest, domain_digest, plan_digest }`,
  `AcceptedStateGeneration { runtime_epoch, accepted_revision }`, `AcceptedStateRef`;
  D-01 `LiveRuntime` rezydentny; D-03 izolowany `ObservationRuntime`.
- **ADR-0030** (accepted for implementation): `project root`, `project storage root`
  = `C:\git\fullmag\storage`, `FULLMAG_PROJECT_STORAGE_ROOT`, `storage/runs/<worktree-id>/`,
  *„Prune domyślnie wykonuje dry-run.”*

**Weryfikacja implementacji ADR-0025:** `grep -rln "AcceptedStateId\|AcceptedStateRef"
crates --include=*.rs` → **brak trafień**; `ObservationRuntime` → brak trafień;
`runtime_epoch` → **0 wystąpień**. `LiveRuntime` występuje w `fullmag-api`
(`main.rs`, `session.rs`, `types.rs`) i `fullmag-cli` (`control_room.rs`,
`live_workspace.rs`, `types.rs`).

---

## D-28 — pliki wskazane w mapie migracji (`03-migracja.md` §3)

Wszystkie istnieją: `scene.rs`, `builder.rs`, `physics_graph.rs`, `adapters.rs`,
`world.py`, `model/problem.py`, `orchestrator.rs`, `scratch_runtime.rs`,
`simulation_preparation.rs`, `WorkspaceShellClient.tsx`, `SimulationStartupOverlay.tsx`,
`KernelProvider.tsx`; katalogi `kernel/resources`, `modules/viewport-3d`,
`modules/field-map`, `apps/desktop`, `crates/fullmag-py-core`, `packages/fullmag-py`.

Skala: `apps/control-room/src` — **1541** plików `.ts`/`.tsx`; `crates/` — **586** plików
`.rs`; `apps/control-room/scripts/` — 72 pozycje.

---

## Czego NIE zweryfikowano

- Zachowania w czasie wykonania (aplikacja nie była uruchamiana).
- Poprawności numerycznej jakiejkolwiek ścieżki fizycznej.
- Rzeczywistego narzutu czasowego pętli `scratch_runtime` — mechanizm potwierdzony,
  wielkość **niezmierzona**.
- Faktycznego zużycia VRAM/RAM przez meshing i solvery — **niezmierzone**.
- Czy `fullmag session gc` był kiedykolwiek wywołany na danych produkcyjnych — sprawdzono
  wyłącznie istnienie i osiągalność ścieżki kodu.
- Stanu gałęzi zdalnej `origin/master` — porównanie dotyczy lokalnych obiektów git.
