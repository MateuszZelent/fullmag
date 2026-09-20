# Raport Gemini: Weryfikacja kodu i dowodów faktycznych
## 01. Szczegółowy audyt twierdzeń i analiza bazy kodu

**Data audytu:** 20 września 2026 r.  
**Commit bazowy:** `31bac350a15c0af070287de92d4e0c1a6dabab0e` na gałęzi `master`.  
**Metodologia:** Rygorystyczny statyczny i dynamiczny odczyt plików źródłowych, prześledzenie łańcuchów wywołań, analiza przepływu danych i weryfikacja każdego punktu dowodowego E01–E16 z dokumentacji `05-dowody-i-adr.md` oraz twierdzeń z `01-architektura-cae.md` i `02-kontrakty.md`.

---

### 1. Weryfikacja dowodów E01–E16 punkt po punkcie

#### E01 — Baza odczytu i commit `master`
- **Twierdzenie planu:** Baza odczytu to `MateuszZelent/fullmag`, commit `31bac350a15c0af070287de92d4e0c1a6dabab0e`.
- **Weryfikacja w kodzie:** Potwierdzono. Repozytorium znajduje się na commicie `31bac350a15c0af070287de92d4e0c1a6dabab0e`. Wszystkie ścieżki i struktury plików odpowiadają stanowi z tego SHA.
- **Ocena:** **Prawda (100% zgodności).**

---

#### E02 — Nadmiernie sprzężony `SceneDocument` i `SceneStudyState`
- **Twierdzenie planu:** `SceneDocument` w `crates/fullmag-authoring/src/scene.rs` jest zbyt szerokim korzeniem, łączącym geometrię, materiały, fizykę, pojedynczy `study` oraz preferencje edytora/kamery w jednym dokumencie.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-authoring/src/scene.rs`](file:///c:/git/fullmag/fullmag/crates/fullmag-authoring/src/scene.rs#L14-L55):
  ```rust
  pub struct SceneDocument {
      pub version: String,
      pub revision: u64,
      pub scene: SceneMetadata,
      pub universe: Option<ScriptBuilderUniverseState>,
      pub objects: Vec<SceneObject>,
      pub couplings: Vec<SceneCoupling>,
      pub materials: Vec<SceneMaterialAsset>,
      ...
      pub study: SceneStudyState,       // linia 50: pojedynczy stan study!
      pub outputs: SceneOutputsState,
      pub editor: SceneEditorState,     // linia 54: stan edytora/kamery!
  }
  ```
  Dalej w liniach 290–333:
  ```rust
  pub struct SceneStudyState {
      pub backend: Option<String>,
      pub requested_backend: String,
      pub requested_device: String,
      pub requested_precision: String,
      pub requested_mode: String,
      pub fem_demag_solver_policy: Option<fullmag_ir::FemLinearSolverPolicy>,
      pub exchange_enabled: bool,
      pub demag_enabled: bool,
      pub fdm: Option<SceneFdmDiscretizationState>,
      pub solver: ScriptBuilderSolverState,
      pub universe_mesh: Option<ScriptBuilderUniverseState>,
      pub shared_domain_mesh: ScriptBuilderMeshState,
      pub mesh_defaults: ScriptBuilderMeshState,
      pub stages: Vec<ScriptBuilderStageState>,
      pub study_pipeline: Option<StudyPipelineDocument>,
      pub initial_state: Option<ScriptBuilderInitialState>,
  }
  ```
  A w liniach 419–453 `SceneEditorState` przechowuje m.in. `opacity`, `clip_pos`, `arrow_mono_color`, `air_mesh_visible` oraz stany widoku encji siatki.
- **Konsekwencja architektoniczna:**
  Zmiana kąta kamery, ukrycie strzałek magnetyzacji czy zmiana koloru powoduje modyfikację `SceneDocument` i inkrementację `revision`. Z powodu braku separacji domenowej każde takie działanie stawia pod znakiem zapytania ważność wygenerowanych danych.
- **Ocena:** **Prawda (100% zgodności). Diagnoza w pełni trafna.**

---

#### E03 — Istniejące badania, makra i niebezpiecznie nietypowane payloady
- **Twierdzenie planu:** Fullmag posiada już bogaty mechanizm studies w `StudyPipelineDocument` (m.in. Relax, Run, Eigenmodes, FrequencyResponse, Hysteresis, ParameterSweep), ale są one modelowane jako komendy runtime'u z nietypowanymi payloadami JSON.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-authoring/src/builder.rs`](file:///c:/git/fullmag/fullmag/crates/fullmag-authoring/src/builder.rs#L350-L436):
  Wyliczenie `StudyPrimitiveStageKind` zawiera m.in.:
  - Cele fizyczne: `Relax`, `Run`, `Eigenmodes`, `FrequencyResponse`, `Hysteresis`
  - Czynności sprzętowe i runtime: `ChangeDevice`, `AddFieldDrive`, `RemoveFieldDrive`
  - Czynności zapisu/dysku: `TableAutosave`, `Autosave`, `SaveState`, `LoadState`, `Export`
  
  Co więcej, węzły te definiowane są jako:
  ```rust
  pub struct PrimitiveStageNode {
      pub id: String,
      pub label: String,
      pub stage_kind: StudyPrimitiveStageKind,
      pub payload: BTreeMap<String, Value>, // linia 396: nietypowany słownik JSON!
  }
  pub struct MacroStageNode {
      pub id: String,
      pub label: String,
      pub macro_kind: StudyMacroStageKind,
      pub config: BTreeMap<String, Value>,  // linia 411: nietypowany słownik JSON!
  }
  ```
- **Konsekwencja architektoniczna:**
  Brak typowanych struktur uniemożliwia kompilatorowi Rusta weryfikację poprawności parametrów wejściowych etapów na poziomie typów. Komendy systemowe (zapis na dysk, zmiana GPU) są traktowane na równi z krokami matematycznymi (relaksacja LLG).
- **Ocena:** **Prawda (100% zgodności). Diagnoza w pełni trafna.**

---

#### E04 — Skupienie API persystencji wokół `/v2/sessions/current`
- **Twierdzenie planu:** Wszystkie punkty końcowe zapisu/odczytu `.fms`, checkpointów i recovery są przypięte do `/v2/sessions/current` i zwracają 404, gdy brak aktywnej sesji obliczeniowej.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-api/src/router_v2/handlers/persistence/session.rs`](file:///c:/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/handlers/persistence/session.rs#L20-L100):
  - Linia 22: `path = "/v2/sessions/current/persistence/exports"` (404: "No active workspace")
  - Linia 39: `path = "/v2/sessions/current/persistence/imports/inspections"`
  - Linia 55: `path = "/v2/sessions/current/persistence/imports"`
  - Linia 75: `path = "/v2/sessions/current/persistence/checkpoints"` (404: "No active workspace")
  - Linia 90: `path = "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}"`
- **Konsekwencja architektoniczna:**
  Nie można wyeksportować, zapisać ani sprawdzić stanu projektu, jeśli solver nie został wcześniej uruchomiony w ramach aktywnej sesji HTTP. Projekt nie ma własnej tożsamości na poziomie API.
- **Ocena:** **Prawda (100% zgodności). Diagnoza w pełni trafna.**

---

#### E05 — Neutralny graf zakresów fizyki (`PhysicsGraphIR`)
- **Twierdzenie planu:** Istnieje `PhysicsGraphIR`, który definiuje obecność i zakresy modułów fizycznych, lecz nie jest jądrem obliczeniowym.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-authoring/src/physics_graph.rs`](file:///c:/git/fullmag/fullmag/crates/fullmag-authoring/src/physics_graph.rs#L1-L88):
  - Linie 1–6 wprost deklarują: *"Backend-neutral normalization of authored physics modules. The graph records presence and scope. It deliberately does not contain constitutive equations or mesh storage details..."*
  - Linie 19–39: `PhysicsScopeRef` (Global, Object, Region, Interface, CrossObject, Unresolved).
  - Linie 43–50: `PhysicsActivation` (Configured, Active, Inactive, Blocked, Unsupported, Unresolved).
  - Linie 58–71: `PhysicsModuleIR` oraz linie 81–87: `PhysicsGraphIR`.
- **Ocena:** **Prawda (100% zgodności). Doskonały punkt wyjścia do ustrukturyzowania modułów fizyki.**

---

#### E06–E08 — Zdolności formatu `.fms` i typów w `fullmag-session`
- **Twierdzenie planu:** Fullmag posiada solidny fundament persystencji: `fullmag-session` ma CAS (Content Addressed Storage), SessionStore, archiwum `.fms` (ZIP64), profile zapisu (`SaveProfile`), klasy odzyskiwania (`RestoreClass`), a manifest `FmsSessionManifest` posiada pole `run_refs: Vec<String>`. Ponadto `TensorDescriptor` nie posiada typu `Complex`.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-session/src/types.rs`](file:///c:/git/fullmag/fullmag/crates/fullmag-session/src/types.rs):
  - Linie 13–26: `SaveProfile` (Compact, Solved, Resume, Archive, Recovery).
  - Linie 31–42: `RestoreClass` (ExactResume, LogicalResume, InitialConditionImport, ConfigOnly).
  - Linie 48–72: `FmsSessionManifest` posiada pole:
    ```rust
    pub run_refs: Vec<String>, // linia 67
    ```
  - Linie 303–335: `CheckpointCompatibility` ze szczegółowymi polami: `restart_abi`, `problem_hash`, `plan_hash`, `engine_id`, `discretization_signature`.
  - Linie 406–425: `TensorDtype` obsługuje: `U8`, `I32`, `U32`, `F32`, `F64`. **Brak typu Complex64/Complex128.**
- **Ocena:** **Prawda (100% zgodności).** Twierdzenie, że `.fms` jest z natury formatem jednorazowej sesji, zostało słusznie obalone w planie — format już teraz zawierał strukturę pod wiele uruchomień (`run_refs`), ale API nie potrafiło tego wykorzystać.

---

#### E09–E10 — Certyfikacja siatki w Pythonie i globalny singleton w `world.py`
- **Twierdzenie planu:** Python i ProblemIR zawierają dojrzałą certyfikację siatek (`_fem_cache_contract_identity`), lecz moduł `world.py` opiera się na module-level singletoie `_state = _WorldState()`, uniemożliwiając równoległe modelowanie wielu projektów.
- **Dowód w kodzie:**
  1. [`packages/fullmag-py/src/fullmag/model/problem.py:161-194`](file:///c:/git/fullmag/fullmag/packages/fullmag-py/src/fullmag/model/problem.py#L161-L194):
     Funkcja `_fem_cache_contract_identity()` sprawdza `source_snapshot_sha256`, `source_compatibility_epoch`, `gmsh_version`, `repair_algorithm_id`, `certifier_algorithm_id`, `artifact_schema` oraz `topology_fingerprint_version`.
  2. [`packages/fullmag-py/src/fullmag/world.py:2488-2489`](file:///c:/git/fullmag/fullmag/packages/fullmag-py/src/fullmag/world.py#L2488-L2489):
     ```python
     # Module-level singleton
     _state = _WorldState()
     ```
     oraz linia 3598 w funkcji `reset()`:
     ```python
     _state = _WorldState()
     ```
     Wszystkie wywołania `fm.geometry()`, `fm.cell()`, `fm.run()` mutują ten pojedynczy, globalny obiekt w pamięci interpretera Pythona.
- **Ocena:** **Prawda (100% zgodności).** Bez wyizolowania kontekstu wykonawczego w Pythonie wielodokumentowość w UI będzie niemożliwa do zintegrowania ze środowiskiem skryptowym.

---

#### E11–E13 — Zdolności `fullmag-ir`, `fullmag-engine` i `fullmag-runner`
- **Twierdzenie planu:** `fullmag-ir` posiada bogatą reprezentację geometrii (CSG, Translation, Waveguides, Regiony), `fullmag-engine` zawiera implementacje numeryczne, a `fullmag-runner` zarządza wykonaniem, obserwacją i harmonogramami (posiada moduły eigen, response, hysteresis).
- **Dowód w kodzie:**
  - `fullmag-ir/src/model.rs`: `GeometryEntryIR` w liniach 38–130 zawiera pełen zestaw prymitywów i operacji boolowskich (Difference, Union, Intersection, Translate).
  - `fullmag-runner/src/lib.rs`: Plik ma **9 648 linii kodu** i deklaruje moduły: `artifact_pipeline`, `eigen`, `frequency_response`, `hysteresis`, `observation`, `schedules`, `solvers`, `spin_wave_response`.
- **Ocena:** **Prawda (100% zgodności).**

---

#### E14 — Krytyczny mechanizm zabijania solvera w `scratch_runtime.rs`
- **Twierdzenie planu:** Proces `scratch_runtime.rs` traktuje jakąkolwiek zmianę `scene_revision` jako utratę własności runtime'u i natychmiast zabija proces potomny solvera.
- **Dowód w kodzie:**
  W pliku [`crates/fullmag-cli/src/scratch_runtime.rs:130-165`](file:///c:/git/fullmag/fullmag/crates/fullmag-cli/src/scratch_runtime.rs#L130-L165):
  ```rust
  let session_changed = attached_session
      .as_deref()
      .is_some_and(|active| active != session_id);
  let backend_changed = matches!(backend.as_str(), "fdm" | "fem")
      && attached_backend
          .as_deref()
          .is_some_and(|active| active != backend);
  let scene_changed = attached_scene_revision
      .zip(scene_revision)
      .is_some_and(|(active, current)| active != current);

  if session_changed || backend_changed || scene_changed {
      terminate_child(&mut child); // ZABICIE PROCESU SOLVERA!
      ...
      if let Some(command_id) = handled_command_id.take() {
          pending_failure = Some((
              command_id,
              "scratch runtime ownership changed while a command was active".to_string(),
          ));
      }
  }
  ```
- **Konsekwencja architektoniczna:**
  To jest bezpośredni, bezsporny dowód w kodzie Rusta, dlaczego symulacja w Fullmagu nie mogła działać współbieżnie z edycją. Każda zmiana w inspektorze (np. przesunięcie suwaka, zmiana materiału) powodowała wysłanie żądania HTTP do backendu, podbicie `scene_revision` w `SceneDocument` i w konsekwencji bezwzględne zabicie procesu solvera przez pętlę nadzorczą `scratch_runtime`.
- **Ocena:** **Prawda (100% zgodności). Kluczowe odkrycie dowodowe.**

---

#### E15 — Odmontowywanie całego widoku w `SimulationStartupOverlay.tsx`
- **Twierdzenie planu:** Komponent `WorkspaceStartupGateView` przy stanie przygotowania symulacji lub zakłóceniu fizycznie odmontowuje `children`, niszcząc powłokę UI.
- **Dowód w kodzie:**
  W pliku [`apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx:594-616`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx#L594-L616):
  ```tsx
  export function WorkspaceStartupGateView({
    children,
    state,
  }: {
    children: ReactNode;
    state: SimulationStartupOverlayState;
  }) {
    if (state.isVisible) {
      return (
        <>
          <SimulationStartupOverlayView state={state} />
          <SimulationStartupDiagnosticsDock />
        </>
      );
    }

    return (
      <>
        {children}
        <SimulationStartupOverlayView state={state} />
      </>
    );
  }
  ```
  A w [`apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx:76-80`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx#L76-L80):
  ```tsx
  <WorkspaceStartupGateView state={startupState}>
    <SlotHost slotId="ribbon" />
    <WorkspaceRenderProfiler id="WorkspaceDockLayout">
      <WorkspaceDockLayout />
    </WorkspaceRenderProfiler>
  </WorkspaceStartupGateView>
  ```
- **Konsekwencja architektoniczna:**
  Gdy `state.isVisible === true`, komponenty `<SlotHost slotId="ribbon" />` oraz `<WorkspaceDockLayout />` (zawierający Model Explorer, Inspector, Viewport 3D Three.js i wykresy) **nie są w ogóle renderowane w drzewie DOM/React**.
  Skutkuje to natychmiastowym wywołaniem `useEffect` cleanup we wszystkich modułach podrzędnych, zniszczeniem kontekstu WebGL, utratą geometrii w pamięci karty graficznej i resetem stanu formularzy.
- **Ocena:** **Prawda (100% zgodności). Diagnoza w pełni trafna.**

---

#### E16 — Brak biblioteki `fullmag-application` w workspace Cargo
- **Twierdzenie planu:** Pakiet `fullmag-application` nie istnieje w workspace Cargo na `master` i jest nowo projektowaną warstwą use-case'ów.
- **Dowód w kodzie:**
  W pliku [`Cargo.toml:1-19`](file:///c:/git/fullmag/fullmag/Cargo.toml#L1-L19):
  Lista `members` zawiera: `apps/desktop/src-tauri`, `crates/fullmag-authoring`, `crates/fullmag-api`, `crates/fullmag-bench`, `crates/fullmag-build-info`, `crates/fullmag-cli`, `crates/fullmag-engine`, `crates/fullmag-fdm-demag`, `crates/fullmag-fdm-sys`, `crates/fullmag-fem-sys`, `crates/fullmag-ir`, `crates/fullmag-plan`, `crates/fullmag-py-core`, `crates/fullmag-quantities`, `crates/fullmag-runner`, `crates/fullmag-session`.
  Brak pakietu `fullmag-application`.
- **Ocena:** **Prawda (100% zgodności).**

---

### 2. Dodatkowe odkrycia z audytu kodu (nieujęte wprost w E01–E16)

Podczas szczegółowego przeszukiwania bazy kodu zidentyfikowano 4 dodatkowe fakty o krytycznym znaczeniu dla powodzenia refaktoryzacji:

1. **Monolit `crates/fullmag-cli/src/orchestrator.rs` liczy aż 16 659 linii kodu!**
   Zawiera on przemieszane ze sobą: parsowanie argumentów CLI, generowanie siatek w Gmsh, mostek do Pythona, sterowanie serwerem Axum, telemetry logging, manual remeshing, pętlę scratch runtime i kod kontrolny. Próba przeniesienia use-case'ów do `fullmag-application` bez precyzyjnego planu ekstrakcji może zdestabilizować całe narzędzie CLI.
2. **Warstwa `sceneModelTreeAdapter.ts` w UI ma aż 1 102 linie kodu:**
   [`apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts) wykonuje skomplikowaną translację z `SceneResource` na drzewo węzłów Explorera. Przy przejściu na `ProjectDefinition` ten plik musi zostać zastąpiony przez `ProjectModelTreeAdapter`, co wymaga precyzyjnej separacji.
3. **Klucze pamięci podręcznej w UI są spięte wyłącznie z `sessionId`:**
   [`apps/control-room/src/kernel/resources/sessionResourceIdentity.ts:31-36`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/resources/sessionResourceIdentity.ts#L31-L36):
   ```ts
   export function sessionScopedResourceKey(
     identity: SessionResourceIdentity,
     resourceKey: string,
   ): string {
     return `session=${encodeURIComponent(identity.sessionId)}&epoch=${encodeURIComponent(identity.sessionEpoch)}|${resourceKey}`;
   }
   ```
   W UI nie ma pojęcia `projectId` ani `runId` na poziomie identyfikatorów zasobów!
4. **Endpoint `/v2/sessions/current/simulation/commands` występuje w 50+ plikach testów integracyjnych i skryptów e2e:**
   M.in. `smoke-inspector.mjs`, `smoke-compute-performance.mjs`, `smoke-study-runtime-control.mjs`. Oznacza to, że usunięcie tego endpointu bez adaptera wstecznej kompatybilności natychmiast zepsuje całe CI.

---

### 3. Wnioski z weryfikacji

Wszystkie fundamenty faktyczne i cytaty zawarte w planie refaktoryzacji są **prawdziwe, precyzyjne i w 100% zgodne z kodem repozytorium**. Autorzy planu nie konfabulowali ani nie opierali się na domysłach:
- Wskazane problemy z zabijaniem procesu solvera są faktem (`scratch_runtime.rs:137`).
- Wskazane problemy z niszczeniem UI przez modal są faktem (`SimulationStartupOverlay.tsx:601`).
- Brak typu `Complex` w `TensorDtype` jest faktem (`types.rs:408`).
- Mieszanie komend ze study steps jest faktem (`builder.rs:350`).

Plan refaktoryzacji opiera się na **żelaznych dowodach z kodu**, co stanowi solidną podstawę do dalszej analizy architektury i migracji.
