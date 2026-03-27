# Plan wdrożenia: Physics-Controlled Adaptive Mesh Refinement

**Data:** 2026-03-27
**Status:** Draft
**Powiązane dokumenty:**
- `docs/physics/0100-mesh-and-region-discretization.md`
- `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md` (§7 — deferred AMR)
- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/plans/active/fem-gpu-implementation/01-meshing-pipeline.md`
- `docs/plans/active/fem-mesher-ui-capability-matrix.md`

---

## 0. Motywacja

Aktualnie użytkownik sam dobiera `hmax` i ręcznie uruchamia studia zbieżności.
Cel: solver sam oblicza lokalne wskaźniki błędu $\eta_K$ i steruje Gmsh-em
tak, aby refinacja siatki była automatyczna (COMSOL-like AFEM loop).

Pipeline:  **solve → estimate → mark → remesh → transfer → solve …**

---

## 1. Etapy wdrożenia

| Etap | Zakres | Zależności | Priorytet |
|------|--------|-----------|-----------|
| E1 | 2D $A_z$ residual + jump estimator | `MeshTopology`, CPU FEM | **P0** |
| E2 | Dörfler marking | E1 | **P0** |
| E3 | Continuous `h_target` size field | E2 | **P0** |
| E4 | Smoothing / gradation limiter | E3 | **P0** |
| E5 | Gmsh background mesh via PostView | E4, `gmsh_bridge.py` | **P1** |
| E6 | Solution transfer (interpolacja po remeshu) | E5 | **P1** |
| E7 | AFEM outer loop + global stopping criterion | E6 | **P1** |
| E8 | 3D $H(\text{curl})$ Nédélec estimator | E7, MFEM backend | **P2** |
| E9 | Goal-oriented (adjoint) estymator | E8 | **P3** |

---

## 2. Etap E1 — Residual + Jump Estimator (2D, $A_z$)

### 2.1 Matematyka

Dla 2D magnetostatyki $-\nabla\cdot(\nu\nabla A) = J_z$, po rozwiązaniu $A_h$:

$$
\eta_K^2 = \underbrace{h_K^2 \|J_z + \nabla\cdot(\nu\nabla A_h)\|_{L^2(K)}^2}_{\text{volume residual}} + \underbrace{\frac{1}{2}\sum_{e \subset \partial K \cap \mathcal{E}_{\text{int}}} h_e \|\llbracket \nu\nabla A_h \cdot n_e \rrbracket\|_{L^2(e)}^2}_{\text{interface jump}}
$$

Gdzie:
- $R_K = J_z + \nabla\cdot(\nu\nabla A_h)$ — residuum objętościowe
- $J_e = \llbracket \nu\nabla A_h \cdot n_e \rrbracket$ — skok strumienia normalnego na krawędzi

### 2.2 Implementacja

**Lokalizacja:** nowy moduł `crates/fullmag-engine/src/fem_error_estimator.rs`

**Dane wejściowe:**
- `MeshTopology` (istniejący) — `coords`, `elements`, `grad_phi`, `element_markers`
- rozwiązanie $A_h$ (wektor DOF)
- parametry materiałowe $\nu(K)$, źródło $J_z(K)$

**Nowe struktury danych:**

```rust
/// Topologia krawędzi / ścian potrzebna do obliczenia skoków
pub struct FaceTopology {
    /// Dla każdej wewnętrznej ściany: (element_left, element_right, local_face_left, local_face_right)
    pub interior_faces: Vec<InteriorFace>,
    /// Dla każdej ściany brzegowej: (element, local_face, boundary_marker)
    pub boundary_faces: Vec<BoundaryFace>,
    /// Mapa element → lista ścian
    pub element_to_faces: Vec<Vec<usize>>,
}

pub struct InteriorFace {
    pub nodes: [u32; 3],       // (2 w 2D, 3 w 3D)
    pub elem_left: u32,
    pub elem_right: u32,
    pub area: f64,             // (długość w 2D)
    pub normal: [f64; 3],      // (2D: [nx, ny, 0])
}

/// Per-element error indicator
pub struct ErrorIndicators {
    pub eta_vol: Vec<f64>,     // η²_K,vol per element
    pub eta_jump: Vec<f64>,    // η²_K,jump per element
    pub eta_bc: Vec<f64>,      // η²_K,bc per element (opcjonalnie)
    pub eta_total: Vec<f64>,   // η²_K = sum of above
    pub eta_global: f64,       // η = sqrt(Σ η²_K)
}
```

**Algorytm (pseudokod):**

```
fn compute_error_indicators_h1(
    topo: &MeshTopology,
    faces: &FaceTopology,
    solution: &[f64],
    nu: &[f64],          // per-element
    source: &[f64],      // per-element J_z
) -> ErrorIndicators {
    for each element K:
        // 1. Volume residual
        grad_Ah = Σ_i solution[nodes[i]] * grad_phi[K][i]
        div_nu_grad = nu[K] * laplacian_Ah  // computed via FE derivatives
        R_K = source[K] - div_nu_grad
        h_K = element_diameter(K)
        eta_vol[K] = h_K² * |R_K|² * volume(K)

    for each interior face F = (K_left, K_right):
        // 2. Interface jump
        flux_left  = nu[K_left]  * (grad_Ah_left  · normal)
        flux_right = nu[K_right] * (grad_Ah_right · normal)
        jump = flux_left - flux_right
        h_F = face_diameter(F)
        contribution = h_F * jump² * area(F)
        eta_jump[K_left]  += 0.5 * contribution
        eta_jump[K_right] += 0.5 * contribution

    for each element K:
        eta_total[K] = eta_vol[K] + eta_jump[K] + eta_bc[K]

    eta_global = sqrt(Σ eta_total[K])
}
```

### 2.3 Testy

- **Unit:** Znane rozwiązanie analityczne (np. jednolity prąd w cylindrze), weryfikacja że estymator maleje z $h$ jak $O(h^p)$.
- **Regression:** Estymator na prostym kwadracie z 2 materiałami (duży skok $\mu$), sprawdzenie że jump dominuje na interfejsie.

**Lokalizacja testów:** `crates/fullmag-engine/tests/error_estimator_2d.rs`

---

## 3. Etap E2 — Dörfler (Bulk) Marking

### 3.1 Algorytm

Dany próg $\theta \in (0,1)$ (domyślnie $\theta = 0.3$):

1. Sortuj elementy malejąco po $\eta_K$.
2. Wybierz najmniejszy zbiór $\mathcal{M} \subset \mathcal{T}_h$ taki, że:
$$\sum_{K \in \mathcal{M}} \eta_K^2 \geq \theta \sum_{K \in \mathcal{T}_h} \eta_K^2$$
3. Oznacz elementy w $\mathcal{M}$ do refinacji.

### 3.2 Implementacja

**Lokalizacja:** `crates/fullmag-engine/src/fem_error_estimator.rs` (ten sam moduł)

```rust
pub struct MarkingResult {
    pub marked: Vec<bool>,       // true = refine
    pub n_marked: usize,
    pub fraction_marked: f64,    // |M| / |T_h|
    pub captured_error: f64,     // Σ_{K∈M} η²_K  /  Σ η²_K
}

pub fn doerfler_marking(
    indicators: &ErrorIndicators,
    theta: f64,               // default 0.3
) -> MarkingResult;
```

### 3.3 Parametry konfiguracyjne

| Parametr | Typ | Default | Opis |
|----------|-----|---------|------|
| `theta` | `f64` | `0.3` | Próg Dörflera |
| `max_fraction` | `f64` | `0.8` | Max ułamek elementów do refinacji (safety cap) |

---

## 4. Etap E3 — Continuous Size Field ($h_\text{target}$)

### 4.1 Formuła

Dla każdego elementu $K$:

$$
h_K^{\text{new}} = \text{clip}\!\left(h_K^{\text{old}} \left(\frac{\eta_{\text{tar}}}{\eta_K + \varepsilon}\right)^\alpha,\; h_{\min},\; h_{\max}\right)
$$

Gdzie:
- $\eta_{\text{tar}} = \text{TOL} / \sqrt{N_{\text{el}}}$ (equidistributed target)
- $\alpha = 0.5$ (2D), $\alpha = 0.4$ (3D)
- $\varepsilon = 10^{-14} \cdot \max_K \eta_K$ (regularyzacja)
- $h_{\min}$, $h_{\max}$ — bezwzględne limity rozmiaru elementu

### 4.2 Implementacja

**Lokalizacja:** `crates/fullmag-engine/src/fem_size_field.rs`

```rust
pub struct SizeFieldConfig {
    pub tolerance: f64,       // global TOL
    pub alpha: f64,           // exponent, default 0.5
    pub h_min: f64,           // absolute minimum
    pub h_max: f64,           // absolute maximum
    pub grad_limit: f64,      // gradation limiter ratio, default 1.3
}

pub struct SizeField {
    /// Per-element target sizes
    pub h_target: Vec<f64>,
    /// Per-node target sizes (interpolated for Gmsh)
    pub h_target_nodal: Vec<f64>,
}

pub fn compute_size_field(
    topo: &MeshTopology,
    indicators: &ErrorIndicators,
    config: &SizeFieldConfig,
) -> SizeField;
```

### 4.3 Tryb alternatywny: Dörfler → uniform refinement factor

Jeśli element $K \in \mathcal{M}$:
$$h_K^{\text{new}} = \gamma \cdot h_K^{\text{old}}, \quad \gamma = 0.5$$

W przeciwnym razie $h_K^{\text{new}} = h_K^{\text{old}}$.

Ten tryb jest prostszy i bardziej stabilny na start.

---

## 5. Etap E4 — Smoothing / Gradation Limiter

### 5.1 Algorytm

Iteracyjnie wymuszaj na sąsiadach:

$$
\frac{h_K}{h_{K'}} \leq g, \quad g \in [1.3, 1.5]
$$

**Pseudokod:**

```
repeat until converged:
    for each interior face F = (K, K'):
        if h_target[K] > g * h_target[K']:
            h_target[K] = g * h_target[K']
        if h_target[K'] > g * h_target[K]:
            h_target[K'] = g * h_target[K]
```

### 5.2 Implementacja

Dodatkowa funkcja w `fem_size_field.rs`:

```rust
pub fn apply_gradation_limit(
    faces: &FaceTopology,
    h_target: &mut [f64],
    grad_limit: f64,           // default 1.3
    max_iterations: usize,     // default 50
) -> usize;  // returns iterations used
```

---

## 6. Etap E5 — Gmsh Background Mesh via PostView

### 6.1 Pipeline

```
SizeField (Rust) → JSON/MSH export → Python gmsh_bridge → Gmsh PostView → new mesh
```

### 6.2 Zmiany w `gmsh_bridge.py`

Nowa funkcja:

```python
def generate_mesh_with_size_field(
    geometry_source: str | Path,
    size_field_data: dict,          # {nodes: [[x,y,z],...], values: [h1,h2,...]}
    mesh_options: MeshOptions,
) -> MeshData:
    """
    1. Import geometry into Gmsh
    2. Create PostView from size_field_data
    3. Set PostView as background mesh
    4. Generate mesh
    5. Return MeshData
    """
```

**Gmsh API calls:**

```python
# Create view with nodal size field
view_tag = gmsh.view.add("size_field")
gmsh.view.addModelData(
    view_tag, 0, "", "NodeData",
    node_tags, size_values
)
# Set as background mesh
bg_field = gmsh.model.mesh.field.add("PostView")
gmsh.model.mesh.field.setNumber(bg_field, "ViewTag", view_tag)
gmsh.model.mesh.field.setAsBackgroundMesh(bg_field)
gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
```

### 6.3 Nowe pole w `MeshOptions`

```python
@dataclass(frozen=True, slots=True)
class MeshOptions:
    # ... existing fields ...
    background_size_field: dict | None = None   # NEW: {nodes, values} for PostView
```

### 6.4 Format wymiany Rust → Python

Serializacja do JSON (przez `MeshIR` lub dedykowany struct):

```json
{
  "size_field": {
    "type": "nodal",
    "node_coords": [[x0,y0,z0], ...],
    "h_values": [h0, h1, ...]
  }
}
```

---

## 7. Etap E6 — Solution Transfer (Interpolacja po Remeshu)

### 7.1 Problem

Po wygenerowaniu nowej siatki trzeba:
$$u_h^{\text{old}} \mapsto u_h^{\text{new}}$$

### 7.2 Podejście

Dla $H^1$ (skalarny potencjał / $A_z$):
1. Dla każdego nowego node'a $x_{\text{new}}$, zlokalizuj element $K_{\text{old}}$ zawierający ten punkt.
2. Interpoluj: $u(x_{\text{new}}) = \sum_i N_i(x_{\text{new}}) \cdot u_i^{\text{old}}$

Dla $H(\text{curl})$ (Nédélec):
- Interpolacja tangencjalna na krawędziach — wymaga projekcji, nie zwykłej interpolacji punktowej.
- Zostawione na E8.

### 7.3 Implementacja

**Lokalizacja:** `crates/fullmag-engine/src/fem_solution_transfer.rs`

```rust
pub fn transfer_h1_solution(
    old_topo: &MeshTopology,
    old_solution: &[f64],
    new_topo: &MeshTopology,
) -> Vec<f64>;
```

Wewnętrznie:
- Buduj bounding-box tree (AABB tree) ze starej siatki.
- Dla każdego nowego node'a: locate → interpolate barycentrycznie.

---

## 8. Etap E7 — AFEM Outer Loop + Global Stopping Criterion

### 8.1 Algorytm AFEM

```
for iteration = 1..max_amr_iterations:
    1. SOLVE:    A_h = solve(mesh, materials, BCs)
    2. ESTIMATE: η_K = compute_error_indicators(mesh, A_h)
    3. CHECK:    if η_global ≤ TOL  →  STOP (converged)
    4. MARK:     M = doerfler_marking(η_K, θ)
    5. REFINE:   h_new = compute_size_field(η_K, config)
                 h_new = apply_gradation_limit(h_new)
    6. REMESH:   mesh_new = gmsh_remesh(geometry, h_new)
    7. TRANSFER: A_h = transfer_solution(mesh_old, A_h, mesh_new)
    8. mesh = mesh_new
```

### 8.2 Stopping Criteria

| Kryterium | Formuła | Default |
|-----------|---------|---------|
| Absolute | $\eta \leq \text{TOL}$ | `1e-3` |
| Relative improvement | $(\eta^{(n)} - \eta^{(n+1)}) / \eta^{(n)} < \delta$ | `0.05` |
| Max iterations | $n \leq n_{\max}$ | `8` |
| Max elements | $N_{\text{el}} \leq N_{\max}$ | `5 \times 10^6$ |
| Stagnation | 2 consecutive iterations with $< \delta$ improvement | — |

### 8.3 Integracja z istniejącą architekturą

**Python API (nowy interfejs):**

```python
sim = fm.FEM(order=1, hmax=5e-9)
sim.adaptive(
    tol=1e-3,
    max_iterations=8,
    theta=0.3,
    alpha=0.5,
    h_min=0.5e-9,
    h_max=20e-9,
    grad_limit=1.3,
)
sim.run()
```

**IR extension:** Nowe pole w `FemMeshAssetIR`:

```rust
pub struct AdaptiveConfig {
    pub enabled: bool,
    pub tolerance: f64,
    pub max_iterations: u32,
    pub theta: f64,
    pub alpha: f64,
    pub h_min: f64,
    pub h_max: f64,
    pub grad_limit: f64,
}
```

**Planner/Runner:** Nowa pętla w `fullmag-runner` obsługująca AFEM cykl zamiast jednorazowego solve.

---

## 9. Etap E8 — 3D $H(\text{curl})$ Nédélec Estimator

### 9.1 Matematyka

Dla $\nabla \times (\nu \nabla \times \mathbf{A}) + \sigma \partial_t \mathbf{A} + \alpha \mathbf{A} = \mathbf{J}_s$:

$$
\eta_K^2 = h_K^2 \|\mathbf{J}_s - \nabla\times(\nu\nabla\times\mathbf{A}_h) - \sigma\partial_t\mathbf{A}_h - \alpha\mathbf{A}_h\|_{L^2(K)}^2 + \sum_{f \subset \partial K \cap \mathcal{F}_{\text{int}}} h_f \|\llbracket \mathbf{n}_f \times (\nu\nabla\times\mathbf{A}_h) \rrbracket\|_{L^2(f)}^2
$$

Plus opcjonalny gauge termin:
$$\eta_{K,\text{div}}^2 = \beta \, h_K^2 \|\nabla\cdot\mathbf{A}_h\|_{L^2(K)}^2$$

### 9.2 Różnice vs. 2D $H^1$

| Aspekt | 2D $H^1$ | 3D $H(\text{curl})$ |
|--------|----------|---------------------|
| DOFs | nodalne (skalary) | krawędziowe (tangencjalne) |
| Residuum | $\nabla\cdot(\nu\nabla A_h)$ | $\nabla\times(\nu\nabla\times\mathbf{A}_h)$ |
| Jump | $\llbracket \nu\nabla A_h \cdot n \rrbracket$ | $\llbracket \mathbf{n} \times (\nu\nabla\times\mathbf{A}_h) \rrbracket$ |
| Transfer | punktowa interpolacja | tangencjalna projekcja na krawędzie |
| Dodatkowy term | — | $\nabla\cdot\mathbf{A}_h$ (gauge) |

### 9.3 Integracja z MFEM

MFEM wspiera AMR w $H(\text{curl})$ natywnie. Strategia:
1. Oblicz $\eta_K$ po stronie C++ (MFEM `L2ZienkiewiczZhuEstimator` lub custom).
2. Eksportuj wektor $\eta_K$ do Rust/Python przez FFI.
3. Buduj size field i remeshuj przez Gmsh (jak w E5) **LUB** użyj MFEM-owego wbudowanego AMR (conforming/non-conforming).

**Nowe pole w `fullmag_fem.h`:**

```c
typedef struct {
    double* eta_per_element;   // output: per-element error indicators
    uint32_t num_elements;
    double eta_global;         // output: global error estimate
} fullmag_fem_error_estimate;

fullmag_fem_return_code fullmag_fem_estimate_error(
    fullmag_fem_backend* backend,
    fullmag_fem_error_estimate* result
);
```

---

## 10. Etap E9 — Goal-Oriented (Adjoint) Estymator

### 10.1 Kiedy jest potrzebny

Gdy celem nie jest dokładne pole wszędzie, tylko konkretna wielkość (QoI):
- indukcyjność
- siła / moment na ciało
- średnie $\mathbf{B}$ w szczelinie
- strata Joule'a
- energia magnetyczna

### 10.2 Formuła

$$
\eta_K^{\text{goal}} \approx |R_K(z_h - I_h z_h)|
$$

Gdzie $z_h$ to rozwiązanie dualne/adjoint problemu:
$$a(v, z) = J(v) \quad \forall v$$
z $J(\cdot)$ = functional QoI.

### 10.3 Wymagania

- Solver musi umieć rozwiązać problem dualny (transpozycja operatora).
- Potrzeba drugiej siatki (lub wyższego rzędu) do estymacji $z_h - I_h z_h$.
- Implementacja nie wcześniej niż po pełnej walidacji E1–E8.

---

## 11. Zmiany w istniejących modułach

### 11.1 `crates/fullmag-ir/src/lib.rs`

- Dodać `AdaptiveConfig` do `FemMeshAssetIR`
- Dodać `SizeFieldData` jako opcjonalny attachment do `MeshIR`

### 11.2 `crates/fullmag-engine/src/fem.rs`

- Rozszerzyć `MeshTopology` o `FaceTopology` (budowaną raz przy inicjalizacji)
- Dodać `element_diameters: Vec<f64>` do `MeshTopology`

### 11.3 `packages/fullmag-py/src/fullmag/meshing/gmsh_bridge.py`

- Dodać `background_size_field` do `MeshOptions`
- Nowa funkcja `generate_mesh_with_size_field()`
- PostView import/export

### 11.4 `crates/fullmag-runner/`

- Nowy tryb `run_adaptive()` z pętlą AFEM
- Logowanie metryk adaptacji (η, N_el, h_min, h_max per iteracja)

### 11.5 `native/backends/fem/`

- Nowa funkcja FFI `fullmag_fem_estimate_error()` (E8)
- Eksport per-element $\eta_K$ przez C ABI

---

## 12. Nowe pliki

| Plik | Etap | Opis |
|------|------|------|
| `crates/fullmag-engine/src/fem_error_estimator.rs` | E1–E2 | Estymator + marking |
| `crates/fullmag-engine/src/fem_size_field.rs` | E3–E4 | Size field + gradation |
| `crates/fullmag-engine/src/fem_solution_transfer.rs` | E6 | Interpolacja po remeshu |
| `crates/fullmag-engine/src/fem_face_topology.rs` | E1 | Topologia ścian/krawędzi |
| `crates/fullmag-engine/tests/error_estimator_2d.rs` | E1 | Testy estymatora 2D |
| `crates/fullmag-engine/tests/adaptive_loop.rs` | E7 | Test pełnego cyklu AFEM |

---

## 13. Metryki sukcesu

| Metryka | Target |
|---------|--------|
| Estymator $\eta_K$ maleje z $h$ jak $O(h^p)$ na smooth solution | ✓ |
| Dörfler z $\theta=0.3$ daje optymalną rate $\|e\| \sim N^{-p/d}$ | ✓ |
| Pełny AFEM loop zbiegnie w ≤8 iteracji na standardowym benchmarku (L-shape, split ring) | ✓ |
| Gmsh PostView poprawnie steruje lokalnym rozmiarem (weryfikacja: h varia >10x w jednym meshu) | ✓ |
| Transfer nie degraduje rozwiązania > 1% w normie $L^2$ | ✓ |
| 3D Nédélec estymator consensus z MFEM reference estimator (≤5% relative) | ✓ |

---

## 14. Ryzyka i mitygacje

| Ryzyko | Prawdopodobieństwo | Mitygacja |
|--------|---------------------|-----------|
| Gmsh PostView nie daje wystarczającej kontroli nad lokalnym h | Niskie | Fallback: Box/Threshold size fields |
| Transfer solution jest niestabilny przy dużych zmianach siatki | Średnie | Clamp refinement ratio per iteration ($\gamma \geq 0.3$) |
| $H(\text{curl})$ jump termin jest kosztowny na GPU | Średnie | Obliczaj na CPU, koszt $O(N_\text{faces})$ jest akceptowalny |
| Gradation limiter nie zbiegnie | Niskie | Max 50 iteracji, fallback do uniform cap |
| Nieliniowy $B(H)$ destabilizuje AFEM | Średnie | Freeze adaptację na ostatnich 2 nieliniowych iteracjach |

---

## 15. Kolejność implementacji (timeline)

```
E1 (estimator 2D)  ─────┐
E2 (marking)       ─────┤
                         ├── Milestone 1: "estimator works on paper benchmarks"
E3 (size field)    ─────┤
E4 (gradation)    ──────┘

E5 (Gmsh PostView) ─────┐
E6 (transfer)       ────┤── Milestone 2: "closed AFEM loop on 2D"
E7 (outer loop)    ─────┘

E8 (3D Nédélec)   ──────── Milestone 3: "3D AFEM on MFEM backend"

E9 (goal-oriented) ─────── Milestone 4: "QoI-driven adaptivity"
```

Milestone 1 jest niezależny od zmian w Gmsh bridge i może być walidowany na istniejących siatkach.
Milestone 2 zamyka pętlę i daje pierwszy produkcyjny AFEM.
Milestone 3 jest zależny od stabilnego GPU backendu MFEM.
Milestone 4 jest research-grade, opcjonalny.
