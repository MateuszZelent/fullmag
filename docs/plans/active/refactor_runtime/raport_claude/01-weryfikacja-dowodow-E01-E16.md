# 01. Niezależna weryfikacja dowodów E01–E16

Każdy punkt sprawdzony przeze mnie w lokalnym drzewie źródeł. Ponieważ lokalny `HEAD`
(`33aa26fe8`) jest 18 commitów za bazą planu (`31bac350a`), dla każdego pliku porównałem
najpierw treść `git show 31bac...:<plik>` z treścią lokalną — wszystkie sprawdzane pliki
są **identyczne** na obu commitach, więc cytaty linia-w-linię są ważne dla obu.

Legenda ocen:
- **POTWIERDZONE** — twierdzenie prawdziwe, cytowanie prawidłowe.
- **POTWIERDZONE / cytowanie do poprawy** — teza prawdziwa, zakres linii błędny.
- **POTWIERDZONE I WZMOCNIONE** — teza prawdziwa, a rzeczywistość jest „gorsza” niż opisano.

---

## E01 — baza odczytu

**Teza planu:** baza to `31bac350a15c0af070287de92d4e0c1a6dabab0e` na `master`, commit
z 15 września 2026.

**Weryfikacja:**
```text
git log -1 --format='%H|%ad|%s' 31bac350a15c0af070287de92d4e0c1a6dabab0e
31bac350a15c0af070287de92d4e0c1a6dabab0e|Tue Sep 15 12:48:31 2026 +0200|
  Merge pull request #94 from MateuszZelent/codex/bimeron-rdmi-frozen-spins
```

**Ocena: POTWIERDZONE.** Commit istnieje, data zgadza się z deklaracją planu.

**Uwaga krytyczna — nie do planu, lecz do raportu Gemini:** lokalny checkout **nie stoi**
na tym commicie. `HEAD = 33aa26fe8` z 14 września, 18 commitów wcześniej. Twierdzenie
Gemini *„Repozytorium znajduje się na commicie 31bac...”* jest fałszywe.
Konsekwencja praktyczna opisana w `00-werdykt-i-podsumowanie.md` §2.

---

## E02 — `SceneDocument` i `SceneStudyState`

**Teza:** `SceneDocument` jest zbyt szerokim korzeniem; zawiera pojedynczy `study`
i stan edytora; `SceneObject` ma wymaganą referencję materiału; pola rotacji/skali w DTO
nie dowodzą ich obsługi przez backendy.

**Weryfikacja (`crates/fullmag-authoring/src/scene.rs`):**

| Element | Linie | Stan |
|---|---|---|
| `pub struct SceneDocument` | 14–55 | zgodne |
| `pub study: SceneStudyState` | **50** | pojedynczy, nie kolekcja — zgodne |
| `pub editor: SceneEditorState` | **54** | zgodne |
| `pub struct SceneStudyState` | 290–333 | zawiera `requested_backend`, `requested_device`, `requested_precision`, `requested_mode`, `fem_demag_solver_policy`, `fdm`, `solver`, `shared_domain_mesh`, `mesh_defaults`, `stages`, `study_pipeline`, `initial_state` — fizyka + mesh + solver + runtime intent w jednym |
| `pub struct SceneEditorState` | **567**–591 | `selected_object_id`, `gizmo_mode`, `air_mesh_visible`, `air_mesh_opacity`, `visualization_presets`, `active_visualization_preset_ref` |
| `VisualizationPresetFemState` | 420–476 | `opacity` (423), `clip_pos` (429), `arrow_mono_color` (437) |
| `VisualizationCameraState` w presecie | 559 (`pub camera:`) | stan kamery **jest** częścią `SceneDocument` |
| `Transform3D` | 165–174 | `translation`, `rotation_quat`, `scale`, `pivot` |

**Ocena: POTWIERDZONE.**

**Sprostowanie do raportu Gemini:** Gemini przypisuje `opacity`/`clip_pos`/
`arrow_mono_color` liniom „419–453” jako polom `SceneEditorState`. Te pola należą do
`VisualizationPresetFemState` (struct od linii 420), zagnieżdżonego w `VisualizationPreset`
(543), który jest polem `SceneEditorState.visualization_presets`. Teza merytoryczna
(preferencje widoku są w dokumencie modelu) pozostaje prawdziwa; atrybucja linii jest
nieprecyzyjna.

**Uzupełnienie, którego brakuje w obu dokumentach — dowód na inkrementację rewizji:**
`crates/fullmag-api/src/main.rs:3947-3953`:
```rust
let next_revision = snapshot
    .scene_document
    .as_ref()
    .map(|current_scene| current_scene.revision.saturating_add(1))
    .unwrap_or_else(|| scene_document.revision.saturating_add(1));
scene_document.version = "scene.v2".to_string();
scene_document.revision = next_revision;
```
Rewizja jest podbijana **bezwarunkowo przy każdym PUT sceny**, bez rozróżnienia, czy
zmiana dotyczyła fizyki, czy stanu edytora. Dodatkowo handler zwraca 404
`"no active local live workspace"` (main.rs:3925) — czyli synchronizacja modelu w ogóle
nie działa bez aktywnej sesji. To jest twardszy dowód niż cytowanie samej struktury.

**Asymetria DTO ↔ IR (potwierdza §8.1 planu):** `Transform3D` niesie `rotation_quat` i
`scale`, natomiast `GeometryEntryIR` (`crates/fullmag-ir/src/model.rs:40-130`) zna wyłącznie
`ImportedGeometry`, `Box`, `Cylinder`, `SinWaveguide`, `ArchWaveguide`, `Ellipsoid`,
`Sphere`, `Ellipse`, `Difference`, `Union`, `Intersection`, `Translate`.
**Nie ma `Rotate` ani `Scale`.** Ostrzeżenie planu jest więc nie tylko trafne, ale opisuje
istniejącą, konkretną dziurę w lowering.

---

## E03 — studies, makra, nietypowane payloady

**Weryfikacja (`crates/fullmag-authoring/src/builder.rs`):**

- `pub enum StudyPrimitiveStageKind` — linie **325–342**: `Relax`, `Run`, `Eigenmodes`,
  `FrequencyResponse`, `Hysteresis`, `ChangeDevice`, `AddFieldDrive`, `RemoveFieldDrive`,
  `TableAutosave`, `Autosave`, `FftResponse`, `SetField`, `SetCurrent`, `SaveState`,
  `LoadState`, `Export`.
- `pub enum StudyMacroStageKind` — linie **367–374**: `HysteresisLoop`, `FieldSweepRelax`,
  `FieldSweepRelaxSnapshot`, `RelaxRun`, `RelaxEigenmodes`, `ParameterSweep`.
- `PrimitiveStageNode.payload: BTreeMap<String, Value>` — linia **396**.
- `MacroStageNode.config: BTreeMap<String, Value>` — linia **411**.
- `StudyPipelineNodeSource` — linie 378–382: `UiAuthored`, `ScriptImported`, `MacroGenerated`.

**Ocena: POTWIERDZONE.** Teza planu o mieszaniu intencji badawczej z komendami runtime'u
jest dosłownie widoczna w jednym enumie: `Relax` (krok fizyczny) obok `ChangeDevice`
(operacja sprzętowa) i `Export` (operacja I/O).

**Drobna nieścisłość planu:** E03 wymienia `ParameterSweep` wśród „rodzajów”
`StudyPipelineDocument` bez zaznaczenia, że jest to **makro**, nie prymityw. Bez znaczenia
dla wniosków, ale w P3 mapowanie prymityw↔makro będzie miało znaczenie i warto to rozdzielić
już w dokumencie.

**Cytowanie Gemini** („`builder.rs#L350-L436`”) wskazuje na `impl ... ALL` i struktury
węzłów, a nie na definicję enuma (325). Poprawne cytowanie to **325–342** dla enuma
i **385–412** dla węzłów.

---

## E04 — persystencja wokół `sessions/current`

**Weryfikacja (`crates/fullmag-api/src/router_v2/handlers/persistence/session.rs`):**
12 ścieżek, wszystkie pod `/v2/sessions/current/persistence/*`, linie 22, 39, 55, 75, 90,
109, 127, 149, 167, 185, 203, 217. Odpowiedzi zawierają `404 "No active workspace"`.

**Ocena: POTWIERDZONE I WZMOCNIONE.**

Rozszerzyłem pomiar na cały router v2:

```text
grep -rh 'path = "/v2/' crates/fullmag-api/src/router_v2/handlers --include=*.rs
  /v2/sessions/current/*  : 288
  /v2/sessions/<inne>     :   0
  pozostałe (/v2/platform):   5
```

**Nie istnieje ani jeden endpoint adresowany identyfikatorem sesji.** Cała powierzchnia
kontrolna (289 z 293 ścieżek) jest przypięta do niejawnego globalnego „current”.
To jest istotnie mocniejsze stwierdzenie niż to, które plan wyprowadza z jednego pliku,
i ma bezpośrednie konsekwencje dla oceny §22 („ograniczony adapter zgodności”) —
patrz luka **L5** w `03-luki-i-bledy-planu.md`.

**Dowód dopełniający po stronie UI:** `apps/control-room/src/kernel/layout/
WorkspaceShellClient.tsx:17-28` — gdy `sessions.state === "no-session"`, cała powłoka jest
zastąpiona przez `EmptyWorkspace`, którego jedyną treścią jest przycisk
„Create simulation” (`EmptyWorkspace.tsx:16-25`). Scenariusz **CAE-01** jest dziś
nie „ograniczony”, tylko **niewykonalny**.

---

## E05 — `PhysicsGraphIR`

**Weryfikacja (`crates/fullmag-authoring/src/physics_graph.rs`):**
- `PhysicsScopeRef` — linie 19–39: `Global`, `Object`, `Region`, `Interface`,
  `CrossObject`, `Unresolved { reason, source_path }`.
- `PhysicsActivation` — linie 43–50: `Configured`, `Active`, `Inactive`, `Blocked`,
  `Unsupported`, `Unresolved`.
- Plik ma 855 linii (plan cytuje 1–175; struktury są w tym zakresie).

**Ocena: POTWIERDZONE.** Wariant `Unresolved` z polami diagnostycznymi i `Blocked`/
`Unsupported` to gotowy fundament pod §22.3 („capabilities i availability”) — plan
słusznie chce go rozwijać, a nie zastępować.

---

## E06–E08 — `.fms`, profile, manifesty, tensory

**Weryfikacja (`crates/fullmag-session/`):**

| Element | Plik:linia | Stan |
|---|---|---|
| moduły: `capture`, `cas`, `communication_policy`, `fms`, `mesh_operation`, `store`, `types` | `src/` | 3 477 linii łącznie |
| `SaveProfile` | `types.rs:15` | Compact/Solved/Resume/Archive/Recovery |
| `RestoreClass` | `types.rs:33` | ExactResume/LogicalResume/InitialConditionImport/ConfigOnly |
| `FmsSessionManifest` | `types.rs:48` | — |
| `pub run_refs: Vec<String>` | **`types.rs:67`** | zgodne z planem |
| `CheckpointCompatibility` | `types.rs:304` | — |
| `TensorDescriptor` | `types.rs:373-382` | `format`, `name`, `dtype`, `shape`, `logical_axes`, `endian`, `chunks: Vec<TensorChunk>` |
| `TensorDtype` | **`types.rs:408-414`** | `U8, I32, U32, F32, F64` — **brak Complex** |
| `TensorChunk` | `types.rs:427-433` | `object_ref`, `offset`, `length`, `sha256: Option<String>` |
| `FieldRole` | `types.rs:447-453` | Primary/ResumeAux/DerivedCached/Rebuildable/PreviewOnly |

**Ocena: POTWIERDZONE.** Teza „`.fms` nie jest z natury formatem jednorazowej sesji”
jest prawdziwa: `run_refs` istnieje, a `SessionStore` ma `commit_run`, `read_run`,
`list_checkpoints`, `latest_checkpoint`, `write_recovery`, `list_recovery`, `try_lock`,
`unlock`, `collect_live_refs`, `gc` (`store.rs:53-350`).

**Uzupełnienie do K11 (brak typu zespolonego):** problem jest szerszy niż brak wariantu
w enumie. `TensorChunk` ma **własne opcjonalne pole `sha256`** obok `object_ref`, przy czym
`object_ref` **też** jest hashem SHA-256 (CAS adresuje po `sha256/<hex>`). Podwójna,
częściowo nadmiarowa tożsamość treści to dokładnie ta klasa niejednoznaczności, przed którą
przestrzega K02 („ID artefaktu jest stabilne… content hash wskazuje konkretny blob”).
Przy okazji dodawania `C64/C128` należy tę redundancję rozstrzygnąć.

---

## E09–E10 — Python: cache FEM i globalny singleton

**Weryfikacja:**

- `packages/fullmag-py/src/fullmag/model/problem.py:161-194` —
  `_fem_cache_contract_identity()` zwraca:
  `source_snapshot_sha256`, `source_compatibility_epoch`
  (`"fullmag.fem.meshing.production-closure.2026-08-31.v1"`), `gmsh_version`,
  `gmsh_threads`, `repair_algorithm_id`, `repair_method`, `repair_iterations`,
  `certifier_algorithm_id`, `artifact_schema`, `topology_fingerprint_version: "v3"`,
  opcjonalnie `resolved_policy_sha256`. Używane w `problem.py:705` i `:1194`.
- `packages/fullmag-py/src/fullmag/world.py:2488-2489`:
  ```python
  # Module-level singleton
  _state = _WorldState()
  ```
  oraz `world.py:3596-3598` w `reset()` — `global _state; _state = _WorldState()`.
  Plik ma **9 274** linie.

**Ocena: POTWIERDZONE.** Ostrzeżenie planu („tej ostrożności nie wolno zastąpić naiwnym
hashem samych wierzchołków”) jest uzasadnione — docstring funkcji mówi wprost, że pola te
chronią przed „false warm hit” po zmianie Gmsh/repair/certifier.

---

## E11 — IR i geometria

`crates/fullmag-ir/src/model.rs:40-130` — `GeometryEntryIR` z prymitywami, falowodami,
CSG (`Difference` 91, `Union` 96, `Intersection` 101) i `Translate` (106).

**Ocena: POTWIERDZONE.** Patrz też uwaga o braku `Rotate`/`Scale` przy E02.

---

## E12–E13 — engine i runner

`crates/fullmag-runner/src/lib.rs` — **9 647** linii; moduły m.in. `artifact_pipeline`,
`eigen`, `frequency_response`, `hysteresis`, `observation`, `schedules`, `solvers`,
`spin_wave_response`, `autosave_zarr` (485 linii).

**Ocena: POTWIERDZONE.**

**Odkrycie wykraczające poza E13 — patrz luka L2:** `fullmag-runner` zawiera **54
wystąpienia** `sessions/current`, w tym w kodzie produkcyjnym generującym manifesty:
`eigen/artifacts/common.rs:346-350` buduje `"/v2/sessions/current/data/fields/
{mode_field_id}/samples/vector?view=phase_rotated_real&phase_rad=0"` jako
`mode_field_resource_key`, zapisywany do artefaktu (`field_sweep.rs:172-173`).
Analogicznie `fmr.rs:1363-1380` ustawia `spectrum_resource_key`, `branches_resource_key`,
`dispersion_resource_key`, `diagnostics_resource_key`, `response_sweep_resource_key` itd.
**Sprzężenie z „current” jest zapisane w trwałych danych, nie tylko w kodzie.**

---

## E14 — `scratch_runtime` i utrata własności

**Weryfikacja (`crates/fullmag-cli/src/scratch_runtime.rs`, 469 linii):**

- linie **130–139**: `session_changed`, `backend_changed`, `scene_changed`
  (`attached_scene_revision.zip(scene_revision).is_some_and(|(a,c)| a != c)`).
- linie **140–165**: `if session_changed || backend_changed || scene_changed {
  terminate_child(&mut child); ... pending_failure = Some((command_id,
  "scratch runtime ownership changed while a command was active")) }`.
- linie **204–228**: `render_current_scene(...)` → `spawn_attached_runtime(...)`.
- linie **421–434**: `render_current_scene` = `POST {api_base}/v2/sessions/current/model/syncs`,
  zwraca `script_path`.
- linie **436–461**: `spawn_attached_runtime` = `Command::new(executable).arg(script_path)
  .arg("--interactive")...spawn()`.
- linie **463–469**: `terminate_child` = `kill()` + `wait()`.

**Ocena: POTWIERDZONE.**

**Doprecyzowanie, które plan formułuje lepiej niż audyt Gemini:** kill wykonuje się
wyłącznie wtedy, gdy `attached_scene_revision` jest `Some`, czyli gdy runtime został już
podpięty dla aktywnej komendy obliczeniowej. `scratch_runtime::spawn` jest wywoływany w
dwóch miejscach: `main.rs:507-513` (UI bez skryptu) i `orchestrator.rs:6933-6935` (sesja
script-backed, gdzie komentarz w kodzie mówi wprost: *„The bridge ignores this
script-backed session and only attaches a fresh runtime after the browser explicitly
replaces it with a runnable scene”*). Zdanie planu *„Nie jest to twierdzenie, że każda
zmiana dowolnego pola zawsze zabija każdy runtime”* jest zatem **precyzyjnie poprawne**,
a kategoryczne sformułowanie Gemini — nadmiernym uogólnieniem.

**Wzmocnienie dowodu o narzucie (ustalenie 5 raportu Gemini — potwierdzone i poszerzone):**
`render_current_scene` trafia do `sync_authoring_script`
(`router_v2/handlers/model/authoring.rs:3392-3409`, opis: *„Canonical Python rewritten from
authoring state”*), a ten do `crate::script::sync_current_live_script_with_request`
(`script.rs:36-96`). Ta funkcja wywołuje `rewrite_script_via_python_helper` (script.rs:151)
albo `render_scene_document_via_python_helper` (script.rs:205), która:
1. serializuje `SceneDocument` do `scene-export-<uuid>.json` **na dysku** (script.rs:213-219),
2. **uruchamia proces Pythona** `python -m fullmag.runtime.helper render-scene-document`
   (script.rs:220-229, `run_python_helper` → `ProcessCommand::new` script.rs:343),
3. Python zapisuje plik `.py`,
4. dopiero potem `scratch_runtime` **uruchamia drugi proces Pythona**, który ten `.py`
   parsuje i buduje `ProblemIR`.

Czyli na jedną komendę obliczeniową przypadają **dwa starty interpretera Pythona i dwa
zapisy pośrednie na dysk**. Diagnoza Gemini jest trafna, ale niedoszacowana o połowę.

**Uwaga metodologiczna:** przedział „600 ms – 2.5 s” podany w raporcie Gemini **nie jest
poparty żadnym pomiarem w repozytorium**. Jest to prawdopodobna, ale niezweryfikowana
estymacja. Zgodnie z §17 `04-scenariusze.md` („Nie wpisujemy fikcyjnych wyników”) powinna
być oznaczona jako hipoteza do zmierzenia w spike'u „Data residency”, a nie cytowana
jako fakt w tabeli porównawczej (`raport_gemini/04-...md` §6).

---

## E15 — globalny gate startowy

**Weryfikacja (`apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`,
641 linii):**

`WorkspaceStartupGateView` — linie **594–616**:
```tsx
if (state.isVisible) {
  return (<><SimulationStartupOverlayView state={state} />
            <SimulationStartupDiagnosticsDock /></>);
}
return (<>{children}<SimulationStartupOverlayView state={state} /></>);
```
`preparationDuringRealtimeDisruption` — linie 583–592 (przekształcenie `ready` → `stale`
przy `disrupted`).

Konsument: `WorkspaceShellClient.tsx:76-85` — `children` to `SlotHost "ribbon"`,
`WorkspaceDockLayout`, `SlotHost "status-bar"` oraz host overlayów.

**Ocena: POTWIERDZONE / cytowanie do poprawy.** Plan podaje zakres
`SimulationStartupOverlay.tsx:580–655`. Plik ma 641 linii, więc górna granica wykracza poza
plik. Poprawny zakres dla `WorkspaceStartupGateView` to **594–616**, a dla
`preparationDuringRealtimeDisruption` **583–592**. Merytorycznie teza w pełni prawdziwa.

---

## E16 — brak `fullmag-application` w workspace

**Weryfikacja (`Cargo.toml`, **42 linie**):** `members` = `apps/desktop/src-tauri`,
`crates/fullmag-authoring`, `-api`, `-bench`, `-build-info`, `-cli`, `-engine`,
`-fdm-demag`, `-fdm-sys`, `-fem-sys`, `-ir`, `-plan`, `-py-core`, `-quantities`,
`-runner`, `-session`.

**Ocena: POTWIERDZONE / cytowanie do poprawy.** Plan cytuje „Cargo.toml:1–160”; plik ma
42 linie, `members` kończy się w linii 19. Brak `fullmag-application` — potwierdzony.

**Uzupełnienie:** plan nie wymienia w mapie pakietów (`03-migracja.md` §2) trzech
istniejących crate'ów: **`fullmag-quantities`** (3 033 linie — `catalog`, `descriptor`,
`eval`, `provider`, `reduction`, `registry`, `transport`, `step_data`),
`fullmag-bench` i `fullmag-build-info`. Pominięcie `fullmag-quantities` jest merytorycznie
istotne — to jest istniejący właściciel katalogu wielkości fizycznych, czyli dokładnie
warstwa, na której powinny stanąć `DerivedValueDefinition` (K12) i `FieldDescriptor` (K11).
Patrz luka **L6**.

---

## Weryfikacja liczb podanych w raporcie Gemini

Wszystkie zliczenia Gemini są **systematycznie o 1 za wysokie** (liczy wiersze wraz z
brakiem końcowego znaku nowej linii). Wartości rzeczywiste (`awk 'END{print NR}'`):

| Plik | Gemini | Rzeczywiście |
|---|---:|---:|
| `crates/fullmag-cli/src/orchestrator.rs` | 16 659 | **16 658** |
| `crates/fullmag-runner/src/lib.rs` | 9 648 | **9 647** |
| `packages/fullmag-py/src/fullmag/world.py` | 9 275 | **9 274** |
| `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts` | 1 102 | **1 101** |
| `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` | 866 | **865** |
| `apps/control-room/src/kernel/events/EventBus.ts` | 38 | **37** |

Różnice są bez znaczenia merytorycznego; odnotowuję je, bo raport Gemini konsekwentnie
deklaruje „100% zgodności”, a ta deklaracja nie wytrzymuje sprawdzenia nawet na poziomie
zliczeń.

**Potwierdzone bez zastrzeżeń:**
- brak `zustand` w `apps/control-room/package.json`; `react`/`react-dom` = **19.2.4**
  (linie 95–96), `next` = 16.2.11 (93), `three` = ^0.183.2 (100);
- `sessionResourceIdentity.ts:31-36` — `sessionScopedResourceKey` buduje klucz wyłącznie
  z `sessionId` i `sessionEpoch`, bez `projectId`/`runId`;
- `crates/fullmag-session/src/cas.rs` — CAS na SHA-256 (`objects/sha256/<hex>`);
- `crates/fullmag-runner/src/autosave_zarr.rs` istnieje (485 linii) i pisze trajektorie
  poza CAS — czyli rekomendowana przez Gemini „architektura hybrydowa” jest **już stanem
  faktycznym**, a nie propozycją.
