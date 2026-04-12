# Plan: Rozbudowa podglądu 2D — FEM Cross-Section Visualization

**Status:** Draft  
**Author:** AI assistant  
**Date:** 2025-07-15  
**Scope:** `apps/web/components/preview/FemMeshSlice2D.tsx` and related viewport plumbing

---

## 1. Obecny stan i diagnoza problemu

### 1.1. Aktualny kod

Komponent `FemMeshSlice2D.tsx` (1052 linii) już istnieje i zawiera:

- **Typy:** `SlicePlane = "xy" | "xz" | "yz"`, `VectorComponent = "x" | "y" | "z" | "magnitude"`
- **Algorytm przecięcia siatki:** `collectBoundarySegments()` i `collectTetraSegments()` — przecinają
  płaszczyzną odpowiednio trójkąty brzegowe i tetraedry objętościowe
- **Interpolacja wartości:** liniowa na krawędziach (parametr `t` wzdłuż krawędzi tet/face)
- **Renderowanie Canvas2D:** rysowanie wielokątów (polygon fill), segmentów brzegowych, kolorbar, probe
- **Kontrolki:** proste przyciski XY/XZ/YZ + slider `sliceIndex` (dyskretny, integer 0..sliceCount-1)
- **Probe:** hover/click → `pointInPolygon` + `distanceToSegment` → wartość pola

### 1.2. Czego brakuje / co nie działa

| Problem | Opis |
|---------|------|
| **Brak ciągłego pozycjonowania** | Slider operuje na dyskretnym `sliceIndex ∈ [0, sliceCount-1]` zamiast ciągłej pozycji w metrach. Przy małym `sliceCount` (domyślnie 25) rozdzielczość jest zbyt niska. |
| **Brak filtrowania domen** | Przecina WSZYSTKIE elementy siatki (air + ferromagnets + interface). Nie respektuje `meshEntityViewState`, `objectViewMode`, `airSegmentVisible`, `vectorDomainFilter`. |
| **Brak trybu izolacji** | W 3D istnieje `objectViewMode: "isolate"` — w 2D nie ma odpowiednika. |
| **Jednokolorowe polygony** | Każdy polygon tetraedra wypełniony jest jednym kolorem (`avgValue`). Brak gradientu wewnątrz polygonu — wygląda "blokowe" przy dużych elementach. |
| **Brak renderowania wektorowego** | 2D pokazuje tylko heatmapę skalara, nie ma opcji nałożenia strzałek pola (quiver plot). |
| **Problem wydajności** | `collectTetraSegments()` iteruje po WSZYSTKICH elementach w każdym renderze (bez spatial indexing). Dla siatek 100k+ elementów jest to odczuwalne. |
| **Brak synchronizacji z 3D** | Clip plane position w 3D toolbar nie jest zsynchronizowany ze slice position w 2D. |
| **Brak skali/legendy kontekstowej** | Kolorbar pokazuje surowe `min/max` — brak smart scaling jak w `MagnetizationSlice2D` (magnetyzacja: `[-1,1]`, pola: symetryczne). |
| **Brak toolbara 2D** | FDM `MagnetizationSlice2D` ma wbudowane kontrolki, ale FEM 2D ma tylko prosty bottom overlay. Brak integracji z głównym toolbarem viewportu. |

### 1.3. Przepływ danych (obecny)

```
ControlRoomContext
  └─ useFemMeshDerived.ts
       ├─ femMeshBase (nodes, elements, boundaryFaces)
       ├─ femFieldData ({x, y, z} Float64Array)
       └─ femMeshData: FemMeshData { ...base, fieldData, activeMask, quantityDomain }
            │
ViewportPanels.tsx
  ├─ effectiveViewMode === "3D" && isFEM → <FemMeshView3D />
  └─ effectiveViewMode === "2D" && isFEM → <FemMeshSlice2D meshData={ctx.femMeshData} />
```

Kluczowe: `FemMeshData` **nie zawiera** informacji o mesh parts, element markers, ani per-domain visibility.

---

## 2. Cele rozbudowy

### 2.1. Must-have (MVP)

1. **Ciągły slider pozycji płaszczyzny** — pozycja w metrach, nie dyskretny index
2. **Filtrowanie domen** — respektowanie `meshEntityViewState`, air visibility, objectViewMode
3. **Element markers → domain coloring** — kolorowanie domen nawet bez danych polowych
4. **Smart colorbar** — identyczna logika jak w FDM (`[-1,1]` dla magnetyzacji, symetryczna dla pól)
5. **Toolbar 2D** — plane selector + continuous slider zintegrowany z toolbarem viewportu
6. **Synchronizacja z clip plane 3D** — zmiana slice position w 2D aktualizuje clip w 3D (i odwrotnie)

### 2.2. Should-have

7. **Smooth gradient fill** — per-vertex interpolacja w obrębie polygonu (zastąpienie flat fill)
8. **Quiver plot overlay** — opcjonalne strzałki wektorowe nałożone na heatmapę
9. **Probe z koordynatami** — wyświetlanie (x, y, z) w metrach, wartości pola, nazwy domeny
10. **WebGL rendering** — migracja z Canvas2D do WebGL dla płynności przy dużych siatkach

### 2.3. Nice-to-have

11. **Spatial indexing** — BVH/grid subdivision dla tetrahedrów — O(log n) zamiast O(n) intersection test
12. **Realistic projection** — tryb "rzut 3D→2D" z perspektywą (slice w otoczeniu mesh outline)
13. **Animacja między krokami** — płynna interpolacja pola przy przełączaniu time steps
14. **Multi-plane** — jednoczesne wyświetlanie 2-3 płaszczyzn (np. XY + XZ + YZ w panelach)

---

## 3. Architektura rozwiązania

### 3.1. Podział modułów

Obecny `FemMeshSlice2D.tsx` (1052 linii) łamie regułę ~1000 linii i jest monolityczny.
Rozwiązanie: podział na moduły w nowym katalogu.

```
apps/web/components/preview/fem-slice/
├── index.ts                       # re-export
├── FemSlice2DView.tsx             # główny komponent React (~200 linii)
├── FemSlice2DToolbar.tsx          # toolbar ze sliderem i plane selector (~150 linii)
├── FemSlice2DCanvas.tsx           # Canvas/WebGL rendering (~300 linii)
├── FemSlice2DProbe.tsx            # probe overlay + tooltip (~100 linii)
├── sliceGeometry.ts               # algorytmy przecięcia siatki (~250 linii)
├── sliceDomainFilter.ts           # filtrowanie elementów po domain/part state (~100 linii)
├── sliceColorMapping.ts           # kolorowanie + smart scales (~80 linii)
├── sliceInterpolation.ts          # barycentric interpolation, gradient fill (~120 linii)
└── types.ts                       # typy, interfejsy (~40 linii)
```

**Szacunk łącznie:** ~1340 linii w 10 plikach (vs 1052 w jednym monolicie)

### 3.2. Interfejs nowego komponentu

```typescript
// FemSlice2DView — top-level component
interface FemSlice2DViewProps {
  // Data
  meshData: FemMeshData;
  meshParts: FemMeshPart[];
  elementMarkers: Int32Array | null;
  
  // Quantity
  quantityLabel: string;
  quantityId: string;
  component: VectorComponent;
  
  // Plane control
  plane: SlicePlane;
  planePosition: number;          // ← NOWE: pozycja w metrach
  onPlaneChange?: (plane: SlicePlane) => void;
  onPlanePositionChange?: (position: number) => void;
  
  // Domain filtering
  meshEntityViewState: MeshEntityViewStateMap;
  airSegmentVisible: boolean;
  airSegmentOpacity: number;
  objectViewMode: ObjectViewMode;
  vectorDomainFilter: FemVectorDomainFilter;
  visibleObjectIds: Set<string>;
  
  // Overlays
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;
  
  // Options
  showQuiverOverlay?: boolean;
  quiverDensity?: number;          // strzałki / 100px
  gradientFill?: boolean;          // smooth vs flat fill
  showElementEdges?: boolean;
}
```

### 3.3. Przepływ danych (nowy)

```
ControlRoomContext
  └─ useFemMeshDerived.ts
       ├─ femMeshData: FemMeshData
       ├─ meshParts: FemMeshPart[]
       └─ elementMarkers: Int32Array
            │
ViewportPanels.tsx
  └─ effectiveViewMode === "2D" && isFEM
       │
       ▼
  <FemSlice2DView
      meshData={ctx.femMeshData}
      meshParts={ctx.meshParts}
      elementMarkers={ctx.effectiveFemMesh?.element_markers}
      meshEntityViewState={ctx.meshEntityViewState}
      airSegmentVisible={ctx.airMeshVisible}
      objectViewMode={ctx.objectViewMode}
      vectorDomainFilter={ctx.femVectorDomainFilter}
      visibleObjectIds={visibleObjectIds}
      plane={ctx.plane}
      planePosition={ctx.slicePlanePosition}             // ← NOWE
      onPlanePositionChange={ctx.setSlicePlanePosition}   // ← NOWE
      ... />
```

---

## 4. Szczegółowy plan implementacji

### Faza 1: Nowa infrastruktura typów i filtrowania (0.5d)

**Cel:** Przygotowanie wspólnych typów i logiki filtrowania domen, zanim ruszy refaktor komponentu.

**Plik:** `fem-slice/types.ts`

```typescript
export type SlicePlane = "xy" | "xz" | "yz";
export type VectorComponent = "x" | "y" | "z" | "magnitude";

export interface SliceConfig {
  plane: SlicePlane;
  position: number;       // pozycja płaszczyzny w metrach wzdłuż osi normalnej
  epsilon: number;         // computed automatycznie z mesh extents
}

export interface SlicePolygon {
  /** Wierzchołki 2D w układzie (u, v) po projekcji */
  points: [number, number][];
  /** Wartości w wierzchołkach (per-vertex interpolation) */
  vertexValues: number[];
  /** Avg wartość (fallback do flat fill) */
  avgValue: number;
  /** Domain marker elementu źródłowego */
  domainMarker: number;
  /** Part ID elementu źródłowego */
  partId: string | null;
}

export interface SliceSegment {
  a: [number, number];
  b: [number, number];
  va: number;
  vb: number;
}

export interface SliceResult {
  config: SliceConfig;
  normalAxis: number;       // 0=x, 1=y, 2=z
  uAxis: number;
  vAxis: number;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  polygons: SlicePolygon[];
  segments: SliceSegment[];
  valueRange: { min: number; max: number };
  domainMarkers: Set<number>;
}
```

**Plik:** `fem-slice/sliceDomainFilter.ts`

```typescript
/**
 * Buduje maskę elementów do przetwarzania na podstawie:
 * - meshParts → element_start + element_count per part
 * - elementMarkers → domain marker per element
 * - meshEntityViewState → visible per part
 * - airSegmentVisible
 * - objectViewMode + visibleObjectIds
 */
export function buildElementVisibilityMask(
  nElements: number,
  meshParts: FemMeshPart[],
  elementMarkers: Int32Array | null,
  meshEntityViewState: MeshEntityViewStateMap,
  airSegmentVisible: boolean,
  objectViewMode: ObjectViewMode,
  visibleObjectIds: Set<string>,
): Uint8Array;
```

Logika:
1. Alokuj `Uint8Array(nElements)`, domyślnie 0 (ukryty).
2. Dla każdego `FemMeshPart`:
   - Sprawdź `meshEntityViewState[part.id]?.visible` — jeśli false → skip.
   - Jeśli `part.role === "air"` i `!airSegmentVisible` → skip.
   - Jeśli `objectViewMode === "isolate"` i `!visibleObjectIds.has(part.object_id)` → skip.
   - Oznacz elementy `[part.element_start, part.element_start + part.element_count)` jako 1.

### Faza 2: Continuous plane positioning (0.5d)

**Cel:** Zamiana dyskretnego `sliceIndex`/`sliceCount` na ciągłą pozycję w metrach.

**Zmiany w `ControlRoomContext`:**

1. Dodaj nowy state w `context-hooks.tsx`:
   ```typescript
   slicePlanePosition: number;                    // pozycja w metrach
   setSlicePlanePosition: (pos: number) => void;
   slicePlaneRange: { min: number; max: number }; // zakres mesh wzdłuż normalnej
   ```

2. Obliczanie `slicePlaneRange` z mesh extents:
   ```typescript
   const slicePlaneRange = useMemo(() => {
     if (!femMeshData) return { min: 0, max: 0 };
     const { normal } = axisIndices(plane);
     let min = Infinity, max = -Infinity;
     for (let i = 0; i < femMeshData.nNodes; i++) {
       const v = femMeshData.nodes[i * 3 + normal];
       if (v < min) min = v;
       if (v > max) max = v;
     }
     return { min, max };
   }, [femMeshData, plane]);
   ```

3. Inicjalizacja `slicePlanePosition` na środek zakresu:
   ```typescript
   const [slicePlanePosition, setSlicePlanePosition] = useState(
     () => (slicePlaneRange.min + slicePlaneRange.max) / 2
   );
   ```

4. Auto-clamp przy zmianie plane lub mesh:
   ```typescript
   useEffect(() => {
     setSlicePlanePosition((prev) =>
       clamp(prev, slicePlaneRange.min, slicePlaneRange.max)
     );
   }, [slicePlaneRange]);
   ```

**Slider w toolbarze:**

Nowy komponent `FemSlice2DToolbar.tsx`:

```typescript
interface SliceToolbarProps {
  plane: SlicePlane;
  position: number;
  range: { min: number; max: number };
  onPlaneChange: (p: SlicePlane) => void;
  onPositionChange: (pos: number) => void;
}
```

Slider:
- `min={range.min}`, `max={range.max}`
- `step` = `(range.max - range.min) / 1000` — minimum 1000 kroków na pełny zakres
- Wyświetlanie bieżącej pozycji: `"Z = 1.234e-7 m"`
- Input numeryczny do wpisania dokładnej pozycji

### Faza 3: Refaktor sliceGeometry — domain-aware intersection (1d)

**Cel:** Modyfikacja algorytmu `collectTetraSegments()` aby respektował element visibility mask
i zapisywał kontekst domeny w wynikowych polygonach.

**Plik:** `fem-slice/sliceGeometry.ts`

```typescript
export function computeSlice(
  meshData: FemMeshData,
  config: SliceConfig,
  component: VectorComponent,
  elementMask: Uint8Array,
  elementMarkers: Int32Array | null,
  meshParts: FemMeshPart[],
): SliceResult;
```

Kluczowe zmiany vs obecny `collectTetraSegments()`:

1. **Element mask filter:**
   ```typescript
   for (let elementIndex = 0; elementIndex < nElements; elementIndex++) {
     if (!elementMask[elementIndex]) continue;  // ← NOWE: skip ukrytych
     // ... intersection logic ...
   }
   ```

2. **Domain marker w wyniku:**
   ```typescript
   const domainMarker = elementMarkers ? elementMarkers[elementIndex] : -1;
   const partId = findPartForElement(elementIndex, meshParts);
   polygons.push({
     points: pts,
     vertexValues: unique.map(v => v.value),
     avgValue,
     domainMarker,
     partId,
   });
   ```

3. **Per-vertex values zamiast avg:**
   Obecny kod oblicza `avgValue` i odrzuca per-vertex. Zachowujemy per-vertex do smooth fill.

4. **Epsilon obliczany z mesh extents:**
   ```typescript
   config.epsilon = meshExtentAlongNormal * 1e-6;
   // zamiast obecnego epsilon = range / sliceCount * 0.25
   ```

5. **Boundary segments** — filtruj boundary faces według `elementMask` analogicznie (potrzebna mapa face → element).

### Faza 4: Smart color mapping (0.5d)

**Plik:** `fem-slice/sliceColorMapping.ts`

Logika identyczna z FDM `MagnetizationSlice2D.getSmartColorScale()`:

```typescript
export function getSmartColorScale(
  dataMin: number,
  dataMax: number,
  quantityId: string,
  component: VectorComponent,
): { min: number; max: number; palette: string[] } {
  const isMagnetization = quantityId === "m" || !quantityId;
  
  if (isMagnetization) {
    if (component === "magnitude") return { min: 0, max: 1, palette: POSITIVE };
    return { min: -1, max: 1, palette: DIVERGING };
  }
  
  // Pola: symetryczny zakres gdy krzyżuje zero
  if (dataMin < 0 && dataMax > 0) {
    const bound = Math.max(Math.abs(dataMin), Math.abs(dataMax));
    return { min: -bound, max: bound, palette: DIVERGING };
  }
  return { min: dataMin, max: dataMax, palette: POSITIVE };
}
```

Dodatkowa logika per-domain coloring gdy brak fieldData:
```typescript
export function domainColor(
  marker: number,
  partId: string | null,
  meshParts: FemMeshPart[],
): string {
  // Kolory per-domain z palety Catppuccin
  const part = meshParts.find(p => p.id === partId);
  if (part?.role === "air") return "rgba(108, 112, 134, 0.08)";
  if (part?.role === "interface") return "rgba(137, 180, 250, 0.15)";
  // ferromagnetic objects — cykliczna paleta
  const palette = ["#cba6f7", "#f38ba8", "#fab387", "#a6e3a1", "#89b4fa"];
  return palette[Math.abs(marker) % palette.length] + "44";
}
```

### Faza 5: Smooth gradient fill (1d)

**Problem:** Obecne polygony mają flat fill (jeden kolor na polygon). Przy dużych tetraedrach
to wygląda "blokowe".

**Rozwiązanie:** Per-vertex barycentric interpolation w obrębie każdego polygonu.

**Podejście A — Canvas2D z sub-triangulation (prostsze, MVP):**

Każdy polygon (3-5 wierzchołków) triangulujemy na wewnętrzne trójkąty (fan triangulation od centroid).
Dla każdego trójkąta:
- Tworzymy `CanvasGradient` z 3 kolorami (crude approximation), LUB
- Rasteryzujemy pixel-by-pixel (wolne), LUB
- Rysujemy wiele micro-polygonów z interpolowanym kolorem.

**Podejście B — WebGL (docelowe, optymalny):**

Migracja do WebGL2 pozwala na:
- Per-vertex color attributes → GPU interpolacja
- Instanced rendering polygonów → masowe przyspieszenie
- Fragment shader z pełną per-pixel interpolacją
- Antyaliasing za darmo (MSAA)

**Rekomendacja:** MVP z podejściem A (sub-triangle fan + gradient), potem migracja do B.

Podejście A — szczegóły:

```typescript
function drawGradientPolygon(
  ctx: CanvasRenderingContext2D,
  polygon: SlicePolygon,
  map: (uv: [number, number]) => [number, number],
  colorForValue: (v: number) => string,
) {
  if (polygon.points.length < 3) return;
  
  // Centroid
  const cx = polygon.points.reduce((s, p) => s + p[0], 0) / polygon.points.length;
  const cy = polygon.points.reduce((s, p) => s + p[1], 0) / polygon.points.length;
  const cv = polygon.vertexValues.reduce((s, v) => s + v, 0) / polygon.vertexValues.length;
  
  // Fan triangulation
  for (let i = 0; i < polygon.points.length; i++) {
    const j = (i + 1) % polygon.points.length;
    const [p0, p1] = [map(polygon.points[i]), map(polygon.points[j])];
    const pc = map([cx, cy] as [number, number]);
    
    // Avg color per sub-triangle
    const avgVal = (polygon.vertexValues[i] + polygon.vertexValues[j] + cv) / 3;
    ctx.fillStyle = colorForValue(avgVal);
    ctx.beginPath();
    ctx.moveTo(pc[0], pc[1]);
    ctx.lineTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.closePath();
    ctx.fill();
  }
}
```

### Faza 6: Quiver plot overlay (0.5d)

**Cel:** Opcjonalne rysowanie strzałek wektorowych (quiver) na heatmapie 2D.

**Plik:** `fem-slice/sliceInterpolation.ts`

Strategia:
1. Stwórz regularną siatkę punktów próbkowania w (u, v) — np. 20×20
2. Dla każdego punktu: znajdź polygon zawierający punkt (`pointInPolygon`)
3. Interpoluj wartość pola (barycentric) — TRZY składowe (fx, fy, fz), nie jedną
4. Narysuj strzałkę z rzutem wektora na płaszczyznę (u, v)

```typescript
interface QuiverSample {
  u: number;
  v: number;
  fu: number;  // składowa w kierunku u
  fv: number;  // składowa w kierunku v
  magnitude: number;
}

export function sampleQuiverGrid(
  slice: SliceResult,
  meshData: FemMeshData,
  gridDensity: number,  // punkty na oś
): QuiverSample[];
```

Rysowanie strzałek:
```typescript
function drawQuiverArrow(
  ctx: CanvasRenderingContext2D,
  sample: QuiverSample,
  map: (uv: [number, number]) => [number, number],
  scale: number,
) {
  const [x0, y0] = map([sample.u, sample.v]);
  const dx = sample.fu * scale;
  const dy = -sample.fv * scale;  // odwrócony y w canvas
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + dx, y0 + dy);
  ctx.stroke();
  // arrowhead
  drawArrowhead(ctx, x0 + dx, y0 + dy, Math.atan2(dy, dx), 5);
}
```

### Faza 7: Synchronizacja z 3D clip plane (0.5d)

**Cel:** Zmiana slice position w 2D aktualizuje clip plane w 3D i odwrotnie.

**Mechanizm:**

W `ControlRoomContext`, oba kontrolowane wspólnym state:

```typescript
// Nowe entries w context
clipPlanePosition: { x: number; y: number; z: number };
activeSliceAxis: "x" | "y" | "z" | null;

// Synchronizacja:
// Gdy użytkownik zmienia slice position w 2D:
setSlicePlanePosition(pos) → clipPlanePosition[normalAxis] = pos

// Gdy użytkownik zmienia clip plane w 3D toolbar:
setClipPosition(axis, pos) → slicePlanePosition = pos (jeśli axis === normalAxis)
```

**Wizualnie w 3D:** Clip plane rysuje kontury mesh na płaszczyźnie cięcia (obecna
funkcjonalność `clipPosition` + `clipAxis` w `FemR3FHelpers.tsx`).

### Faza 8: Toolbar 2D integration (0.5d)

**Cel:** Dedykowany toolbar dla trybu 2D, spójny z wzorcem `FemViewportToolbar.tsx`.

**Plik:** `fem-slice/FemSlice2DToolbar.tsx`

Elementy toolbara:

```
┌──────────────────────────────────────────────────────────┐
│ [XY] [XZ] [YZ]  │  ──●──── Z=1.23e-7 m  │ [⬛] [🔍] [↗] │
│   Plane select   │  Position slider       │  Options       │
└──────────────────────────────────────────────────────────┘
```

1. **Plane selector** — 3 przyciski toggle: XY, XZ, YZ
2. **Position slider** — continuous slider z dynamicznym range z mesh extents
3. **Position readout** — wartość w metrach z formatowaniem SI (nm, µm, mm)
4. **Position input** — kliknięcie na readout otwiera input do wpisania dokładnej wartości
5. **Options popover:**
   - Component selector: mx / my / mz / |m|
   - Gradient fill toggle (smooth vs flat)
   - Element edges toggle
   - Quiver overlay toggle + density slider
   - Domain filter (magnetic_only / full_domain / airbox_only)

**Pattern UI**: Wykorzystuje istniejące `ViewportPopoverPanel`, `ViewportToolGroup`,
`ViewportIconAction` z `FemViewportToolbar.tsx`.

### Faza 9: Probe z kontekstem domeny (0.25d)

**Cel:** Rozszerzenie probe o informacje o domenie i pełne koordynaty 3D.

Obecny probe wyświetla `u`, `v`, `value`. Nowy:

```
┌─────────────────────────┐
│ Probe                   │
│ x: 1.234e-7 m           │
│ y: 5.678e-8 m           │
│ z: 3.456e-8 m           │
│ mz: -0.8432             │
│ |m|: 0.9998             │
│ Domain: Layer_1 (ferro) │
│ Element: #12345         │
└─────────────────────────┘
```

Potrzebne: mapowanie (u, v, planePosition) → (x, y, z) + domain identification z `partId` w `SlicePolygon`.

### Faza 10: WebGL migration (2d, docelowa)

**Cel:** Migracja renderowania z Canvas2D do WebGL2 dla wydajności i jakości.

**Uzasadnienie:**
- Canvas2D: ~10ms render dla 5k polygonów, ~100ms dla 50k → opóźnienia przy dużych siatkach
- WebGL2: <1ms render niezależnie od ilości polygonów (GPU rasteryzacja)
- Per-pixel interpolacja koloru (fragment shader) vs per-triangle approximation

**Architektura:**

```
FemSlice2DCanvas.tsx
  ├─ useWebGL2Context(canvasRef)
  ├─ useSliceMeshBuffers(slice)  // → VBO, IBO, color VBO
  ├─ useSliceProgram()           // → vertex + fragment shader
  └─ renderFrame()
       ├─ drawPolygons()         // instanced triangles z per-vertex color
       ├─ drawEdges()            // line primitives
       ├─ drawQuiver()           // instanced arrows
       ├─ drawColorbar()         // quad + gradient texture
       └─ drawAxes()             // line + text (Canvas2D overlay lub SDF text)
```

**Vertex shader:**
```glsl
#version 300 es
in vec2 a_position;
in float a_value;
uniform mat3 u_transform;  // world → clip
uniform vec2 u_valueRange;
out float v_normalizedValue;

void main() {
  vec3 pos = u_transform * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  v_normalizedValue = (a_value - u_valueRange.x) / max(u_valueRange.y - u_valueRange.x, 1e-18);
}
```

**Fragment shader:**
```glsl
#version 300 es
precision mediump float;
in float v_normalizedValue;
uniform sampler2D u_colormap;  // 1D texture z palety
out vec4 fragColor;

void main() {
  fragColor = texture(u_colormap, vec2(clamp(v_normalizedValue, 0.0, 1.0), 0.5));
}
```

### Faza 11: Spatial indexing (1d, optymalizacja)

**Problem:** `computeSlice()` iteruje po WSZYSTKICH elementach. Złożoność O(n).

**Rozwiązanie:** Bounding box pre-filtering + opcjonalny BVH.

**Podejście proste (MVP):**

```typescript
// Pre-compute per-element bounding box along normal axis
const elementBounds = new Float32Array(nElements * 2);  // [min, max] per element
for (let i = 0; i < nElements; i++) {
  const nodeIds = getElementNodes(i);
  let lo = Infinity, hi = -Infinity;
  for (const nid of nodeIds) {
    const v = nodes[nid * 3 + normalAxis];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  elementBounds[i * 2] = lo;
  elementBounds[i * 2 + 1] = hi;
}

// Sort elements by their midpoint along normal axis
const sortedIndices = [...Array(nElements).keys()].sort(
  (a, b) => elementBounds[a * 2] - elementBounds[b * 2]
);

// Binary search for first element that could intersect planePosition
// Then scan forward until element.min > planePosition + epsilon
```

Szacowany speedup: 10-50x dla typowych siatek (cięcie przechodzi przez ~2-10% elementów).

**Podejście docelowe:** 1D interval tree wzdłuż osi normalnej, budowany raz przy zmianie plane orientation.

### Faza 12: Realistic projection mode (1d, nice-to-have)

**Cel:** Tryb wyświetlania gdzie cięcie 2D jest osadzone w kontekście 3D siatki.

Dwa warianty:

**A. Outlined projection:**
- Slice 2D jest rysowany centralnie
- Wokół slice: obrys (outline) mesh w kierunku normalnym (rzut bounding faces)
- Efekt: widać kształt obiektu wokół cięcia

**B. Mini 3D z wyróżnioną płaszczyzną:**
- Wykorzystanie istniejącego R3F canvasu z `FemMeshView3D`
- Mesh renderowany semi-transparent
- Cutting plane renderowany z pełnym kolorem/polem
- Kontrola kamery ograniczona do obrotu wokół normalnej

**Rekomendacja:** Wariant A jako szybki do implementacji, wariant B jako docelowy.

---

## 5. Zmiany w istniejącym kodzie

### 5.1. `ViewportPanels.tsx`

```diff
- <FemMeshSlice2D
-   meshData={ctx.femMeshData}
-   quantityLabel={...}
-   quantityId={...}
-   component={ctx.effectiveVectorComponent}
-   plane={ctx.plane}
-   sliceIndex={ctx.sliceIndex}
-   sliceCount={ctx.maxSliceCount}
-   antennaOverlays={ctx.antennaOverlays}
-   selectedAntennaId={selectedAntennaName}
- />
+ <FemSlice2DView
+   meshData={ctx.femMeshData}
+   meshParts={ctx.meshParts}
+   elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
+   quantityLabel={...}
+   quantityId={...}
+   component={ctx.effectiveVectorComponent}
+   plane={ctx.plane}
+   planePosition={ctx.slicePlanePosition}
+   onPlaneChange={ctx.setPlane}
+   onPlanePositionChange={ctx.setSlicePlanePosition}
+   meshEntityViewState={ctx.meshEntityViewState}
+   airSegmentVisible={ctx.airMeshVisible}
+   airSegmentOpacity={ctx.airMeshOpacity}
+   objectViewMode={ctx.objectViewMode}
+   vectorDomainFilter={ctx.femVectorDomainFilter}
+   visibleObjectIds={visibleObjectIds}
+   antennaOverlays={ctx.antennaOverlays}
+   selectedAntennaId={selectedAntennaName}
+ />
```

### 5.2. `context-hooks.tsx`

Dodać do `ControlRoomViewportSlice`:
```typescript
slicePlanePosition: number;
setSlicePlanePosition: (pos: number) => void;
slicePlaneRange: { min: number; max: number };
```

### 5.3. `ControlRoomContext.tsx`

Dodać state i obliczenia dla continuous plane position. Auto-sync z clip plane position.

### 5.4. `useFemMeshDerived.ts`

Udostępnić `elementMarkers` i `meshParts` do kontekstu 2D (już dostępne, ale nie przekazywane
do komponentu 2D).

### 5.5. Stary `FemMeshSlice2D.tsx`

Oznaczyć jako `@deprecated`, zachować tymczasowo za flagą diagnostyczną, usunąć po stabilizacji
nowego modułu.

---

## 6. Priorytety i kolejność wdrażania

```
Faza    Opis                              Wysiłek    Priorytet    Zależności
─────   ────────────────────────────────   ────────   ──────────   ──────────
  1     Typy + filtrowanie domen           0.5d       CRITICAL     —
  2     Continuous plane positioning       0.5d       CRITICAL     1
  3     Domain-aware intersection          1.0d       CRITICAL     1
  4     Smart color mapping                0.5d       HIGH         3
  5     Smooth gradient fill               1.0d       HIGH         3, 4
  6     Quiver plot overlay                0.5d       MEDIUM       3
  7     Sync z 3D clip plane               0.5d       MEDIUM       2
  8     Toolbar 2D integration             0.5d       CRITICAL     2, 4
  9     Probe z kontekstem domeny          0.25d      MEDIUM       3
 10     WebGL migration                    2.0d       LOW          5
 11     Spatial indexing                   1.0d       MEDIUM       3
 12     Realistic projection              1.0d       LOW          10
```

**Minimalne wdrożenie (MVP):** Fazy 1—4 + 8 = ~3 dni robocze  
**Pełne wdrożenie v1:** Fazy 1—9 = ~5 dni roboczych  
**Docelowe z WebGL:** Fazy 1—12 = ~9 dni roboczych

---

## 7. Kryteria akceptacji

### MVP

- [ ] Płaszczyzna cięcia pozycjonowana ciągłym sliderem (nie dyskretnym indeksem)
- [ ] Widoczna wartość pozycji w metrach z formatowaniem SI
- [ ] Filtry domen (air/ferro/interface) respektowane — niewidoczne domeny nie pojawiają się
- [ ] `objectViewMode: "isolate"` ukrywa niezaznaczone obiekty na przekroju
- [ ] Smart colorbar (magnetyzacja [-1,1], pola symetryczne)
- [ ] Plane selector (XY/XZ/YZ) w toolbarze
- [ ] Brak regresji: antenna overlays nadal działają

### Pełny v1

- [ ] Gradient fill wewnątrz polygonów (smooth, nie blokowy)
- [ ] Quiver overlay ze strzałkami wektorowymi
- [ ] Probe wyświetla pełne koordynaty 3D, nazwę domeny, indeks elementu
- [ ] Synchronizacja pozycji z clip plane w trybie 3D
- [ ] Wydajność: <50ms na render dla siatek 100k elementów

### Docelowe

- [ ] WebGL rendering z per-pixel interpolacją kolorów
- [ ] Spatial indexing — <5ms compute per slice niezależnie od rozmiaru siatki
- [ ] Realistic projection mode — widok 2D w kontekście 3D obrysu

---

## 8. Ryzyka i mitygacje

| Ryzyko | Mitigacja |
|--------|-----------|
| WebGL context conflicts z R3F canvas | Osobny `<canvas>` w 2D, nie współdzielony z Three.js |
| Duże siatki (>500k elementów) → spowolniony intersection | Faza 11 (spatial indexing) + web worker offload |
| Brak face→element mapping w FemMeshData | Zbudować mapping z `element_markers` + `FemMeshPart.boundary_face_start` |
| Gradient fill w Canvas2D wygląda źle | Sub-triangle fan as MVP, migracja do WebGL docelowo |
| Synchronizacja 2D↔3D state race conditions | Jeden wspólny state w ControlRoomContext, derived values |
| element_markers null dla starych siatek | Fallback: wszystkie elementy należą do jednej domeny |
| Polygon triangulation edge cases (concave) | Ear-clipping zamiast fan (fan wystarczy gdy polygony z tet-intersection zawsze convex) |

---

## 9. Otwarte pytania

1. **Czy Canvas2D wystarczy na production czy od razu celować w WebGL?**
   - Rekomendacja: Canvas2D MVP → WebGL v2
   
2. **Czy slider powinien mieć opcję "snap to nearest node"?**
   - Potencjalnie przydatne dla FEM, bo node distribution jest nieuniformowa
   
3. **Czy 2D view powinien obsługiwać dowolną orientację cięcia (nie tylko axis-aligned)  ?**
   - Out of scope dla v1, ale architektura typów (`SliceConfig`) powinna nie blokować

4. **Czy smooth interpolation powinna być barycentric w 3D (dokładna) czy bilinear w 2D (szybka)?**
   - Rekomendacja: barycentric w obrębie polygonu (dane już mamy z vertex interpolation)
