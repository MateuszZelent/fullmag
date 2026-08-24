# Scratch Simulation Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** Zbudować kompletną, testowalną ścieżkę utworzenia od zera symulacji FDM CPU double i FEM CPU w Control Room, od pustej sesji przez geometrię, translację, materiał, teksturę, oddziaływania, dyskretyzację i study aż do Run oraz kanonicznego eksportu Python/ProblemIR 0.3.

**Architektura:** UI pozostaje klientem jednego zasobowego API v2 i edytuje kanoniczny `SceneDocument`; nie powstaje drugi model domenowy. Nowa sesja jest prawidłowym pustym dokumentem authoringu, readiness jest zasobem pochodnym serwera, a ciężkie dane siatki/pól nadal przechodzą istniejącą data-plane. Mutacje zachowują optimistic concurrency przez `base_revision`, a realtime wyłącznie unieważnia zasoby pobierane ponownie przez HTTP.

**Stos:** Rust/Axum, `fullmag-authoring`, OpenAPI 3.1 i generowane typy TypeScript, Next.js 16/React, Zustand/resource hooks, Three.js/R3F, Python DSL, Vitest/Testing Library, Rust tests, pytest, Playwright/browser smoke, repozytoryjne receptury `just`.

## Ograniczenia globalne

- Aktywnym kontraktem pozostaje `ProblemIR schema_version == "0.3"`; ten plan nie aktywuje 0.4.
- `Move` oznacza pełną translację w Inspectorze i gizmo dla FDM/FEM. `Rotate` i `Scale` pozostają wyłączone z jawnym powodem, ponieważ 0.3 nie gwarantuje ich kanonicznego round-trip.
- Każdy obiekt zachowuje osobne: niezmienne `object_id`, edytowalne `name`, prezentacyjne `type` i jawnie przypisane moduły fizyki.
- Komponenty nie wywołują `fetch`; używają generowanego transportu, `ControlRoomApi`, resource hooks i revision-driven invalidation.
- Draft formularza i draft viewportu są lokalne; `Apply` jest jedyną granicą mutacji serwera.
- Każda mutacja sceny przesyła `base_revision`; `409` zachowuje draft/focus/scroll i umożliwia refetch/rebase/retry.
- Zmiana geometrii, translacji albo dyskretyzacji oznacza nieaktualną topologię; materiał, tekstura i oddziaływania nie przebudowują topologii bez jawnej deklaracji backendu.
- Klasy CSS w `apps/control-room` mają prefiks `fm-`, korzystają z `--fm-*`, Tailwind i wspólnych prymitywów shadcn/ui.
- Persistent Inspectors nie remountują się, nie mają animacji opacity i nie używają jednego panelowego `pending`.
- Zmiany viewportu muszą udowodnić: widoczny canvas, `gl.isContextLost() === false` i niezerowy drawing buffer.
- FEM/MFEM/CUDA/hypre/libCEED są budowane i kwalifikowane wyłącznie przez kontenerowe receptury `just`; hostowe buildy są tylko diagnostyką.
- Źródłem wymagań i audytu jest `docs/superpowers/specs/2026-08-23-scratch-simulation-authoring-design.md`.

## Mapa plików i odpowiedzialności

### Nowe pliki

- `crates/fullmag-api/src/router_v2/handlers/sessions/create.rs` — atomowe utworzenie pustej sesji i reset zasobów bieżącej sesji.
- `crates/fullmag-api/src/schemas/sessions.rs` — typowane zasoby listy, żądania i odpowiedzi sesji używane przez router i OpenAPI.
- `crates/fullmag-api/src/router_v2/handlers/model/readiness.rs` — serwerowa, deterministyczna checklista authoringu i blokery Run/export.
- `apps/control-room/src/kernel/authoring/scratchAuthoringReadiness.ts` — wyłącznie prezentacyjne mapowanie odpowiedzi readiness; bez powtórnej walidacji fizyki.
- `apps/control-room/src/kernel/layout/NewProblemDialog.tsx` — dialog wyboru FDM/FEM, device, precision i nazwy.
- `apps/control-room/src/kernel/layout/EmptyWorkspace.tsx` — prawidłowy stan aplikacji bez aktywnej sesji.
- `apps/control-room/src/modules/viewport-3d/MoveObjectGizmo.tsx` — translacyjne gizmo z lokalnym draftem i jednym Apply na końcu gestu.
- `apps/control-room/scripts/lib/scratch-authoring-browser.mjs` — wspólny sterownik prawdziwych scenariuszy E1/E2/E3/E5 i manifest dowodowy.
- `apps/control-room/scripts/smoke-scratch-authoring-fdm.mjs` oraz `smoke-scratch-authoring-fem.mjs` — wejścia lane-specific.
- `packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py` — semantyczny UI → Python → reload → ProblemIR 0.3.

### Główne pliki modyfikowane

- `crates/fullmag-api/src/types.rs`, `router_v2/mod.rs`, `router_v2/tests.rs`, `openapi_v2.rs` — typy, routing, testy i kontrakt.
- `crates/fullmag-api/src/main.rs`, `session.rs`, `script.rs` — inicjalizacja/reset sesji, synchronizacja i eksport.
- `apps/control-room/src/kernel/api/apiPaths.ts`, `ControlRoomApi.ts`, `ControlRoomApi.test.ts` — jedyna fasada nowych zasobów.
- `apps/control-room/src/kernel/layout/{appMenuModel,shellCommands,AppMenuBar,WorkspaceShellClient,SimulationStartupOverlay}.tsx` — wejście New Problem i stan bez sesji.
- istniejące modele/panele `geometry`, `materials`, `magnetization`, `physics`, `meshing`, `study` — dopięcie już istniejących mutacji do kompletnego workflow.
- `apps/control-room/src/modules/viewport-3d/{PrimitiveObjectLayer,useViewport3DSceneModel}.tsx` — draft primitive i Move bez wymiany zasobu topology.
- `packages/fullmag-py/src/fullmag/runtime/{helper,script_builder}.py` — kanoniczny render kompletnego SceneDocument bez zależności od skryptu wejściowego.
- `apps/control-room/package.json`, `justfile` — jawne bramki FDM/FEM i macierz.

---

### Task 1: Prawdziwy kontrakt tworzenia pustej sesji

**Pliki:**
- Create: `crates/fullmag-api/src/router_v2/handlers/sessions/create.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/sessions.rs`
- Create: `crates/fullmag-api/src/schemas/sessions.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs:43,1015`
- Modify: `crates/fullmag-api/src/types.rs:672,1067`
- Modify: `crates/fullmag-api/src/session.rs:1241`
- Modify: `crates/fullmag-api/src/main.rs:2337-2390`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfejsy:**
- Consumes: `default_current_live_state`, `AppState.current_live_state`, `SceneDocument` 0.3 i istniejący mechanizm revisions/events.
- Produces: `CreateSessionRequest { name, backend, device, precision }`, `CreateSessionResponse { session_id, status, scene_document, revisions }`, `create_empty_scene_document(&CreateSessionRequest) -> Result<SceneDocument, ApiError>`.

- [ ] **Krok 1: Napisać RED dla FDM, FEM i błędów kontraktu**

  W `router_v2/tests.rs` dodać testy wysyłające prawdziwe `POST /v2/sessions`:

  ```rust
  let response = app.oneshot(
      Request::post("/v2/sessions")
          .header(CONTENT_TYPE, "application/json")
          .body(Body::from(r#"{"name":"Scratch FDM","backend":"fdm","device":"cpu","precision":"double"}"#))?
  ).await?;
  assert_eq!(response.status(), StatusCode::CREATED);
  let body: Value = read_json(response).await;
  assert_eq!(body["scene_document"]["schema_version"], "0.3");
  assert_eq!(body["scene_document"]["objects"], json!([]));
  assert_eq!(body["status"]["requested_execution"]["backend"], "fdm");
  ```

  Drugi pozytywny przypadek używa FEM/CPU/double. Negatywne przypadki wymagają `400` dla nieznanej kombinacji i `409` dla próby zastąpienia aktywnej sesji bez jawnego `replace_current`.

- [ ] **Krok 2: Uruchomić RED**

  Run: `cargo test -p fullmag-api router_v2::tests::create_scratch_session -- --nocapture`

  Expected: FAIL, ponieważ obecny handler zawsze zwraca `400` i nie przyjmuje JSON.

- [ ] **Krok 3: Wdrożyć minimalne atomowe utworzenie sesji**

  Przenieść handler do `handlers/sessions/create.rs`; zbudować `CurrentLiveSnapshotRequest`, uzupełnić go pustym `SceneDocument`, ustawić requested/effective execution bez fallbacku i pod jednym write-lockiem zastąpić `None`. Reset kolejki komend, display i workspace wyciągnąć z istniejącej ścieżki zmiany sesji do jednej współdzielonej funkcji; nie kopiować procedury.

  ```rust
  pub(crate) async fn create_session(
      State(state): State<Arc<AppState>>,
      Json(request): Json<CreateSessionRequest>,
  ) -> Result<(StatusCode, Json<CreateSessionResponse>), ApiError>;

  pub(crate) fn create_empty_scene_document(
      request: &CreateSessionRequest,
  ) -> Result<SceneDocument, ApiError>;
  ```

  Pusty dokument jest edytowalny, lecz jeszcze niewykonywalny; nie wstawiać ukrytego magnesu zastępczego.

- [ ] **Krok 4: Uruchomić testy sesji i regresję routera**

  Run: `cargo test -p fullmag-api create_scratch_session -- --nocapture`

  Expected: PASS dla FDM/FEM/400/409, bez zmiany istniejących snapshotów.

- [ ] **Krok 5: Commit**

  ```text
  git add crates/fullmag-api/src/router_v2/handlers/sessions/create.rs crates/fullmag-api/src/router_v2/handlers/sessions.rs crates/fullmag-api/src/schemas/sessions.rs crates/fullmag-api/src/schemas/mod.rs crates/fullmag-api/src/router_v2/mod.rs crates/fullmag-api/src/types.rs crates/fullmag-api/src/session.rs crates/fullmag-api/src/main.rs crates/fullmag-api/src/router_v2/tests.rs
  git commit -m "feat(api): create empty authoring sessions"
  ```

### Task 2: OpenAPI i jedyna typed facade sesji

**Pliki:**
- Modify: `crates/fullmag-api/src/openapi_v2.rs:842-870`
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify generated: `apps/control-room/src/kernel/api/generated/*`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfejsy:**
- Consumes: typy request/response z zadania 1.
- Produces: `kernel.api.sessions.create(input)` oraz `SESSIONS_PATH` bez ręcznego `fetch`.

- [ ] **Krok 1: Napisać RED kontraktu i fasady**

  Test OpenAPI ma wymagać request body, odpowiedzi `201`, `400`, `409` i schematów. Test TS:

  ```ts
  await api.sessions.create({
    name: "Scratch FEM",
    backend: "fem",
    device: "cpu",
    precision: "double",
  });
  expect(transport.post).toHaveBeenCalledWith(SESSIONS_PATH, expect.objectContaining({ backend: "fem" }));
  ```

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/api/ControlRoomApi.test.ts`

  Expected: FAIL, brak `sessions.create`.

- [ ] **Krok 3: Uzupełnić OpenAPI, wygenerować typy i fasadę**

  `add_session_collection_paths` ma wskazywać rzeczywiste schematy, a `ControlRoomApi` ma delegować do generowanego klienta. Nie edytować ręcznie semantyki wygenerowanych plików.

  Run: `pnpm --dir apps/control-room generate:api`

- [ ] **Krok 4: Uruchomić testy i bramkę API**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/api/ControlRoomApi.test.ts`

  Run: `bash scripts/ci-resource-first-gates.sh --strict`

  Expected: oba PASS; brak bezpośredniego `fetch` w komponencie.

- [ ] **Krok 5: Commit**

  ```text
  git add crates/fullmag-api/src/openapi_v2.rs apps/control-room/src/kernel/api
  git commit -m "feat(frontend): expose typed session creation"
  ```

### Task 3: Stan „brak sesji” i dialog New Problem

**Pliki:**
- Create: `apps/control-room/src/kernel/layout/NewProblemDialog.tsx`
- Create: `apps/control-room/src/kernel/layout/NewProblemDialog.test.tsx`
- Create: `apps/control-room/src/kernel/layout/EmptyWorkspace.tsx`
- Create: `apps/control-room/src/kernel/resources/useSessionCollection.ts`
- Create: `apps/control-room/src/kernel/resources/useSessionCollection.test.ts`
- Modify: `apps/control-room/src/kernel/layout/appMenuModel.tsx:51,92`
- Modify: `apps/control-room/src/kernel/layout/shellCommands.ts:108`
- Modify: `apps/control-room/src/kernel/layout/AppMenuBar.tsx`
- Modify: `apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx`
- Modify: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`
- Test: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.test.tsx`

**Interfejsy:**
- Consumes: `kernel.api.sessions.create`, `ResourceInvalidationController`, status sesji.
- Produces: `NewProblemDialog`, jawny `no-session` startup state i aktywne `workspace.new-problem`/`Ctrl+N`.

- [ ] **Krok 1: Napisać RED dla pustego startu i dialogu**

  Test ma wykazać, że `GET /v2/sessions` zwracające pustą kolekcję renderuje AppMenu i `Create simulation`, a nie blokujący błąd. `404` z zasobów `/current` nie jest używane jako źródło stanu `absent` ani dopasowywane po tekście. Dialog ma domyślnie wybrać FDM/CPU/double, przełączyć FEM/CPU, wysłać dokładny request, pokazać błąd capability oraz po sukcesie unieważnić sessions/status/current/model.

  ```tsx
  expect(screen.getByRole("button", { name: "Create simulation" })).toBeEnabled();
  await user.click(screen.getByRole("menuitem", { name: "New Problem" }));
  await user.click(screen.getByRole("radio", { name: "FEM" }));
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ backend: "fem", device: "cpu" }));
  ```

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/layout/NewProblemDialog.test.tsx src/kernel/layout/SimulationStartupOverlay.test.tsx`

  Expected: FAIL, command jest placeholderem, a gate traktuje brak sesji jako awarię/przygotowanie.

- [ ] **Krok 3: Wdrożyć stan i dialog**

  `useSessionCollection` pobiera `SESSIONS_PATH` przez typed facade i mapuje pustą kolekcję na prezentacyjny stan `no-session`; nie rozszerzać runtime'owego `sessionLifecycle` o `absent`. `WorkspaceShellClient` w tym stanie zachowuje shell i AppMenu, ale nie montuje modułów odpytujących `/current`; renderuje `EmptyWorkspace`. Dialog używa wspólnych `Dialog`, `RadioGroup`, `Input`, `Button`; lokalny pending dotyczy wyłącznie Create.

- [ ] **Krok 4: Uruchomić regresję layoutu i hydration**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/resources/useSessionCollection.test.ts src/kernel/layout/NewProblemDialog.test.tsx src/kernel/layout/SimulationStartupOverlay.test.tsx src/kernel/layout/SimulationPreparationMounted.test.tsx`

  Expected: PASS i brak hydration mismatch.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/kernel/layout apps/control-room/src/kernel/resources/useSessionCollection.ts apps/control-room/src/kernel/resources/useSessionCollection.test.ts
  git commit -m "feat(frontend): add scratch problem entry flow"
  ```

### Task 4: Serwerowa readiness i checklista modelu

**Pliki:**
- Create: `crates/fullmag-api/src/router_v2/handlers/model/readiness.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Create: `apps/control-room/src/kernel/authoring/scratchAuthoringReadiness.ts`
- Create: `apps/control-room/src/kernel/authoring/scratchAuthoringReadiness.test.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`
- Test: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.test.ts`

**Interfejsy:**
- Produces: `GET /v2/sessions/current/model/readiness` z `scene_revision`, `ready_to_run`, `ready_to_export`, `checks[]`, `blockers[]` i capability reason dla Rotate/Scale.
- Każdy `check` ma stabilne `id`, `state: "complete" | "blocked" | "stale"`, `label`, `target_resource?`, `reason?`.

- [ ] **Krok 1: Napisać RED macierzy readiness**

  Rust testuje pustą scenę, kompletny FDM i FEM ze stale mesh. TS testuje tylko mapowanie kolejności/etykiet i Run gating, nigdy ponowną walidację wartości fizycznych.

  ```ts
  expect(toChecklist(response).map((item) => [item.id, item.state])).toEqual([
    ["geometry", "blocked"], ["material", "blocked"], ["texture", "blocked"],
    ["interactions", "blocked"], ["discretization", "blocked"], ["study", "blocked"],
  ]);
  expect(resolveRunAvailability(response)).toEqual({ enabled: false, reason: "Add at least one magnetic object." });
  ```

- [ ] **Krok 2: Potwierdzić RED**

  Run: `cargo test -p fullmag-api model_readiness -- --nocapture`

  Run: `pnpm --dir apps/control-room vitest run src/kernel/authoring/scratchAuthoringReadiness.test.ts src/kernel/runtime/studyRuntimeCommandContributions.test.ts`

- [ ] **Krok 3: Wdrożyć pochodny zasób i Run gating**

  Readiness korzysta z walidacji `fullmag-authoring`, bieżącej provenance mesh/grid i study. Nie zapisuje stanu. Run command konsumuje ten resource i pokazuje pierwszy stabilny blocker.

- [ ] **Krok 4: Wygenerować typy i uruchomić regresję**

  Run: `pnpm --dir apps/control-room generate:api`

  Run: `cargo test -p fullmag-api model_readiness -- --nocapture`

  Run: `pnpm --dir apps/control-room vitest run src/kernel/authoring/scratchAuthoringReadiness.test.ts src/kernel/runtime/studyRuntimeCommandContributions.test.ts`

- [ ] **Krok 5: Commit**

  ```text
  git add crates/fullmag-api/src/router_v2 crates/fullmag-api/src/openapi_v2.rs apps/control-room/src/kernel/api apps/control-room/src/kernel/authoring apps/control-room/src/kernel/runtime
  git commit -m "feat(authoring): expose model readiness"
  ```

### Task 5: Primitive draft, Apply i konflikt revision

**Pliki:**
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommands.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/geometryObjectPanelModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`
- Test: `apps/control-room/src/kernel/authoring/geometryLifecycleCommands.test.ts`
- Test: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts`
- Test: `apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/geometryObjectPanelModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx`

**Interfejsy:**
- Produces: lokalny `PrimitiveDraft { kind, dimensions, translation, errors }`, draft overlay w viewport i `applyPrimitiveDraft(baseRevision)`.

- [ ] **Krok 1: Napisać RED dla Box/Cylinder/Sphere i 409**

  Pokryć dodatnie wymiary SI, lokalne błędy bez requestu, draft widoczny przed Apply, pojedynczy request przy Apply, realny model błędu `revision_conflict`, zachowanie dirty fields oraz refetch/rebase/retry.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/authoring/geometryLifecycleCommands.test.ts src/kernel/authoring/geometryLifecycleCommandContributions.test.ts src/kernel/authoring/geometryLifecycleResources.test.ts src/modules/inspector/geometry/geometryObjectPanelModel.test.ts src/modules/viewport-3d/PrimitiveObjectLayer.test.tsx src/modules/viewport-3d/useViewport3DSceneModel.test.ts`

- [ ] **Krok 3: Wdrożyć wspólny draft i preview**

  Użyć istniejącej mutacji geometrii i `base_revision`; nie tworzyć równoległego scene store. Preview ma osobny klucz/render layer i nie podmienia mesh resource ani topology provenance. Inline validation pozostaje przy polu.

- [ ] **Krok 4: Uruchomić testy i sprawdzić ograniczone invalidacje**

  Expected: przed Apply zero mutacji/mesh fetch; po Apply dokładnie jedna mutacja i invalidacja scene/readiness/mesh-staleness.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/kernel/authoring apps/control-room/src/kernel/resources/geometryLifecycleResources.ts apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx apps/control-room/src/modules/inspector/panels/geometryObjectPanelModel.ts apps/control-room/src/modules/inspector/panels/geometryObjectPanelModel.test.ts apps/control-room/src/modules/viewport-3d
  git commit -m "feat(authoring): preview and apply primitive geometry"
  ```

### Task 6: Translacja w Inspectorze i gizmo Move

**Pliki:**
- Create: `apps/control-room/src/modules/viewport-3d/MoveObjectGizmo.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/MoveObjectGizmo.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3D.tsx`
- Test: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`

**Interfejsy:**
- Produces: `MoveDraft { objectId, origin, translation }`; `onCommit(objectId, translation, baseRevision)` wywoływane raz na końcu gestu.

- [ ] **Krok 1: Napisać RED translacji i capability reasons**

  Testować wpis SI w Inspectorze, drag po osi, jeden commit na pointer-up, anulowanie Escape, współbieżny `409`, oraz jawne disabled reason: `Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.`

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/viewport-3d/MoveObjectGizmo.test.tsx src/modules/ribbon/ribbonStructure.test.ts`

- [ ] **Krok 3: Wdrożyć Move bez ciągłych requestów**

  Podczas drag aktualizować wyłącznie draft prezentacyjny; na końcu użyć tej samej mutacji translacji co Inspector. Kamera nie może przechwycić aktywnego gestu. Rotate/Scale nie wysyłają requestu.

- [ ] **Krok 4: Uruchomić testy viewport lifecycle**

  Run: `pnpm --dir apps/control-room vitest run src/modules/viewport-3d/MoveObjectGizmo.test.tsx src/modules/viewport-3d/PrimitiveObjectLayer.test.tsx src/modules/viewport-3d/useViewport3DSceneModel.test.ts`

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/modules/viewport-3d apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx apps/control-room/src/modules/ribbon
  git commit -m "feat(viewport): move authored objects"
  ```

### Task 7: Materiał „utwórz i przypisz” oraz stabilny Inspector

**Pliki:**
- Modify: `apps/control-room/src/kernel/layout/MaterialLibraryDialog.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts`
- Create: `apps/control-room/src/modules/inspector/ScratchAuthoringInspectorStability.test.tsx`

**Interfejsy:**
- Produces: jedna jawna transakcja użytkownika `createMaterialThenAssign(objectId, draft, baseRevision)` z dwoma śledzonymi ACK i zachowaniem identity panelu.

- [ ] **Krok 1: Napisać RED**

  Pokryć parametry `Ms`, `A`, opcjonalnie `Ku1`/axis, walidację SI, utworzenie wpisu biblioteki, przypisanie do konkretnego `object_id`, konflikt drugiego ACK oraz stabilność root/focus/scroll. Tylko aktywne pole może być pending/disabled; brak opacity animation.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts src/modules/inspector/ScratchAuthoringInspectorStability.test.tsx`

- [ ] **Krok 3: Wdrożyć reuse istniejących mutacji**

  Nie dodawać endpointu łączonego: orkiestracja używa istniejącego create material i assign, aktualizując `base_revision` po pierwszym ACK. Przy błędzie przypisania nowy materiał pozostaje widoczny i można ponowić assign.

- [ ] **Krok 4: Uruchomić regresję material/inspector**

  Expected: materiał nie unieważnia topology; readiness i scene odświeżają się w ograniczonej liczbie requestów.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/kernel/layout/MaterialLibraryDialog.tsx apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.ts apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts apps/control-room/src/modules/inspector/ScratchAuthoringInspectorStability.test.tsx
  git commit -m "feat(authoring): create and assign materials"
  ```

### Task 8: Tekstura magnetyczna i oddziaływania jako jawne moduły

**Pliki:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.dom.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.test.ts`

**Interfejsy:**
- Consumes: katalog capabilities i typed mutations SceneDocument.
- Produces: atomiczne Apply tekstury oraz jawne enable/configure Exchange, Demag i Anisotropy bez inferencji z nazwy/type obiektu.

- [ ] **Krok 1: Napisać RED presetów i capabilities**

  Pokryć uniform `[1,0,0]`, vortex z parametrami, niezerowy/wektor znormalizowany, backendowo niedostępne opcje z reason oraz Exchange+Demag dla obu lane. Testować, że żaden moduł nie aktywuje się od nazwy/type.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts src/modules/inspector/panels/PhysicsInteractionPanelModel.test.ts src/modules/inspector/panels/PhysicsInteractionPanel.dom.test.tsx`

- [ ] **Krok 3: Wdrożyć atomowe Apply i capability-driven controls**

  Parametry tekstury są jednym draftem i jednym requestem. Każda interakcja zachowuje własne pending/error. Zmiany unieważniają readiness/results, lecz nie topology bez serwerowego sygnału.

- [ ] **Krok 4: Uruchomić regresję round-trip presetów**

  Run: `python -m pytest packages/fullmag-py/tests/test_preset_texture_roundtrip.py -q`

  Run: testy Vitest z kroku 2.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.test.ts apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.ts apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.dom.test.tsx apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.test.ts
  git commit -m "feat(authoring): configure textures and interactions"
  ```

### Task 9: Domknięcie istniejącego authoringu dyskretyzacji FDM

**Pliki:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx`
- Test: `packages/fullmag-py/tests/test_fdm_ui_roundtrip.py`

**Interfejsy:**
- Consumes: istniejące `SceneStudyState.fdm.default_cell`, `per_object_grid`, `buildStudyGlobalMergePatch` oraz kanoniczne `model.commitTransaction`.
- Produces: `Apply Grid` dla globalnego cell size i opcjonalnego per-object override; nie tworzy fikcyjnego commandu mesh-build.

- [ ] **Krok 1: Napisać RED FDM grid**

  Pokryć trzy dodatnie składowe SI, błędy zero/negative/NaN, globalne `default_cell`, override po `object_id`, przeliczone counts/extent i stale topology po Apply.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts src/modules/inspector/panels/StudyInspectorPanel.test.tsx`

- [ ] **Krok 3: Wdrożyć formularz na istniejącym study endpoint**

  Etykieta operacji brzmi `Apply Grid`, bo FDM nie ma osobnego mesh-build command. Preview counts jest pochodne i unit-aware. Domknąć istniejące pola `defaultCell` i `perMagnet` w `StudyInspectorPanel`, zapisując `buildStudyGlobalMergePatch` przez `model.commitTransaction` z `base_revision`; nie dodawać wąskiego endpointu study ani drugiego panelu FDM i nie kasować ustawień demag.

- [ ] **Krok 4: Uruchomić TS i Python round-trip**

  Run: `python -m pytest packages/fullmag-py/tests/test_fdm_ui_roundtrip.py -q`

  Expected: zachowane `default_cell` i `per_object_grid` w eksporcie/importcie 0.3.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx packages/fullmag-py/tests/test_fdm_ui_roundtrip.py
  git commit -m "feat(authoring): configure FDM grids"
  ```

### Task 10: Kompletny FEM mesh/shared-domain/airbox

**Pliki:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.dom.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.test.tsx`

**Interfejsy:**
- Consumes: rzeczywiste zasoby mesh policy, shared-domain, airbox, build command, manifest i quality.
- Produces: jeden spójny flow Configure → Build → command ACK → manifest current; readiness porównuje `source_scene_revision`.

- [ ] **Krok 1: Napisać RED FEM**

  Pokryć object/shared-domain policy, full-extent airbox z hidden-edge semantics, build command, quality gates, stale po geometry/translation, brak fallbacku FDM/GPU oraz current dopiero przy zgodnym `source_scene_revision`.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/inspector/panels/ObjectMeshPolicyPanel.dom.test.tsx src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.test.ts src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.test.tsx`

- [ ] **Krok 3: Dopięcie istniejących zasobów bez duplikacji FEM stanu**

  Panel pokazuje osobno policy, command progress, manifest i quality. Wireframe airbox nie dziedziczy opacity powierzchni i zawsze zachowuje pełny extent.

- [ ] **Krok 4: Uruchomić frontendową regresję freshness**

  Run: `node apps/control-room/scripts/smoke-fem-preview-freshness.mjs`

  Expected: manifest przestaje być stale wyłącznie po ukończonym buildzie dla bieżącej scene revision.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.dom.test.tsx apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts apps/control-room/src/modules/inspector/panels/airbox
  git commit -m "feat(authoring): complete FEM meshing workflow"
  ```

### Task 11: Study od pustego dokumentu i bezpieczny Run

**Pliki:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`

**Interfejsy:**
- Produces: utworzenie pierwszego `Relax` stage, edycja kryteriów SI, kolejność stages oraz Run wyłącznie przy `readiness.ready_to_run`.

- [ ] **Krok 1: Napisać RED pustego study**

  Testować `Add Relax`, stabilne stage id, wymagane tolerancje/limity, błędy inline, reorder/delete i Run disabled aż do kompletności oraz aktualnej dyskretyzacji.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts src/modules/inspector/panels/StudyStageAuthoringModel.test.ts src/modules/inspector/panels/StudyInspectorPanel.test.tsx src/kernel/runtime/studyRuntimeCommandContributions.test.ts`

- [ ] **Krok 3: Wdrożyć minimalny authoring Relax**

  Użyć istniejącego `PATCH /model/study`; nie dodawać ukrytego domyślnego stage w API. Run pokazuje dokładny blocker readiness i po ACK śledzi istniejący command resource.

- [ ] **Krok 4: Uruchomić regresję study/runtime**

  Expected: brak requestu Run w stanie blocked/stale; dokładnie jeden command po ready.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx apps/control-room/src/kernel/runtime
  git commit -m "feat(authoring): build and run scratch studies"
  ```

### Task 12: Kanoniczny eksport bez skryptu wejściowego

**Pliki:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/helper.py`
- Modify: `crates/fullmag-api/src/script.rs`
- Modify: `crates/fullmag-api/src/main.rs:2991-3220`
- Create: `packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py`
- Create: `packages/fullmag-py/tests/fixtures/scratch_authoring_fdm_problem_ir_0_3.json`
- Create: `packages/fullmag-py/tests/fixtures/scratch_authoring_fem_problem_ir_0_3.json`

**Interfejsy:**
- Produces: `render_scene_document_as_script(scene_document_json, output_path)` działające dla kompletnego modelu bez wcześniejszego `load_problem_from_script`; incomplete scene zwraca jawne blokery readiness.

- [ ] **Krok 1: Napisać RED UI → Python → reload → IR**

  Dwa fixtures SceneDocument budują FDM i FEM. Test renderuje Python, ładuje go publicznym loaderem, obniża do ProblemIR i porównuje semantycznie z goldenem: object id/name/type, geometry+translation, material, texture, interactions, grid/mesh policy/airbox, study i requested execution.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `python -m pytest packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py -q`

  Expected: FAIL, obecny helper wymaga istniejącego prawidłowego skryptu bazowego.

- [ ] **Krok 3: Wyodrębnić bezpośredni renderer buildera**

  Renderer używa tych samych funkcji kanonicznych co `render_loaded_problem_as_script`, ale przyjmuje kompletny builder/SceneDocument i nie tworzy placeholder magnet. API wywołuje nowy helper tylko po `ready_to_export`; zapis pozostaje atomowy.

  ```python
  def render_scene_document_as_script(scene_document: dict[str, object]) -> str:
      builder = build_builder_from_scene_document(scene_document)
      validate_complete_builder(builder)
      return render_builder_as_script(builder)
  ```

- [ ] **Krok 4: Uruchomić wszystkie round-trip tests**

  Run: `python -m pytest packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py packages/fullmag-py/tests/test_script_builder_roundtrip.py packages/fullmag-py/tests/test_fdm_ui_roundtrip.py packages/fullmag-py/tests/test_preset_texture_roundtrip.py -q`

  Expected: PASS, oba goldeny mają `schema_version == "0.3"`.

- [ ] **Krok 5: Commit**

  ```text
  git add packages/fullmag-py/src/fullmag/runtime packages/fullmag-py/tests crates/fullmag-api/src/script.rs crates/fullmag-api/src/main.rs
  git commit -m "feat(authoring): export scratch scenes to Python"
  ```

### Task 13: Invalidation i stabilność E3

**Pliki:**
- Modify: `apps/control-room/src/kernel/authoring/regionAuthoringInvalidation.ts`
- Modify: `apps/control-room/src/kernel/authoring/regionAuthoringInvalidation.test.ts`
- Modify: `apps/control-room/src/modules/inspector/ScratchAuthoringInspectorStability.test.tsx`
- Modify: odpowiednie resource hooks meshing/fields/readiness

**Interfejsy:**
- Produces: jedna tabela mutation-kind → invalidated resource prefixes; metryki testowe request/render/topology upload.

- [ ] **Krok 1: Napisać RED macierzy invalidacji**

  Asercje: material bez topology rebuild; texture/interactions unieważniają initial/results; geometry/translation/grid/domain oznaczają mesh stale; field update nie pobiera topology; ACK ma ograniczoną liczbę requestów; root/focus/scroll stabilne.

- [ ] **Krok 2: Potwierdzić RED**

  Run: `pnpm --dir apps/control-room vitest run src/kernel/authoring/regionAuthoringInvalidation.test.ts src/modules/inspector/ScratchAuthoringInspectorStability.test.tsx`

- [ ] **Krok 3: Scentralizować mapę bez globalnego pending**

  Websocket publikuje wyłącznie revision invalidation. Każdy panel subskrybuje target-scoped selector, a jeden owner zarządza zasobem w drzewie panelu.

- [ ] **Krok 4: Uruchomić regresję resource hooks i inspectorów**

  Run: `pnpm --dir apps/control-room test`

  Expected: PASS, brak duplikowanych subskrypcji i remountów.

- [ ] **Krok 5: Commit**

  ```text
  git add apps/control-room/src/kernel/authoring apps/control-room/src/modules/inspector
  git commit -m "fix(frontend): preserve authoring state across revisions"
  ```

### Task 14: Browser E1/E2/E5 i dowody WebGL

**Pliki:**
- Create: `apps/control-room/scripts/lib/scratch-authoring-browser.mjs`
- Create: `apps/control-room/scripts/lib/scratch-authoring-browser.test.mjs`
- Create: `apps/control-room/scripts/smoke-scratch-authoring-fdm.mjs`
- Create: `apps/control-room/scripts/smoke-scratch-authoring-fem.mjs`
- Create: `apps/control-room/scripts/fixtures/scratch-authoring/fdm.v1.json`
- Create: `apps/control-room/scripts/fixtures/scratch-authoring/fem.v1.json`
- Modify: `apps/control-room/package.json`
- Modify: `justfile`

**Interfejsy:**
- Produces: manifest JSON z inputami, revisions, command ids/states, normalized IR, WebGL health, request/render/topology counters i ścieżkami screenshotów.

- [ ] **Krok 1: Napisać RED helpera i scenariuszy**

  Helper startuje na API bez skryptu, nie stubuje odpowiedzi. FDM: New → Box → Apply → Move input → drag → material → uniform → Exchange+Demag → Apply Grid → Relax → Run → export/reload. FEM: analogicznie plus shared-domain/airbox/build/quality. E5 obejmuje invalid dimension, unavailable capability, stale mesh i realny `409` wywołany konkurencyjną mutacją.

- [ ] **Krok 2: Potwierdzić RED helpera**

  Run: `node --test apps/control-room/scripts/lib/scratch-authoring-browser.test.mjs`

  Expected: FAIL przed dodaniem sterownika/selektorów.

- [ ] **Krok 3: Dodać stabilne selektory i manifest dowodowy**

  Po każdym checkpoint sprawdzać dokładnie jeden widoczny canvas, `isContextLost() === false`, drawing buffer > 0, brak startupowego Context Lost, bounded request/render counts i brak topology upload po samym field update/drafcie.

- [ ] **Krok 4: Dodać receptury `just`**

  ```text
  run-scratch-authoring-fdm-browser-smoke
  run-scratch-authoring-fem-browser-smoke fem_execution="cpu"
  verify-scratch-authoring-browser-matrix
  ```

  FEM recipe wywołuje `ensure-managed-fem-runtime` i zarządzany runtime z `FULLMAG_FEM_EXECUTION=cpu`; nie host-buildzi natywnego solvera.

- [ ] **Krok 5: Uruchomić browser qualification**

  Run: `just run-scratch-authoring-fdm-browser-smoke`

  Run: `just ensure-managed-fem-runtime`

  Run: `just run-scratch-authoring-fem-browser-smoke fem_execution=cpu`

  Expected: oba PASS, screenshots przed/po i dwa kompletne manifesty dowodowe.

- [ ] **Krok 6: Commit**

  ```text
  git add apps/control-room/scripts apps/control-room/package.json justfile
  git commit -m "test(authoring): qualify scratch FDM and FEM flows"
  ```

### Task 15: Końcowa bramka jakości i dokumentacja

**Pliki:**
- Inspect: `docs/superpowers/specs/2026-08-23-scratch-simulation-authoring-design.md`; zmienić i osobno uzasadnić wyłącznie udowodnioną korektę kontraktu
- Evidence: `.fullmag/test-results/scratch-authoring/*` (nie commitować artefaktów binarnych, jeśli katalog jest ignorowany)

**Interfejsy:**
- Produces: powtarzalny dowód ukończenia E1–E5; zero deklaracji sukcesu przed wszystkimi bramkami.

- [ ] **Krok 1: Uruchomić testy kontraktu i frontend**

  ```text
  cargo test -p fullmag-api router_v2
  pnpm --dir apps/control-room generate:api
  pnpm --dir apps/control-room test
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room lint
  node --test apps/control-room/scripts/lib/scratch-authoring-browser.test.mjs
  python -m pytest packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py -q
  bash scripts/ci-resource-first-gates.sh --strict
  bash scripts/ci/contract_guard.sh --strict
  ```

  Expected: każdy command exit 0; po generatorze `git diff --exit-code` nie wykazuje nieodtworzonych typów.

- [ ] **Krok 2: Uruchomić pełną macierz browser/FEM**

  ```text
  just run-scratch-authoring-fdm-browser-smoke
  just ensure-managed-fem-runtime
  just run-scratch-authoring-fem-browser-smoke fem_execution=cpu
  just verify-fem-relaxation-runtime
  ```

  Jeśli zmienił się natywny kod FEM/MFEM/hypre/libCEED, najpierw uruchomić `just rebuild-fem-runtime`. Expected: exit 0 oraz dowody requested/effective/resolved == FEM/CPU bez fallbacku.

- [ ] **Krok 3: Wykonać wizualną inspekcję screenshotów**

  Porównać stan pusty, primitive draft, model gotowy, FDM grid, FEM mesh+airbox i wynik. Odrzucić wynik z niewidocznym/zerowym canvasem, context loss, nałożonym wireframe przy kwalifikacji wektorów, resetem focus/scroll albo znikającym Inspectorem.

- [ ] **Krok 4: Sprawdzić diff i wygenerowane pliki**

  Run: `git diff --check`

  Run: `git status --short`

  Expected: brak whitespace errors i wyłącznie pliki należące do zakresu.

- [ ] **Krok 5: Poprosić o dwustopniowy code review**

  Użyć `requesting-code-review`: najpierw zgodność ze specyfikacją i E1–E5, następnie jakość kodu, lifecycle, API hygiene i test reliability. Wszystkie uwagi P0/P1/P2 rozwiązać przed finalnym commitem.

- [ ] **Krok 6: Finalny commit**

  ```text
  git add docs/superpowers/specs/2026-08-23-scratch-simulation-authoring-design.md
  git commit -m "feat: complete scratch simulation authoring"
  ```

## Definicja ukończenia

Implementacja jest ukończona tylko wtedy, gdy prawdziwe E1 FDM i E2 FEM zaczynają się od API bez bieżącej sesji i kończą wynikiem oraz eksportem, E3 dowodzi poprawnej invalidacji/stabilności, E4 porównuje przeładowany ProblemIR 0.3, a E5 przechodzi na rzeczywistych błędach i konflikcie. Zielone testy komponentowe bez tych browserowych i semantycznych dowodów nie spełniają planu.


## Stan realizacji 2026-08-24

Zrealizowane w worktree:

- implementacja scratch authoringu obejmująca SceneDocument, primitive geometry,
  materiał, teksturę magnetyczną, interactions, transform, stage, FDM/FEM
  study settings oraz canonical script export;
- pełny FDM API/runtime scenario z `mesh_build`, `relax`, rewizjami,
  invalidacjami i terminalnym ACK;
- stabilizacja attached-session handoff, owner-scoped command polling i
  ochrona API przed przejęciem komendy starej sesji;
- normalizacja kluczy FDM grid z object ID/region ID do nazwy użytkownika oraz
  regresja eksportu.

Bramki:

- helper kontraktowy: **6/6 PASS**;
- Python scratch round-trip: **7 passed**;
- buildy CLI/API: **PASS**;
- FDM API/runtime E2-like: **PASS**;
- pełny browser/WebGL E1/E2/E5: **BLOCKED** przez timeout SSR Next przy
  `page.goto(/workspace)`;
- managed FEM i FEM browser qualification: **BLOCKED** przez launcher
  Windows/WSL i brak managed runtime.

Plan pozostaje otwarty wyłącznie dla bramek zależnych od działającej
infrastruktury browser/WebGL oraz managed FEM; nie są one oznaczone jako
ukończone na podstawie testów kontraktowych.

Aktualizacja stabilizacji runtime: failure endpoint ma test API **1 passed**,
supervisor czeka na terminalny ACK po wyjściu procesu i wiąże attached runtime
z `(session_id, backend, scene_revision)`. Te zmiany nie zmieniają statusu
bramek browser/WebGL ani managed FEM, które nadal wymagają infrastruktury.

Aktualizacja cancellation: worker owner-loss budzi runner i kończy główną
pętlę solvera po podmianie sesji. Nadal pozostaje ryzyko, że Windows
`Child::kill()` nie zamknie całego drzewa potomnego; wymaga to osobnej bramki
procesowej na docelowym launcherze.

Po tej aktualizacji `cargo check -p fullmag-cli --bin fullmag` przechodzi,
test owner-loss ma **1 passed**, a filtr `wait_for_solve` ma **4 passed**.

### Aktualizacja realizacji 2026-08-24 — E1 FDM zamknięte dowodem

- Pełny browser smoke FDM przeszedł w osobnym worktree: rewizje authoringu
  `0..8`, `mesh_build` i `relax` zakończone terminalnie, eksport skryptu
  wygenerowany, a manifest zawiera `requested/resolved` lane oraz provenance.
- WebGL smoke potwierdził jeden widoczny canvas, brak utraty kontekstu i niezerowy
  drawing buffer `617x525`; limit żądań i mutacji DOM został zachowany.
- Naprawiono realną regresję lifecycle: żądania pól z viewportu nie wysyłają
  `compute_fields` przed buildem nieaktualnego mesha. Gate korzysta z
  `model/geometry/validation`, a równoległe odczyty świeżości są współdzielone
  tylko in-flight; brak autorytatywnej odpowiedzi jest traktowany fail-closed.
- Zaktualizowana weryfikacja: `ControlRoomApi` **129/129**, helper **7/7**,
  Python scratch round-trip **9 passed**, focused viewport guard **1 passed**.
- Harness kwalifikuje również request failures i tylko jawnie znane odpowiedzi
  opcjonalnych zasobów; jawnie authored DMI z wartością `0` pozostaje w
  eksporcie, bez automatycznej aktywacji z material defaults.
- E2 FEM pozostaje otwarte wyłącznie z powodu niedostępnego managed FEM runtime;
  wymagane są `just ensure-managed-fem-runtime` i późniejszy smoke FEM/CPU.
