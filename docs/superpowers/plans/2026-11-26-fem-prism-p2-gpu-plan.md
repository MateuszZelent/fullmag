# Plan implementacji — Wave 1 (PR A, P0 #4): Cienkowarstwowe `pure_prism_p2` na FEM GPU + Zunifikowany CSR GPU DMI + Naprawa konforemności `layers=2`

> **Dla agentów wykonawczych:** Realizuj zadania w kolejności faz (Faza 0 → równoległa Faza 1 w osobnych `workspace:"share"` → Faza 2). Wszystkie komendy kompilacji i testów C++/CUDA/Rust oraz benchmarków wykonuj wyłącznie w zarządzanym środowisku Docker DEV uruchomionym przez `just docker-dev <source_root>` (lub `just fullmag-dev-container <script> <source_root>` zgodnie z `justfile` i `AGENTS.md`), nigdy przez hostowe `cargo`/`cmake` ani surowe `docker run` montujące katalogi cache hosta.

**Cel:** Odblokować w pełni produkcyjną ścieżkę cienkowarstwową `pure_prism_p2` ($P_1$ na $\mathbf{m}$ + konforemny potencjał $P_2$ `H1_WedgeElement(2)` na $\phi$) na FEM CPU i GPU (`cuDSS` oraz `cg_amg`), zastąpić elementowy kernel GPU DMI zunifikowanym preasemblowanym operatorem CSR DMI (obsługującym `tet4`, `prism6` i `mixed` z parytetem $\le 10^{-12}$ względem MFEM CPU), oraz naprawić błąd konforemności `6 nonconforming tet4 faces` dla `thin_film(layers=2, topology="prismatic", transition="pyramid_to_tetrahedra")`.

**Architektura:** Patrz szczegółowa specyfikacja projektowa [`2026-11-26-fem-prism-p2-gpu-design.md`](../specs/2026-11-26-fem-prism-p2-gpu-design.md) oparta w 100% na `origin/master` (`9ab99132d5`).

**Stos technologiczny:** C++20 / MFEM 4.10 / CUDA 12.4 + CUB + cuDSS + HYPRE, Rust (`fullmag-ir`, `fullmag-authoring`, `fullmag-api`, `fullmag-plan`, `fullmag-runner`), Python 3.10+ (`fullmag`, Gmsh 4.15, NumPy, SciPy HiGHS).

**Macierz wyłącznej własności plików (ZERO nakładania w Fazie 1):**
- **Phase 0 (`coordinator`):** `dmi_csr_state.hpp`, `dmi_csr_operator.hpp`, `dmi_csr_kernels.hpp`, `gpu_state.hpp`.
- **Track A (`mesher-author`):** `packages/fullmag-py/src/fullmag/{meshing/_gmsh_swept.py, meshing/_gmsh_types.py, meshing/_mesh_targets.py, meshing/persistence.py, meshing/asset_pipeline.py, world.py, model/discretization.py, runtime/script_builder.py}`, `packages/fullmag-py/tests/{test_mixed_element_meshing.py, test_pure_prism_shared_domain_meshing.py, test_script_builder_roundtrip.py}`.
- **Track B (`prism-dmi-author`):** `backends/fem/CMakeLists.txt` (sekcja `dmi_csr_*` + `fem_cuda_csr_dmi_prism_contract` dla kompilowalności już w Fazie 1!), `backends/fem/gpu/cuda/interactions/dmi/{dmi_csr_operator.cpp, dmi_csr_kernels.cu}`, `backends/fem/gpu/cuda/state/gpu_state.cpp`, `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`, `backends/fem/gpu/cuda/integrators/rk/{rk_plan.cpp, rk_dmi_fields.cu, rk_dmi_energy_reductions.cu}`, `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`, `backends/fem/tests/{gpu_state_runtime_contract.cpp, source_facade_gpu_state_contract.cpp, source_facade_cuda_kernels_contract.cpp, source_facade_gpu_rk_contract.cpp, gpu_rk_plan.cpp, relaxation_source_contract.cpp, cuda_csr_dmi_prism_contract.cpp}`.
- **Track C (`prism-gpu-unlock-author`):** `backends/fem/core/fem_mesh.cpp`, `backends/fem/tests/fem_mesh_contract.cpp`, `crates/fullmag-ir/src/{mesh_policy.rs, plan.rs, mesh_assets.rs, mixed_certificate.rs}`, `crates/fullmag-authoring/src/validation.rs`, `crates/fullmag-api/src/schemas/mesh.rs`, `crates/fullmag-plan/src/{mesh.rs, tests.rs}`, `crates/fullmag-runner/src/lib.rs`, `packages/fullmag-py/src/fullmag/model/problem.py`, `packages/fullmag-py/tests/test_mixed_p1_preflight.py`, `scripts/benchmarks/relax_film_compare_case.py`.
- **Phase 2 (`integrator/verifier`):** `backends/fem/CMakeLists.txt` (tylko wpis `fem_pure_prism_p2_gpu_contract`), `backends/fem/tests/fem_pure_prism_p2_gpu_contract.cpp`, `docs/physics/{0106*, 0431*, 1001*, README.md}`.

---

## Faza 0: Zamrożenie szwów interfejsowych (Koordynator — 1 commit przed rozgałęzieniem)

### Task 0.1: Nagłówki szwów CSR DMI i rozszerzenie `FemGpuState`

**Pliki:**
- Utwórz: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_state.hpp`
- Utwórz: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.hpp`
- Utwórz: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp`
- Edytuj: `backends/fem/gpu/cuda/state/gpu_state.hpp`

- [ ] **Krok 1:** Utwórz `dmi_csr_state.hpp` (nagłówek bez zależności CUDA/MFEM, bezpieczny dla `FULLMAG_HAS_MFEM_STACK=0` i `FULLMAG_HAS_CUDA_RUNTIME=0`):
```cpp
#pragma once
/*
 * GPU CUDA sparse CSR DMI device-state module header.
 *
 * Owns device-side off-diagonal skew-symmetric nodal edge vector CSR buffers
 * (d_ij = -d_ji, R_i = sum_j d_ij x m_j) for interfacial (+ rotated) and bulk
 * DMI channels, plus optional periodic class-reduced P^T D P buffers.
 */
#include <cstdint>

namespace fullmag::fem {

struct GpuDmiCsrChannelDeviceState {
    bool uploaded = false;
    uint64_t rows = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
    uint32_t *csr_row_offsets = nullptr;
    uint32_t *csr_col_indices = nullptr;
    double *csr_dx = nullptr;
    double *csr_dy = nullptr;
    double *csr_dz = nullptr;

    // Optional periodic class-level P^T D P representation (docs/physics/0810).
    bool periodic_reduced_ready = false;
    uint64_t periodic_reduced_rows = 0;
    uint64_t periodic_reduced_nnz = 0;
    uint64_t periodic_reduced_device_bytes = 0;
    uint32_t *periodic_reduced_row_offsets = nullptr;
    uint32_t *periodic_reduced_col_indices = nullptr;
    double *periodic_reduced_dx = nullptr;
    double *periodic_reduced_dy = nullptr;
    double *periodic_reduced_dz = nullptr;
    double *periodic_reduced_mass = nullptr;
    double *periodic_reduced_rx = nullptr;
    double *periodic_reduced_ry = nullptr;
    double *periodic_reduced_rz = nullptr;
};

struct FemGpuDmiCsrDeviceState {
    GpuDmiCsrChannelDeviceState interfacial{};
    GpuDmiCsrChannelDeviceState bulk{};
};

} // namespace fullmag::fem
```

- [ ] **Krok 2:** Utwórz `dmi_csr_operator.hpp` z deklaracjami host-side CSR i funkcjami asemblacji/uploadu/teardownu:
```cpp
#pragma once
/*
 * GPU CUDA sparse CSR DMI operator module header.
 *
 * Declares MFEM-backed assembly of skew-symmetric edge-vector DMI CSR data
 * (tet4, prism6, mixed), optional periodic class reduction, and GPU upload/free.
 */
#include "gpu/cuda/interactions/dmi/dmi_csr_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

struct GpuDmiCsrHostData {
    uint32_t rows = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> dx;
    std::vector<double> dy;
    std::vector<double> dz;

    bool has_periodic_reduced = false;
    uint32_t periodic_reduced_rows = 0;
    std::vector<uint32_t> periodic_reduced_row_offsets;
    std::vector<uint32_t> periodic_reduced_col_indices;
    std::vector<double> periodic_reduced_dx;
    std::vector<double> periodic_reduced_dy;
    std::vector<double> periodic_reduced_dz;
    std::vector<double> periodic_reduced_mass;
};

bool build_gpu_dmi_csr_from_mfem(
    const Context &ctx,
    bool bulk_mode,
    GpuDmiCsrHostData &out,
    std::string &error);

bool gpu_dmi_csr_upload_channel(
    FemGpuLifecycleDeviceState &lifecycle,
    GpuDmiCsrChannelDeviceState &channel,
    const GpuDmiCsrHostData &host_data,
    TransferAudit &audit,
    std::string &error);

void gpu_dmi_csr_free(
    FemGpuLifecycleDeviceState &lifecycle,
    FemGpuDmiCsrDeviceState &state);

bool context_upload_mfem_dmi_to_gpu_state(
    Context &ctx,
    std::string &error);

} // namespace fullmag::fem
```

- [ ] **Krok 3:** Utwórz `dmi_csr_kernels.hpp` (chroniony `#if FULLMAG_HAS_CUDA_RUNTIME`):
```cpp
#pragma once
/*
 * GPU CUDA sparse CSR DMI kernels module header.
 *
 * Declares deterministic row-wise CSR DMI field/energy SpMV and compensated
 * double-double polarized energy increment wrappers for arbitrary H1 P1 meshes.
 */
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Deterministic row-wise CSR DMI field projection and optional per-block energy.
/// Pass energy_block_sums == nullptr on intermediate RK stages to skip energy reduction.
void fullmag_cuda_dmi_csr_field_energy(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int node_count,
    cudaStream_t stream = nullptr);

/// Periodic class-reduced P^T D P CSR DMI field projection and optional per-block energy.
/// periodic_reduced_representative_nodes is reduced-row-indexed (len == reduced_row_count).
void fullmag_cuda_dmi_csr_periodic_field_energy(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_dx,
    const double *reduced_dy,
    const double *reduced_dz,
    const double *reduced_mass,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_reduced_representative_nodes,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const uint8_t *magnetic_node_mask,
    double *reduced_rx,
    double *reduced_ry,
    double *reduced_rz,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int reduced_row_count,
    int node_count,
    cudaStream_t stream = nullptr);

/// Polarized CSR DMI energy increment E(m1)-E(m0) and conservative absolute scale S_abs
/// using double-double compensated arithmetic (supports both direct and periodic CSR).
/// When non-null, periodic_reduced_representative_nodes is reduced-row-indexed (len == row_count).
void fullmag_cuda_dmi_csr_energy_difference(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *m0x,
    const double *m0y,
    const double *m0z,
    const double *m1x,
    const double *m1y,
    const double *m1z,
    double *delta_block_sums,
    double *absolute_block_sums,
    int row_count,
    cudaStream_t stream = nullptr,
    const uint32_t *periodic_reduced_representative_nodes = nullptr);

} // namespace fullmag::fem
#endif
```

- [ ] **Krok 4:** W `backends/fem/gpu/cuda/state/gpu_state.hpp` dodaj `#include "gpu/cuda/interactions/dmi/dmi_csr_state.hpp"` oraz pole `FemGpuDmiCsrDeviceState dmi_csr{};` w `struct FemGpuState` zaraz po `legacy_exchange`.
- [ ] **Krok 5:** Zatwierdź commit Phase 0 (`chore(fem): freeze Wave 1 CSR DMI headers and FemGpuState seam`) i rozgałęź 3 równoległe worktree Fazy 1.

---

## Faza 1 — Ścieżka A (`mesher-author`): Naprawa `layers=2` + Generator `pure_prism` Shared-Domain

### Task A1: Deterministyczne rozplątywanie `same_side_two_owner_face` dla `layers >= 2`

**Pliki:**
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`

- [ ] **Krok 1:** Zaimplementuj w `_gmsh_swept.py` funkcję pomocniczą `_chebyshev_center_3d(normals: np.ndarray, offsets: np.ndarray) -> tuple[np.ndarray | None, float]`:
  - Podstawowa ścieżka: `scipy.optimize.linprog([0.0, 0.0, 0.0, -1.0], A_ub=np.hstack([-normals, np.ones((m, 1))]), b_ub=-offsets, bounds=[...], method="highs")` (z bezpiecznymi granicami na `x` w zakresie lokalnego pudełka gwiazdy powiększonego o `5×` rozpiętość).
  - Deterministyczny fallback czysto-NumPy (gdy brak `scipy` i $m \le 24$): wektoryzowane rozwiązanie przecięć $\binom{m}{4}$ czwórek płaszczyzn i wybór maksymalnego dopuszczalnego $r$.
- [ ] **Krok 2:** Zaimplementuj `_untangle_same_side_mixed_tetrahedra(gmsh: Any, *, max_passes: int = 8) -> int`:
  - W każdej iteracji zbierz w jednym przelocie wszystkie ściany `tet4` (4 ściany), `pyramid5` (4 ściany boczne, zapisz `pyramid_apices = arr[:, 4]`), `prism6` (2 podstawy trójkątne).
  - Wektoryzowane wykrywanie `same_side` w $O(F \log F)$: `np.sort(faces, axis=1)` → `np.lexsort` → filtr par o liczności dokładnie 2 (bez nonmanifold $\ge 3$) → `d0 * d1 > 0.0`. Gdy `len(bad_pairs) == 0`, zwróć liczbę przeniesionych węzłów.
  - Wyznacz zbiór odwróconych tetów $I = \{t : \text{bad\_face\_count}[t] \ge 2\}$ (jeśli `bad_pairs` niepuste, ale $I$ puste — zastosuj propagację BFS spójności znaku od ścian sąsiadujących z `prism6`/`pyramid5`/brzegiem zewnętrznym).
  - Wyznacz posortowanych rosnąco kandydatów `vid` z `dim == 3` i `vid not in pyramid_apices`.
  - Dla każdego `vid` zbuduj spójnie zorientowane półprzestrzenie gwiazdy $\mathcal{S}(\text{vid})$ (odwróć normalną dla $t \in I$, zachowaj dla $t \notin I$), wywołaj `_chebyshev_center_3d`, zweryfikuj $r > 0$, spadek liczby `same_side`, oraz że wszystkie tety w $\mathcal{S}(\text{vid})$ zachowują $|\det| > \text{global\_threshold}$.
  - Zastosuj ruch: `gmsh.model.mesh.setNode(vid, new_pos.tolist(), [])`, a następnie w każdym wolumenie `vtag` dotkniętym przez odwrócone tety $t \in I \cap \mathcal{S}(\text{vid})$ obróć wierzchołki `arr[idx, 2], arr[idx, 3] = arr[idx, 3], arr[idx, 2]` i zaktualizuj przez `removeElements(3, vtag, tet_tags)` + `addElementsByType(vtag, 4, tet_tags, arr.ravel())`.
  - Po wyjściu z pętli wykonaj końcowe sprawdzenie `same_side == 0`; jeśli pozostała jakakolwiek ściana `same_side`, rzuć `RuntimeError("mixed_tet_untangle_failed: remaining same_side_two_owner_face=...")` (fail-closed!).
- [ ] **Krok 3:** Podłącz `_untangle_same_side_mixed_tetrahedra(gmsh)` w `_execute_mixed_tet_repair_policy` (`_gmsh_swept.py:2213-2265`, **przed** wczesnym `if not before.element_tags: return before` oraz po ewentualnym `optimize()`) oraz jako szybki strażnik na końcu `_optimize_mixed_pyramid_apices` (tak aby optymalizacja wierzchołków piramid również nie mogła pozostawić `same_side > 0`).

### Task A2: Generator czysto-pryzmatycznej domeny współdzielonej `generate_pure_prism_box_airbox_mesh`

**Pliki:**
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/persistence.py`

- [ ] **Krok 1:** Dodaj opcjonalne pole `pure_prism_topology_certificate: dict[str, Any] | None = None`:
  - na `MeshData` (`_gmsh_types.py:2175,2241,2441`),
  - na zamrożonym dataclassie `SharedDomainBuildReport` (`_mesh_targets.py:772`, `@dataclass(frozen=True, slots=True)`),
  - oraz w serializacji / cache `persistence.py` (`:162,299,319,350,364,759,825,1049,1113`), zachowując 100% kompatybilność wsteczną dla V1/V2.
- [ ] **Krok 2:** W `_gmsh_swept.py` zaimplementuj `generate_pure_prism_box_airbox_mesh(...)`:
  - Waliduj ścisłe zawieranie pudełka filmu w airboxie, `n_layers >= 1`, `order == 1`, brak piramid/tetów, `thin_axis ∈ {"x", "y", "z"}`.
  - Na płaszczyźnie bazowej $w_0 = c_w - A_w / 2$ utwórz w `gmsh.model.geo`: prostokąt wewnętrzny $S_{\text{inner}}$ (`[l1, l2, l3, l4]`) oraz ramę zewnętrzną $S_{\text{outer}}$ z otworem `[-l4, -l3, -l2, -l1]`.
  - Skonfiguruj deterministyczne pole tła `MathEval` dla płynnego wzrostu w ramie 2D (`growth_rate = max(airbox.maximum_element_growth_rate, 1.25)`), `Mesh.Algorithm = opts.algorithm_2d`, `Mesh.RandomFactor = 0.0`, `Mesh.ElementOrder = 1`, `Mesh.RecombineAll = 0` na 2D.
  - Wyznacz poziomy dolne i górne przez `_box_airbox_layer_levels` (start $\Delta w = L_w / L$, wzrost `growth_rate`, limit $h_{\text{air}}$) i wykonaj 3 kolejne ekstruzje GEO z `recombine=True`:
    1. Dolne powietrze (`n_lower` warstw),
    2. Warstwa filmu + boczne powietrze (dokładnie `n_layers` jednorodnych warstw),
    3. Górne powietrze (`n_upper` warstw).
  - Zarejestruj grupy fizyczne Gmsh (zgodnie z `_gmsh_swept.py:3129-3132` — **bez fizycznego tagu `0`!**):
    - `addPhysicalGroup(3, [V_mag], tag=1)` z nazwą `"magnetic"`,
    - `addPhysicalGroup(3, [V_air_bot_inner, V_air_bot_outer, V_air_lat, V_air_top_inner, V_air_top_outer], tag=2)` z nazwą `"air"` (ekstraktor `_extract_mesh_data` → `_semantic_marker_from_name` w `_gmsh_extraction.py:251-255` mapuje `"air"` na semantyczne `element_markers == 0`!),
    - powierzchnia `10` (`"mag_air_interface"`: 2× `tri3` + 4× `quad4`) oraz powierzchnia `airbox.boundary_marker` (`"outer_boundary"`: 4× `tri3` + 12× `quad4`).
  - Wyekstrahuj siatkę istniejącym `_extract_mesh_data(..., has_physical_groups=True, boundary_role_markers=(10, int(airbox.boundary_marker)))`, użyj `_gmsh_cell_parts_in_extraction_order` do nadania ról części (`"magnetic"` / `"far_air"`), i zbuduj certyfikat `pure_prism_topology_certificate.v1` z kluczami `facet_family_counts_by_role_marker` używającymi ról `MeshIR` **`"material_interface:10"`** i **`"exterior:<outer_boundary_marker>"`**, `topology_fingerprint_version = "v3"`, `topology_fingerprint = mesh.topology_fingerprint_v3()`, `lower_air_layer_count`, `upper_air_layer_count`, `magnetic_plane_coordinates_m`, `scaled_jacobian_p05_by_family["prism6"] >= 0.1`, `nonconforming_face_count == 0`, `fallbacks_triggered == []`.

### Task A3: Publiczne API Pythona (`world.py`, `discretization.py`, `script_builder.py`, `asset_pipeline.py`)

**Pliki:**
- Edytuj: `packages/fullmag-py/src/fullmag/world.py`
- Edytuj: `packages/fullmag-py/src/fullmag/model/discretization.py`
- Edytuj: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Edytuj: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`

- [ ] **Krok 1:** W `world.py` zaktualizuj WSZYSTKIE miejsca walidacji, adnotacji `Literal` i propagacji certyfikatu:
  - adnotacje `Literal["pyramid_to_tetrahedra", "pure_prism", "reject"]` na `GeometryMeshHandle.__call__`, `.configure`, `.thin_film` (`:1754,1869,2228,2280-2288,2347,2391-2396`),
  - `_validate_mesh_spec` (`:1512,1584-1596`): akceptacja `"pure_prism"` przy `topology="prismatic"` (i zachowanie domyślnego `"pyramid_to_tetrahedra"`),
  - propagacja `pure_prism_topology_certificate` w budowaniu zasobów domeny (`:5885,9274`).
- [ ] **Krok 2:** W `model/discretization.py` zaktualizuj `_SWEEP_TRANSITION_POLICIES` (`:358`) oraz wszystkie walidatory/serializatory `transition_policy` (`:439,465,925,957,966`) o `"pure_prism"`.
- [ ] **Krok 3:** W `runtime/script_builder.py:9447` dopuść `mesh_config.get("transition_policy") in {"pyramid_to_tetrahedra", "pure_prism"}` i serializuj argument `transition="pure_prism"` w generowanym wywołaniu `.mesh.thin_film(...)`.
- [ ] **Krok 4:** W `meshing/asset_pipeline.py`:
  - W `_qualified_mixed_per_geometry_body_hmax` (`:2708,2712,2714`, wywoływanym na `:3004` przed `:3041`): gdy `transition_policy == "pure_prism"`, akceptuj `"pure_prism"` oraz `through_thickness_elements >= 1` (bez limitu `(1, 2, 3)`).
  - Na `:3003-3070` oraz `:3554+`: dla `transition_policy == "pure_prism"` (pojedynczy `Box`, `airbox is not None`, `order == 1`) wywołaj `generate_pure_prism_box_airbox_mesh(...)`, przekaż `pure_prism_topology_certificate` do `SharedDomainBuildReport` (`:4058,4103-4117`), ustaw `build_mode = "pure_prism_extruded_shared_domain"`, `degraded = False`, `fallbacks_triggered = []`.

### Task A4: Testy jednostkowe i integracyjne (Python)

**Pliki:**
- Edytuj: `packages/fullmag-py/tests/test_mixed_element_meshing.py`
- Edytuj: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`
- Utwórz: `packages/fullmag-py/tests/test_pure_prism_shared_domain_meshing.py`

- [ ] **Krok 1:** W `test_mixed_element_meshing.py` dodaj:
  - Test regresyjny `test_thin_film_prismatic_layers_2_300x300x5_conforming`: dokładna geometria `300×300×5 nm` ($h=2.5\text{ nm}$, airbox `900×900×600 nm`, `hmax=110 nm`) dla `layers=1, 2, 3` z `transition="pyramid_to_tetrahedra"` — asercje `certificate_status == "accepted"`, `nonconforming_face_count == 0`, `jacobian_min > 0` dla każdej rodziny, `tet4 p05 >= 0.1`, `pyramid5 p05 >= 0.1`, `prism6 p05 >= 0.1`.
  - Test jednostkowy `_untangle_same_side_mixed_tetrahedra` na syntetycznej 10-tetowej gwieździe z ręcznie odwróconą dwupiramidą (testuje zarówno ścieżkę `scipy.linprog`, jak i fallback NumPy oraz weryfikuje reorientację wierzchołków).
- [ ] **Krok 2:** W `test_script_builder_roundtrip.py:137,156` zaktualizuj oczekiwaną dziedzinę `Literal` dla `transition` / `transition_policy` do `{"pyramid_to_tetrahedra", "pure_prism", "reject"}` i dodaj round-trip dla `transition="pure_prism"`.
- [ ] **Krok 3:** W `test_pure_prism_shared_domain_meshing.py` przetestuj:
  - `thin_film(..., topology="prismatic", transition="pure_prism")` dla `layers = 1, 2, 3, 4` oraz dla osi `z` i `x` (pudełko obrócone): wyłącznie komórki `prism6`, ściany `tri3 | quad4`, role `material_interface:10` / `exterior:<marker>`, zero piramid/tetów, `nonconforming_face_count == 0`, `orphan_face_count == 0`, `nonmanifold_face_count == 0`, `magnetic_relative_volume_error < 1e-12`, `shared_domain_relative_volume_error < 1e-12`, `prism6 p05 >= 0.1`, `topology_fingerprint_version == "v3"`, ważny `topology_fingerprint_v3()`.
  - Zapis/odczyt cache w `persistence.py` zachowujący `pure_prism_topology_certificate`.
- [ ] **Krok 4:** Uruchom testy Track A:
  ```bash
  pytest packages/fullmag-py/tests/test_mixed_element_meshing.py packages/fullmag-py/tests/test_pure_prism_shared_domain_meshing.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -v
  ```
  Oczekiwany wynik: wszystkie testy `PASSED`.

---

## Faza 1 — Ścieżka B (`prism-dmi-author`): Zunifikowany preasemblowany CSR GPU DMI

### Task B1: Asemblacja host-side CSR DMI z MFEM i upload GPU (`dmi_csr_operator.cpp`)

**Pliki:**
- Utwórz: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp`

- [ ] **Krok 1:** Zaimplementuj `build_gpu_dmi_csr_from_mfem(const Context &ctx, bool bulk_mode, GpuDmiCsrHostData &out, std::string &error)`:
  - Pod `#if !FULLMAG_HAS_MFEM_STACK`: zwróć `false` z komunikatem `"CSR DMI assembly requires MFEM stack support"` (gwarantuje czysty build `bootstrap / native-modal-cabi-contract`).
  - Pod `#if FULLMAG_HAS_MFEM_STACK`:
    - Sprawdź `ctx.mfem_context.ready && ctx.mfem_context.mesh != nullptr && ctx.mfem_context.fes != nullptr` (dokładne nazwy pól z `dmi_interfacial.cpp:52-58,269`), `n_nodes = ctx.mesh.n_nodes`, `ctx.integration_weights.mfem_lumped_mass`.
    - Dla każdego elementu `elem` w `[0, ctx.mfem_context.mesh->GetNE())`: pomiń niemagnetyczne (identycznie jak `dmi_interfacial.cpp` / `dmi_bulk.cpp`: `magnetic_element_mask[elem] == 0`), pobierz `dofs` z `ctx.mfem_context.fes`, `fe`, `T`, regułę kwadratury `mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder())`.
    - Wyznacz uśrednione na elemencie współczynniki dokładnie jak w MFEM CPU:
      - dla `bulk_mode == true`: `elem_D_bulk` z `ctx.material_fields.Dbulk_field` (lub `ctx.dmi.bulk_D`),
      - dla `bulk_mode == false`: `elem_D_int` (gdy `interfacial_enabled`) z `ctx.material_fields.Dind_field` (lub `ctx.dmi.interfacial_D`) oraz `elem_D_rot` (gdy `rotated_interfacial_enabled`, `ctx.dmi.rotated_interfacial_D`).
    - W pętli po punktach kwadratury `q` oblicz `w = ip.weight * T->Weight()`, `fe->CalcShape(ip, shape)`, `fe->CalcPhysDShape(*T, dshape)`.
    - Dla każdej pary lokalnych DOF `(a, b)` z `gdof_a != gdof_b` (zachowując znaki `s_a = dofs[a] >= 0 ? 1.0 : -1.0`, `s_b = dofs[b] >= 0 ? 1.0 : -1.0`):
      $$\Delta\mathbf{g}_{ab} = w\, s_a s_b \left(\phi_a \nabla \phi_b - \phi_b \nabla \phi_a\right),$$
      i dodaj do wpisu `(gdof_a, gdof_b)`:
      - `bulk`: $\Delta\mathbf{d}_{ab} = D_e^{\text{bulk}}\,\Delta\mathbf{g}_{ab}$,
      - `interfacial`: $\Delta\mathbf{d}_{ab} = D_e^{\text{int}}\,(\Delta\mathbf{g}_{ab} \times \hat{\mathbf{n}}) + D_e^{\text{rot}}\,(0,\; -\Delta g_{ab,x},\; -\Delta g_{ab,y})$.
    - Skonsoliduj mapę sąsiedztwa do posortowanego CSR (`row_offsets`, `col_indices`, `dx`, `dy`, `dz`), odrzucając `col == row` oraz dokładne zera `dx == 0 && dy == 0 && dz == 0`.
    - Jeśli `!ctx.mesh.periodic_reduced_node.empty()`: zbuduj zredukowany graf klas $P^\top D P$ (`c = periodic_reduced_node[i]`, `c' = periodic_reduced_node[j]`, pomiń `c == c'`, zsumuj `dx/dy/dz`) oraz `periodic_reduced_mass[c] = sum_{i in c} ctx.integration_weights.mfem_lumped_mass[i]`.
- [ ] **Krok 2:** Zaimplementuj `gpu_dmi_csr_upload_channel`, `gpu_dmi_csr_free` (pod `#if FULLMAG_HAS_CUDA_RUNTIME` z dokładnym księgowaniem `lifecycle.device_bytes` i `TransferAudit`, wzorowane na `exchange_upload.cpp`, oraz bezpieczną obsługą **`nnz == 0`**, np. `D == 0.0`, gdzie `csr_col_indices`/`csr_d{x,y,z}` mogą być `nullptr`, a `uploaded = true` i `rows = host_data.rows`!) oraz `context_upload_mfem_dmi_to_gpu_state(Context &ctx, std::string &error)` (uploaduje kanał `interfacial` gdy `interfacial_enabled || rotated_interfacial_enabled`, oraz kanał `bulk` gdy `bulk_enabled`; gdy oba wyłączone — natychmiastowy no-op zwracający `true`).

### Task B2: Kernele CUDA CSR DMI (`dmi_csr_kernels.cu`)

**Pliki:**
- Utwórz: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu`

- [ ] **Krok 1:** Zaimplementuj `template <bool ComputeEnergy> __global__ void dmi_csr_field_energy_kernel(...)`:
  - **KRYTYCZNA ZASADA BEZPIECZEŃSTWA:** **ZERO wczesnych `return;` przed `cub::BlockReduce`!** Każdy wątek (również poza `i < node_count`) musi dotrzeć do `cub::BlockReduce` (użyj predykatu `double local_e = 0.0; if (i < node_count) { ... }`).
  - Wewnątrz `if (i < node_count)`: pętla `for (uint32_t k = row_offsets[i]; k < row_offsets[i + 1]; ++k)` wczytuje `j = col_indices[k]`, `(dx, dy, dz)`, `(mx[j], my[j], mz[j])` i akumuluje $\mathbf{R}_i \mathrel{+}= \mathbf{d}_{ij} \times \mathbf{m}_j$ (FMA).
  - Rzutowanie pola: obsłuż bezpiecznie `magnetic_node_mask == nullptr` (`const bool is_mag = (magnetic_node_mask == nullptr) || (magnetic_node_mask[i] != 0u);`); jeśli `is_mag && mass > 0.0`, zapisz `h_dmi_{x,y,z}[i] = R_i * (-1.0 / (kMu0 * ms_i * mass + 1e-300))`, inaczej `0.0`.
  - Gdy `ComputeEnergy == true`: `local_e = 0.5 * (mx[i]*Rx + my[i]*Ry + mz[i]*Rz)`; po bloku `if (i < node_count)` wykonaj `cub::BlockReduce<double, 256>::Sum(local_e)` i `if (threadIdx.x == 0) energy_block_sums[blockIdx.x] = block_sum;` (**ZERO globalnych `atomicAdd`!**).
  - W wrapperze `fullmag_cuda_dmi_csr_field_energy`: przy `node_count <= 0` wróć natychmiast; wybierz `ComputeEnergy = (energy_block_sums != nullptr)`.
- [ ] **Krok 2:** Zaimplementuj wariant periodyczny `fullmag_cuda_dmi_csr_periodic_field_energy`:
  - Kernel 1 (bez wczesnego `return;` przed `cub::BlockReduce`!): dla `c < reduced_row_count` oblicza $\mathbf{R}_c^{\text{class}} = \sum_{c'} \mathbf{d}_{c,c'}^{\text{red}} \times \mathbf{m}_{\text{rep}(c')}$ używając `periodic_reduced_representative_nodes`, zapisuje do `reduced_r{x,y,z}[c]`, i gdy `ComputeEnergy == true`, redukuje blokowo $\frac{1}{2}\mathbf{m}_{\text{rep}(c)} \cdot \mathbf{R}_c^{\text{class}}$.
  - Kernel 2 (1 wątek = 1 węzeł `i < node_count`): odczytuje `c = periodic_reduced_node[i]`, `M_c = reduced_mass[c]`, sprawdza `is_mag` (z `magnetic_node_mask == nullptr` traktowanym jako all-magnetic), rzutuje `h_dmi[i] = -R_c / (kMu0 * ms_i * M_c + 1e-300)`.
- [ ] **Krok 3:** Zaimplementuj `fullmag_cuda_dmi_csr_energy_difference` używając **`#include "gpu/cuda/relaxation/double_double.cuh"`** (przestrzeń nazw **`fullmag::fem::gpu_relax_dd`**: `Value`, `two_sum`, `two_diff`, `two_product`, `add`, `multiply`, `scale`, `rounded`, `magnitude`) — **ZERO wczesnych `return;` przed `cub::BlockReduce`!**:
  - Dla każdego wiersza `r < row_count`: `i = periodic_reduced_representative_nodes ? periodic_reduced_representative_nodes[r] : r`; oblicz $\mathbf{s}_i = \mathbf{m}_{1,i} + \mathbf{m}_{0,i}$ przez `gpu_relax_dd::two_sum(m1[i], m0[i])` i dla każdego sąsiada `j` oblicz $\mathbf{q}_j = \mathbf{m}_{1,j} - \mathbf{m}_{0,j}$ przez `gpu_relax_dd::two_diff(m1[j], m0[j])`.
  - Akumuluj skompensowany wkład `local_dd = gpu_relax_dd::add(local_dd, term_dd)` dla $\frac{1}{2}\mathbf{s}_i \cdot (\mathbf{d}_{ij} \times \mathbf{q}_j)$ oraz konserwatywną skalę błędów `local_abs` obejmującą zarówno `fabs(term.hi) + fabs(term.lo)`, jak i **podłogę błędu `DBL_EPSILON` na skali operandów** (`(|m0_i|+|m1_i|)(|m0_j|+|m1_j|)` przemnożoną przez `|d_ij|`, dokładnie jak `exchange_kernels.cu:338-349`), dzięki czemu `S_abs` pozostaje konserwatywne nawet dla stanów prawie antyrównoległych $\mathbf{m}_1 \approx -\mathbf{m}_0$!
  - Po bloku `if (r < row_count)` wykonaj dwie niezależne redukcje blokowe `cub::BlockReduce<double, 256>::Sum` do `delta_block_sums[blockIdx.x]` i `absolute_block_sums[blockIdx.x]`.

### Task B3: Podpięcie runtime GPU (state, bootstrap, RK, PGBB/NCG Armijo)

**Pliki:**
- Edytuj: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Edytuj: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
- Edytuj: `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp`
- Edytuj: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`
- Edytuj: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu`
- Edytuj: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`

- [ ] **Krok 1:** W `gpu_state.cpp`: dodaj `#include "gpu/cuda/interactions/dmi/dmi_csr_operator.hpp"`, zresetuj `state.dmi_csr = {};` w `reset_metadata(state)` oraz wywołaj `gpu_dmi_csr_free(state.lifecycle, state.dmi_csr);` w `gpu_state_destroy(state)`.
- [ ] **Krok 2:** W `gpu_state_runtime.cpp`:
  - Zmień `gpu_state_requires_tetrahedral_mesh_geometry(const Context &ctx)` (linie 23–28) na:
    ```cpp
    bool gpu_state_requires_tetrahedral_mesh_geometry(const Context &ctx)
    {
        return ctx.stt.zhang_li_enabled;
    }
    ```
  - W sekcji `#if FULLMAG_HAS_MFEM_STACK` (zaraz po `context_upload_mfem_exchange_to_gpu_state(ctx, error)` na linii 231) wywołaj `if (!context_upload_mfem_dmi_to_gpu_state(ctx, error)) { return gpu_bootstrap_failed(ctx, error); }`.
- [ ] **Krok 3:** W `rk_plan.cpp:160-166`: zastąp sprawdzenie `mesh_geometry.uploaded` walidacją kanałów CSR DMI:
  - Gdy `ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled`: wymagaj `gpu.dmi_csr.interfacial.uploaded && gpu.dmi_csr.interfacial.rows == ctx.mesh.n_nodes`.
  - Gdy `ctx.dmi.bulk_enabled`: wymagaj `gpu.dmi_csr.bulk.uploaded && gpu.dmi_csr.bulk.rows == ctx.mesh.n_nodes`.
- [ ] **Krok 4:** W `rk_dmi_fields.cu`: przełącz na `#include "gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp"`, wybieraj kanał `const auto &chan = bulk_mode ? gpu.dmi_csr.bulk : gpu.dmi_csr.interfacial;`, waliduj `chan.uploaded` (gdy `chan.nnz == 0`: wyzeruj `field.{x,y,z}` przez `cudaMemsetAsync` i wróć `true`!), a gdy `chan.nnz > 0` wywołaj `fullmag_cuda_dmi_csr_field_energy(..., /*energy_block_sums=*/nullptr, ...)` (lub `fullmag_cuda_dmi_csr_periodic_field_energy` z `gpu.mesh_regions.periodic_reduced_representative_nodes` gdy `chan.periodic_reduced_ready`).
- [ ] **Krok 5:** W `rk_dmi_energy_reductions.cu`: przełącz na `dmi_csr_kernels.hpp`; gdy `active_nnz == 0` wyzeruj `field.{x,y,z}` oraz `gpu_rk_final_scalar_result(gpu, slot)` przez `cudaMemsetAsync` i wróć `true`; inaczej oblicz `block_count = (active_rows + 255) / 256`, wywołaj `fullmag_cuda_dmi_csr[_periodic]_field_energy(..., gpu.reductions.scalar_workspace, ...)` + `fullmag_cuda_device_sum(gpu.reductions.scalar_workspace, block_count, gpu_rk_final_scalar_result(gpu, slot), ...)`.
- [ ] **Krok 6:** W `direct_energy_increment.cpp:297-335`: przełącz `add_dmi_difference` na `fullmag_cuda_dmi_csr_energy_difference` zapisujący per-blokowe sumy do `gpu.reductions.scalar_workspace` (`delta_block_sums`) i `gpu.rk.k[1].x` (`absolute_block_sums`, identycznie jak ścieżka exchange na liniach 268–292!), z przekazaniem `gpu.mesh_regions.periodic_reduced_representative_nodes` w trybie periodycznym, po czym wykonaj dwa wywołania `reduce_scalar_sum` na `dmi_reduction_blocks = (active_rows + 255) / 256` do `tail + delta_tail_slot` oraz `tail + absolute_tail_slot` (dla pustego `active_nnz == 0` wyzeruj oba sloty przez `cudaMemsetAsync`).
- [ ] **Krok 7:** **NIE modyfikuj** `dmi_kernels.{hpp,cu}` (legacy symbole `fullmag_cuda_dmi_field_energy` i `fullmag_cuda_dmi_energy_difference` pozostają nienaruszone dla wyroczni `relaxation_energy_derivative_contract.cpp:2620-2888`).

### Task B4: Spięcie `CMakeLists.txt` dla CSR DMI + Aktualizacja 6 testów fasady + `cuda_csr_dmi_prism_contract.cpp`

**Pliki:**
- Edytuj: `backends/fem/CMakeLists.txt` (tylko wpisy `dmi_csr_operator.cpp`, `dmi_csr_kernels.cu`, `fem_cuda_csr_dmi_prism_contract`)
- Edytuj: `backends/fem/tests/gpu_state_runtime_contract.cpp`
- Edytuj: `backends/fem/tests/source_facade_gpu_state_contract.cpp`
- Edytuj: `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`
- Edytuj: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Edytuj: `backends/fem/tests/gpu_rk_plan.cpp`
- Edytuj: `backends/fem/tests/relaxation_source_contract.cpp`
- Utwórz: `backends/fem/tests/cuda_csr_dmi_prism_contract.cpp`

- [ ] **Krok 1:** W `backends/fem/CMakeLists.txt`:
  - Dodaj `gpu/cuda/interactions/dmi/dmi_csr_operator.cpp` do bezwarunkowej listy źródeł C++ `fullmag_fem` (wewnętrzne `#if FULLMAG_HAS_MFEM_STACK` / `#if FULLMAG_HAS_CUDA_RUNTIME`).
  - Dodaj `gpu/cuda/interactions/dmi/dmi_csr_kernels.cu` w bloku `if(FULLMAG_ENABLE_CUDA)` obok `gpu/cuda/interactions/dmi/dmi_kernels.cu`.
  - Zarejestruj cel testowy `fem_cuda_csr_dmi_prism_contract` (pod `if(FULLMAG_ENABLE_CUDA AND FULLMAG_USE_MFEM_STACK)` linkujący `fullmag_fem`, `CUDA::cudart`, `MFEM::mfem`).
- [ ] **Krok 2:** Zaktualizuj dokładnie **6 testów kontraktowych** fasady źródłowej i runtime tak, aby odzwierciedlały przeniesienie DMI z `mesh_geometry` na `dmi_csr`:
  - `gpu_state_runtime_contract.cpp:74-89`: asercje `!gpu_state_requires_tetrahedral_mesh_geometry(ctx)` dla `interfacial_enabled` i `bulk_enabled`, oraz `true` dla `zhang_li_enabled`.
  - `source_facade_gpu_state_contract.cpp:106-143` **oraz `:983-992`**: `mesh_geometry` wymagane wyłącznie w `rk_zhang_li_torque.cu` i `ctx.stt.zhang_li_enabled`; usuń oczekiwanie na `gpu.local_interactions.vector.{x,y,z}` w `rk_dmi_fields.cu`/`rk_dmi_energy_reductions.cu` (CSR SpMV akumuluje w rejestrach bez bufora scatter!) i dodaj sprawdzenie substate `dmi_csr` w `gpu_state.hpp`, `rk_dmi_*`, `rk_plan.cpp`.
  - `source_facade_cuda_kernels_contract.cpp:1581-1588`: `rk_dmi_fields.cu` wywołuje `fullmag_cuda_dmi_csr_field_energy(`.
  - `source_facade_gpu_rk_contract.cpp:989-1015`: `rk_dmi_energy_reductions.cu` wywołuje `fullmag_cuda_dmi_csr_field_energy(`.
  - `gpu_rk_plan.cpp:123-125` **oraz `:268-303`**: `rk_dmi_fields.cu` wywołuje `fullmag_cuda_dmi_csr_field_energy(`; w teście gotowości `gpu_rk_plan_device_resident` (`:268-303`) sprawdzaj wymaganie `dmi_csr.{interfacial,bulk}.uploaded` zamiast `mesh_geometry.uploaded` / `"device-resident mesh geometry for DMI"`.
  - `relaxation_source_contract.cpp:2770-2798`: zaktualizuj asercje na `direct_energy_increment.cpp` (`dmi_csr` zamiast `gpu.mesh_geometry.nodes_xyz`), `gpu_state_runtime.cpp` (`return ctx.stt.zhang_li_enabled;` jako jedyny właściciel `mesh_geometry`), oraz `rk_plan.cpp` (`dmi_csr` dla DMI; `device-resident mesh geometry for Zhang-Li STT` zachowane!).
- [ ] **Krok 3:** Utwórz `backends/fem/tests/cuda_csr_dmi_prism_contract.cpp` testujący (pod `#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME`):
  1. Siatka `tet4`, czysta wielowarstwowa siatka `prism6` oraz mieszana `prism6 + pyramid5 + tet4`, niejednorodne skręcone pole $\mathbf{m}(\mathbf{x})$:
     - Conventional interfacial DMI z ukośną normalną $\hat{\mathbf{n}} = (0.3, -0.4, \sqrt{0.75})$,
     - Rotated interfacial DMI (Göbel $D_{\text{rot}} = 1.5\text{ mJ/m}^2$),
     - Jednoczesne interfacial + rotated + przestrzennie zmienne pole `Dind_field`,
     - Bulk DMI ($D_{\text{bulk}} = 2.0\text{ mJ/m}^2$) + przestrzennie zmienne `Dbulk_field`,
     - Przypadek zdegenerowany `D == 0.0` (`nnz == 0`) oraz `magnetic_node_mask == nullptr` (brak awarii, zerowe pole i energia).
     - Asercje: $\|\mathbf{H}_{\text{GPU}} - \mathbf{H}_{\text{CPU}}\|_\infty / \|\mathbf{H}_{\text{CPU}}\|_\infty \le 10^{-12}$ oraz $|E_{\text{GPU}} - E_{\text{CPU}}| / |E_{\text{CPU}}| \le 10^{-12}$.
  2. Test `energy_block_sums == nullptr`: identyczny bitowo wektor $\mathbf{H}_{\text{DMI}}$ bez dotykania bufora energii.
  3. Test spolaryzowanego przyrostu `fullmag_cuda_dmi_csr_energy_difference` dla małej perturbacji $\|\mathbf{m}_1 - \mathbf{m}_0\| \sim 10^{-7}$ oraz stanu prawie antyrównoległego $\mathbf{m}_1 \approx -\mathbf{m}_0$ na `prism6`: zgodność z $E_{\text{CPU}}(\mathbf{m}_1) - E_{\text{CPU}}(\mathbf{m}_0)$ do $\le 10^{-11}$ rel. oraz konserwatywne $S_{\text{abs}} \ge |\Delta E|$.
  4. Test periodyczny 2D na `tet4`: parytet GPU `periodic_reduced` CSR DMI z CPU MFEM $\le 10^{-12}$.

---

## Faza 1 — Ścieżka C (`prism-gpu-unlock-author`): Odblokowanie `pure_prism_p2` C++/Rust/Python + Benchmark

### Task C1: Odblokowanie bramek C++ w `fem_mesh.cpp` i testów `fem_mesh_contract.cpp`

**Pliki:**
- Edytuj: `backends/fem/core/fem_mesh.cpp`
- Edytuj: `backends/fem/tests/fem_mesh_contract.cpp`

- [ ] **Krok 1:** W `backends/fem/core/fem_mesh.cpp:863-973`:
  - Zmień `const bool dmi_supported = !has_dmi || explicit_cpu_or_cuda_device;` (zarówno CPU jak i CUDA obsługują teraz wszystkie 3 typy DMI przez CSR DMI).
  - Zmień `qualified_pure_prism_p2` na:
    ```cpp
    const bool qualified_pure_prism_p2 =
        pure_prism_cell_family && pure_prism_facet_families &&
        pure_prism_markers_cover_magnetic_and_air &&
        explicit_cpu_or_cuda_device;
    ```
  - Zaktualizuj komunikaty diagnostyczne i listę `failed_predicates`: usuń `pure_prism_p2_cpu_only`, `pure_prism_p2_dmi_not_qualified` oraz `gpu_dmi_kernel_not_mixed_p1`; w przypadku innego urządzenia raportuj `explicit_cpu_or_cuda_device`.
  - Zachowaj wszystkie pozostałe strażniki fail-closed (`plan_topology_matches_import_no_periodic`, `p1_magnetization_state`, `double_precision`, `exchange`, `poisson_robin_or_dirichlet`, `no_other_extended_physics` odrzucające Zhang-Li STT, Oersted, thermal, magnetoelastic, DG0 `Ms`).
- [ ] **Krok 2:** W `backends/fem/tests/fem_mesh_contract.cpp:374,654-685`:
  - Zmień dawne negatywne asercje `pure_prism_p2_cpu_only` i `gpu_dmi_kernel_not_mixed_p1` na **pozytywne** testy akceptacji: `pure_prism_p2 + cuda`, `pure_prism_p2 + cuda + interfacial/rotated/bulk DMI`, `mixed_p1 + cuda + DMI`.
  - Dodaj negatywne testy fail-closed: `pure_prism_p2 + cuda + zhang_li_stt` (musi odrzucić z `unrelated_extended_physics_scope` i `fallback=none`), `pure_prism_p2 + periodic` (musi odrzucić z `plan_topology_matches_import_no_periodic`), `pure_prism_p2` bez markerów powietrza (zachowane `prism_shared_domain_magnetic_air_markers`).

### Task C2: Rust IR — `PurePrism`, `PurePrismP2` i `PurePrismTopologyCertificateV1IR`

**Pliki:**
- Edytuj: `crates/fullmag-ir/src/mesh_policy.rs`
- Edytuj: `crates/fullmag-ir/src/plan.rs`
- Edytuj: `crates/fullmag-ir/src/mesh_assets.rs`
- Edytuj: `crates/fullmag-ir/src/mixed_certificate.rs`

- [ ] **Krok 1:** W `mesh_policy.rs`: dodaj `PurePrism` do `enum FemTransitionPolicyIR` (`:99`, `#[serde(rename_all = "snake_case")]` → `"pure_prism"`), dodaj `| FemTransitionPolicyIR::PurePrism` w ramieniu `(Triangular, Prism6, ...)` (`:862`) oraz `Some("pure_prism") => FemTransitionPolicyIR::PurePrism` w parserze (`:1347-1359`).
- [ ] **Krok 2:** W `plan.rs:1486` dodaj `PurePrismP2` do `enum FemMeshTopologyFamilyIR` (`#[serde(rename_all = "snake_case")]` → `"pure_prism_p2"`).
- [ ] **Krok 3:** W `mesh_assets.rs` dodaj `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)] #[serde(deny_unknown_fields)] pub struct PurePrismTopologyCertificateV1IR` z kompletem pól ze specyfikacji (§3.3) oraz opcjonalne pole `#[serde(default, skip_serializing_if = "Option::is_none")] pub pure_prism_topology_certificate: Option<PurePrismTopologyCertificateV1IR>` na `FemSharedDomainBuildReportIR`. Zaktualizuj `FemDomainMeshAssetIR::deserialize` (`:2287-2335`) o odczyt `mesh["pure_prism_topology_certificate"]`, oraz `validate()` (`:2437-2528`): wymuś wzajemną wyłączność (co najwyżej jeden z V1 / V2 / `pure_prism`), zweryfikuj `pure_prism_topology_certificate`, dopuść `PurePrismP2` w provenance (`:2511-2512`) oraz zachowaj `capability_status == Implemented` (`:2519-2528`, zero zmian w ścieżkach V1/V2!).
- [ ] **Krok 4:** W `mixed_certificate.rs` dodaj `pub fn validate_pure_prism_topology_certificate_against_mesh(mesh: &MeshIR, certificate: &PurePrismTopologyCertificateV1IR) -> Result<(), MeshValidationError>`:
  - Weryfikuje `schema_version == "pure_prism_topology_certificate.v1"`, `certificate_status == "accepted"`, `fallbacks_triggered.is_empty()`, **`topology_fingerprint_version == "v3"`** oraz dokładne dopasowanie **`mesh.mixed_topology_fingerprint_v3()`** (zgodnie z `mesh_hints.rs:3036-3044`!).
  - Weryfikuje wyłącznie `FemCellTypeIR::Prism6` w komórkach (obie części `Magnetic` i `FarAir` niepuste, zero `Pyramid5`, zero `Tet4`, zero `TransitionAir`), ściany `⊆ {Tri3, Quad4}` z obydwoma typami obecnymi i kluczami `facet_family_counts_by_role_marker` w konwencji `"material_interface:<marker>"` / `"exterior:<marker>"`.
  - Przelicza na nowo płaszczyzny warstw (`realized_layer_count == requested_layer_count >= 1`, `lower_air_layer_count >= 1`, `upper_air_layer_count >= 1`), pełną konforemność wszystkich ścian (`nonconforming_face_count == 0`, `orphan_face_count == 0`, `nonmanifold_face_count == 0`), dodatnie jakobiany i `scaled_jacobian_p05 >= 0.1` dla `prism6`, oraz domknięcie objętościowe.
  - Dodaj testy jednostkowe w `mesh_assets.rs`: ważny certyfikat `pure_prism_p2` przechodzi, sfałszowany fingerprint v3 / brak warstwy powietrza / wstrzyknięta piramida / jednoczesna obecność V1 + `pure_prism` / `nonconforming_face_count > 0` są odrzucane fail-closed.

### Task C3: Odblokowanie `authoring`, `api`, `plan`, `runner` i Python `problem.py`

**Pliki:**
- Edytuj: `crates/fullmag-authoring/src/validation.rs`
- Edytuj: `crates/fullmag-api/src/schemas/mesh.rs`
- Edytuj: `crates/fullmag-plan/src/mesh.rs`
- Edytuj: `crates/fullmag-plan/src/tests.rs`
- Edytuj: `crates/fullmag-runner/src/lib.rs`
- Edytuj: `packages/fullmag-py/src/fullmag/model/problem.py`
- Edytuj: `packages/fullmag-py/tests/test_mixed_p1_preflight.py`

- [ ] **Krok 1:** W `crates/fullmag-authoring/src/validation.rs`: akceptuj `"pure_prism"` w `transition_policy` obok `"pyramid_to_tetrahedra"` dla `topology == "prismatic"` (`:894,986`), oraz upewnij się, że kontrola sprzeczności dla `hex` (`:1004`) odrzuca również `"pure_prism"`.
- [ ] **Krok 2:** W `crates/fullmag-api/src/schemas/mesh.rs`: rozszerz kontrolę wzajemnej wyłączności certyfikatów (`:600-604`) o `pure_prism_topology_certificate`, a na `:670-715` — gdy `report.pure_prism_topology_certificate` jest obecne — wypełnij `requested_layered_policy` i `resolved_layered_policy` z `topology = "pure_prism_p2"`, `transition_policy = "pure_prism"` oraz zachowaj `mixed_topology_provenance`.
- [ ] **Krok 3:** W `crates/fullmag-plan/src/mesh.rs:1870-1925,2200-2245,2298-2394`:
  - W `reject_unsupported_mixed_topology`: rozpoznaj czysto-pryzmatyczną siatkę (`cells == [Prism6]`, `facets ⊆ {Tri3, Quad4}` z `Quad4`), wymagaj `report.pure_prism_topology_certificate` (`fem_pure_prism_p2_certificate_required` przy braku), zweryfikuj certyfikat przeciw siatce i zakresowi problemu (dowolne `requested_layer_count >= 1`, `cpu | gpu`, `double`, `P1`, `exchange`, `poisson_robin | poisson_dirichlet`, relaksacja lub dynamika, dozwolone wszystkie 3 DMI; brak periodic/Zhang-Li/Oersted/thermal/magnetoelastic).
  - W `resolve_fem_domain_mesh_asset` (`:2298-2394`): dodaj post-packing rebinding certyfikatu `pure_prism_topology_certificate` (przeliczenie `mixed_topology_fingerprint_v3()` po spakowaniu siatki) i emisję `FemMixedTopologyProvenanceIR` z `requested_topology = resolved_topology = PurePrismP2` oraz **`capability_status = FemMixedTopologyCapabilityStatusIR::Implemented`** (zgodnie z kontraktem IR i runnera!).
  - W `mixed_p1_scope_failed_predicates` (`:1887`): usuń gałąź `gpu_dmi_kernel_not_mixed_p1`.
- [ ] **Krok 4:** W `crates/fullmag-runner/src/lib.rs:2200-2208,2219-2260,2362-2363,2622,2654-2656,2684-2695`:
  - Na `:2200-2208`: obejmij `pure_prism_topology_certificate` w `has_mixed_metadata` (blokada na siatkach `tet4`) oraz w kontroli wzajemnej wyłączności V1/V2/pure_prism.
  - Na `:2219-2260`: dopuść rodzinę `cells == {Prism6}` + `facets ⊆ {Tri3, Quad4}` (z `Quad4`) z obowiązkowym `pure_prism_topology_certificate` (re-weryfikacja `mixed_topology_fingerprint_v3()`, `fallbacks_triggered == [] && !degraded`), na `:2362-2363` akceptuj `PurePrismP2` przy czysto-pryzmatycznym certyfikacie (z `capability_status == Implemented`), a na `:2622` zwolnij limit `!(1..=3)` do `>= 1` dla `pure_prism_p2`.
  - W `require_tetrahedral_fem_plan_mesh` (`:2684`): uwzględnij zarówno `mixed_layer_topology_certificate_v2`, jak i `pure_prism_topology_certificate` w `has_mixed_metadata`.
  - Usuń `gpu_dmi_kernel_not_mixed_p1` na `:2654-2656`.
- [ ] **Krok 5:** W `packages/fullmag-py/src/fullmag/model/problem.py`:
  - Na `:1488-1541`: strażnik pomijający natywną ścieżkę re-certyfikacji V2 cache, gdy zasób niesie `pure_prism_topology_certificate`.
  - Na `:2656`: zaakceptuj `transition_policy in {"pyramid_to_tetrahedra", "pure_prism"}` (z `layers >= 1` dla `"pure_prism"`).
  - Na `:2729-2730`: usuń `gpu_dmi_kernel_not_mixed_p1`.
- [ ] **Krok 6:** Zaktualizuj testy w `crates/fullmag-plan/src/tests.rs:17710-17728`, `crates/fullmag-runner/src/lib.rs:8871` oraz `packages/fullmag-py/tests/test_mixed_p1_preflight.py:90-135` (GPU DMI teraz akceptowane na `mixed_p1` i `pure_prism_p2`; dodaj pozytywne i negatywne fail-closed testy dla `pure_prism_p2`).

### Task C4: Rozszerzenie benchmarku `scripts/benchmarks/relax_film_compare_case.py`

**Pliki:**
- Edytuj: `scripts/benchmarks/relax_film_compare_case.py`

- [ ] **Krok 1:** Dodaj obsługę `FILM_FEM_MESH=pure_prism` (przekazuje `transition="pure_prism"` do `film.mesh.thin_film(...)`) oraz opcjonalnego `FILM_FEM_GPU_STRATEGY` (`auto | cudss | cg_amg`, domyślnie `"auto"`, przekazywane jako `gpu_strategy=GPU_STRATEGY` do `study.fem_demag_solver(...)`), bez zmiany domyślnego zachowania dla `prism` i `tet`.
- [ ] **Krok 2:** Uruchom testy Track C (wewnątrz uruchomionego kontenera Docker DEV z `just docker-dev <source_root>`):
  ```bash
  # W kontenerze Docker DEV (uruchomionym przez `just docker-dev <source_root>`):
  cargo test -p fullmag-ir -p fullmag-authoring -p fullmag-api -p fullmag-plan -p fullmag-runner
  pytest packages/fullmag-py/tests/test_mixed_p1_preflight.py -v
  ```
  Oczekiwany wynik: wszystkie testy Rust i Python `PASSED`.

---

## Faza 2: Integracja, CMake, Dokumentacja Naukowa i Pełna Walidacja A/B (`integrator/verifier`)

### Task 2.1: Test end-to-end `fem_pure_prism_p2_gpu_contract` w `CMakeLists.txt`

**Pliki:**
- Edytuj: `backends/fem/CMakeLists.txt` (tylko rejestracja `fem_pure_prism_p2_gpu_contract` — wpisy `dmi_csr_*` i `fem_cuda_csr_dmi_prism_contract` są już w Fazie 1 Track B!)
- Utwórz: `backends/fem/tests/fem_pure_prism_p2_gpu_contract.cpp`

- [ ] **Krok 1:** W `backends/fem/CMakeLists.txt` zarejestruj cel testowy `fem_pure_prism_p2_gpu_contract` pod `if(FULLMAG_ENABLE_CUDA AND FULLMAG_USE_MFEM_STACK)` linkujący `fullmag_fem`, `CUDA::cudart`, `MFEM::mfem`.
- [ ] **Krok 2:** Utwórz `backends/fem/tests/fem_pure_prism_p2_gpu_contract.cpp`:
  - Zbuduj wielowarstwową czysto-pryzmatyczną domenę współdzieloną (film `prism6` + otaczający airbox `prism6`, `layers = 2`, konforemne ściany `tri3`/`quad4`).
  - Uruchom w identycznej konfiguracji CPU MFEM oraz GPU (`cg_amg` i `cudss`) z `exchange + demag(poisson_robin) + interfacial_dmi + bulk_dmi`:
    - Zweryfikuj `potential_order == 2`, `scalar_dof_count > node_count`, `mesh_geometry.uploaded == false`, `dmi_csr.interfacial.uploaded == true`, `dmi_csr.bulk.uploaded == true`.
    - Zweryfikuj parytet pól i energii na kroku `RK4` oraz po relaksacji `PGBB` pomiędzy GPU (`cuDSS` i `cg_amg`) a CPU MFEM: **`<= 1e-11` rel.**!

### Task 2.2: Dokumentacja naukowa (`docs/physics/`) i spójność repozytorium

**Pliki:**
- Edytuj: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.{md,source-map.json}`
- Edytuj: `docs/physics/0431-fem-demag-mixed-order-potential.{md,source-map.json}`
- Utwórz: `docs/physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.{md,source-map.json}`
- Edytuj: `docs/physics/README.md`

- [ ] **Krok 1:** Zaktualizuj notę `0106` (i source-map): odnotuj odblokowanie GPU DMI przez CSR DMI na `mixed_p1` oraz deterministyczną naprawę `same_side_two_owner_face` metodą środka Czebyszewa dla `layers >= 2`.
- [ ] **Krok 2:** Zaktualizuj notę `0431` (i source-map): zaktualizuj status `pure_prism_p2` na pełne wsparcie FEM CPU i GPU (`cg_amg` oraz `cuDSS`) i podlinkuj `1001`.
- [ ] **Krok 3:** Utwórz `docs/physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.md` i `.source-map.json` (zgodnie z `.agents/skills/scientific-documentation-contract/SKILL.md`: `backend_matrix`, wszystkie `equations` i `symbols` z jednostkami SI, `sources` z istniejącymi symbolami, `public_api.parameters` dla `transition="pure_prism"`, sekcja `validation`), oraz dopisz wpis w `docs/physics/README.md`.
- [ ] **Krok 4:** Uruchom walidatory dokumentacji i spójności repo:
  ```bash
  python3 scripts/validate_scientific_docs.py
  python3 scripts/validate_changed_scientific_docs.py
  python3 scripts/check_repo_consistency.py
  ```
  Oczekiwany wynik: kod wyjścia `0` dla wszystkich 3 skryptów.

### Task 2.3: Pełna macierz weryfikacji w Docker DEV i benchmark A/B na RTX 4080 SUPER

Wszystkie poniższe kroki wykonuj w zarządzanym kontenerze Docker DEV uruchomionym przez `just docker-dev <source_root>` (lub dla pojedynczych skryptów Pythona przez `just fullmag-dev-container <script> <source_root>` zgodnie z `justfile`):

- [ ] **Krok 1 (Build non-MFEM — ochrona `bootstrap / native-modal-cabi-contract`):**
  ```bash
  cmake -S backends/fem -B /tmp/build-fem-nomfem -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF \
    && cmake --build /tmp/build-fem-nomfem -j \
    && ctest --test-dir /tmp/build-fem-nomfem --output-on-failure
  ```
  Oczekiwany wynik: czysty build bez MFEM/CUDA i wszystkie testy `PASSED`.
- [ ] **Krok 2 (Build FEM GPU CUDA + CTest):**
  ```bash
  cmake --build build/fem-gpu -j \
    && ctest --test-dir build/fem-gpu -R 'fem_(mesh|mixed_p1|gpu_state_runtime|source_facade_gpu_state|source_facade_cuda_kernels|source_facade_gpu_rk|gpu_rk_plan|relaxation_source|dmi|relaxation_energy_derivative|cuda_csr_dmi_prism|pure_prism_p2_gpu)' --output-on-failure
  ```
  Oczekiwany wynik: wszystkie testy C++/CUDA `PASSED` (w tym niezmodyfikowana wyrocznia `fem_relaxation_energy_derivative_contract`!).
- [ ] **Krok 3 (Rust + Python full suite):**
  ```bash
  cargo test -p fullmag-ir -p fullmag-authoring -p fullmag-api -p fullmag-plan -p fullmag-runner
  pytest packages/fullmag-py/tests/test_mixed_element_meshing.py packages/fullmag-py/tests/test_pure_prism_shared_domain_meshing.py packages/fullmag-py/tests/test_script_builder_roundtrip.py packages/fullmag-py/tests/test_mixed_p1_preflight.py -v
  ```
- [ ] **Krok 4 (Flagowy benchmark walidacyjny A/B na RTX 4080 SUPER — 300×300×5 nm Py vs Aharoni `4.632850e-18 J`):**
  ```bash
  # A3: weryfikacja konforemności layers=2 (mixed_p1)
  FILM_ENGINE=fem FILM_FEM_MESH=prism FILM_FEM_LAYERS=2 FILM_MAX_STEPS=5 python3 scripts/benchmarks/relax_film_compare_case.py
  # B1: flagship pure_prism_p2 layers=1 GPU cuDSS
  FILM_ENGINE=fem FILM_FEM_MESH=pure_prism FILM_FEM_LAYERS=1 FILM_FEM_GPU_STRATEGY=cudss python3 scripts/benchmarks/relax_film_compare_case.py
  # B2: flagship pure_prism_p2 layers=2 GPU cuDSS
  FILM_ENGINE=fem FILM_FEM_MESH=pure_prism FILM_FEM_LAYERS=2 FILM_FEM_GPU_STRATEGY=cudss python3 scripts/benchmarks/relax_film_compare_case.py
  ```
  Zanotuj w `docs/physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.md`: liczbę DOF $P_2$, szczytowy VRAM `cuDSS`, `resolved_linear_solver == "cudss_direct"`, początkową $E_{\text{demag}}$ i jej błąd względem Aharoniego (`< 1%`), zrelaksowaną $E_{\text{total}}$ vs `tet P2`/FDM oraz czas całkowity ściany.

---

## Review Focus — Przypięte testy dla 5 przypadków brzegowych

| # | Przypadek brzegowy | Zadanie | Przypięty test weryfikujący |
|---|---|---|---|
| 1 | Znak `d_int = g × n_hat`, `d_rot = (0, -g_x, -g_y)`, `d_bulk = +g`, orientacja `dofs[i] < 0`, redukcja `P^T D P`, zero wczesnych `return;` przed `cub::BlockReduce`, `nnz == 0` / `magnetic_node_mask == nullptr`, i `gpu_relax_dd` + `DBL_EPSILON` dla `E(m1)-E(m0)` | Task B1, B2, B4 | `fem_cuda_csr_dmi_prism_contract` (`tet4` + `prism6` + `mixed`, wszystkie 3 DMI + spatial $D$ + `D==0` + near-antiparallel + periodic, błąd $\le 10^{-12}$ rel.) |
| 2 | Bufory potencjału $P_2$ (`scalar_dof_count > node_count`) i brak `tet4` `mesh_geometry` przy `pure_prism_p2` GPU + DMI | Task B3, 2.1 | `fem_pure_prism_p2_gpu_contract` + `fem_gpu_state_runtime_contract` (`cuDSS` + `cg_amg` + PGBB + RK4, parytet CPU $\le 10^{-11}$) |
| 3 | Reorientacja odwróconych tetów po rozplątaniu `layers=2` (brak ujemnych jakobianów, brak zniszczonych piramid, `same_side == 0`) | Task A1, A4 | `test_mixed_element_meshing.py::test_thin_film_prismatic_layers_2_300x300x5_conforming` + test syntetycznej dwupiramidy (`scipy` + NumPy fallback) |
| 4 | Kompilacja non-MFEM (`FULLMAG_HAS_MFEM_STACK=0`) i nieuszkodzenie legacy wyroczni `tet4` | Task 0.1, B1, B3, 2.3 | Build `-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF` + `fem_relaxation_energy_derivative_contract` |
| 5 | Ścisłe fail-closed dla niezakwalifikowanych kombinacji (`Zhang-Li STT`, `periodic`, brak certyfikatu, zły fingerprint `"v3"`, jednoczesne V1+`pure_prism`, `Hex8`) i nienaruszenie V1/V2 | Task C1, C2, C3 | `fem_mesh_contract`, `cargo test -p fullmag-ir -p fullmag-plan -p fullmag-runner`, `test_mixed_p1_preflight.py` |
