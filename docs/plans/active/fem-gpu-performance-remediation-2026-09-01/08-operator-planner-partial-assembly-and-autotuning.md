# 08. Planner operatorów: CSR, SpMM i partial assembly

**Ustalenie:** PA-01 oraz docelowa decyzja dla EX-04/EX-06.

## 1. Problem

Jeden assembled CSR nie jest uniwersalny dla regularnych pryzmatów, wyższych
rzędów, nieregularnych wierszy i różnych GPU. Runtime autotune utrudnia
reprodukowalność. Planner ma wybierać tylko warianty zakwalifikowane offline.

## 2. Typowany plan

```cpp
enum class GpuExchangeOperatorKind : uint32_t {
    FusedGraphCsr,
    PeriodicReducedFusedGraphCsr,
    CusparseSpmm,
    MfemPartialAssembly,
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

Przykład qualification ID:

```text
fem.exchange.gpu.ada.sm89.p1_tet.csr_xyz.v1
```

Brak profilu:

- explicit kind → fail,
- auto → konserwatywny qualified fused CSR,
- nigdy silent niewalidowany PA.

## 3. Inputs

- FE order,
- cell families,
- N/NNZ,
- row histogram,
- PBC,
- strictness,
- compute capability,
- VRAM,
- expected applies,
- output/materialization mode.

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

Źródłowy artifact:

```text
docs/performance/fem_gpu_exchange_operator_profiles_v1.json
```

Wpis zawiera device family, FE order, cells, PBC, kind, mapping, accumulation,
qualified commit, validation i benchmark artifact.

Runtime korzysta ze zwalidowanej projekcji profilu, nie parsuje arbitralnie docs
w hot path.

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

DoD: każdy resolved kind ma proof i poprawia time-to-solution w swoim profilu.
