# Audyt UI symulacji FDM/FEM: wizualizacja, Explorer, Inspector, interakcje i mesh/airbox

**Data:** 2026-08-04  
**Zakres:** `apps/control-room`, kontrakt v2 API/OpenAPI, adaptery domeny, zasoby mesh/grid, runtime capabilities oraz istniejące testy.  
**Status:** audyt diagnostyczny; dokument nie jest implementacją poprawek.

## 0. Streszczenie wykonawcze

Obserwacja użytkownika jest potwierdzona w kodzie. Problem nie ogranicza się do etykiet w zakładce Mesh — **najpilniejszym blockerem jest brak wiarygodnej wizualizacji 3D meshu/gridu**. UI posiada częściową ścieżkę renderowania FDM, ale większość modelu informacji, zarządzania drzewem, selekcji, Inspectorów i komend nadal zakłada **FEM-owy shared-domain mesh**. W efekcie FDM może dostać panel z parametrami `hmax/hmin`, wzrostem elementu, krzywizną, tetra/pyramid, jakością SICN i budowaniem shared-domain, mimo że jego źródłem prawdy jest regularna siatka strukturalna `shape × origin × spacing` oraz maska przynależności komórek.

Najważniejsze ustalenia:

1. **P0 — wizualizacja 3D meshu/gridu jest stop-ship blockerem.** `FdmGridRenderDomain` i `FdmCuboidLayer` istnieją, lecz aktualny v2 membership może zostać odrzucony, błędnie sklasyfikowany lub zastąpiony fallbackiem całego gridu. Żądania pól/wektorów i część modelu renderowania są dodatkowo warunkowane obecnością FEM-owego `fieldCompatibleTopologyRenderModel`. Najpierw trzeba uzyskać poprawny, revision-aware render geometrii FDM/FEM; dopiero potem ma sens dopracowanie Inspectorów.
2. **P1 — Explorer buduje FEM-owe drzewo niezależnie od dyskretyzacji.** Dla zwykłego FDM nadal pojawia się `Airbox > Mesh > Parameters/Quality Gates/Statistics/Topology/Build & Provenance`, a korzeń Mesh i komenda nazywają się shared-domain/FEM. W snapshotach drzewa brakuje descriptoru FDM, shape, spacing, maski i requested/resolved execution.
3. **P1 — Inspector mesh/airbox/object/region prezentuje i zapisuje parametry elementowe.** Panele są zbudowane wokół Gmsh, rozmiarów elementów, wzrostu, krzywizny, kolejności FEM, tetra/prism/hex, boundary faces i jakości elementów. Brak branchu po `domain.discretization`, brak FDM grid/membership inspectorów i brak bezpiecznego stanu not-applicable.
4. **P1 — FDM airbox/uniwersum nie ma osobnego modelu semantycznego.** Airbox może być prawidłowy dla FDM, gdy universe jest większy od ferromagnetyka, ale obecny model zna tylko cały grid albo FEM-owe `airboxParts`. Nie rozróżnia konsekwentnie magnetic support, aktywnej komórki, komórki nieprzypisanej i inactive/background.
5. **P0/P1 — bazowy stan codec/maski odrzucał aktualny artefakt v2 i odwracał/odrzucał semantykę kodowania; w worktree jest częściowa poprawka bez kwalifikacji browserowej.** Bazowy `HEAD` miał codec tylko v1/kind 1 oraz filtr `regionId > 0`. Bieżący diff dodaje v2/kind 2 i sentinel `u32::MAX`, ale nie dowodzi jeszcze poprawnego renderu całego UI/runtime.
6. **P1 — interakcje, polityka demag i selektory wykonania nie są capability-driven.** UI pokazuje FEM-owe opcje dla FDM, pomija kanoniczne FDM `multilayer_convolution`, zapisuje dowolne kombinacje backend/device/precision/mode bez macierzy legalności i nie pokazuje trwałego requested/resolved/fallback.

Wniosek: potrzebny jest jeden zunifikowany workspace, ale z **dyskryminowanym adapterem domeny**. FDM i FEM nie powinny być dwoma aplikacjami; nie mogą jednak być jednym komponentem z FEM-owymi polami podmienionymi etykietą. Każda powierzchnia musi otrzymać canonical domain/capability resource i renderować tylko semantykę dostępnej realizacji.

### Priorytet naprawczy wynikający z audytu

Kolejność nie może zaczynać się od przebudowy etykiet ani od pełnego Explorer/Inspector. Najpierw należy zamknąć **3D mesh-visualization gate**:

1. FDM v2 membership dekoduje się bez błędu i zachowuje `schema/version/encoding`;
2. active `0`, region IDs, inactive `u32::MAX` oraz ewentualny air/background są klasyfikowane jawnie;
3. FDM grid i FEM topology mają działający, rozłączny render path;
4. FDM universe większy od magnetic support pokazuje cały zakres oraz magnetic/air occupancy bez udawania FEM airboxa;
5. field/vector demand nie wymaga FEM manifestu;
6. browser smoke potwierdza canvas, WebGL context i niezerowy drawing buffer.

Jeżeli którykolwiek punkt nie przechodzi, dalsze panele mogą jedynie maskować problem i nie powinny być traktowane jako priorytet implementacyjny.

## 1. Metoda i granica kwalifikacji

Audyt wykonano przez statyczne prześledzenie:

- źródeł React/TypeScript w `apps/control-room`,
- modeli stanu, adapterów domeny, selektorów zasobów i API facade,
- schematów Rust v2/OpenAPI dla domain, mesh, runtime i FDM membership,
- testów jednostkowych/komponentowych oraz istniejących planów produkcyjnych.

Zrzut dostępny w sesji (`/mnt/c/Users/Mateusz/.codex/attachments/6614fea1-f8f8-4a0a-885b-e5d7d5a982c5/image-1.png`) pokazuje ten sam symptom: Explorer ma `Airbox > Mesh`, a Inspector pokazuje render modes i zakładkę Mesh o wyglądzie FEM/shared-domain. Podana później ścieżka `C:\Users\Mateusz\AppData\Local\Temp\codex-clipboard-2f004cd9-eaa1-4151-8408-1fb28bc9d4d1.png` nie istnieje w środowisku, dlatego nie traktuję jej jako dodatkowego dowodu.

Nie wykonano w ramach tego audytu:

- uruchomienia pełnego Control Room w przeglądarce z rzeczywistym payloadem FDM,
- browser smoke/E2E dla WebGL, drawing buffer, hover i selekcji komórki,
- kwalifikacji fizycznej solvera ani sprawdzenia, czy konkretne FDM pole zostało policzone na urządzeniu.

Wnioski oznaczone jako „źródło/test” są dowodem implementacyjnym. Nie oznaczają jeszcze, że każda obserwacja została odtworzona w działającym runtime. Brak browser proof jest osobnym blockerem P1/P2, a nie podstawą do uznania problemu za rozwiązany.

### 1.1. Bieżący working tree — częściowa poprawka P0, nadal niezakwalifikowana

Ponowna inspekcja bieżącego checkoutu wykazała niezatwierdzony diff w:

- `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts` — canonical v2 (`version=2`, `kind=2`), kompatybilność legacy v1, `FMRM_INACTIVE_REGION_ID`, `formatVersion/payloadKind`;
- `apps/control-room/src/kernel/api/codecs/index.ts` — eksport sentinelu;
- `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts` — aktywność definiowana jako `regionId !== FMRM_INACTIVE_REGION_ID`, więc ID `0` pozostaje aktywne;
- odpowiadające testy codec/modelu.

Weryfikacja fokusu:

```text
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/codecs/fdmRegionMembershipCodec.test.ts \
  src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts
→ 2 pliki, 6 testów passed
```

To zamyka wyłącznie testowany podfragment decode/classification. Nie zamyka `FDM-UI-001` ani pełnego `FDM-UI-002`, ponieważ nadal brak browser proof, nadal istnieje gate `fieldCompatibleTopologyRenderModel`, a fallback/error path, air/void overlay, target/selection i Explorer/Inspector nie są przez te testy pokryte. W raporcie status „candidate fix in working tree” jest celowo oddzielony od „qualified/complete”.

## 2. Kontrakt domeny, który UI powinien respektować

Backend już rozróżnia dwie realizacje:

| Aspekt | FDM | FEM |
|---|---|---|
| Podstawowy opis | `DomainMeta.discretization = "fdm"` oraz `grid` | `discretization = "fem"`, manifest shared-domain/topology |
| Geometria obliczeniowa | regularny grid: `shape`, `origin_m`, `spacing_m`, `cell_count` | węzły, elementy, rodziny `tet4/prism6/pyramid5/...`, boundary faces |
| Przynależność | `FdmRegionMembershipResource`: maska/region ID dla komórek, `grid_fingerprint`, encoding | konformalny membership: element/node/boundary-face indices i topology fingerprint |
| „Airbox” | część universe poza magnetic support; może być regularnym obszarem void/air/background | jawne `airboxParts` i elementy shared-domain |
| Jakość | grid spacing, count, mask freshness, active/background counts; brak SICN/tetra bins | rozkłady edge/volume/SICN, rodziny elementów, quality gates |
| Budowa | generowanie/odświeżenie gridu i maski | budowa shared-domain mesh, manifest, topology, quality |
| Selekcja | `(i,j,k)`, global cell ordinal, region ID, mask state, grid fingerprint | element family/index, mesh part, airbox part, boundary face |

Źródła kontraktu:

- `crates/fullmag-api/src/schemas/domain.rs:10-52` — `DomainMeta` i `StructuredGridDescriptor`;
- `crates/fullmag-api/src/schemas/mesh.rs:923-985` — osobne FEM `MeshRegionMembershipResource` i FDM `FdmRegionMembershipResource`;
- `crates/fullmag-runner/src/fdm/artifacts.rs:68-83` — semantyka v2 kodowania (`u32::MAX` = inactive, `0` = active/unassigned);
- `crates/fullmag-api/src/router_v2/handlers/data/fdm_region_membership.rs:147-169,251-386` — encoder zachowujący maskę i region legend;
- `docs/plans/active/mesh-management-ui-production-masterplan-2026-06-06-pl.md:45-54` — wymaganie jednego drzewa FDM/FEM z gotowością gridu i requested/resolved;
- `docs/plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-004-mesh-editor-capabilities-implementation-plan.md:5-15,38-47` — capability-driven FDM grid/FEM mesh editor i nadal otwarty pełny round-trip.

To rozróżnienie musi stać się typem wejściowym dla każdego panelu, a nie lokalnym `if` tylko w viewport.

## 3. Audyt wizualizacji i viewportu

### 3.1 Co działa częściowo

`apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts:44-65,78-130` ma dwa sensowne modele:

- `FdmGridRenderDomain` z bounds, budgetem, shape, origin, spacing, stride i `totalCells`,
- `FemManifestRenderDomain` z `magneticParts`, `airboxParts` i mapami manifestu.

`useViewport3DSceneModel.ts:2351-2390` pobiera `DomainMeta`, adaptuje FDM grid i korzysta z `useFdmRegionMembershipResource`/binary resource. `Viewport3DScene.tsx:931-954` montuje `FdmCuboidLayer`. Istnieją też testy `FdmCuboidLayer.test.ts` i `fdmCuboidBuildModel.test.ts` oraz hover inspection w `viewport3dInspect.ts:33-91`.

To jest dobry zalążek, ale nie jest pełną ścieżką równoważną FEM.

### 3.2 P0: żądania pól/wektorów są zależne od FEM topology model

W `useViewport3DSceneModel.ts`:

- `:2627-2634` ustawia `fieldCompatibleTopologyRenderModel` tylko po sprawdzeniu bieżącej FEM topology;
- `:2952-2987` wylicza airbox field vectors i node count z `fieldCompatibleTopologyRenderModel.airboxParts`;
- `:3035-3105` zwraca pusty target-quantity demand plan, gdy nie ma tego modelu;
- `:3295-3325` uzależnia `primaryFieldVectorEnabled` od `Boolean(fieldCompatibleTopologyRenderModel)`;
- `:3446-3527` dziedziczy tę bramkę przy pobieraniu resource;
- `:3777-3840` przekazuje FEM-owy topology model do ogólnego field render modelu.

Konsekwencja: FDM może mieć strukturę kostek, lecz aktywne pole, wektory, target quantity, legendę i zapotrzebowanie na dane nie przechodzą przez wspólny FDM contract. To jest błąd architektoniczny, nie tylko brak komponentu.

**Kryterium P0 wizualizacji:** dla identycznego FDM statusu i quantity selectorów UI musi:

1. pobrać właściwy field resource bez obecności FEM manifestu;
2. zastosować grid/mask do tej samej komórkowej domeny;
3. zbudować wektory/kolorowanie/topography z jawnie podanym `cell_count` i jednostką;
4. pokazać unsupported/degraded, gdy resource nie istnieje — nie wyciszyć żądania.

Przed przejściem do Explorer/Inspector wymagany jest również test geometrii: niezerowy FDM grid z maską ma być widoczny jako właściwy zakres komórek, a nie jako pusty viewport i nie jako pełny box po błędzie membership.

### 3.3 P1: airbox/void extent FDM nie ma renderera ani targetu

`Viewport3DScene.tsx:956-970` przekazuje do `AirboxLayer` wyłącznie FEM `topologyModel`. `BoundsLayers.tsx:1025-1084` buduje `AirboxMeshPartLayer` z `topologyModel.airboxParts`; przy FDM lista jest pusta. FDM ma tylko `FdmCuboidLayer` i zewnętrzny `DomainBox` (`Viewport3DScene.tsx:727-741`).

`viewport3DTargets.ts:63-72` mapuje FDM domain na generyczny `kind: "object"`, podczas gdy `viewport3DFieldDataPlan.ts:760-780` używa `targetKind: "fdm-domain"`. To dwa niespójne identyfikatory tej samej semantyki.

Airbox w FEM ma dodatkowy kontrakt hidden-edge/interior volume (`BoundsLayers.tsx:750-812,909-973`), którego FDM nie posiada. Przy universe większym od ferromagnetyka nie da się zatem wiarygodnie wskazać: „to jest cały universe”, „to jest magnetic support”, „to jest pusty/air background” i „to jest zakres aktualnie renderowanych komórek”.

**Kryterium P1:** FDM ma jeden jawny `fdm-domain` target oraz osobny, opcjonalny overlay `universe/air/void`, wyliczony z descriptoru i maski. Overlay nie może udawać elementowego airboxa FEM.

### 3.4 P0/P1: v2/maska — bazowy błąd i częściowa poprawka working tree

W `HEAD` `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts:1-3,29-31` miał stałe `VERSION=1` i `KIND_U32=1`, a `:6-12,14-65` redukował payload do surowych ID i gubił schema/version/encoding. Aktualny runner emituje v2 header/version/kind (`crates/fullmag-runner/src/fdm/artifacts.rs:72-79`), a API preferuje `fdm_region_membership.v2.json` (`crates/fullmag-api/src/router_v2/handlers/data/fdm_region_membership.rs:214-228`).

Bieżący niezatwierdzony diff zmienia codec na v2/2, zachowuje v1 jako legacy i eksportuje sentinel (`fdmRegionMembershipCodec.ts:1-8,38-88`). To jest poprawa kierunkowa, ale nie jest jeszcze dowodem produkcyjnego renderu.

`useViewport3DSceneModel.ts:2370-2386` ustawia `fdmRealizedRegionIds` tylko po udanym decode. Gdy resource ma error, `.data` jest `null`, a `fdmCuboidBuildModel.ts:82-103` przechodzi do fallbacku próbkowania całego authored gridu. To nie jest neutralne degraded state: bez udowodnionej polityki błędu inactive/outside cells mogą zostać wizualnie potraktowane jak aktywne komórki. Błąd trafia głównie do diagnostyki (`useViewport3DSceneModel.ts:4022-4031`), więc nadal potrzebny jest browser test i jawny degraded marker.

Należy zachować kompatybilność v1 tylko wtedy, gdy jest to jawnie potrzebne, ale v2 musi być pierwszorzędnym kontraktem i mieć test fixture z aktualnym headerem.

Nawet po dodaniu v2 obsługi `fdmCuboidBuildModel.ts:168-185` nie może filtrować `regionId > 0`.

To jest sprzeczne z backendem: `u32::MAX` oznacza inactive, a `0` active/unassigned. Obecny filtr:

- usuwa aktywne komórki ID `0`,
- może pozostawić sentinel inactive jako zwykły region,
- nie pozwala odróżnić `air/background` od `unassigned` bez dodatkowego legend/state,
- nie zapewnia zgodności z `active_mask` w encoderze.

Istniejący test `fdmCuboidBuildModel.test.ts:5-25` utrwala tę interpretację (`[0,2,0,1]` → indeksy `[1,3]`) i nie ma przypadku `u32::MAX` ani active/unassigned. Jest to P0 dla ścieżki produkcyjnego v2 fallbacku oraz P1 dla samego klasyfikatora maski: wizualizacja może wyglądać jak pełny box albo pominąć aktywne komórki, które fizycznie są ID `0`.

### 3.5 Selekcja i inspect FDM

`viewport3dInspect.ts:33-91` potrafi chwilowo wyświetlić wartości dla `Cell {pointIndex}`, ale `selectionTypes.ts:214-284` nie ma jawnego FDM cell ref z `(i,j,k)`, `grid_fingerprint`, mask state i region legend. `MeshElementFamily` zna tylko FEM `hex8/prism6/pyramid5/tet4`.

`resolveViewport3DSelectionBounds` (`viewport3DTargets.ts:284-324`) przyjmuje `FemManifestRenderDomain` i airbox bounds wyznacza z `airboxParts`; FDM grid nie ma równoważnego resolvera. Hover nie może więc stać się stabilną selekcją, inspektor nie ma gwarancji, że kliknięta komórka odpowiada tej samej rewizji gridu, a focus/fit bounds może celować w pusty FEM model.

### 3.6 Wizualizacja panelu obiektu

`ObjectVisualizationController.ts:157-183,235-272` ma domyślne Airbox settings z aktywnym quantity `H_demag`, geometry scope `full`, FEM-owe primary render modes i `showBoundsControl: false`. `ObjectVisualizationPanel.tsx:137-221` ładuje wyłącznie shared-domain manifest i selected mesh parts. `ObjectVisualizationPanelModel.ts:331-369,700-787,1376-1501` zgłasza „No airbox mesh part is present in the shared-domain manifest”, co dla FDM jest fałszywie brzmiącym błędem, a nie stanem „FDM air/void overlay uses grid mask”.

## 4. Audyt Explorera, drzewa i selekcji

### 4.1 P1: drzewo Airbox/Mesh jest unconditional

`apps/control-room/src/modules/explorer/builders/buildModelTree.ts:1172-1292` zawsze tworzy:

```text
Airbox
└── Mesh
    ├── Parameters
    ├── Quality Gates
    ├── Statistics
    ├── Topology
    └── Build & Provenance
```

Podobnie `:918-1020` zawsze tworzy Mesh, `Shared-Domain Solver Mesh`, Build Pipeline, Quality Gates, Realized Size Fields i Regions/mesh parts. `ExplorerModule.tsx:144-186,322-411` zna `discretization`, ale nie przekazuje go do snapshotu jako rozstrzygającego adaptera. `ModelTreeSnapshot` (`explorerTypes.ts:421-440`) nie zawiera `discretization`, FDM grid descriptoru, mask revision ani requested/resolved execution.

Dla FDM, gdy `explicit_topology=false`, `studyRuntimeResources.ts:400-426` poprawnie nie wymaga shared-domain manifestu, lecz builder drzewa nadal renderuje FEM-owy kształt. Otrzymujemy więc rozjazd: resource gate mówi „brak shared mesh”, a Explorer pokazuje użytkownikowi ścieżkę, która implikuje, że ten mesh powinien istnieć.

### 4.2 Brak semantycznych rodzajów FDM

`ExplorerNodeKind` (`explorerTypes.ts:15-205`) nie zawiera `mesh.grid`, `mesh.grid.region`, `fdm.cell` ani odpowiednika. Nie ma też dedykowanego Inspector registry entry. Nowy FDM node musiałby obecnie trafić do wildcard Placeholder (`inspectorRegistry.tsx:779-788`).

`explorerSelection.ts:222-239` mapuje wszystkie Airbox nodes na generyczne `{type:"airbox", visualizationTargetId:"airbox"}`. `:108-117` obsługuje tylko `mesh.unassigned.part`; rodzic `mesh.unassigned` nie ma semantycznego panelu. To utrudnia pokazanie różnicy między:

- gridem obliczeniowym,
- regionem obiektu,
- aktywną komórką,
- air/void/unassigned,
- elementem FEM.

### 4.3 P1/P2: breadcrumbs i panel registry są niespójne

`inspectorDescriptor.ts:112-146` generuje breadcrumb Airbox, a `:124-135` potrafi wyemitować selection kind `object`. Registry ma natomiast exact panel tylko dla `object.root` (`inspectorRegistry.tsx:492-496`), więc część breadcrumbów może otworzyć Placeholder zamiast właściwego inspectora.

`inspectorRegistry.tsx:724-735` nie ma exact entry dla `mesh.unassigned`/`mesh.unassigned.part`. To nie jest wyłącznie problem FDM, ale przy dodaniu FDM grid/cell pogłębiłoby ryzyko, dlatego należy naprawić registry w tym samym kontrakcie.

### 4.4 P2: badge i provenance nie mówią, co faktycznie działa

`buildModelTree.ts:1387-1404` pokazuje „Published fields” z `m, H_demag` oraz „Mesh topology” z revision/stale nawet wtedy, gdy FDM nie ma topology manifestu. `explorerTypes.ts:503-510` przechowuje requested backend/device/mode/precision tylko dla Study, nie dla mesh/grid node. Użytkownik nie dostaje więc trwałej informacji:

```text
requested: FDM / GPU / double / strict
resolved:  FDM / CPU / double / extended
fallback:  reason
grid:      revision / fingerprint / freshness
```

## 5. Audyt Inspectorów

### 5.1 Mesh Details — panel elementowy bez branchu FDM

`useMeshDetailsModel.ts:70-77,141-172` odczytuje `domain.discretization` tylko do porównań równości. `:308-356` pobiera shared-domain manifest/report/quality/gates/size-fields/universe report/quality niezależnie od aktywnej reprezentacji. `:416-455` wybiera „worst element” przez FEM `elementIndex`, a `:486-566` komenda zawsze wykonuje `mesh.build-shared-domain`.

`MeshDetailsPanel.tsx:27-109,118-260` domyślnie pokazuje identity, pipeline, mixed topology, policy, quality, size fields, thin-film, shared-domain JSON. `MeshOverviewSection.tsx:39-78,101-132,153-195` mówi o Nodes/Elements/Boundary Faces, min/max/mean edge i mesh parts. `MeshQualityStatisticsView.tsx:257-276,308-320` opisuje tetra-size, edge-length, volume bins i SICN. `MixedTopologyProvenanceSection.tsx:325-405` pokazuje prism/P1/Gmsh/family/facet counts.

Dla FDM te sekcje powinny zostać zastąpione lub oznaczone jako nieaplikowalne. Prawidłowy odpowiednik to m.in. `Nx × Ny × Nz`, `origin_m`, `cell_m`, total/active/inactive/background cells, region legend, mask freshness, grid fingerprint i stride/display budget.

### 5.2 Airbox Mesh — dokładny symptom ze zrzutu

`AirboxMeshParametersPanel.tsx:58-94,204-292` deklaruje pola `airboxHmax`, `airboxHmin`, maximum growth rate, curvature factor, narrow-region resolution, padding/size/center i effective element sizes. `airboxMeshPolicyDraft.ts:7-31,48-73,99-203` waliduje te same FEM/Gmsh-owe pojęcia oraz grading `auto/geometric/linear`.

Panel zapisuje `api.meshing.replaceUniversePolicy` i wykonuje `commands.execute("mesh.build-shared-domain")`; kopia mówi „Shared-domain mesh”. To jest twardy dowód, że zakładka Airbox Mesh nie jest adaptowana do FDM.

Pozostałe panele są równie jednoznaczne:

- `AirboxMeshOverviewPanel.tsx:54-72` — effective maximum/minimum element size, growth, policy/manifest revisions;
- `AirboxMeshQualityGatesPanel.tsx:28-40` — strukturalne quality gates;
- `AirboxMeshStatisticsPanel.tsx:40-78` — points/nodes, volume elements, element families, boundary/surface faces, interface nodes;
- `AirboxMeshTopologyPanel.tsx:25-44` — topology fingerprint, carrier, boundary sources;
- `AirboxMeshBuildPanel.tsx:29-92` — shared-domain lifecycle/provenance/pipeline;
- `AirboxOverviewPanel.tsx:33-57` — mesh carrier/nodes/elements/boundary faces.

`airboxInspectorRuntimeStatus.ts:4-10,47-50` odczytuje `domain.discretization`, ale używa go tylko do runtime equality/load status. Nie steruje renderowaniem paneli. Testy `AirboxMeshBuildPanel.test.tsx:27`, `airboxMeshInspectorModel.test.ts`, `ScopedMeshQualityPanels.test.tsx` używają fixture’ów FEM i nie zawierają FDM render contract.

### 5.3 Object Mesh Policy — Gmsh/FEM controls dla każdej dyskretyzacji

`ObjectMeshPolicyPanelModel.ts:18-87,101-200,240-345` ma tylko politykę elementową: hmax/hmin, curvature, topology/order/sweep/manual size. `ObjectMeshPolicyPanel.tsx:316-334` pokazuje Element Size Parameters, FEM order i Mesh source; `:338-444` pokazuje free tetra/swept prism/hex, layers i thickness distribution; `:465-511` pokazuje Gmsh 2D/3D algorithm, smoothing, optimizer i boundary layers; `:596-648` wyświetla target max/min element, topology, nodes/elements/boundary faces; `:935-1012` renderuje całość oraz Build Mesh bez branchu.

`ObjectRegionsPanelModel.ts:18-24,451-460,815-839,893-900` serializuje region policy z max/min element size, transition distance i order. `ObjectRegionMeshPanel.tsx:42-128` i `ObjectRegionsPanel.tsx:176-195` korzystają z konformalnego FEM membership/quality. `regionMeshLifecycle.ts:15-28,52-64,111-137` wymaga topology fingerprint/generation i conformal freshness, których FDM descriptor nie ma.

Wniosek: nie wolno „przemianować” tych pól na grid size. FDM potrzebuje osobnego draftu (cell spacing/grid dimensions/origin/alignment/mask policy) i osobnego lifecycle.

### 5.4 Visualization Inspector — FEM carrier dependency

`ObjectVisualizationPanel.tsx:137-156` pobiera wyłącznie `useMeshSharedDomainManifestResource`, a selected mesh-part rozwiązuje przez `manifestRenderableCarriers`. `ObjectVisualizationPanelModel.ts:331-369,700-787,1376-1501` buduje dostępne node counts/parts/vector diagnostics tylko z manifestu. FDM grid/mask resources nie są włączone do tej ścieżki. `ObjectVisualizationOverview.tsx` ma nawet copy „Canonical finite-element field available” (`:100`).

FDM Visualization Inspector powinien wybierać grid target, quantity, vector sampling, cell/region mask, clipping po indeksach i ograniczenia display budget. Gdy pole nie jest dostępne, należy pokazać powód (`unsupported`, `not materialized`, `stale`, `no active cells`) zamiast pustego renderu.

### 3.7 Field map i topography mają dodatkowe rozjazdy zakresu

`apps/control-room/src/modules/field-map/FieldMapModule.tsx:82-93` wywołuje `usePlanarProbeResource` tylko z component/resolution/u/v, pomijając `scope_kind/scope_id`, stage/snapshot i expected monitor/mesh/field revisions, mimo że `PlanarFieldProbeQuery` je wspiera (`kernel/api/apiTypes.ts:94-110`, `planarFieldResources.ts:205-265`). Probe może więc pokazać wartość z innego scope albo snapshotu niż raster na ekranie; jest to P1 dla reprodukowalności FDM/FEM.

`apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx:82-86,147-154` przechowuje `emptyMask` lokalnie, ale `apps/control-room/src/modules/field-map/renderer/planarColorizer.ts:27-38` transferuje ten sam `mask.buffer` do workera. Późniejszy hover używa odłączonej tablicy typed array. Empty pixel może zostać zgłoszony jako zajęty i dostać wartość zamiast `null`. Maskę trzeba sklonować albo zachować nieprzekazywaną kopię do probe.

`apps/control-room/src/modules/field-map/FieldMapModule.tsx:109-121` raportuje głównie meta/scalar errors; błędy mask/vector/mesh mogą pozostawić częściowy, cichy render. Również FDM-only topography ma niespójny ribbon: `ribbonTabViews.tsx:927-935` mówi o FDM, ale control jest statycznie niedostępny, podczas gdy `ribbonContributions.tsx:1808-1879` nie bramkuje topography po `structured_grid`/`discretization` i manifest viewportu (`viewport-3d/manifest.ts:393-432`) nie deklaruje disabledReason.

## 6. Mesh i airbox: wymagany model produktowy

### 6.1 Airbox zostaje, ale zmienia semantykę zależnie od backendu

Nie rekomenduję usuwania airboxa z FDM. Jeśli universe jest większe od ferromagnetyka, użytkownik musi zobaczyć zakres solvera i przestrzeń poza magnetic support. Nie oznacza to dodania drugiego FEM-owego `AirboxLayer`: FDM pozostaje jednym regularnym gridem, a air/void jest rolą/overlayem tego gridu wynikającym z maski i bounds. Jest to zgodne z `docs/plans/active/fdm-viewport-cuboid-visualization-diagnostic-plan-2026-06-05-pl.md:28-44`, gdzie FDM opisano jako jeden regularny grid bez osobnej FEM-owej siatki airboxa. Rekomendowana reprezentacja:

```text
FDM Domain / Grid
├── Grid descriptor
├── Magnetic support (region mask)
├── Universe outside magnetic support (optional air/void overlay)
├── Active / unassigned / inactive cells
└── Mask & provenance
```

W FEM zachowujemy obecne pojęcia elementowe:

```text
FEM Shared-Domain Mesh
├── Magnetic parts
├── Airbox parts
├── Interface/boundary faces
├── Element families
└── Quality/topology/build provenance
```

Nazwa może pozostać „Airbox” jako pojęcie fizyczne, ale UI nie może używać wspólnego kontraktu `hmax/hmin/tet4` dla obu realizacji.

### 6.2 MeshBuildDialog jest również FEM-first

`apps/control-room/src/modules/overlay/MeshBuildDialog.tsx:216-243,251-295,406-479` ładuje generic/FEM manifest/quality, diffuje `effective_airbox_target`, a potwierdzenie zakłada revision/manifest/quality/viewport render. `MeshBuildConfirmDialog.tsx:42-46,82-94` mówi o strict layered prism/mixed topology. Nie ma FDM cases w `MeshBuildDialog.test.tsx:5-31` ani `MeshBuildConfirmDialog.test.tsx:6-108`.

Dla FDM komenda powinna być „Build/refresh FDM grid and region mask”, a dialog powinien pokazywać grid shape/spacing, mask revision i zakres display, nie quality report shared-domain.

### 6.3 Zasoby FDM istnieją, lecz są niewykorzystane

`geometryLifecycleResources.ts:935-1010` ma hooki `useFdmRegionMembershipResource` i binary resource. `crates/fullmag-api/src/schemas/mesh.rs:957-985` definiuje schema_version, mesh_revision, region_membership_revision, freshness, binary path, grid fingerprint, origin, counts, cell size, cell count, object IDs, region legend i encoding. Explorer/Inspector nie konsumuje tych hooków (`rg -l useFdmRegionMembershipResource .../modules/explorer .../modules/inspector` zwraca brak wyników), a viewport jest jedynym konsumentem.

To powinno zostać podniesione do wspólnego domain adapter/resource layer. Nie należy tworzyć drugiego, lokalnego FDM API w komponencie.

## 7. Audyt interakcji, physics i capability

### 7.1 P1: demag policy jest twardo FEM-owe

`StudyInspectorPanel.tsx:1389-1392` zawsze pokazuje `Current FEM demag policy`, a `:1489-1498` renderuje `FEM demag policy` textarea nawet przy `requested_backend=fdm`. `StudyGlobalAuthoringModel.ts:8-20,83-84,138-142,159` parsuje i waliduje wyłącznie `fem_demag_solver_policy`.

`shared/domain/physics/interactions.ts:69-77` ma jednocześnie FEM Poisson Robin/Dirichlet/BEM/Fredkin/FMM i FDM `multilayer_convolution`, ale `StudyInspectorPanel.tsx:1458-1470` pomija kanoniczną opcję FDM. FDM powinien pokazywać `multilayer_convolution` tam, gdzie capability/runtime ją wspiera, a FEM-only policy powinno być ukryte albo jawnie oznaczone jako unavailable/deferred — nie zapisywane jako aktywna polityka FDM.

### 7.2 P1: interakcje są katalogiem statycznym, nie capability resource

`InteractionSpec` (`shared/domain/physics/interactions.ts:23-52`) nie ma backend/device/precision/mode capability. `PhysicsInteractionPanel.tsx:186-190,369-406,450-471` sprawdza tylko spec/deferred, a `sceneModelTreeAdapter.ts:710-752` seeduje exchange+demag dla każdego obiektu. `ribbonContributions.tsx:199-209` dodaje wszystkie specs do menu, a test `ribbonStructure.test.ts:1438-1472` utrwala wszystkie 11 pozycji. Komenda w `ribbonCommands.ts:195-204,400-445` sprawdza głównie istnienie selekcji.

To pozwala kliknąć opcję, która jest semantic-only, planner-deferred albo niedostępna dla aktualnego lane. Capability musi zawierać co najmniej `supported | semantic_only | deferred | unsupported`, reason oraz macierz backend × device × precision × mode × interaction.

### 7.3 P1: requested/resolved execution ginie w Study Inspector

Selektory w `StudyInspectorPanel.tsx:1394-1436` pokazują auto/FDM/FEM/hybrid, CPU/GPU, double/single i strict/extended/hybrid. `StudyGlobalAuthoringModel.ts:105-143` waliduje formaty, lecz nie legalność kombinacji.

Runtime publikuje pełne requested/resolved/fallback w `crates/fullmag-api/src/schemas/runtime.rs:58-77` i `openapi-v2-types.ts:3837-3847`, lecz `StudyInspectorModel.ts:73-125,147-170,173-320` nie wystawia tych pól. Sekcja runtime (`StudyInspectorPanel.tsx:1059-1100`) nie pokazuje trwałego resolved backend/device/precision/mode ani fallback. Startup overlay ma część tego (`simulationPreparationModel.ts:156-157`, `SimulationStartupOverlay.tsx:159-173`), ale po starcie informacja znika.

### 7.4 P1/P2: ribbon i stage commands nie są adaptacyjne

`ribbonContributions.tsx:294-305` ma statyczne `Build FEM Mesh`; `:447-479` pokazuje FDM grid i FEM shared domain bez filtrowania po aktualnym lane. `kernel/runtime/studyRuntimeCommandContributions.ts:424-476` używa tylko coarse gates (`binary_fields`, `explicit_topology`, discretization, revisions). `addStageCommand` (`:1671-1711`) włącza wszystkie stage commands, a registry (`:1935-1994`) obejmuje eigenmodes/frequency/FFT/hysteresis mimo statusu `eigen_modes:false` (`crates/fullmag-api/src/router_v2/handlers/sessions/status.rs:228-239`).

Dodatkowo `FrequencyResponseStageInspector.tsx:59-95,448-458` hardcoduje wykonywalny lane „FEM magnetic-only CPU response; double precision”, a `EigenmodesStageInspector.tsx:76-82,126-145,200-212` odsyła rozstrzygnięcie do plannera bez aktywnej macierzy w UI. FDM może więc dodać stage, który dopiero później zostanie odrzucony, bez wskazania capability reason.

`CapabilityMap` (`crates/fullmag-api/src/schemas/status.rs:151-165`) jest zbyt gruby, a `RunSummary` (`:56-74`) nie ma pełnej informacji requested/resolved backend/precision/mode/fallback. Nie da się na nim zbudować rzetelnego, reaktywnego ribbonu.

### 7.5 P2: niespójna walidacja stage

`StudyGlobalAuthoringModel.ts:308-342` i `StudyStageAuthoringModel.ts:1838-1852` dopuszczają szerokie kombinacje backend/device dla adaptive; `StudyStageInspectorRouter.ts:43-51` pomija precision, a `validateStudyStageDraft` (`StudyStageAuthoringModel.ts:1572-1582,1847-1852`) odrzuca single/adaptive dopiero w wybranej ścieżce. UI może więc chwilowo pokazać poprawny stage, który odrzuci commit.

## 8. Stan, API, lifecycle i provenance

### 8.1 Jeden adapter domeny, zamiast lokalnych branchy

Obecny podział jest odwrotny od potrzeb: viewport ma FDM adapter, Explorer/Inspector mają FEM-owe modele i dopiero lokalnie sprawdzają `discretization`. Należy wprowadzić jeden serializowalny, revision-aware adapter:

```ts
type RenderDomain =
  | { kind: "fdm-grid"; descriptor: StructuredGridDescriptor; membership: FdmMembership }
  | { kind: "fem-topology"; manifest: FemManifest; topology: FemTopology };
```

Z niego powinny korzystać viewport, Explorer, Inspector, selection resolver, commands i tests. Adapter nie może ukrywać błędu: jeśli FDM resource jest stale lub nieobecny, zwraca jawny status z reason.

### 8.2 Lifecycle nie może wymagać FEM topology dla FDM

`shared/domain/mesh/regionMeshLifecycle.ts:15-28,52-64,111-137` wymaga conformal current, topology fingerprint i generation. FDM potrzebuje analogicznego, ale odrębnego warunku: `mesh_revision`, `region_membership_revision`, `grid_fingerprint`, `freshness`, schema/encoding compatibility i mask counts.

`studyRuntimeResources.ts:365-426` powinien rozróżniać:

- `requiresSharedDomain` dla FEM/explicit topology,
- `requiresFdmGrid` dla FDM structured grid,
- `requiresFdmMembership` tylko dla overlays/region selection, nie dla samego gridu.

### 8.3 API resource-first jest częściowo gotowe

FDM descriptor/membership ma zasoby, ale `MeshSemanticsResource` (`crates/fullmag-api/src/schemas/mesh.rs:193-224`) pozostaje generic `config/effective_config` bez dyskryminacji. To sprzyja sytuacji, w której FDM dostaje FEM config JSON. Kontrakt powinien jawnie określać `kind: fdm_grid | fem_shared_domain` albo capabilities schema, aby UI nie musiało zgadywać po obecności pól.

### 8.4 Requested vs resolved i fallback muszą być pierwszorzędne

Każdy relevant node/panel powinien mieć:

- requested backend/device/precision/mode;
- resolved backend/device/precision/mode;
- fallback/reason;
- resource revision/fingerprint/freshness;
- capability state i human-readable explanation.

Nie wystarczy badge „FDM” w status barze, jeśli Inspector nadal pokazuje FEM policy.

## 9. Priorytetyzowany rejestr findings

| ID | Priorytet | Obszar | Finding / skutek | Dowód | Kryterium zamknięcia |
|---|---|---|---|---|---|
| FDM-UI-001 | P0 | viewport/data | Field/vector/target demand FDM jest gated przez FEM topology | `useViewport3DSceneModel.ts:3035-3105,3295-3527` | FDM field/vector path działa bez manifestu FEM; brak resource jest jawny |
| FDM-UI-002 | P0/P1 | mask/visual | bazowy v2 header był odrzucany; working tree ma częściowy candidate fix, ale brak render/runtime proof | runner `fdm/artifacts.rs:68-83`; API `fdm_region_membership.rs:214-228`; codec/build model + focused tests | v2/v1 compatibility + testy encoding-aware dla 0/MAX/region/air/inactive + browser render |
| FDM-UI-003 | P0/P1 | airbox/3D | brak FDM air/void extent i jawnego magnetic support w działającym render path | `BoundsLayers.tsx`, `Viewport3DScene.tsx`, `viewport3DTargets.ts` | P0: zakres gridu widoczny; P1: universe > magnetic object ma czytelny overlay/legend i target |
| FDM-UI-004 | P1 | Explorer | unconditional Airbox/FEM Mesh subtree | `buildModelTree.ts:918-1020,1172-1292` | FDM tree pokazuje Grid/Mask; FEM tree pokazuje shared topology |
| FDM-UI-005 | P1 | Mesh Inspector | FEM element stats/policy/build dla FDM | `MeshDetailsPanel.tsx`, `useMeshDetailsModel.ts` | FDM inspector nie renderuje tetra/SICN/hmax; pokazuje grid metrics |
| FDM-UI-006 | P1 | Airbox Inspector | `hmax/hmin/growth/curvature/grading`, shared-domain command | `AirboxMeshParametersPanel.tsx`, `airboxMeshPolicyDraft.ts` | FDM Airbox/Grid panel ma tylko semantykę grid/mask; FEM zachowuje mesh policy |
| FDM-UI-007 | P1 | Object/Region | Gmsh/FEM order/tetra/prism controls dla FDM | `ObjectMeshPolicyPanel.tsx`, `ObjectRegionMeshPanel.tsx` | adapter domain capability + separate FDM grid policy |
| FDM-UI-008 | P1 | Visualization Inspector | selected carrier/quantity/vector lookup tylko przez FEM manifest | `ObjectVisualizationPanel.tsx`, model/controller | FDM grid/cell/region target rozwiązywalny i revision-aware |
| FDM-UI-009 | P1 | interactions | flat catalog, no lane capability, missing FDM demag | `interactions.ts`, `PhysicsInteractionPanel.tsx`, ribbon | capability-scoped options, FDM convolution round-trip |
| FDM-UI-010 | P1 | execution | arbitrary backend/device/precision/mode, no resolved provenance | `StudyInspectorPanel.tsx`, runtime schema/model | fail-closed validator + durable requested/resolved/fallback |
| FDM-UI-011 | P1 | commands | static `Build FEM Mesh`, coarse gates | `ribbonContributions.tsx`, runtime contributions | neutral/capability label and disabled reason per lane |
| FDM-UI-012 | P2 | selection | no FDM cell ref; breadcrumb/registry fallbacks | `selectionTypes.ts`, `explorerSelection.ts`, registry | `fdm-cell` selection with `(i,j,k)`/fingerprint and exact Inspector |
| FDM-UI-013 | P2 | lifecycle | FEM topology freshness assumptions for FDM | `regionMeshLifecycle.ts`, runtime resources | separate FDM grid/mask lifecycle and revision invalidation |
| FDM-UI-014 | P2 | stage commands | eigen/frequency/FFT commands enabled without lane proof | `studyRuntimeCommandContributions.ts:1671-1994` | capability matrix controls availability and explanation |
| FDM-UI-015 | P2 | accessibility/UX | unsupported states look like empty/failed data; units/provenance unclear | panels/controllers/tree | status, reason, units, keyboard target and screen-reader labels |
| FDM-UI-016 | P1 | field map | planar probe omits scope/snapshot/revision; transferred occupancy mask is detached before hover | `FieldMapModule.tsx:82-121`, `PlanarSurface.tsx:82-154` | probe/raster share scope and revision; empty pixel remains empty after worker render |
| FDM-UI-017 | P2 | topography | FDM-only topography is statically unavailable in one surface and ungated in another | `ribbonTabViews.tsx:927-935`, `ribbonContributions.tsx:1808-1879` | capability-gated FDM control with explicit FEM not-applicable reason |

## 10. Docelowa architektura UI

### 10.1 Zasada

Nie tworzyć „FDM workspace” i „FEM workspace”. Zostawić jeden workspace/ribbon/viewport, ale wszystkie moduły dostają `ResolvedDomainAdapter` i `CapabilitySnapshot`. Moduł nie może importować FEM-owego resource tylko dlatego, że node nazywa się Mesh.

### 10.2 Minimalne typy domenowe

```ts
type DomainPresentation =
  | {
      discretization: "fdm";
      grid: StructuredGridDescriptor;
      membership?: FdmRegionMembershipResource;
      airbox: { kind: "universe-outside-magnetic-support"; bounds: Bounds3 } | null;
    }
  | {
      discretization: "fem";
      manifest: FemManifestResource;
      topology: FemTopologyResource;
      airbox: { kind: "shared-domain-airbox"; parts: MeshPart[] } | null;
    };
```

`airbox` musi być opcjonalne w obu wariantach. Brak airboxa w FDM nie jest błędem, a jego obecność nie oznacza FEM.

### 10.3 Capability snapshot

Capability resource powinien zwracać dla każdej operacji:

```text
state: supported | semantic_only | deferred | unsupported | stale
reason: kod + komunikat dla użytkownika
requires: resource/revision/capability
resolved: backend/device/precision/mode
```

Operacje obejmują co najmniej: grid build, shared mesh build, field quantity, vectors, surface coloring, air/void overlay, region membership, hover/select cell, exchange, demag, DMI/SOT/STT/Oersted/thermal, eigen/frequency/FFT i każdy stage command.

### 10.4 Jednolity rendering contract

`FdmGridRenderModel` i `FemTopologyRenderModel` powinny implementować wspólny interfejs render targetów, ale nie wspólne dane elementowe:

- `bounds`, `displayBudget`, `selection`, `field compatibility`, `diagnostics`, `provenance` są wspólne;
- FDM dostarcza cells, `(i,j,k)`, mask state, grid fingerprint, cell-centered field;
- FEM dostarcza elements, nodes, element family, mesh part, boundary face, topology fingerprint.

## 11. Docelowa informacja w Explorerze i Inspectorze

### 11.1 FDM bez airboxa (universe = magnetic support)

```text
Domain (FDM)
├── Grid
│   ├── Dimensions
│   ├── Spacing & Origin
│   ├── Active cells / Mask
│   └── Build & Provenance
├── Objects / Regions
├── Visualization
└── Fields / Quantities
```

Brak `Airbox > Mesh` i brak tetra/SICN/element quality. Jeśli użytkownik kliknie stary alias FEM, panel powinien pokazać „Not applicable for FDM structured grid” z linkiem do Grid.

### 11.2 FDM z universe większym od ferromagnetyka

```text
Domain (FDM)
├── Grid
├── Magnetic support
├── Universe outside magnetic support (Air/Void)
├── Active / Unassigned / Inactive cells
├── Mask & Provenance
└── Visualization
```

Air/Void ma bounds, count, legend i opacity/wireframe controls adekwatne do komórek/obszaru. Nie ma `hmax`, `tet4`, `boundary faces` ani „shared-domain build”.

### 11.3 FEM

Dotychczasowa sekcja shared-domain może zostać, pod warunkiem że jest renderowana wyłącznie dla `discretization=fem` lub `explicit_topology=true` i ma requested/resolved/capability state.

## 12. Plan remediacji

### P0-A — naprawa wizualizacji 3D meshu/gridu (pierwsza kolejność)

To jest pierwszy sprint i blokada dla dalszych warstw UI:

1. **Candidate w working tree, do domknięcia:** utrzymać codec FDM dla aktualnego v2 (`version=2`, `kind=2`) z testem produkcyjnego headera; legacy v1 może pozostać jawnie kompatybilne.
2. Zastąpić fallback „renderuj cały authored grid” stanem `membership unavailable/stale/error` albo bezpiecznym renderem z wyraźnym degraded markerem — nigdy cichym udawaniem aktywności.
3. **Częściowo zaimplementowane:** utrzymać encoding-aware classifier dla `active`, `inactive`, `unassigned`, region i air/background oraz dodać testy wszystkich stanów.
4. Zbudować niezależny `FdmGridRenderModel` oraz `FemTopologyRenderModel`, wspólne tylko na poziomie bounds/display budget/selection/provenance.
5. Dodać FDM magnetic-support/air/void overlay dla universe > ferromagnetyk oraz spójny `fdm-domain` target.
6. Odłączyć field/vector demand od `fieldCompatibleTopologyRenderModel` i potwierdzić render nonuniform FDM field.
7. Uruchomić browser smoke/screenshot: canvas visible, `gl.isContextLost() === false`, drawing buffer `> 0 × 0`, grid/mask/air extent widoczne.

**Gate P0-A:** bez tego nie uznajemy wizualizacji FDM za działającą, nawet jeśli TypeScript i testy jednostkowe są zielone.

### P0-B — kontrakt i obserwowalna ścieżka danych

1. Zdefiniować dyskryminowany `DomainPresentation`/`CapabilitySnapshot` w centralnym resource layer.
2. Utrwalić revision/fingerprint/freshness w każdym render target.
3. Rozdzielić field/vector demand plan od `fieldCompatibleTopologyRenderModel`; FDM ma grid-compatible field model.
4. Ujednolicić target kind (`fdm-domain`, nie generyczne `object`) i selection bounds.

**Gate:** testy danych i viewportu przechodzą na fixture FDM bez manifestu FEM; każdy brak/stan stale jest widoczny jako diagnostyka.

### P1 — Explorer, Inspector i zarządzanie mesh/grid/airbox

1. Dodać grid/mask Inspector i zastąpić FEM-only sekcje w `MeshDetailsPanel`, `Airbox*`, object/region panels.
2. Przebudować `MeshBuildDialog` na adapter domain: FDM grid/mask refresh vs FEM shared-domain build.
3. Dodać FDM Explorer nodes i exact registry/selection types.
4. Zachować opcjonalny FDM airbox jako rolę gridu, gdy universe > magnetic support; nie tworzyć drugiej FEM-owej topologii.

**Gate:** fixture FDM z i bez airboxa nie pokazuje żadnej FEM-only sekcji ani komendy shared-domain.

### P2 — interakcje, ribbon i provenance

1. Rozszerzyć capability catalog o backend/device/precision/mode/operator.
2. Wpiąć go w `PhysicsInteractionPanel`, ribbon, stage commands i global/stage validators.
3. Dodać FDM `multilayer_convolution` do canonical selectora; FEM-only policy ma jawny stan.
4. W Study/Runtime wyświetlać requested + resolved + fallback po wykonaniu i po odświeżeniu.
5. Zastąpić statyczne `Build FEM Mesh` neutralnym/adaptacyjnym label.

**Gate:** FDM/FEM matrix tests i round-trip DSL/UI/API są zgodne; unsupported nie da się zapisać jako aktywna opcja.

### P3 — UX, accessibility i wydajność

1. Dodać statusy `supported`, `not applicable`, `deferred`, `stale`, `not materialized`, z kodem przyczyny.
2. Ujednolicić jednostki SI i nazwy: `cell spacing [m]`, `origin [m]`, `cells`, `elements` tylko dla FEM.
3. Ograniczyć render przez display budget/stride/decimation bez zmiany jakości domyślnej; pełny mesh/grid nadal musi być dostępny w danych.
4. Zapewnić keyboard focus, selection announcement i tooltip z provenance/revision.
5. Dodać testy hydration/store snapshot oraz lifecycle WebGL.

### P4 — kwalifikacja browser/scientific

1. Browser smoke: canvas widoczny, `gl.isContextLost() === false`, drawing buffer `> 0 × 0`.
2. Screenshot proof FDM bez/ z airboxem, quantity switch, wireframe/points, clipping i hover.
3. Porównać identyczny payload i czas dla FDM/FEM tylko tam, gdzie kontrakt fizyczny przewiduje wspólną obserwablę; nie mieszać proof UI z kwalifikacją solvera.

## 13. Macierz testów akceptacyjnych

| Scenariusz | Oczekiwany Explorer/Inspector | Oczekiwany viewport | Oczekiwane guardy |
|---|---|---|---|
| FDM, universe = magnetic support | Grid, dimensions, spacing, mask; brak Airbox Mesh FEM | grid/cells, field/vector jeśli resource dostępny | brak `hmax`, tetra, SICN, shared-domain |
| FDM, universe > magnetic support | Grid + Magnetic support + Universe outside support/Air-Void | czytelny extent universe i legenda maski | airbox nie używa element policy |
| FDM active ID `0` | active/unassigned widoczny jako stan | komórki ID 0 nie znikają | `u32::MAX` inactive nie renderuje się jako region |
| FDM region IDs > 0 | region legend i object/region selection | selection `(i,j,k)`, region id | revision/fingerprint zgodne |
| FEM shared-domain | obecne mesh parts, element families, quality/topology | magnetic/airbox/interface layers | FEM-only policy dozwolona |
| FDM status + stale mask | jawny stale/degraded banner | brak cichego pustego renderu | build/refresh command z reason |
| quantity switch FDM | dostępne quantities zależne od capability | field color/vector demand nie wymaga FEM manifestu | unsupported wyjaśnione |
| hover → click FDM cell | exact `fdm-cell` Inspector | highlight tej samej komórki | grid fingerprint + cell ordinal |
| FDM/FEM requested vs resolved | oba w Study/Runtime/provenance | status overlay nie ukrywa fallback | legalność macierzy przed commit |
| interaction menu FDM | tylko supported/deferred z reason | — | brak FEM-only write |
| eigen/frequency unsupported | disabled/not-applicable z powodem | — | status `eigen_modes=false` respektowany |
| SSR/hydration i reload | stabilne drzewo/selection | brak flashu FEM przed FDM snapshotem | server snapshot/explicit hydration gate |
| WebGL lifecycle | — | canvas visible, context not lost, buffer non-zero | smoke/E2E required |

Minimalny fixture contract powinien zawierać oba FDM warianty, FEM shared-domain oraz payload z `schema_version`, `encoding`, `active_mask`, `region_legend`, `grid_fingerprint`, `requested/resolved` i stale revision. Obecne testy Airbox/MeshBuild są prawie wyłącznie FEM; trzeba dodać prawdziwe FDM fixtures, a nie tylko ustawić `discretization: "fdm"` w transporcie.

## 14. Inwentaryzacja dowodów

### Viewport i render

- `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts:44-65,78-130`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2351-2445,2627-2634,2952-3105,3295-3527,3625-3840,3891-3938`
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx:727-741,931-1003`
- `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx:750-812,909-973,1025-1084`
- `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts:11-19,53-185,193-241`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts:63-72,284-324`
- `apps/control-room/src/modules/viewport-3d/viewport3dInspect.ts:33-91`
- `apps/control-room/src/kernel/selection/selectionTypes.ts:214-284`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:713-731`
- `apps/control-room/src/modules/field-map/FieldMapModule.tsx:82-121`
- `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx:82-154`
- `apps/control-room/src/modules/field-map/renderer/planarColorizer.ts:27-38`

### Explorer i Inspector

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts:918-1020,1172-1308,1387-1404`
- `apps/control-room/src/modules/explorer/explorerTypes.ts:15-205,421-440,503-510,558-580`
- `apps/control-room/src/modules/explorer/explorerSelection.ts:108-117,222-239`
- `apps/control-room/src/modules/explorer/ExplorerModule.tsx:144-186,257-274,322-411`
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx:492-496,712-735,779-788`
- `apps/control-room/src/modules/inspector/inspectorDescriptor.ts:112-146`
- `apps/control-room/src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts:70-77,308-356,416-455,486-566`
- `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx:27-109,118-260`
- `apps/control-room/src/modules/inspector/panels/mesh-details/MeshOverviewSection.tsx:39-78,101-132,153-195`
- `apps/control-room/src/modules/inspector/panels/MeshQualityStatisticsView.tsx:257-276,308-320`

### Airbox, object mesh i region

- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx:58-94,204-292`
- `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts:7-31,48-73,99-203`
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshOverviewPanel.tsx:54-72`
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshQualityGatesPanel.tsx:28-40`
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshStatisticsPanel.tsx:40-78`
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshTopologyPanel.tsx:25-44`
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.tsx:29-92`
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts:18-87,101-200,240-345`
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx:316-334,338-444,465-511,596-648,935-1012`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts:18-24,451-460,815-839,893-900`
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx:42-128`
- `apps/control-room/src/shared/domain/mesh/regionMeshLifecycle.ts:15-28,52-64,111-137`

### Physics, capability i runtime

- `apps/control-room/src/shared/domain/physics/interactions.ts:23-52,69-110,276-295,334-384,463-498`
- `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx:104-190,350-406,450-471`
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:199-209,294-305,447-479,515-522`
- `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts:1438-1472`
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx:1059-1100,1389-1498`
- `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts:8-20,83-84,105-143,138-142,308-342`
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts:1572-1582,1838-1852`
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts:216-331,365-426`
- `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts:424-476,1671-1711,1848-1994`
- `crates/fullmag-api/src/schemas/status.rs:56-74,151-165`
- `crates/fullmag-api/src/schemas/runtime.rs:58-77`
- `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs:167-186,228-239`
- `crates/fullmag-api/src/schemas/mesh.rs:193-224,923-985`
- `crates/fullmag-api/src/schemas/domain.rs:10-52`
- `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts:6-65`
- `crates/fullmag-runner/src/fdm/artifacts.rs:68-83`
- `crates/fullmag-api/src/router_v2/handlers/data/fdm_region_membership.rs:147-169,214-228,251-386`
- `apps/control-room/src/modules/ribbon/ribbonTabViews.tsx:927-935`
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:1808-1879`

## 15. Otwarte blokery i decyzje

1. Brak drugiego pliku obrazu z podanej ścieżki Windows; do wizualnego porównania trzeba dołączyć go ponownie.
2. Brak live FDM session payloadu i browser E2E w tym audycie; potrzebny fixture lub uruchomienie Control Room do P4.
3. Trzeba rozstrzygnąć w kontrakcie, czy „airbox” w FDM jest nazwą fizyczną `universe outside magnetic support`, czy wyłącznie prezentacyjnym overlayem. Audyt rekomenduje zachować nazwę fizyczną z jawnie innym `kind` niż FEM airbox.
4. Trzeba potwierdzić pełną macierz legalności interakcji FDM dla CPU/GPU, precision i mode w capability API; UI nie powinno jej rekonstruować z listy stringów.
5. Nie należy zamykać żadnego findingu na podstawie samego TypeScript/test pass. Dla viewportu wymagany jest browser smoke, dla runtime — executed-device evidence, a dla solvera — osobna kwalifikacja naukowa.

## 16. Definition of done dla tego audytu

Ten dokument jest kompletnym audytem diagnostycznym i nie deklaruje naprawy. Audyt uznaję za zamknięty, gdy:

- każdy wskazany obszar ma dowód path+line oraz severity;
- airbox FDM został jawnie zachowany jako wymagany wariant, gdy universe > magnetic support;
- oddzielono UI/source proof od browser/runtime/scientific qualification;
- opisano docelowy adapter, IA, fazy remediacji i acceptance matrix;
- precyzyjnie wskazano brakujące zasoby, testy i provenance.

Implementacja jest osobnym zadaniem i powinna rozpocząć się od P0 (`DomainPresentation`, encoding-aware FDM membership i odcięcie field demand od FEM topology), następnie przejść przez viewport, Explorer/Inspector, interakcje/ribbon i dopiero na końcu browser/scientific qualification.

W praktyce pierwszym warunkiem wejścia w tę implementację jest **P0-A: działający, zweryfikowany browserowo render 3D meshu/gridu i maski**. Bez niego poprawianie samych Inspectorów nie rozwiązuje zgłoszonego problemu.
