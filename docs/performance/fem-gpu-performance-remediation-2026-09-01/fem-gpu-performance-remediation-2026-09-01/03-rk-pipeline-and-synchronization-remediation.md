# 03. Naprawa grafu RK, synchronizacji i powtórnej pracy

**Ustalenia:** RK-01, RK-02, RK-03, RK-04, RK-05, RK-06.

**Status po weryfikacji:** wszystkie sześć diagnoz ma potwierdzenie w grafie
źródłowym. Deferred normalizer validation, pinned attempt-control packet,
endpoint token/FSAL oraz opcjonalny metric mode są już obecne w kodzie; typed
buffer roles, output mask v2, publiczne API v2 i device-side PI decision nadal
nie są gotowe. Adaptive readback ma jedną ścieżkę packet+fence, ale część
legacy nadal istnieje. Wpływ na wall time pozostaje `NOT VERIFIED`.

Historyczny budżet przed remediacją dla warm BS23 adaptive to 4 RHS (trzy
stage, w tym endpoint k3, oraz obowiązkowy final refresh), trzy normalizacje i
jeden adaptive scalar readback. Bieżący kod ma warunkowe endpoint/FSAL reuse,
deferred normalizację i jeden packet control, ale ich liczby oraz parytet DP54
nie zostały jeszcze zmierzone w managed runtime.

## 1. Granice własności

- plan i legality: `gpu/cuda/integrators/rk/rk_plan.cpp`,
- transakcja kroku: `rk_step_transaction_device.cu`,
- próba: `rk_attempt_loop.cu`,
- przygotowanie: `rk_attempt_setup.cu`,
- sekwencje metod: `rk23_stage_sequence.cu`, `rk45_stage_sequence.cu`, itd.,
- finalizacja: `rk_final_refresh.cu`, `rk_step_stats.cu`,
- workspace: `rk_workspace_state.hpp`, `rk_workspace_memory.cpp`,
- pola endpoint: `fields/field_buffer_state.hpp`.

Nie umieszczać logiki metod w `src/api.cpp`, runnerze ani `Context`.

## 2. RK-01 — deferred validation normalizacji

### Stan

`fullmag_cuda_normalize_vectors`:

1. zeruje flagę device,
2. normalizuje,
3. kopiuje flagę do zmiennej hostowej,
4. synchronizuje compute stream,
5. zwraca błąd.

Jest wywoływana po każdym predyktorze.

### Stan wdrożony

Wprowadzono:

```text
gpu/cuda/integrators/rk/rk_attempt_control_state.hpp
gpu/cuda/integrators/rk/rk_attempt_control_memory.cpp
gpu/cuda/integrators/rk/rk_attempt_control_kernels.cu
```

i osadzono stan w `FemGpuRkWorkspaceDeviceState`:

```cpp
enum GpuRkAttemptFlag : uint64_t {
    GpuRkAttemptFlagNone = 0,
    GpuRkAttemptFlagInvalidNormalization = 1ull << 0,
    GpuRkAttemptFlagNonFiniteError = 1ull << 1,
    GpuRkAttemptFlagRotationViolation = 1ull << 2,
    GpuRkAttemptFlagNormViolation = 1ull << 3,
};

struct GpuRkAttemptControlPacket {
    uint64_t flags;
    double error_norm;
    double max_norm_defect;
    double max_spin_rotation;
    double suggested_dt;
    uint32_t decision;
    uint32_t reason;
};

struct GpuRkAttemptControlDeviceState {
    GpuRkAttemptControlPacket *device = nullptr;
    GpuRkAttemptControlPacket *host_pinned = nullptr;
    bool host_pinned_owned = false;
};
```

Nie używać przypadkowo pierwszych slotów `scalar_result`, ponieważ są
współdzielone z energią i relaksacją.

### Nowa funkcja normalizacji

```cpp
void fullmag_cuda_normalize_vectors_deferred(
    const FemGpuComponentField &target,
    const FemGpuComponentField &safe_fallback,
    const uint8_t *magnetic_node_mask,
    GpuRkAttemptControlPacket *packet,
    int N,
    cudaStream_t stream = nullptr,
    GpuPerformanceCounterState *performance_counters = nullptr);
```

Funkcja nie zwraca wyniku walidacji danych; zapisuje flagi do packetu, a błędy
enqueue/launch są sprawdzane przez istniejącego właściciela sekwencji CUDA.

Kernel dla aktywnego węzła:

```text
if finite && norm >= DBL_MIN:
    target = target / norm
else:
    target = safe_fallback
    atomicOr(packet.flags, InvalidNormalization)
```

Bezpieczny fallback musi być skończony:

- dla predyktora: `m_backup` albo aktualny accepted state;
- dla frozen node: frozen reference;
- dla nonmagnetic node: zachować dotychczasową semantykę.

Dzięki temu kolejne GPU operatory nie dostają NaN przed odczytem pakietu.

### Kiedy czytać pakiet

- adaptive: razem z decyzją accept/reject;
- fixed step: raz po zakończeniu próby, przed commit transakcji;
- debug/profile nie może dodawać osobnego fence.

### Rollback

Jeżeli flaga invalid:

- adaptive → typed failed decision lub retry według istniejącej polityki;
- fixed → restore transaction i zwróć kod zgodny z obecnym kontraktem;
- receipt próby nie może zostać opublikowany.

## 3. Fuzja predictor + normalize

Po usunięciu host fence nadal pozostają dwa pełne przejścia:

```text
write predictor to m_stage
read m_stage, normalize, write m_stage
```

Dla każdej metody dodać wyspecjalizowany kernel:

```cpp
fullmag_cuda_rk23_predict_normalize(...)
fullmag_cuda_rk45_predict_normalize<Stage>(...)
fullmag_cuda_rk4_predict_normalize(...)
```

Kernel:

1. czyta `m_n` i wymagane `k`,
2. oblicza surowy predyktor w rejestrach,
3. oblicza normę,
4. zapisuje znormalizowany `m_stage`,
5. ustawia flagę invalid,
6. opcjonalnie stosuje frozen projection.

### Uwaga o PBC

Jeżeli wiele pełnych węzłów zapisuje tę samą klasę periodyczną, nie wolno
łączyć projekcji z dowolnym predyktorem bez jednego kanonicznego autora.
Najpierw zachować istniejącą deterministic projection. Po przeniesieniu
magnetyzacji do reduced representation można projektować w jednym kernelu.

### Surowy kandydat embedded

Adaptive error może potrzebować surowego high-order candidate. Dla endpointu:

- obliczyć raw candidate do dedykowanego `m_candidate_raw`,
- znormalizować do `m_candidate`,
- estymator dostaje oba zgodnie z kontraktem,
- nie nadpisywać raw przed redukcją błędu.

## 4. RK-02 — jeden control readback na próbę

`gpu_rk_read_adaptive_error_norm_decision_host` ma odczytać jeden packet:

```cpp
bool gpu_rk_read_attempt_control_packet(
    Context &ctx,
    cudaStream_t stream,
    GpuRkAttemptControlPacket &out,
    std::string &reason);
```

Funkcja:

- `cudaMemcpyAsync` device → pinned host packet,
- dokładnie jeden `cudaStreamSynchronize`,
- zapisuje control bytes/fence,
- waliduje flags i typed decision,
- nie wykonuje dodatkowych odczytów.

### Device decision

Mały kernel może obliczać:

```text
effective error
PI factor
dt_next
accepted/retry/failed
typed reason
```

Pierwszy PR może zachować PI na CPU, o ile wszystkie dane są w jednym pakiecie.
Następny PR przenosi decyzję na GPU.

## 5. RK-03 — dokładny endpoint FSAL

### BS23

Adaptacyjny BS23 oblicza (historyczny przebieg przed reuse):

\[
k_3=f(t_{n+1},m_{n+1})
\]

po normalizacji kandydata; przed remediacją final refresh ponownie liczył to
samo RHS.

### Attempt-local token (stan wdrożony)

W `rk_workspace_state.hpp` zapisano token przez pola endpointu:

```cpp
bool endpoint_valid = false;
uint32_t endpoint_integrator = 0;
uint64_t endpoint_generation = 0;
double endpoint_time_seconds = 0.0;
uint64_t endpoint_operator_signature = 0;
bool endpoint_consumed = false;
```

Token poświadcza, że:

- bieżące `m` jest dokładnym endpointem,
- `k[slot]` jest RHS tego endpointu,
- `h_ex/h_demag/h_eff` odpowiadają temu samemu endpointowi i czasowi,
- konfiguracja nie zmieniła się.

### BS23 finalizacja

W `rk_final_refresh.cu`:

```text
if valid exact BS23 endpoint:
    nie wywołuj gpu_rk_compute_rhs_for_magnetization
    skopiuj lub aliasuj k3 jako przyszły FSAL
    użyj istniejących endpoint fields
    consume token exactly once
else:
    wykonaj compatibility final refresh
```

Pierwsza wersja może zachować 3×D2D `k3 -> k0`; największy zysk to usunięcie
RHS/Poissona. Następny PR wprowadza `fsal_slot`.

### DP54

Obecny `m_stage` użyty dla `k6` i `m` odtworzony przez `dp54_accept` mogą
różnić się bitowo. Docelowo:

```text
build raw high-order endpoint once
preserve raw endpoint for embedded error
normalize endpoint once
compute k6 at this exact normalized endpoint
accept przez swap/copy dokładnie tego endpointu do authoritative m
publish endpoint token
```

`dp54_accept_kernel` nie rekonstruuje endpointu w ścieżce adaptacyjnej.

Ważne ograniczenie bezpieczeństwa: gdy aktywna jest mapa okresowa, GPU wymusza
projekcję `m` przed RHS, ale FSAL pozostaje wyłączony do czasu dowodu bitowej
tożsamości kandydata po projekcji z endpointem użytym do `k_6`/`k_3`.

### Invalidation

Token invalidować przy:

- reject/failure,
- zmianie field/material/mesh/solver revision,
- zewnętrznym uploadzie `m`,
- innym endpoint time,
- refinement zmieniającym endpoint,
- nadpisaniu pól.

### Testy

- warm accepted BS23: `rhs=3`, `demag_solves=3`, hit 1;
- reject then accept;
- time-dependent Zeeman/regional drive;
- failure injection podczas finalizacji;
- DP54 exact state identity.

## 6. RK-04 — LLG metric wyłącznie dla konsumenta

Fused LLG RHS może pominąć per-node metric i block maxima dla pośredniego RHS;
finalizacja jawnie żąda metryki. Globalna redukcja maksimum jest wykonywana
podczas finalizacji; nie opisywać tego jako pełnej globalnej redukcji „na każdym
stage”.

Dodać:

```cpp
enum class GpuLlgMetricMode {
    NoMetric,
    MaxNormSquared,
};
```

oraz templated kernel.

`NoMetric`:

- bez `sqrt`,
- bez CUB BlockReduce,
- bez `block_max_rhs`.

`MaxNormSquared` redukuje:

\[
r_x^2+r_y^2+r_z^2
\]

i wykonuje jeden `sqrt` po globalnym maksimum.

Call sites:

- pośredni stage → `NoMetric`,
- endpoint/final metric → `MaxNormSquared`,
- endpoint cache może policzyć lekki metric kernel bez pełnego RHS.

## 7. RK-05 — kopie D2D i role buforów

### Etap 1

Mierzyć osobno backup, raw candidate, FSAL copy i reject restore bytes.

### Etap 2 — role

```cpp
struct FemGpuMagnetizationBufferRoles {
    FemGpuComponentField current;
    FemGpuComponentField backup;
    FemGpuComponentField candidate;
    FemGpuComponentField raw_candidate;
};
```

Transakcja:

```text
begin: current pozostaje authoritative
accept: swap(current, candidate)
reject: current bez zmian
```

Warunki:

- żadna długowieczna struktura nie przechowuje nieaktualnego raw pointera;
- HYPRE konsumuje wskaźnik przekazany w call;
- snapshot lease jest związany z eventem;
- destruction zwalnia bazowe alokacje raz.

### FSAL role

```cpp
uint32_t fsal_slot;
bool fsal_valid;
```

Predyktory używają accessora lub resolved slot, nie stałego `k[0]`.

## 8. RK-06 — maska wymaganych wyników

### Bezpieczne ABI

Dodać nowy entrypoint:

```cpp
#define FULLMAG_FEM_STEP_REQUEST_ABI_VERSION 2u

typedef enum {
    FULLMAG_FEM_STEP_OUTPUT_CONTROL_METRICS = 1ull << 0,
    FULLMAG_FEM_STEP_OUTPUT_ENERGIES = 1ull << 1,
    FULLMAG_FEM_STEP_OUTPUT_FIELD_METRICS = 1ull << 2,
    FULLMAG_FEM_STEP_OUTPUT_AVERAGE_M = 1ull << 3,
    FULLMAG_FEM_STEP_OUTPUT_PROFILE = 1ull << 4,
} fullmag_fem_step_output_mask_v2;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t output_mask;
} fullmag_fem_step_request_v2;

int fullmag_fem_backend_step_v2(
    fullmag_fem_backend *,
    const fullmag_fem_step_request_v2 *,
    fullmag_fem_step_stats *);
```

Stary entrypoint deleguje do v2 z pełną compatibility maską.

### Rozwiązanie maski

```text
required = control_mask_from_stage_completion
requested = runner publication mask
effective = required | requested
```

Runner zna table/preview/artifact cadence. Backend nie zgaduje frontendu.

Jeżeli endpoint fields są ważne, późniejsze żądanie snapshotu może policzyć
brakujące observables jako post-step refresh, bez zmiany solver state.

## 9. TDD i DoD

RED:

- normalizer source contract bez `cudaStreamSynchronize`;
- fixed/adaptive invalid-vector tests;
- exact control readback count;
- FSAL endpoint tests;
- LLG no-metric bez BlockReduce;
- v1/v2 step compatibility;
- minimal mask zachowuje stop criteria.

DoD:

- zero normalizer host readback;
- maksymalnie jeden control fence/adaptive attempt;
- warm BS23 = 3 RHS/3 Poisson;
- atomic rollback/receipt;
- output mask usuwa zbędne final work;
- managed trajectory i temporal tests przechodzą.
