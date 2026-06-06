# Region Viewport UI i Authoring – Plan Implementacji

Data: 2026-06-06  
Status: DRAFT — do akceptacji przed implementacją  
Zależności: [region-owned-implementation-masterplan-2026-06-04-pl.md](./region-owned-implementation-masterplan-2026-06-04-pl.md)

---

## 1. Cel

Dodać pełne wizualne doświadczenie tworzenia, edycji i inspekcji regionów w Control Room:

1. **Viewport overlay** – kształt regionu widoczny na obiekcie rodzica jako kolorowa nakładka.
2. **Inspector CRUD** – inspektor gałęzi Regions z listą regionów, przyciskiem Add Region, i pełną edycją wybranego regionu.
3. **Explorer ↔ Viewport ↔ Inspector sync** – zaznaczenie regionu w Explorer podświetla go w viewport i otwiera jego inspektor.

---

## 2. Viewport – wizualizacja regionu

### 2.1 Dwa tryby renderowania

Region w viewport musi mieć dwa tryby zależne od tego, czy mesh istnieje.

#### Tryb A: Authored Shape (przed mesh)

Mesh nie istnieje albo jest stale. Viewport pokazuje **wireframe kształtu regionu** (box, cylinder, sphere) jako semi-transparentny ghost nałożony na primitive geometry ownera.

Implementacja:

- Nowa warstwa `RegionOverlayLayer.tsx` w `apps/control-room/src/modules/viewport-3d/layers/`.
- Warstwa jest analogiczna do `BoundsBox` z `BoundsLayers.tsx` – renderuje `<mesh>` z semi-transparentnym `meshBasicMaterial`.
- Geometria pochodzi z authored region shape (`RegionShapeIR`: Box → `boxGeometry`, Cylinder → `cylinderGeometry`, Sphere → `sphereGeometry`).
- Pozycja i rozmiar z `center`/`size`/`radius`/`height` regionu, w `frame=object` (lokalne współrzędne ownera).
- Kolor z palety regionów – każdy region dostaje unikalny odcień z accentowej palety Catppuccin.

Wygląd:
```
┌─────────────────────────────────────────┐
│                                         │
│   ╔══════════╗  ← wireframe box         │
│   ║ ░░░░░░░░ ║    regionu (alpha 0.15)  │
│   ║ ░░░░░░░░ ║    na obiekcie           │
│   ╚══════════╝    rodzica               │
│                                         │
│         [ surface mesh obiektu ]        │
└─────────────────────────────────────────┘
```

Parametry wizualne:
- Fill opacity: `0.10–0.20` (ledwo widoczny, nie zasłania obiektu).
- Wireframe opacity: `0.60–0.80` (wyraźne krawędzie shape'a).
- Wybrany (selected) region: fill opacity `0.25`, wireframe `1.0`, grubsza linia.
- Nieaktywny (disabled) region: desaturowany kolor, przerywany wireframe.

#### Tryb B: Realized Membership (po mesh)

Mesh istnieje. Viewport pokazuje **shader overlay na mesh ownera** – elementy/węzły wewnątrz regionu dostają kolor regionu z alpha blending.

Implementacja:

- Warstwa `RegionMembershipOverlayLayer.tsx`.
- Wymaga danych z API: `GET /v2/sessions/current/model/regions/{region_id}/membership` (nowy endpoint, deferred).
- Membership = lista node/element IDs które należą do regionu po materializacji na mesh.
- Overlay: duplikat geometrii mesh ownera z per-vertex `color` attribute ustawionym na kolor regionu tylko dla węzłów wewnątrz regionu.
- Additive blending (`THREE.AdditiveBlending`) lub multiply – rysowane na wierzchu main mesh pass.

**Uwaga:** Tryb B wymaga runtime materialization regionów na mesh, co jeszcze nie istnieje. Dlatego **v1 implementuje tylko Tryb A (authored shape)**. Tryb B jest deferred do momentu, gdy planner/runtime obsłuży `mesh_policy` i `realization_policy`.

### 2.2 Warstwa renderowania – oddzielna od obiektu

Region overlay NIE zmienia shadera samego obiektu. Jest renderowany jako **oddzielna warstwa** (overlay pass):

- Nie ingeruje w pipeline renderowania obiektu (quantity coloring, wireframe, etc.).
- Można włączać/wyłączać overlay niezależnie od visualization mode obiektu.
- Wiele regionów może mieć overlay jednocześnie z różnymi kolorami bez konfliktów.
- Region overlay nie psuje się, gdy użytkownik przełącza active quantity (`m`, `H_demag`, etc.).
- Analogia: tak jak `BoundsBox`/`BoundsVolumeWireframe` jest oddzielną warstwą od mesh surface.

### 2.3 Paleta kolorów regionów

Paleta Catppuccin accent colors, 8 slotów, cyklicznie:

| Slot | Catppuccin Mocha (dark) | Catppuccin Latte (light) | Nazwa |
|---|---|---|---|
| 0 | `#f38ba8` | `#d20f39` | Red |
| 1 | `#fab387` | `#fe640b` | Peach |
| 2 | `#f9e2af` | `#df8e1d` | Yellow |
| 3 | `#a6e3a1` | `#40a02b` | Green |
| 4 | `#94e2d5` | `#179299` | Teal |
| 5 | `#89b4fa` | `#1e66f5` | Blue |
| 6 | `#cba6f7` | `#8839ef` | Mauve |
| 7 | `#f5c2e7` | `#ea76cb` | Pink |

Region index % 8 → kolor. Index to kolejność `priority` (niższy priority = niższy index).

### 2.4 Interaktywny transform gizmo

Zaznaczony region (selected w Explorer) pokazuje transform gizmo w viewport:

- **Translate gizmo** – przesuwanie center regionu w 3D.
- **Scale gizmo** – zmiana rozmiaru (box: width/height/depth, cylinder: radius/height, sphere: radius).
- Gizmo działa w `frame=object` (lokalne współrzędne ownera).
- Zmiana gizmo → natychmiastowy PATCH na `shape.center`/`shape.size` → invalidate region overlay.

Gizmo jest **deferred do v2** – v1 pozwala na edycję numeryczną w inspektorze. Gizmo transform jest znacznie bardziej złożony (snapping, constraints, undo/redo) i nie blokuje MVP.

### 2.5 Integracja z Viewport3DScene

Nowe props w `Viewport3DScene.tsx`:

```tsx
// Region overlay jest renderowany jako grupa dzieci sceny,
// po MeshPartLayer ale przed SelectionHighlightLayer.
{regionOverlayVisible && (
  <RegionOverlayLayer
    objectId={selectedObjectId}
    regions={authoredRegions}
    selectedRegionId={selectedRegionId}
    colors={colors}
    tracker={tracker}
  />
)}
```

Toggle visibility: ribbon button lub visualization panel checkbox „Show region overlay".

---

## 3. Inspector – Regions CRUD Panel

### 3.1 Dwa widoki inspektora

Inspektor rozróżnia dwa selection kinds:

| Selection | Explorer node | Inspector view |
|---|---|---|
| `object.regions` | Klik na „Regions" (gałąź rodzica) | **Lista regionów** z przyciskiem Add Region |
| `object.region` | Klik na konkretny region | **Edycja regionu** z shape/mesh/material/texture |

### 3.2 Widok listy regionów (selection = `object.regions`)

Gdy użytkownik kliknie gałąź **Regions** w Explorer:

```
┌─────────────────────────────────────────┐
│  ▾ Object Regions                  [+]  │  ← przycisk Add Region
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────┐    │
│  │ ● Skyrmion Core                 │    │  ← kliknięcie → zaznacz w Explorer
│  │   priority: 10 · conformal      │    │
│  │   shape: cylinder               │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ ● Edge Softening                │    │
│  │   priority: 5 · inherit         │    │
│  │   shape: box                    │    │
│  └─────────────────────────────────┘    │
├─────────────────────────────────────────┤
│  Total: 2 regions                       │
│  Object: arch_waveguide                 │
└─────────────────────────────────────────┘
```

Elementy:
- Lista kart regionów posortowana po `priority` (malejąco).
- Każda karta: kolorowy dot (kolor z palety §2.3), nazwa, priority, realization policy, shape kind.
- Klik na kartę → zaznacza ten region w Explorer → inspektor przechodzi do widoku edycji.
- Przycisk **[+] Add Region** w headerze sekcji.
- Drag & drop reorder (zmiana priority) – deferred do v2.

### 3.3 Add Region flow

Kliknięcie [+] Add Region:

1. **Inline form** w inspektorze (nie modal, nie dialog):
   ```
   ┌─────────────────────────────────────┐
   │  New Region                         │
   │                                     │
   │  Name: [________________]           │
   │  Shape: [Box ▾]                     │
   │  Priority: [0___]                   │
   │                                     │
   │  [Create]  [Cancel]                 │
   └─────────────────────────────────────┘
   ```

2. Klik **Create** → `POST /v2/sessions/current/model/objects/{objectId}/regions` (nowy endpoint).
3. Serwer tworzy region z domyślnym shape (centered w owner, 50% rozmiaru ownera).
4. Frontend invaliduje resources, nowy region pojawia się w Explorer tree i viewport overlay.
5. Inspektor automatycznie zaznacza nowy region.

### 3.4 Widok edycji regionu (selection = `object.region`)

Gdy użytkownik kliknie konkretny region w Explorer:

```
┌─────────────────────────────────────────┐
│  ▾ Region Identity                      │
│  Name: [Skyrmion Core____]              │
│  ID: reg:skyrmion (read-only)           │
│  Priority: [10__]                       │
│  Enabled: [✓]                           │
│  Realization: conformal                 │
├─────────────────────────────────────────┤
│  ▾ Shape                                │
│  Kind: [Cylinder ▾]                     │
│  Radius: [80_____] nm                   │
│  Height: [2______] nm                   │
│  Center X: [0______] nm                 │
│  Center Y: [0______] nm                 │
│  Center Z: [0______] nm                 │
│  Frame: [Object ▾]                      │
├─────────────────────────────────────────┤
│  ▾ Mesh Policy                          │
│  Enable mesh policy: [✓]               │
│  Max element size: [1______] nm         │
│  Min element size: [1______] nm         │
│  Transition distance: [80____] nm       │
│  Order: [1__]                           │
├─────────────────────────────────────────┤
│  ▾ Material Overrides          [+ Add]  │
│  Ms = 760 kA/m (priority 10)           │
├─────────────────────────────────────────┤
│  ▾ Texture Override                     │
│  [None — inherits object]              │
├─────────────────────────────────────────┤
│  ▾ Diagnostics                          │
│  Realization status: authored_pending   │
│  Node count: — (mesh not built)         │
│  Overlap warnings: none                 │
├─────────────────────────────────────────┤
│  [Apply]  [Revert]  [Delete Region]     │
└─────────────────────────────────────────┘
```

Sekcje:
- **Identity**: name (editable), region_id (read-only), priority (numeric), enabled (checkbox), realization policy (dropdown: inherit/conformal/projection).
- **Shape**: kind (dropdown: box/cylinder/sphere), wymiary (numeric z jednostkami SI, adaptatywne do kind), center (3x input), frame (dropdown: object/world).
- **Mesh Policy**: toggle + parametry meshing lokalne do regionu.
- **Material Overrides**: lista `parameter → value` z priority i conflict_policy. Przycisk [+ Add] dodaje nowy override.
- **Texture Override**: preset picker lub „inherits object".
- **Diagnostics**: read-only status, membership count (po mesh), overlap warnings.
- **Actions**: Apply (PATCH), Revert (reset draft), Delete Region (DELETE + confirm).

### 3.5 Komunikacja z API

Nowe endpointy (write):

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/v2/sessions/current/model/objects/{objectId}/regions` | Tworzenie regionu |
| `PATCH` | `/v2/sessions/current/model/objects/{objectId}/regions/{regionId}` | Edycja regionu |
| `DELETE` | `/v2/sessions/current/model/objects/{objectId}/regions/{regionId}` | Usunięcie regionu |

PATCH body:
```json
{
  "name": "Skyrmion Core",
  "enabled": true,
  "priority": 10,
  "shape": {
    "kind": "cylinder",
    "radius": 80e-9,
    "height": 2e-9,
    "center": [0, 0, 0],
    "axis": [0, 0, 1]
  },
  "frame": "object",
  "mesh_policy": {
    "maximum_element_size": 1e-9,
    "minimum_element_size": 1e-9,
    "transition_distance": 80e-9,
    "order": 1
  },
  "material_overrides": [
    {
      "parameter": "Ms",
      "value": { "kind": "constant", "value": 760e3, "unit": "A/m" },
      "priority": 10,
      "conflict_policy": "error"
    }
  ],
  "realization_policy": "conformal"
}
```

POST body: to samo co PATCH, ale `name` i `shape.kind` wymagane.

DELETE: brak body, zwraca `204 No Content`.

Po każdej mutacji: invalidate `SCENE_RESOURCE_KEY`, `MODEL_REGIONS_RESOURCE_KEY`, `MODEL_MATERIAL_FIELDS_RESOURCE_KEY`.

---

## 4. Explorer ↔ Viewport ↔ Inspector sync

### 4.1 Selection flow

```
Explorer click "Regions"
  → selection.kind = "object.regions"
  → Inspector: RegionsListPanel (lista + Add)
  → Viewport: wszystkie regiony ownera podświetlone (low opacity)

Explorer click "Skyrmion Core"
  → selection.kind = "object.region"
  → selection.regionId = "reg:skyrmion"
  → Inspector: RegionEditPanel (edycja shape/material/mesh)
  → Viewport: ten region podświetlony (high opacity), reszta low opacity

Viewport click na region overlay
  → zaznacz ten region w Explorer
  → Inspector: RegionEditPanel
```

### 4.2 Viewport click detection

Region overlay shape (`<mesh>`) ma handler `onPointerDown`:
- `event.stopPropagation()` – zapobiega zaznaczeniu ownera.
- Dispatch selection z `kind: "object.region"`, `regionId`, `objectId`.

Raycast priority: region overlay (bliżej kamery, semi-transparent) → object surface → airbox.

---

## 5. Implementacja krok po kroku

### Faza 1: Inspector Regions List (v1 – bez API write)

1. Nowy komponent `RegionsListPanel.tsx` – widok listy regionów z kartami.
2. Rozdzielenie `ObjectRegionsPanel` na dwa widoki:
   - `object.regions` → `RegionsListPanel`
   - `object.region` → istniejący `ObjectRegionsPanel` (rozszerzony o shape/mesh/material)
3. Update `inspectorRegistry.tsx` – osobne panele dla `object.regions` vs `object.region`.
4. Przycisk [+ Add Region] w `RegionsListPanel` – disabled z tooltip „Requires write API" do Fazy 3.

### Faza 2: Viewport Region Overlay (v1 – authored shape only)

1. Nowy komponent `RegionOverlayLayer.tsx` w `layers/`.
2. Model danych `regionOverlayModel.ts` – resolve authored regions z snapshot, mapuj shape na Three.js geometry.
3. Paleta kolorów regionów w `viewport3dGeometryColors.ts`.
4. Integracja z `Viewport3DScene.tsx` – conditional render po MeshPartLayer.
5. Click handler na overlay → dispatch region selection.
6. Visibility toggle w visualization store.

### Faza 3: API Write Endpoints

1. Rust: `POST /objects/{objectId}/regions` w `authoring.rs`.
2. Rust: `PATCH /objects/{objectId}/regions/{regionId}` w `authoring.rs`.
3. Rust: `DELETE /objects/{objectId}/regions/{regionId}` w `authoring.rs`.
4. Frontend: `ControlRoomApi.model.createRegion()`, `.patchObjectRegion()`, `.deleteRegion()`.
5. Resource invalidation w obu kierunkach.

### Faza 4: Inspector CRUD (v1 – pełna edycja)

1. Inline Add Region form w `RegionsListPanel`.
2. Shape editor w `ObjectRegionsPanel` – numeric inputs z SI units.
3. Material override editor – parameter/value/priority rows.
4. Mesh policy toggle + fields.
5. Delete Region z confirm dialog.
6. Apply/Revert draft management.

### Faza 5: Transform Gizmo (v2 – deferred)

1. Gizmo translate/scale na zaznaczonym regionie.
2. Snapping do grid/ownera.
3. Undo/redo integracja.

### Faza 6: Realized Membership Overlay (v2 – deferred)

1. `GET /regions/{regionId}/membership` endpoint (po materializacji).
2. Per-vertex color overlay na mesh ownera.
3. Przełącznik authored shape ↔ realized membership w visualization panel.

---

## 6. Pliki do zmiany/dodania

### Nowe pliki

| Plik | Opis |
|---|---|
| `layers/RegionOverlayLayer.tsx` | Viewport overlay: authored shape wireframe + fill |
| `layers/regionOverlayModel.ts` | Shape → Three.js geometry resolution |
| `layers/regionOverlayModel.test.ts` | Testy modelu overlay |
| `panels/RegionsListPanel.tsx` | Inspector: lista regionów z Add button |
| `panels/RegionsListPanelModel.ts` | Model widoku listy regionów |
| `panels/RegionsListPanelModel.test.ts` | Testy modelu listy |

### Modyfikowane pliki

| Plik | Zmiana |
|---|---|
| `inspectorRegistry.tsx` | Rozdzielenie `object.regions` → `RegionsListPanel`, `object.region` → `ObjectRegionsPanel` |
| `ObjectRegionsPanel.tsx` | Rozszerzenie o shape editor, mesh policy, material overrides, delete |
| `ObjectRegionsPanelModel.ts` | Dodanie shape/mesh_policy/material_overrides do modelu |
| `Viewport3DScene.tsx` | Conditional render `RegionOverlayLayer` |
| `viewport3dGeometryColors.ts` | Paleta kolorów regionów |
| `ControlRoomApi.ts` | `createRegion`, `patchObjectRegion`, `deleteRegion` methods |
| `apiPaths.ts` | `MODEL_OBJECT_REGIONS_PATH` |
| `authoring.rs` | POST/PATCH/DELETE handlers |
| `explorerSelection.ts` | Click na overlay → selection dispatch |

---

## 7. Weryfikacja

### Testy jednostkowe

- `regionOverlayModel.test.ts`: shape→geometry, paleta kolorów, visibility rules.
- `RegionsListPanelModel.test.ts`: sortowanie po priority, empty state, badge rendering.
- `ObjectRegionsPanelModel.test.ts`: rozszerzenie o shape draft, mesh policy draft.
- API handler tests: POST/PATCH/DELETE na regionach.

### Testy wizualne

- Playwright smoke: region overlay widoczny na viewport po dodaniu regionu.
- Screenshot: lista regionów w inspektorze z kolorowymi kartami.
- Screenshot: shape editor z numeric inputs.

### Testy manualne

- Dodaj region z inspektora → pojawia się w Explorer i viewport.
- Zmień shape w inspektorze → overlay aktualizuje się w viewport.
- Usuń region → znika z Explorer, viewport, Inspector wraca do listy.
- Przełącz visibility overlay → region overlay znika/pojawia się.
