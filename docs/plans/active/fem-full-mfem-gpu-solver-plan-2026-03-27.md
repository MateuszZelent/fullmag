# Plan: Pełny solver FEM — measurement-driven GPU pipeline

- Status: **active**
- Data: 2026-03-27 (rev 2: korektury architektoniczne)
- Autorzy: Fullmag core
- Filozofia: **Measurement-driven: optymalizuj step_time_ms, eliminuj zbędne kopie,
  zapewnij stabilny step time i sensowny overlap — nie celuj w "100% utilization"
  jako KPI.**
- Powiązane fizyka:
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
  - `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Powiązane plany:
  - `docs/plans/active/fem-gpu-implementation/04-native-gpu-fem-backend.md`
  - `docs/plans/active/fem-adaptive-mesh-refinement-plan.md`
- Referencyjne solvery: tetmag (C++/CUDA), magpar, nmag

---

## 0. Diagnoza obecnego stanu

### Co jest zaimplementowane

| Komponent | Status | Lokalizacja |
|-----------|--------|-------------|
| FEM exchange (stiffness matrix) | ✅ CPU + MFEM assembled | `fem.rs` L727–767, `mfem_bridge.cpp` L592–667 |
| FEM Zeeman (uniform H_ext) | ✅ CPU + native | `fem.rs` L992–1021, `mfem_bridge.cpp` L836–883 |
| LLG Heun integrator | ✅ CPU (5 integratorów) + native (Heun) | `fem.rs` L246–642, `mfem_bridge.cpp` L1114–1285 |
| MFEM mesh/FE-space init | ✅ P1 na tetraedrach | `mfem_bridge.cpp` L885–1045 |
| Lumped mass matrix | ✅ | `mfem_bridge.cpp` L395–406 |
| **FEM demag** | ⚠️ **HYBRYDA FDM** | `fem.rs` L833–930, `mfem_bridge.cpp` L669–834 |

### Co jest hybrydą (problem)

**Demagnetyzacja** — jedyny term wymagający globalnego rozwiązania — jest realizowana przez:

```
FEM mesh (m na węzłach)
  → rasteryzacja do kartezjańskiej siatki FDM
    → FFT-based Newell tensor demag (fullmag_fdm_backend)
      → trilinearna interpolacja H_demag z powrotem na węzły FEM
```

To podejście:

1. **Wprowadza błąd interpolacyjny** — dwukrotna projekcja (FEM→FDM→FEM) traci dokładność,
   szczególnie na zakrzywionych granicach i interfejsach materiałowych.
2. **Wymaga podwójnej pamięci** — utrzymuje zarówno mesh FEM jak i siatkę FDM+FFT workspace.
3. **Limituje geometrię** — bounding box transfer grid musi ogarnąć cały mesh, więc wąskie/długie
   geometrie generują ogromne puste gridy.
4. **Blokuje multi-region** — `compute_exchange_for_magnetization()` w `mfem_bridge.cpp` L611
   jawnie odrzuca mixed-marker meshes.
5. **Nie korzysta z GPU do demag** — demag FDM backend może być CUDA-accelerated, ale to
   acceleracja FFT na Cartesian grid — nie FEM.
6. **Blokuje precyzję adaptacyjną** — nie da się refinować mesha w strefie demag niezależnie
   od transferowej siatki FDM.

### Cel końcowy

**Pełny FEM solver na GPU**: rozwiązanie potencjału skalarnego magnetostatyki
bezpośrednio na mesh tetraedrycznym, z assembled operatorami + hypre CG+AMG na GPU,
fused CUDA kernels dla LLG, async artifact pipeline.
Eliminacja zależności od `fullmag_fdm_backend` w ścieżce FEM.

Assembled+cuSPARSE jako first-class production path dla P1 tetra.
PA/libCEED promowane dopiero po benchmarkach (S14 gate).
Air-box Poisson jako v1, `shell_transform` jako pierwszy kandydat v2.

### Audyt paralelizmu (2026-03-27)

**Wniosek: obecna implementacja wykorzystuje ~15% dostępnych zasobów.**

| Warstwa | Co mamy | Co tracimy |
|---------|---------|------------|
| Rust CPU | rayon global thread pool (`configured_cpu_threads()`) | Brak NUMA awareness, brak CPU pinning |
| C++ native | Single-threaded (zero OpenMP, zero TBB) | 100% CPU cores idle poza jednym |
| CUDA FDM | 256-thread blocks, cuFFT, SoA layout | Default stream ONLY — zero overlap |
| CUDA streams | Brak (stream 0 only) | H2D/D2H blokuje compute → 30-50% idle SM |
| GPU memory | `cudaMalloc` + explicit memcpy | Per-step H2D/D2H zamiast device-resident |
| Reductions | Host-side po D2H scalar copy | Extra sync + latency |
| MFEM | FE spaces CPU-mode | `UseDevice(false)` — zero GPU execution path |
| hypre | Nie zintegrowany | — |
| libCEED | Nie zintegrowany | — |
| NUMA | Nie wykrywany | Cross-socket access penalty ~2× na dual-socket |

---

## 1. Architektura docelowa — pełne wykorzystanie sprzętu

### 1.1 Cel nadrzędny

Solver FEM musi **minimalizować time-to-solution** przy sensownym wykorzystaniu sprzętu:

- **Główne KPI**: `step_time_ms`, brak H2D/D2H w hot loopie, overlap streamów,
  solver iterations, zużycie pamięci
- **GPU**: device-resident dane, zero per-step transfers, overlap compute + I/O
- **CPU**: orchestration + artifact pipeline + stats + meshing — nie agresywny
  oversubscribed solver konkurujący o pamięć i cache
- **PCIe/NVLink**: overlapped H2D/D2H z compute via CUDA streams

**Nie optymalizujemy pod literalne "100% CPU i 100% GPU" jako KPI.**
Na pojedynczym GPU część CPU i tak musi zostać na launch, runtime, sterowanie I/O
i system. Pełne "zajęcie wszystkiego" często psuje przepływ danych i responsywność.

### 1.2 Model podziału pracy CPU↔GPU

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        KROK LLG (jeden timestep)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─── GPU Stream 0 (compute) ──────────────────────────────────────────┐    │
│  │  Exchange: PA operator apply (libCEED)                              │    │
│  │  Demag: CG+AMG Poisson solve (hypre GPU)                           │    │
│  │  Zeeman: trivial add kernel                                         │    │
│  │  LLG RHS: fused m×H + α·m×(m×H) kernel                            │    │
│  │  Normalize: per-node |m|=1 kernel                                   │    │
│  │  Scalar reductions: E_ex, E_demag, max_torque (device-side)        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─── GPU Stream 1 (async I/O) ──────────────────────────────────────┐     │
│  │  D2H: scalar stats (64 bytes) — overlapped z compute              │     │
│  │  D2H: magnetization snapshot (co N kroków) — overlapped           │     │
│  │  H2D: updated H_ext (jeśli zmienny w czasie)                      │     │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─── CPU (all cores, rayon + OpenMP) ────────────────────────────────┐    │
│  │  Thread group A: artifact I/O — VTK/CSV write, snapshot compress   │    │
│  │  Thread group B: live UI — WebSocket broadcast, JSON serialize     │    │
│  │  Thread group C: meshing — background re-mesh dla AMR (future)     │    │
│  │  Thread group D: statistics — rolling averages, convergence detect │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─── CPU Socket 0          ┐  ┌─── CPU Socket 1 (dual-socket) ─────┐    │
│  │  rayon threads 0..N/2    │  │  rayon threads N/2..N               │    │
│  │  NUMA-local alloc        │  │  NUMA-local alloc                   │    │
│  │  Own L3 cache domain     │  │  Own L3 cache domain                │    │
│  └──────────────────────────┘  └─────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Architektura operatorów

**Kluczowa zasada**: Operatory (exchange, demag, Zeeman) implementowane jako reusable
objects z operator seams — nie jako ad hoc time-stepping code. To umożliwia przyszłe
eigenproblemy (Bloch-phase), inne study types, i podpięcie PETSc/SLEPc bez rozrywania
time-domain backendu.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  LLG Time Integrator  (Heun baseline → adaptive later)                   │
│  RHS(m) = H_eff(m) wymaga na KAŻDYM stage:                               │
├──────────────┬──────────────────────────┬─────────────────────────────────┤
│  Exchange    │  Demagnetization         │  Zeeman                         │
│  ──────────  │  ───────────────         │  ──────                         │
│  K·m / M_L   │  Poisson: ∇²u = ∇·M     │  H_ext (uniform lub spatial)    │
│              │  H_d = -∇u               │                                 │
│  assembled   │  assembled + Hypre       │  1 kernel add                   │
│  SpMV        │  CG+AMG (GPU)            │                                 │
│  (cuSPARSE)  │  [PA: benchmark gate]    │                                 │
│  ~0.1ms      │  ~1-5ms (CG iterations)  │  ~0.01ms                        │
│  memory BW   │  compute bound           │  trivial                        │
│  limited     │  (AMG + SpMV)            │                                 │
├──────────────┴──────────────────────────┴─────────────────────────────────┤
│  ALL device-resident: m[], h_ex[], h_d[], h_ext[], h_eff[], u[]           │
│  Host copy: ONLY scalar stats (E, torque) per step via async D2H          │
│  Recovery (H_demag, H_eff): ONLY on output schedule, nie na każdym stage  │
├───────────────────────────────────────────────────────────────────────────┤
│  MFEM 4.7 + hypre 2.30 + CUDA 11.8+                                      │
│  + rayon (Rust orchestration)                                             │
│  [libCEED 0.12: only if PA benchmarks win on P1 tet]                     │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.4 Strategie optymalizacyjne (ponad baseline)

- **Inexact demag solve per stage**: tolerancję Poissona spiąć z błędem czasowym
  integratora, zamiast zawsze `rtol=1e-10`. Mniejsza tolerancja na predictor stage
  Heuna, pełna na corrector.
- **Double-buffered pinned snapshots**: dwa pinned host buffery dla snapshotów,
  żeby stream I/O nigdy nie czekał na writer.
- **Precompute element geometry**: gradienty kształtów, objętości, mapowania DOF
  i maski magnetic/support poza hot loop.
- **Assembled path as first-class citizen**: nie jako fallback "gorszy", tylko jako
  równorzędna ścieżka produkcyjna dla P1.
- **Solver setup amortization**: jawne polityki `rebuild_amg_every`, `reuse_symbolic`,
  `reuse_numeric`, zamiast jednego domyślnego zachowania.

---

## 2. Etapy implementacji (measurement-driven)

Etapy są celowo drobne — każdy ma jasny deliverable, jest testowalny, i nie wprowadza
więcej niż jednego nowego podsystemu naraz.

**Kluczowa zmiana vs v1**: multi-region (dawne S17) przeniesione do S08 — PRZED
optymalizacją GPU, żeby nie przerabiać RHS assembly, exchange masek, recovery i output
semantics drugi raz.

**PA/libCEED**: benchmark gate, nie dogmat. Dla P1 tetra assembled+cuSPARSE jest
pełnoprawną ścieżką produkcyjną.

```
FAZA A ── v1: region-aware air-box FEM demag + assembled/Hypre baseline
  S01  Air-box mesh generation (Gmsh pipeline)                    ✅ done
  S02  Scalar FE space + Poisson bilinear form (assembled CPU)    ✅ done
  S03  RHS assembly: ∫ M·∇v (source term)                        ✅ done
  S04  Poisson solve CG+Jacobi assembled (CPU baseline)           ✅ done
  S05  H_demag = -∇u recovery + energy accounting                ✅ done
  S06  Walidacja: sphere/ellipsoid vs analityka                   ⬜ deferred
  S07  Przełącznik demag realization (transfer-grid / poisson)    ✅ done
  S08  Multi-region foundation (material markers, exchange mask)  ✅ done

FAZA B ── v2: production GPU baseline (device residency + Hypre)
  S09  MFEM device vectors + CUDA memory management              ✅ done
  S10  Hypre GPU CG+AMG (BoomerAMG) dla Poisson                  ✅ done (gated)
  S11  Fused LLG RHS kernel + normalize + device-side reductions  ✅ done
  S12  Dual CUDA streams: compute/IO overlap                      ✅ done
  S13  Async artifact pipeline (double-buffered pinned snapshots)  ✅ done

FAZA C ── v3: benchmarked PA (only if measurements prove benefit on P1)
  S14  PA benchmark checkpoint: assembled vs PA on P1 tets        ✅ scaffold
  S15  [conditional] PA exchange / Poisson operators               ⬜ pending S14
  S16  [conditional] LOR preconditioner (for order > 1)            ⬜ pending S14

FAZA D ── v4+: advanced features (post-stable baseline)
  S17  Adaptive time stepping (Heun baseline stable first)        ✅ done
  S18  Usunięcie transfer-grid FDM + benchmarki końcowe           ✅ scaffold
```

**Nie w tym planie** (future seams):
- `shell_transform` jako pierwszy kandydat v2 open-boundary (przed BEM/FMM)
- Bogaty ABI integratorów — capability query + wewnętrzny enum, nie publiczny kontrakt
- NUMA-aware threading — przesunięte do osobnego planu optymalizacji CPU

---

### FAZA A — v1: region-aware air-box FEM demag

---

#### S01. Air-box mesh generation (Gmsh pipeline)

**Problem**: Poisson demag wymaga mesha obejmującego `Ω_m ∪ Ω_air`. Obecnie mesh obejmuje
tylko `Ω_m`.

**Deliverable**:
- Python helper `fullmag.meshing.add_air_box(mesh, factor=3.0, grading=0.3)` używający Gmsh API
- Graded mesh: gęsty przy powierzchni `∂Ω_m`, coarse na `∂D`
- Element markers: magnetic=1, air=0, propagowane do `MeshIR.element_markers`
- `FemPlanIR` z nowym polem `air_box_config { factor, boundary_condition, grading }`

**Pliki**:
- `packages/fullmag-py/` — nowy moduł meshing
- `crates/fullmag-ir/src/` — `FemPlanIR` rozszerzenie
- `examples/fem_airbox_sphere.py` — example

**Kryterium**: mesh z air-boxem widoczny w 3D viewer, markery poprawne.

**Trudność**: 🟡

---

#### S02. Scalar FE space + Poisson bilinear form (MFEM CPU assembled)

**Problem**: Potrzebujemy drugiej FE space na potencjał skalarny `u`, i Laplacian bilinear form.

**Deliverable**:
- `mfem::H1_FECollection` order=1 na CAŁYM mesh `D` (magnetic + air)
- `mfem::FiniteElementSpace` scalar (1 DOF/node)
- `mfem::BilinearForm` z `DiffusionIntegrator` (= ∫ ∇u·∇v dV)
- Opcjonalny `BoundaryMassIntegrator` dla Robin BC (β·∫ u·v dS na ∂D)
- Form assembled na CPU, `SparseMatrix` gotowa do solve

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — `init_poisson_space()`, `assemble_poisson_lhs()`
- `native/backends/fem/include/context.hpp` — nowe pola: `mfem_potential_fec`, `mfem_potential_fes`,
  `mfem_poisson_bilinear`, `mfem_poisson_matrix`

**Kryterium**: bilinear form assembled, SPD, `SparseMatrix::CheckFinite()` passes.

**Trudność**: 🟡

---

#### S03. RHS assembly: ∫ M·∇v (source term)

**Problem**: Prawa strona Poissona to $b(v) = \int_{\Omega_m} \mathbf{M} \cdot \nabla v\,dV$.
To nie jest standardowy `LinearForm` — to vector-field dot gradient of test function, zintegrowane
TYLKO po elementach magnetycznych.

**Deliverable**:
- Custom `LinearFormIntegrator` albo użycie MFEM `DomainLFGradIntegrator`
  z `VectorCoefficient` = M_s·m(x)
- Integration restricted to elements z marker=1 (magnetic)
- Odbudowa RHS na każdym kroku LLG (bo m się zmienia!)
- Optymalizacja: pre-assemble element-level structures, update only DOF values

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — `assemble_poisson_rhs(magnetization)`
- Ewentualnie nowy plik `native/backends/fem/src/poisson_rhs.cpp` z custom integratorem

**Kryterium**: RHS vector non-zero only at nodes touching magnetic elements;
  `b.Norml2() > 0` dla non-zero magnetyzacji.

**Trudność**: 🔴

---

#### S04. Poisson solve CG+Jacobi assembled (CPU baseline)

**Problem**: Mamy LHS (S02) i RHS (S03) — teraz trzeba rozwiązać `A·u = b`.

**Deliverable**:
- `MFEM::CGSolver` z `GSSmoother` lub `DSmoother` (diagonal) jako preconditioner
- Boundary conditions: Dirichlet u=0 na ∂D (via `EssentialTrueDofs`)
  lub Robin (jeśli zassemblowane w S02)
- Solver stats: iterations, final residual → context fields
- Warm-start: `u` z poprzedniego kroku jako initial guess (zbieżność 2-5× szybsza)

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — `solve_poisson(ctx, rhs, solution)`

**Kryterium**: CG zbieżność w <100 iteracji na sphere 10k nodes;
  residual < 1e-10.

**Trudność**: 🟡

---

#### S05. H_demag = -∇u recovery + energy accounting

**Problem**: Po rozwiązaniu Poissona, trzeba odzyskać pole demag `H_d = -∇u` na węzłach
magnetycznych i policzyć energię.

**Deliverable**:
- `H_demag` obliczone jako: gradient `u` interpolowany na węzły magnetyczne
  (opcja 1: `GradientGridFunction` + `GetVectorValue` per node;
   opcja 2: element-wise ∇u z shape function derivatives, lumped)
- Demag energy: $E_d = -\frac{\mu_0}{2}\int_{\Omega_m} \mathbf{M}\cdot\mathbf{H}_d\,dV$
  via lumped mass: `E_d = -μ₀/2 · Ms · Σᵢ (m·h_d)ᵢ · M_L_i`
- All observables: max|H_demag|, E_demag → step stats

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — `recover_demag_field()`, `compute_demag_energy()`

**Kryterium**: H_demag na uniformly magnetized sphere = `-M_s/3 ± 2%` (analytical).

**Trudność**: 🟡

---

#### S06. Walidacja: sphere/ellipsoid vs analityka + FDM cross-check

**Problem**: Musimy udowodnić że mesh-native demag jest poprawny zanim idziemy na GPU.

**Deliverable**:
- Test: uniformly magnetized sphere → H_demag_average = -M_s/3
- Test: prolate ellipsoid → analytyczne demagnetizing factors Nₓ, Nᵧ, N_z
- Test: cube → FDM vs FEM porównanie (<5% rel. error)
- Test: air-box convergence → E_demag vs air-box factor (3×, 5×, 10×, 20×)
- Test: mesh refinement convergence → E_demag vs h→0
- Raport z wykresami

**Pliki**:
- `crates/fullmag-runner/tests/` — nowe physics validation testy
- `docs/reports/fem-poisson-demag-validation.md`

**Kryterium**: wszystkie testy pass, raport z wykresami zbieżności.

**Trudność**: 🟡

---

#### S07. Przełącznik demag realization

**Problem**: Trzeba móc wybrać transfer-grid vs Poisson, i zachować fallback.

**Deliverable**:
- IR: `demag_realization: "transfer_grid" | "poisson_airbox" | "auto"`
- Planner: `auto` → `poisson_airbox` jeśli mesh ma air-box elementy; inaczej `transfer_grid`
- Native dispatch: `compute_demag_for_magnetization()` switch na realizację
- Python: `fm.Demag()` bez zmian (auto); `fm.Demag(realization="poisson")` explicit

**Pliki**:
- `crates/fullmag-ir/` — `EnergyTermIR::Demag` rozszerzenie
- `crates/fullmag-plan/` — logika wyboru
- `native/backends/fem/src/mfem_bridge.cpp` — dispatch

**Kryterium**: oba path'y działają, planner wybiera poprawnie.

**Trudność**: 🟢

---

#### S08. Multi-region foundation (material markers, exchange mask)

**Problem**: `compute_exchange_for_magnetization()` odrzuca meshes z mieszanymi markerami
(`is_fully_magnetic()` guard). Obecna konwencja "marker 1 = magnetic, reszta = air"
jest bootstrap-only. Trzeba zrobić jawną realizację region/material PRZED optymalizacją
GPU, żeby nie przerabiać RHS assembly, exchange masek i recovery drugi raz.

**Deliverable**:
- Usunięcie guardu `is_fully_magnetic()` z exchange path
- Exchange: operator application restricted do magnetic DOFs
  - Masking w kernel: zeruj `h_ex` na non-magnetic nodes
  - Pre-compute `magnetic_dof_mask` (bool per node) w init, reuse w hot loop
- Demag source term: `∫_Ω_m M·∇v` ograniczony do magnetic elements (marker-based)
  — to JUŻ działa (MagnetizationCoefficient zeruje na air elements)
- Poisson solve: na CAŁYM mesh D (magnetic + air) — to jest poprawne
- H_demag recovery: gradient `u` odczytywany TYLKO na magnetic nodes
- IR rozszerzenie: `MaterialIR` per region (lista materiałów + marker mapping)
  — na razie jeden materiał + mask, ale seam na multi-material

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — refactor exchange + demag
- `native/backends/fem/include/context.hpp` — `magnetic_dof_list`, `magnetic_node_mask`
- `crates/fullmag-ir/src/lib.rs` — region/material seam

**Kryterium**: multi-layer stack (100nm magnet / 5nm spacer / 100nm magnet)
daje poprawne pola i energie. Exchange zerowy na spacer nodes.

**Trudność**: 🟡

---

### FAZA B — v2: production GPU baseline

---

#### S09. MFEM device vectors + CUDA memory management

**Problem**: Obecnie pola (m, h_ex, h_demag, h_eff) to `std::vector<double>` na hoście.
Każdy operator kopiuje dane host↔device. To zabija wydajność.

**Deliverable**:
- Wszystkie field vectors jako `mfem::Vector` z `UseDevice(true)`
- MFEM memory manager kontroluje device allocation
- Magnetyzacja: `mfem::GridFunction` na device (komponentowa: gf_mx, gf_my, gf_mz)
- Potencjał: `mfem::GridFunction` na device
- Helper: `sync_to_host()` wywoływane TYLKO przy snapshot/export — NIE per step
- Eliminacja `std::vector<double>` w hot path

**Pliki**:
- `native/backends/fem/include/context.hpp` — refactor do `mfem::Vector`
- `native/backends/fem/src/context.cpp` — device allocation
- `native/backends/fem/src/mfem_bridge.cpp` — update all accessors

**Kryterium**: `nvprof`/`nsys` nie pokazuje H2D/D2H w hot loopie (poza initial + final + snapshots).

**Trudność**: 🟡

---

#### S10. Hypre GPU CG+AMG (BoomerAMG) dla Poisson

**Problem**: CG+Jacobi z S04 jest CPU-only. Trzeba przenieść iteracyjny solver na GPU
via hypre, który natywnie obsługuje GPU via `HYPRE_MEMORY_DEVICE`.

**Deliverable**:
- `HypreBoomerAMG` z MFEM jako preconditioner
  - `SetPrintLevel(0)`, `SetRelaxType(18)` (l1-scaled Jacobi — GPU-friendly)
  - `SetCoarsenType(8)` (PMIS — parallelize well)
  - `SetInterpType(6)` (extended+i)
  - `SetAggressiveCoarseningLevels(1)` (single aggressive level)
- `HyprePCG` jako solver wrapper, rtol=1e-10, max_iter=200
- Solver setup amortization: jawne polityki `rebuild_amg_every` (np. 50 kroków),
  `reuse_symbolic`, `reuse_numeric`
- Warm-start: previous `u` jako initial guess
- Inexact demag solve: tolerancję spiąć z błędem integratora
  (mniejsza tolerancja na predictor stage Heuna, pełna na corrector)

**Opcja GMRES**: Jeśli Poisson nie jest dokładnie SPD (Robin BC, mixed elements),
przełączenie na `HypreGMRES` zamiast PCG.

**Pliki**:
- `native/backends/fem/src/mfem_bridge.cpp` — `PoissonDemagSolver` class
- `native/backends/fem/include/context.hpp` — solver state: `HypreSolver*, HyprePCG*`

**Kryterium**: Poisson solve na GPU, <30 iterations, residual < 1e-10.
`nvidia-smi` pokazuje użycie GPU podczas solve.

**Trudność**: 🔴

---

#### S11. Fused LLG RHS kernel + normalize + device-side reductions

**Problem**: Obecnie LLG RHS jest CPU loop po węzłach. Na GPU trzeba fused kernel:
cross-product + damping + normalization + reduction w jednym launch.

**Deliverable**:
- CUDA kernel `llg_rhs_heun_fused`:
  ```
  __global__ void llg_rhs_fused(
    const double* mx, my, mz,
    const double* hx, hy, hz,
    double* dmx, dmy, dmz,
    double* block_max_rhs,
    double* block_dot_mh,
    double gamma, double alpha,
    int N
  )
  ```
- Normalization kernel: `normalize_unit_vectors(mx, my, mz, N)`
- Device-side reduction: `cub::DeviceReduce::Max()` dla max_torque, `Sum()` dla energii
- Scalar results → `double[8]` na device → single async D2H per step
- **Nie odzyskuj nodalnego H_demag/H_eff na każdym stage** — trzymaj w najbardziej
  naturalnej reprezentacji operatorowej, recovery tylko na output schedule

**Pliki**:
- Nowy: `native/backends/fem/src/kernels.cu` — fused kernels
- `native/backends/fem/src/mfem_bridge.cpp` — integracja z step loop

**Kryterium**: `nsys` profile: zero host-side computation per step.

**Trudność**: 🟡

---

#### S12. Dual CUDA streams: compute/IO overlap

**Problem**: Default stream (0) serializuje wszystko. Scalar D2H transfers blokują
następny kernel launch.

**Deliverable**:
- Stream 0 (compute): exchange SpMV → Poisson CG → Zeeman add → LLG RHS → normalize
- Stream 1 (I/O): async D2H scalar stats overlapped z compute kolejnego pod-kroku
- Event synchronization: compute stream signals "scalars ready",
  I/O stream copies po event
- `cudaStreamCreateWithPriority()`: compute = high, I/O = low
- Double-buffered pinned snapshots: dwa pinned host buffery → stream I/O
  nigdy nie czeka na writer

**Pliki**:
- `native/backends/fem/include/context.hpp` — `cudaStream_t compute_stream, io_stream`
- `native/backends/fem/src/mfem_bridge.cpp` — stream management
- `native/backends/fem/src/kernels.cu` — kernel launches z stream arg

**Kryterium**: `nsys` profiler: compute i I/O streams overlap ≥ 30% czasu.

**Trudność**: 🟡

---

#### S13. Async artifact pipeline (double-buffered pinned snapshots)

**Problem**: Zapis artefaktów (VTK, CSV, snapshots) blokuje step loop.

**Deliverable**:
- Dedykowany I/O thread pool (2-4 threads) na rayon z niskim priorytetem
- `crossbeam::channel` bounded (capacity=4) dla pending writes
- Step loop pushes `ArtifactJob` do kanału → nie czeka
- `cudaHostAlloc()` z `cudaHostAllocWriteCombined` dla pinned host buffer
- CPU pracuje jako orchestrator + artifact pipeline + stats — nie jako agresywnie
  oversubscribed solver

**Pliki**:
- Nowy: `crates/fullmag-runner/src/artifact_pipeline.rs`
- `native/backends/fem/src/mfem_bridge.cpp` — pinned buffer D2H

**Kryterium**: step time constant niezależnie od field_every_n.

**Trudność**: 🟡

---

### FAZA C — v3: benchmarked PA (conditional)

**Kluczowa zasada**: Dla P1 tetra nie zakładamy z góry, że PA/libCEED będzie lepsze od
assembled sparse path. MFEM PA jest szczególnie ważne na GPU i historycznie rozwijane
głównie dla tensor-product elements. libCEED sam podkreśla, że główny focus to high-order
FE. Na P1 tetra assembled+cuSPARSE może być szybszy ze względu na niską arithmetic
intensity.

---

#### S14. PA benchmark checkpoint: assembled vs PA on P1 tets

**Problem**: Trzeba empirycznie sprawdzić, czy PA daje korzyść na P1 tetrahedrach.

**Deliverable**:
- Benchmark harness: identical problem, assembled vs `AssemblyLevel::PARTIAL`
- Metryki: apply time, memory, iteration count, total step time
- Decision matrix: GPU model × mesh size × operator (exchange, Poisson)
- **Fizyczne testy, nie bitwise**: field comparison z normami względnymi,
  żaden test "exchange field bitwise identyczny" — MFEM `ceed-cuda` backend
  jest non-deterministic
- Trzy poziomy testów: operator unit tests, field comparison z normami względnymi,
  end-to-end physics tolerances

**Decyzja wyjściowa**: jeśli assembled wygrywa → zostaje jako primary path, PA
przesunięte do `order > 1` milestone.

**Trudność**: 🟢

---

#### S15. [conditional] PA exchange / Poisson operators

Realizowane TYLKO jeśli S14 wykaże korzyść PA na P1.

**Deliverable**:
- MFEM `BilinearForm` z `AssemblyLevel::PARTIAL` dla exchange i Poisson
- Seam na P2: przygotowany ale nie aktywowany

**Trudność**: 🟡

---

#### S16. [conditional] LOR preconditioner (for order > 1)

Realizowane dopiero gdy `fe_order > 1` jest dostępny.

LOR i matrix-free są szczególnie korzystne dla wyższych rzędów —
dla `order 1` nawet statyczna kondensacja "nie daje efektu".

**Deliverable**:
- `LORSolver` jako preconditioner: CG(PA operator) + AMG(LOR matrix)
- Aktywowany tylko gdy `fe_order > 1`

**Trudność**: 🔴

---

### FAZA D — v4+: advanced features

---

#### S17. Adaptive time stepping

Realizowane dopiero po stabilnym Heun baseline. IR fullmaga akceptuje dziś tylko `heun`,
a higher-order/adaptive integrators są draftem. Nie stabilizujemy bogatego ABI
integratorów — capability query + wewnętrzny enum, publicznie Heun jako v1.

**Deliverable**:
- DOPRI54 lub SSPRK3 — na podstawie pomiarów
- PI controller dla dt adaptation
- AMG reuse: ten sam preconditioner przez wszystkie stages
- GPU-resident: ZERO host compute w adapt loop

**Trudność**: 🟡

---

#### S18. Usunięcie transfer-grid FDM + benchmarki końcowe

**Problem**: Po walidacji S01-S17, transfer-grid hybryda w native backendzie jest zbędna.

**Deliverable A — cleanup**:
- Usunięcie `TransferGridState`, `ensure_transfer_grid_backend()`,
  `rasterize_magnetization_to_transfer_grid()`, `sample_cell_centered_vector_field()`
  z `mfem_bridge.cpp`
- Usunięcie `fullmag_fdm` z `native/backends/fem/CMakeLists.txt` target_link_libraries
- CPU reference Rust (`fem.rs`) ZACHOWUJE transfer-grid jako debug/comparison mode

**Deliverable B — benchmarki**:
- Benchmark suite: sphere 10k / 50k / 100k / 500k / 1M nodes
- Metryki per mesh size:
  - `step_time_ms` (total), `exchange_time_ms`, `demag_solve_time_ms`, `llg_rhs_time_ms`
  - `gpu_utilization_%`, `gpu_memory_mb`, `gpu_bandwidth_gb_s`
  - `cpu_utilization_%` (per core), `numa_local_ratio_%`
  - `demag_cg_iterations`, `demag_residual`
  - `E_demag_relative_error_%` vs analytical
- Porównanie z: tetmag, mumax3, OOMMF (na porównywalnym problemie)
- Raport z wykresami scaling: strong scaling (nodes) + GPU occupancy

**Pliki**:
- `native/backends/fem/` — cleanup
- `docs/reports/fem-gpu-performance-benchmark.md` — raport
- `scripts/analysis/` — benchmark runner scripts

**Kryterium**: 
1. `CMakeLists.txt` nie linkuje `fullmag_fdm`
2. GPU utilization ≥ 80% na 100k+ nodes
3. CPU utilization ≥ 70% na dual-socket przy artifact I/O
4. Raport z wykresami opublikowany

**Trudność**: 🟡

---

## 3. Krytyczne decyzje techniczne

### 3.1 Preconditioner dla Poisson na GPU

| Opcja | Pros | Cons | Verdict |
|-------|------|------|---------|
| **AMG (hypre BoomerAMG)** | Robustny, sprawdzony, GPU-ready | Wymaga assembled matrix | **S10 (production baseline)** |
| **LOR (Low-Order Refined)** | MFEM-native, auto-built | Memory niższa | S16 (only for order > 1) |
| **p-multigrid** | Czysto matrix-free | Custom impl, brak MFEM support | ❌ |
| **Chebyshev/Jacobi** | PA-friendly | >100 iter na Poisson | ❌ fallback only |

**Strategia**: assembled matrix + hypre BoomerAMG jako produkcyjny baseline (S10).
LOR/PA dopiero po benchmarkach i/lub przy `order > 1` (S16).

### 3.2 Model pamięci: device-first, host-never

```
REGUŁA: Jedyną daną kopiowaną D2H per step jest double[8] (skalary statystyk).
Magnetyzacja→host kopiowana jest WYŁĄCZNIE przy:
  - snapshot co N kroków (via async stream 1)
  - koniec symulacji
  - user-requested export
```

| Obiekt | Lokalizacja | Rozmiar (100k nodes) |
|--------|-------------|---------------------|
| m_xyz[3] | GPU only (mfem::Vector UseDevice) | 2.4 MB |
| h_eff[3], h_ex[3], h_demag[3] | GPU only | 7.2 MB |
| u_potential | GPU only | 0.8 MB |
| k1..k7 (DOPRI54 stages) | GPU only | 16.8 MB |
| Poisson operator (PA) | GPU only (quad-point data) | ~2 MB |
| LOR AMG hierarchy | GPU (hypre device mem) | ~40 MB |
| Transfer grid + FFT | **USUNIĘTE** | **0** |
| **Total GPU** | | **~70 MB** |

### 3.3 Memory budget per mesh size

| Mesh nodes | GPU memory (estimated) | Viable on |
|------------|----------------------|-----------|
| 50k | ~40 MB | Any GPU |
| 100k | ~70 MB | Any GPU |
| 500k | ~350 MB | 8+ GB GPU |
| 1M | ~700 MB | 16+ GB GPU |
| 5M | ~3.5 GB | 24+ GB GPU (A5000, A100) |

### 3.4 Performance target per step

| Operacja | Hybryda CPU (teraz) | Target GPU (S12-S13) |
|----------|---------------------|---------------------|
| Exchange H_ex | sparse matvec CPU ~2ms | PA apply GPU ~0.1ms |
| Demag H_demag | rasterize+FFT+sample ~3ms | CG(PA)+AMG(LOR) ~1-5ms |
| LLG RHS | CPU loop ~1ms | fused CUDA kernel ~0.05ms |
| Normalize | CPU loop ~0.3ms | CUDA kernel ~0.01ms |
| Scalar stats | CPU sum ~0.1ms | cub::Reduce ~0.02ms |
| **Łącznie per step (Heun)** | **~13ms** (2× RHS) | **~2-10ms** (2× RHS) |

### 3.5 Model wielowątkowości

```
Warstwa 1: GPU — sole owner of numerical compute
  MFEM assembled SpMV + hypre CG/AMG + custom CUDA kernels
  Streams: compute (high priority), I/O (low priority)

Warstwa 2: CPU — orchestrator + artifact pipeline
  Main thread: GPU kernel launches, synchronization, step control
  I/O threads (2-4): artifact write (VTK, CSV, WebSocket push)
  Stats thread: rolling averages, convergence detection
  NOTE: CPU NIE jest agresywnie oversubscribed solver — na GPU path
  CPU pracuje głównie jako orchestrator, nie jako compute engine

Warstwa 3: NUMA (future, osobny plan)
  Przesunięte poza ten plan — zostawione jako seam
```

---

## 4. Zależności i wymagania

### Wymagania build

| Dependency | Version | Cel | Etap |
|------------|---------|-----|------|
| MFEM | ≥ 4.6 | FE spaces, forms, device memory | S02+ |
| hypre | ≥ 2.28 | AMG preconditioner, PCG solver, GPU support | S10+ |
| CUDA toolkit | ≥ 11.8 | GPU execution, streams, cub | S09+ |
| CUB (CUDA) | bundled w CUDA | Device-side reductions | S11 |
| Gmsh | ≥ 4.11 | Air-box mesh generation (Python API) | S01 |
| crossbeam | ≥ 0.8 | Bounded MPMC channel for artifact pipeline | S13 |
| libCEED | ≥ 0.12 | [conditional] PA operators — only if S14 proves benefit | S15 |

### Wymagania runtime

- NVIDIA GPU z compute capability ≥ 7.0 (Volta+) — wymagane dla hypre GPU
- Driver ≥ 520
- Linux x86_64

---

## 5. Harmonogram i priorytety

```
FAZA A ── v1: region-aware air-box FEM demag
═══════════════════════════════════════════════════════════
  S01  Air-box mesh (Gmsh)              ████████ ✅
  S02  Scalar FE space + Poisson form   ████████ ✅
  S03  RHS: ∫ M·∇v source term         ████████ ✅
  S04  Poisson CG+Jacobi CPU            ████████ ✅
  S05  H_demag recovery + energy        ████████ ✅
  S06  Walidacja vs analityka           ░░░░░░░░ deferred
  S07  Demag realization switch         ████████ ✅
  S08  Multi-region foundation          ████████░░

FAZA B ── v2: production GPU baseline
═══════════════════════════════════════════════════════════
  S09  MFEM device vectors (CUDA mem)   ████████░░
  S10  Hypre GPU CG+AMG Poisson        ████████████░░
  S11  Fused LLG kernel + reductions    ████████░░
  S12  Dual CUDA streams overlap        ██████░░░░
  S13  Async artifact pipeline          ██████░░░░

FAZA C ── v3: benchmarked PA (conditional)
═══════════════════════════════════════════════════════════
  S14  PA benchmark checkpoint          ████░░░░░░
  S15  [cond] PA operators              ████████░░░░
  S16  [cond] LOR (order > 1)           ████████████░░

FAZA D ── v4+: advanced features
═══════════════════════════════════════════════════════════
  S17  Adaptive time stepping           ████████████░░
  S18  Cleanup FDM + benchmarki         ████████████░░
```

### Milestones

| Milestone | Etapy | Definicja sukcesu |
|-----------|-------|-------------------|
| **M1: "Mesh-native demag"** | S01–S07 | Poisson demag na CPU, auto-switch ✅ |
| **M2: "Region-aware"** | S08 | Multi-region z exchange mask, air-box poprawny |
| **M3: "GPU baseline"** | S09–S10 | Device vectors, Poisson solve na GPU via hypre |
| **M4: "Zero-copy GPU step"** | S11–S12 | Fused CUDA kernels, streams, zero host compute per step |
| **M5: "Production pipeline"** | S13 | Async I/O, double-buffered snapshots |
| **M6: "PA decision"** | S14 | Empiryczna decyzja: assembled vs PA na P1 |
| **M7: "Production FEM"** | S17–S18 | Adaptive dt, benchmarks, FDM removed |

### Dependency graph

```
S01 → S02 → S03 → S04 → S05 → S07
                                 ↓
                               S08 → S09 → S10
                                      ↓      ↓
                                      S11 → S12 → S13
                                                    ↓
                                                  S14 → [S15, S16]
                                                    ↓
                                                  S17 → S18
```

S06 (walidacja) może być realizowana w dowolnym momencie po S05.

---

## 6. Ryzyka

| # | Ryzyko | P | Wpływ | Mitygacja |
|---|--------|---|-------|-----------|
| R1 | PA na P1 tets nie daje speedup (low arith. intensity) | **Wysoki** | Średni | S14 benchmark gate; assembled+cuSPARSE jako production path |
| R2 | Air-box zbyt duży → za dużo DOF | Niskie | Średni | Graded mesh, `shell_transform` jako v2 |
| R3 | hypre AMG setup cost dominuje (~10ms vs ~3ms step) | Niskie | Średni | `rebuild_amg_every` policy; warm-start u |
| R4 | MFEM `ceed-cuda` non-deterministic → flaky tests | Śr | Niski | Physics tolerance tests, nie bitwise |
| R5 | LOR daje za dużo iteracji na P1 | Śr | Niski | S16 conditional, only for order > 1 |
| R6 | Multi-region przerabiany dwukrotnie (jeśli nie zrobiony wcześnie) | **Wysoki** | Wysoki | S08 przeniesione do Fazy A ✅ |
| R7 | Dual-stream overlap < 10% (GPU saturates PCIe) | Niskie | Niski | Double-buffered pinned snapshots |
| R8 | Higher-order integrators nie stabilne na stiff FEM | Śr | Średni | S17 dopiero po stable Heun baseline |

---

## 7. Metryki sukcesu końcowego

### Poprawność (fizyczne tolerancje, nie bitwise)

1. **FEM demag error < 2% vs analityka** (sphere N_demag, ellipsoid Osborn factors)
2. **Multi-region mesh** (magnet + spacer) daje poprawne pola i energie
3. **Transfer-grid path zachowany jako debug/reference mode** w CPU Rust engine
4. **Trzy poziomy testów**: operator unit tests, field comparison z normami względnymi,
   end-to-end physics tolerances (MFEM `ceed-cuda` backend jest non-deterministic —
   żadnych bitwise identity testów)

### Wydajność (measurement-driven KPI)

5. **`step_time_ms`** jako główny KPI — stabilny, bez skoków
6. **Brak H2D/D2H per step** (poza async scalar stats [64 bytes])
7. **Dual-stream overlap ≥ 30%** (`nsys` profiler: compute + I/O overlapped)
8. **Solver iterations** < 30 na Poisson solve
9. **Zużycie pamięci GPU** poniżej budżetu (70MB @ 100k nodes)
10. **Artifact write latency = 0** w step loop (async pipeline)

### Czystość kodu

11. **`native/backends/fem/CMakeLists.txt` nie linkuje `fullmag_fdm`**
12. **Zero `std::vector<double>` w hot path** — wyłącznie `mfem::Vector`
13. **Zero raw `cudaMalloc`** — wyłącznie MFEM device memory manager

### Benchmarki porównawcze

14. **GPU speedup ≥ 5× vs CPU reference** na mesh 100k+ nodes
15. Porównanie step time z: tetmag, mumax3 (na porównywalnym problemie)
16. Strong scaling report: 10k → 1M nodes
17. Roofline analysis: compute vs memory-bound identification per kernel

---

## 8. Co ten plan NIE obejmuje

- Exact open-boundary (FEM-BEM, FMM, H-matrix) — future seam via `demag_realization`
  (`shell_transform` jako pierwszy kandydat v2 przed BEM/FMM)
- DMI (Dzyaloshinskii–Moriya interaction) — odrębny physics note
- Periodic boundary conditions — odrębny plan
- Spin-transfer torque (STT) — odrębny plan
- Eigenmode analysis — odrębny plan (wymaga operator seams z Fazy A)
- Windows/macOS native builds — odrębny plan dystrybucji
- P2/P3 elements — future refinement po stabilnym P1 (triggers S15/S16)
- AMR (adaptive mesh refinement) — odrębny plan (`fem-adaptive-mesh-refinement-plan.md`)
- Multi-GPU (data-parallel mesh partitioning) — future plan po single-GPU stabilności
- CPU-only fallback optimization (Intel MKL, etc.) — CPU path zachowany as-is
- NUMA-aware threading — osobny plan optymalizacji CPU
- Bogaty publiczny ABI integratorów — capability query + wewnętrzny enum,
  nie "na twardo" SSPRK3/RK4/DOPRI54 jako stabilny kontrakt

---

## 9. Audyt obecnego paralelizmu (baseline przed optymalizacją)

Wynik audytu na dzień 2026-03-27. Podsumowanie co MAMY i czego BRAKUJE.

### CPU (Rust)

| Aspekt | Stan | Problem |
|--------|------|---------|
| Thread pool | rayon global, `configured_cpu_threads()` | Brak NUMA awareness |
| FFT demag | `par_chunks_mut` na Newell tensor | OK, ale zniknie z Poisson |
| LLG stepping | Sequential per-node loop | Brak SIMD, brak OpenMP |
| Artifact I/O | Synchroniczny w step loop | Blokuje compute |

### CPU (C++ native)

| Aspekt | Stan | Problem |
|--------|------|---------|
| MFEM operations | Single-threaded (no OpenMP) | Zero multi-core |
| hypre | Nie zintegrowany | — |
| OpenMP | Nie skompilowany (`#pragma omp` absent) | —|

### GPU (CUDA)

| Aspekt | Stan | Problem |
|--------|------|---------|
| FDM kernels | 256-thread blocks, cuFFT | OK ale FDM-only |
| CUDA streams | Default stream (0) only | Zero overlap |
| Memory | `cudaMalloc` + explicit H2D/D2H | Brak device-resident lifecycle |
| Reductions | Host-side after D2H | Waste |

### Memory layout

| Aspekt | Stan |
|--------|------|
| FDM fields | SoA (Structure of Arrays) — GPU-friendly ✅ |
| FEM fields | std::vector<double> — host-only ❌ |
| MFEM GridFunctions | CPU memory mode — no UseDevice ❌ |
