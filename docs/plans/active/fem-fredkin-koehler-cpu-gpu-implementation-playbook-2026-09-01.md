# Szczegółowy playbook wdrożenia i refaktoryzacji FEM Fredkin–Koehler CPU/GPU

**Data:** 1 września 2026  
**Stan bazowy:** `master@ed1fd1c7d2513ea2f7f6e12ddb2d4f3e2fc6a267`  
**Dokument nadrzędny:** [plan ogólny](fem-fredkin-koehler-cpu-gpu-general-plan-2026-09-01.md)  
**Audyt:** [audyt bieżącego kodu](../../audits/fem-fredkin-koehler-cpu-gpu-audit-2026-09-01.md)  
**Tryb realizacji:** test-first, physics-first, małe PR-y, obowiązkowe receipts

---

## 1. Zasady wykonawcze

1. Nie promować capability na podstawie kompilacji lub smoke testu.
2. Nie portować na GPU błędu topologii lub gauge.
3. Nie kopiować kodu Tetmag; AGPL pozostaje granicą licencyjną.
4. Dense jest oracle z limitem, nie rozwiązaniem skalowalnym.
5. Nie budować drugiego stosu FEM. Używać istniejącego MFEM/Hypre/libCEED/CUDA.
6. Nie dodawać fizyki do `mfem_bridge.cpp`; bridge może tylko routować i tłumaczyć ABI.
7. Każdy hot-path buffer ma właściciela i zadeklarowaną residency.
8. Każdy solver publikuje residual, iteracje, convergence status i failure atomically.
9. Tolerancje fizyczne ustalać na podstawie zbieżności i oracle, nie arbitralnie.
10. Każdy etap kończy się testami zarządzanymi przez kanoniczne `just` recipes.

---

## 2. Docelowy podział modułów

### 2.1. Wspólne CPU-side metadata

Proponowane nowe lub rozdzielone pliki:

```text
backends/fem/cpu/mfem/interactions/
  demag_fem_bem_topology.hpp/.cpp
  demag_fem_bem_components.hpp/.cpp
  demag_fem_bem_geometry.hpp/.cpp
  demag_fem_bem_discrete_operators.hpp/.cpp
  demag_fem_bem_operator.hpp/.cpp
  demag_fem_bem_dense_cpu_operator.hpp/.cpp
  demag_fem_bem_h2_cpu_operator.hpp/.cpp
  demag_fem_bem_workspace.hpp/.cpp
  demag_fem_bem_solve.hpp/.cpp
  demag_fem_bem_telemetry.hpp/.cpp
```

Nie trzeba tworzyć wszystkich plików w jednym PR. Ważna jest granica odpowiedzialności:

```text
topology != geometry kernel != operator mode != FE solve != telemetry
```

### 2.2. GPU

```text
backends/fem/gpu/cuda/demag_fem_bem/
  device_topology.hpp/.cpp
  device_operators.hpp/.cpp
  device_workspace.hpp/.cpp
  dense_operator.hpp/.cu
  h2_operator.hpp/.cu
  boundary_kernels.hpp/.cu
  hypre_solve.hpp/.cpp
  stage_compute.hpp/.cpp
  recovery.hpp/.cu
  energy.hpp/.cu
  telemetry.hpp/.cpp
```

Wspólne elementy z `demag_poisson` należy przenieść do neutralnego podsystemu, zamiast kopiować:

```text
gpu/cuda/demag_common/
  csr_operator.*
  hypre_device_solver.*
  hypre_stream_interop.*
  solver_validation.*
  recovery_operator.*
  energy_reduction.*
```

---

## 3. Milestone 0 — status, manifest i baseline kontraktu

### `FK-M0-001` — zamrozić status capability

**Pliki:**

- `docs/specs/capability-matrix-v0.md`
- `docs/physics/0870-fem-bem-demag-open-boundary.md`
- `docs/physics/fem_demag_fem_bem.md`
- publiczne strony demag
- testy capability w plannerze/runnerze

**Zmiana:**

```text
CPU dense Fredkin–Koehler = reference_executable
strict GPU = unsupported
hybrid CPU fallback = compatibility
H2/FMM = target-only
```

**Testy:**

- Python/IR akceptuje nazwę modelu;
- CPU plan rozwiązuje model bez airboxu;
- strict GPU odrzuca z komunikatem wymieniającym brak device boundary operatora;
- hybrid ma jawny resolved mode.

**Gate:**

- żadna strona nie nazywa dense CPU skalowalnym production solverem;
- żadna strona nie nazywa hybrid fallback implementacją GPU.

### `FK-M0-002` — utworzyć manifest walidacyjny i wydajnościowy

**Utworzyć:**

```text
docs/validation/fem_fredkin_koehler_validation_manifest.md
docs/performance/fem_fredkin_koehler_benchmark_manifest.md
```

Manifest walidacyjny ma zawierać:

- fixture id;
- geometria i jednostki;
- materiał;
- mesh family;
- oracle;
- mierzone quantity;
- normę błędu;
- oczekiwany trend;
- status/receipt.

Manifest wydajnościowy:

- CPU model/socket/NUMA;
- GPU model/driver/CUDA;
- compiler/build flags;
- `N`, `N_b`, `N_tri`;
- operator mode;
- memory budget;
- cold/warm runs;
- p50/p95;
- solver iterations;
- transfer bytes;
- commit/image fingerprint.

---

## 4. Milestone 1 — topologia powierzchni i kontrakt TET4/P1

### `FK-M1-001` — testy RED dla supplied facets

**Plik testowy:**

- rozszerzyć `backends/fem/tests/demag_fem_bem_contract.cpp` albo rozdzielić na `demag_fem_bem_surface_contract.cpp`.

**Przypadki dla jednego tetraedru:**

- pełne cztery ściany;
- jedna ściana;
- trzy ściany;
- brak jednej;
- duplikat;
- dodatkowa ściana nieistniejąca;
- ściana wewnętrzna w dwóch tetraedrach;
- dowolna permutacja kolejności;
- odwrócony winding każdej ściany.

**Oczekiwanie:**

```text
tylko dokładny exterior face set przechodzi
kolejność/winding są kanonizowane
```

### `FK-M1-002` — exact exterior set

**Plik:** `demag_fem_bem_surface.cpp`

Wprowadzić:

```cpp
struct CanonicalFaceKey { uint32_t a, b, c; };

struct ExteriorFaceRecord {
    CanonicalFaceKey key;
    std::array<uint32_t,3> oriented_vertices;
    uint32_t owner_element;
    uint32_t opposite_vertex;
};
```

Algorytm:

1. przejść po typed `cell_offsets/cell_types`;
2. odrzucić wszystko poza `TET4`;
3. zliczyć incidence wszystkich ścian magnetycznych;
4. `count==1` -> exterior;
5. `count==2` -> interior;
6. `count>2` -> nonmanifold error;
7. zbudować posortowany exact exterior set;
8. jeśli caller podał facets:
   - kanonizować,
   - wykryć duplicates,
   - porównać exact set,
   - raportować pierwsze brakujące/nadmiarowe klucze;
9. orientować wyłącznie z owner/opposite;
10. nadać stabilne ordinals.

### `FK-M1-003` — closure i orientowalność

Zbudować mapę nieukierunkowanych krawędzi powierzchni. Każda musi mieć incidence `2`.

Dodatkowe testy:

- otwarta skorupa;
- trzy trójkąty na jednej krawędzi;
- dwa komponenty domknięte;
- wewnętrzna jama;
- bow-tie/nonmanifold vertex.

Output:

```cpp
struct BoundaryTopologyInfo {
    uint64_t face_count;
    uint64_t edge_count;
    uint64_t vertex_count;
    uint32_t connected_components;
    bool closed;
    bool orientable;
};
```

### `FK-M1-004` — jawny runtime gate

Przed budową dense operatora sprawdzić:

```text
dimension == 3
fe_order == 1
all magnetic cells == TET4
cell_offsets consistent
non-periodic
serial unconstrained scalar H1 true DOF mapping available
finite coordinates
positive signed tetra volume
```

Nie opierać bezpieczeństwa natywnego kodu wyłącznie na plannerze.

### Gate milestone 1

- malformed topology failuje przed `N_b^2` allocation;
- supplied/derived surface mają identyczny fingerprint;
- complete surface jest deterministyczna względem numeracji kolejności elementów;
- provenance zawiera source, counts, components i fingerprint.

---

## 5. Milestone 2 — składowe magnetyczne i gauge

### `FK-M2-001` — volume connected components

**Nowy moduł:** `demag_fem_bem_components.*`

Połączyć magnetyczne tetraedry przez wspólną ścianę. Nie łączyć ich tylko przez wspólny wierzchołek lub krawędź.

Output:

```cpp
struct MagneticComponent {
    uint32_t id;
    std::vector<uint32_t> elements;
    std::vector<uint32_t> nodes;
    std::vector<uint32_t> boundary_nodes;
    uint32_t stable_anchor_node;
    double volume;
};
```

Stabilny `anchor_node` nie powinien zależeć od przypadkowej kolejności. Preferować najmniejszy persistent node ordinal, nie surowy lokalny indeks MFEM, jeśli taki ordinal istnieje.

### `FK-M2-002` — referencyjny gauge per component

Pierwszy bezpieczny wariant:

```text
one eliminated true DOF per connected component
corresponding RHS entries = 0
```

Zmienić:

- `neumann_op` elimination;
- `prepare_demag_fem_bem_neumann_rhs`;
- solver/cache fingerprint;
- testy.

Testy:

- dwa rozłączne tetraedry;
- trzy rozłączne ciała;
- jedna domena z jamą, ale nadal jedna składowa objętości;
- deterministyczny wybór anchor.

### `FK-M2-003` — docelowy mean-zero gauge

Zaprojektować i benchmarkować constraint:

\[
\int_{\Omega_c}u_1\,dV = 0
\quad \forall c.
\]

Możliwe realizacje:

1. projekcja nullspace w iteracyjnym solverze;
2. saddle-point z `C` mnożnikami;
3. elimination po transformacji bazowej.

Wersja anchor może pozostać dense oracle, ale produkcyjny solver powinien preferować średnią ważoną masą, jeśli nie pogarsza stabilności/AMG.

### `FK-M2-004` — multi-body BEM interaction

Operator graniczny musi obejmować wszystkie trójkąty wszystkich komponentów. Nie tworzyć osobnych niezależnych BEM bez off-diagonal cross blocks.

Test:

- dwa sześciany/kule w zmiennej odległości;
- pole wzajemne zanika z odległością zgodnie z trendem dipolowym;
- zamiana kolejności komponentów nie zmienia wyniku.

### Gate milestone 2

- macierz Neumanna ma usunięty pełny nullspace;
- solver zbiega dla wielu obiektów;
- rozwiązanie nie zależy od anchor w granicach tolerancji pola;
- energy/field cross interaction jest symetryczna.

---

## 6. Milestone 3 — stabilny kernel Lindholma i bezpieczny dense oracle

### `FK-M3-001` — wydzielić kernel geometryczny

Przenieść:

- solid angle;
- vertex coincidence;
- linear-triangle weights;

do testowalnego modułu `demag_fem_bem_geometry.*`.

API nie może cicho zerować błędu:

```cpp
enum class LindholmStatus {
    ok,
    collocation_vertex,
    degenerate_triangle,
    near_singular_unresolved,
    nonfinite_input,
    nonfinite_output
};

LindholmResult evaluate_lindholm_weights(...);
```

`collocation_vertex` jest oczekiwanym przypadkiem obsługiwanym przez diagonalę. Pozostałe statusy są błędami lub wymagają dedykowanej kwadratury.

### `FK-M3-002` — scale-aware tolerances

Wyznaczyć:

```text
L = bounding-box diagonal lub median edge length
eps_len = C_len * eps_machine * L
eps_area = C_area * eps_machine * L^2
```

Do logarytmu używać form odpornych na cancellation. Testować tę samą bezwymiarową geometrię w skalach:

```text
1e-9 m, 1e-7 m, 1e-5 m
```

### `FK-M3-003` — independent golden values

Golden data nie może być wyprowadzana przez testowaną funkcję.

Źródła:

- symboliczna/numerical high-precision integracja dla kilku trójkątów;
- opublikowana formuła Lindholma;
- zewnętrzna fixture Tetmag jako dodatkowy oracle, bez kodu w Fullmag.

Przypadki:

- punkt daleki;
- punkt bliski płaszczyźnie;
- punkt nad centroidem;
- skośny trójkąt;
- permutacja orientacji;
- near-edge i near-vertex, ale nie dokładnie na singularity.

### `FK-M3-004` — dense memory contract

Przed alokacją:

```cpp
checked_mul(N_b, N_b)
checked_mul(entries, sizeof(double))
required_bytes + workspace_bytes <= budget
```

Konfiguracja:

```text
operator_mode = dense_reference | h2 | fmm | auto
max_operator_memory_bytes
dense_reference_max_boundary_nodes
```

Publiczny Python nie musi eksponować niskopoziomowego cap-u jako obowiązkowego pola; może to być polityka backendu/profilu wykonania.

### `FK-M3-005` — dense operator interface

Rozdzielić interface od implementacji:

```cpp
struct BoundaryVectorView {
    double* data;
    uint64_t size;
    Residency residency;
};

class DemagBoundaryOperator {
public:
    virtual bool apply(
        BoundaryVectorView x,
        BoundaryVectorView y,
        ExecutionContext& exec,
        std::string& error) = 0;
    virtual DemagBoundaryOperatorInfo info() const = 0;
};
```

Factory:

```text
make_boundary_operator(resolved_policy, topology, geometry, resources)
```

### `FK-M3-006` — BLAS CPU

Dla dense CPU:

- użyć `cblas_dgemv`;
- ustalić właściciela wątków;
- uniknąć równoległego OpenMP wokół wielowątkowego BLAS;
- dodać deterministic scalar fallback do testów;
- utrzymywać `u2_boundary` jako trwały bufor.

### Gate milestone 3

- kernel ma golden tests;
- skala geometrii nie zmienia wyniku poza tolerancją;
- invalid geometry failuje jawnie;
- dense nie może spowodować niekontrolowanego OOM;
- operator interface obsługuje host/device views.

---

## 7. Milestone 4 — walidacja fizyczna dense CPU

### `FK-M4-001` — zero source

Dla `M=0`:

```text
rhs1 = 0
u1 = gauge-compatible constant/zero
u2 = 0
H = 0
E = 0
```

Sprawdzić również warm start po poprzednim niezerowym stanie, aby wykluczyć stale cache.

### `FK-M4-002` — kula

Jednorodna kula:

\[
\langle\mathbf H_d\rangle = -\frac13\mathbf M.
\]

Wykonać serię siatek `h0, h1, h2, ...`. Raportować:

- średnie pole ważone objętością;
- `L2` error, z wyłączeniem/uwzględnieniem regionu brzegowego jako osobne metryki;
- energię;
- observed order.

Nie kodować tolerancji, zanim nie powstanie krzywa zbieżności.

### `FK-M4-003` — elipsoida

Dla trzech osi i trzech kierunków magnetyzacji porównać:

\[
\langle H_i\rangle = -N_i M_i,
\qquad
N_x+N_y+N_z=1.
\]

Test wykrywa nie tylko globalny znak, ale błędy orientacji i anizotropii geometrycznej.

### `FK-M4-004` — prostopadłościan/pryzmat

Porównać średnie pole/energię z analitycznymi współczynnikami lub wysoko dokładną referencją. Przypadki:

- cienka warstwa;
- sześcian;
- wydłużony pręt.

### `FK-M4-005` — directional derivative

Dla perturbacji tangentowej `delta m`:

\[
D_\epsilon E
=
\frac{E(\mathrm{normalize}(m+\epsilon\delta m))
-
E(\mathrm{normalize}(m-\epsilon\delta m))}
{2\epsilon}.
\]

Porównać z pracą pola. Sweep `epsilon` ma wykazać zakres błędu truncation/roundoff.

### `FK-M4-006` — invariance

- translacja;
- obrót wraz z `M`;
- jednolite skalowanie geometrii przy zachowaniu kształtu;
- permutacja numeracji węzłów/elementów/facets.

### `FK-M4-007` — airbox convergence

Dla identycznego ciała:

```text
Fredkin–Koehler body-only
vs Poisson airbox 2x, 4x, 8x
```

Airbox ma zbliżać się do open boundary. Różnice geometryczne mesha trzeba oddzielić od błędu warunku zewnętrznego.

### `FK-M4-008` — external fixture

Uruchomić Tetmag jako zewnętrzny program lub użyć zapisanej fixture:

- wejście/wyjście i wersja Tetmag zapisane;
- brak kopiowania AGPL;
- porównać `u1_trace`, boundary output, `H`, `E`, jeśli eksport pozwala;
- dokumentować różnice normalizacji/gauge.

### Gate milestone 4

- raport w `docs/validation`;
- zaakceptowane krzywe zbieżności;
- energy derivative;
- multi-body;
- dense CPU promowany tylko do `validated_reference`.

---

## 8. Milestone 5 — preasemblowane operatory i CPU hot path

### `FK-M5-001` — immutable dependency receipt

Zastąpić hot-path hashowanie pełnych wektorów rewizjami:

```cpp
struct DemagFemBemDependencyReceipt {
    uint64_t mesh_revision;
    uint64_t topology_revision;
    uint64_t geometry_revision;
    uint64_t material_revision;
    uint64_t fe_space_revision;
    uint64_t boundary_operator_policy_revision;
};
```

Pełny hash może powstać przy tworzeniu artefaktu/provenance, nie przy każdym solve.

### `FK-M5-002` — source operator

Preasemblować sparse maps:

\[
b_1 = B_x M_x + B_y M_y + B_z M_z.
\]

Uwzględnić:

- scalar/per-node/elementwise `M_s`;
- magnetic mask;
- P1 quadrature;
- component gauges.

CPU może używać MFEM sparse `Mult`; GPU wykorzysta ten sam eksport CSR.

### `FK-M5-003` — recovery operator

Preasemblować:

\[
H_x = -R_x u,\quad
H_y = -R_y u,\quad
H_z = -R_z u.
\]

Eliminuje to:

- ponowne liczenie odwrotności Jacobianów;
- atomiki OpenMP;
- zależność redukcji od harmonogramu.

Jeśli `L2` projection/consistent mass jest potrzebne jako dokładniejszy wariant, nadać mu osobny mode i oracle.

### `FK-M5-004` — boundary gather/scatter

Zbudować jawne operatory/mapy:

```text
G: global potential -> boundary trace
S: boundary values -> global vector
L: boundary values -> Dirichlet RHS
```

Nie zakładać `node id == true DOF`. Użyć rzeczywistej mapy FE.

### `FK-M5-005` — persistent workspace

Przenieść wszystkie tymczasowe wektory z funkcji kroku do workspace:

```text
rhs_neumann
u1_boundary
u2_boundary
dirichlet_lift
residual_check
energy partials
```

Dodać debug allocation counter. Po pierwszym warm solve liczba alokacji hot-path ma być zero.

### `FK-M5-006` — bulk elimination

Nie wywoływać `EliminateRowCol` osobno dla każdego boundary DOF, jeśli MFEM udostępnia wydajną operację zbiorczą. Alternatywnie zbudować constrained CSR raz własnym bezpiecznym helperem i zweryfikować parity.

### `FK-M5-007` — solver policy

- oddzielna konfiguracja `u1` i `u2`, ale wspólne rozsądne defaulty;
- PCG tylko dla operatora, którego symetria/dodatnia określoność po constraint jest dowiedziona;
- GMRES fallback;
- AMG setup reuse;
- residual validation po obu solve’ach;
- zerowanie/recovery cache po failure;
- first-solve/warm-solve telemetry.

### `FK-M5-008` — CPU threading/NUMA

Benchmarkować:

```text
1, physical cores per socket, all physical cores, SMT
close vs spread
1 socket vs 2 sockets
```

Ustalić:

- OpenMP owner;
- BLAS threads;
- Hypre threads;
- affinity;
- first-touch;
- NUMA allocation operatora H2/dense.

### Gate milestone 5

- zero alokacji po warm-upie;
- source/recovery parity z poprzednią implementacją;
- brak atomików;
- mierzona poprawa warm step;
- residual i fizyka bez regresji.

---

## 9. Milestone 6 — H2 CPU

### `FK-M6-001` — decyzja biblioteczna/licencyjna

Porównać:

1. własna minimalna implementacja H2;
2. biblioteka o zgodnej licencji;
3. H2Lib jako opcjonalna zależność, jeśli licencja i packaging są zaakceptowane;
4. FMM jako alternatywa.

Kryteria:

- licencja;
- CPU/GPU roadmap;
- Windows/Linux;
- deterministyczność;
- serializacja;
- MPI;
- maintenance cost.

Tetmag nie może być źródłem kopiowanego kodu.

### `FK-M6-002` — cluster trees

Zbudować stabilne drzewa klastrów dla:

- collocation boundary nodes;
- source triangles/basis functions.

Provenance:

```text
leaf_size
max_depth
admissibility_eta
tree_fingerprint
```

### `FK-M6-003` — near field

Bloki nieadmissible obliczać dokładnie przez kernel Lindholma. Przechowywać jako małe dense blocks.

### `FK-M6-004` — far field

Admissible blocks aproksymować low-rank/H2. Każda aproksymacja ma kontrolowaną tolerancję i raportowany rank.

### `FK-M6-005` — operator error contract

Na małych fixture:

```text
||B_h2 x - B_dense x|| / ||B_dense x||
```

dla:

- stałych,
- losowych,
- gładkich,
- wysokooscylacyjnych śladów.

Dodatkowo porównać finalne `H` i `E`, ponieważ mały błąd trace nie gwarantuje identycznego pola.

### `FK-M6-006` — persistence/cache

Operator zależy wyłącznie od geometrii/topologii/polityki. Dodać:

- fingerprint;
- wersję formatu;
- checksums;
- cache hit/miss;
- bezpieczne odrzucenie starego cache.

### Gate milestone 6

- pamięć subkwadratowa;
- błąd kontrolowany;
- produkcyjna fixture nie używa dense;
- CPU może zostać promowany do `production_executable`.

---

## 10. Milestone 7 — wspólny device contract

### `FK-M7-001` — przenieść neutralne elementy z `demag_poisson`

Wydzielić z istniejącego GPU Poissona:

- CSR containers;
- upload helpers;
- Hypre device solver;
- stream interop;
- residual validation;
- energy reduction.

Nie wykonywać wielkiego rename-only PR razem ze zmianą fizyki. Najpierw testy parity, potem migracja jednego właściciela naraz.

### `FK-M7-002` — device topology view

```cpp
struct DeviceDemagFemBemTopology {
    uint32_t* boundary_nodes;
    uint32_t* boundary_triangles;
    double* triangle_areas;
    double* unit_normals;
    uint32_t* component_ids;
    uint32_t* gauge_tdofs;
    ...
};
```

Upload odbywa się raz przy inicjalizacji. Geometryczne dane H2/FMM również pozostają na device.

### `FK-M7-003` — device discrete operators

Wgrać:

- `B_x/B_y/B_z`;
- `A_N`, `A_D`;
- `G`, `L`;
- `R_x/R_y/R_z`;
- mass weights.

Każdy bufor ma bytes i ownership w GPU state receipt.

### `FK-M7-004` — persistent GPU workspace

```text
rhs1, u1, trace1, trace2, rhs2, u2, u, Hx/Hy/Hz,
residual scratch, energy scratch
```

Brak `cudaMalloc/cudaFree` w hot loop.

### Gate milestone 7

- pełny setup receipt;
- destroy jest idempotent;
- forced allocation failure nie publikuje częściowego state;
- transfer audit wykazuje tylko setup upload.

---

## 11. Milestone 8 — dense strict GPU reference

### `FK-M8-001` — dense matrix build policy

Dwie dopuszczalne ścieżki początkowe:

1. build na CPU, jednokrotny upload — dozwolone w setup, najprostszy oracle;
2. build na GPU — późniejsza optymalizacja setupu.

Nie należy blokować pierwszego device-resident hot path wymaganiem GPU assembly.

### `FK-M8-002` — cuBLAS apply

`trace2 = B * trace1` przez `cublasDgemv` albo odpowiedni backend MFEM, z:

- istniejącym streamem runtime;
- stałym handle;
- brakiem implicit sync;
- row/column-major contract przetestowanym na małej macierzy.

### `FK-M8-003` — device u1/u2 solve

Użyć istniejącego Hypre GPU stack:

- osobne constrained operators/cache;
- device vectors;
- warm start;
- BoomerAMG setup reuse;
- convergence status;
- residual validation.

Sprawdzić, czy gauge per component zachowuje SPD. W przeciwnym razie wybrać GMRES lub nullspace projection.

### `FK-M8-004` — device gather/lifting/recovery

Kernels/SpMV:

```text
trace1 = G*u1
rhs2 = L*trace2
u = u1+u2
H = -R*u
```

### `FK-M8-005` — device energy

\[
E = -\frac{\mu_0}{2}\sum_i w_i M_i\cdot H_i.
\]

Redukcja ma:

- szybki mode;
- opcjonalny deterministic mode;
- parity tolerance względem CPU.

### `FK-M8-006` — RK dispatch

W `rk_demag_dispatch.cu` dodać jawny branch:

```text
FREDKIN_KOEHLER + strict_device
  -> compute_device_fem_bem_for_stage
FREDKIN_KOEHLER + hybrid_compat
  -> existing host fallback
```

Receipt ma dowodzić, która ścieżka została wykonana.

### `FK-M8-007` — parity etap po etapie

Porównać CPU dense i GPU dense:

- `rhs1`;
- `u1`;
- `trace1`;
- `trace2`;
- `rhs2`;
- `u2`;
- `u_total`;
- `H`;
- `E`;
- iteracje/residual.

To pozwala zlokalizować rozbieżność bez porównywania wyłącznie końcowego pola.

### Gate milestone 8

- zero D2H/H2D w hot loop;
- zero host operatorów w execution receipt;
- parity;
- cancellation/nonconvergence/OOM są failure-atomic;
- status `validated_reference GPU`, jeszcze nie production.

---

## 12. Milestone 9 — H2/FMM strict GPU

### `FK-M9-001` — device cluster representation

Przenieść drzewa, bounding boxes, permutations i block metadata na device.

### `FK-M9-002` — exact near-field blocks

- batched small dense GEMV;
- coalesced layout;
- reuse kernel Lindholma tylko do setupu bloków, nie do każdego time step.

### `FK-M9-003` — far-field traversal

Wariant H2:

- upward pass;
- coupling;
- downward pass;
- batched low-rank kernels.

Wariant FMM:

- P2M/M2M/M2L/L2L/L2P zgodnie z wybranym kernelem.

Nie implementować obu produkcyjnie równolegle przed benchmarkiem prototypów.

### `FK-M9-004` — error and rank telemetry

Raportować:

```text
compression_tolerance
observed_max_rank
mean_rank
near_blocks
far_blocks
operator_bytes
compression_ratio
apply_ns
```

### `FK-M9-005` — crossover policy

`auto` może wybrać:

```text
dense_gpu_reference    dla bardzo małego N_b
h2_gpu/fmm_gpu         dla większego N_b
h2_cpu                 gdy GPU memory budget nie wystarcza i fallback jest dozwolony
reject                  gdy strict GPU nie może spełnić kontraktu
```

Progi wynikają z benchmarków i dostępnej pamięci, nie ze stałych „na oko”.

### Gate milestone 9

- finalne `H/E` w tolerancji dense oracle;
- subkwadratowa pamięć;
- przewaga czasu warm apply nad CPU dla zakresu docelowego;
- brak transferów;
- strict GPU promowany do `production_executable`.

---

## 13. Milestone 10 — telemetria, ABI i produkt

### `FK-M10-001` — rozszerzyć natywną telemetrię

Minimalne pola:

```text
boundary_nodes
boundary_triangles
magnetic_components
gauge_constraints
operator_mode
operator_bytes
operator_setup_ns
boundary_gather_ns
bem_apply_ns
dirichlet_lift_ns
u1_iterations/residual/solve_ns
u2_iterations/residual/solve_ns
recovery_ns
energy_ns
compression_tolerance/ratio
host_transfer_calls/bytes
device_transfer_calls/bytes
allocation_count_after_warmup
```

### `FK-M10-002` — ABI i Rust

Zmienić w sposób wersjonowany:

- `native/include/fullmag_fem.h`;
- `crates/fullmag-fem-sys`;
- runner types;
- provenance/artifacts;
- session solver profiler.

Nie przeciążać istniejącego pola `gpu_demag_mode` niejednoznacznymi wartościami. Rozdzielić:

```text
execution_residency
boundary_operator_mode
fallback_policy
```

### `FK-M10-003` — Python/public diagnostics

Użytkownik wybiera fizykę, nie bibliotekę:

```python
fm.Demag(model="fredkin_koehler")
```

Zaawansowana polityka backendu może opcjonalnie wymusić reference/operator mode, ale domyślnie planner dobiera realizację i zapisuje ją w resolved execution.

Błędy muszą być operacyjne:

```text
surface is missing 14 exterior faces
mesh has 2 magnetic components but only 1 gauge constraint
dense operator needs 21.3 GiB, budget is 8 GiB
strict GPU requested but no device boundary operator is available
H2 cache fingerprint does not match geometry
```

### `FK-M10-004` — quantities

Zachować:

- `H_demag`;
- `E_demag`;
- potencjał całkowity, jeśli publiczny;
- opcjonalne diagnostyczne `u1`, `u2`, boundary trace tylko w debug/validation mode.

Quantities nie mogą wymuszać readback podczas każdego kroku; readback odbywa się na żądanie.

---

## 14. Milestone 11 — testy wydajności i skalowania

### 14.1. Zestaw rozmiarów

Co najmniej:

```text
tiny:   oracle/unit
small:  dense CPU/GPU parity
medium: dense cap crossover
large:  H2/FMM production
```

Dla każdej fixture zapisać `N`, `N_b`, `N_tri`, `nnz`.

### 14.2. CPU matrix

- 1/2/4/... wątków;
- physical cores vs SMT;
- 1 socket vs 2 socket;
- memory bandwidth;
- BLAS ownership;
- H2 assembly/apply;
- u1/u2 solve;
- full RK stage.

### 14.3. GPU matrix

- setup upload;
- dense DGEMV;
- H2/FMM apply;
- Hypre iterations;
- occupancy i bandwidth;
- stream synchronization;
- transfer audit;
- total RK stage.

### 14.4. Metryki akceptacji

Nie wpisywać z góry obiecanego speedupu. Akceptacja wymaga:

- brak regresji dokładności;
- brak wzrostu iteracji bez wyjaśnienia;
- subkwadratowa pamięć produkcyjnego operatora;
- zero hot-loop transferów strict GPU;
- zero warm allocations;
- poprawa p50 i p95 czasu do rozwiązania w docelowym zakresie;
- zapisany sprzęt/build/commit.

---

## 15. Proponowany podział PR-ów

| PR | Zakres | Zależność |
|---|---|---|
| PR-1 | capability truth + RED malformed-surface tests | brak |
| PR-2 | exact exterior/manifold/orientation | PR-1 |
| PR-3 | components + gauge per component | PR-2 |
| PR-4 | robust Lindholm kernel + dense cap | PR-2 |
| PR-5 | physical validation fixtures | PR-3, PR-4 |
| PR-6 | boundary operator interface + persistent buffers | PR-5 |
| PR-7 | preassembled source/recovery + CPU telemetry | PR-6 |
| PR-8 | BLAS/NUMA CPU dense optimization | PR-7 |
| PR-9 | H2 CPU prototype and oracle comparison | PR-6 |
| PR-10 | H2 CPU production/cache | PR-9 |
| PR-11 | common GPU demag operator infrastructure | PR-7 |
| PR-12 | dense strict GPU reference | PR-11 |
| PR-13 | strict GPU parity/validation | PR-12 |
| PR-14 | H2/FMM GPU prototype | PR-10, PR-13 |
| PR-15 | production GPU operator + crossover | PR-14 |
| PR-16 | ABI/provenance/public docs promotion | wszystkie gates |

Każdy PR ma być reviewable i nie może mieszać masowych rename’ów z korektą fizyki bez osobnego dowodu parity.

---

## 16. Kanoniczne polecenia walidacyjne

Nazwy targetów należy sprawdzić po każdej zmianie CMake, ale bieżący punkt wejścia obejmuje:

```bash
just rebuild-fem-runtime
```

oraz target:

```text
fem_demag_fem_bem_contract
```

W planowanych PR-ach dodać dedykowane testy CTest, a następnie uruchamiać zarządzane przypadki CPU/GPU przez repozytoryjne recipes, nie przez przypadkowe lokalne binaria.

Minimalna kolejność CI:

```text
format/lint
-> C++ contract/unit tests
-> Rust planner/runner tests
-> Python API tests
-> managed CPU validation smoke
-> managed GPU parity smoke
-> scheduled physical refinement
-> scheduled performance benchmark
```

Długie refinement/performance nie muszą blokować każdego PR, ale ich accepted receipt jest obowiązkowy przed promocją capability.

---

## 17. Checklist zamknięcia

### Poprawność

- [ ] exact exterior set;
- [ ] duplicate/missing/interior/nonmanifold rejection;
- [ ] edge closure i orientowalność;
- [ ] typed `TET4/P1` gate;
- [ ] gauge per magnetic component;
- [ ] multi-body cross interaction;
- [ ] robust Lindholm;
- [ ] failure-atomic init/solve.

### Walidacja

- [ ] zero source;
- [ ] sphere;
- [ ] ellipsoid;
- [ ] prism/cuboid;
- [ ] h-refinement;
- [ ] translation/rotation/scale/permutation;
- [ ] energy directional derivative;
- [ ] airbox convergence;
- [ ] independent external fixture.

### CPU

- [ ] dense memory cap;
- [ ] operator interface;
- [ ] persistent buffers;
- [ ] preassembled RHS;
- [ ] preassembled recovery;
- [ ] BLAS;
- [ ] thread/NUMA policy;
- [ ] H2/FMM;
- [ ] accepted cold/warm benchmark.

### GPU

- [ ] device topology;
- [ ] device discrete operators;
- [ ] persistent workspace;
- [ ] device u1/u2 solves;
- [ ] dense cuBLAS oracle;
- [ ] device gather/lifting/recovery/energy;
- [ ] stage-by-stage parity;
- [ ] no hot-loop transfers;
- [ ] H2/FMM device operator;
- [ ] accepted crossover benchmark.

### Produkt

- [ ] capability truthful;
- [ ] ABI versioned;
- [ ] provenance complete;
- [ ] diagnostics actionable;
- [ ] public docs aligned;
- [ ] `auto` policy based on evidence;
- [ ] no unresolved P0/P1.
