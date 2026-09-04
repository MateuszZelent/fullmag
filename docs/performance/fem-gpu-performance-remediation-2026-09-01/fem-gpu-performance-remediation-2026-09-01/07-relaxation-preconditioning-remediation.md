# 07. Relaksacja GPU: preconditioner, Armijo i sterowanie

**Ustalenia:** RL-01 oraz RD-01/RK-02 w NCG i PG-BB.

### Current source status (2026-09-04)

Obecna klasa `GpuExchangeMassPreconditioner` ma status: diagonal/Jacobi approximation.
Otrzymuje tylko przekątne $M$ i $K$ oraz mnoży punktowo przez
$M_i/(M_i+wK_{ii})$. Nie wykonuje pełnego sparse $(M+wK)^{-1}M$, nie ma
produkcyjnego wywołania setupu, a NCG/PG-BB nie propagują jeszcze błędu apply.
Benchmark mapuje `exchange_mass` na brak realizacji C++.

Historyczny eksperyment z 2026-07-26 pozostaje osobnym no-go i nie jest
przepisywany. Zatwierdzony projekt fazy 1 rozdziela `diagonal` od przyszłego
pełnego sparse `exchange_mass_cg4|cg8`, lecz nowa realizacja i kwalifikacja
jeszcze nie istnieją. Capability, runtime, CPU/GPU parity, physics validation i
performance pozostają `NOT VERIFIED`. The production default remains `none`.

Dalsze sekcje zachowują pierwotny plan RL-01 jako materiał historyczny. Nie są
dowodem wykonania ani promocją strategii.

## 1. CPU jako kontrakt

CPU NCG używa `relaxation::exchange_mass_preconditioned_gradient` z operatorem:

\[
P(w)=M+wK.
\]

Preconditioned gradient bierze udział w kierunku, PR+, restarcie i transporcie.
GPU NCG jest unpreconditioned. To poprawny algorytm, ale może wykonywać więcej
kroków, prób i solve’ów demag.

Metryka sukcesu: **time-to-tolA**, nie czas pojedynczej iteracji.

## 2. Właściciel

Utworzyć:

```text
gpu/cuda/relaxation/ncg_preconditioner.hpp
gpu/cuda/relaxation/ncg_preconditioner.cpp
gpu/cuda/relaxation/ncg_preconditioner_kernels.cu
gpu/cuda/relaxation/ncg_preconditioner_state.hpp
```

Dodać do `FemGpuRelaxationDeviceState`:

```cpp
enum class GpuNcgPreconditionerKind {
    None,
    Diagonal,
    ChebyshevFixedDegree,
    PcgFixedBudget,
};

struct GpuNcgPreconditionerDeviceState {
    GpuNcgPreconditionerKind kind;
    double *inverse_diagonal;
    FemGpuComponentField z;
    FemGpuComponentField work0;
    FemGpuComponentField work1;
    uint64_t operator_signature;
    uint64_t setup_count;
    uint64_t apply_count;
    uint64_t device_bytes;
};
```

## 3. Etap 1 — diagonal

Dla \(P=M+wK\):

\[
D_i=M_{ii}+wK_{ii},\qquad z_i=D_i^{-1}g_i.
\]

Po off-diagonal CSR trzeba zachować osobny `exchange_diagonal` z pełnego MFEM
operatora.

Invalidation:

- operator/mass,
- `w`,
- PBC reduction,
- mesh/material revision.

Jeżeli `w` zależy od step size, cache key zawiera exact bits lub jawnie
kwalifikowaną kwantyzację.

Testy: diagonal oracle, invalid diagonal, masks, descent, no host transfer.

## 4. Etap 2 — Chebyshev

Fixed-degree Chebyshev ogranicza global reductions.

Wymaga:

- spektralnego przedziału P,
- stałego degree 2/4/8,
- persistent work,
- fused xyz apply,
- stability qualification.

Zakres początkowo z konserwatywnego Gershgorina podczas buildera. Nie power
iteration co krok.

## 5. Etap 3 — PCG fixed budget

Tylko jeśli wcześniejsze nie poprawiają time-to-tolA:

- device dot products,
- typed reductions,
- stały budget,
- residual validation,
- zero host sync per inner iteration,
- jeden result packet po apply.

Nie przepinać demag workspace do innego operatora.

## 6. Zachowanie poprawnego PR+ po dodaniu preconditionera

Preconditioned PR+:

\[
\beta_\mathrm{PR+}=
\max\left(0,
\frac{\langle g_{k+1},z_{k+1}-Tz_k\rangle_E}
{\langle g_k,z_k\rangle_E}\right).
\]

Obecny unpreconditioned PR+ jest poprawny dla gradientu surowego. Po dodaniu
`z=P^{-1}g` GPU musi:

1. zachować `z_k`,
2. przetransportować do nowej przestrzeni stycznej,
3. policzyć poprawny numerator/denominator,
4. zachować roundoff policy,
5. restartować przy niepewnym mianowniku,
6. zachować periodic restart,
7. fallback `-z`, potem `-g`.

Nie wolno połączyć starego unpreconditioned numerator z nowym denominator.

## 7. Armijo device decision

```cpp
struct GpuArmijoDecisionPacket {
    uint32_t decision;
    uint32_t reason;
    double delta_j;
    double roundoff_bound_j;
    double rhs_increment_j;
    double trial_energy_j;
    uint64_t changed_active_nodes;
};
```

Próba:

```text
retraction
field/energy
typed direct-energy reduction
device Armijo decision
readback tylko przy accept/exhaust/refinement
```

Bounded refinement pozostaje. Liczniki rozróżniają logical i physical RHS.

## 8. PG-BB device control

Przenieść na device:

- finite flags,
- BB1/BB2,
- reset counter,
- clamp step,
- curvature decision.

Host czyta diagnostykę zgodnie z cadence. Rollback obejmuje device step state
lub shadow slot.

## 9. Planner

Nowy preconditioner nie jest automatycznie produkcyjny.

```text
none -> baseline
diagonal -> candidate po parity
chebyshev -> qualified profile
pcg -> qualified large-problem profile
```

Provenance zapisuje kind/params. Publiczny wybór dopiero po kwalifikacji.

## 10. Benchmark i DoD

Mierzyć:

- step time,
- steps/backtracks do tolA,
- field evaluations,
- demag solves,
- setup/apply,
- total wall,
- final energy/torque/state.

DoD:

- persistent state;
- no host transfer in apply;
- correct PR+;
- Armijo proof;
- rollback tests;
- time-to-tolA lepszy;
- final physics bez regresji.
