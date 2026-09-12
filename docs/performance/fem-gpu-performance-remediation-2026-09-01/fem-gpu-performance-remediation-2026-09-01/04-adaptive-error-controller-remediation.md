# 04. Naprawa adaptacyjnego estymatora błędu

**Ustalenia:** AD-01, AD-02, AD-03.

**Status po weryfikacji:** diagnozy są potwierdzone źródłowo. Kernel nadal
przyjmuje k0…k6 i pozostaje ogólny, ale obrót liczy przez dot/cosine, a runtime
warunkowo redukuje kanały; rotation kończy się jednym device min i końcowym
`acos`. Policy resolver istnieje. Typed partials, wyspecjalizowane kernele i
device decision nie są jeszcze gotowe; przewaga wydajnościowa pozostaje
`NOT VERIFIED`.

## 1. Koszt bazowy i stan bieżący

Historyczny kernel bazowy:

- przyjmuje `k0...k6`,
- przyjmuje `b_hi` i `b_lo`,
- wykonuje runtime branches,
- liczy normę błędu, defekt normy i obrót,
- wykonywał `acos` dla każdego węzła,
- zapisuje trzy tablice blokowe,
- uruchamiał trzy `DeviceReduce::Max`.

W bieżącym kodzie rotation używa dot/cosine i jednego device min; redukcje są
warunkowe. Generic kernel nadal ma wspólne kanały i nie jest specjalizacją
BS23/DP54.

## 2. Rozdzielenie metody i polityki

Pozostałe cele specjalizacji wymagają wydzielenia:

```text
gpu/cuda/integrators/rk/adaptive_error_bs23.cu
gpu/cuda/integrators/rk/adaptive_error_dp54.cu
gpu/cuda/integrators/rk/adaptive_error_policy.hpp
gpu/cuda/integrators/rk/adaptive_error_reduction.cu
```

Stary kernel może zostać compatibility oracle do czasu migracji.

```cpp
enum class GpuAdaptiveMethod { Bs23, Dp54 };

enum class GpuAdaptiveDiagnosticPolicy {
    ErrorOnly,
    ErrorAndNorm,
    ErrorAndRotation,
    ErrorNormRotation,
};
```

Planner wybiera policy wyłącznie z aktywnych semantycznie guardów.

## 3. AD-01 — bez `acos` per node

### Rotation wyłączony

`ErrorOnly`/`ErrorAndNorm` nie może:

- liczyć old-new dot,
- liczyć `acos`,
- zapisywać rotation partial,
- wykonywać rotation reduction.

### Rotation aktywny

\[
d_i=\mathrm{clamp}
\frac{m_i^\mathrm{old}\cdot m_i^\mathrm{new}}
{\|m_i^\mathrm{old}\|\|m_i^\mathrm{new}\|}.
\]

\[
\max_i\theta_i=\arccos(\min_i d_i).
\]

Redukować minimum dot/cosine, wykonać jeden `acos` po redukcji (wynik publikacji
jest zapisywany jako `max_spin_rotation`). Dla samego progu:

\[
\theta_i\le\theta_\max\iff d_i\ge\cos(\theta_\max).
\]

Można całkowicie pominąć `acos` w decyzji i liczyć go tylko dla publikacji.

Stabilność:

- clamp do `[-1,1]`,
- subnormal norm → invalid flag,
- bez aproksymacji funkcji specjalnej,
- `cos(theta_max)` policzony raz w setup/request.

## 4. AD-02 — redukcja wielokanałowa

```cpp
struct AdaptivePartial {
    double max_scaled_error;
    double max_norm_defect;
    double min_spin_dot;
    uint64_t flags;
};
```

Combine:

```text
max error
max norm defect
min spin dot
OR flags
```

Dla niewykorzystywanych pól neutral values: 0, 0, 1, 0.

`reduction_workspace_memory.cpp` dobiera temp storage jako maksimum wymagane
przez scalar i typed reductions. Zero query/allocation w kroku.

Jeżeli custom CUB type daje nieakceptowalny koszt, użyć first-stage partial +
małego second-stage kernela, zachowując ten sam interfejs.

## 5. AD-03 — wyspecjalizowane BS23/DP54

BS23 ma tylko 4 derivative sets; DP54 ma 7. Współczynniki są compile-time.
Usunąć `stages > s` i nieużywane parametry.

Pierwszy PR nie łączy adaptive error z RHS/HYPRE. Późniejsza fuzja raw
candidate + embedded difference jest dopuszczalna po endpoint cache.

## 6. Device decision

```cpp
__global__ void finalize_adaptive_decision(
    const AdaptivePartial *reduced,
    const AdaptivePolicyParameters *policy,
    GpuRkAttemptControlPacket *packet);
```

Kernel:

1. sprawdza flags/finite;
2. wyznacza effective normalized error;
3. stosuje kanoniczną PI policy;
4. zapisuje decision/reason/dt_next.

Matematyka PI musi być współdzielonym host/device helperem albo mieć immutable
golden vectors. Nie utrzymywać dwóch niezależnych zestawów stałych.

## 7. Call sites

- `rk_error_norm_runtime.cu`,
- `rk_adaptive_decision_readback.cu`,
- `rk_attempt_loop.cu`,
- `rk_workspace_state.hpp`,
- `rk_workspace_memory.cpp`,
- `reduction_workspace_memory.cpp`,
- CMake.

## 8. Testy

- BS23/DP54 coefficient goldens,
- ErrorOnly parity,
- norm guard on/off,
- rotation: 0, threshold, pi,
- nonfinite/all nonmagnetic/frozen,
- one reduction,
- one readback,
- register count artifact,
- SP4 dt/accept trajectory.

## 9. DoD

- ErrorOnly nie wykonuje norm/rotation;
- rotation nie wykonuje `acos` per node;
- jedna typed reduction;
- jedna typed decision;
- brak zmiany tolerancji;
- managed parity i SP4 przechodzą.
