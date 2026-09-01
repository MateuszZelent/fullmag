# 05. Naprawa demagnetyzacji Poissona i HYPRE

**Ustalenia:** DM-01, DM-02, DM-03, DM-04, DM-05 oraz podwójne ustawianie
polityki HYPRE wykryte na aktualnym `master`.

## 1. Co zachować

- persistent Hypre matrix/vectors/solver/preconditioner,
- setup poza każdym RHS,
- warm/fresh-zero policy,
- device memory/execution,
- eventowy most Fullmag ↔ HYPRE,
- device RHS/recovery,
- phase telemetry.

Nie zastępować eventów globalnym `cudaDeviceSynchronize`.

## 2. Jeden właściciel polityki HYPRE

`runtime/hypre_device_policy.cpp` ma być jedynym właścicielem process-wide
`HYPRE_Set*`. `hypre_device_solver.cpp` nadal posiada lokalne settery.

Naprawa:

1. usunąć `configure_hypre_device_vendor_kernels`;
2. po `mfem::Hypre::Init/InitDevice` wywołać wyłącznie
   `configure_hypre_cuda_device_policy`;
3. zwalidować snapshot;
4. zapisać snapshot do provenance/workspace;
5. nie czyścić HYPRE errors poza policy owner.

Source contract zabrania `HYPRE_SetMemoryLocation`, `SetExecutionPolicy`,
`SetSp*UseVendor` poza `runtime/hypre_device_policy.cpp`.

## 3. DM-01 — `FieldOnly`

W `stage_compute.hpp`:

```cpp
enum class GpuDemagEvaluationMode : uint32_t {
    FieldOnly,
    FieldAndRecoveredEnergy,
};

enum class GpuDemagSolvePurpose : uint32_t {
    IntermediateRkStage,
    EndpointRkStage,
    RelaxationTrial,
    RelaxationAcceptedState,
    ObservableRefresh,
    ValidationOracle,
};

struct GpuDemagApplyRequest {
    bool reset_initial_solution;
    GpuDemagEvaluationMode evaluation_mode;
    GpuDemagSolvePurpose purpose;
};
```

Wspólny impl przyjmuje request.

Call sites:

- pośredni/endpoint RK → `FieldOnly`,
- final stats → osobny energy reducer,
- direct minimizer → jego energy owner,
- H_demag snapshot → `FieldOnly`,
- validation oracle → jawny energy mode.

W `FieldOnly` nie pozostawiać starego demag energy slot jako aktualnego.
Output mask/final stats musi go ustawić lub oznaczyć nieważnym.

Telemetry:

```text
demag_solves++
demag_stage_energy_evaluations += mode == FieldAndRecoveredEnergy
```

## 4. DM-02 — warunkowe `Norml2(rhs)`

Utworzyć pure helper:

```text
gpu/cuda/demag_poisson/hypre_validation_policy.hpp
```

```cpp
struct HypreResidualValidationNeeds {
    bool rhs_norm;
    bool independent_residual;
};

HypreResidualValidationNeeds resolve_hypre_residual_validation_needs(
    bool solver_reported_converged,
    bool has_absolute_tolerance,
    bool force_independent_validation);
```

Norma RHS jest potrzebna tylko, gdy:

- solver nie zgłasza zbieżności,
- jest absolutna tolerancja,
- diagnostyka wymusza niezależną certyfikację.

Implementacja:

```cpp
const auto needs = resolve(...);
double rhs_norm = 0.0;
if (needs.rhs_norm) {
    rhs_norm = b.Norml2();
    gpu_perf_note_demag_rhs_norm(ctx);
}
if (needs.independent_residual) {
    A*x -> r
    exact stream wait
    r -= b
    absolute_residual = r.Norml2();
}
```

Relative residual HYPRE nadal jest walidowany.

## 5. DM-03 — fused recovery

W `operators.cpp` wykryć, czy x/y/z mają identyczne:

- row offsets,
- column indices.

Użyć digest, potem pełnego porównania.

```cpp
enum class GpuDemagRecoveryMode {
    SplitCsr,
    SharedPatternFusedXyz,
};
```

Shared pattern state ma jedne indeksy i trzy value arrays.

Fused kernel czyta `u[col]` raz i akumuluje hx/hy/hz. Jeśli patterny się
różnią, zachować split path i raportować resolved mode.

Testy: common/different pattern, parity, launch count, memory destroy.

## 6. DM-04 — timeline HYPRE

Per solve mierzyć:

```text
wait_in_enqueue_host_ns
hypre_mult_host_api_ns
hypre_device_elapsed_ns
wait_out_enqueue_host_ns
iterations
AMG levels / unknowns per level
```

Event timing pozostaje opt-in. Work counters są zawsze.

Benchmarkować istniejące policy:

- CG/AMG,
- CG/Jacobi,
- GMRES/AMG,
- relax/coarsening/interpolation/aggressive/strength/max levels.

Kryterium: wall time pełnego RHS i całej symulacji, nie sama liczba iteracji.

Pipelined solver rozważać dopiero po profilu i osobnym ADR, jeżeli obecna
wersja HYPRE/MFEM ma stabilne API.

## 7. DM-05 — purpose-dependent tolerance

P0 zachowuje request `rtol` dla wszystkich purpose.

Najpierw benchmark-only explicit policy:

```cpp
struct GpuDemagPurposeTolerancePolicy {
    double intermediate_rtol;
    double endpoint_rtol;
    double relaxation_trial_rtol;
    double accepted_rtol;
};
```

Sweep 1e-12...1e-8. Mierzyć field/energy error, accept/reject, crossing,
time-to-tolA. Dopiero po kwalifikacji dodać opcjonalne wersjonowane publiczne
pole. Brak pola = identyczny rtol.

## 8. Warm start i endpoint cache

- fresh-zero po invalidation/failure zgodnie z kontraktem;
- endpoint reuse zachowuje exact solution endpointu;
- reject unieważnia/odtwarza iterate;
- liczniki warm/fresh/cache;
- żadnego wykorzystania odrzuconej próby bez tokenu.

## 9. Testy i DoD

Testy:

- HYPRE setter source owner,
- residual truth table,
- converged relative-only → zero rhs norm,
- absolute/nonconverged branches,
- FieldOnly → zero stage energy,
- final energy parity,
- fused/split recovery,
- warm/fresh rollback,
- periodic Poisson,
- no global sync,
- setup count = 1.

DoD:

- jeden owner policy;
- conditional rhs norm;
- zero stage energy w RK;
- fused recovery gdy legalne;
- persistent setup;
- residual/physics parity;
- krótszy full RHS.
