# Audyt procedury budowania siatki FEM na `master` oraz projekt interaktywnego poradnika gotowości siatki (FEM Mesh Readiness Guide)

**Data:** 2026-10-13  
**Zakres:** `apps/control-room` (Explorer, Ribbon, Inspector, Kernel Resources/Commands) oraz kontrakt `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` i `model/readiness.rs`  
**Status:** Zatwierdzony do implementacji w worktree `fem-mesh-guide-20261013`

---

## 1. Cel dokumentu

Dokument stanowi szczegółowy raport z audytu pełnej procedury konfiguracji i budowania siatki (meshu) w trybie **FEM** na gałęzi `master` oraz specyfikację projektową dla:
1. **Interaktywnego poradnika gotowości siatki FEM („Poradnik jak w grach” / FEM Mesh Readiness Guide)** — systemu proaktywnych podpowiedzi prowadzących użytkownika krok po kroku od utworzenia geometrii przez dobór parametrów domeny/Airboxa i obiektów aż do zbudowania wspólnej siatki obliczeniowej (`study_domain`) wymaganej przez solver FEM.
2. **Poprawek błędów logicznych, architektonicznych i UX** wykrytych podczas audytu w `apps/control-room`.

---

## 2. Analiza obecnej procedury budowania siatki FEM w UI (`master`)

### 2.1. Ścieżka użytkownika od utworzenia geometrii do zbudowania siatki

1. **Inicjalizacja sesji FEM (`StartScreen` / `NewProblemDialog`)**:
   - Użytkownik tworzy projekt/sesję z wybraną rodziną solvera `fem` (`sessionMode === "fem"`).
2. **Tworzenie geometrii (`Geometry` Ribbon / Explorer -> `GeometryObjectPanel` -> `ObjectGeneralPanel`)**:
   - Użytkownik dodaje obiekt geometryczny (np. `Box`, `Cylinder`, `Sphere`, `Polygon`, `CSG` lub import CAD/STL) w `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`.
   - Po utworzeniu obiektu w drzewie `ExplorerModule.tsx` pojawia się węzeł `model:object:<id>` z pod-węzłami:
     - `model:object:<id>:transform`
     - `model:object:<id>:material`
     - `model:object:<id>:mesh` (`ObjectMeshPolicyPanel.tsx`)
3. **Cztery poziomy konfiguracji parametrów siatki w architekturze API v2**:
   Backend (`crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`) oraz warstwa hooków (`apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`) udostępniają cztery poziomy polityk siatkowania:
   - **Poziom 1 — Universe / Airbox Policy** (`GET/PUT /v2/sessions/current/meshing/policies/universe`):
     - Zapisuje `scene.universe.mesh_policy` (`UniverseMeshPolicy`).
     - Definiuje tryb domeny zewnętrznej (`airbox_mode: "auto" | "manual"`), marginesy `padding` (`x, y, z`), jawny rozmiar/środek (`size`, `center`), rozmiary elementów w Airboxie (`airbox_h_max`, `airbox_h_min`, `airbox_growth_rate`) oraz strategię powłoki zewnętrznej (`exterior_shell_strategy`).
     - Edytowany w `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` (dostępny pod węzłem `model:universe` oraz `model:airbox:mesh:parameters`).
   - **Poziom 2 — Shared-Domain Policy** (`GET/PUT /v2/sessions/current/meshing/policies/shared-domain`):
     - Zapisuje `scene.study.shared_domain_mesh` oraz `scene.study.mesh_defaults`.
     - Definiuje globalne domyślne rozmiary elementów (`h_max`, `h_min`, `growth_rate`, `curvature_safety`, `min_elements_per_feature`), `interface_conformity`, `exterior_treatment`, `gmsh_3d_algorithm` oraz `mesh_order`.
   - **Poziom 3 — Object Mesh Policy** (`GET/PUT /v2/sessions/current/meshing/policies/objects/{id}`):
     - Zapisuje `object.mesh_policy` (`ObjectMeshPolicy`).
     - Definiuje lokalne nadpisanie rozmiaru elementu dla obiektu (`h_max`, `h_min`, `growth_rate`), strategię dla cienkich warstw (`thin_film_strategy: "isotropic" | "swept_prism"`, `sweep_layers`, `sweep_axis`), zagęszczenie na interfejsach (`interface_h`, `interface_band_width`), krawędziach/narożach oraz warstwach brzegowych.
     - Edytowany w `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` (`model:object:<id>:mesh`).
   - **Poziom 4 — Region Mesh Policy** (`GET/PUT /v2/sessions/current/meshing/policies/regions/{id}`):
     - Zapisuje `region.mesh_policy` (`RegionMeshPolicy`) dla regionów przypisanych do obiektów (`RegionMeshPolicyPanel.tsx`).
4. **Wyzwalanie budowy siatki (`POST /v2/sessions/current/meshing/builds`)**:
   - Backend rozróżnia dwa cele budowy (`MeshTarget` w `mesh.rs`):
     - **`object_mesh`** (`{ kind: "object_mesh", object_id }`) — wywoływany przez komendę `mesh.build-selected`: buduje izolowaną siatkę podglądową dla wybranego obiektu i zapisuje ją w `snapshot.object_fem_meshes[object_id]`.
     - **`study_domain`** (`{ kind: "study_domain" }`) — wywoływany przez komendę `mesh.build-shared-domain` (lub `mesh.build-airbox`): buduje pełną, konforemną siatkę wieloobiektową wraz z domeną zewnętrzną (Airbox) i zapisuje ją w `snapshot.fem_mesh`.

---

## 3. Zidentyfikowane błędy logiczne, architektoniczne i luki UX

Podczas audytu kodu na `master` wykryto **7 istotnych problemów**, które utrudniają lub blokują prawidłowe skonfigurowanie i zbudowanie siatki FEM:

### Problem 1 (Krytyczny błąd invalidacji cache): Zapis polityki siatki nie odświeża UI przed pierwszym zbudowaniem siatki
- **Lokalizacja:**
  - Backend: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` (`get_mesh_universe_config` l. 571, `replace_mesh_universe_config` l. 624, `get_mesh_shared_domain_config` l. 705, `replace_mesh_shared_domain_config` l. 753, `get_mesh_object_config` l. 2277, `replace_mesh_object_config` l. 2340).
  - Frontend: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` (l. 126–131), `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` (l. 1131–1138), `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` (l. 254–265), `apps/control-room/src/kernel/resources/ResourceInvalidationController.ts` (l. 50–58).
- **Mechanizm błędu:**
  - Endpointy `GET/PUT /meshing/policies/*` zwracają w polu `revision` wartość `snapshot.mesh_revision` (a nie `scene.revision`).
  - Zapis polityki (`PUT`) modyfikuje `scene_document` (zwiększając `scene.revision`), ale **nie zmienia `snapshot.mesh_revision`** (które przed pierwszym zbudowaniem siatki wynosi `0`).
  - Gdy panel wywołuje `resources.invalidate(meshUniversePolicyResourceKey(), next.revision)`, przekazuje `next.revision = 0`.
  - W `ResourceRuntimeStore.ts` funkcja `settledForExternalRevision` sprawdza `snapshot.revision === externalRevision` (`0 === 0`), uznaje zasób za już aktualny i **nigdy nie wykonuje ponownego pobrania (`GET`)**. Co więcej, przy drugim zapisie `ResourceInvalidationController.invalidateOne` widzi `current === revision` (`0 === 0`) i wychodzi bez powiadomienia subskrybentów.
- **Skutek dla użytkownika:** Po zapisaniu polityki Airboxa węzeł `Airbox` nie pojawia się w drzewie Explorer, a po przełączeniu węzła i powrocie Inspector nadal pokazuje stary stan sprzed zapisu.

### Problem 2 (Pułapka UX): Ukryty węzeł `Airbox` oraz blokada przycisku „Apply Policy” / „Apply & Build Mesh”
- **Lokalizacja:**
  - `apps/control-room/src/modules/explorer/femAirboxEvidence.ts` (l. 23–55)
  - `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts` (l. 170–176)
  - `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` (l. 53–80, 191–196)
  - `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` (l. 113–120, 194–203)
- **Mechanizm błędu:**
  - W nowej sesji FEM `universeMeshPolicy.data.config` ma wartość `null` (choć backend zwraca kompletny `effective_config` z obliczonymi wymiarami i domyślnym `h_max`).
  - Ponieważ `config === null`, węzeł `Airbox` jest ukryty w drzewie Explorer (`buildFemAirboxNode` zwraca `null`).
  - Gdy użytkownik wejdzie w `Universe` (`model:universe`), formularz `AirboxMeshParametersPanel` inicjalizuje wszystkie pola pustymi stringami `""`, ignorując `effective_config`.
  - Jeśli użytkownik kliknie **„Apply Policy”** lub **„Apply & Build Mesh”**, chcąc zaakceptować domyślny Airbox i zbudować siatkę, `isUntouchedNullAuthoredDraft` zwraca `{ request: null }`, a panel wyświetla błąd: `"Author an airbox policy or edit a parameter before applying."`
  - Dodatkowo pole `Airbox mode` jest zwykłym `<input type="text" placeholder="auto | manual" />` zamiast `<select>`, a pola dla trybu `auto` (`Padding`) i `manual` (`Size`, `Center`) są wyświetlane jednocześnie bez rozróżnienia, które z nich działają w wybranym trybie.

### Problem 3 (Pułapka UX): Ściana zablokowanych kontrolek w `ObjectMeshPolicyPanel`
- **Lokalizacja:** `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- **Mechanizm:** Dopóki obiekt nie ma własnego nadpisania (`config === null`), checkbox `"Use object policy"` jest odznaczony, a wszystkie pola (`Maximum element size`, `Minimum element size`, `Thin-Film Sweep Strategy`, `Interface Refinement` itd.) są wyszarzone (`disabled`). Użytkownik po utworzeniu geometrii i kliknięciu węzła `Mesh` pod obiektem widzi nieaktywny formularz bez wyraźnego komunikatu na górze, jakie parametry efektywne obiekt obecnie dziedziczy z domeny i że włączenie checkboxa pozwala je nadpisać.

### Problem 4 (Rozbieżność semantyczna): `Build Object Mesh` vs `Build Shared-Domain Mesh` blokuje gotowość solvera
- **Lokalizacja:**
  - `crates/fullmag-api/src/router_v2/handlers/model/readiness.rs` (l. 238–256)
  - `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` (l. 1179–1205)
  - `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` (`mesh.build-selected` vs `mesh.build-shared-domain`)
- **Mechanizm:**
  - Bramka gotowości solvera FEM (`model/readiness`, sekcja `discretization`) wymaga aktualnej **wspólnej siatki domeny (`study_domain`)**, tj. `snapshot.fem_mesh.is_some() && source_revision == Some(scene.revision)`.
  - Tymczasem przyciski `"Build Mesh"` i `"Apply & Build Mesh"` w `ObjectMeshPolicyPanel` oraz główny przycisk `Build (Ctrl+B)` na wstążce `Mesh` wywołują `mesh.build-selected`, co buduje wyłącznie izolowaną siatkę pojedynczego obiektu (`object_mesh`).
  - Użytkownik buduje siatkę obiektu, widzi ją w 3D, przechodzi do `Study -> Run`, a solver odmawia startu komunikatem: `"Build a current shared-domain mesh before running."`

### Problem 5 (Błąd reaktywności): Zakładka `Mesh` na wstążce (`RibbonModule.tsx`) nie reaguje na zmianę zaznaczenia w Explorerze
- **Lokalizacja:** `apps/control-room/src/modules/ribbon/RibbonModule.tsx` (l. 172–176)
- **Mechanizm:**
  ```ts
  const selection = useSelectionSelector((state) =>
    activeTab === "view" || activeTab === "geometry" ? state.selection : EMPTY_SELECTION,
  );
  ```
  Gdy aktywna jest zakładka `Mesh` (`activeTab === "mesh"`), `RibbonModule` w ogóle nie subskrybuje `selectionStore`! Zmiana zaznaczonego obiektu w drzewie Explorer nie powoduje przerenderowania wstążki `Mesh`, przez co przyciski zależne od selekcji (`Build`, `Object Report`) mają nieaktualny stan `disabled`.

### Problem 6 (Brak ekspozycji w UI): Brak podglądu i edycji domyślnych parametrów `Shared-Domain Mesh`
- **Lokalizacja:** `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts` (`useMeshSharedDomainPolicyResource`, l. 955).
- **Mechanizm:** Hook i metoda API `api.meshing.sharedDomain.replacePolicy` istnieją, ale nigdzie w UI nie ma sekcji pozwalającej podejrzeć ani skonfigurować domyślnych parametrów wspólnej domeny (`h_max`, `h_min`, `growth_rate`, `mesh_order`, `gmsh_3d_algorithm`) w `MeshDetailsPanel` (`model:mesh` / `model:mesh:shared-domain`).

### Problem 7 (Brak prowadzenia użytkownika): Brak interaktywnego poradnika / checklisty gotowości siatki FEM
- Po stworzeniu geometrii użytkownik nie ma w UI żadnego przewodnika („quest-loga”), który analizowałby bieżący stan modelu FEM i podpowiadał:
  - co jest już skonfigurowane poprawnie,
  - jakie parametry warto lub trzeba jeszcze uzupełnić (materiał, Airbox/rozmiar elementów domeny, opcjonalne zagęszczenie/sweep dla cienkich warstw),
  - czy siatka jest zbudowana jako `object_mesh` czy jako wymagana przez solver `study_domain`,
  - czy po edycji geometrii/polityki siatka stała się nieaktualna (`stale` względem `scene.revision`).

---

## 4. Projekt „Poradnika budowania siatki FEM” (FEM Mesh Readiness Guide)

### 4.1. Założenia architektoniczne (zgodność z `AGENTS.md` i `frontend.md`)
- **Brak zduplikowanego stanu (State Hygiene):** Poradnik jest w 100% czystą projekcją (`pure derived model`) wyliczaną z istniejących hooków zasobów (`useModelSceneResource`, `useGeometryValidationResource`, `useMeshUniversePolicyResource`, `useMeshSharedDomainPolicyResource`, `useMeshSemanticsResource`, `useMeshSummaryResource`, `useMeshManifestResource`, `useActiveMeshBuildResource`, `useMeshQualityGatesResource`). Nie tworzy własnego store'a Zustand ani kontekstu React.
- **Brak bezpośrednich wywołań sieciowych (API Hygiene):** Akcje poradnika korzystają wyłącznie z rejestru komend (`kernel.commands.execute`) oraz selekcji (`kernel.selection.select`), a zapisy polityk przechodzą przez istniejące fasady `ControlRoomApi`.
- **Stabilność Inspectora:** Komponent poradnika nie używa animacji `opacity` ani globalnego blokowania panelu podczas operacji asynchronicznych. Wszystkie klasy CSS używają prefiksu `fm-` i tokenów `--fm-*` (Catppuccin Mocha/Latte).

### 4.2. Struktura kroków poradnika (Quest Steps)

Model `FemMeshReadinessGuideModel` (`apps/control-room/src/modules/inspector/panels/mesh-guide/femMeshReadinessGuide.ts`) wylicza ogólny status gotowości (`overallStatus`: `"action-required" | "recommended" | "stale" | "building" | "ready"`) oraz 6 kroków:

| # | ID kroku | Tytuł w UI | Warunek zaliczenia (`complete`) | Stany ostrzegawcze / wymagające akcji | Akcja bezpośrednia w UI |
|---|---|---|---|---|---|
| 1 | `geometry` | **1. Solid Geometry** | W `scene` istnieje $\ge 1$ obiekt geometryczny oraz `geometryValidation` nie zawiera błędów blokujących (`errorCount === 0`). | `action-required`: brak obiektów w scenie lub błędy walidacji CSG/CAD. | Nawigacja do `Geometry` (`model:objects` lub pierwszy błędny obiekt `model:object:<id>`). |
| 2 | `materials` | **2. Material Assignment** | Wszystkie obiekty w scenie mają przypisany `material_id` w `scene` lub przypisanie materiałowe. | `recommended` / `action-required`: obiekt bez przypisanego materiału (ze wskazaniem nazwy obiektu). | Nawigacja bezpośrednio do `model:object:<id>:material`. |
| 3 | `airbox-domain` | **3. Exterior Airbox & Domain Sizing** | Polityka `Universe / Airbox` ma prawidłowy `effective_config` (`h_max > 0`). Jeśli `config !== null` — `complete` (Explicit policy); jeśli `config === null` — `recommended` z informacją o aktywnych wartościach domyślnych (`effective_config`) i możliwością ich jawnego zapisania. | `recommended`: używane domyślne parametry Airboxa bez jawnego zatwierdzenia (`mode`, `padding`, `h_max`). | Nawigacja do `model:universe` / `model:airbox:mesh:parameters` (`Configure Airbox`). |
| 4 | `object-sizing` | **4. Object Element Size & Thin-Film Strategy** | Przegląd obiektów: pokazuje ile obiektów ma własną politykę (`object_configs`), a ile dziedziczy rozmiar domeny. | `recommended`: wykryto obiekt o dużym stosunku wymiarów (cienka warstwa, np. grubość $z \ll x, y$) bez włączonej strategii `swept_prism` lub obiekt bez lokalnego `h_max`. | Nawigacja bezpośrednio do `model:object:<id>:mesh` (`Configure Object Mesh`). |
| 5 | `shared-domain-build` | **5. Build Shared-Domain FEM Mesh** | Zbudowano siatkę `study_domain` (`summary.element_count > 0`) i jej `source_revision === scene.revision`. | `building`: trwa budowa; `failed`: ostatni build zakończony błędem; `stale`: siatka zbudowana dla starszej rewizji sceny (`source_revision !== scene.revision`) lub zbudowano tylko `object_mesh` zamiast `study_domain`; `action-required`: siatka jeszcze niezbudowana. | Przycisk **`Build Shared-Domain Mesh`** (`mesh.build-shared-domain`) + podgląd `model:mesh:shared-domain`. |
| 6 | `quality-gates` | **6. Mesh Quality & Solver Readiness** | Siatka jest aktualna, a `qualityGates.overall_status === "pass"`. | `recommended`: ostrzeżenia jakości (`warn`); `action-required`: przekroczone progi jakości (`fail`) lub brak zbudowanej siatki. | Nawigacja do `model:mesh:quality` (`Inspect Quality Gates`). |

### 4.3. Wyświetlanie „Następnego zalecanego kroku” (Next Quest Hint)
Na górze karty `FemMeshReadinessGuideCard` znajduje się wyraźny pasek postępu (np. `4 / 6 steps complete`) oraz wyróżniona podpowiedź **Next Step** wskazująca pierwszy nieukończony lub wymagający uwagi krok wraz z przyciskiem szybkiej akcji (np. `Configure Airbox`, `Assign Material`, `Build Shared-Domain Mesh`).

### 4.4. Miejsca integracji w UI
1. **`MeshDetailsPanel.tsx` (`model:mesh`, `model:mesh:shared-domain`, `model:mesh:build`)**:
   - Pełna karta `FemMeshReadinessGuideCard` na górze panelu.
   - Dodatkowa sekcja konfiguracji domyślnych parametrów `Shared-Domain Mesh Policy` (`h_max`, `h_min`, `growth_rate`, `mesh_order`, `gmsh_3d_algorithm`) na trasie `model:mesh` / `model:mesh:shared-domain`, podłączona do `useMeshSharedDomainPolicyResource` i `api.meshing.sharedDomain.replacePolicy`.
2. **`AirboxMeshParametersPanel.tsx` (`model:universe`, `model:airbox:mesh:parameters`)**:
   - Kompaktowy nagłówek `FemMeshReadinessGuideCard` pokazujący stan gotowości siatki FEM.
   - Naprawiony formularz Airboxa: `<select>` dla `Airbox mode` (`auto` / `manual`), widoczne wartości efektywne (`effective_config`), przycisk **`Use Effective Defaults`** oraz możliwość bezpośredniego kliknięcia **`Apply & Build Mesh`** bez sztucznej blokady, gdy `config === null`.
3. **`ObjectMeshPolicyPanel.tsx` (`model:object:<id>:mesh`)**:
   - Kompaktowy pasek `FemMeshReadinessGuideCard` + czytelny baner informujący o aktualnie dziedziczonych parametrach (`effective_config`), gdy `"Use object policy"` jest wyłączony, z szybkim przyciskiem **`Enable Object Override`**.
   - Wyraźne rozdzielenie przycisków: **`Build Object Mesh`** (lokalny podgląd obiektu) oraz **`Build Shared-Domain Mesh`** (pełna siatka FEM dla solvera).
4. **`ObjectGeneralPanel.tsx` (`model:object:<id>`)**:
   - Kontekstowa wskazówka po utworzeniu/edycji geometrii w trybie FEM pokazująca status gotowości siatki tego obiektu i szybkie przejście do `Object Mesh Policy` (`model:object:<id>:mesh`) lub `Mesh Readiness Guide` (`model:mesh`).

---

## 5. Kryteria weryfikacji

1. **Testy jednostkowe (Vitest):**
   - `femMeshReadinessGuide.test.ts` — pokrycie wszystkich stanów poradnika: pusta scena, brak materiału, domyślny vs jawny Airbox, cienka warstwa (`thin-film` hint), zbudowany tylko `object_mesh` vs `study_domain`, nieaktualna rewizja (`stale`), trwający build (`building`), błędy jakości (`qualityGates`).
   - `airboxMeshPolicyDraft.test.ts` — weryfikacja budowania requestu z `effective_config`, gdy użytkownik zatwierdza domyślny Airbox (`config === null`), oraz walidacji trybów `auto` i `manual`.
   - Testy komponentów / integracji dla `AirboxMeshParametersPanel`, `ObjectMeshPolicyPanel` i `RibbonModule`.
2. **Bramki jakości `apps/control-room`:**
   - `pnpm --dir apps/control-room typecheck` — 0 błędów TypeScript.
   - `pnpm --dir apps/control-room lint` — 0 błędów i 0 ostrzeżeń ESLint (`--max-warnings=0`).
   - `pnpm --dir apps/control-room check:api-hygiene` oraz `check:architecture-hygiene` — PASS.
   - Wybrane testy Vitest (`pnpm --dir apps/control-room test -- --run ...`) — PASS.
