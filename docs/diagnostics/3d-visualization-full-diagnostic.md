# Pełna diagnostyka wizualizacji 3D — Fullmag Control Room v2

> Data: 2025-05-26  
> Zakres: `apps/control-room/src/modules/viewport-3d/`, kernel API, backend Rust (`crates/fullmag-api/src/`)

---

## 1. Architektura ogólna — stack wizualizacji 3D

```
Backend Rust (fullmag-api)
  ├─ /v2/sessions/current/data/domain/meta          → JSON: DomainMeta
  ├─ /v2/sessions/current/data/domain/topology      → binary: FMMT v1
  ├─ /v2/sessions/current/data/fields/{qty}/samples/vector → binary: FMVP v2
  ├─ /v2/sessions/current/meshing/meshes/shared-domain/manifest → JSON
  ├─ /v2/sessions/current/visualization/state       → JSON: VisualizationStateResource
  └─ WS: /v2/sessions/current/events/ws (fullmag.live.v1)

Frontend (control-room v2)
  ├─ KernelContext → ControlRoomApi → typed resource hooks
  ├─ RealtimeClient (WebSocket JSON events → RealtimeInvalidationBridge)
  ├─ ResourceCache (ETag-based, 96MB topology / 128MB fields / 48MB quality)
  ├─ BinaryDecodeScheduler (Web Worker offload)
  └─ Viewport3DModule → useViewport3DSceneModel → Viewport3DScene (R3F Canvas)
```

---

## 2. Komunikacja frontend–backend

### 2.1 Transport REST (resource-first)

**Ścieżka:**
`useViewport3DSceneModel` → hooki zasobów z `viewport3dResources.ts` → `useResource()` → `ControlRoomApi`

Główne endpointy wizualizacji:

| Zasób | Endpoint | Format | Rewizja |
|---|---|---|---|
| Domain meta | `GET /v2/sessions/current/data/domain/meta` | JSON | `generation_id` |
| Topology (FEM) | `GET /v2/sessions/current/data/domain/topology` | binarny FMMT v1 | ETag |
| Field vector | `GET /v2/sessions/current/data/fields/{qty}/samples/vector` | binarny FMVP v2 | ETag |
| Mesh manifest | `GET /v2/sessions/current/meshing/meshes/shared-domain/manifest` | JSON | `revision` |
| Visualization state | `GET /v2/sessions/current/visualization/state` | JSON | `revision` |
| Mesh quality data | `GET /v2/sessions/current/meshing/meshes/shared-domain/quality` | binarny | ETag |

**Caching:** `ResourceCache` z `maxBytes` (96/128/48 MB) i ETag 304-not-modified. Żądania są deduplikowane przez `useResource()` z kluczem zasobu.

**Nagłówki odpowiedzi dla field vector:**
- `x-fullmag-field-revision`, `x-fullmag-domain-generation-id`, `x-fullmag-quantity-id`
- `x-fullmag-component`, `x-fullmag-encoding: FMVP;version=2`
- `x-fullmag-point-count`, `x-fullmag-value-count`, `x-fullmag-scope-kind`

### 2.2 Transport WebSocket (realtime)

**Protokół:** `fullmag.live.v1` (subprotocol header)  
**Endpoint:** `GET /v2/sessions/current/events/ws`  
**Klasa:** `RealtimeClient` → parsuje JSON → `RealtimeInvalidationBridge`

Obsługiwane typy zdarzeń:
- `resource.batch_changed` — zawiera listę zmian zasobów z `revision` i opcjonalnym `recommended_fetch`
- `resync.required` — wymusza full reload zasobów

**Invalidacja:** `ResourceInvalidationController` mapuje klucze zasobów na rewizje. Zmiana rewizji wyzwala `useResource` do ponownego pobrania.

Zasoby obserwowane przez WS:
- `VISUALIZATION_STATE_PATH`, `MODEL_SCENE_PATH`
- `MESHING_BUILDS_LATEST_SUCCESSFUL_PATH`, `MESHING_SHARED_DOMAIN_MANIFEST_PATH`
- `SIMULATION_SOLVER_STATUS_PATH`, `SIMULATION_STAGES_EXECUTION_PATH`
- `DATA_SCALARS_PATH`, `SIMULATION_OBJECT_METRICS_PATH`

### 2.3 Dekodowanie binarne

**Scheduler:** `BinaryDecodeScheduler` tworzy `Worker` (`fullmag-binary-decode`) dla dekodowania off-main-thread.  
**Fallback:** jeśli `Worker` niedostępny → dekodowanie synchroniczne na main thread.

**Typy koderów:**
- `"field-vector"` → `decodeFieldVector()` → `DecodedFieldVector`
- `"topology"` → `decodeTopology()` → `DecodedTopology`  
- `"mesh-quality-data"` → `decodeMeshQualityData()` → `DecodedMeshQualityData`

---

## 3. Format binarny FMVP v2 (field vector)

```
Offset  Bytes  Znaczenie
0       4      Magic "FMVP"
4       1      Version = 2
5       1      Kind = 1 (f64)
6       1      n_comp (1–3)
7       1      Reserved
8       4      Reserved (flags)
12      4      value_count = gridX * gridY * gridZ * n_comp
16      4      gridX
20      4      gridY
24      4      gridZ
28      16     quantity_id (null-padded ASCII)
44      4      Reserved padding
48      N*8    Float64 values (little-endian)
```

**Walidacja frontend (decodeFieldVector):**
- Sprawdza magic, version=2, kind=1, n_comp ∈ [1,3]
- Weryfikuje `value_count == gridX*gridY*gridZ*n_comp`
- Wyciąga `quantityId` z 16-bajtowego pola

**Walidacja backend (serialize_field_vector_binary_v2):**
- Odrzuca NaN/Inf w wartościach
- Weryfikuje `values.len() == expected_value_count`
- Sprawdza overflow `grid*n_comp`

## 4. Format binarny FMMT v1 (topology)

```
Offset  Bytes  Znaczenie
0       4      Magic "FMMT"
4       1      Version = 1
5       1      Kind = 1 (f64+u32)
6       2      Reserved
8       4      node_count
12      4      element_count
16      4      boundary_face_count
20      4      element_marker_count
24      4      boundary_marker_count
28      4      Reserved
32      N*24   nodes (3×f64)
+       N*16   elements (4×u32)
+       N*12   boundary_faces (3×u32)
+       N*4    element_markers (u32)
+       N*4    boundary_markers (u32)
```

---

## 5. Wybór quantity (active quantity selection)

### 5.1 Poziomy wyboru

```
VisualizationStateResource.active_quantity_id  (compat: globalna kwantyta)
  ↕
VisualizationStateResource.quantity.active_quantity_id  (kanoniczne)
  ↕
VisualizationTargetSettings.activeQuantityId  (per-obiekt override)
```

Każda część mesha, każdy obiekt i airbox może mieć **własny `activeQuantityId`** przez override w `VisualizationTargetSettings`.

### 5.2 Hooki zasobów dla kwantyty

```ts
// Pełne pole (full scope):
useViewport3DFieldVector(quantityId, { component: "full", scope_kind: "full" })

// Airbox per-part:
useViewport3DAirboxFieldVectors(quantityId, airboxParts)
// → key: /v2/.../data/fields/{qty}/samples/vector?component=full&scope_id={partId}&scope_kind=airbox

// Wiele kwantyt równocześnie (per-part multi-quantity):
useViewport3DQuantityFieldVectors(quantityIds)
```

Hooki używają `ResourceCache` z kluczem URL. Zmiana `quantityId` lub `scope_id` → nowy klucz → nowe zapytanie HTTP.

### 5.3 Zmiana kwanty na żywo

Zmiana `activeQuantityId` przez polecenie wizualizacji:
1. Frontend wysyła `PATCH /v2/sessions/current/visualization/state` z nowym `active_quantity_id`
2. Backend aktualizuje `VisualizationStateResource` i emituje `resource.batch_changed` przez WS
3. Invalidacja `VISUALIZATION_STATE_PATH` → re-fetch stanu wizualizacji
4. `useViewport3DFieldVector` z nowym `quantityId` → fetch nowego pola
5. Kolory wektora przeliczane przez `buildVertexScalarColors`

**Znany problem:** Brak szybkiej ścieżki (fast path) dla już-pobranych pól w v2 (fast path istniał w legacy `apps/web`). Każda zmiana kwanty wymaga HTTP GET do backendu.

---

## 6. System shader/materiał

### 6.1 Brak niestandardowych shaderów GLSL

**Ważny fakt:** Fullmag v2 viewport **nie używa custom GLSL shaderów**. Cała wizualizacja opiera się na:
- `MeshStandardMaterial` (Three.js) — powierzchnie magnetyczne i airbox
- `MeshBasicMaterial` — wireframe, glyphs (koniusy/cylindry)
- `LineSegments` z `MeshBasicMaterial` — wireframe edges

Kolorowanie pól (orientation/magnitude/component) jest realizowane **w całości po stronie CPU w TypeScript**, jako `vertexColors` na `BufferGeometry.setAttribute("color", ...)`.

### 6.2 Profile wizualne (Visual Profiles)

| ID | Label | Antialias | DPR cap | Lighting | Tone mapping | Glyph budget |
|---|---|---|---|---|---|---|
| `interactive-lite` | Interactive Lite | false | 1.0 | minimal | none | 700 |
| `interactive` | Interactive | true | 1.25 | studio | aces | 1200 |
| `balanced` | Balanced | true | 1.5 | studio | aces | 2000 |
| `figure` | Figure | true | 2.0 | figure | aces | 3500 |
| `capture` | Capture | true | 4.0 | figure | aces | 5000 |

Domyślny: `"interactive"`.

Profil steruje: `WebGLRenderer.antialias`, `devicePixelRatio` (cap), `toneMapping` (ACESFilmic vs NoToneMapping), `toneMappingExposure`, budżetem glifów wektorów, budżetem voxelowym (FDM).

### 6.3 Profile materiałów (Material Profiles)

Wynikają z visual profile przez `resolveViewport3DMaterialProfile()`:

| Powierzchnia | Właściwości |
|---|---|
| `magneticSurface` | `roughness` 0.72/0.88 (studio/minimal), `metalness: 0`, `emissiveIntensity: 0` |
| `airSurface` | `roughness: 0.92`, `metalness: 0`, `emissiveIntensity: 0.02–0.04` |
| `primitivePreview` | `roughness: 0.68`, `emissiveIntensity: 0.08–0.12` |
| `featureEdges` | `opacity = edgeOpacity * edgeBoost` |
| `glyphs` | `toneMapped: false`, `opacityScale: 0.92–1.0` |
| `selectionShell` | `opacity: 0.72–0.82` |

### 6.4 Polityki renderowania (Render Policies)

Centralna tabela deterministycznych `renderOrder` + depth/blend:

| Semantic | renderOrder | transparent | depthWrite | depthTest | side |
|---|---|---|---|---|---|
| `solidSurface` | 0 | false | true | true | FrontSide |
| `contextSurface` | 10 | true | false | true | FrontSide |
| `airSurface` | 11 | true | false | true | **BackSide** |
| `featureEdges` | 20 | true | false | true | DoubleSide |
| `hiddenEdges` | 21 | true | false | **false** | DoubleSide |
| `selectionShell` | 30 | true | false | true | DoubleSide |
| `glyphs` | 40 | true | false | true | FrontSide |
| `points` | 50 | true | false | true | DoubleSide |

`polygonOffset` aktywny dla surface/selectionShell (factor: 1,1 lub -1,-1), nieaktywny dla edge passes.

---

## 7. Kolorowanie wektora magnetyzacji

### 7.1 Tryby kolorowania

| Tryb | Opis |
|---|---|
| `orientation` | HSL sphere: `hue = atan2(my, mx)`, `saturation = |mxy|`, `lightness = mz*0.5+0.5` |
| `magnitude` | Viridis-like: dark-purple → blue → green → yellow (4 przystanki) |
| `x / y / z` | Liniowy scalar: component mapped do zakresu [min,max] |
| `monochrome` | Płaski kolor (brak vertex colors, material.color) |

Normalizacja nazw: `"hsl"`, `"hslsphere"`, `"hsl_sphere"` → `"orientation"`.

### 7.2 Implementacja orientacji (HSL)

```ts
// magnetizationColor.ts
hue = atan2(my, mx)       // kąt w płaszczyźnie XY
saturation = sqrt(mx²+my²)  // projekcja na XY (= |mxy|)
lightness = mz*0.5 + 0.5    // z → [0,1]
```

RGB wyliczane przez standardowy algorytm HSL→RGB (bez GPU).

### 7.3 Paleta magnitude (Viridis-like)

```
t=0.0: [0x44/255, 0x01/255, 0x54/255] = ciemny fiolet
t=0.33: [0x31/255, 0x68/255, 0x8e/255] = niebieski
t=0.67: [0x35/255, 0xb7/255, 0x79/255] = zielony
t=1.0: [0xfd/255, 0xe7/255, 0x25/255] = żółty
```

Interpolacja liniowa między 4 stopniami.

### 7.4 Pipeline kolorowania (CPU-side)

```
DecodedFieldVector (Float64Array, wartości)
  ↓
buildVertexScalarColors() / buildMappedVertexScalarColors()
  ↓  (> 50k punktów → chunked: setTimeout batching)
ScalarColorBuffer { colors: Float32Array, range: {min,max} }
  ↓
applyVertexScalarColorBuffer(geometry, buffer, vertexCount)
  ↓
BufferGeometry.setAttribute("color", BufferAttribute(Float32Array, 3))
  ↓
MeshStandardMaterial { vertexColors: true, color: 0xffffff }
```

**Limit synchroniczny:** `VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT = 50_000` punktów. Powyżej tej wartości — przetwarzanie chunked przez `setTimeout(0)` w batches po 1024 punkty (lub glyphs).

---

## 8. Rendering meshu (FEM)

### 8.1 Pipeline topologii FEM

```
useViewport3DDomainTopology()
  → GET /v2/.../data/domain/topology  (FMMT v1, cache 96MB)
  → DecodedTopology { positions, indices, boundaryFaces, ... }
  ↓
buildViewport3DTopologyRenderModel(topology, manifest, ...)
  → Viewport3DTopologyRenderModel {
      magneticParts[], airboxParts[],
      positions: Float32Array,
      nodeCount
    }
  ↓
Viewport3DTopologyPartRenderModel per part {
  surfaceIndices: Uint32Array   (z boundary_face_indices)
  edgeIndices: Uint32Array      (z buildSurfaceEdgeIndices)
  volumeEdgeIndices: Uint32Array (dla geometryScope="full")
}
```

### 8.2 MeshPartLayer — co renderuje

Jeden `<MeshPartLayer>` per part mesha:
1. **Surface mesh:** `<mesh>` z `BufferGeometry` (surfaceIndices) + `MeshStandardMaterial` (z vertex colors jeśli pole aktywne)
2. **Edge wireframe:** `<line>` / `<lineSegments>` z edgeIndices
3. **Vectors:** `<VectorFieldLayer>` (instanced glyphs) jeśli `vectorsVisible`
4. **Bounds:** `<BoundsBox>` jeśli `boundsVisible`
5. **Selection highlight:** `<SelectionHighlightLayer>` jeśli part wybrany

### 8.3 Zakres geometrii (geometryScope)

| Wartość | Co renderuje |
|---|---|
| `"surface"` | Tylko boundary faces (surfaceIndices) |
| `"full"` | Wszystkie krawędzie elementów (volumeEdgeIndices) |

Zmiana `geometryScope` → rebuild `edgeGeometry` w `useMemo`.

### 8.4 Tryby renderowania (renderMode)

| Wartość | Widoczność surface | Widoczność wireframe |
|---|---|---|
| `"surface"` | tak | nie |
| `"surface+edges"` | tak | tak (domyślny) |
| `"wireframe"` | nie | tak |
| `"points"` | nie | nie (tylko pointsVisible) |

### 8.5 Staleness (świeżość topologii)

Topologia jest "stale" gdy `scene.revision` ≠ `manifest.source_scene_revision`.  
Gdy topologia nieaktualna: `resolveStaleTopologyVisualizationSettings()` wyłącza renderowanie siatki (pokazuje fallback).  
`FallbackTopologyMeshLayer` renderuje uproszczoną geometrię zastępczą.

---

## 9. Rendering FDM (voxel cuboids)

### 9.1 Pipeline FDM

```
useViewport3DDomainMeta()  → DomainMetaResource (shape, origin, spacing)
  ↓
adaptFdmDomainMeta(meta, displayCellBudget)  → FdmGridRenderDomain
  → stride = ceil(totalCells / displayCellCount)  (subsampling)
  ↓
buildFdmCuboidInstanceModel(domain, fieldVector, options)
  → FdmCuboidInstanceModel {
      cellSize, cellIndices: Uint32Array,
      centers: Float32Array, count
    }
  ↓
FdmCuboidLayer: InstancedMesh (BoxGeometry) + MeshStandardMaterial
```

### 9.2 Batched upload

`FDM_CUBOID_UPLOAD_BATCH_SIZE = 2048` instancji per tick (`setTimeout(0)`). Zapobiega zamrożeniu UI przy dużych siatkach.

### 9.3 Voxel topography (FDM)

Dostępny parametr w visual profile:
```ts
voxelTopography: {
  amplitudeCells: number,   // amplituda wychylenia
  component: "z" | "x" | "y" | "magnitude",
  enabled: boolean          // domyślnie: false we wszystkich profilach
}
```

**Status: nieaktywne** — `enabled: false` we wszystkich profilach. Kod istnieje w `buildFdmCuboidInstanceModel()` ale nie jest wywoływany w produkcji.

### 9.4 Budżet komórek wyświetlanych

`displayCellBudget` → kontroluje ile voxeli renderować (subsampling). Domyślnie pobierany ze stanu wizualizacji. Przy dużych siatkach FDM może nastąpić znaczące przerzedzenie.

---

## 10. Primitives (pre-mesh geometry)

### 10.1 Obsługiwane prymitywy

| Typ | Geometria Three.js |
|---|---|
| `"box"` | `BoxGeometry` |
| `"cylinder"` | `CylinderGeometry` |
| `"sphere"` | `SphereGeometry` |
| `"unsupported"` | Fallback (nie renderowany) |

Rozpoznanie typu geometrii: `lowerGeometryKind()` dopasowuje `"box"|"film"|"cuboid"` → box, `"cylinder"|"disk"` → cylinder, `"sphere"` → sphere.

### 10.2 Stany prymitywu

```
"primitive-only"  → rendering primitywu (mesh jeszcze nie zbudowany)
"mesh-stale"      → mesh nieaktualny (pokazuje prymityw z ostrzeżeniem)
"mesh-failed"     → mesh nie udał się (pokazuje prymityw)
"mesh-ready"      → mesh gotowy (prymityw ukryty, mesh aktywny)
```

### 10.3 Magnetization texture preview

Podgląd inicjalizacji magnetyzacji dla prymitywów (przed meshem):

| Preset | Kolor podglądu |
|---|---|
| `vortex` | `[0.153, 0.769, 0.910]` (cyjan) |
| `bloch_skyrmion`, `neel_skyrmion` | `[0.76, 0.33, 0.94]` (fiolet) |
| `antivortex` | `[0.98, 0.49, 0.49]` (różowy) |
| `domain_wall` | `[0.94, 0.87, 0.31]` (żółty) |
| `two_domain` | `[0.95, 0.52, 0.19]` (pomarańczowy) |
| `helical` | `[0.45, 0.73, 0.98]` (błękitny) |
| `conical` | `[0.99, 0.64, 0.69]` (różowy jasny) |
| `random_seeded` | `[0.263, 0.820, 0.478]` (zielony) |
| domyślny | `[0.624, 0.710, 1.0]` (niebieski jasny) |

---

## 11. Wektory pola (glyphs)

### 11.1 Geometria glifów

Każdy wektor = głowa (stożek `ConeGeometry`) + trzon (cylinder `CylinderGeometry`), renderowane jako `InstancedMesh`.

Proporcje:
- `head_radius_ratio = 0.20 * thickness`
- `shaft_radius_ratio = 0.08 * thickness`

### 11.2 Budżet wektorów

- Budżet per part: `settings.vectorBudget` (domyślnie `1200` z `DEFAULT_OBJECT_VISUALIZATION`)
- `maxVectorGlyphs` z profilu wizualnego (700–5000)
- Dla airbox: `DEFAULT_AIRBOX_VECTOR_BUDGET = 1200` (backend)

### 11.3 Upload batchowany

`VECTOR_GLYPH_UPLOAD_BATCH_SIZE = 1024` instancji per tick. Dla dużych pól — progressywne wypełnianie macierzy instancji.

### 11.4 Centering / tail mode

- `vectorCenteringEnabled: true` → glyph wyśrodkowany (anchor: `"center"`)
- `vectorCenteringEnabled: false` → glyph od końca (anchor: `"tail"`)

### 11.5 Surface offset

`vectorSurfaceOffsetEnabled / vectorSurfaceOffsetScale` — przesunięcie glifów od powierzchni sieci (do inspekcji glifów powierzchniowych).

---

## 12. Post-processing

### 12.1 Efekty

| Efekt | Biblioteka | Domyślnie |
|---|---|---|
| Ambient Occlusion | `@react-three/postprocessing` N8AO | wyłączone |
| Bloom | `@react-three/postprocessing` Bloom | wyłączone |
| MSAA Antialias | `EffectComposer` multisampling=4 | 0 gdy brak PP |

Konfiguracja w `PostProcessingLayer.tsx`:
- `N8AO: aoRadius=0.5, intensity=2.5, halfRes=true`
- `Bloom: luminanceThreshold=0.5, luminanceSmoothing=0.1, intensity=1.2`

**Uwaga:** `EffectComposer` z `multisampling=0` gdy PP jest aktywny ale antialias wyłączony. Gdy PP jest nieaktywny — brak `EffectComposer`, antialias przez Canvas `gl.antialias` (ustawiane per profil wizualny).

### 12.2 Tone mapping

Profil `interactive`/`balanced`/`figure`/`capture` → `ACESFilmicToneMapping` (Three.js)  
Profil `interactive-lite` → `NoToneMapping`

Konfigurowane przez `configureViewport3DRenderer()` na `WebGLRenderer`.

---

## 13. Nakładka jakości mesha (Mesh Quality Overlay)

### 13.1 Metryki

| Metryka | Opis |
|---|---|
| `sicn` | Scaled Inscribed Circle (SICN) — jakość kształtu elementu |
| `gamma` | Aspect ratio |
| `volume` | Objętość elementu |

Źródło: `GET /v2/sessions/current/meshing/meshes/shared-domain/quality` (binarny codec `DecodedMeshQualityData`).

### 13.2 Mapping kolorów jakości

- Per element → uśrednianie node-wise (każdy węzeł = średnia elementów sąsiadujących)
- Paleta: Viridis-like (`magnitudeColorRgb`)
- Cache: `WeakMap<DecodedTopology, WeakMap<DecodedMeshQualityData, ...>>` — automatyczne GC

### 13.3 Override mechanizm

Gdy `meshQualityOverlayVisible=true`: `meshQualityColors` zastępuje `effectiveScalarColors` w `MeshPartLayer`. Pole fizyczne nie jest renderowane gdy nakładka jakości jest aktywna.

---

## 14. Zarządzanie zasobami GPU (Resource Tracker)

`Viewport3DResourceTracker` (`viewport3dDiagnostics.ts`):
- `track(kind, resource)` → rejestruje zasób (geometry, texture, material)
- `release(kind, resource)` → wywołuje `resource.dispose()` + dekrement licznika
- `recordDirtyFrame(reason)` → diagnostyki (ostatnia zmiana, powód)

Geometrie są tworzone w `useMemo` i zwalniane przez `useEffect` cleanup. Zapobiega wyciekom pamięci GPU przy przełączaniu scen.

---

## 15. Kamera

### 15.1 Tryby projekcji

| Tryb | Kamera Three.js |
|---|---|
| `perspective` | `PerspectiveCamera` (FOV=42°) |
| `orthographic` | `OrthographicCamera` |

### 15.2 Orbiting

`CameraControls` (custom, nie `OrbitControls` drei) — obsługuje:
- tryb `"camera"` (orbita wokół punktu docelowego)
- tryb `"object"` (rotacja obiektu)
- debuga z kontrolkami `orbitDebugAngles`

### 15.3 Clip planes

Dynamiczne near/far z `resolveViewport3DProjectionCameraClip()`:
- `near` z `fit.near` (na podstawie bounds radius)
- `far = max(fit.far, distance+radius*4, near*100, 1e-3)`

Zapobiega Z-fighting przy dużych rozpiętościach skali.

### 15.4 Ortho zoom

`resolveViewport3DOrthographicZoom()` oblicza zoom tak by cały model mieścił się w viewport z marginesem 60%.

---

## 16. Kolorystyka tokeny CSS

Viewport pobiera kolory ze zmiennych CSS `--fm-*`:

| Zmienna CSS | Rola |
|---|---|
| `--fm-accent` | kolor akcentu (glyphs, selekcja) |
| `--fm-accent-strong` | mocniejszy akcent |
| `--fm-bg-viewport` | tło canvasu |
| `--fm-surface-3` | kolor meshu (surface) |
| `--fm-text-muted` | kolor wireframe |
| `--fm-syntax-string` | kolor field (wektory) |
| `--fm-bg-panel` | panel background |
| `--fm-bg-panel-raised` | panel raised |

Odczytywane przez `readViewport3DColorsFromStyles()` z `getComputedStyle()` na starcie. Retry do 120 razy co 50ms jeśli tokeny CSS nie są gotowe (SSR-safe).

---

## 17. System vizualizacji stan/overrides

### 17.1 Hierarchia ustawień wizualizacji

```
DEFAULT_OBJECT_VISUALIZATION  (globalny fallback)
  ↓ merge z
VisualizationStateResource.targets.{airbox,objects,parts}[id].settings
  ↓ merge z
VisualizationStateResource.overrides[].settings
  ↓ = effectiveSettings per target
```

Każdy target (obiekt, part, airbox) ma:
- `renderMode`: `points | surface | surface+edges | wireframe`
- `shaderVisible`, `wireframeVisible`, `vectorsVisible`, `boundsVisible`, `pointsVisible`
- `surfaceColorSource`: `solid | orientation | component_x/y/z | magnitude | colormap`
- `vectorColorMode`: `orientation | x | y | z | magnitude | monochrome`
- `opacityPercent`, `vectorAlphaPercent`, `vectorBudget`, `vectorThickness`
- `vectorLengthScale`, `vectorCenteringEnabled`, `vectorSurfaceOffsetEnabled/Scale`
- `geometryScope`: `surface | full`

### 17.2 Patching przez komendy

`visualizationCommandContributions.ts` eksponuje komendy do:
- `patchSelectedTarget()` — zmienia ustawienia wybranego obiektu/partu/airbox
- `patchVisualizationState()` — aktualizuje globalny stan `VisualizationStateResource`
- `clearTargetOverrideResource()` — usuwa override

Patch trafia na: `PATCH /v2/sessions/current/visualization/state` (JSON merge patch).

### 17.3 Optimistic updates

`VisualizationRegistrySyncController` przechowuje lokalnie zoptymistyczny stan pending.  
`useVisualizationStateResource()` zwraca `optimisticData = sync.applyOptimisticState(resource.data)` — natychmiastowa odpowiedź UI bez oczekiwania na potwierdzenie backendu.

---

## 18. Client Ack (potwierdzenie renderowania)

Frontend potwierdza renderowanie backendu przez:
- `POST /v2/sessions/current/visualization/client-acks`
- Body: `{ client_id, viewport_id, revision, status: "applied"|"rendered"|"failed", effective_render_mode? }`

Wyzwalany przez `onVisualizationFrameCommitted(revision)` callback po każdej klatce R3F.

---

## 19. Frame loop i invalidacja

- R3F `frameloop = "demand"` — rysuje tylko gdy wymagane
- `useBatchedInvalidate()` — debounced `invalidate()` z `@react-three/fiber`
- `viewport3dBatchedInvalidate.ts` → jednorazowe wywołanie `invalidate()` per klatka reagując na wiele zmian

Powody invalidacji rejestrowane przez tracker:
- `"field-colors"` — zmiana kolorów pola
- `"mesh-quality-colors"` — zmiana nakładki jakości
- `"primitive-geometry"` — zmiana geometrii prymitywu
- `"topology"` — zmiana topologii

---

## 20. Wykryte problemy i luki

### P1 — Brak fast path dla kwanty w v2

**Problem:** Legacy `apps/web` miał `requestPreviewQuantity` z fast-path omijającym POST gdy kwanta już w cache. W v2 każda zmiana `activeQuantityId` wymaga HTTP GET do `/v2/.../data/fields/{qty}/samples/vector`.

**Wpływ:** Opóźnienie przełączania kwanty (widoczne przy szybkim przełączaniu orientation → magnitude → x/y/z).

**Rekomendacja:** Dodać `prefetchFieldVector(quantityId)` w `useViewport3DSceneModel` gdy użytkownik hover nad przyciskiem kwanty.

---

### P2 — Coloring CPU-side: brak GPU shader coloring

**Problem:** Cały pipeline kolorowania jest CPU-side TypeScript → `Float32Array` → GPU vertex buffer. Przy ~500k węzłów (fine mesh) jedno przeliczenie kolorów to >1.5M float operacji na main thread.

**Wpływ:** Stuttering przy zmianie trybu koloru dla dużych meshów.

**Istniejący mitygant:** Chunked processing (`setTimeout`, batch 1024) + threshold 50k punktów dla synchronicznego.

**Rekomendacja:** Przenieść kolorowanie do WebGL shader jako uniform/texture LUT. Wymaga niestandardowego `ShaderMaterial`.

---

### P3 — Surface edge deduplication: potencjalny overflow

**Problem:** `buildSurfaceEdgeIndices()` używa Cantor pairing hash:
```ts
key = maxVal * maxVal + minVal  // dla maxVal >= 0, minVal < maxVal
```
Dla `maxVal > sqrt(MAX_SAFE_INTEGER) ≈ 94_906_265` → hash przekracza `Number.MAX_SAFE_INTEGER`.

**Wpływ:** Duplikowane krawędzie dla dużych meshów (>94M węzłów — mało prawdopodobne w praktyce dla obecnych benchmarków, ale możliwe dla dużych siatek FEM).

**Rekomendacja:** Zamienić na `Set<string>` z kluczem `"${min}_${max}"` lub użyć sorted pair encoding w `BigInt`.

---

### P4 — Brak renderowania punktów (points mode)

**Problem:** `VisualizationTargetSettings.pointsVisible = true` nie renderuje chmury punktów węzłów mesha. `BoundsPoints` renderuje tylko 8 narożników bounding boxa, nie węzły mesha.

**Wpływ:** Wybór `renderMode = "points"` lub `pointsVisible = true` nie daje oczekiwanego efektu (widoczność węzłów sieci).

**Rekomendacja:** Dodać `<PointsLayer>` z `THREE.Points` geometry używający `topologyModel.positions`.

---

### P5 — Voxel topography FDM nieaktywne

**Problem:** Kod dla topografii voxelowej FDM (`voxelTopography: { enabled, amplitudeCells, component }`) jest zaimplementowany w `buildFdmCuboidInstanceModel()` ale `enabled: false` we wszystkich profilach wizualnych. Brak UI do aktywacji.

**Wpływ:** Funkcja istnieje ale jest nieosiągalna przez użytkownika.

**Rekomendacja:** Dodać toggle do `Viewport3DSettingsDialog` lub ribbon FDM.

---

### P6 — PostProcessing: EffectComposer vs canvas antialias konflikt

**Problem:** Gdy `effectAmbientOcclusion = true` lub `effectBloom = true`, używany jest `EffectComposer`. Gdy efekty są wyłączone — antialias przez native `gl.antialias = true` (per profil). Przełączenie PP w trakcie sesji nie resetuje `WebGLRenderer.antialias` (jest immutable po created).

**Wpływ:** Toggling AO/Bloom może powodować zmianę jakości AA bez reload canvasu.

**Rekomendacja:** Zawsze używać `EffectComposer` z `multisampling` gdy profil ma `antialias: true`.

---

### P7 — Topology staleness: brak komunikatu UI

**Problem:** Gdy `isViewport3DTopologyCurrent = false` (topologia nieaktualna), `FallbackTopologyMeshLayer` renderuje uproszczoną geometrię zastępczą, ale brak toast/overlay informującego użytkownika dlaczego mesh wygląda inaczej.

**Wpływ:** Użytkownik może nie rozumieć dlaczego geometria wygląda niepoprawnie.

**Rekomendacja:** Dodać toast lub overlay z informacją "Mesh topology is rebuilding..." gdy stale.

---

### P8 — Brak wsparcia colormap (palette-based coloring)

**Problem:** `surfaceColorSource = "colormap"` jest zdefiniowane w typach i schemacie backendu, ale `surfaceColorSourceToColorMode("colormap")` zwraca wartość która nie jest obsługiwana przez `buildVertexScalarColors()` (fallback do `null`). Brak możliwości wyboru palety kolorów przez użytkownika (inferno, plasma, coolwarm itp.).

**Wpływ:** Tryb `colormap` jest de-facto niedziałający.

**Rekomendacja:** Zaimplementować `buildColormapScalarColors()` z wsparciem dla co najmniej Viridis, Inferno, Coolwarm, RdBu.

---

### P9 — Brak obsługi dużych siatek FEM (chunked topology)

**Problem:** Topologia FEM jest ładowana jednorazowo jako pełny binary blob (FMMT v1). Dla meshów >1M węzłów: ~72MB dla pozycji + ~16MB dla elementów = ~88MB single request.

**Wpływ:** Długi czas pierwszego load, brak streamingu.

**Rekomendacja:** Rozważyć chunked/streamed topology protocol lub kompresję (LZ4/Zstd) na poziomie FMMT.

---

### P10 — Brak walidacji zakresu `n_comp` dla kvantyt FEM

**Problem:** Backend koduje `n_comp` bazując na polach FEM, ale frontend `decodeFieldVector()` akceptuje `n_comp ∈ [1,3]`. Dla bardziej złożonych pól (tensor, 6-komponentowy stres) format FMVP nie wystarczy.

**Wpływ:** Ograniczenie do wektorów 3D i skalarów. Brak wsparcia tensor quantities.

---

## 21. Podsumowanie architektury — mapa komponentów

```
Viewport3DModule (główny React component)
├── useViewport3DColors() → CSS token → Viewport3DColors
├── useViewport3DCommandState() ← viewport3dStore (useSyncExternalStore)
├── useViewport3DSceneModel() ← główna logika danych
│   ├── useViewport3DDomainMeta() → FdmGridRenderDomain
│   ├── useViewport3DSharedDomainManifest() → FemManifestRenderDomain  
│   ├── useViewport3DDomainTopology() → DecodedTopology
│   ├── useViewport3DFieldVector(activeQty) → DecodedFieldVector
│   ├── useViewport3DAirboxFieldVectors(activeQty, airboxParts) → Map
│   ├── useViewport3DMeshQualityData() → ScalarColorBuffer (quality)
│   ├── useViewport3DScene() → SceneResource (prymitywy)
│   ├── useVisualizationStateResource() → VisualizationStateResource
│   ├── useObjectVisualizationSelector() → ObjectVisualizationSnapshot
│   └── useViewport3DChunkedScalarColors() → ScalarColorBuffer (async)
└── Viewport3DScene (R3F Canvas, frameloop="demand")
    ├── Viewport3DLightingRig (directional + ambient lights)
    ├── CameraControls / OrbitCameraControls
    ├── CanvasLifecycleProbe (WebGL context monitoring)
    ├── PrimitiveObjectLayer (Box/Cylinder/Sphere pre-mesh)
    ├── TopologyMeshLayer
    │   └── MeshPartLayer × N (per FEM mesh part)
    │       ├── <mesh> surface (MeshStandardMaterial + vertexColors)
    │       ├── <lineSegments> wireframe
    │       └── VectorFieldLayer (InstancedMesh glyphs)
    ├── FdmCuboidLayer (InstancedMesh voxels)
    ├── AirboxLayer / DomainBoxLayer
    ├── SelectionHighlightLayer
    ├── BoundsLayers
    ├── DimensionFrameLayer (scale bars)
    ├── OrientationHudLayer (view cube)
    └── PostProcessingLayer (N8AO + Bloom gdy aktywne)
```

---

## 22. Checklist weryfikacji

- [x] Komunikacja REST (resource-first, ETag cache) — **OK**
- [x] Komunikacja WebSocket (invalidacja przez `resource.batch_changed`) — **OK**
- [x] Dekodowanie binarne FMVP v2 (field vector) — **OK, Worker + inline fallback**
- [x] Dekodowanie binarne FMMT v1 (topology) — **OK**
- [x] Wybór kwanty (global + per-object override) — **OK, brak fast path (P1)**
- [x] Wybór trybu koloru (orientation/magnitude/x/y/z/monochrome) — **OK**
- [x] Kolorowanie CPU-side (HSL, Viridis-like, scalar) — **OK, perf risk na dużych meshach (P2)**
- [x] Material profiles (surface roughness/metalness) — **OK**
- [x] Render policies (z-ordering, depth) — **OK**
- [x] Profil wizualny (interactive/balanced/figure/capture) — **OK**
- [x] Post-processing (AO, Bloom, MSAA) — **OK, ale konflikt antialias (P6)**
- [x] Tone mapping (ACESFilmic per profil) — **OK**
- [x] FEM surface rendering (surfaceIndices z boundaryFaces) — **OK**
- [x] FEM edge rendering (deduplication Cantor pairing) — **OK, overflow risk (P3)**
- [x] FEM geometryScope (surface vs full edges) — **OK**
- [x] FEM topologia staleness detection — **OK, brak UI feedback (P7)**
- [x] FDM voxel cuboids (InstancedMesh, stride subsampling) — **OK**
- [x] FDM voxel topography — **NIEAKTYWNE (P5)**
- [x] Primitives (Box/Cylinder/Sphere) — **OK**
- [x] Magnetization texture preview colors — **OK**
- [x] Points mode (`pointsVisible`) — **NIEKOMPLETNE (P4)**
- [x] Colormap mode — **NIEKOMPLETNE (P8)**
- [x] Mesh quality overlay (SICN/gamma/volume) — **OK**
- [x] Kamera (perspective/orthographic, near/far) — **OK**
- [x] Kamera ortho zoom fit — **OK**
- [x] CSS token colors — **OK (z retry loop)**
- [x] Client Ack (frame commit) — **OK**
- [x] Invalidacja batchowana (frameloop demand) — **OK**
- [x] Resource tracker (GPU dispose) — **OK**
- [x] Binary decode Worker (off-main-thread) — **OK**
- [x] Chunked scalar color (>50k pts → setTimeout) — **OK**
- [x] Airbox wektory (scope_kind=airbox per-part) — **OK**
- [x] Selection highlight — **OK**
- [x] Dimension frame (scale bars) — **OK**
- [x] View cube (OrientationHud) — **OK**
- [x] SSR-safe hydration (useSyncExternalStore) — **OK**
