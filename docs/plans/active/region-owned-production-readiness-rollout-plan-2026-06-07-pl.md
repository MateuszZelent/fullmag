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
| SceneDocument | w duzej mierze gotowe | Sa typed structs: `SceneObjectRegion`, `SceneRegionShape` (enum Box/Cylinder/Sphere/Csg), `SceneRegionMeshPolicy`, `SceneRegionMaterialOverride`, `SceneMaterialParameterValue`, `SceneTextureOverride`, `SceneCoupling`, `SceneCouplingEndpoint`, `SceneCouplingParameters`. Wszystkie maja `utoipa::ToSchema`. Pozostaly dlug kontraktu to glownie raw/merge patch payloady (`ObjectRegionPatchRequest.patch: Value`) i reczne typy frontend facade, nie podstawowa scene schema. |
| Planner | w duzej mierze gotowe | Sa capability gates dla: material_parameter_fields, material_overrides, mesh_policy, texture_override, realization_policy (conformal/project), coupling executability. `validate_region_owned_planning()` blokuje run z czytelnymi komunikatami. FDM CUDA exchange pairs sa executable. |
| FDM runtime | czesciowo gotowe | Planner materializuje authored `object_regions` do `region_mask` dla FDM single-grid (`materialize_object_region_mask`) i stosuje region texture overrides oraz region-region exchange overrides. Native FDM ABI ma `region_mask`, `exchange_pair_default`, `exchange_lut` i pola `ms_field`/`a_field`/`alpha_field`. Brak produkcyjnej realizacji region material fields/overrides i mesh policy; brakuje tez szerokich testow fizycznych na non-trivial authored region masks. |
| FEM runtime | w duzej mierze gotowe | Native FEM ABI/runner/backend maja per-node material fields (`ms_field`, `a_field`, `alpha_field` itd.) oraz runtime seam dla per-element `Ms/A` coefficientow uzywanych przez discontinuous conformal domains przy jednym wspolnym polu H1 `m`. Planner materializuje strict conformal constant `Ms/Aex` authored regions z realnymi markerami domeny do `ms_element_field` / `a_element_field`, runner przekazuje te arrays do native ABI, a planner automatycznie wlacza consistent-mass exchange projection dla elementowego `Ms`. Strict-conformal managed CPU smoke `tests/fem_region_owned_validation/spatial_fields_smoke.py` przeszedl do konca przez `fem_cpu_native`. |
| OpenAPI v2 | w duzej mierze gotowe | Sa zasoby regionow/couplingow/material_fields/diagnostics i CRUD regionow. Typed schemas z `utoipa::ToSchema` generuja jawne OpenAPI schematy. Pozostaje doprecyzowac typed patch contract, bo wygenerowany `ObjectRegionPatchRequest.patch` jest raw object, a `apiTypes.ts` nadal uzywa `JsonObject` dla create/patch facade. |
| Control Room | w duzej mierze gotowe | Explorer ma pelne 7 sub-node'ow per region (Geometry, Magnetic Parameters, Mesh, Texture, Visualization, Regions, Diagnostics). Inspector registry routuje kazdy `object.region.*` kind. Region overlay model jest kompletny (box/cylinder/sphere z transform/style/selection). `regionAuthoringInvalidation` poprawnie wyklucza mesh resources. Bounds clamping dziala w UI. Brak: dedykowane panele per sub-node (wszystko w monolitycznym `ObjectRegionsPanel.tsx`), frontend nie konsumuje generated types (parsuje `shape` jako `unknown` przez `asRecord()`). |
| Testy | czesciowo gotowe | Sa testy IR/Python/API/frontend/planner, testy invalidation (`regionAuthoringInvalidation.test.ts` — explicit assert nie invaliduje mesh), testy explorer tree, testy region overlay model, testy CUDA exchange pairs. Brakuje pelnych testow fizycznych z non-trivial region mask, round-trip testow, browser proof. |

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
| Clamp region shape do owner bounds | UI clamp gotowy w `ObjectRegionsPanelModel.ts`; API clamp gotowy w `authoring.rs` (`clamp_object_region_shape_to_owner*`) dla create/patch/duplicate. Pozostaje rozszerzyc testy na world-frame/CSG/imported payload diagnostics. |
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
| Typed generated region schemas | `openapi-v2-types.ts` | Gotowe dla `SceneObjectRegion`, `SceneRegionShape`, `SceneMaterialParameterValue`, `SceneCoupling`. Problem zostaje w raw patch schema i recznej facade `apiTypes.ts`. |

### Zakres (pozostale prace)

| Zadanie | Szczegoly |
|---|---|
| Zastapic raw patch schema typowanym kontraktem | `ObjectRegionPatchRequest.patch` jest `serde_json::Value`, co w OpenAPI generuje slaby object shape. Docelowo dodac typed patch DTO albo jawny JSON Merge Patch schema z walidacja pol. |
| Zachowac migration bridge | Stare scene.v1 payloady przechodza przez adapter, ale zapis scene.v2 uzywa typed fields. |
| Wymusic konsumpcje generated types w frontend facade i modelach | `apiTypes.ts` nadal definiuje `ObjectRegionCreateRequest.region: JsonObject` i `ObjectRegionPatchRequest.patch: JsonObject`; modele (`ObjectRegionsPanelModel.ts`, `RegionsListPanelModel.ts`, `regionOverlayModel.ts`) czesto parsuja `shape` jako `unknown` przez `asRecord()`. Trzeba przejsc na generated `components["schemas"]["SceneObjectRegion"]` i typed draft mappers. |
| Usunac duplicate parsers w UI | `ownerBoundsForObject()` jest zduplikowana w `ObjectRegionsPanelModel.ts` i `RegionsListPanelModel.ts`. `sceneModelTreeAdapter` ma niezalezne parsery raw JSON. |
| Dodac round-trip test | Brak testu Python -> SceneDocument -> UI resource -> export Python ktory weryfikuje zachowanie region IDs i overrides. |

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
| `object.regions` | `RegionsListPanel` | Czesciowo gotowe | Lista, create, duplicate, reorder, delete dzialaja. Brak: summary conflicts. |
| `object.region` | `ObjectRegionOverviewPanel` | Brak dedykowanego panelu | Obecnie obslugiwany w monolitycznym `ObjectRegionsPanel.tsx` (26KB). Nalezy wydzielic osobny komponent. |
| `object.region.geometry` | `ObjectRegionGeometryPanel` | Brak dedykowanego panelu | Logika modelu jest w `ObjectRegionsPanelModel.ts` (shape draft). Brak osobnego pliku panelu. |
| `object.region.magnetic-parameters` | `ObjectRegionMagneticParametersPanel` | Brak dedykowanego panelu | Model ma `RegionMaterialOverrideDraft`. Brak: inherited values preview obok local override. |
| `object.region.mesh` | `ObjectRegionMeshPanel` | Brak dedykowanego panelu | Model ma `RegionMeshPolicyDraft` z walidacja. Brak osobnego pliku panelu. |
| `object.region.texture` | `ObjectRegionTexturePanel` | Czesciowo gotowe | Routuje do `ObjectMagneticTexturePanel` z widokiem `"region"`. |
| `object.region.visualization` | `ObjectRegionVisualizationPanel` | Czesciowo gotowe | Routuje do `ObjectVisualizationPanel`. Brak: overlay visibility/color controls. |
| `object.region.regions` | `ObjectRegionNestedRegionsPanel` | Brak dedykowanego panelu | Drzewo pokazuje node z badge `"inherits none"`. Brak explicit unsupported message. |
| `object.region.diagnostics` | `ObjectRegionDiagnosticsPanel` | Brak dedykowanego panelu | Model ma `ObjectRegionDiagnosticItem` z `capabilityGate`, `realizationStatus`. Brak osobnego pliku panelu. |

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
| UI realized preview | Inspector pokazuje authored value, ale nie realized status, sample count, min/max, warnings. |
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
| Domknac material fields z authored region overrides | **GLOWNY BLOKER.** FDM plan nadal ustawia `ms_field: None`, `a_field: None`, `alpha_field: None` dla region-owned overrides. Trzeba zmaterializowac `MaterialParameterAssignmentIR` / `material_overrides` do cellwise fields. |
| CPU oracle — material fields i region exchange | CPU FDM reference musi byc oracle dla `Ms_i`, `A_i`, `alpha_i`, region mask oraz exchange pair semantics. Nie wystarczy CUDA-only transport. |
| CUDA payload — material fields | Native CUDA ABI ma pola `ms_field`/`a_field`/`alpha_field`, ale backend obecnie odrzuca/nie kwalifikuje non-zero field payloady. Trzeba zaimplementowac albo capability-gate'owac kazdy parametr osobno. |
| Test authored shape -> mask -> exchange | Testy exchange pairs istnieja, ale trzeba dodac przypadek z Python/ProblemIR authored regions, ktory przechodzi przez `materialize_object_region_mask()` do runtime planu. |
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
| Surface selector resolver | `surface("top")` v1 = local bounding-box face + tolerance. Nie zaimplementowane. |
| FDM contact discovery | Coupling surface/object/region endpointy materializuja sie do par sasiednich cell faces. Nie zaimplementowane. |
| FEM boundary markers | Coupling endpointy wymagaja shared boundary markers albo blokady. Nie zaimplementowane. |
| RKKY runtime gate | Unsupported RKKY blokuje run w plannerze (capability gate istnieje). Do weryfikacji: czy RKKY `CouplingKindIR` jest poprawnie odrzucane. |
| Coupling inspector | UI ma `CouplingInspectorPanel.tsx`, ale brak: endpoint resolution preview, runtime status, blocked reason detail. |
| Delete behavior | API guard istnieje: `ensure_region_has_no_active_couplings()` blokuje region referencjonowany przez aktywny coupling. Brakuje pelnego UX: pokazania zaleznosci, akcji disable/delete coupling oraz testow dla surface/object endpoint variants. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| `object.surface("top")` FDM | Resolver znajduje cell faces na bbox top. |
| `rkky` unsupported | Planner blokuje run. |
| Delete region with active coupling | UI/API nie zostawia dangling active coupling. |
| Object-object no coupling | Planner nie syntetyzuje ukrytego exchange. |

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
| Mode switch | UI pozwala przelaczyc authored shape / realized membership / both. Nie zaimplementowane. |
| Selection sync | Explorer <-> Inspector dziala. Viewport -> Explorer selection do weryfikacji. |
| Safety view discipline | Safety wireframe tylko przy rzeczywiscie brakujacej/niezgodnej topologii, nie przy zwyklym authoringu. `regionAuthoringInvalidation` wyklucza mesh resources, ale end-to-end viewport behavior do weryfikacji. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Add region before mesh rebuild | Pokazuje authored overlay, mesh bez zmian. |
| Build mesh after region | Realized overlay pokazuje membership. |
| Select region in viewport | Explorer i Inspector wybieraja ten region. |
| Hide overlay | Glowny mesh zostaje bez zmian. |

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
| Capability vocabulary | Jedne nazwy capability w Python, planner, API i UI. Planner uzywa dlugich stringow, UI nie mapuje ich na user-friendly nazwy. |
| Diagnostics inline w inspectorze | Region diagnostics resource istnieje, ale inspector nie renderuje blokerow inline przy odpowiednich polach (np. mesh policy, material field). |
| Build dialog | Mesh build dialog pokazuje region-related diff i rebuild reasons. Nie zaimplementowane. |
| Run blocker | Simulation run pokazuje region-owned blockers przed startem solvera. Planner blokuje, ale UI nie wyswietla blokerow w sposob user-friendly. |
| Provenance | Artifacts zapisuja authored intent i resolved reality. Nie zaimplementowane. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Unsupported FEM projection strict | UI pokazuje bloker przed run. |
| FDM multilayer + active region | Planner blokuje z jasnym komunikatem. |
| Region overlap equal priority | Diagnostics wskazuje konflikt parametru. |
| Mesh rebuild dialog | Pokazuje `region mesh policy changed`, nie ogolne `topology stale`. |

## 15. Etap 10: przyklady, migracja i dokumentacja uzytkownika

### Cel

Regiony maja byc zrozumiale dla uzytkownika i reprodukowalne w skryptach.

### Zakres

| Dokument / przyklad | Zawartosc |
|---|---|
| User guide: Regions | Kiedy uzyc regionu, kiedy osobnego obiektu, kiedy coupling. |
| User guide: Mesh refinement | Lokalny region mesh policy, skyrmion core, edge refinement, airbox transition. |
| User guide: Material fields | `Ms(x)`, `Aex(x)`, gradienty, sharp jumps, priority. |
| User guide: Couplings | object-object exchange, disabled/free surface, RKKY limitations. |
| Migration note | `scene.v1` -> `scene.v2`, legacy `RegionIR`, old `region_overrides`. |
| Example: skyrmion core | Region cylinder z lokalnym mesh `1 nm` i parent bulk `10 nm`. |
| Example: two objects | Dwa styczne materialy, explicit exchange/RKKY. |
| Example: gradient `Ms` | Jeden obiekt, region/field gradient, brak fizycznego rozdzielenia. |

### Akceptacja

| Test | Wymagany wynik |
|---|---|
| Export UI-authored region script | Skrypt uzywa `object.add_region`, `fm.shapes`, `fm.fields`, `study.couplings`. |
| Run example skyrmion core | Mesh pokazuje lokalne zageszczenie tylko w core. |
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
| Authoring invaliduje mesh payload albo dirty tags | Uzytkownik widzi edge-only safety view po Add Region. | Rozdzielic stale metadata od latest successful mesh resource i pilnowac, ze authoring nie ustawia `mesh:dirty`/`mesh:building`. | Czesciowo zmitigowane: `regionAuthoringInvalidation` wyklucza mesh resources, a stale topology jest renderowalne. Do weryfikacji browser: brak `topologyFreshness=unknown` po region CRUD. |
| Raw patch kontrakt dla regionow | Drift miedzy API, UI i Python export w operacjach patch, mimo typed SceneDocument. | Typed patch DTO albo scisle izolowany merge-patch boundary z walidacja. | Czesciowo zmitigowane: scene structs i generated schemas sa typed; pozostaje `ObjectRegionPatchRequest.patch: Value` i reczna frontend facade `JsonObject`. |
| Frontend nie konsumuje generated types | Drift miedzy backend schema a frontend parsowaniem. | Frontend modele musza uzywac generated types zamiast recznego `asRecord()` parsowania. | Aktywne ryzyko: frontend parsuje `shape` jako `unknown`, nie korzysta konsekwentnie z typed imports. |
| FDM region-owned fields nie sa materializowane | Region mask/coupling scaffold dziala, ale lokalne `Ms`/`Aex`/`alpha` i mesh policy nie zmieniaja solver payloadu. | Materializowac authored overrides/fields do `ms_field`/`a_field`/`alpha_field` lub capability-gate'owac kazdy parametr per backend. | Czesciowo zmitigowane: authored shape -> `region_mask`, texture override i exchange overrides sa w plannerze; material fields/mesh policy nadal blokery produkcyjne. |
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
