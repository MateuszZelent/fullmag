# Explorer, Inspectors and FEM/FDM Regions Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Naprawić wszystkie P0/P1/P2 z audytu Explorera i Inspectorów oraz zapewnić poprawne, wspólne semantycznie renderowanie Airboxa i co najmniej dwóch regionów w FEM i FDM.

**Architecture:** Explorer jest projekcją rzeczywistych zasobów HTTP v2, a nie statycznym drzewem ekranowym. Wspólny semantic target catalog rozwiązuje `airbox` i `region:<objectId>:<encodedRegionId>` do lane-specific carrierów; ten sam carrier i revision filtruje geometrię, scalar fields, vectors, picking i Inspector diagnostics. Renderer pozostaje lane-neutral.

**Tech Stack:** TypeScript, React 19, Next.js 16, Zustand, Three.js/R3F, Vitest, Playwright, Rust/Axum, OpenAPI v2.

## Global Constraints

- Zachować jeden workspace, jeden Explorer, jeden Inspector registry i jeden viewport dla FEM/FDM.
- React components nie wykonują bezpośredniego `fetch()` i nie budują ścieżek `/v2`; używają `ControlRoomApi` i resource hooks.
- HTTP v2 pozostaje źródłem prawdy; WebSocket tylko unieważnia zasoby.
- Publiczne target IDs to `airbox`, `object:<objectId>`, `region:<objectId>:<encodedRegionId>` i `mesh-part:<meshPartId>`.
- `fdm-universe-outside-support` jest wyłącznie wejściem migracji v2 i nie jest ponownie zapisywany.
- Geometria i pola targetu używają tej samej ownership identity i revision; mismatch zamyka renderowanie pola.
- R3F pozostaje `frameloop="demand"`; zmiana quantity/membership nie przebudowuje topologii bez zmiany topology/grid revision.
- Nie obniżać domyślnej jakości wizualizacji ani glyph density jako naprawy wydajności.
- Wszystkie nowe klasy CSS używają prefiksu `fm-` i istniejących tokenów `--fm-*`.
- Chronić niezwiązane zmiany w brudnym checkoutcie; staging i commity są path-specific.

---

### Task 1: Izolacja i baseline zależnych zmian Airboxa

**Files:**
- Read: `docs/superpowers/specs/2026-08-07-explorer-inspectors-regions-fdm-fem-remediation-design.md`
- Read: `docs/audits/2026-08-07-explorer-inspectors-fdm-fem-audit.md`
- Create worktree: `.worktrees/explorer-inspectors-regions-remediation`
- Create: `/tmp/explorer-inspectors-regions-relevant.patch`

**Interfaces:**
- Consumes: bieżący `HEAD` z zatwierdzoną specyfikacją oraz sklasyfikowane istniejące zmiany Airbox/viewport.
- Produces: izolowany branch z wyłącznie zależnymi zmianami wejściowymi i zielonym baseline testów frontendowych.

- [ ] **Step 1: Sklasyfikuj istniejący patch**

Uruchom `git diff --name-only` i zachowaj tylko pliki bezpośrednio dotyczące `ObjectVisualizationController`, field catalog/materialization, Airbox render plan, `BoundsLayers`, `Viewport3DScene`, `useViewport3DSceneModel`, `viewport3DFieldDataPlan` oraz odpowiadające testy. Wyklucz lock/export scripts, standard problems i niezwiązane backend physics.

- [ ] **Step 2: Utwórz izolowany worktree**

```bash
git worktree add .worktrees/explorer-inspectors-regions-remediation -b fix/explorer-inspectors-regions-remediation
```

Expected: worktree utworzony z bieżącego `HEAD`, a główny checkout pozostaje nietknięty.

- [ ] **Step 3: Przenieś wyłącznie zależny patch**

Utwórz path-scoped patch przez `git diff -- <approved files>` i zastosuj go w worktree przez `git apply`. Przed zastosowaniem sprawdź listę ścieżek w patchu.

- [ ] **Step 4: Uruchom baseline**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test -- --run src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Expected: exit 0. Jeśli baseline nie jest zielony, zatrzymaj implementację i napraw/sklasyfikuj pre-existing failure przed Task 2.

### Task 2: Resource-first Frequency Domain presence i Explorer runtime resources

**Files:**
- Modify: `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Test: `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`
- Test: `apps/control-room/src/modules/explorer/ExplorerModule.test.tsx`

**Interfaces:**
- Consumes: `StageExecutionResource`, `FrequencyDomainManifestResource`, `FieldCatalogResource`, mesh summary/status, command queue, current run, artifacts i thin status revisions.
- Produces: `FrequencyDomainPresence`, rozszerzone `ExplorerTreeResources` i drzewa bez statycznych/fikcyjnych stanów.

- [ ] **Step 1: Napisz failing tests presence**

Dodaj pure-model tests wymagające:

```ts
expect(resolveFrequencyDomainPresence({ stageExecution: timeDomainOnly, manifest: null })).toBe(false);
expect(resolveFrequencyDomainPresence({ stageExecution: eigenmodesStage, manifest: null })).toBe(true);
expect(resolveFrequencyDomainPresence({ stageExecution: null, manifest })).toBe(true);
```

oraz brak wszystkich `*.frequency_domain.*` węzłów w czterech zakładkach zwykłej sesji FDM i FEM.

- [ ] **Step 2: Uruchom testy i potwierdź RED**

```bash
pnpm --dir apps/control-room test -- --run src/modules/explorer/builders/buildModelTree.test.ts src/kernel/resources/studyRuntimeResources.test.ts
```

Expected: FAIL, ponieważ builder nadal bezwarunkowo tworzy Frequency Domain.

- [ ] **Step 3: Zaimplementuj czystą bramkę**

Dodaj:

```ts
export interface FrequencyDomainPresenceInput {
  manifest: FrequencyDomainManifestResource | null;
  stageExecution: StageExecutionResource | null;
}

export function resolveFrequencyDomainPresence(input: FrequencyDomainPresenceInput): boolean {
  return Boolean(input.manifest) || Boolean(
    input.stageExecution?.stages.some((stage) =>
      stage.kind === "eigenmodes" || stage.kind === "frequency_response",
    ),
  );
}
```

Nie używaj capability ani heurystyk artifact path. Włącz FD hooks i buildery tylko przy prawdziwej obecności.

- [ ] **Step 4: Napisz failing tests danych runtime**

Fixtures mają wymagać badge z field catalogu, `m` z unit `1`, rzeczywistej mesh revision, rzeczywistego command queue state i statusu `not published` zamiast literałów.

- [ ] **Step 5: Zasil drzewo istniejącymi hooks**

Rozszerz `ExplorerTreeResources` o typed read models. Generuj field nodes z `FieldDescriptor`, mesh z current revisions, jobs z queue/run/stages i diagnostics z thin resource revisions. Usuń literały `m, H_demag`, `revision 0`, `A/m`, `idle` i fałszywe `ready`.

- [ ] **Step 6: Uruchom testy GREEN**

```bash
pnpm --dir apps/control-room test -- --run src/modules/explorer/builders/buildModelTree.test.ts src/kernel/resources/studyRuntimeResources.test.ts src/modules/explorer/ExplorerModule.test.tsx
```

Expected: wszystkie wskazane testy PASS.

### Task 3: Runtime resource selections i kompletne Inspectory

**Files:**
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/RuntimeResourceInspectorPanels.tsx`
- Test: `apps/control-room/src/modules/explorer/explorerSelection.test.ts`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Test: `apps/control-room/src/modules/inspector/RuntimeResourceInspectorPanels.test.tsx`

**Interfaces:**
- Consumes: resource-backed Explorer nodes z Task 2.
- Produces: `runtime-resource` selection oraz dedykowane overview/field/mesh/job/diagnostics panele.

- [ ] **Step 1: Napisz test kompletności registry**

Test buduje minimalne drzewa FDM i FEM, filtruje `selectable !== false` i wymaga, aby `resolveInspectorPanel()` nie zwrócił `placeholder`. Jawna allowlista zawiera tylko niewybieralne foldery.

- [ ] **Step 2: Potwierdź RED**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorRegistry.test.tsx src/modules/explorer/explorerSelection.test.ts
```

Expected: FAIL dla resources/results/jobs/diagnostics roots i leaf nodes.

- [ ] **Step 3: Dodaj typed selection**

```ts
interface RuntimeResourceSelectionRef {
  type: "runtime-resource";
  kind: ExplorerNodeKind;
  nodeId: string;
  resourceId: string;
  quantityId?: string;
}
```

Mapuj wybieralne runtime nodes bez zmiany modułowych granic.

- [ ] **Step 4: Dodaj dedykowane panele**

Panele czytają wyłącznie resource hooks i pokazują identity, revision/freshness, unit, availability, sample count/scope, command state i diagnostics. Rooty mogą być niewybieralne, jeśli nie mają prawdziwego overview.

- [ ] **Step 5: Usuń produkcyjny wildcard**

`PlaceholderPanel` pozostaje tylko jawnym development error boundary poza normalnym `PANELS`, a test blokuje jego użycie przez wybieralny node.

- [ ] **Step 6: Uruchom testy GREEN**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorRegistry.test.tsx src/modules/explorer/explorerSelection.test.ts src/modules/inspector/RuntimeResourceInspectorPanels.test.tsx
```

### Task 4: Boundary Faces FEM i opcjonalne interaction resources

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesOverviewPanel.tsx`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
- Test: właściwe testy routera `crates/fullmag-api/src/router_v2/**`
- Test: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesOverviewPanel.test.tsx`
- Test: `apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts`

**Interfaces:**
- Consumes: `MeshPartResource.boundary_face_count`, `boundary_face_indices`, object interaction kind.
- Produces: spójny manifest boundary faces oraz `200 present:false` dla poprawnej, nieaktywnej interakcji.

- [ ] **Step 1: Dodaj failing backend tests**

Test outer boundary zaczyna od source count 0 i 180 resolved indices, a odpowiedź musi mieć count 180. Test poprawnego object/kind bez konfiguracji wymaga HTTP 200 z `present:false`, `enabled:false`; unknown object/kind pozostaje 404.

- [ ] **Step 2: Potwierdź RED właściwym cargo testem**

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
```

Expected: nowe testy FAIL.

- [ ] **Step 3: Napraw semantykę backendu**

Po rozwiązaniu boundary indices ustaw count z opublikowanej listy i waliduj równość. Nie dodawaj ciężkich danych do statusu. Znormalizuj brak opcjonalnej interakcji przed serializacją odpowiedzi.

- [ ] **Step 4: Dodaj frontend contract diagnostics**

Panel rozróżnia `consistent`, `manifest-inconsistent`, `unavailable`; przy rozjeździe pokazuje obie wartości i nie zgaduje. Hook nie musi maskować oczekiwanego 404 dla poprawnej interakcji.

- [ ] **Step 5: Uruchom backend i frontend tests**

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/boundary-faces/BoundaryFacesOverviewPanel.test.tsx src/kernel/resources/geometryLifecycleResources.test.ts
```

Jeśli JSON schema zmieni się, uruchom generator OpenAPI i sprawdź brak ręcznej edycji generated transport.

### Task 5: Kanoniczne region carriers i FDM mask accounting

**Files:**
- Modify: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFdmTargetViews.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/model/viewport3DFdmTargetViews.test.ts`

**Interfaces:**
- Consumes: DomainMeta, descriptor/binary FMRM, object-qualified region legend.
- Produces: lane-neutral catalog entry kind `region`, `RegionCarrierResolution` i `TargetMaskAccounting`.

- [ ] **Step 1: Napisz failing fixtures FDM**

Fixture `20×12×6` ma 120 selected cells i 1320 Airbox. Drugi fixture ma dwa obiekty z tą samą lokalną nazwą regionu, lecz różnymi numeric IDs. Testy wymagają owner-qualified targetów, pełnego partition i braku cross-painting.

- [ ] **Step 2: Potwierdź RED**

```bash
pnpm --dir apps/control-room test -- --run src/kernel/selection/semanticRenderTargetCatalog.test.ts src/modules/inspector/panels/fdmMeshInspectorModel.test.ts src/modules/viewport-3d/model/viewport3DFdmTargetViews.test.ts
```

- [ ] **Step 3: Rozszerz katalog i resolver**

Dodaj `region` do `SemanticRenderTargetKind`. Target ID buduj istniejącą funkcją kodującą object/region. `RegionCarrierResolution` przechowuje identity/revision/numeric IDs, a buffers pozostają w resource cache.

- [ ] **Step 4: Napraw FDM Object Mesh**

Rozwiązuj legendę przez owner-qualified canonical entry, nie surowe literalne porównanie authoring aliasu. `ready` wymaga:

```ts
selected + foreignActive + activeUnassigned + inactive === totalCells
```

W przeciwnym razie zwróć `not-materialized` lub `stale` z diagnostyką.

- [ ] **Step 5: Zwiąż geometry i field views z jedną revision**

Zmiana membership revision przy stałym grid fingerprint przebudowuje target cell indices i derived field mask razem; stale render adoption jest odrzucany.

- [ ] **Step 6: Uruchom testy GREEN**

Powtórz komendę z kroku 2 i wymagaj exit 0.

### Task 6: FEM region carriers, Airbox mask accounting i picking

**Files:**
- Modify: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dSelection.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshInspectorModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshStatisticsPanel.tsx`
- Test: corresponding `.test.ts`/`.test.tsx` files.

**Interfaces:**
- Consumes: FEM manifest, region membership, `mesh_part_ids`, topology/membership revisions.
- Produces: `FemRegionCarrier`, complete Airbox accounting i wspólny picking targetu regionu.

- [ ] **Step 1: Napisz failing FEM tests**

Fixture wymaga regionu z wieloma mesh parts, identycznego part setu dla geometry/field/Inspector/picking oraz Airbox accounting `207 carrier`, `145 exclusive air`, `62 shared interface`, `780 air elements`.

- [ ] **Step 2: Potwierdź RED**

```bash
pnpm --dir apps/control-room test -- --run src/kernel/selection/semanticRenderTargetCatalog.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/viewport3dSelection.test.ts src/modules/inspector/panels/airbox/airboxMeshInspectorModel.test.ts
```

- [ ] **Step 3: Przenieś region mapping do wspólnego katalogu**

Usuń boczne `regionTargetByPartId` jako źródło prawdy. Katalog reprezentuje jednoznaczne region ownership; multi-owner/overlap daje typed ambiguity zamiast nadpisania mapy.

- [ ] **Step 4: Zwiąż field request i picking z carrierem**

Scoped field request używa dokładnie `carrier.meshPartIds`. Kliknięcie partu i węzła Explorera wybiera identyczny region target. Membership bez aktualnych parts daje tylko diagnostic overlay, bez physical field.

- [ ] **Step 5: Dodaj pełne Airbox diagnostics**

Inspector pokazuje carrier/exclusive/shared counts, element count, mask identity/revision oraz coverage state.

- [ ] **Step 6: Uruchom testy GREEN**

Powtórz komendę z kroku 2 i wymagaj exit 0.

### Task 7: Jeden Airbox target, display-state migration v2 i uproszczone drzewo FDM

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts` lub wygenerowane typy wyłącznie przez generator, jeśli backend registry się zmieni
- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Test: selection, builder, controller i backend display tests.

**Interfaces:**
- Consumes: stare persisted IDs i settings.
- Produces: jeden `airbox`, jawne region registry oraz requested/resolved settings z typed reason.

- [ ] **Step 1: Napisz failing migration tests**

Wymagaj idempotentnego mapowania `fdm-universe-outside-support -> airbox`, braku starego ID po zapisie oraz osobnych requested/resolved values dla niedozwolonego `surface`.

- [ ] **Step 2: Potwierdź RED**

Uruchom narrow frontend controller/selection tests oraz właściwy backend visualization test.

- [ ] **Step 3: Zaimplementuj registry i migrację**

Backend registry obejmuje `regions` oraz typed source. Effective target publikuje requested/resolved/reason. Frontend nie utrzymuje osobnego FDM Airbox targetu.

- [ ] **Step 4: Uprość FDM Explorer**

`Universe/Airbox` zachowuje Scope & Membership, Visualization i Debug. Descriptor, Mask, Regions i Provenance pozostają wyłącznie w `Mesh/Structured Grid`. Usuń puste FEM-only Quality/Topology/Build z FDM Airboxa.

- [ ] **Step 5: Uruchom wszystkie narrow tests GREEN**

Expected: brak starego targetu poza migratorem i fixtures migracji.

### Task 8: Visualization Debug, Object General i Inspector Shell

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/objectGeneralPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.ts`
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/modules/inspector/InspectorModule.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.lane.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/objectGeneralPanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/InspectorShell.test.tsx`

**Interfaces:**
- Consumes: resolved target/carrier diagnostics, scene authoring state, runtime discretization, descriptor action capabilities.
- Produces: pełny FDM debug, rozdzielone authoring/runtime labels i capability-aware actions.

- [ ] **Step 1: Napisz failing tests**

FDM Debug wymaga fingerprint, membership revision, target cells, field samples, coverage, resolved mode i glyph budget. Object General wymaga osobnych `Geometry source` i `Realized discretization`. Spatial selections mają Focus; jobs/diagnostics nie mają aktywnego Focus/Isolate.

- [ ] **Step 2: Potwierdź RED**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.lane.test.tsx src/modules/inspector/panels/visualization-debug/VisualizationDebugPanelModel.test.ts src/modules/inspector/panels/objectGeneralPanelModel.test.ts src/modules/inspector/InspectorShell.test.tsx
```

- [ ] **Step 3: Zaimplementuj debug i object read model**

Usuń FEM-only gate. Zestaw scene i runtime resources bez dodawania nowego endpointu, jeśli istniejące zasoby wystarczają.

- [ ] **Step 4: Dodaj declarative Inspector actions**

```ts
interface InspectorActionDescriptor {
  focus?: { enabled: boolean; reason?: string };
  isolate?: { enabled: boolean; reason?: string };
}
```

Shell renderuje tylko znaczące akcje. `Copy node ID` używa `copyTextToClipboard()` i pokazuje feedback błędu.

- [ ] **Step 5: Uruchom testy z kroku 2 ponownie i wymagaj GREEN**

Expected: wszystkie PASS, w tym brak Clipboard API.

### Task 9: Konsolidacja Planar Monitors i usunięcie konkurencyjnego Visualizations 2D

**Files:**
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify/Delete from active path: `apps/control-room/src/modules/explorer/builders/crossSectionExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify tests: Explorer/selection/field-map integration tests.

**Interfaces:**
- Consumes: Planar Monitor authoring resources i compatibility mesh cross-section export.
- Produces: Model/Planar Monitors i Results/field-map bez równoległego `Visualizations 2D` workflow.

- [ ] **Step 1: Napisz failing tree tests**

Normalne drzewo nie zawiera `visualizations-2d.*`. Planar Monitor ma dedykowany Inspector i otwiera `field-map`. Compatibility cross-section pozostaje tylko export/fallback i nie tworzy rootu.

- [ ] **Step 2: Potwierdź RED**

Uruchom builder i selection tests.

- [ ] **Step 3: Usuń aktywną legacy branch**

Usuń builder call i remapping selection z aktywnego drzewa. Zachowaj binary export facade/resource zgodnie ze specem 2D.

- [ ] **Step 4: Uruchom testy GREEN**

Expected: brak legacy node kinds w runtime tree.

### Task 10: Pełne bramki, runtime FEM/FDM i dowody wizualne

**Files:**
- Modify/Create: `apps/control-room/scripts/smoke-explorer-inspectors-regions.mjs`
- Create: `apps/control-room/.artifacts/explorer-inspector-regions-audit/*` lub wskazany zewnętrzny katalog dowodów
- Update: `docs/audits/2026-08-07-explorer-inspectors-fdm-fem-audit.md`

**Interfaces:**
- Consumes: wszystkie implementacje Tasks 2–9 i żywe sesje FDM/FEM.
- Produces: mechaniczny completion audit, JSON evidence i screenshots.

- [ ] **Step 1: Uruchom frontend verification**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
pnpm --dir apps/control-room build
```

- [ ] **Step 2: Uruchom architecture/API gates**

```bash
rg "from ['\"]\.\./" apps/control-room/src/modules
rg "apps/web|ControlRoomContext|normalizeSession|mergeSession" apps/control-room/src
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

- [ ] **Step 3: Uruchom viewport/performance gates**

```bash
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room test -- --run viewport-memory-stress
pnpm --dir apps/control-room test -- --run chart
pnpm --dir apps/control-room audit:idle-performance
```

- [ ] **Step 4: Uruchom React Doctor**

```bash
npx -y react-doctor@latest apps/control-room --verbose --diff
```

Expected: brak regresji score; nowe errors/warnings naprawione.

- [ ] **Step 5: Browser audit każdego węzła**

Dla żywych sesji FDM i FEM kliknij wszystkie wybieralne nodes w pięciu zakładkach. Gate wymaga: zero PlaceholderPanel, zero niespodziewanych 4xx/5xx, zero console errors i brak fikcyjnych workflow.

- [ ] **Step 6: Region/Airbox viewport proof**

Dla Airboxa i dwóch regionów w obu lane'ach przełącz surface, wireframe, points i `H_demag` vectors; wykonaj isolate i picking. Zapisz screenshoty oraz JSON z target ID, mask/carrier count, sample count, revisions, drawing buffer i `gl.isContextLost()`.

- [ ] **Step 7: Zaktualizuj audyt punkt po punkcie**

Każde P0/P1/P2 otrzymuje status, źródło poprawki, test i runtime evidence. Nieweryfikowalne wymaganie pozostaje otwarte; nie oznaczaj całego celu jako ukończonego.

- [ ] **Step 8: Final code review i completion audit**

Uruchom szeroki reviewer subagent na pełnym diffie, napraw wszystkie Critical/Important findings, uruchom test wskazany w zadaniu obejmującym każdy zmieniony symbol oraz pełne komendy ze Steps 1–4, a następnie porównaj wszystkie 12 sekcji specyfikacji i 10 zadań planu z bieżącym stanem.
