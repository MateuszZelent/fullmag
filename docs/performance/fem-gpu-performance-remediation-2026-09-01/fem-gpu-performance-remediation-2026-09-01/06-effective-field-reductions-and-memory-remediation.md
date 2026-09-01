# 06. Składanie H_eff, redukcje, LLG i pamięć

**Ustalenia:** HF-01, HF-02, RD-01, MEM-01 oraz część RK-04/RK-05.

**Status po weryfikacji:** HF-01/HF-02 są potwierdzone jako obecne
component-split passes; `has_ext=true` jest dziś przekazywane bezwarunkowo.
Typed reducers, maski materializacji i fused compose nie istnieją. MEM-01 jest
częściowy: generyczny scalar readback ma pinned host buffer i pageable fallback,
ale nie ma odrębnego `GpuRkAttemptControlPacket`. Wpływ wszystkich fuzji na
rejestry, occupancy i wall time pozostaje `NOT VERIFIED`.

## 1. HF-01 — fused bazowe H_eff xyz

### Stan

Bazowe:

\[
H_\mathrm{eff}=H_\mathrm{ex}+H_\mathrm{demag}+H_\mathrm{ext}
\]

jest składane trzema kernelami komponentowymi.

### Kernel

W `fields/vector_field_kernels.cu` dodać:

```cpp
void fullmag_cuda_compose_base_heff_xyz(
    const FemGpuComponentField &h_ex,
    const FemGpuComponentField &h_demag,
    const FemGpuComponentField *h_ext,
    FemGpuComponentField &h_eff,
    int n,
    cudaStream_t stream);
```

Jeden wątek liczy wszystkie trzy komponenty. Nie przekazywać `has_ext=true`
bezwarunkowo; null/bit flag ma odzwierciedlać operator.

Test: ext on/off, field parity, launch count 3→1.

## 2. HF-02 — dodatkowe pola

Każde pole jest zwykle materializowane, a potem dodawane trzema kernelami.

### Etap A — jeden compose pass

```cpp
enum GpuHeffInput : uint64_t {
    Exchange,
    Demag,
    External,
    Drive,
    Anisotropy,
    CubicAnisotropy,
    InterfacialDmi,
    BulkDmi,
    Oersted,
    Thermal,
    Magnetoelastic,
};
```

`compose_heff_xyz` ma bitmaskę aktywnych zmaterializowanych pól i wykonuje
jeden końcowy pass.

### Etap B — lazy materialization

Output mask określa, czy osobne `H_ani`, `H_therm`, itd. muszą być zachowane.

```cpp
struct GpuFieldWriteTargets {
    FemGpuComponentField *published_field;
    FemGpuComponentField *h_eff_accumulator;
};
```

Pole jest obliczone raz, zawsze dodane do H_eff, a osobny bufor zapisany tylko
gdy jest potrzebny do outputu albo innej fizyki.

Najpierw objąć proste nodal fields. DMI/element operators pozostawić osobno,
dopóki profil nie uzasadni fuzji.

### Rejestry

Dla wariantów zapisać registers/thread, spills, occupancy i duration. Gdy
bitmaskowy kernel generuje za dużo rejestrów, użyć kilku template variants.

## 3. RD-01 — wielokanałowe redukcje

Rozszerzyć:

```text
gpu/cuda/reductions/reduction_kernels.hpp/.cu
gpu/cuda/reductions/reduction_workspace_memory.cpp
```

o typy:

```text
AdaptivePartial
ArmijoPartial
NcgPartial
PgbbPartial
FinalObservablePartial
```

Każdy typ ma neutral element, associative combine, CPU oracle i CUB temp query
podczas setupu.

Nie tworzyć generic reducer 32 doubles, ponieważ kanały mają różną semantykę:
sum/max/min/flags/double-double.

### Armijo

```cpp
struct ArmijoPartial {
    DoubleDouble local_delta;
    double local_abs;
    DoubleDouble demag_delta;
    double demag_abs;
    DoubleDouble exchange_delta;
    double exchange_abs;
    uint64_t changed_nodes;
    uint64_t flags;
};
```

Strict roundoff proof pozostaje nienaruszony.

### Final stats

Producenci energii mogą pozostać osobni, ale second-stage reductions i readback
mogą być batchowane. Celem nie jest jeden megakernel.

## 4. MEM-01 — pinned packet

Normalizer ma korzystać z `GpuRkAttemptControlPacket`:

- device allocation,
- pinned host mirror,
- pageable fallback z warning/counter,
- jeden readback owner.

Nie mieszać packetu RK z ogólnymi scalar slots.

Benchmark strict może wymagać `control_packet_pinned=true`.

## 5. LLG metric

- intermediate → `NoMetric`,
- final → `max_norm_squared`,
- jedna global max,
- jeden sqrt,
- torque pozostaje odrębną wielkością.

## 6. D2D buffer role migration

Każde `gpu_rk_copy_component_device` wykonuje 3×N×sizeof(double), ale obecnie
nie raportuje osobnego licznika. Telemetria transakcji agreguje journal `m+k0`,
czyli 6×N×sizeof(double). Nowy snapshot ma rozdzielić przyczynę kopii.

Kolejność:

1. endpoint RHS reuse,
2. FSAL slot,
3. magnetization buffer roles,
4. dopiero potem ewentualna zmiana HYPRE ownership.

Test wielokrotnie swapuje role, niszczy backend i sprawdza leak/double-free.

## 7. Output/materialization mask

`GpuHeffInputMask` opisuje aktywną fizykę.
`GpuFieldMaterializationMask` opisuje wymagane osobne bufory.

Przykład:

```text
uniaxial active = true
H_ANI requested = false
=> oblicz wkład do H_eff, nie zapisuj h_ani
```

Planner rozwiązuje zależności energii/observable; kernel nie zgaduje.

## 8. Testy i DoD

- H_eff all combinations,
- output mask vs active physics,
- energy unchanged,
- post-step snapshot,
- typed reduction CPU/GPU parity,
- roundoff-bound tests,
- pinned/pageable,
- D2D accounting,
- register/spill artifact.

DoD:

- base H_eff 1 launch;
- dodatkowe pola jeden compose pass;
- niepotrzebne field buffers nie są zapisywane;
- redukcje zachowują dowody;
- brak stack D2H;
- brak memory lifecycle błędów;
- full RHS/step szybszy.
