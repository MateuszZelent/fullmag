# Audyt UI symulacji FDM/FEM: wizualizacja, Explorer, Inspector, interakcje i mesh/airbox

**Data:** 2026-08-04  
**Zakres:** `apps/control-room`, kontrakt v2 API/OpenAPI, adaptery domeny, zasoby mesh/grid, runtime capabilities oraz istniejące testy.  
**Status:** audyt + implementacja P0–P3 w working tree; świeży audytowy bundle
`.next-audit` (controlled fixture `:3123`, real API `:3124`) przeszedł dwa
niezależne controlled browser/WebGL smoke oraz real-API probe dla
canvas/WebGL/FMVP/auto-fit, kolorowanego meshu, colorbara, shaderów i glyphów.
Frontend `:3100` po HMR/odświeżeniu przechodzi ten sam real-API probe; live API
`:8081` nadal jest starszym runtime bundlem (v1, unresolved), membership/air-void
artifactu brak, a kwalifikacja naukowa pozostaje osobną bramką. Ostatnia
weryfikacja: 2026-08-05.

W dalszych sekcjach „brak” oznacza stan bazowy znaleziony podczas audytu. Zmiany
wdrożone w bieżącym working tree są oznaczone jako częściowo zamknięte; nie są
uznawane za produkcyjnie zakwalifikowane bez testu HTTP/browser/WebGL.

## 0. Streszczenie wykonawcze

Obserwacja użytkownika jest potwierdzona w kodzie. Problem nie ogranicza się do etykiet w zakładce Mesh — **najpilniejszym blockerem jest brak wiarygodnej wizualizacji 3D meshu/gridu**. UI posiada częściową ścieżkę renderowania FDM, ale większość modelu informacji, zarządzania drzewem, selekcji, Inspectorów i komend nadal zakłada **FEM-owy shared-domain mesh**. W efekcie FDM może dostać panel z parametrami `hmax/hmin`, wzrostem elementu, krzywizną, tetra/pyramid, jakością SICN i budowaniem shared-domain, mimo że jego źródłem prawdy jest regularna siatka strukturalna `shape × origin × spacing` oraz maska przynależności komórek.

Najważniejsze ustalenia:

1. **P0 — wizualizacja 3D meshu/gridu ma zamknięty controlled-fixture gate oraz frontend live proof.** `FdmGridRenderDomain` i `FdmCuboidLayer` mają rozłączny lane FDM, mapowanie pól z kontrolą kardynalności oraz izolację od starej topologii FEM. Browser smoke pobiera FMVP v2 `12×8×2×3`, pokazuje colorbar, shader i glyphy, a WebGL context/drawing buffer są prawidłowe. Świeży audytowy bundle przeciwko live API pokazał 4096-komórkowy grid, aktywny FMVP i kamerę dopasowaną do bounds; dwa powtórzenia zakończyły się kodem `0`, z niezerowym delta shadera i glyphów. Membership/air-void i revision-safe identity pozostają osobnymi gate’ami.
2. **P1 — Explorer buduje FEM-owe drzewo niezależnie od dyskretyzacji.** Dla zwykłego FDM nadal pojawia się `Airbox > Mesh > Parameters/Quality Gates/Statistics/Topology/Build & Provenance`, a korzeń Mesh i komenda nazywają się shared-domain/FEM. W snapshotach drzewa brakuje descriptoru FDM, shape, spacing, maski i requested/resolved execution.
3. **P1 — baseline Inspectorów był FEM-owy.** W bieżącym drzewie dodano rozgałęzienia FDM Grid/Mask oraz stany not-applicable dla paneli FEM, ale Airbox mesh pozostaje panelem FEM i musi być jawnie odseparowany od FDM universe/void overlay.
4. **P1 — FDM airbox/uniwersum nie ma osobnego modelu semantycznego.** Airbox może być prawidłowy dla FDM, gdy universe jest większy od ferromagnetyka, ale obecny model zna tylko cały grid albo FEM-owe `airboxParts`. Nie rozróżnia konsekwentnie magnetic support, aktywnej komórki, komórki nieprzypisanej i inactive/background.
5. **P0/P1 — codec/maska są naprawione źródłowo/testowo; membership live proof pozostaje otwarty.** Codec obsługuje v2/kind 2, legacy v1 i sentinel `u32::MAX`; ID `0` pozostaje aktywne/unassigned. Live API zwraca poprawny structured-grid/FMVP, ale descriptor membership daje `204`, a binary artifact jest `404`; controlled smoke dowodzi ścieżki pola, lecz nie zastępuje live membership/air-void qualification.
6. **P1 — capability/provenance mają lane-aware implementację i stabilne reason codes.** FDM demag, ribbon/Study, authored/effective/resolved rows oraz `reason_code` są w kontrakcie; pełna macierz wykonania CPU/GPU/precision/mode i scientific qualification pozostają osobnymi gate’ami.

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

W ramach pierwszego audytu nie wykonano jeszcze pełnej kwalifikacji hover/click
oraz fizyki solvera. W toku remediacji wykonano jednak browser smoke na świeżym
frontendzie przeciwko rzeczywistemu live API: canvas jest obecny, WebGL context
nie jest utracony, drawing buffer jest niezerowy, FMVP pola jest załadowany, a
kamera FDM dopasowuje się do bounds. Nadal nie wykonano kwalifikacji fizycznej
solvera ani nie potwierdzono, że bieżące pole pochodzi z konkretnego urządzenia.

Wnioski oznaczone jako „źródło/test” są dowodem implementacyjnym. Browser
proof core path został wykonany, ale nie oznacza jeszcze kwalifikacji live
membership/air-void, hover/click ani fizyki solvera.

### 1.1. Bieżący working tree — implementacja i kwalifikacja controlled fixture

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

To zamyka podfragment decode/classification. Bieżący viewport ma już
`fdmLaneActive`, rozłączny render FEM/FDM, FDM field-index resolver oraz
fail-closed status dla niezgodnej kardynalności. Controlled browser smoke
zamyka ścieżkę FDM field → shader/vector/colorbar, ale nie zastępuje live
membership/air-void proof ani runtime/scientific qualification.

### 1.2. Weryfikacja endpointów API v2 (2026-08-04/05)

Sprawdzono nie tylko komponenty React, ale cały kontrakt danych używany przez
viewport. Kluczowy endpoint to:

```text
GET /v2/sessions/current/data/fields/{quantity_id}/samples/vector
    ?component=full&scope_kind=full[&max_samples=N]
```

| Zasób | Wynik audytu |
|---|---|
| `/v2/sessions/current/data/domain/meta` | FDM zwraca `discretization=fdm`, shape/origin/spacing/bounds; obsłużono także metadata-only `execution_plan.backend_plan.grid.cells`. |
| `/v2/sessions/current/status` | FDM domain generation/topology revision nie dziedziczą starego FEM mesh. |
| `/v2/sessions/current/data/domain/topology` | Dla jawnego FDM zwraca `204`, także gdy snapshot zawiera odziedziczony FEM mesh. |
| `/v2/sessions/current/data/domain/slice/mesh-overlay` | Dla jawnego FDM zwraca `204`; overlay FEM nie przecieka do FDM. |
| `.../fields/{quantity_id}/samples/vector` | Pełne FDM wymaga kardynalności równej iloczynowi aktywnego gridu; dodatni `max_samples` jest dla FDM ignorowany, więc endpoint zwraca kompletny cell-centered FMVP v2 zamiast nieadresowalnego downsampled payloadu. Stary FEM topology hash jest wyłączony w FDM. FEM nadal próbuje przez FMVP v3 z indeksami węzłów. |

Dowody testowe:

- wcześniejszy in-process router v2 run — 509 testów passed, w tym regresje pełnego FDM i izolacji starej topologii; 3 pozostałe failures były niezwiązane z FDM (transport/tabela);
- `v2_field_vector` — 17 passed;
- `fdm_domain_endpoints_ignore_reused_fem_topology` — 1 passed;
- `metadata_material_fields_use_canonical_preview_quantity_ids` — 1 passed;
- `python_waveguide_box_region_ms_override_changes_backend_mat_ms_mean` — 1 passed po dodaniu fallbacku do `execution_plan.backend_plan.grid.cells`;
- `v2_fdm_vector_ignores_max_samples_when_preview_would_be_downscaled` — regresja obejmuje dodatni `max_samples`, wymaga pełnych 4 komórek i przechodzi po uzupełnieniu niezwiązanego konstruktora `MagnetIR` o opcjonalne `absorbing_boundary: None`;
- frontend field/indexing/viewport focus — 242 passed w 8 plikach, typecheck passed.

Pozostają dwa jawne kontraktowe residuale P1. Po pierwsze, pełny FDM FMVP v2
nie niesie w swoim body `grid_fingerprint` ani mapy komórek; odpowiedź ma
`x-fullmag-domain-generation-id`, ale frontend nadal powinien wiązać tę
tożsamość z aktualnym `DomainMeta.grid`, a nie tylko z kardynalnością. Po
drugie, scope `airbox/object/part` nadal opiera się na FEM membership i nie
jest jeszcze ogólnym FDM structured-grid scope. `fdm_multilayer` wymaga
osobnego classifier/layout contractu; nie jest jeszcze kwalifikowany jako
zwykły `fdm`.
To są testy in-process/static, kontrolowany browser fixture oraz osobny live
frontend smoke. Bridge przeglądarki zgłaszał `sandboxCwd is not a local file URI`,
więc live proof wykonano przez izolowany headless Playwright na świeżym bundlu,
bez utożsamiania go z kwalifikacją solvera. Kontrolowany smoke Playwright
`screenshot:viewport-3d` zakończył się kodem `0` i wykazał:

```text
FMVPv2 12x8x2x3, magnitude=0.550000..1.000000
shader=2668/7416, vectors=31/7416 (świeży `:3123`; aktualny `:3100` po HMR:
1784/7416)
projection deltas=2305/329/2276, topologyRequestsAfterSwitch=0
WebGL context not lost, non-zero drawing buffer
```

Źródłowa przyczyna zgłoszonego pustego viewportu miała dwa elementy: predykat
nieaktywnego Field Map wstrzymywał cały prefiks `/data/fields/`, w tym request
3D vector, a domyślna kamera FEM-scale nie obejmowała nanoskalowego FDM gridu.
Resource runtime zachowuje teraz oczekujące load intents i niezależne leases
pauzy, a scena dopasowuje domyślną kamerę do FDM bounds także po przełączeniu
aktywnej kamery Three.

Live API zostało odczytane osobno i jest spójne dla podstawowej ścieżki pola:

```text
GET /data/domain/meta → discretization=fdm, shape=[128,32,1], cells=4096,
  bounds=[-2.5e-7,-6.25e-8,-1.5e-9]..[2.5e-7,6.25e-8,1.5e-9]
GET /data/domain/topology → 204 (prawidłowe dla structured FDM)
GET /data/fields/m/meta → vector_field, 3 components, finite stats,
  domain_generation_id zgodne z DomainMeta
GET /data/fields/m/samples/vector?component=full&scope_kind=full → 200,
  `FMVP;version=2`, 4096 points × 3 components (12 288 values, 98 352 bytes),
  all values finite, `x-fullmag-domain-generation-id` zgodne z DomainMeta
```

Jednocześnie live API nadal pochodzi z `runtime_bundle_version=2026-08-04`,
ma `active_lane.schema_version=v1` z `resolved=null`, brak mu artefaktu
`mesh/fdm_region_membership.v1/v2.json` (descriptor `204`, binary `404`), a
zapisany `visualization/state` ma `viewport_colorbar_visible=false`,
`vectors_visible=false` i kamerę FEM-scale `[2e-6,1.4e-6,2e-6]`. Brak colorbaru
i glyphów w tym konkretnym live zrzucie jest więc stanem zapisanej konfiguracji,
nie dowodem pustego FMVP; controlled fixture na świeżym audytowym bundle
przechodzi shader/colorbar/vector gate w dwóch kolejnych uruchomieniach. Do
zamknięcia live gate potrzebny jest restart
backendu z aktualnym bundlem, membership/air-void artifactem i powtórzenie tej
samej sesji. Dodatkowy probe aktualnego `:3100` z tymi ustawieniami zmienionymi
wyłącznie w pamięci (`magnitude`, `viewportColorbarVisible=true`,
`vectorsVisible=true`) pokazał `Rendered range`, `data-fdm-vector-segment-count=1200`
oraz HUD `vector-glyph:full:complete`; nie jest to zapis trwały i nie zastępuje
restartu runtime. Na świeżym audytowym bundle `:3124`, z tym samym live API,
porównanie zrzutów `vectors=false/true` wykazało `1697` zmienionych pikseli na
`1 296 000`, a zrzut pokazuje gęstą warstwę glyphów nad FDM slabem.

Źródłowy backendowy residual provenance również został naprawiony: syntetyczny
terminal `StepUpdate` przechodzi teraz przez wspólną ścieżkę publikacji pola, więc
`latest_fields.m` otrzymuje magnetyzację końcowego kroku oraz `source_step`/
`source_revision` zamiast pozostawać przy preview `0/1`. Test regresyjny z
uprzednio zachowanym polem `source_step=0` potwierdza zamianę na krok `342`
(`cargo test -p fullmag-cli orchestrator::tests::synthetic` — 4 passed;
`publish_live_step_update` — 3 passed). Działający proces API nie został przez
to automatycznie przebudowany ani zrestartowany, więc na starym runtime nadal
można zobaczyć `0/1`.

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

### 3.2 P0: field/vector demand — baseline FEM gate i bieżąca korekta

Baseline rzeczywiście uzależniał `primaryFieldVectorEnabled` i część demand od
`fieldCompatibleTopologyRenderModel`. W bieżącym drzewie ten gate pozostaje
FEM-only dla topology/chunked renderu, ale FDM ma osobny lane:

- `useViewport3DSceneModel.ts` wyznacza `fdmLaneActive` z `DomainMeta`, odcina
  FEM `AirboxLayer`/`TopologyMeshLayer` i nie pobiera topology jako warunku FDM;
- FDM primary demand używa `fdm-domain`, a `buildFdmSampledScalarColors` i
  `buildFdmFieldIndexResolver` mapują dane po komórkach/indexach;
- `field_resolution.rs` wymaga dla snapshotu FDM liczby punktów równej
  iloczynowi aktywnego gridu, a `fields.rs` nie emituje FEM topology hash dla
  FDM;
- brak lub niezgodność resource daje jawny `FDM field degraded: ...`, a nie
  ciche rysowanie po kolejności FEM.

Pozostają dwa ograniczenia: przejście FEM→FDM może mieć krótkie okno ładowania
starego cache przed rozstrzygnięciem `DomainMeta`, a FDM FMVP v2 nie niesie
pełnej tożsamości gridu. To nadal wymaga browser smoke i docelowego FDM FMVP v3.

**Kryterium P0 wizualizacji:** dla identycznego FDM statusu i quantity selectorów UI musi:

1. pobrać właściwy field resource bez obecności FEM manifestu;
2. zastosować grid/mask do tej samej komórkowej domeny;
3. zbudować wektory/kolorowanie/topography z jawnie podanym `cell_count` i jednostką;
4. pokazać unsupported/degraded, gdy resource nie istnieje — nie wyciszyć żądania.

Przed przejściem do Explorer/Inspector wymagany jest również test geometrii: niezerowy FDM grid z maską ma być widoczny jako właściwy zakres komórek, a nie jako pusty viewport i nie jako pełny box po błędzie membership.

Weryfikacja live wykazała dodatkowy frontendowy blocker skali: zapisany stan
kamery `[2e-6,1.4e-6,2e-6]` był poprawnym historycznie defaultem FEM, ale dla
live FDM bounds rzędu `5e-7 m` ustawiał grid jako prawie niewidoczny pasek.
Scena ma teraz deterministyczny `effectiveCameraState`: niezmieniony default
jest zastępowany fit-em bounds, a jawna pozycja użytkownika pozostaje
autorytatywna. Świeży audytowy bundle potwierdził pozycję
`[7.215557e-7,5.195201e-7,7.215557e-7]`, canvas/WebGL i 4096 instancji FDM.

Kolejna repro na świeżym bundlu ujawniła dwa dodatkowe błędy GPU, które
wyjaśniały sytuację „dane są w HUD, ale mesh jest tylko szary/pusty”:

1. Po pojawieniu się bufora kolorów `InstancedMesh` był rekonstruowany przy
   niezmienionym kluczu `model.count`. Nowa instancja zachowywała macierze
   jednostkowe, więc wszystkie komórki wypadały z nanoskalowego kadru. Klucz
   `fdmCuboidSurfaceMeshKey(count, colorMode)` oraz zależność uploadu macierzy
   od tej tożsamości wymuszają ponowne wgranie transformacji do właściwej
   instancji.
2. `MeshBasicMaterial` z `vertexColors` używa jednocześnie atrybutu koloru
   wierzchołka i `instanceColor`. `BoxGeometry` nie miała regularnego atrybutu
   `color`, przez co shader mnożył kolory instancji przez domyślną czerń.
   Geometria FDM dostaje teraz neutralny atrybut `(1,1,1)`.

3. FDM `VectorFieldLayer` nie miał opcjonalnego `buildKey`, więc worker
   publikował ukończony wynik z kluczem `null`, a warstwa porównywała go z
   `undefined` i odrzucała jako niewidoczny. Klucz jest teraz normalizowany do
   `null` przed porównaniem; wynik bez cache reference może zostać zamontowany
   po zakończeniu workera.

Po tych zmianach świeży audytowy bundle (dwa kolejne uruchomienia na `:3123`)
przeszedł browser smoke: `FMVPv2 12×8×2×3`, shader `2668/7416`, glyphy
`31/7416`, projekcje bez ponownego żądania topology i niezerowy canvas/WebGL.
Na realnym live API świeży bundle `:3124` dał dodatkowo `1200` segmentów,
`vector-glyph:full:complete` i `1697/1 296 000` zmienionych pikseli przy
przełączeniu glyphów off/on.
Zapisany stan live początkowo nadal ma wektory i colorbar wyłączone, więc UI nie
powinno traktować tego jako automatycznie włączonego layeru. Przy FDM wektory są cell-centered i mieszczą się wewnątrz
nieprzezroczystych cuboidów; warstwa używa teraz jawnego `renderOnTop` z
`depthTest=false/depthWrite=false`, aby glyphy nie znikały za powierzchnią.
Osobny screenshot z poprawką koloru pokazuje pełny czerwono-pomarańczowy FDM
slab zamiast szarego paska. To jest kwalifikacja renderera frontendowego; nie
jest jeszcze dowodem świeżości pola solvera ani poprawności naukowej. W live API
`m` ma `field_revision=2`, `source_step=0`, podczas gdy status ma
`solver_steps=342` i `field_revision=16`; transport jest poprawny, ale
final-state provenance starego runtime pozostaje niezakwalifikowane.

### 3.3 P1: airbox/void extent FDM nie ma renderera ani targetu

`Viewport3DScene.tsx:956-970` przekazuje do `AirboxLayer` wyłącznie FEM `topologyModel`. `BoundsLayers.tsx:1025-1084` buduje `AirboxMeshPartLayer` z `topologyModel.airboxParts`; przy FDM lista jest pusta. FDM ma tylko `FdmCuboidLayer` i zewnętrzny `DomainBox` (`Viewport3DScene.tsx:727-741`).

`viewport3DTargets.ts:63-72` mapuje FDM domain na generyczny `kind: "object"`, podczas gdy `viewport3DFieldDataPlan.ts:760-780` używa `targetKind: "fdm-domain"`. To dwa niespójne identyfikatory tej samej semantyki.

Airbox w FEM ma dodatkowy kontrakt hidden-edge/interior volume (`BoundsLayers.tsx:750-812,909-973`), którego FDM nie posiada. Przy universe większym od ferromagnetyka nie da się zatem wiarygodnie wskazać: „to jest cały universe”, „to jest magnetic support”, „to jest pusty/air background” i „to jest zakres aktualnie renderowanych komórek”.

**Kryterium P1:** FDM ma jeden jawny `fdm-domain` target oraz osobny, opcjonalny overlay `universe/air/void`, wyliczony z descriptoru i maski. Overlay nie może udawać elementowego airboxa FEM.

### 3.4 P0/P1: v2/maska — poprawka codec/modelu, brak browser proof

W `HEAD` `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts:1-3,29-31` miał stałe `VERSION=1` i `KIND_U32=1`, a `:6-12,14-65` redukował payload do surowych ID i gubił schema/version/encoding. Aktualny runner emituje v2 header/version/kind (`crates/fullmag-runner/src/fdm/artifacts.rs:72-79`), a API preferuje `fdm_region_membership.v2.json` (`crates/fullmag-api/src/router_v2/handlers/data/fdm_region_membership.rs:214-228`).

Bieżący codec zmienia obsługę na v2/2, zachowuje v1 jako legacy i eksportuje
sentinel (`fdmRegionMembershipCodec.ts:1-8,38-88`). `fdmCuboidBuildModel` nie
traktuje już `u32::MAX` jako regionu, a ID `0` pozostaje aktywne/unassigned.
To jest potwierdzone testami modelu, ale nadal nie jest dowodem produkcyjnego
renderu WebGL.

`useViewport3DSceneModel.ts:2370-2386` ustawia `fdmRealizedRegionIds` tylko po udanym decode. Gdy resource ma error, `.data` jest `null`, a `fdmCuboidBuildModel.ts:82-103` przechodzi do fallbacku próbkowania całego authored gridu. To nie jest neutralne degraded state: bez udowodnionej polityki błędu inactive/outside cells mogą zostać wizualnie potraktowane jak aktywne komórki. Błąd trafia głównie do diagnostyki (`useViewport3DSceneModel.ts:4022-4031`), więc nadal potrzebny jest browser test i jawny degraded marker.

Należy zachować kompatybilność v1 tylko wtedy, gdy jest to jawnie potrzebne, ale v2 musi być pierwszorzędnym kontraktem i mieć test fixture z aktualnym headerem.

Historyczny filtr `regionId > 0` został usunięty; poniższa uwaga opisuje
znaleziony baseline bug i pozostaje jako guard regresyjny.

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

### 4.1 P1 baseline: drzewo Airbox/Mesh było unconditional

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

To był stan bazowy. Bieżący builder ma FDM `mesh.grid.*`, membership/provenance
i opcjonalny `universe-outside-support`, a FEM shared-domain nodes pozostają
warunkowane lane. Nadal trzeba zakwalifikować pełny snapshot/realtime Explorera
oraz domknąć wszystkie legacy aliasy.

### 4.2 Baseline: brak semantycznych rodzajów FDM; bieżący tree ma częściową naprawę

Historycznie `ExplorerNodeKind` nie zawierał `mesh.grid`, `mesh.grid.region`,
`fdm.cell` ani dedykowanego registry. Bieżący tree/selection/registry ma te
rodzaje i FDM Grid Inspector; pozostaje test reload/stale identity oraz pełna
kwalifikacja interakcji komórki w browserze.

`explorerSelection.ts:222-239` mapuje wszystkie Airbox nodes na generyczne `{type:"airbox", visualizationTargetId:"airbox"}`. `:108-117` obsługuje tylko `mesh.unassigned.part`; rodzic `mesh.unassigned` nie ma semantycznego panelu. To utrudnia pokazanie różnicy między:

- gridem obliczeniowym,
- regionem obiektu,
- aktywną komórką,
- air/void/unassigned,
- elementem FEM.

### 4.3 P1/P2 baseline: breadcrumbs i panel registry były niespójne

`inspectorDescriptor.ts:112-146` generuje breadcrumb Airbox, a `:124-135` potrafi wyemitować selection kind `object`. Registry ma natomiast exact panel tylko dla `object.root` (`inspectorRegistry.tsx:492-496`), więc część breadcrumbów może otworzyć Placeholder zamiast właściwego inspectora.

W bieżącym registry dodano exact FDM Grid/cell routes oraz poprawiono
`object.root`; `mesh.unassigned` pozostaje osobnym legacy guardem do pełnego
przeglądu. Nie należy utożsamiać go z FDM active-unassigned.

### 4.4 P2: badge i provenance nie mówią, co faktycznie działa

`buildModelTree.ts:1387-1404` pokazuje „Published fields” z `m, H_demag` oraz „Mesh topology” z revision/stale nawet wtedy, gdy FDM nie ma topology manifestu. `explorerTypes.ts:503-510` przechowuje requested backend/device/mode/precision tylko dla Study, nie dla mesh/grid node. Użytkownik nie dostaje więc trwałej informacji:

```text
requested: FDM / GPU / double / strict
resolved:  FDM / CPU / double / extended
fallback:  reason
grid:      revision / fingerprint / freshness
```

## 5. Audyt Inspectorów

### 5.1 Mesh Details — baseline panelu elementowego i bieżący branch FDM

`useMeshDetailsModel.ts:70-77,141-172` odczytuje `domain.discretization` tylko do porównań równości. `:308-356` pobiera shared-domain manifest/report/quality/gates/size-fields/universe report/quality niezależnie od aktywnej reprezentacji. `:416-455` wybiera „worst element” przez FEM `elementIndex`, a `:486-566` komenda zawsze wykonuje `mesh.build-shared-domain`.

`MeshDetailsPanel.tsx:27-109,118-260` domyślnie pokazuje identity, pipeline, mixed topology, policy, quality, size fields, thin-film, shared-domain JSON. `MeshOverviewSection.tsx:39-78,101-132,153-195` mówi o Nodes/Elements/Boundary Faces, min/max/mean edge i mesh parts. `MeshQualityStatisticsView.tsx:257-276,308-320` opisuje tetra-size, edge-length, volume bins i SICN. `MixedTopologyProvenanceSection.tsx:325-405` pokazuje prism/P1/Gmsh/family/facet counts.

Dla FDM te sekcje powinny zostać zastąpione lub oznaczone jako nieaplikowalne. Prawidłowy odpowiednik to m.in. `Nx × Ny × Nz`, `origin_m`, `cell_m`, total/active/inactive/background cells, region legend, mask freshness, grid fingerprint i stride/display budget.

Bieżący `useMeshDetailsModel`/`ObjectMeshPolicyPanel` rozpoznaje lane FDM i
udostępnia Structured Grid/not-applicable zamiast zapisu FEM policy. Ten audit
baseline pozostaje jako guard regresyjny; potrzebne są jeszcze fixture'y z
rzeczywistym FDM membership i browserową inspekcją.

### 5.2 Airbox Mesh — dokładny symptom ze zrzutu (FEM-only baseline)

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

Wniosek produktowy pozostaje ważny: ten panel jest poprawny wyłącznie dla FEM.
Dla FDM należy kierować do Grid/Universe overlay; obecna częściowa zmiana nie
robi z `AirboxMesh` panelu FDM.

### 5.3 Object Mesh Policy — Gmsh/FEM controls w baseline, FDM branch w bieżącym tree

`ObjectMeshPolicyPanelModel.ts:18-87,101-200,240-345` ma tylko politykę elementową: hmax/hmin, curvature, topology/order/sweep/manual size. `ObjectMeshPolicyPanel.tsx:316-334` pokazuje Element Size Parameters, FEM order i Mesh source; `:338-444` pokazuje free tetra/swept prism/hex, layers i thickness distribution; `:465-511` pokazuje Gmsh 2D/3D algorithm, smoothing, optimizer i boundary layers; `:596-648` wyświetla target max/min element, topology, nodes/elements/boundary faces; `:935-1012` renderuje całość oraz Build Mesh bez branchu.

`ObjectRegionsPanelModel.ts:18-24,451-460,815-839,893-900` serializuje region policy z max/min element size, transition distance i order. `ObjectRegionMeshPanel.tsx:42-128` i `ObjectRegionsPanel.tsx:176-195` korzystają z konformalnego FEM membership/quality. `regionMeshLifecycle.ts:15-28,52-64,111-137` wymaga topology fingerprint/generation i conformal freshness, których FDM descriptor nie ma.

Wniosek: nie wolno „przemianować” tych pól na grid size. FDM potrzebuje osobnego draftu (cell spacing/grid dimensions/origin/alignment/mask policy) i osobnego lifecycle.

Bieżący model ma już jawne FDM Structured Grid oraz FEM controls oznaczone
`not applicable`; pozostaje pełny round-trip draftu i runtime qualification.

### 5.4 Visualization Inspector — FEM carrier dependency w baseline

`ObjectVisualizationPanel.tsx:137-156` pobiera wyłącznie `useMeshSharedDomainManifestResource`, a selected mesh-part rozwiązuje przez `manifestRenderableCarriers`. `ObjectVisualizationPanelModel.ts:331-369,700-787,1376-1501` buduje dostępne node counts/parts/vector diagnostics tylko z manifestu. FDM grid/mask resources nie są włączone do tej ścieżki. `ObjectVisualizationOverview.tsx` ma nawet copy „Canonical finite-element field available” (`:100`).

FDM Visualization Inspector powinien wybierać grid target, quantity, vector sampling, cell/region mask, clipping po indeksach i ograniczenia display budget. Gdy pole nie jest dostępne, należy pokazać powód (`unsupported`, `not materialized`, `stale`, `no active cells`) zamiast pustego renderu.

Viewport ma już FDM target/indexing i jawny degraded status; panel Inspectora
pozostaje do domknięcia o pełny grid/cell resource oraz browserową selekcję.

### 3.7 Field map i topography — baseline rozjazdów, bieżące guardy

`apps/control-room/src/modules/field-map/FieldMapModule.tsx:82-93` wywołuje `usePlanarProbeResource` tylko z component/resolution/u/v, pomijając `scope_kind/scope_id`, stage/snapshot i expected monitor/mesh/field revisions, mimo że `PlanarFieldProbeQuery` je wspiera (`kernel/api/apiTypes.ts:94-110`, `planarFieldResources.ts:205-265`). Probe może więc pokazać wartość z innego scope albo snapshotu niż raster na ekranie; jest to P1 dla reprodukowalności FDM/FEM.

`apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx:82-86,147-154` przechowuje `emptyMask` lokalnie, ale `apps/control-room/src/modules/field-map/renderer/planarColorizer.ts:27-38` transferuje ten sam `mask.buffer` do workera. Późniejszy hover używa odłączonej tablicy typed array. Empty pixel może zostać zgłoszony jako zajęty i dostać wartość zamiast `null`. Maskę trzeba sklonować albo zachować nieprzekazywaną kopię do probe.

`apps/control-room/src/modules/field-map/FieldMapModule.tsx:109-121` raportuje głównie meta/scalar errors; błędy mask/vector/mesh mogą pozostawić częściowy, cichy render. Również FDM-only topography ma niespójny ribbon: `ribbonTabViews.tsx:927-935` mówi o FDM, ale control jest statycznie niedostępny, podczas gdy `ribbonContributions.tsx:1808-1879` nie bramkuje topography po `structured_grid`/`discretization` i manifest viewportu (`viewport-3d/manifest.ts:393-432`) nie deklaruje disabledReason.

Bieżący FieldMap przekazuje scope/stage/snapshot/revision, a raster zachowuje
kopię maski przed transferem do workera; interaction/ribbon mają lane-aware
guardy. Pozostaje browserowa weryfikacja, że degraded mask/vector jest widoczny
użytkownikowi, a nie tylko w diagnostyce.

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
| FDM-UI-001 | P0 | viewport/data | **controlled browser gate passed:** FDM demand is separated from FEM topology; live-session identity remains open | `useViewport3DSceneModel.ts`, FDM demand/index resolver, API field tests, `screenshot-viewport-3d.mjs` | controlled FMVP field/vector render passed; live FDM grid identity remains |
| FDM-UI-002 | P0/P1 | mask/visual | **codec/model fixed in source/tests:** v2/v1, 0/MAX semantics; controlled field smoke passed, live membership render open | runner `fdm/artifacts.rs:68-83`; API `fdm_region_membership.rs:214-228`; codec/build model + focused tests | browser render with current v2 membership |
| FDM-UI-003 | P0/P1 | airbox/3D | FDM grid lane and universe/magnetic-support overlay exist; extent/legend live browser proof remains open | `BoundsLayers.tsx`, `Viewport3DScene.tsx`, `viewport3DTargets.ts` | universe > magnetic object has extent, legend and target |
| FDM-UI-004 | P1 | Explorer | **baseline fixed in current tree:** Grid/Mask nodes replace unconditional FEM branch; reload/stale proof open | `buildModelTree.ts`, explorer selection/registry tests | FDM tree snapshot in live browser |
| FDM-UI-005 | P1 | Mesh Inspector | **source/test complete:** FDM Structured Grid/not-applicable branch and SI/display sampling rows exist; live fixture open | `FdmGridInspectorPanel.tsx`, `useMeshDetailsModel.ts` | no FEM-only fields/actions in FDM inspector |
| FDM-UI-006 | P1 | Airbox Inspector | intentionally FEM-only; FDM routes to Grid/Universe overlay, which needs completion | `AirboxMeshParametersPanel.tsx`, `airboxMeshPolicyDraft.ts` | FDM never shows shared-domain command |
| FDM-UI-007 | P1 | Object/Region | **source/test complete for not-applicable branch:** FDM grid policy is explicit/deferred; writable round-trip intentionally remains deferred | `ObjectMeshPolicyPanel.tsx`, `ObjectRegionMeshPanel.tsx` | separate FDM grid policy |
| FDM-UI-008 | P1 | Visualization Inspector | FDM target/indexing and exact cell Inspector are present; browser selection/universe proof remains open | `ObjectVisualizationPanel.tsx`, `FdmGridInspectorPanel.tsx`, model/controller | FDM grid/cell/region target revision-safe |
| FDM-UI-009 | P1 | interactions | lane-aware catalog/demag/ribbon and reason-coded capability changes present; executed matrix proof open | `interactions.ts`, `PhysicsInteractionPanel.tsx`, ribbon, active-lane resource | capability-scoped options and round-trip |
| FDM-UI-010 | P1 | execution | requested/resolved/fallback rows and validators present; runtime matrix proof open | `StudyInspectorPanel.tsx`, runtime schema/model | fail-closed validator + durable provenance |
| FDM-UI-011 | P1 | commands | FDM ribbon command gating present; browser/command completion proof open | `ribbonContributions.tsx`, runtime contributions | neutral/capability label and disabled reason |
| FDM-UI-012 | P2 | selection | `fdm-cell`, exact registry routes and mounted screen-reader announcement are source/test complete; live hover/click proof open | `selectionTypes.ts`, `explorerSelection.ts`, `Viewport3DModule.tsx`, registry | `(i,j,k)`/fingerprint Inspector |
| FDM-UI-013 | P2 | lifecycle | FEM topology freshness assumptions for FDM | `regionMeshLifecycle.ts`, runtime resources | separate FDM grid/mask lifecycle and revision invalidation |
| FDM-UI-014 | P2 | stage commands | eigen/frequency/FFT commands enabled without lane proof | `studyRuntimeCommandContributions.ts:1671-1994` | capability matrix controls availability and explanation |
| FDM-UI-015 | P2 | accessibility/UX | **source/test complete:** reason-coded status, SI labels, keyboard selection, screen-reader announcement and identity-safe tooltip | panels/controllers/tree, `Viewport3DFdmAccessibility.test.tsx` | browser accessibility audit and live selection proof |
| FDM-UI-016 | P1 | field map | **source/test fix present:** scope/snapshot/revision and mask copy are carried; browser degraded-state proof open | `FieldMapModule.tsx`, `PlanarSurface.tsx`, `planarColorizer.ts` | probe/raster share scope and revision |
| FDM-UI-017 | P2 | topography | lane-aware FDM control present; capability/runtime proof remains open | `ribbonTabViews.tsx`, `ribbonContributions.tsx` | explicit FEM not-applicable reason |

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

### P0-A — naprawa wizualizacji 3D meshu/gridu (controlled gate zamknięty)

To jest pierwszy sprint i blokada dla dalszych warstw UI:

1. **Zrealizowane źródłowo/testowo:** utrzymać codec FDM dla aktualnego v2 (`version=2`, `kind=2`) z testem produkcyjnego headera; legacy v1 pozostaje jawnie kompatybilne.
2. **Zrealizowane źródłowo/testowo:** brak membership/stale/error daje jawny degraded status, a identity selection/membership fail-closed; nie ma cichego potwierdzania aktywności.
3. **Zrealizowane źródłowo/testowo:** encoding-aware classifier dla `active`, `inactive`, `unassigned`, region i air/background; controlled browser fixture potwierdza pole/kolorowanie, a live membership render pozostaje osobnym gate’em.
4. **Zrealizowane źródłowo/testowo:** niezależne `FdmGridRenderModel` oraz `FemTopologyRenderModel`, wspólne tylko na poziomie bounds/display budget/selection/provenance.
5. **Zrealizowane źródłowo/testowo:** FDM magnetic-support/air/void overlay dla universe > ferromagnetyk oraz spójny `fdm-domain` target; controlled extent/legend jest pokryty, a live membership artifact/extent proof pozostaje otwarty.
6. **Zrealizowane i zakwalifikowane na fixture:** field/vector demand odłączony od `fieldCompatibleTopologyRenderModel`; nonuniform FDM field, colorbar, shader i glyphy przechodzą smoke. FMVP v3 provenance i live session pozostają osobną bramką.
7. **Zrealizowane na controlled fixture i live frontendzie:** canvas visible, `gl.isContextLost() === false`, drawing buffer `> 0 × 0`; fixture ma niezerowe field/vector/projection deltas, a live frontend ma poprawny camera fit i aktywny FMVP.
8. **Zrealizowane źródłowo i potwierdzone świeżym WebGL smoke:** przejście
   FDM z neutralnego meshu do shader/instance colors zachowuje macierze komórek,
   a regularny atrybut koloru geometrii jest neutralny `(1,1,1)`, więc shader
   nie wygasza poprawnych kolorów pola.
9. **Zrealizowane źródłowo i potwierdzone świeżym WebGL smoke:** FDM glyphy
   mają osobną politykę głębokości (`renderOnTop`), a przełączenie warstwy
   buduje i montuje segmenty wektorowe także przy 100% opacity powierzchni;
   dwa kolejne audytowe smoke’y oraz real-API probe pokazały niezerowy delta
   glyphów po włączeniu opcji (`1697/1 296 000` pikseli). Zapisany live state z
   `vectors_visible=false` pozostaje świadomym stanem konfiguracji, nie błędem
   renderera.
10. **Zrealizowane źródłowo i potwierdzone testem regresyjnym:** unkeyed FDM
    vector build normalizuje `undefined` do store’owego `null`, dzięki czemu
    wynik workera nie pozostaje ukryty mimo poprawnego payloadu.

**Gate P0-A:** controlled browser smoke i live frontend canvas/FMVP/camera smoke
przechodzą. Pozostaje powtórzenie na aktualnym backendzie z membership/air-void
payloadem; sam poprawny FMVP nie zamyka tej pozostałej bramki.

### P0-B — kontrakt i obserwowalna ścieżka danych

1. Zdefiniować dyskryminowany `DomainPresentation`/`CapabilitySnapshot` w centralnym resource layer.
2. Utrwalić revision/fingerprint/freshness w każdym render target.
3. Rozdzielić field/vector demand plan od `fieldCompatibleTopologyRenderModel`; FDM ma grid-compatible field model.
4. Ujednolicić target kind (`fdm-domain`, nie generyczne `object`) i selection bounds.

**Gate:** testy danych, viewportu i controlled browser fixture przechodzą na FDM bez manifestu FEM; każdy brak/stan stale jest widoczny jako diagnostyka. Live-session identity pozostaje do powtórzenia.

### P1 — Explorer, Inspector i zarządzanie mesh/grid/airbox (source/test complete; live gate open)

1. Dodać grid/mask Inspector i zastąpić FEM-only sekcje w `MeshDetailsPanel`, `Airbox*`, object/region panels.
2. Przebudować `MeshBuildDialog` na adapter domain: FDM grid/mask refresh vs FEM shared-domain build.
3. Dodać FDM Explorer nodes i exact registry/selection types.
4. Zachować opcjonalny FDM airbox jako rolę gridu, gdy universe > magnetic support; nie tworzyć drugiej FEM-owej topologii.

**Gate:** source/test fixture FDM z i bez airboxa nie pokazuje żadnej FEM-only sekcji ani komendy shared-domain. Live browser reload, universe extent/legend i exact selection pozostają do wykonania.

### P2 — interakcje, ribbon i provenance (source/test complete; runtime matrix open)

1. Rozszerzyć capability catalog o backend/device/precision/mode/operator.
2. Wpiąć go w `PhysicsInteractionPanel`, ribbon, stage commands i global/stage validators.
3. Dodać FDM `multilayer_convolution` do canonical selectora; FEM-only policy ma jawny stan.
4. W Study/Runtime wyświetlać requested + resolved + fallback po wykonaniu i po odświeżeniu.
5. Zastąpić statyczne `Build FEM Mesh` neutralnym/adaptacyjnym label.

**Gate:** FDM/FEM matrix tests, reason-coded capability snapshot i round-trip DSL/UI/API są zgodne; unsupported nie da się zapisać jako aktywna opcja. Executed CPU/GPU/precision/mode matrix jest osobnym gate’em.

### P3 — UX, accessibility i wydajność (implemented; runtime qualification in progress)

1. **Zrealizowane źródłowo/testowo:** statusy `supported`, `not applicable`, `deferred`, `stale`, `not materialized` z maszynowym `reason_code`.
2. **Zrealizowane źródłowo/testowo:** FDM używa `Origin [m]`, `Cell spacing [m]`, `cells`; FEM zachowuje `elements`.
3. **Zrealizowane źródłowo/testowo:** centralny display budget/stride bez obniżania jakości domyślnej; HUD/Inspector pokazują total/display/budget.
4. **Zrealizowane źródłowo/testowo:** keyboard/tree semantics, exact FDM selection announcement oraz tooltip provenance/revision z fail-closed identity.
5. **Częściowo zrealizowane:** hydration/store oraz lifecycle/resource smoke są pokryte testami; pełny settled-window runtime smoke wymaga uruchomionej sesji FDM.

### P4 — kwalifikacja browser/scientific

1. **Controlled fixture passed; live frontend passed for core path:** canvas widoczny, `gl.isContextLost() === false`, drawing buffer `> 0 × 0`, shader/vector/colorbar/projection deltas niezerowe na fixture; świeży audytowy bundle na `:3123` potwierdził FMVP/camera fit/4096-cell grid, a real-API `:3124` potwierdził kolorowany slab i delta glyphów `1697/1 296 000`.
2. **Częściowo:** screenshot proof obejmuje FDM quantity/vector/projection/dimension-frame oraz region overlay; live airbox/universe, wireframe/points, clipping i hover wymagają aktualnego backendu z membership artifactem. Bieżący live zapis ma vectors/colorbar wyłączone, więc nie jest dowodem ich braku w rendererze.
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
- `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx:538-582,665-743,1144-1173` — FDM surface mesh identity, neutral vertex colors and render-on-top vector wiring
- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx:370-404,470-520,1240-1290` — vector glyph depth policy and GPU adoption
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx:1980-1995` — FDM segment-count diagnostic exposed to browser smoke
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts:63-72,284-324`
- `apps/control-room/src/modules/viewport-3d/viewport3dInspect.ts:33-91`
- `apps/control-room/src/kernel/selection/selectionTypes.ts:214-284`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:713-731`
- `apps/control-room/src/modules/field-map/FieldMapModule.tsx:82-121`
- `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx:82-154`
- `apps/control-room/src/modules/field-map/renderer/planarColorizer.ts:27-38`
- `crates/fullmag-cli/src/orchestrator.rs:8187-8220,12757-12803` — synthetic terminal field publication and source-step regression test

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

### Zweryfikowany błąd provenance launchera FDM

Live uruchomienie `fdm gpu` ujawniło, że status mieszał authored intent z
efektywnym żądaniem wykonania: skrypt zachowywał `device=cpu`, launcher ustawiał
`FULLMAG_FDM_EXECUTION=gpu`, a runtime poprawnie rozwiązywał `device=gpu`.
Kontrakt `status.capabilities.active_lane` musi więc eksponować osobno
`authored` (ProblemIR), `requested` (effective request po override) i
`resolved`, wraz z provenance źródeł. UI Study/Runtime musi używać etykiet
`Authored request`, `Effective request`, `Resolved` oraz jawnie pokazywać
fallback; samo porównanie starego `requested` z `resolved` było semantycznie
niepoprawne.

1. **Live browser/runtime:** obecny `3100/8081` zwraca poprawny transportowo FMVP
   i renderuje FDM slab. Początkowo `:3100` miał stary dynamiczny chunk, więc
   worker raportował `1200` segmentów i `complete`, ale glyphy nie zmieniały
   obrazu; po HMR/odświeżeniu chunk zawiera `normalizedBuildKey`, a real-API
   porównanie `vectors off/on` daje `1697/1 296 000` pikseli. Użytkownik musi
   odświeżyć kartę po aktualizacji dev servera. Backend nadal ma
   `runtime_bundle_version=2026-08-04`, active-lane v1/unresolved i brak
   membership artifactu. Źródłowa publikacja syntetycznego finalnego pola jest
   już poprawiona i ma testy `source_step/source_revision`, ale działający
   backend wymaga rebuild/restartu, aby przestać zwracać stare `0/1`. Następnie
   trzeba powtórzyć tę samą sesję z FDM membership, universe > magnetic support,
   hover/click, quantity/scope switch i reload selection.
2. **FDM identity contract:** FMVP v2 body nadal nie niesie pełnego `grid_fingerprint`/cell map; frontend wiąże payload z `DomainMeta` generation/grid. Docelowy FMVP v3 albo jawny envelope identity jest wymagany przed pełną live qualification.
3. **FDM grid lifecycle:** odświeżenie/replan gridu i maski jest jawnie odroczone, gdy ExecutionPlanIR jest immutable; nie wolno udawać zapisywalnego FEM build. To pozostaje decyzją produktowo-runtime, nie ukrytym fallbackiem.
4. **Runtime/scientific:** pełna macierz FDM CPU/GPU/precision/mode, executed-device proof, `fdm_multilayer` oraz solver qualification są poza browser/UI gate’em i muszą być potwierdzone osobno.
5. **Accessibility/performance live gate:** source/DOM tests są zielone, a smoke helper wymaga settled-window `dirty frames=0`, `requests=0` i stabilnych resource counts; wykonanie tego helpera wymaga uruchomionej sesji FDM.
6. Brak drugiego pliku obrazu z podanej ścieżki Windows; do wizualnego porównania trzeba dołączyć go ponownie.

Maszynowy `reason_code`, SI naming, display budget/stride, FDM cell announcement
i provenance-safe inspect tooltip są już częścią kontraktu/source tests — nie są
już blockerami implementacyjnymi.

## 16. Definition of done dla tego audytu

Audyt i refaktoryzacja UI są udokumentowane w working tree. Dokument spełnia
warunki audytu, ponieważ:

- każdy wskazany obszar ma dowód path+line oraz severity;
- airbox/universe FDM został jawnie zachowany jako wariant, gdy universe > magnetic support;
- oddzielono UI/source proof od controlled browser, live runtime i scientific qualification;
- opisano docelowy adapter, IA, fazy remediacji i acceptance matrix;
- wskazano brakujące zasoby, testy, provenance oraz dokładne bramy kontynuacji;
- P0 controlled smoke dowodzi, że mesh/grid, shader, vectors i colorbar są renderowane na FMVP payloadzie (w tym glyphy nad nieprzezroczystym FDM cuboidem), a świeży live frontend dowodzi poprawnego WebGL/FMVP/camera fit i budowy segmentów po włączeniu warstwy;
- P3 reason codes, SI naming, display budget oraz accessibility identity są pokryte kontraktem i testami.
- backendowy synthetic final-field provenance ma test regresyjny, lecz jego wdrożenie wymaga restartu aktualnego runtime.

Nie jest to deklaracja pełnej kwalifikacji produktu. Do osobnego zamknięcia
pozostają aktualny runtime v2 z `resolved` lane, universe/membership extent w
działającej sesji, FMVP identity v3/envelope, executed CPU/GPU/precision/mode
matrix, `fdm_multilayer` oraz kwalifikacja naukowa solvera.
