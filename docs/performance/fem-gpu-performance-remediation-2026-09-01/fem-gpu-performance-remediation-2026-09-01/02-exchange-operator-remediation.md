# 02. Naprawa operatora wymiany FEM GPU

**Ustalenia:** EX-01, EX-02, EX-03, EX-04, EX-05, EX-06, EX-07, EX-08.

**Status po weryfikacji:** EX-01 ma źródłowy reduced CSR/mass/lift dla ścieżki
RK oraz osobne reduced-kernel paths dla pola, energii exchange i różnicy energii
używanej przez Armijo; EX-02 ma fused XYZ z zachowaną ścieżką split. EX-03
pozostaje częściowy: typed operator kinds istnieją, ale strict/FMA precision
modes nie. EX-04 ma deterministyczny fail-closed resolver, bez
histogramu/autotune. EX-05 nadal failuje przed strict GPU step dla consistent
mass. EX-06 potwierdza obecną `LEGACY` assembly, a PA pozostaje
nieprodukcyjnym celem. Builder off-diagonal CSR i row-scale są kontraktami
źródłowymi, lecz integracja wszystkich konsumentów, parytet i managed runtime
są `NOT VERIFIED`.

## 1. Aktualny przepływ

`cpu/mfem/interactions/exchange_operator.cpp` montuje `BilinearForm` na poziomie
`LEGACY`, pobiera `SparseMatrix`, kanonizuje ją do postaci grafowego
Laplacjanu i publikuje metadane. `gpu/cuda/exchange/exchange_upload.cpp`
kopiuje pełny CSR oraz lumped mass na GPU.

`gpu/cuda/integrators/rk/rk_exchange_dispatch.cu` zachowuje split x/y/z jako
compatibility path, ale dla nieperiodycznego row-scale wybiera fused XYZ, a dla
kwalifikowanej mapy PBC może wybrać reduced CSR/lift. Publiczny planner nadal
nie promuje tych wariantów bez kwalifikacji.

Wariant periodyczny używa kernela, w którym każdy docelowy wiersz skanuje
wszystkie `source_row`, aby znaleźć członków swojej klasy. To nie jest problem
block size; to niewłaściwa reprezentacja operatora.

## 2. Docelowa własność

Zastąpić nazwę i strukturę `LegacyGpuExchangeDeviceState` modułowym stanem:

```cpp
enum class GpuExchangeOperatorKind : uint32_t {
    LegacySparse,
    FusedXYZ,
    PeriodicReduced,
    CuSparse,
    PartialAssembly,
};

struct GpuExchangeCsrDeviceState {
    uint32_t *row_offsets = nullptr;
    uint32_t *col_indices = nullptr;
    double *values = nullptr;
    double *row_scale = nullptr;
    uint64_t rows = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
};

struct GpuPeriodicExchangeDeviceState {
    GpuExchangeCsrDeviceState reduced{};
    uint32_t *full_to_reduced = nullptr;
    uint32_t *reduced_representatives = nullptr;
    double *reduced_lumped_mass = nullptr;
    FemGpuComponentField reduced_field{};
    uint64_t full_rows = 0;
    uint64_t reduced_rows = 0;
    uint64_t device_bytes = 0;
};

struct FemGpuExchangeDeviceState {
    GpuExchangeOperatorKind kind = GpuExchangeOperatorKind::LegacySparse;
    GpuExchangeCsrDeviceState full{};
    GpuPeriodicExchangeDeviceState periodic{};
    bool uploaded = false;
    uint64_t apply_count = 0;
    uint64_t kernel_launch_count = 0;
};
```

### Pliki

- zmienić `gpu/cuda/exchange/exchange_state.hpp`,
- zmienić `gpu/cuda/state/gpu_state.hpp`,
- zmienić `gpu/cuda/exchange/exchange_upload.hpp/.cpp`,
- zmienić `gpu/cuda/exchange/exchange_plan.hpp/.cpp`,
- zmienić `gpu/cuda/exchange/exchange_kernels.hpp/.cu`,
- zmienić `gpu/cuda/integrators/rk/rk_exchange_dispatch.cu`,
- wydzielić backend-neutralny host artifact z istniejącego właściciela
  `cpu/mfem/interactions/exchange_operator.cpp`; moduł CUDA nie może stać się
  drugim właścicielem MFEM assembly,
- zaktualizować energy/direct-energy consumers,
- zaktualizować CMake i testy source ownership.

Przejściowy adapter może zachować starą funkcję uploadu, ale po migracji
wszystkich konsumentów usunąć słowo `legacy` z aktywnej ścieżki.

## 3. EX-07 — prekomputacja skali wiersza

### Problem

Każdy komponent i każdy apply liczy:

\[
s_i=-\frac{2}{\mu_0M_{s,i}}M_{L,i}^{-1}.
\]

To są dane niezmienne względem etapu RK.

### Implementacja

W `exchange_operator.cpp` oraz uploadzie przygotowano deviceowy row-scale:

```cpp
std::vector<double> build_exchange_row_scale(
    span<const double> ms,
    span<const double> inv_lumped_mass,
    span<const uint8_t> magnetic_mask)
{
    std::vector<double> scale(ms.size(), 0.0);
    for (size_t i = 0; i < ms.size(); ++i) {
        if (magnetic_mask[i] == 0 || ms[i] <= 0.0 ||
            inv_lumped_mass[i] <= 0.0) {
            scale[i] = 0.0;
        } else {
            scale[i] = -2.0 * inv_lumped_mass[i] / (kMu0 * ms[i]);
        }
    }
    return scale;
}
```

Builder ma używać kanonicznych hostowych pól `Ms` i lumped mass podczas setupu.
Nie wykonywać device→host readbacku.

### Invalidation

Przebudować/uploadować skalę przy zmianie:

- mesh dependency key,
- `Ms_field`,
- lumped mass,
- magnetic node mask,
- periodic equivalence classes.

Nie przebudowywać przy zmianie `m`, `alpha`, Zeeman ani czasu.

### Testy

- uniform `Ms`,
- nodal `Ms`,
- nonmagnetic node → scale zero,
- invalid `Ms<=0` zgodnie z istniejącym kontraktem,
- CPU formula parity.

## 4. EX-08 — off-diagonal CSR

### Problem

Pełny CSR zawiera przekątną, a kernel wykonuje branch `col != row`. Dla postaci:

\[
\sum_{j\ne i}K_{ij}(m_j-m_i)
\]

przekątna nie wnosi pracy.

### Builder

Kanoniczny builder GPU-only znajduje się w `exchange_operator.cpp`:

```cpp
struct HostExchangeCsr {
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
    std::vector<double> row_scale;
};
```

Algorytm:

1. sprawdź monotoniczność `row_offsets`;
2. dla każdego wiersza pomiń `col == row`;
3. odrzuć indeks poza zakresem;
4. scal duplikaty kolumn deterministycznie;
5. zachowaj sortowanie kolumn;
6. nie usuwaj małych wartości na podstawie heurystycznego epsilon;
7. zachowaj pełny MFEM operator po stronie CPU dla oracle;
8. policz digest GPU CSR.

### Inwarianty

- usunięcie przekątnej nie zmienia pola różnicowego;
- nie wykonywać drugiej symetryzacji w GPU builderze;
- błędny CSR failuje podczas setupu, nie w kernelu.

## 5. EX-02 — jeden fused xyz CSR kernel

### Interfejs

```cpp
void fullmag_cuda_exchange_fused_xyz(
    const GpuExchangeCsrDeviceState &op,
    const FemGpuComponentField &m,
    FemGpuComponentField &h_ex,
    int rows,
    cudaStream_t stream,
    GpuExchangeAccumulationMode mode);
```

Kernel:

```cpp
template <AccumulationMode Mode>
__global__ void exchange_fused_xyz_kernel(
    const uint32_t *__restrict__ row_offsets,
    const uint32_t *__restrict__ columns,
    const double *__restrict__ values,
    const double *__restrict__ row_scale,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ hx,
    double *__restrict__ hy,
    double *__restrict__ hz,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) return;

    const double scale = row_scale[row];
    if (scale == 0.0) {
        hx[row] = 0.0;
        hy[row] = 0.0;
        hz[row] = 0.0;
        return;
    }

    const double mxi = mx[row];
    const double myi = my[row];
    const double mzi = mz[row];

    Accumulator<Mode> sx{}, sy{}, sz{};
    for (uint32_t p = row_offsets[row]; p < row_offsets[row + 1]; ++p) {
        const uint32_t col = columns[p];
        const double a = values[p];
        sx.add_scaled_difference(a, mx[col], mxi);
        sy.add_scaled_difference(a, my[col], myi);
        sz.add_scaled_difference(a, mz[col], mzi);
    }
    hx[row] = scale * sx.value();
    hy[row] = scale * sy.value();
    hz[row] = scale * sz.value();
}
```

### SoA pozostaje

Nie zmieniać głównego layoutu na AoS tylko dla wymiany. Fused kernel czyta trzy
strumienie SoA, ale tylko raz odczytuje strukturę CSR.

### Launch

- początkowo `block=256`;
- później wybór 128/256 na podstawie Nsight;
- bez `cudaStreamSynchronize`;
- `cudaPeekAtLastError` zgodnie z obecnym wzorcem;
- liczniki `exchange_applies += 1`, `exchange_kernel_launches += 1`.

## 6. EX-03 — tryby akumulacji

```cpp
enum class GpuExchangeAccumulationMode : uint32_t {
    StrictCompensated,
    AccurateFp64Fma,
};
```

### StrictCompensated

- przenieść obecną arytmetykę double-double do
  `exchange_accumulator.cuh`;
- trzy niezależne akumulatory;
- zachować kolejność NNZ;
- sprawdzić rejestry przez `-Xptxas=-v`.

### AccurateFp64Fma

- suma FP64 z `fma(a, m[col]-m_i, sum)`;
- opcjonalnie Neumaier, jeżeli zwykłe FMA nie przechodzi oracle;
- bez globalnego fast-math.

### Wybór

Początkowo strict GPU używa `StrictCompensated`. Tańszy wariant jest kandydatem
produkcyjnym dopiero po kwalifikacji i otrzymuje własny provenance mode ID.

### Testy numeryczne

- jednorodny i prawie jednorodny stan,
- ściana domenowa,
- losowe unormowane `m`,
- kontrast `A` i `Ms`,
- energia i directional derivative,
- 1000 apply bez narastającego driftu.

## 7. EX-04 — mapowanie wierszy

Builder oblicza histogram:

```cpp
struct SparseRowHistogram {
    uint32_t min, p10, p50, p90, p95, p99, max;
    double mean;
};
```

Warianty:

1. `ThreadPerRow`,
2. `WarpPerRow`,
3. `Bucketed`,
4. `CusparseSpmm`.

Nie wdrażać runtime autotune. Najpierw offline benchmark i statyczne,
kwalifikowane progi według histogramu oraz GPU architecture ID.

Warp-per-row dla strict compensated wymaga deterministycznego łączenia
akumulatorów; dlatego pierwsza wersja warp może dotyczyć tylko
`AccurateFp64Fma`.

## 8. EX-01 — zredukowany operator periodyczny

Niech `full_to_reduced[i]=r` opisuje klasy periodyczne, a `P` prolonguje:

\[
m=P\widehat m.
\]

Przygotować raz:

\[
\widehat K=P^T K P,\qquad
\widehat M_L=P^T M_L.
\]

### Host builder

1. zwaliduj mapę i liczbę klas;
2. zbuduj listy członków;
3. dla każdego pełnego NNZ `(i,j,Kij)` dodaj `(ri,rj,Kij)`;
4. scal duplikaty i sortuj;
5. usuń zredukowaną przekątną dla różnicowego apply;
6. policz zredukowaną lumped mass;
7. wybierz reprezentantów;
8. zwaliduj klasę materiałową.

W jednej klasie wymagane są zgodne:

- magnetic status,
- `Ms`,
- material/region identity na sparowanych granicach,
- frozen status/reference, jeżeli obowiązuje.

`A` jest już zawarte w `K`, lecz ogólny kontrakt PBC powinien odrzucać
fizycznie niespójne sparowanie materiałów.

### Apply

```text
fused xyz apply na reduced rows
lift h_full[i] = h_reduced[full_to_reduced[i]]
```

### Energia i Armijo

Zaktualizować równocześnie:

- `rk_exchange_energy_reductions.cu`,
- `relaxation/direct_energy_increment.cpp`,
- exchange difference kernel,
- final stats.

Nie wolno mieć reduced field apply i full unreduced energy o innej semantyce.

### Skalowanie

Source contract zabrania pełnej pętli `source_row=0..N` w kernelu. Runtime
liczy `visited_nnz`, a test potwierdza koszt `O(nnz_reduced + N)`.

## 9. EX-05 — consistent mass

Strict GPU z `use_consistent_mass=true` już failuje przed krokiem w
`gpu/cuda/exchange/exchange_plan.cpp::gpu_exchange_plan_stage_exchange` i
publikuje przyczynę. To zachowanie należy zachować podczas przebudowy.

Docelowy osobny moduł:

```text
gpu/cuda/exchange/consistent_mass_solver.hpp/.cpp
```

- persistent operator/preconditioner,
- trzy device RHS,
- Jacobi/Chebyshev baseline,
- warm start,
- residual validation,
- CPU parity.

Nie łączyć z fused lumped CSR w jednym PR.

## 10. EX-06 — partial assembly

Aktualny P1 tetra używa component-split legacy CSR. P1 tetra ma przejść
najpierw przez kwalifikację fused CSR. PA jest osobnym operator kind,
capability i benchmarkiem. Szczegóły w dokumencie 08.

## 11. Testy i DoD

Nowe testy:

- `exchange_gpu_operator_builder_contract.cpp`,
- `cuda_exchange_fused_xyz_contract.cpp`,
- `cuda_exchange_periodic_reduced_contract.cpp`,
- `cuda_exchange_accuracy_contract.cpp`,
- rozszerzenia `gpu_rk_plan.cpp` i source-facade tests.

DoD nieperiodyczne:

- 1 kernel/apply zamiast 3;
- field/energy parity;
- brak host sync/alokacji w apply;
- poprawa full RHS.

DoD PBC:

- brak O(N²);
- field/energy/direct-energy parity;
- material mismatch reject;
- resolved kind `periodic_reduced_fused_xyz`;
- skalowanie z `nnz_reduced`.
