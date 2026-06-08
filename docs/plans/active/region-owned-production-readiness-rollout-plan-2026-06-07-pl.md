# Region-owned semantics: plan dojscia do jakosci produkcyjnej

Data: 2026-06-07

Status: plan produkcyjnego domkniecia wdrozenia

Powiazane dokumenty:

- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
- `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`
- `docs/plans/active/region-owned-mesh-material-texture-plan-2026-06-04-pl.md`
- `docs/plans/active/region-viewport-ui-authoring-plan-2026-06-06-pl.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- `docs/adr/0011-resource-first-api.md`
- `docs/adr/0013-frontend-v2-module-kernel.md`

## 1. Cel dokumentu

Ten dokument nie zastepuje masterplanu z 2026-06-04. Jego rola jest bardziej
operacyjna: okresla, co trzeba jeszcze zrobic, zeby region-owned semantics
przestaly byc czesciowo wdrozonym kontraktem authoringu, a staly sie
produkcyjna funkcja Fullmag.

Produktowy standard docelowy:

1. Region jest sub-obiektem wlasciciela, nie osobnym materialem fizycznym.
2. Region dziedziczy geometrie kontekstu, material, texture, mesh policy i
   visualization parenta, ale moze lokalnie nadpisac wybrane aspekty.
3. Dodanie albo edycja regionu nie niszczy istniejacego meshu ani nie zmienia
   trybu wizualizacji glownego obiektu.
4. Region nie moze wyjsc poza obiekt rodzica.
5. Jeden obiekt z regionami pozostaje jednym ciaglym polem `m`, chyba ze
   uzytkownik jawnie deklaruje fizyczne rozdzielenie przez osobne obiekty albo
   explicit coupling.
6. Python DSL, UI, `ProblemIR`, planner, runtime, OpenAPI i script export
   opisuja te sama semantyke.
7. Backend, ktory nie potrafi zrealizowac authored intent, blokuje run
   diagnostyka capability. Nie wolno cicho ignorowac regionow, pol
   materialowych ani couplingow.

## 2. Stan poczatkowy

Aktualne wdrozenie ma juz silne fundamenty:

| Warstwa | Stan | Uwagi |
|---|---|---|
| Fizyka | w duzej mierze gotowe | Nota `0104` definiuje obiekty, regiony, material fields, RKKY, exchange i airbox. |
| Python DSL | w duzej mierze gotowe | Sa `RegionRegistry`, `ObjectRegion`, `MaterialParameterField`, `CouplingRegistry`, `fm.shapes`, `fm.fields`, `fm.couplings`. |
| `ProblemIR` | w duzej mierze gotowe | Sa `object_regions`, `material_parameter_fields`, `couplings` i walidacja z testami shape/mesh_policy/material_overrides/coupling. |
| SceneDocument | w duzej mierze gotowe | Sa typed structs: `SceneObjectRegion`, `SceneRegionShape` (enum Box/Cylinder/Sphere/Csg), `SceneRegionMeshPolicy`, `SceneRegionMaterialOverride`, `SceneMaterialParameterValue`, `SceneTextureOverride`, `SceneCoupling`, `SceneCouplingEndpoint`, `SceneCouplingParameters` i `SceneObjectRegionPatch`. Wszystkie maja `utoipa::ToSchema`. Pozostaly dlug kontraktu to glownie raw/merge patch payloady poza object-region create/patch i reczne parsery frontendowe w czesci modeli, nie podstawowa scene schema. |
| Planner | w duzej mierze gotowe | Sa capability gates dla: material_parameter_fields, material_overrides, mesh_policy, texture_override, realization_policy (conformal/project), coupling executability. `validate_region_owned_planning()` blokuje run z czytelnymi komunikatami. FDM CUDA exchange pairs sa executable. |
| FDM runtime | czesciowo gotowe | Planner materializuje authored `object_regions` do `region_mask` dla FDM single-grid (`materialize_object_region_mask`), stosuje region texture overrides, region-region exchange overrides oraz materializuje wspierane `Ms/Aex/alpha` material fields/overrides do cellwise `ms_field`/`a_field`/`alpha_field`. Native FDM ABI ma `region_mask`, `exchange_pair_default`, `exchange_lut` i pola material field. Nadal brakuje produkcyjnego mesh policy runtime, CPU/GPU physics parity dla non-trivial region masks i szerszych testow fizycznych. |
| FEM runtime | w duzej mierze gotowe | Native FEM ABI/runner/backend maja per-node material fields (`ms_field`, `a_field`, `alpha_field` itd.) oraz runtime seam dla per-element `Ms/A` coefficientow uzywanych przez discontinuous conformal domains przy jednym wspolnym polu H1 `m`. Planner materializuje strict conformal constant `Ms/Aex` authored regions z realnymi markerami domeny do `ms_element_field` / `a_element_field`, runner przekazuje te arrays do native ABI, a planner automatycznie wlacza consistent-mass exchange projection dla elementowego `Ms`. Strict-conformal managed CPU smoke `tests/fem_region_owned_validation/spatial_fields_smoke.py` przeszedl do konca przez `fem_cpu_native`. |
| OpenAPI v2 | w duzej mierze gotowe | Sa zasoby regionow/couplingow/material_fields/diagnostics i CRUD regionow. Typed schemas z `utoipa::ToSchema` generuja jawne OpenAPI schematy. `ObjectRegionCreateRequest.region` i `ObjectRegionPatchRequest.patch` uzywaja wygenerowanych `SceneObjectRegion` / `SceneObjectRegionPatch`; control-room transaction facade konsumuje te generated types. Pozostaja raw/merge patch granice poza object-region create/patch oraz reczne parsery frontendowe w czesci modeli. |
| Control Room | w duzej mierze gotowe | Explorer ma pelne 7 sub-node'ow per region (Geometry, Magnetic Parameters, Mesh, Texture, Visualization, Regions, Diagnostics). Inspector registry routuje kazdy `object.region.*` kind. Region overlay model jest kompletny (box/cylinder/sphere z transform/style/selection). Dedykowane pliki paneli istnieja dla Overview, Geometry, Magnetic Parameters, Mesh, Texture, Visualization, Regions i Diagnostics. `regionAuthoringInvalidation` poprawnie wyklucza mesh resources. Bounds clamping dziala w UI. Brak: frontend nie konsumuje generated types (parsuje `shape` jako `unknown` przez `asRecord()`). |
| Testy | czesciowo gotowe | Sa testy IR/Python/API/frontend/planner, testy invalidation (`regionAuthoringInvalidation.test.ts` — explicit assert nie invaliduje mesh), testy explorer tree, testy region overlay model, testy CUDA exchange pairs oraz fixture-backed Playwright proof dla UI region create -> script sync. Brakuje pelnych testow fizycznych z non-trivial region mask i release-gate runtime proofow. |

Najpilniejsze regresje do zamkniecia:

1. `Add Region` nie moze przelaczac glownego meshu w edge-only/safety wireframe.
2. Istniejacy mesh ma zostac widoczny do czasu jawnego `Build Mesh`.
3. Po dodaniu regionu ma pojawic sie tylko dodatkowy region overlay.
4. Region shape musi byc automatycznie ograniczany do bounds rodzica.
5. UI musi jasno pokazywac, ze region bez override jest tylko selektorem w
   ciaglym obiekcie.

## 3. Definicja jakosci produkcyjnej

Funkcja jest produkcyjna dopiero wtedy, gdy spelnia wszystkie ponizsze warunki.

| Obszar | Kryterium produkcyjne |
|---|---|
| Semantyka fizyczna | Jeden obiekt z regionami pozostaje jednym polem `m`; intra-object exchange domyslnie harmonic mean; inter-object exchange domyslnie brak. |
| Authoring | Python i UI potrafia utworzyc, edytowac, usunac, zduplikowac i wyeksportowac region bez driftu semantycznego. |
| Mesh lifecycle | Authoring regionu oznacza mesh jako stale/rebuild recommended, ale nie usuwa ostatniego poprawnego meshu i nie zmienia display mode. |
| Bounds | Regiony w `frame=object` sa clampowane/walidowane do obiektu rodzica w UI i API. |
| Typed contract | SceneDocument, OpenAPI i frontend generated types maja jawne typy region/coupling/material-field zamiast opaque `Value` tam, gdzie znamy schemat. |
| Planner | Kazda nieobslugiwana semantyka ma capability gate z czytelnym komunikatem. |
| FDM | Region mask, texture override, material fields i exchange pair semantics sa materializowane i testowane dla supported paths. |
| FEM | Coefficient fields, conformal sharp interfaces i projection policy maja jawna implementacje albo jawne blokady capability. |
| UI | Explorer regionu ma kompletne sub-node i kazdy sub-node ma wlasny sensowny inspector. |
| Viewport | Authored overlay i realized membership overlay sa rozroznione i nie psuja glownej wizualizacji. |
| Testy | Sa testy unit, API, planner, backend physics, round-trip, browser smoke i screenshot proof. |
| Dokumentacja | User guide, examples i troubleshooting opisuja regiony bez ukrywania ograniczen. |

## 4. Zasady niezmienne

Te zasady maja byc egzekwowane w kazdym etapie.

1. **Region nie jest drugim materialem fizycznym.** Region wewnatrz obiektu jest
   selektorem/sub-obiektem. Dwa materialy fizyczne modelujemy jako dwa obiekty
   albo jawne domeny materialowe ze sprzezeniem.
2. **Region dziedziczy parenta.** Brak lokalnych override'ow oznacza brak
   zmiany fizyki.
3. **Authoring nie jest buildem.** Zmiana regionu nie przebudowuje meshu i nie
   usuwa ostatniego poprawnego wyniku.
4. **Runtime nie moze zgadywac.** Jezeli backend nie wspiera authored intent,
   planner/runtime blokuje run albo wymaga explicit extended/projection policy.
5. **OpenAPI v2 jest zrodlem prawdy dla browser JSON.** UI nie moze budowac
   endpointow ad hoc ani trzymac alternatywnego modelu regionow.
6. **FEM build/runtime proof uzywa container-backed `just`.** Hostowe buildy sa
   tylko diagnostyka, nie finalnym dowodem.

## 5. Etap 0: stabilizacja obecnego authoring UX

### Cel

Zamknac regresje, ktore psuja podstawowa prace uzytkownika: dodanie regionu ma
byc bezpieczna operacja authoringu i nie moze zmieniac wygladu istniejacego
meshu.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `regionAuthoringInvalidationKeys()` wyklucza mesh resources | `regionAuthoringInvalidation.ts` | Gotowe. Explicit assert w testach: `.not.toContain(MESH_BUILD_CURRENT_RESOURCE_KEY)`. |
| `publishRegionAuthoringScene()` | `regionAuthoringInvalidation.ts` | Gotowe. Publishes scene immediately, invaliduje model resources, nie mesh. |
| Bounds clamping w UI draft | `ObjectRegionsPanelModel.ts` | Gotowe. `clampObjectRegionDraftShapeToOwnerBounds()` dla box/cylinder/sphere. |
| Bounds clamping w API patch | `ObjectRegionsPanelModel.ts` | Gotowe. `buildObjectRegionPatch()` clampuje przed wyslaniem. |
| Owner bounds resolution | `ObjectRegionsPanelModel.ts` | Gotowe. Box, Cylinder, ArchWaveguide geometrii. |
| Region overlay po Create | `regionOverlayModel.ts`, `useViewport3DSceneModel.ts` | Gotowe. `resolveViewport3DRegionOverlays()` buduje overlays z RegionListResource i scene. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Utrzymac separacje authoring invalidation od mesh invalidation | Zrealizowane w `regionAuthoringInvalidation.ts`. Do weryfikacji end-to-end: region create/patch/delete nie ustawia `mesh:dirty` / `mesh:building` tagow na obiekcie, bo te tagi moga zmienic `topologyFreshness` na `unknown`. |
| Zachowac ostatni dobry mesh | Invalidation wyklucza mesh resources. Trzeba utrzymac zasade: ostatni successful topology zostaje renderowany az do jawnego `Build Mesh`. |
| Rozroznic `stale` od `unknown` | `resolveVisualizationRenderResolution()` degraduje do edge-only safety view tylko dla `topologyFreshness=unknown`; `stale` jest renderowalne. Testy musza pilnowac, ze region authoring daje co najwyzej renderowalne stale, nigdy unknown. |
| Naprawic overlay po Create Region | Overlay model dziala (`regionOverlayModel.ts`). Do potwierdzenia: czy material/mesh shading glownego obiektu nie zmienia sie. |
| Clamp region shape do owner bounds | Gotowe dla obecnego kontraktu v1. UI clamp jest w `ObjectRegionsPanelModel.ts`; API clamp jest w `authoring.rs` (`clamp_object_region_shape_to_owner*`) dla object-frame create/patch/duplicate. Full-scene/imported object-frame payload poza ownerem daje `REGION_OUTSIDE_OWNER_BOUNDS`, a `model/region-diagnostics` raportuje osobne warningi dla world-frame i CSG materialization blockers (`authoring_region_diagnostics_report_world_frame_and_csg_materialization_blockers`). Region Identity inspector pokazuje te materialization blockers inline przez `regions.realized_materialization`. |
| Zablokowac region poza parentem w importowanych payloadach | SceneDocument/API validation musi odrzucic albo clampowac payloady spoza bounds, z deterministycznym raportem. CRUD clamp nie wystarcza dla recznie importowanych scene payloadow. |

### Pliki i obszary

| Obszar | Pliki |
|---|---|
| Frontend resources | `apps/control-room/src/kernel/resources/*`, realtime invalidation bridge |
| Authoring invalidation | `regionAuthoringInvalidation.ts`, `regionAuthoringInvalidation.test.ts` |
| Inspector regionow | `ObjectRegionsPanel.tsx`, `ObjectRegionsPanelModel.ts`, `RegionsListPanel.tsx`, `RegionsListPanelModel.ts` |
| Viewport overlay | `RegionOverlayLayer.tsx`, `regionOverlayModel.ts`, `Viewport3DScene.tsx`, `useViewport3DSceneModel.ts` |
| API authoring | `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` |
| Tests | frontend model tests, API CRUD tests, viewport smoke |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Add cylinder region na obiekcie z istniejacym meshem | Widok glownego meshu nie zmienia display mode; pojawia sie region wireframe. |
| Patch region shape | Mesh pozostaje widoczny; overlay aktualizuje sie. |
| Delete region | Overlay znika; mesh pozostaje widoczny. |
| Region wiekszy niz parent | UI/API clampuje albo odrzuca; nie da sie zapisac regionu poza parentem. |
| Smoke viewport | Brak tekstu `Mesh topology is stale; rendering an edge-only safety view` po samym authoringu regionu. |

### Komendy weryfikacyjne

```bash
pnpm --dir apps/control-room test -- --run ObjectRegionsPanel
pnpm --dir apps/control-room test -- --run RegionsListPanel
pnpm --dir apps/control-room test -- --run useViewport3DSceneModel
cargo test -p fullmag-api router_v2 --no-fail-fast
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

## 6. Etap 1: typed authoring contract

### Cel

Usunac opaque JSON tam, gdzie region-owned schema jest juz znana. SceneDocument,
OpenAPI i TypeScript powinny miec jeden typed contract, zamiast `Value` /
`Record<string, unknown>` / `Record<string, never>`.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `SceneObjectRegion` | `scene.rs:753` | Gotowe. Typed struct: `region_id`, `name`, `shape: SceneRegionShape`, `frame`, `mesh_policy`, `material_overrides`, `texture_override`, `realization_policy`. |
| `SceneRegionShape` | `scene.rs:776` | Gotowe. Typed enum: `Box { size, center }`, `Cylinder { radius, height, center, axis }`, `Sphere { radius, center }`, `Csg`. |
| `SceneRegionMeshPolicy` | `scene.rs:815` | Gotowe. Typed struct: `maximum_element_size`, `minimum_element_size`, `transition_distance`, `order`. |
| `SceneRegionMaterialOverride` | `scene.rs:827` | Gotowe. Typed: `parameter: SceneMaterialParameterName` (enum Ms/Aex/Alpha/Ku1/...), `value: SceneMaterialParameterField`, `priority`, `conflict_policy`. |
| `SceneMaterialParameterField` | `scene.rs:863` | Gotowe. Typed enum: `Constant`, `Linear`, `Radial`, `Sampled`. |
| `SceneTextureOverride` | `scene.rs:917` | Gotowe. Typed struct z `SceneInitialMagnetization` (Uniform/RandomSeeded/SampledField/PresetTexture). |
| `SceneCoupling` | `scene.rs:1003` | Gotowe. Typed struct z `SceneCouplingKind`, `SceneCouplingEndpoint`, `SceneCouplingParameters`, `SceneCouplingCapabilityPolicy`. |
| `utoipa::ToSchema` | Wszystkie structs | Gotowe. OpenAPI generation produkuje typed schemas. |
| Typed generated region schemas | `openapi-v2-types.ts` | Gotowe dla `SceneObjectRegion`, `SceneObjectRegionPatch`, `SceneRegionShape`, `SceneMaterialParameterValue`, `SceneCoupling` i `SceneCouplingPatch`. Control-room object-region create/patch oraz coupling patch facade uzywaja generated types. Pozostaja raw/merge patch granice poza typed authoring transactions oraz reczne parsery frontendowe w czesci modeli. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Zastapic raw patch schema typowanym kontraktem | Gotowe dla object-region create/patch i coupling patch: `ObjectRegionPatchRequest.patch` jest `SceneObjectRegionPatch`, `AuthoringTransactionRequest::PatchCoupling.patch` jest `SceneCouplingPatch`, a OpenAPI/generator przenosza oba typed DTO do control-room facade. `SceneCouplingPatch` nie reklamuje juz `coupling_id` jako patchowalnego pola; identity pozostaje w transaction envelope i runtime rejection path. Pozostaje doprecyzowac pozostale raw/merge patch granice, np. scene merge patch. |
| Zachowac migration bridge | Stare scene.v1 payloady przechodza przez adapter, ale zapis scene.v2 uzywa typed fields. |
| Wymusic konsumpcje generated types w frontend facade i modelach | Gotowe dla `apiTypes.ts` i `ControlRoomApi` object-region create/patch transaction facade: uzywaja generated `components["schemas"]["SceneObjectRegion"]` i `SceneObjectRegionPatch`. `sceneModelTreeAdapter` uzywa generated `SceneResource` / `SceneMaterialParameterAssignment` dla scene-authored material fields i respektuje typed `owner_object`. Pozostaje szerszy audit modeli, ktore nadal parsuja czesc regionowych payloadow jako `unknown` przez `asRecord()`. |
| Usunac duplicate parsers w UI | `ownerBoundsForObject()` jest zduplikowana w `ObjectRegionsPanelModel.ts` i `RegionsListPanelModel.ts`. `sceneModelTreeAdapter` ma jeszcze niezalezne parsery raw JSON dla czesci scene fallback, ale material-field owner path zostal zawiazany do generated scene assignment type. |
| Dodac round-trip test | Gotowe dla Python -> SceneDocument -> export Python, v2 API script sync oraz fixture-backed browser write path. `test_scene_document_region_edits_export_as_canonical_python`, `authoring_script_sync_uses_session_scene_document_region_edits` i `pnpm --dir apps/control-room smoke:study-authoring-ui` weryfikuja zachowanie UI-edited `region_id`, mesh policy, material override, material field region reference oraz UI region create -> `POST model/syncs`. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| `cargo test -p fullmag-authoring` | Przechodzi dla scene.v1 migration i scene.v2 region-owned. |
| OpenAPI generation | Znane resource/create schemas region-owned sa typed; ewentualne opaque objecty sa ograniczone do jawnie nazwanych boundary, takich jak merge patch albo CSG expression. |
| UI typecheck | Przechodzi bez `as any` / raw `JsonObject` dla znanych region create payloadow; patch pozostaje typed DTO albo jawnie izolowany merge-patch boundary. |
| Round-trip | Python -> SceneDocument -> UI resource -> export Python zachowuje region IDs i overrides. |

### Komendy weryfikacyjne

```bash
cargo test -p fullmag-authoring
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
```

## 7. Etap 2: kompletne inspektory region sub-node

### Cel

Region w Explorerze ma zachowywac sie jak sub-obiekt. Kazdy jego semantic node
ma miec wlasny, jasny inspector, a nie generyczny panel z ukrytymi sekcjami.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| Explorer tree — 7 sub-node'ow per region | `buildModelTree.ts` | Gotowe. Kazdy authored region ma: Geometry, Magnetic Parameters, Mesh, Texture, Visualization, Regions, Diagnostics. Takze primary region (obiekt bez authored regions) ma pelne drzewo. |
| Region material field nodes | `buildModelTree.ts` | Gotowe. Material fields per region sa sub-children node'a Magnetic Parameters. |
| Inspector registry routing | `inspectorRegistry.tsx` | Gotowe. Kazdy `object.region.*` kind routuje do `ObjectRegionsPanel` z odpowiednim komponentem (Texture routuje do `ObjectMagneticTexturePanel`, Visualization do `ObjectVisualizationPanel`). |
| `ObjectRegionsPanel` — switch po kind | `ObjectRegionsPanel.tsx` | Gotowe. Obsluguje: `object.region.geometry`, `object.region.shape`, `object.region.mesh`, `object.region.magnetic-parameters`, `object.region.material`, `object.region.regions`, `object.region.texture`, `object.region.diagnostics`. |
| Region panel model | `ObjectRegionsPanelModel.ts` | Gotowe. 803 linii: shape draft, mesh policy draft, material override draft, diagnostics, validation, clamp, formatting, SI scalar parsing. |
| Regions list model | `RegionsListPanelModel.ts` | Gotowe. 329 linii: list, create, duplicate, find, owner bounds, node ID helpers. |
| SI scalar formatting | `ObjectRegionsPanelModel.ts` | Gotowe. `formatRegionPhysicalScalar()` i `parseRegionPhysicalScalar()`. |

### Docelowe drzewo

```text
Objects
  arch_waveguide
    Geometry
    Magnetic Parameters
    Mesh
    Texture
    Visualization
    Regions
      skyrmion_core
        Geometry / Transform
        Magnetic Parameters
        Mesh
        Texture
        Visualization
        Regions
        Diagnostics
```

Drzewo jest juz zrealizowane w `buildModelTree.ts`. Ponizsze zadania dotycza
jakosci inspektorow, nie struktury drzewa.

### Zakres (pozostale prace)

| Node | Inspector docelowy | Stan | Pozostale prace |
|---|---|---|---|
| `object.regions` | `RegionsListPanel` | Gotowe | Lista, create, duplicate, reorder, delete dzialaja. Summary conflicts sa liczone z `RegionDiagnosticsResource` w `RegionsListPanelModel.ts` i pokazywane w `RegionsListPanel.tsx`. |
| `object.region` | `ObjectRegionOverviewPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionOverviewPanel.tsx`, routowany przez `inspectorRegistry.test.tsx`. |
| `object.region.geometry` | `ObjectRegionGeometryPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionGeometryPanel.tsx`, shape draft dalej wspoldzieli model z `ObjectRegionsPanelModel.ts`. |
| `object.region.magnetic-parameters` | `ObjectRegionMagneticParametersPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionMagneticParametersPanel.tsx`; panel pokazuje inherited parent value przy braku override i obok local override value w override row. |
| `object.region.mesh` | `ObjectRegionMeshPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionMeshPanel.tsx`, model ma `RegionMeshPolicyDraft` z walidacja. |
| `object.region.texture` | `ObjectRegionTexturePanel` | Gotowe | Dedykowany panel region texture uzywa wspolnych magnetic-texture sekcji, buduje typed `SceneObjectRegionPatch.texture_override` przez `buildRegionTextureOverridePatch()` i zapisuje przez object-region transaction path. |
| `object.region.visualization` | `ObjectRegionVisualizationPanel` | Gotowe | Routuje do `ObjectVisualizationPanel` z regionowym `visualizationTargetId`; wspolny panel ma controls dla Visible, Surface/Wireframe, solid color, wireframe color i opacity. |
| `object.region.regions` | `ObjectRegionNestedRegionsPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionNestedRegionsPanel.tsx` pokazuje explicit unsupported/current-state message. |
| `object.region.diagnostics` | `ObjectRegionDiagnosticsPanel` | Gotowe | Dedykowany plik `panels/region/ObjectRegionDiagnosticsPanel.tsx`, model ma `ObjectRegionDiagnosticItem` z `capabilityGate`, `realizationStatus`. |

### UX wymagania

1. Pola fizyczne uzywaja inputow tekstowych z notacja naukowa i jednostkami,
   np. `1e-9 m`, `1 nm`, `800 kA/m`.
2. Priority/order pozostaja integer controls.
3. Inspector pokazuje inherited value i local override value obok siebie.
4. Brak override jest opisany jako `inherits parent`, nie jako brak parametru.
5. Capability blocker jest widoczny przy polu, ktore nie zostanie zrealizowane
   przez aktualny backend.

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Klik kazdego sub-node regionu | Otwiera dedykowany inspector z wlasnym tytulem i zakresem. |
| Edycja `1e-9` w mesh/shape/material | Input przyjmuje notacje naukowa i zapisuje poprawna wartosc SI. |
| Brak override | Inspector pokazuje dziedziczenie parenta, nie puste/zero. |
| Capability blocker | Unsupported runtime field pokazuje diagnostyke przed build/run. |

### Komendy weryfikacyjne

```bash
pnpm --dir apps/control-room test -- --run ObjectRegionsPanel
pnpm --dir apps/control-room test -- --run RegionsListPanel
pnpm --dir apps/control-room test -- --run explorer
pnpm --dir apps/control-room typecheck
```

## 8. Etap 3: mesh policy regionow i mesh build reports

### Cel

Region mesh policy ma realnie wplywac na meshing tam, gdzie backend/mesher to
wspiera, a w pozostalych przypadkach ma generowac jawny capability blocker.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `SceneRegionMeshPolicy` typed struct | `scene.rs:815` | Gotowe. `maximum_element_size`, `minimum_element_size`, `transition_distance`, `order`. |
| `RegionMeshPolicyDraft` w UI | `ObjectRegionsPanelModel.ts` | Gotowe. Draft z walidacja: min/max size, order >= 1, transition > 0. |
| Planner capability gate | `validate.rs:51-60` | Gotowe. `"object region mesh_policy is authored in ProblemIR but not yet executable"` — blokuje run. |
| Explorer mesh badge | `buildModelTree.ts` | Gotowe. Region mesh node pokazuje badge `"policy"` gdy active, `"inherits object"` gdy nie. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Mesh policy inheritance | Region dziedziczy mesh parenta, a lokalny policy nadpisuje tylko wskazane pola. |
| Size fields z regionow | Box/cylinder/sphere region tworza lokalne size fieldy w obrebie ownera. Brak logiki ktora preklada region shape na size field w mesherze. |
| Gradient do parent/airbox | Region refinement wygasza sie wedlug `transition_distance` i growth policy. `transition_distance` jest authored, ale nie konsumowany w mesherze. |
| Mesh report | Raport pokazuje authored region count, realized region count, size-field source, fallback/capability blockers. |
| Stale reason | Mesh freshness rozroznia `geometry changed`, `mesh policy changed`, `region policy changed`, `material only changed`. Aktualnie brak tej granulacji. |
| Degenerate gate | Mesh build odrzuca degeneraty i pokazuje region/size-field source, ktory najpewniej wywolal problem. |

### Wersja v1

| Shape | Tryb v1 |
|---|---|
| Box in object bounds | supported dla FDM local policy i prostych FEM size fields. |
| Cylinder z osia lokalna | supported jako local size field, bez arbitralnego CSG split. |
| Sphere | supported jako distance field. |
| CSG arbitrary | authored-only/projection warning, bez conformal split w v1. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Region cylinder `hmax=1 nm`, parent `hmax=10 nm` | Mesh report pokazuje lokalne zageszczenie w regionie. |
| Region mesh policy disabled | Mesh identyczny jak bez regionu. |
| Region poza parentem | Build nie startuje albo payload zostaje clampowany przed buildem. |
| Arch waveguide skyrmion core | Region lokalnie zageszcza core; poza core wraca do bulk policy. |

### Komendy weryfikacyjne

```bash
python3 -m pytest packages/fullmag-py/tests/test_meshing.py
python3 -m pytest packages/fullmag-py/tests/test_api.py
cargo test -p fullmag-plan
```

## 9. Etap 4: material parameter fields i realized material assets

### Cel

MaterialParameterField ma przejsc cala sciezke: authored intent -> `ProblemIR`
-> planner -> realized asset -> backend payload -> provenance -> UI
diagnostics.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `MaterialParameterFieldListResource` w API | `apiTypes.ts` | Gotowe. Frontend ma typed resource z `fields[].assignment_id`, `owner_object_id`, `source_region_id`, `parameter`, `unit`, `realization_status`. |
| Material fields per region w Explorer | `sceneModelTreeAdapter.ts` | Gotowe. `materialFieldsByOwner()` buduje mape fields -> owner object, filtruje po region_id. |
| Material field nodes w region sub-tree | `buildModelTree.ts` | Gotowe. `regionMaterialFieldNodes()` tworzy sub-children pod Magnetic Parameters node. |
| Planner capability gate — material fields | `validate.rs:40-50` | Gotowe. `"region-owned material_parameter_fields are authored but not yet executable"`. |
| Planner capability gate — material overrides | `validate.rs:61-70` | Gotowe. `"object region material_overrides are authored but not yet executable"`. |
| Material override draft w UI | `ObjectRegionsPanelModel.ts` | Gotowe. `RegionMaterialOverrideDraft` z parameter, value, unit, priority, conflictPolicy. Walidacja Ms > 0, Aex/alpha/Ku1 >= 0. |
| Default material values | `ObjectRegionsPanelModel.ts` | Gotowe. `defaultMaterialOverrideValue()`: Ms=800e3, Aex=1e-11, alpha=0.1, Ku1=0. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Field realization plan | Dla kazdego `MaterialParameterAssignmentIR` planner tworzy plan samplingu na grid/mesh. Nie zaimplementowane. |
| Conflict resolution | Per-parameter priority; equal priority overlap jest bledem. Nie zaimplementowane w runtime. |
| Field assets | Runtime zapisuje realized `Ms`, `Aex`, `alpha`, anisotropy/DMI fields z provenance. Nie zaimplementowane. |
| Data-plane resource | Dodac zasoby material fields/membership tam, gdzie payload jest duzy. Nie zaimplementowane. |
| UI realized preview | Gotowe. Material-fields inspector renderuje realization status, sample count, min/max/mean i warnings z `MaterialParameterFieldResource` przez `materialFieldRealizationRows()`. |
| Backend payload | FDM i FEM dostaja jawne arrays albo coefficient descriptors, bez zgadywania z UI. Nie zaimplementowane. |

### Priorytet parametrow

| Parametr | FDM v1 | FEM v1 | Uwagi |
|---|---|---|---|
| `Ms` | required | required | `Ms > 0` wszedzie w aktywnym obiekcie. |
| `Aex` | required | required | Exchange field/energy musi uzywac tej samej definicji. |
| `alpha` | required | required | Wplywa na LLG/relaxation. |
| `Ku1/Ku2`, easy axis | recommended | recommended | Lokalna anisotropy jako field. |
| `Dind/Dbulk` | capability-gated | capability-gated | DMI interface note moze byc osobnym etapem. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Region `Ms=700e3`, parent `Ms=800e3` | Realized field ma poprawny zakres i provenance. |
| Overlap equal priority `Ms` | Walidacja blokuje payload. |
| Gradient `Ms(x)` | Backend dostaje przestrzenny denominator dla effective field. |
| Disabled region field | Nie materializuje sie i nie blokuje planu. |

### Komendy weryfikacyjne

```bash
cargo test -p fullmag-ir
cargo test -p fullmag-plan
cargo test -p fullmag-runner
```

## 10. Etap 5: FDM produkcyjna sciezka regionow

### Cel

FDM ma byc pierwsza produkcyjna sciezka region-owned material/coupling, z CPU
oracle i CUDA parity.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| Authored region mask w FDM plannerze | `fullmag-plan/src/fdm.rs` | Czesciowo gotowe. `materialize_object_region_mask()` konwertuje enabled object-frame Box/Cylinder/Sphere regions na cell membership dla wlasciciela FDM. CSG i non-object frame sa blokowane. |
| Region texture overrides w FDM plannerze | `fullmag-plan/src/fdm.rs` | Czesciowo gotowe. `apply_region_texture_overrides()` stosuje local texture override przez `region_mask`. |
| Region-region exchange overrides w FDM plannerze | `fullmag-plan/src/fdm.rs` | Czesciowo gotowe. `materialize_region_exchange_couplings()` mapuje authored region endpoints na exchange override pairs. |
| `region_mask` w CUDA native | `fdm/gpu/cuda/native.rs` | Gotowe. Upload region mask do GPU, `build_region_exchange_pairs()`, default harmonic mean. |
| Exchange pairs — explicit/disabled/harmonic_mean | `fdm/gpu/cuda/native.rs` | Gotowe. Testy: `native_fdm_region_exchange_pairs_default_harmonic_mean`, `native_fdm_region_exchange_pairs_explicit_value`, `native_fdm_region_exchange_pairs_require_region_mask`. |
| Multilayer region mask | `fdm/gpu/cuda/multilayer.rs:945-1016` | Gotowe. Inicjalizuje region mask z layer index. |
| Planner coupling executability | `validate.rs:118-154` | Gotowe. `region_coupling_is_executable_for_backend()` sprawdza FDM CUDA exchange pairs z explicit/disabled/harmonic_mean. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Domknac material fields z authored region overrides | Czesciowo gotowe. FDM plan uzywa `resolve_spatial_parameter()` i materializuje wspierane `MaterialParameterAssignmentIR` / `material_overrides` dla `Ms`, `Aex`, `alpha` do cellwise fields, pomijajac uniform fields. Pozostaje kwalifikacja pozostalych parametrow, sampled field payloadow i backend parity. |
| CPU oracle — material fields i region exchange | CPU FDM reference musi byc oracle dla `Ms_i`, `A_i`, `alpha_i`, region mask oraz exchange pair semantics. Nie wystarczy CUDA-only transport. |
| CUDA payload — material fields | Native CUDA ABI ma pola `ms_field`/`a_field`/`alpha_field`, ale backend obecnie odrzuca/nie kwalifikuje non-zero field payloady. Trzeba zaimplementowac albo capability-gate'owac kazdy parametr osobno. |
| Test authored shape -> mask -> exchange | Czesciowo gotowe. Testy planera obejmuja authored region mask, texture override, material override do `ms_field` i region-region exchange override. Pozostaje Python-to-plan end-to-end i backend parity. |
| Directional derivative | Test spojnosc `E_ex` i `H_ex` dla niejednorodnego `Aex`. Brak testu. |
| Multilayer gate | Multilayer + active region-owned material/coupling pozostaje blokowane albo osobno kwalifikowane do osobnego rollout. |
| Testy fizyczne z non-trivial region mask | `physics_validation.rs` uzywa `region_mask: vec![0; n]` — brak testow z dwoma regionami. |

### Akceptacja fizyczna

| Test | Wymagany wynik |
|---|---|
| Jeden obiekt, dwa regiony, rozne `Aex` | Exchange miedzy regionami nie jest zerowy; harmonic mean. |
| Dwa obiekty bez coupling | Brak direct exchange miedzy obiektami. |
| Dwa regiony z explicit disabled | Direct exchange na tej parze jest zero. |
| Taylor test exchange | `dE/dm` zgadza sie z `H_ex` w tolerancji CPU double. |
| CUDA parity | CUDA double zgadza sie z CPU oracle dla region masks/material fields. |

### Komendy weryfikacyjne

```bash
cargo test -p fullmag-plan fdm_region
cargo test -p fullmag-runner fdm_region
just ensure-managed-fem-runtime
```

Uwaga: ostatnia komenda nie waliduje FDM jako taka, ale utrzymuje managed
runtime hygiene przed cross-backend smoke. Dla native FDM CUDA nalezy uzyc
istniejacych repo recipes, jezeli sa dostepne, zamiast recznego uruchamiania
binarek.

## 11. Etap 6: FEM material fields, conformal i projection policy

### Cel

FEM musi realizowac region-owned coefficient fields zgodnie z nota fizyczna.
Ostre skoki w strict mode wymagaja conformal boundary/domain markers, a
projection jest jawna polityka extended.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| FEM domain region markers w plannerze | `fullmag-plan/src/mesh.rs` | Gotowe dla object/domain markers oraz authored-region marker metadata. Authored-region markers sa pakowane jako segmenty parent object, a strict conformal gate wymaga, zeby marker faktycznie wystepowal w `mesh.element_markers`. |
| Shared-domain mesh reorder z markers | `fullmag-plan/src/mesh.rs:910` | Gotowe. `reorder_shared_domain_mesh()` zachowuje stara sciezke object markers; `resolve_fem_domain_mesh_asset()` uzywa rozszerzonej analizy z authored-region markers, bez tworzenia nowego magnetu. |
| Explicit Python shared-domain region markers | `packages/fullmag-py/src/fullmag/world.py`, `model/problem.py`, `runtime/script_builder.py` | Gotowe dla precomputed shared-domain meshes. `study.domain_mesh(..., object_region_markers={...})` przenosi authored-region markers do `FemDomainMeshAssetIR.object_region_markers` i zachowuje je w script export; markery nie sa syntetyzowane z region shape. |
| FEM per-node material fields ABI/runtime | `native/include/fullmag_fem.h`, `native_fem.rs`, `backends/fem/core/fem_material_fields.*` | Gotowe jako infrastruktura. Runner przekazuje `ms_field`/`a_field`/`alpha_field` i backend je kopiuje/waliduje. Planner buduje pola dla heterogenicznych object segments. |
| FEM per-element `Ms/A` coefficient runtime seam | `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys/src/lib.rs`, `crates/fullmag-ir/src/plan.rs`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-runner/src/native_fem.rs`, `backends/fem/core/fem_material_fields.*`, `backends/fem/cpu/mfem/runtime/mfem_context.cpp`, `backends/fem/cpu/mfem/interactions/exchange_operator.*` | Local-contract closure gotowe. ABI ma opcjonalne `ms_element_field`/`a_element_field`; `FemPlanIR` niesie te arrays; planner materializuje conformal sharp constant `Ms/Aex` po realnych markerach domeny; runner przekazuje pointery i dlugosci do native ABI; native backend kopiuje i waliduje pola per element; MFEM exchange przyjmuje generic `mfem::Coefficient`; elementwise coefficient adapter moze dostarczyc discontinuous `A` i `Ms` bez duplikowania DOF `m`; per-element `Ms` wymaga consistent-mass projection. |
| Planner conformal/project capability gate | `validate.rs` | Gotowe dla strict/extended FEM: sharp `Aex/Ms` bez realnego conformal marker blokuje strict, extended wymaga explicit `realization_policy=project`, projection trafia do `MaterialFieldPlan.warnings`, a explicit `Project` pozostaje projection nawet gdy realny marker istnieje. |
| Planner texture override capability gate | `validate.rs:71-81` | Gotowe. Blokuje texture override dla non-FDM backendow. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Authored region -> FEM coefficient descriptors | Planner materializuje `ObjectRegionIR` / `MaterialParameterAssignmentIR` dla `Ms/Aex/Alpha` do nodal fields, uwzglednia translacje object frame, waliduje wartosci po samplingu oraz zapisuje realization method i statystyki min/max/mean/sample count. Python emituje kanoniczne nazwy parametrów ProblemIR (`ms`, `aex`, `alpha`). |
| Conformal v1 | Python/Gmsh automatycznie produkuje osobne markery dla w pelni zawartych regionow box/cylinder na OCC shared-domain path. Obslugiwane sa dowolne osie cylindra; region poza ownerem, nakladanie regionow i nieobslugiwany shape blokuja build bez fallbacku do projection. Pozostaje runtime coefficient mapping: authored region nie moze byc pakowany jako drugi magnet ani dostac zduplikowanych DOF `m`; ostre `A/Ms` wymagaja element/domain coefficient przy jednym wspolnym polu `m`. |
| Projection policy | Explicit `realization_policy=project` w extended mode materializuje sampled/projected nodal field, emituje warning w execution provenance i solver status. Python DSL udostepnia `study.mode("extended")` / `fm.mode("extended")`. Managed CPU payload przeszedl materialization, planning, native runtime initialization oraz pelny headless CPU run poza sandboxem. |
| Sharp jump strict gate | Gotowe w plannerze z testami FEM-specific, wlacznie z przypadkiem metadanych markerow bez realnego markera w mesh. |
| Runtime upload release gate | Managed runtime zostal odbudowany z aktualnych zrodel. Strict-conformal payload `just fem-managed-headless cpu tests/fem_region_owned_validation/spatial_fields_smoke.py` oraz projection payload `just fem-managed-headless cpu tests/fem_region_owned_validation/projected_fields_smoke.py` przeszly przez materialization, planning, native FEM CPU runtime initialization i 2-krokowy solver run. |
| Exchange operator validation | Consistent-mass exchange uzywa teraz `Ms`-weighted mass matrix i przestrzennego `A(x)`; usunieto niepoprawne nodewise dzielenie po unweighted solve. Lokalny C++ contract set `fem_exchange_contract`, `fem_material_fields_contract`, `fem_mfem_context_contract` przechodzi w `native/build/backends/fem`. Pozostaje szerszy runtime physics validation dla markerowego sharp-interface coefficient payloadu jako osobny produkcyjny gate. |

### Akceptacja fizyczna

| Test | Wymagany wynik |
|---|---|
| FEM sharp `Aex` bez conformal strict | Planner blokuje. |
| FEM sharp `Aex` conformal | Mesh ma domain markers, solver dostaje coefficient mapping. |
| FEM projected field extended | Run moze wystartowac tylko z explicit warning/provenance. |
| FEM `Ms(x)` denominator | Effective field uzywa lokalnego `Ms`. |
| FEM exchange energy/field | Taylor test przechodzi dla spatial `A(x)`. |

### Komendy weryfikacyjne

```bash
cargo test -p fullmag-plan fem_region
just rebuild-fem-runtime
just ensure-managed-fem-runtime
```

Po zmianach w `backends/fem` finalny proof musi isc przez container-backed
`just` recipe. Host `cargo` albo host `cmake` nie jest wystarczajacym dowodem.

### Aktualny dowod z 2026-06-07

| Dowod | Wynik |
|---|---|
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-plan fem_sharp_aex --no-fail-fast` | 6/6 FEM sharp Aex planner tests passed; strict conformal real-marker case lowers to `ms_element_field`/`a_element_field` and sets `use_consistent_mass=Some(true)`, while missing marker strict/project-policy gates still pass. |
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-plan --no-fail-fast` | 138/138 passed. |
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-ir --no-fail-fast` | 75/75 passed. |
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-fem-sys --no-fail-fast` | 12/12 passed, wlacznie z ABI guardem `plan_desc_has_element_material_coefficient_fields` dla `ms_element_field`/`a_element_field`. |
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem --no-fail-fast` | 8/8 focused native FEM runner tests passed. |
| `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner --test physics_validation fem --no-fail-fast` | 14/14 FEM-filtered physics validation tests passed. |
| `just ensure-managed-fem-runtime` | Passed po najnowszych zmianach; managed bundle odbudowany i wyeksportowany do `.fullmag/runtimes/fem-gpu-host`. |
| `just fem-managed-headless cpu tests/fem_region_owned_validation/projected_fields_smoke.py` | Passed po aktualnych zmianach. Managed runtime przeszedl materialization, planning, native FEM CPU runtime initialization i zakonczyl stage po 2 krokach (`status: completed`, `backend: fem`, `mode: extended`, `precision: double`). |
| `just fem-managed-headless cpu tests/fem_region_owned_validation/spatial_fields_smoke.py` | Passed po aktualnych zmianach. Managed runtime odbudowal bundle, materializacja utworzyla conformal OCC mesh z markerem regionu, planner przekazal elementowe `Ms/Aex`, native `fem_cpu_native` uruchomil solver i zakonczyl stage `flat_run` po 2 krokach (`status: completed`, `backend: fem`, `mode: strict`, `precision: double`). |
| `ctest --test-dir native/build/backends/fem -R 'fem_(exchange_contract\|material_fields_contract\|mfem_context_contract)$' --output-on-failure` | 3/3 passed: `fem_exchange_contract`, `fem_mfem_context_contract`, `fem_material_fields_contract`. |

## 12. Etap 7: interface couplings i surface selector resolution

### Cel

Couplingi maja byc realizowalne, walidowalne i widoczne. Authored-only nie moze
prowadic do cichego uruchomienia z pomieta fizyka.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `SceneCoupling` typed struct | `scene.rs:1003` | Gotowe. `coupling_id`, `kind: SceneCouplingKind` (Exchange/Rkky/InterlayerExchange), `source/target: SceneCouplingEndpoint` (Object/Region/Surface), `parameters: SceneCouplingParameters`, `capability_policy`. |
| `CouplingListResource` w Explorer | `sceneModelTreeAdapter.ts:463-506` | Gotowe. `couplingSnapshots()` buduje tree nodes z endpoint labels, kind, realization status. |
| `CouplingInspectorPanel` | `CouplingInspectorPanel.tsx` | Istnieje (2.8KB). |
| Planner coupling executability | `validate.rs:94-154` | Gotowe. `RequireRuntime` blokuje run dla nieobslugiwanego backendu. `AuthoredOnly` blokuje w strict planning. FDM CUDA exchange pairs (explicit/disabled/harmonic_mean) sa executable. |
| Exchange coupling w CUDA | `fdm/gpu/cuda/native.rs` | Gotowe. `build_region_exchange_pairs()` z testami. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Surface selector resolver | Czesciowo gotowe. `fullmag-plan::resolve_fem_surface_selector()` realizuje v1 `top/bottom/left/right/front/back` jako lokalna bbox face z tolerancja, ogranicza kandydatow do magnetycznego `FemMeshPartIR` obiektu i raportuje face indices, triangles, nodes oraz area. `ProblemIR` i `SceneDocument` odrzucaja inne/named-face selectors. `GET model/couplings` niesie teraz preview rozdzielczosci z aktualnego FEM execution planu albo opublikowanego FEM mesh payloadu. Pozostaje podlaczenie resolved faces do executable coupling planu/provenance i operatora backendu. |
| FDM contact discovery | Coupling surface/object/region endpointy materializuja sie do par sasiednich cell faces. Nie zaimplementowane. |
| FEM boundary markers | Coupling endpointy wymagaja shared boundary markers albo blokady. Nie zaimplementowane. |
| RKKY runtime gate | Zweryfikowane. `rkky_unsupported_blocks_runtime_plan` potwierdza, ze RKKY `CouplingKindIR` blokuje runtime planning z komunikatem `requires runtime support` i `must not silently drop authored coupling intent`. |
| Coupling inspector | Czesciowo gotowe. Inspector pokazuje source/target resolution status, liczbe faces, area, tolerance, resolution detail, jawny runtime blocker oraz akcje Enable/Disable i Delete Coupling oparte o istniejace model transactions. Pozostaje runtime operator status po zaimplementowaniu backendu. |
| Delete behavior | Czesciowo gotowe. API guard `ensure_region_has_no_active_couplings()` blokuje disable regionu referencjonowanego przez aktywny coupling; delete region usuwa region-owned couplings; delete object usuwa authored couplings z object/surface/region endpointem wskazujacym usuwany obiekt. Coupling inspector pozwala jawnie disable/delete coupling, a region Actions pokazuje aktywne coupling dependencies i blokuje Delete Region z komunikatem `Delete Coupling first`. Pozostaje backend/operator provenance po wdrozeniu executable couplingow. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| `object.surface("top")` FDM | Resolver znajduje cell faces na bbox top. |
| `rkky` unsupported | Planner blokuje run. |
| Delete region with active coupling | UI/API nie zostawia dangling active coupling. |
| Object-object no coupling | Planner nie syntetyzuje ukrytego exchange. |

### Postep 2026-06-08

- Dodano kanoniczna walidacje selectorow v1 w `ProblemIR` i `SceneDocument`:
  tylko `top/bottom/left/right/front/back` jest akceptowane; named faces pozostaja
  jawnie poza v1.
- Dodano FEM planner resolver bbox-face z tolerancja, area i resolved topology
  metadata. Resolver obsluguje boundary face ranges/indices oraz
  `FemMeshPartIR.surface_faces`.
- `GET /v2/sessions/current/model/couplings` publikuje typed
  `source_resolution`/`target_resolution` oraz `blocker_reason`. Preview korzysta
  z aktualnego FEM execution planu lub opublikowanego FEM mesh payloadu i nie
  promuje capability operatora.
- Coupling Inspector pokazuje status resolucji endpointow, face count, area,
  tolerance, detail oraz jawny powod blokady runtime.
- Testy:
  - `coupling_surface_selector_rejects_named_faces_in_v1`,
  - `scene_document_validation_rejects_unsupported_surface_selector`,
  - `fem_top_surface_selector_resolves_bbox_faces`,
  - `fem_surface_selector_rejects_unknown_bbox_face`,
  - `authoring_coupling_resource_resolves_bbox_surface_from_current_fem_mesh`,
  - `authoring_coupling_resource_does_not_treat_unknown_mesh_part_as_magnetic`.
- Ten krok nie zmienia capability statusu couplingow. FEM RKKY/interlayer i
  surface exchange pozostaja nieexecutowalne, dopoki resolved faces nie sa
  niesione przez runtime plan i backend nie ma odpowiadajacego operatora.

### Postep 2026-06-08: delete object coupling cleanup

- `delete_object` w `model/transactions` usuwa authored couplingi, ktorych
  endpoint `object`, `surface` albo `region` wskazuje usuwany obiekt.
- Test `authoring_delete_object_removes_object_and_surface_couplings` pokrywa
  object-object exchange i surface-surface RKKY, zeby committed scene nie
  zostawial dangling coupling endpointow.
- To nie implementuje runtime contact discovery ani operatorow couplingow.

## 13. Etap 8: realized regions, membership i viewport produkcyjny

### Cel

Viewport ma rozroznic authored shape od realized membership. UI ma pokazywac, co
uzytkownik zadeklarowal, i co mesher/runtime faktycznie zrealizowal.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| Authored overlay model | `regionOverlayModel.ts` | Gotowe. 282 linii. `RegionOverlayModel` z typami Box/Cylinder/Sphere, color palette (Catppuccin latte/mocha), style (fill/wireframe opacity, scale), transform (position/quaternion/scale z owner transform). |
| Authored overlay rendering | `RegionOverlayLayer.tsx` | Gotowe. R3F layer renderujacy region overlays. |
| Overlay w viewport scene | `useViewport3DSceneModel.ts` | Gotowe. `resolveViewport3DRegionOverlays()` buduje overlays z RegionListResource i scene, z deduplication. |
| Selection sync (czesciowa) | `regionOverlayModel.ts` | Gotowe. `selectedRegionId` w options, `selected` flag w modelu wplywa na style (opacity, scale). |
| Authored overlay color palette | `regionOverlayModel.ts` | Gotowe. 8 kolorow z `--fm-region-overlay-*` CSS variables. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Authored overlay | Gotowe. Wireframe/fill shape w object frame, niezalezny od glownego mesh shader. Authored overlay respektuje per-region target visualization (`visible`, `shaderVisible`, `wireframeVisible`, opacity i kolory). |
| Mesh-backed region visualization | Czesciowo gotowe. `MeshSharedDomainManifestResource.regions[]` raportuje authored object regions, gdy aktualny FEM mesh ma part/segment z `geometry_id=region_id`; viewport ukrywa wtedy authored primitive overlay i renderuje odpowiadajace mesh parts przez target `region:*`, wiec wireframe po rebuildzie pochodzi z prawdziwej topologii. |
| Realized membership resource | `model/realized-regions` istnieje jako lista zrealizowanych region resources, ale nie niesie pelnego node/element membership payloadu do kolorowania czesciowego membership na wspolnym mesh parcie. Potrzebny osobny data-plane membership resource albo rozszerzenie mesh-region resource dla projection/non-segmented cases. |
| Realized overlay | Mesh-backed conformal region parts renderuja sie przez prawdziwy mesh. Membership-color overlay dla regionow, ktore nie sa osobnym mesh partem, pozostaje niezaimplementowany. |
| Mode switch | Gotowe dla dostepnych reprezentacji. Lokalny segmented control viewportu przelacza `authored` / `realized` / `both`; realized jest niedostepny bez current mesh-backed regionu. Tryb nie mutuje fizyki ani `visualization/state`. |
| Selection sync | Explorer <-> Inspector dziala. Viewport -> Explorer selection do weryfikacji. |
| Safety view discipline | Safety wireframe tylko przy rzeczywiscie brakujacej/niezgodnej topologii, nie przy zwyklym authoringu. `regionAuthoringInvalidation` wyklucza mesh resources, unit tests pokrywaja region authoring bez `mesh:dirty`; end-to-end viewport behavior pozostaje release gate. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Add region before mesh rebuild | Pokazuje authored overlay, mesh bez zmian. |
| Build mesh after region | Realized overlay pokazuje membership. |
| Select region in viewport | Explorer i Inspector wybieraja ten region. |
| Hide overlay | Glowny mesh zostaje bez zmian. |

### Postep 2026-06-08: tryb overlay

- Dodano typed `RegionOverlayMode = authored | realized | both`.
- Authored layer zawsze zachowuje kanoniczny primitive intent; realized layer
  dostaje tylko regiony potwierdzone przez current shared-domain manifest jako
  mesh-backed.
- Segmented control w HUD jest interaktywny mimo `pointer-events: none` na
  pasywnym HUD i domyslnie wybiera `both`.
- Bez aktualnego mesh-backed regionu opcja `realized` jest jawnie disabled.
- Playwright screenshot fixture zawiera authored region i sprawdza widocznosc
  kontrolki, stan domyslny, przejscie do `authored` oraz nieblank canvas.
- Fallback `scene.objects[].regions[].shape` w viewport adapterze przechodzi
  przez typed normalizer zgodny z generated OpenAPI `SceneRegionShape`; invalid
  payload i `csg` nie tworza authored overlay inputu.
- Unit coverage potwierdza, ze region authoring bez `mesh:dirty` nie przelacza
  topologii w `unknown`, a `stale` topologia pozostaje renderowalna normalna
  sciezka zamiast edge-only safety view.
- Nadal brakuje osobnego membership data-plane dla projection/non-segmented
  regions; ten krok nie deklaruje takiego przypadku jako realized.

### Komendy weryfikacyjne

```bash
pnpm --dir apps/control-room test -- --run viewport
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
```

## 14. Etap 9: capability, diagnostics i provenance

### Cel

Uzytkownik ma widziec, ktora czesc authored region semantics zostanie
zrealizowana przez wybrany backend, a ktora jest zablokowana albo deferred.

### Juz zrealizowane

| Element | Plik | Stan |
|---|---|---|
| `RegionDiagnosticsResource` w API | `apiTypes.ts` | Gotowe. Frontend ma typed resource z `diagnostics[].diagnostic_id`, `owner_object_id`, `region_id`, `code`, `message`, `severity`, `capability_gate`, `realization_status`. |
| `MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY` | `geometryLifecycleResources.ts` | Gotowe. Invalidowany przy region authoring. |
| `ObjectRegionDiagnosticItem` w modelu | `ObjectRegionsPanelModel.ts` | Gotowe. Model z `capabilityGate`, `realizationStatus`, `severity`. |
| Diagnostics per region w modelu | `ObjectRegionsPanelModel.ts` | Gotowe. `diagnosticsForRegion()` filtruje po `owner_object_id` i `region_id`. |
| Diagnostics node w Explorer | `buildModelTree.ts` | Gotowe. `object.region.diagnostics` z badge `realizationPolicy/realizationStatus/"authored"`. |
| Planner capability gates | `validate.rs` | Gotowe. Czytelne komunikaty dla material_fields, material_overrides, mesh_policy, texture_override, realization_policy, couplings. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Capability vocabulary | Czesciowo gotowe. Control-room ma wspolny katalog `regionCapabilityCatalog.ts` dla stabilnych gates `regions.mesh_policy`, `regions.material_override`, `regions.conformal_or_projected_boundary` i `regions.realized_materialization`; inline inspector i runtime command blockers uzywaja tych samych user-facing nazw. Pozostaje wspolny katalog dla Python/planner/API/UI zamiast frontend-only katalogu prezentacyjnego. |
| Diagnostics inline w inspectorze | Gotowe dla istniejacych region capability diagnostics. Mesh Policy, Material Overrides i Region Identity renderuja warning/error przy odpowiednich polach; pelny panel Diagnostics zachowuje wszystkie szczegoly. |
| Build dialog | Gotowe dla region mesh-policy diagnostics. Mesh build dialog pokazuje regionowy powod przebudowy `region mesh policy changed` z istniejacego `model/region-diagnostics` resource. |
| Run blocker | Gotowe dla region-owned warning/error diagnostics. `study.run` i pokrewne runtime commands zwracaja user-facing disabled reason z konkretnego region diagnostic message przed startem solvera. |
| Provenance | Czesciowo gotowe. `ArtifactEntry.region_owned_provenance` niesie control-plane summary dla field-state/API-created artifact entries: `scene_revision`, liczbe authored regions, material parameter fields, couplings oraz blocked/deferred diagnostic counts. Pozostaje zapis pelnego artifact payload/provenance dla realized backend reality i run-stage outputs. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Unsupported FEM projection strict | UI pokazuje bloker przed run. |
| FDM multilayer + active region | Planner blokuje z jasnym komunikatem. |
| Region overlap equal priority | Diagnostics wskazuje konflikt parametru. |

### Postep 2026-06-08: inline diagnostics

- Dodano frontendowy katalog `regionCapabilityCatalog.ts`, zeby inspector i
  runtime command gating uzywaly tych samych nazw capability.
- Dodano wspolny mapper `resolveRegionInlineDiagnostics()`, ktory filtruje po
  stabilnym `capability_gate`, nadaje user-facing label i zachowuje severity
  `warning`/`error`.
- `regions.mesh_policy` jest widoczne inline w panelu Mesh Policy.
- `regions.material_override` jest widoczne inline w panelu Material Overrides.
- `regions.conformal_or_projected_boundary` jest widoczne inline przy wyborze
  Realization w Region Identity.

### Postep 2026-06-08: artifact provenance metadata

- `GET /v2/sessions/current/data/artifacts` expose opcjonalne
  `region_owned_provenance` na wpisie artifactu.
- Field-state export/import artifact entries zapisuje summary z aktywnego
  `SceneDocument`: scene revision, authored region count, material parameter
  field count, coupling count oraz liczbe blocked/deferred region diagnostics.
- To jest metadata indeksu artifactow. Nie zastepuje pelnego artifact payload
  ani provenance realized backend reality dla run-stage outputs.
- Komponenty nadal korzystaja z centralnego `model/region-diagnostics` resource
  przez istniejacy hook; nie dodano transportu ani drugiego store.

### Postep 2026-06-08: mesh rebuild dialog

- Mesh build confirmation dialog laduje istniejacy
  `model/region-diagnostics` resource tylko kiedy dialog jest otwarty.
- `regions.mesh_policy` warning/error diagnostics sa streszczane w New Mesh
  Request jako `Rebuild reasons: region mesh policy changed`.
- Nie dodano endpointu, drugiego store ani lokalnego komponentowego transportu.

### Postep 2026-06-08: run blocker UX

- `study.run`, `study.compute-fields` i `study.compute-energies` sprawdzaja
  istniejacy `model/region-diagnostics` snapshot w command registry.
- Region-owned `warning`/`error` diagnostics z `regions.*` capability gate
  wylaczaja runtime command przed startem solvera.
- Disabled reason pokazuje shared capability label i konkretny komunikat
  diagnostyczny zamiast ogolnego mesh/readiness statusu.

## 15. Etap 10: przyklady, migracja i dokumentacja uzytkownika

### Cel

Regiony maja byc zrozumiale dla uzytkownika i reprodukowalne w skryptach.

### Zakres

| Dokument / przyklad | Zawartosc |
|---|---|
| User guide: Regions | Gotowe. `docs/guides/region-owned-authoring.md` opisuje kiedy uzyc regionu, kiedy osobnego obiektu, kiedy coupling. |
| User guide: Mesh refinement | Gotowe. `docs/guides/region-owned-authoring.md` opisuje lokalny region mesh policy, skyrmion core i separacje airbox. |
| User guide: Material fields | Gotowe. `docs/guides/region-owned-authoring.md` opisuje `Ms(x)`, `Aex(x)`, gradienty, sharp jumps, priority/projection constraints. |
| User guide: Couplings | Gotowe. `docs/guides/region-owned-authoring.md` opisuje object-object exchange, disabled/free surface i RKKY limitations. |
| Migration note | Gotowe. `docs/guides/region-owned-migration.md` opisuje `scene.v1` -> `scene.v2`, legacy `RegionIR` i old `region_overrides`. |
| Example: skyrmion core | Gotowe. `examples/skyrmion_core_mesh_refinement.py` pokazuje region cylinder z lokalnym mesh `1 nm` i parent bulk `10 nm`. |
| Example: two objects | Gotowe. `examples/two_object_couplings.py` pokazuje dwa fizyczne obiekty, explicit object-object exchange oraz surface-surface RKKY authored intent. |
| Example: gradient `Ms` | Gotowe. `examples/region_owned_gradient_ms.py` pokazuje jeden fizyczny obiekt, authored region jako support pola `Ms(x)`, brak drugiego obiektu i brak couplingow. |

### Postep 2026-06-08: canonical script export

- Region-owned script export zachowuje `object.add_region`, region material
  fields, texture overrides i `study.couplings.*` w round-trip tescie Python ->
  SceneDocument -> Python.
- Coupling endpointy odnoszace sie do authored regions sa eksportowane przez
  lokalne zmienne regionow, np. `study.couplings.exchange(film_core_region,
  film_shell_region, ...)`, zamiast przez runtime `region_id` helpers.
- Fallback `fm.couplings.region(object, region_id)` pozostaje tylko dla
  endpointow, ktorych region nie zostal wyrenderowany jako authored local
  variable w tym skrypcie.

### Postep 2026-06-08: gradient `Ms` example

- Dodano `examples/region_owned_gradient_ms.py`.
- Przyklad laduje sie przez publiczne API jako jeden `permalloy_track` object,
  jeden authored region `gradient_window` i jeden `MaterialParameterFieldIR`
  dla `Ms` wsparty na tym regionie.
- Test `test_region_owned_gradient_ms_example_keeps_one_physical_object`
  pilnuje, ze przyklad nie tworzy drugiego obiektu ani ukrytych couplingow.

### Postep 2026-06-08: two-object coupling example

- Dodano `examples/two_object_couplings.py`.
- Przyklad deklaruje dwa osobne obiekty `free_layer` i `reference_layer`.
- `study.couplings.exchange(...)` zapisuje jawny object-object exchange z
  `mode="explicit"` i `inter_exchange=6.5e-12`.
- `study.couplings.rkky(...)` zapisuje jawny surface-surface RKKY intent dla
  `free_layer.surface("top")` i `reference_layer.surface("bottom")`.
- Test `test_two_object_couplings_example_uses_explicit_exchange_and_rkky`
  pilnuje dokladnego `ProblemIR` endpoint/parameter contractu.

### Postep 2026-06-08: skyrmion-core mesh refinement example

- Dodano `examples/skyrmion_core_mesh_refinement.py`.
- Przyklad deklaruje jeden `permalloy_track` object z bulk mesh policy
  `maximum_element_size=10e-9`.
- Region `skyrmion_core` jest cylindrycznym authored regionem z lokalnym
  `minimum_element_size=1e-9`, `maximum_element_size=1e-9` i
  `transition_distance=40e-9`.
- Test `test_skyrmion_core_mesh_refinement_example_scopes_region_mesh_policy`
  pilnuje, ze mesh refinement jest region-scoped w `ProblemIR` i nie tworzy
  drugiego physical object.

### Postep 2026-06-08: scene-document region export round-trip

- Dodano `test_scene_document_region_edits_export_as_canonical_python`.
- Test symuluje UI-edited `SceneDocument`: zmieniony `region_id`, nazwe
  regionu, lokalny mesh policy, material override i
  `material_parameter_fields[].region_id`.
- `rewrite_loaded_problem_script(..., overrides=builder_overrides_from_scene_document(scene))`
  renderuje teraz region-owned authoring z `overrides["geometries"]`, nie ze
  starego `LoadedProblem`, gdy scene document dostarcza aktualny stan UI.
- Export zachowuje lokalna zmienna regionu i uzywa jej dla
  `set_material_field(..., region=...)`, zamiast fallbacku na string region id.

### Postep 2026-06-08: v2 API script sync region export proof

- `scene_document_problem_projection()` przenosi teraz do
  `rewrite_overrides.geometries[]` takze `object_regions`,
  `allocated_region_ids` i `material_parameter_fields`.
- Dodano unit assertion w `scene_problem_projection_uses_scene_revision`, zeby
  projection layer nie zgubil region-owned arrays przed Python helperem.
- Dodano route test
  `authoring_script_sync_uses_session_scene_document_region_edits`, ktory
  ustawia `snapshot.scene_document`, wywoluje
  `POST /v2/sessions/current/model/syncs` bez manualnych overrides i sprawdza
  zapisany canonical Python.
- To jest API/resource proof dla script sync.

### Postep 2026-06-08: browser region authoring script-sync proof

- `RegionsListPanel` i `ObjectRegionsPanel` wywoluja
  `syncAuthoringScriptBestEffort(api)` po udanym create/update/duplicate/delete
  authored regionu.
- Fixture-backed `smoke-study-authoring-ui.mjs` tworzy region przez UI,
  sprawdza `SceneDocument` response (`film:r1`, cylinder) i potwierdza
  `POST /v2/sessions/current/model/syncs`.
- Smoke przeszedl na aktywnym dev serverze:
  `CONTROL_ROOM_URL=http://localhost:45017/workspace pnpm --dir apps/control-room smoke:study-authoring-ui`
  z wynikiem `3 model transactions and 1 authoring script syncs`.

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Export UI-authored region script | Gotowe dla obecnego UI write path. Testy Python script export, v2 API script sync i fixture-backed Playwright smoke uzywaja `object.add_region`, `fm.fields`, region texture override, `study.couplings`, lokalnych zmiennych regionow dla region coupling endpointow, scene-document overrides dla UI-edited `region_id`/mesh/material fields oraz UI region create -> `POST model/syncs`. |
| Gradient `Ms` example | Gotowe. Przyklad zachowuje jeden physical object i region-scoped material field. |
| Two-object coupling example | Gotowe. Przyklad zachowuje dwa physical objects i jawne exchange/RKKY couplings. |
| Run example skyrmion core | Czesciowo gotowe. Example contract weryfikuje authored parent/core mesh policies; runtime mesh density proof pozostaje gate release. |
| Read docs by new user | Nie da sie pomylic regionu z drugim materialem fizycznym. |

## 16. Etap 11: pelna walidacja release candidate

### Cel

Przed uznaniem funkcji za production-ready trzeba wykonac wspolny zestaw
testow cross-layer.

### Macierz testow

| Klasa testu | Zakres |
|---|---|
| Python DSL | region registry, deterministic IDs, add/remove/rename/reorder, material fields, coupling endpoints, script export. |
| IR | validation, disabled behavior, overlap conflicts, Ms>0, owner mismatch, airbox rejection. |
| SceneDocument | scene.v1 migration, scene.v2 typed serialization, imported invalid region bounds. |
| Planner | FDM region mask/material fields/exchange, FEM blockers, multilayer gates, RKKY blockers. |
| API | CRUD regions, duplicate/reorder/delete, coupling references, resource revisions, OpenAPI generated types. |
| Frontend model | Explorer tree, inspectors, SI inputs, clamp, resource invalidation, diagnostics. |
| Viewport | authored overlay, realized overlay, no safety wireframe on authoring, click selection. |
| FDM physics | exchange harmonic mean, explicit disabled/scale, directional derivative, CPU/CUDA parity. |
| FEM physics | coefficient fields, conformal sharp interface, projection blocker/warning, managed runtime proof. |
| Examples | arch waveguide/skyrmion region, two-object coupling, gradient material field. |

### Minimalny zestaw komend release-candidate

```bash
cargo test -p fullmag-ir
cargo test -p fullmag-authoring
cargo test -p fullmag-plan
cargo test -p fullmag-api router_v2 --no-fail-fast
cargo test -p fullmag-runner
python3 -m pytest packages/fullmag-py/tests
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
just rebuild-fem-runtime
just ensure-managed-fem-runtime
```

Jezeli zmieniono native FEM, ostatnie dwa polecenia sa obowiazkowe jako finalny
dowod build/runtime. Jezeli zmieniono tylko UI albo Python DSL, FEM managed
build moze byc odnotowany jako nie dotyczy.

## 17. Priorytety implementacyjne

| Priorytet | Etapy | Dlaczego |
|---|---|---|
| P0 | Etap 0 | Obecna regresja UX sprawia, ze uzytkownik traci zaufanie do meshu po zwyklym authoringu. |
| P1 | Etapy 1-3 | Stabilny typed contract, inspektory i mesh policy sa fundamentem dalszego runtime. |
| P2 | Etapy 4-7 | Material fields, FDM/FEM i couplingi domykaja fizyke. |
| P3 | Etapy 8-10 | Realized overlays, diagnostics i dokumentacja robia z funkcji narzedzie produkcyjne. |
| Release | Etap 11 | Cross-layer proof przed uznaniem za gotowe. |

## 18. Ryzyka i blokery

| Ryzyko | Skutek | Mitigacja | Stan mitigacji |
|---|---|---|---|
| Authoring invaliduje mesh payload albo dirty tags | Uzytkownik widzi edge-only safety view po Add Region. | Rozdzielic stale metadata od latest successful mesh resource i pilnowac, ze authoring nie ustawia `mesh:dirty`/`mesh:building`. | Czesciowo zmitigowane: `regionAuthoringInvalidation` wyklucza mesh resources, `stale` topology jest renderowalne, a unit tests pokrywaja region authoring bez `mesh:dirty`. Do weryfikacji browser: brak `topologyFreshness=unknown` po region CRUD. |
| Raw patch kontrakt dla regionow | Drift miedzy API, UI i Python export w operacjach patch, mimo typed SceneDocument. | Typed patch DTO albo scisle izolowany merge-patch boundary z walidacja. | Zmitigowane dla object-region create/patch: `ObjectRegionPatchRequest.patch` jest typed `SceneObjectRegionPatch`, a control-room facade uzywa generated types. Pozostaja raw/merge patch granice poza object-region create/patch. |
| Frontend nie konsumuje generated types | Drift miedzy backend schema a frontend parsowaniem. | Frontend modele musza uzywac generated types zamiast recznego `asRecord()` parsowania. | Zmitigowane dla viewport region overlay: API resource i SceneDocument fallback normalizuja `shape` przez generated OpenAPI `SceneRegionShape`; invalid/csg payload nie trafia do overlay inputu. Pozostaje szerszy audit innych regionowych parserow frontendowych. |
| FDM region-owned fields nie sa materializowane | Region mask/coupling scaffold dziala, ale lokalne material fields musza dotrzec do solver payloadu. | Materializowac authored overrides/fields do `ms_field`/`a_field`/`alpha_field` lub capability-gate'owac kazdy parametr per backend. | Czesciowo zmitigowane: planner materializuje wspierane `Ms/Aex/alpha` fields/overrides do cellwise payloadow i testy `fdm_` to potwierdzaja. Nadal otwarte: mesh policy runtime, pozostale parametry, sampled field payloady oraz CPU/GPU physics parity. |
| Material fields bez runtime | UI pozwala zadeklarowac fizyke, ktora solver ignoruje. | Capability blockers do czasu pelnej materializacji. | Zmitigowane: planner blokuje run z czytelnymi komunikatami. |
| FEM conformal split kruchy | Degenerate tetrahedra albo bledna fizyka granicy. | V1 tylko ograniczone shapes, quality gate, projection explicit extended. | Czesciowo zmitigowane: planner capability gate istnieje. |
| Coupling authored-only | Solver startuje bez RKKY/exchange intent. | Unsupported coupling zawsze blokuje executable plan. | Zmitigowane: planner blokuje z `RequireRuntime`/`AuthoredOnly` policy. |
| Realized overlay miesza sie z authored overlay | Uzytkownik nie wie, czy widzi intencje, czy wynik meshera. | Dwa tryby overlay i czytelne legendy/statusy. | Authored overlay gotowy. Realized overlay nie istnieje. |
| Nested regions bez semantyki | UI sugeruje funkcje, ktorej fizyka nie definiuje. | V1 pokazuje explicit unsupported/inherits none; nested regions dopiero po osobnej decyzji. | Zmitigowane: Explorer pokazuje node z badge `"inherits none"` i status `"degraded"`. |

## 19. Definicja konca

Region-owned semantics mozna uznac za production-ready dopiero gdy:

1. `Add Region` nie zmienia display mode ani nie niszczy ostatniego meshu.
2. Region nie moze wyjsc poza rodzica w UI, API i importowanych scene payloadach.
3. Explorer i Inspector traktuja region jako pelny sub-obiekt z dedykowanymi
   panelami.
4. Python -> IR -> SceneDocument -> OpenAPI -> UI -> export Python round-trip
   zachowuje region IDs, mesh policies, material fields, texture overrides i
   couplings.
5. FDM ma przetestowana produkcyjna sciezke region mask/material fields/exchange
   z CPU oracle i CUDA parity.
6. FEM ma przetestowana albo jawnie capability-gated sciezke coefficient fields,
   conformal sharp interfaces i projection policy.
7. Realized region resources i viewport overlay pokazuja roznice miedzy
   authored intent a zmaterializowana rzeczywistoscia.
8. Capability diagnostics sa widoczne przed build/run.
9. Dokumentacja i przyklady jasno wyjasniaja roznice: region vs osobny obiekt
   materialowy vs coupling.
10. Pelny zestaw release-candidate testow z sekcji 16 przechodzi albo ma
    udokumentowane, zaakceptowane wykluczenie dla niezmenionej warstwy.
