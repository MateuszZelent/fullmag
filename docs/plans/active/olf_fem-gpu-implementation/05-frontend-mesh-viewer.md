# S5: Frontend — 3D Tetrahedral Mesh Viewer

- Etap: **S5** (po S3 — wymaga artifacts z mesh danymi)
- Priorytet: **MEDIUM** — UX, nie blokuje symulacji
- Docelowe pliki: `apps/web/components/preview/`, `apps/web/components/panels/`
- Powiązane: `MagnetizationView3D.tsx`, `MeshPanel.tsx`

---

## 1. Cele etapu

1. **Renderowanie siatki tetraedrycznej** w Three.js (surface faces, wireframe).
2. **Kolorowanie po polu** (mx, my, mz, |m|, H_eff, ...) z interpolacją na wierzchołki.
3. **Przycięcia (clipping planes)** do wizualizacji wnętrza.
4. **MeshPanel** z informacjami: n_nodes, n_elements, volume, quality stats.
5. **Cross-backend comparison** view: FDM voxels obok FEM mesh.

---

## 2. Architektura renderowania

### 2.1 Tetrahedral mesh → surface triangles

Siatka FEM to tetraedry (4-node solid elements). Three.js nie renderuje tetraedrów bezpośrednio — 
trzeba wyekstrahować **powinne ścianki** (surface faces) do renderowania.

```
Tetraedron (4 nodes) → 4 trójkąty → filtruj boundary faces → Three.js BufferGeometry
```

**Algorytm ekstrakcji surface:**

```typescript
/**
 * Extract surface triangles from tetrahedral mesh.
 *
 * A face is on the surface if it belongs to exactly one tetrahedron.
 * Internal faces are shared by two tetrahedra.
 */
function extractSurfaceFaces(
  elements: Uint32Array,     // (nTet × 4) flattened
  nElements: number,
): { faces: Uint32Array; faceToElement: Uint32Array } {
  // 4 faces per tet, defined by local node indices
  const TET_FACES = [
    [0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]
  ];

  // Build face → tetrahedron count map
  // Key: sorted(n0, n1, n2) as string
  const faceMap = new Map<string, { nodes: number[]; count: number; elem: number }>();

  for (let e = 0; e < nElements; e++) {
    const n = [
      elements[4 * e + 0],
      elements[4 * e + 1],
      elements[4 * e + 2],
      elements[4 * e + 3],
    ];

    for (const [i, j, k] of TET_FACES) {
      const faceNodes = [n[i], n[j], n[k]].sort((a, b) => a - b);
      const key = `${faceNodes[0]}_${faceNodes[1]}_${faceNodes[2]}`;

      const existing = faceMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        faceMap.set(key, { nodes: [n[i], n[j], n[k]], count: 1, elem: e });
      }
    }
  }

  // Collect surface faces (count == 1)
  const surfaceFaces: number[] = [];
  const faceToElement: number[] = [];

  for (const { nodes, count, elem } of faceMap.values()) {
    if (count === 1) {
      surfaceFaces.push(nodes[0], nodes[1], nodes[2]);
      faceToElement.push(elem);
    }
  }

  return {
    faces: new Uint32Array(surfaceFaces),
    faceToElement: new Uint32Array(faceToElement),
  };
}
```

### 2.2 Three.js renderowanie

```typescript
/**
 * Create Three.js mesh from FEM tetrahedral surface data.
 */
function createFemMesh(
  nodes: Float64Array,       // (nNodes × 3) flattened
  nNodes: number,
  surfaceFaces: Uint32Array, // (nFaces × 3) flattened
  fieldValues: Float64Array, // (nNodes) — scalar field for coloring
  colorMap: ColorMap,
): THREE.Mesh {
  // Position buffer (Float32 for GPU)
  const positions = new Float32Array(nNodes * 3);
  for (let i = 0; i < nNodes * 3; i++) {
    positions[i] = nodes[i]; // double → float
  }

  // Color buffer
  const colors = new Float32Array(nNodes * 3);
  const [fMin, fMax] = fieldRange(fieldValues);
  for (let i = 0; i < nNodes; i++) {
    const t = (fieldValues[i] - fMin) / (fMax - fMin + 1e-30);
    const [r, g, b] = colorMap.sample(t);
    colors[3 * i + 0] = r;
    colors[3 * i + 1] = g;
    colors[3 * i + 2] = b;
  }

  // Geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(surfaceFaces, 1));
  geometry.computeVertexNormals();

  // Material
  const material = new THREE.MeshPhongMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    flatShading: false,   // smooth shading on P1 mesh
  });

  return new THREE.Mesh(geometry, material);
}
```

---

## 3. Komponent `FemMeshView3D.tsx`

### 3.1 Struktura

```typescript
// apps/web/components/preview/FemMeshView3D.tsx

interface FemMeshData {
  nodes: Float64Array;       // (N × 3) flattened
  elements: Uint32Array;     // (M × 4) flattened
  nNodes: number;
  nElements: number;
  magnetization?: {
    mx: Float64Array;
    my: Float64Array;
    mz: Float64Array;
  };
  effectiveField?: {
    hx: Float64Array;
    hy: Float64Array;
    hz: Float64Array;
  };
}

interface FemMeshView3DProps {
  meshData: FemMeshData;
  colorField: 'mx' | 'my' | 'mz' | '|m|' | 'hx' | 'hy' | 'hz' | 'none';
  showWireframe: boolean;
  showSurface: boolean;
  showGlyphs: boolean;
  clipPlane?: { normal: [number, number, number]; distance: number };
  quality: 'low' | 'medium' | 'high';
}
```

### 3.2 Funkcjonalności

| Feature | Opis | Priorytet |
|---------|------|-----------|
| Surface rendering | Powinne ścianki z Phong shading | P0 |
| Vertex coloring | Pole skalarne → kolor | P0 |
| Wireframe overlay | Krawędzie elementów | P1 |
| Glyph arrows | Strzałki magnetyzacji na węzłach | P1 |
| Clipping plane | Interaktywne przekrój przez siatkę | P2 |
| Region highlighting | Kolorowanie wg material marker | P2 |
| Quality LOD | Decimation dla dużych meshów | P2 |

### 3.3 Tryby wyświetlania

**Surface mode (domyślny)**:
- Powinne ścianki colored by field
- Phong shading z ambient + diffuse + specular
- Opcjonalny wireframe overlay (czarne krawędzie)

**Glyph mode**:
- Strzałki (InstancedMesh of cones) na węzłach boundary
- Kierunek = m_i, kolor = |m_i| lub component
- Subsampling dla meshów > 10k nodes (co N-ty node)

**Cross-section mode**:
- Clipping plane ucina połowę siatki
- Widoczne wnętrza tetraedrów
- Pole na wewnętrznych ściankach (wymaga re-extraction)

---

## 4. Rozszerzenie `MeshPanel.tsx`

### Obecny stan

`MeshPanel.tsx` wyświetla informacje o siatce FDM (grid size, cell count).

### Rozszerzenie

```typescript
// apps/web/components/panels/MeshPanel.tsx

interface FemMeshInfo {
  type: 'fem';
  nNodes: number;
  nElements: number;
  nBoundaryFaces: number;
  totalVolume: number;             // m³
  feOrder: number;
  hasAirBox: boolean;
  airBoxFactor?: number;
  qualityStats: {
    minAspectRatio: number;
    maxAspectRatio: number;
    meanAspectRatio: number;
    nDegenerate: number;
  };
}

// Panel display:
// ┌───────────────────────────────┐
// │ Mesh Information              │
// ├───────────────────────────────┤
// │ Type:          FEM (P1 tet)  │
// │ Nodes:         5,432         │
// │ Elements:      28,901        │
// │ Boundary:      3,204 faces   │
// │ Total Volume:  2.00e-22 m³   │
// │ FE Order:      1             │
// │ Air Box:       3.0×          │
// │ ─────────────────────────── │
// │ Quality                      │
// │ Aspect ratio:  1.2 — 15.3   │
// │ Mean AR:       2.8           │
// │ Degenerate:    0             │
// └───────────────────────────────┘
```

---

## 5. Color maps

```typescript
// apps/web/components/preview/colorMaps.ts

export interface ColorMap {
  name: string;
  sample(t: number): [number, number, number]; // RGB [0, 1]
}

/** Blue-White-Red diverging colormap for signed fields (mx, my, mz). */
export const blueWhiteRed: ColorMap = {
  name: 'Blue-White-Red',
  sample(t: number): [number, number, number] {
    // t ∈ [0, 1], mapped from [field_min, field_max]
    if (t < 0.5) {
      const s = t * 2;  // 0 → 1
      return [s, s, 1];           // blue → white
    } else {
      const s = (t - 0.5) * 2;   // 0 → 1
      return [1, 1 - s, 1 - s];  // white → red
    }
  },
};

/** Viridis sequential colormap for magnitude fields. */
export const viridis: ColorMap = {
  name: 'Viridis',
  sample(t: number): [number, number, number] {
    // Simplified 5-stop viridis approximation
    const stops = [
      [0.267, 0.004, 0.329],
      [0.282, 0.140, 0.458],
      [0.127, 0.566, 0.551],
      [0.544, 0.774, 0.247],
      [0.993, 0.906, 0.144],
    ];
    const idx = Math.min(Math.floor(t * 4), 3);
    const frac = t * 4 - idx;
    const a = stops[idx];
    const b = stops[idx + 1];
    return [
      a[0] + frac * (b[0] - a[0]),
      a[1] + frac * (b[1] - a[1]),
      a[2] + frac * (b[2] - a[2]),
    ] as [number, number, number];
  },
};
```

---

## 6. Ładowanie danych z artefaktów

```typescript
// apps/web/lib/femDataLoader.ts

interface FemSnapshot {
  step: number;
  time: number;
  backend: 'fem';
  mesh: {
    n_nodes: number;
    n_elements: number;
    nodes: number[];
    elements: number[];
  };
  magnetization: {
    mx: number[];
    my: number[];
    mz: number[];
  };
  effective_field?: {
    hx: number[];
    hy: number[];
    hz: number[];
  };
}

export async function loadFemSnapshot(url: string): Promise<FemMeshData> {
  const response = await fetch(url);
  const json: FemSnapshot = await response.json();

  return {
    nodes: new Float64Array(json.mesh.nodes),
    elements: new Uint32Array(json.mesh.elements),
    nNodes: json.mesh.n_nodes,
    nElements: json.mesh.n_elements,
    magnetization: {
      mx: new Float64Array(json.magnetization.mx),
      my: new Float64Array(json.magnetization.my),
      mz: new Float64Array(json.magnetization.mz),
    },
    effectiveField: json.effective_field ? {
      hx: new Float64Array(json.effective_field.hx),
      hy: new Float64Array(json.effective_field.hy),
      hz: new Float64Array(json.effective_field.hz),
    } : undefined,
  };
}
```

---

## 7. Cross-backend comparison view

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│  Cross-Backend Comparison: FDM vs FEM                    │
├───────────────────────┬──────────────────────────────────┤
│                       │                                  │
│   FDM (voxel)        │   FEM (mesh)                      │
│                       │                                  │
│   [3D view]          │   [3D view]                        │
│                       │                                  │
│   mx: 0.002          │   mx: 0.003                        │
│   my: 0.001          │   my: 0.001                        │
│   mz: 0.998          │   mz: 0.997                        │
│                       │                                  │
├───────────────────────┴──────────────────────────────────┤
│  Scalar comparison (echarts)                             │
│  ┌──── Energy vs time ────┐  ┌──── <mz> vs time ────┐  │
│  │  FDM ─── FEM ─ ─ ─   │  │  FDM ─── FEM ─ ─ ─   │  │
│  └────────────────────────┘  └────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 7.2 Komponent

```typescript
// apps/web/app/visualizations/page.tsx

export default function ComparisonPage() {
  const [fdmData, setFdmData] = useState<VoxelData | null>(null);
  const [femData, setFemData] = useState<FemMeshData | null>(null);
  const [fdmScalars, setFdmScalars] = useState<ScalarTimeSeries | null>(null);
  const [femScalars, setFemScalars] = useState<ScalarTimeSeries | null>(null);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="border rounded-lg p-4">
        <h3>FDM (voxel grid)</h3>
        {fdmData && <MagnetizationView3D data={fdmData} />}
      </div>
      <div className="border rounded-lg p-4">
        <h3>FEM (tetrahedral mesh)</h3>
        {femData && <FemMeshView3D meshData={femData} colorField="mz" />}
      </div>
      <div className="col-span-2">
        <ScalarComparisonChart
          fdmScalars={fdmScalars}
          femScalars={femScalars}
          fields={['energy_exchange', 'avg_mz', 'max_torque']}
        />
      </div>
    </div>
  );
}
```

---

## 8. Performance optimization for large meshes

| Mesh size | Strategy |
|-----------|----------|
| < 10k nodes | Render all surface faces, all glyph arrows |
| 10k–100k | Render all faces, subsample glyphs (every 10th node) |
| 100k–500k | LOD: simplify surface (quadric decimation), sparse glyphs |
| > 500k | Frustum culling, octree-based LOD, stream from server |

```typescript
// Decimation for large meshes
function decimateMesh(
  positions: Float32Array,
  indices: Uint32Array,
  targetRatio: number,
): { positions: Float32Array; indices: Uint32Array } {
  // Use Three.js SimplifyModifier or custom edge-collapse
  // targetRatio = 0.5 → reduce to 50% of faces
  // ...
}
```

---

## 9. Testy S5

| Test | Opis |
|------|------|
| `test_surface_extraction_cube` | Sześcian (12 tet) → 12 surface triangles |
| `test_surface_extraction_no_internal` | Żadna internal face w surface output |
| `test_color_map_range` | sample(0) i sample(1) dają poprawne kolory |
| `test_fem_data_loader` | Parsowanie JSON snapshot → FemMeshData |
| `test_mesh_panel_info` | FEM metadata poprawnie wyświetlane |
| `test_render_smoke` | Three.js Mesh creates bez crash (jest headless test?) |
| `test_comparison_layout` | Oba panele renderują się obok siebie |

---

## 10. Kryteria akceptacji S5

| # | Kryterium |
|---|-----------|
| 1 | Tetrahedral mesh renderuje się w przeglądarce |
| 2 | Kolorowanie po polu (mz) widoczne z gradientem |
| 3 | Wireframe overlay opcjonalny |
| 4 | MeshPanel wyświetla n_nodes, n_elements, volume |
| 5 | Cross-backend comparison page ładuje FDM + FEM dane |
| 6 | Interaktywna rotacja (TrackballControls) |
| 7 | ViewCube działa z FEM mesh |
| 8 | Mesh < 50k nodes renderuje się w < 1s |

---

## 11. Zależności npm (bez nowych)

Wszystko realizowane z istniejącymi zależnościami:
- `three` ^0.183.2 (BufferGeometry, MeshPhongMaterial, InstancedMesh)
- `echarts` ^6.0.0 (wykresy porównawcze)
- Brak potrzeby dodawania react-three-fiber (konsekwentnie z istniejącym MagnetizationView3D.tsx)
