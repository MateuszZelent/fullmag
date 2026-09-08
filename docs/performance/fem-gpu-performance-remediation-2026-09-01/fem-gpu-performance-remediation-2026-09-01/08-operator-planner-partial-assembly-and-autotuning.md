# 08. Planner operatorów: CSR, SpMM i partial assembly

**Ustalenie:** PA-01 oraz docelowa decyzja dla EX-04/EX-06.

**Status po weryfikacji:** `exchange_operator.hpp/.cpp` ma typed enum,
parser/resolver oraz deterministyczny `plan_gpu_exchange_operator` z
fail-closed gate'ami profilu, VRAM i dostępności runtime. Nie ma jeszcze
produkcyjnego cuSPARSE SpMM ani PA exchange, a resolver nie jest podłączony do
publicznego `GpuExchangePlan`: bieżący RK publikuje
`exchange_operator_mode="legacy_sparse_gpu"`. `pa_benchmark.cpp` nadal mierzy
ogólny assembled-vs-PA Laplacian, nie operator wymiany, i nie emituje
opisanego JSON. Cały wybór wariantu, break-even oraz runtime proof pozostają
`NOT VERIFIED`.

## 1. Problem

Jeden assembled CSR nie jest uniwersalny dla regularnych pryzmatów, wyższych
rzędów, nieregularnych wierszy i różnych GPU. Runtime autotune utrudnia
reprodukowalność. Planner ma wybierać tylko warianty zakwalifikowane offline.

## 2. Typowany plan docelowy

Poniższy typ jest kontraktem docelowym, nie nazwą istniejącego API. Bieżący
kod ma tylko `GpuExchangePlannerRequest` i
`GpuExchangePlannerDecision`; nie ma jeszcze pól `row_mapping`,
`accumulation`, `block_size` ani `qualification_id` w decyzji publicznej.

```cpp
enum class GpuExchangeOperatorKind : uint32_t {
    LegacySparse,
    FusedXYZ,
    PeriodicReduced,
    CuSparse,
    PartialAssembly,
};

enum class GpuExchangeRowMapping : uint32_t {
    ThreadPerRow,
    WarpPerRow,
    Bucketed,
};

struct GpuExchangeResolvedPlan {
    bool enabled;
    GpuExchangeOperatorKind kind;
    GpuExchangeRowMapping row_mapping;
    GpuExchangeAccumulationMode accumulation;
    uint32_t block_size;
    const char *qualification_id;
};
```

To jest ten sam canonical enum co w dokumencie 02; nie wolno definiować dwóch
wariantów nazw. `qualification_id` musi mieć owned/fixed-size representation
wewnętrzne oraz wersjonowaną reprezentację provenance/ABI, a nie niezarządzany
`const char *` przekraczający granicę C ABI.

Przykład qualification ID:

```text
fem.exchange.gpu.ada.sm89.p1_tet.csr_xyz.v1
```

Obecne zachowanie resolvera:

- explicit unqualified non-legacy kind → fail,
- pusty `requested_kind` → `LegacySparse` w trybie kompatybilności;
  nie jest to zakwalifikowany fused CSR,
- explicit `legacy_sparse_gpu` może przejść bez profilu,
- każdy explicit fused/reduced/cuSPARSE/PA wymaga profilu i wspieranego
  runtime,
- nigdy silent niewalidowany PA.

## 3. Inputs planera

Aktualny resolver przyjmuje wyłącznie `requested_kind`,
`profile_qualified`, `profile_stale`, `vram_preflight_ok` oraz
`runtime_supported`. FE order, rodziny elementów, histogram wierszy, PBC,
compute capability, oczekiwana liczba apply i maska materializacji są
wejściami planowanego profilu; nie są jeszcze oceniane przez produkcyjny
planner.

Nie używać bieżącego load ani losowego runtime microbenchmarku.

## 4. Harness

Rozszerzyć `backends/fem/examples/pa_benchmark.cpp` albo utworzyć
`exchange_operator_benchmark.cpp`.

- canonical fixture/operator,
- warmup,
- >=100 batched applies,
- CUDA event timing,
- jeden sync po batchu,
- correctness,
- JSON z histogram/register/device.

Warianty: fused strict/accurate, cuSPARSE SpMM, row mappings, PA, PBC reduced.

## 5. cuSPARSE SpMM

\[
K[m_x,m_y,m_z]
\]

Persistent:

- SpMat descriptor,
- dense descriptors,
- external buffer,
- no per-apply layout conversion.

Uwzględnić row scaling i graph-Laplacian semantics. Vendor path musi przejść
oracle; nie zakładać zwycięstwa.

## 6. Partial assembly

Osobny owner:

```text
gpu/cuda/exchange/partial_assembly_operator.hpp/.cpp
```

Persistent:

- restrictions,
- quadrature data,
- coefficient data,
- geometry,
- device vectors,
- operator handle.

Zero assembly in steady state.

Początek: przypadki, gdzie PA ma sens — wyższy order/tensor-product. P1 tetra
nie musi przechodzić.

## 7. Qualified profiles

Planowany artifact (nie istnieje w bieżącym checkoutcie):

```text
docs/performance/fem_gpu_exchange_operator_profiles_v1.json
```

Wpis zawiera device family, FE order, cells, PBC, kind, mapping, accumulation,
qualified commit, validation i benchmark artifact.

Runtime powinien korzystać ze zwalidowanej projekcji profilu, nie parsować
arbitralnych docs w hot path. Sam obecny enum/resolver nie jest takim
profilem.

## 8. Break-even

\[
T_\mathrm{total}=T_\mathrm{setup}+n_\mathrm{apply}T_\mathrm{apply}.
\]

Raportować break-even apply count. Krótka symulacja może preferować CSR.

## 9. Testy i DoD

- deterministic resolution,
- unsupported fail,
- explicit no fallback,
- qualification ID,
- device mapping,
- VRAM preflight,
- no setup in apply,
- operator parity,
- stale profile reject.

DoD: każdy resolved kind ma proof i poprawia time-to-solution w swoim profilu;
do tego czasu jedyną bezpieczną ścieżką domyślną pozostaje
`legacy_sparse_gpu`, a pozostałe warianty są kandydatami `NOT VERIFIED`.
