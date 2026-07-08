# FEM GPU Implementation Plan — Overview

- Status: **active**
- Data: 2026-03-24
- Autorzy: Fullmag core
- Powiązane fizyka: `docs/physics/0410`, `0430`, `0450`, `0470`, `0490`, `0510`
- Powiązane specyfikacje: `capability-matrix-v0`, `exchange-bc-policy-v0`, `problem-ir-v0`
- Referencyjne solvery: `external_solvers/tetmag` (C++/CUDA), `external_solvers/tetrax` (Python)

---

## 1. Cel

Wdrożenie backendu **FEM (Finite Element Method)** z akceleracją GPU w Fullmag, analogicznie do
istniejącego backendu FDM. Backend FEM musi:

1. Obsługiwać **siatkę tetraedryczną** (P1, liniowe elementy) generowaną z geometrii analitycznych
   (Box, Cylinder), z importu powierzchni `.stl` / `.step`, albo z już gotowej siatki `.msh` / `.vtk`.
2. Realizować **oddziaływania**: Exchange, Demag (air-box truncated), Zeeman.
3. Integrować dynamikę **LLG** z integratorem Heuna (bootstrap), potem DOPRI54 (produkcja).
4. Działać na **GPU** z wykorzystaniem stosu MFEM + libCEED + hypre (CG/AMG).
5. Publikować **te same artefakty** co FDM: skalary CSV, snapshoty pól, provenance JSON.
6. Być **porównywalny** z FDM na siatce Box (cross-backend validation).
7. Wyświetlać **siatkę 3D** w przeglądarce (Three.js tetrahedral mesh viewer).
8. Dzielić z backendem FDM **jeden wspólny kontrakt geometrii**:
   - ten sam `GeometryIR`,
   - ten sam import `ImportedGeometry(format="stl" | "step" | ...)`,
   - dwa różne lowering paths:
     - `STL/STEP -> tetra mesh` dla FEM,
     - `STL/STEP -> voxelized active mask` dla FDM.
9. Wspierać **eksport STL** jako format interoperacyjny:
   - export powierzchni geometrii analitycznej,
   - export boundary skin z gotowego FEM mesha,
   - później export izopowierzchni/maski FDM do celów wizualnych i debugowych.

### Kluczowa decyzja architektoniczna

**STL nie jest natywnym formatem solvera.**
Jest formatem **assetu powierzchniowego i interoperacyjnego**.

W Fullmag:

- dla **FEM** STL jest wejściem do pipeline’u meshowania,
- dla **FDM** STL jest wejściem do pipeline’u voxelization,
- dla **UI / eksportu** STL jest wygodnym formatem podglądu i wymiany zewnętrznej,
- ale źródłem prawdy dla wykonania pozostają:
  - `FemPlanIR` z tetra meshem,
  - `FdmPlanIR` z gridem + `active_mask`.

---

## 2. Odpowiedź na pytanie: Własne algorytmy meshowania czy zewnętrzna biblioteka?

### Decyzja: **Zewnętrzna biblioteka — Gmsh + meshio + trimesh**

Fullmag **nie powinien** implementować własnych algorytmów meshowania. Budowanie generatora siatek
tetraedrycznych to projekt solvera sam w sobie (Delaunay refinement, jakość elementów, adaptive
meshing, boundary recovery). Zarówno tetmag jak i tetrax korzystają z zewnętrznych narzędzi:

| Solver | Meshowanie | Format wejściowy |
|--------|------------|-------------------|
| tetmag | Gmsh (zewnętrzne CLI lub API) | `.msh` (GMSH format) |
| tetrax | pygmsh (Python wrapper na Gmsh) | meshio abstraction |
| Boris | FDM — brak meshowania | — |
| OOMMF | FDM — brak meshowania | — |
| MuMax3 | FDM — brak meshowania | — |

### Rekomendowany stos meshowania

```
Geometria analityczna (Box, Cylinder) / ImportedGeometry(STEP/STL/MSH)
                  |
                  v
        Geometry Asset Layer (Python helper)
        ├─ trimesh      → surface I/O, watertightness, STL export/import
        ├─ meshio       → mesh I/O (.msh/.vtk/...)
        └─ gmsh         → tet meshing / remeshing / air-box generation
                  |
      ┌───────────┴────────────────┐
      v                            v
 FEM lowering                 FDM lowering
 gmsh tetra mesh             voxelizer / active_mask
 MeshIR / FemPlanIR          GridRealizationIR / FdmPlanIR
      |                            |
      v                            v
 MFEM/libCEED/hypre          exchange/demag on masked grid
```

### Dlaczego Gmsh?

1. **Dojrzały i stabilny** — >20 lat rozwoju, standard w FEM
2. **API w C/C++ i Python** — `import gmsh` lub Gmsh SDK C library
3. **Obsługuje geometrie CAD** — STEP, IGES, BREP → automatyczny mesh
4. **Kontrola jakości** — `hmax`, `hmin`, adaptive refinement, element quality metrics
5. **3D tetrahedral + surface triangle** — P1 i P2 elementy
6. **Domain markers** — physical groups → material regions
7. **Open source** (GPL, ale API jest separate i BSD-kompatybilne do linkowania)
8. **Tetmag już z niego korzysta** — sprawdzona ścieżka

### Dlaczego `trimesh`?

1. **Dobry do STL import/export** i surface-level preprocessing.
2. **Watertightness checks** i podstawowe sanity checks przed meshowaniem lub voxelizacją.
3. **Point-in-solid / contains / voxel helper utilities**, przydatne przy FDM lowering.
4. Umożliwia wspólną warstwę geometrii pomiędzy:
   - FEM meshing,
   - FDM voxelization,
   - frontend/debug export.

### Rola `meshio`

`meshio` nie jest mesherem, ale jest bardzo ważne jako warstwa I/O:

- czyta gotowe `.msh`, `.vtk`, później `.xdmf/.vtu`,
- pozwala ujednolicić mesh interchange niezależnie od Gmsh,
- upraszcza roundtrip Python ↔ Rust ↔ external viewers.

### Alternatywy rozważone i odrzucone

| Biblioteka | Powód odrzucenia |
|------------|------------------|
| Netgen/NGSolve | Dobra, ale mniejszy ekosystem; mniej stabilne API C |
| TetGen | Tylko tet mesh (brak CAD import), ograniczona kontrola jakości |
| CGAL | Zbyt nisko-poziomowa; wymaga dużo kodu integracyjnego |
| Własna implementacja | Ogromny nakład pracy; bez wartości dodanej |

### Co dokładnie ma znaczyć „obsługa STL” w Fullmag

To trzeba zamrozić już tutaj, bo inaczej FDM i FEM pójdą różnymi drogami.

#### STL import

- `ImportedGeometry(format="stl")` jest legalnym source assetem.
- Dla **FEM**: STL przechodzi przez Gmsh i daje zamknięty tetra mesh.
- Dla **FDM**: STL przechodzi przez voxelizer i daje `active_mask` na regularnej siatce.

#### STL export

Musimy wspierać co najmniej trzy export paths:

1. export analitycznej geometrii do STL,
2. export boundary skin z FEM mesha do STL,
3. później export FDM maski / boundary surface do STL do debugowania i porównań.

#### Ważne ograniczenie

STL opisuje **powierzchnię trójkątną**, a nie solverowy stan objętościowy.
Dlatego:

- STL nie zastępuje `MeshIR`,
- STL nie zastępuje `FdmPlanIR`,
- STL nie jest głównym artifact store runu.

### Integracja z Fullmag

**Opcja A (rekomendowana na Phase 1): Python helper = Gmsh + trimesh + meshio**

```python
# W packages/fullmag-py/src/fullmag/meshing/gmsh_bridge.py
import gmsh
import numpy as np

def generate_mesh(geometry, hmax, order=1):
    """Generate tetrahedral mesh from Fullmag geometry."""
    gmsh.initialize()
    gmsh.model.add("fullmag")

    if isinstance(geometry, Box):
        # Box centered at origin
        sx, sy, sz = geometry.size
        gmsh.model.occ.addBox(-sx/2, -sy/2, -sz/2, sx, sy, sz)
    elif isinstance(geometry, Cylinder):
        gmsh.model.occ.addCylinder(0, 0, -geometry.height/2,
                                    0, 0, geometry.height,
                                    geometry.radius)
    # ... imported geometry: load STEP/STL ...

    gmsh.model.occ.synchronize()
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
    gmsh.option.setNumber("Mesh.ElementOrder", order)
    gmsh.model.mesh.generate(3)  # 3D tetrahedral

    # Extract arrays
    nodes_tags, coords, _ = gmsh.model.mesh.getNodes()
    elem_types, elem_tags, node_tags = gmsh.model.mesh.getElements(dim=3)

    gmsh.finalize()
    return MeshData(nodes=coords, elements=node_tags, ...)
```

**Opcja B (Phase 2+): Gmsh C SDK via Rust FFI**

Bezpośrednie linkowanie `libgmsh.so` z Rusta przez C ABI. Eliminuje zależność od Pythona
w ścieżce meshowania. Do rozważenia po stabilizacji Phase 1.

### Brakujący element, który musi być wspólny dla FEM/FDM

Potrzebujemy wspólnego **Geometry Asset Pipeline**, nie tylko “FEM meshing”.

Docelowy kontrakt:

```text
GeometryIR / ImportedGeometry
        |
        v
GeometryAssetRealization
        ├─ SurfaceAsset (STL / STEP / analytic boundary skin)
        ├─ FemMeshAsset   (tet mesh + markers + air box)
        └─ FdmGridAsset   (grid dims + active_mask + optional occupancy)
```

To jest kluczowe dla późniejszego przełącznika `backend="fdm" | "fem"`:

- użytkownik nie zmienia fizyki,
- backend wybiera tylko właściwe lowering,
- oba backendy mogą startować z tego samego source assetu.

---

## 3. Architektura stosu GPU FEM

```
┌─────────────────────────────────────────────────────────┐
│  Python API (fm.Problem + fm.FEM)                      │
│  ↓ to_ir() → ProblemIR z FemHintsIR                    │
├─────────────────────────────────────────────────────────┤
│  Geometry Asset Layer                                  │
│  STL/STEP import, STL export, gmsh meshing, voxelizer  │
├─────────────────────────────────────────────────────────┤
│  Rust Planner (fullmag-plan)                           │
│  ↓ plan() → FemPlanIR z tetra meshem /                 │
│             FdmPlanIR z grid + active_mask             │
├─────────────────────────────────────────────────────────┤
│  Rust Runner (fullmag-runner)                          │
│  ↓ dispatch() → execute_fem() lub NativeFemBackend     │
├──────────────────────┬──────────────────────────────────┤
│  CPU Reference FEM   │  Native CUDA/FEM Backend         │
│  (fullmag-engine)    │  (native/backends/fem)            │
│  Pure Rust P1 tet    │  ┌───────────────────────────┐   │
│  exchange + demag    │  │  MFEM (mesh, FE spaces)   │   │
│  Heun stepper        │  │  libCEED (GPU operators)   │   │
│  Walidacja baseline  │  │  hypre (CG/AMG solver)    │   │
│                      │  │  cuSPARSE (sparse ops)     │   │
│                      │  └───────────────────────────┘   │
├──────────────────────┴──────────────────────────────────┤
│  Artifacts: scalars.csv, fields/*.json, metadata.json  │
│  Geometry assets: mesh skin STL / mask debug STL       │
│  ↓ WebSocket/SSE                                       │
├─────────────────────────────────────────────────────────┤
│  Frontend: Three.js Tetrahedral Mesh Viewer            │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Fazy implementacji

Plan podzielony na **6 etapów** (stages), każdy w osobnym pliku:

| Etap | Plik | Tytuł | Zależności |
|------|------|-------|------------|
| S1 | `01-meshing-pipeline.md` | Geometry assets + STL import/export + Gmsh → IR → Rust | brak |
| S2 | `02-cpu-reference-fem-engine.md` | CPU reference FEM engine w Rust | S1 |
| S3 | `03-runner-planner-wiring.md` | Podłączenie FEM do planner/runner/artifacts | S1, S2 |
| S4 | `04-native-gpu-fem-backend.md` | Native C++/CUDA FEM backend (MFEM+libCEED+hypre) | S1, S3 |
| S5 | `05-frontend-mesh-viewer.md` | Frontend: 3D mesh viewer w Three.js | S3 |
| S6 | `06-cross-backend-validation.md` | Cross-backend validation FDM↔FEM | S2, S3, S4 |

### Dodatkowy podział logiczny etapu S1

Nawet jeśli dokumentacja pozostanie zgrupowana pod `01-meshing-pipeline.md`, sam etap S1 powinien
być wewnętrznie podzielony na cztery logiczne kawałki:

1. `S1a` — import/export assetów geometrii (`STL`, `STEP`, gotowe `.msh/.vtk`)
2. `S1b` — tetra meshing dla FEM
3. `S1c` — voxelization / `active_mask` dla FDM z tych samych assetów
4. `S1d` — surface export (`STL`) do debugowania, porównań i UI

To jest ważne, bo sam “pipeline FEM” nie wystarczy do sensownego przełączania backendów.

### Szacowana kolejność realizacji

```
S1 (geometry assets + meshing + voxelization) ─────────┐
                       ├──→ S2 (CPU engine) ──→ S3 (runner) ──→ S4 (GPU)
                       │                                         │
                       └──→ S5 (frontend) ←──────────────────────┘
                                                                  │
                                                            S6 (validation)
```

---

## 5. Zewnętrzne zależności do dodania

### Python

| Pakiet | Wersja min. | Cel |
|--------|-------------|-----|
| `gmsh` | ≥4.12 | Generowanie siatek tetraedrycznych |
| `meshio` | ≥5.3 | I/O siatek w wielu formatach |
| `trimesh` | ≥4.2 | STL import/export, sanity checks, surface preprocessing, FDM voxelization helpers |
| `numpy` | ≥1.24 | (już jest) Operacje na tablicach siatki |

### Rust

| Crate | Cel |
|-------|-----|
| `nalgebra` | Algebra liniowa (macierze elementowe, P1 shape functions) |
| `nalgebra-sparse` | Sparse CSR/CSC macierze (stiffness, mass) |
| `rustfft` | (już jest) FFT jeśli potrzebne w CPU demag |

### C++/CUDA (native/backends/fem)

| Biblioteka | Wersja | Cel |
|------------|--------|-----|
| MFEM | ≥4.7 | Mesh management, FE spaces, bilinear forms |
| libCEED | ≥0.12 | Matrix-free GPU operator evaluation |
| hypre | ≥2.30 | CG/GMRES + AMG preconditioner |
| CUDA Toolkit | ≥11.8 | cuSPARSE, cuFFT, thrust |
| SUNDIALS (opcjonalnie) | ≥6.7 | Adaptive RK integrators |

---

## 6. Kryteria akceptacji całego planu

| # | Kryterium | Miernik |
|---|-----------|---------|
| A1 | Box z Exchange+Demag uruchomiony na FEM CPU | Energia maleje monotonically |
| A2 | Energia wymiany FEM vs FDM na Box < 5% | Przy dopasowanym hmax ≈ dx |
| A3 | Czynnik demagnetyzacyjny FEM ≈ analityczny | $\|N_z - 1\| < 0.15$ dla cienkiej płyty |
| A4 | GPU FEM daje te same wyniki co CPU FEM | < 0.1% relative error |
| A5 | `fullmag script.py` z `backend="fem"` runs end-to-end | Artefakty identyczne w formacie |
| A6 | Mesh widoczny w przeglądarce (Three.js) | Interaktywna rotacja + kolorowanie |
| A7 | Cylinder meshed i executed | Krzywa geometria reprezentowana przez tet mesh |
| A8 | Cross-backend comparison page w UI | FDM vs FEM wynik obok siebie |
| A9 | STL import działa dla FEM i FDM | Ten sam asset `.stl` daje tet mesh albo voxelized `active_mask` |
| A10 | STL export działa | Możliwy export surface assetu / boundary skin do debugowania i porównań |

---

## 7. Powiązanie z istniejącym kodem

### Już istnieje i gotowe do użycia

| Komponent | Plik/Crate | Stan |
|-----------|-----------|------|
| `fm.FEM(hmax=, order=)` Python API | `model/discretization.py` | ✅ |
| `FemHintsIR { order, hmax }` | `fullmag-ir/src/lib.rs` | ✅ |
| `FemPlanIR` stub | `fullmag-ir/src/lib.rs` L295 | ✅ stub |
| `BackendTarget::Fem` | `fullmag-ir/src/lib.rs` L20 | ✅ |
| `ImportedGeometry(format=\"stl\")` semantyka | `docs/specs/geometry-policy-v0.md` | ✅ accepted |
| `EnergyTermIR::Exchange/Demag/Zeeman` | `fullmag-ir/src/lib.rs` | ✅ |
| `fullmag_backend.h` (abstract C ABI) | `native/include/` | ✅ |
| `native/backends/fem/CMakeLists.txt` | INTERFACE stub | ✅ |
| Three.js `MagnetizationView3D.tsx` | Instanced rendering | ✅ (do rozszerzenia o mesh) |
| `ViewCube.tsx` | Kamera kontrolna | ✅ |
| Physics docs 0410, 0430, 0450, 0470, 0490, 0510 | Formy słabe zamrożone | ✅ |
| tetmag/tetrax reference code | `external_solvers/` | ✅ do studiowania |

### Trzeba stworzyć

| Komponent | Etap | Szacowany nakład |
|-----------|------|------------------|
| `fullmag/meshing/gmsh_bridge.py` | S1 | 3 dni |
| `fullmag/geometry_assets/stl_io.py` lub analogiczny moduł | S1 | 2 dni |
| `fullmag/voxelization/stl_to_mask.py` lub analogiczny moduł | S1 | 3–4 dni |
| `MeshIR` (Rust) — format siatki w IR | S1 | 2 dni |
| FEM CPU engine w Rust (P1 tet) | S2 | 10–15 dni |
| Planner FEM lowering | S3 | 3 dni |
| Runner FEM dispatch | S3 | 2 dni |
| `fullmag_fem.h` (C ABI) | S4 | 2 dni |
| MFEM+libCEED+hypre C++ backend | S4 | 20–30 dni |
| `MeshViewer3D.tsx` (Three.js) | S5 | 5 dni |
| Cross-backend tests + UI | S6 | 5 dni |

---

## 8. Indeks plików planu

```
docs/plans/active/fem-gpu-implementation/
├── 00-overview.md              ← ten plik
├── 01-meshing-pipeline.md       ← S1: geometry assets + STL + meshing + voxelization
├── 02-cpu-reference-fem-engine.md ← S2: CPU FEM engine
├── 03-runner-planner-wiring.md  ← S3: Planner + Runner + Artifacts
├── 04-native-gpu-fem-backend.md ← S4: MFEM/libCEED/hypre GPU
├── 05-frontend-mesh-viewer.md   ← S5: Three.js tetrahedral viewer
└── 06-cross-backend-validation.md ← S6: FDM↔FEM comparison
```
