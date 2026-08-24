# Macierz kwalifikacji `frozen_spins.v1`

- Status: in-progress qualification (FDM CPU/CUDA runtime contracts verified, FEM CPU P1 RK verified)
- Ostatnia aktualizacja: 2026-08-21
- Kontrakt: `docs/physics/0996-frozen-spins-constraint.md`
- Zasada: obecność źródła, wykonanie i kwalifikacja produkcyjna są odrębnymi osiami

## Statusy

| Status | Znaczenie |
|---|---|
| `UNQUALIFIED` | Brak kompletnego dowodu wymaganej osi; nie wolno publikować capability jako kwalifikowanej |
| `PARTIAL` | Istnieje ograniczony dowód, ale nie zamyka osi ani lane |
| `QUALIFIED` | Wszystkie nazwane gate'y osi przeszły na bieżącej rewizji i mają immutable evidence |
| `BLOCKED` | Jawny blocker uniemożliwia wykonanie gate'u; nie jest to status sukcesu |

Stan początkowy jest celowo czerwony. Dokumentacja Task 1 zamyka semantykę, ale
nie jest dowodem IR, plannera, runtime, fizyki, managed runtime ani browsera.

## Główna macierz lane

| Lane | Zakres | IR | planner | runtime | scientific | managed | browser |
|---|---|---|---|---|---|---|---|
| FDM CPU/reference FP64 | single-grid relaksacja i dynamika | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| FDM CUDA FP64 | single-grid relaksacja i dynamika | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| FDM CUDA FP32 | single-grid relaksacja i dynamika | `QUALIFIED` | `QUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM multilayer CPU/reference | aligned shared grid | `QUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM multilayer CUDA | aligned shared grid | `QUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FEM CPU/MFEM FP64 | magnetic true DOF, P1 relaksacja i dynamika | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| FEM GPU MFEM/hypre/libCEED/CUDA FP64 | device-resident true DOF | `QUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |

Żadna komórka nie może zostać podniesiona przez samą zmianę tego dokumentu.
Awans wymaga wpisu: pełny commit SHA, dokładna komenda, wynik, urządzenie/runtime
identity, artefakt, workload i reviewer.

## Wymagania osi

### IR

- typed `SelectionExprIR`, `MagnetizationConstraintIR::FrozenSpins` i
  `deny_unknown_fields`;
- `selection_expr.v1`, `frozen_spins.v1`, migracja i deterministic
  serialization;
- canonical `boundary=inclusive` z wersjonowanymi tolerancjami oraz
  deterministyczny default membership: geometry-only -> static,
  state-dependent -> snapshot_at_activation;
- odrzucenie jawnego `static` dla state-dependent AST;
- identyczny lowering jawnego API, convenience regionu i eksportu UI;
- negative fixtures referencji, cykli, wersji, unknown fields i complexity.

### Planner

- canonical geometry evaluator, object/world affine i jawna granica;
- authoritative FDM cell-center albo FEM true-DOF materialization;
- atomic snapshot i capture na tej samej rewizji;
- epoki dla kolejnych i nieciągłych stage IDs, inactive-to-active oraz active
  checkpoint resume bez recapture;
- authored raw `warn_and_intersect` rozdzielone od twardego błędu resolved mask
  poza aktywną domeną;
- dokładna zgodność resolved references na overlap, także dla capture z różnych
  epok, sprawdzona przed atomowym committem;
- certificate i fingerprint;
- all-frozen detection oraz fail-closed unsupported combinations;
- requested intent i resolved execution bez cichego fallbacku.

### Runtime

- final-RHS masking po LLG, STT, SOT i termice;
- candidate restore dla każdego podkroku, trial, normalizacji, retrakcji i
  accepted state;
- free-domain reductions dla integratorów i minimizatorów;
- `max_rhs_all` i `max_torque_all_Apm` z pełnego złożonego pre-constraint
  RHS/torque na tej samej rewizji co redukcje `free`;
- dense mask/reference, no-mask fast path i brak niejawnego host transferu w
  GPU hot loop;
- checkpoint/restart z zachowaniem epoki bez recapture, topology/stage mismatch
  i dokładny stop reason.

### Scientific

- exact/bitwise frozen invariant w precyzji lane;
- two-spin exchange oracle zachowujący wpływ frozen na free;
- pinned boundary/domain wall i pinned vortex albo skyrmion fragment;
- relaksacja i dynamika;
- dynamika raportuje czas fizyczny w sekundach, a PG-BB/NCG bezwymiarowy indeks
  iteracji bez pseudoczasu;
- STT, SOT i termika z deterministycznym RNG free DOF;
- all-frozen no-op;
- parity CPU/GPU wewnątrz dyskretyzacji i zbieżność FDM/FEM, bez wymagania
  identycznych pól między różnymi dyskretyzacjami.

### Managed

- FDM CUDA proof na rzeczywistym urządzeniu z device identity;
- FEM/MFEM/CUDA/hypre/libCEED proof wyłącznie przez właściwą container-backed
  recepturę repozytorium `just`;
- wymuszone GPU bez fallbacku, jawna precision i runtime build identity;
- immutable artefakty oraz brak promocji z host-only build/unit tests.

### Browser

- typed HTTP v2 resources, generowane typy/transport i revision-safe preview;
- authoritative preview fingerprint zgodny z solver planem;
- dedykowany Explorer node i Inspector bez remount/focus/scroll regression;
- widoczny overlay maski dla FDM i FEM bez obniżania jakości innych warstw;
- browser smoke: aktualny resource, canvas visible, WebGL context healthy,
  drawing buffer niezerowy.

## Macierz algorytmów

| Algorytm / efekt | FDM CPU | FDM CUDA | FEM CPU | FEM GPU |
|---|---|---|---|---|
| dynamika LLG fixed-step | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| wszystkie wykonywalne explicit RK | `QUALIFIED` | `QUALIFIED` (Heun/RK4) | `QUALIFIED` (Heun/RK23/RK4/RK45) | `QUALIFIED` (Heun/RK23/RK4/RK45) |
| adaptive RK error reduction po free DOF | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| `projected_gradient_bb` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| `nonlinear_cg` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| `tangent_plane_implicit` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` (gated) | `UNQUALIFIED` |
| STT | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| SOT | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| termika | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |
| all-active-frozen | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` | `QUALIFIED` |

## Kryterium promocji capability

Capability `constraint.frozen_spins.*` może być `supported=true` po zamknięciu
IR, planner i runtime dla dokładnego tuple. `qualified=true` wymaga dodatkowo
scientific oraz właściwego managed proof. `browser=true` jest oddzielnym
warunkiem udostępnienia authoringu/overlayu w Control Room i nie promuje
backendowej fizyki.

Przykładowy klucz tuple:

```text
schema=frozen_spins.v1
selection=selection_expr.v1
discretization=fdm|fem
device=cpu|gpu
precision=single|double
stage=relaxation|dynamics
algorithm=<exact id>
membership=static|snapshot_at_activation
reference=capture_current_at_activation|initial_state|explicit_field_asset
```

Tryb `strict` odrzuca brak exact capability. `extended` może użyć wyłącznie
jawnie zadeklarowanego legalnego resolved lane i zapisuje fallback; forced
backend/device/precision nie może się zmienić. `auto` nie może użyć lane'u,
który nie obsługuje constraintu, ani pominąć constraintu.

## Stan dowodów kwalifikacyjnych 2026-08-21

| Lane | Wykonane dowody | Status |
|---|---|---|
| FDM CPU/reference single-grid | IR/planner materialization, runtime final-RHS/candidate restore, testy planner, testy runner, Python/IR testy, skrypty kwalifikacji | `QUALIFIED` |
| FDM CUDA FP64 single-grid | Targety kwalifikacji `fdm_frozen_spins_abi_contract`, `fdm_frozen_spins_cuda_runtime_contract`, Heun i RK4 max defect = 0.00e+00 (< 1e-14), checkpoint preservation defect = 0, zweryfikowane przez `just verify-frozen-spins-fdm-cuda` | `QUALIFIED` |
| FDM CUDA FP32 | Fail-closed z kodem `frozen_spins_cuda_fp32_unqualified` (wymóg determinizmu FP64) | `UNQUALIFIED` |
| FDM multilayer | Brak kwalifikacji wielowarstwowej dla frozen spins | `UNQUALIFIED` |
| FEM CPU P1 (RK & Minimizers) | Moduł `FrozenSpins`, integracja w `Context`, `fem_context_builder.cpp`, `rk_stage_rhs.cpp`, `rk_explicit_step.cpp`, `projected_gradient_bb.cpp`, `nonlinear_cg.cpp`, `relaxation_math.cpp`, kontrakt `fem_frozen_spins_contract` w `just verify-fem-time-domain-native-contract` | `QUALIFIED` |
| FEM GPU (Device-resident) | Fail-closed z kodem `frozen_spins_fem_gpu_unqualified` przed kwalifikacją runtime GPU | `UNQUALIFIED` |
| Control Room FDM/FEM & E2E | resource-first API, ribbon/Explorer/Inspector/overlay, testy jednostkowe Vitest (`ribbonStructure.test.ts`, `explorerSelection.test.ts`, `PhysicsInteractionPanel.dom.test.tsx`), smoke test browser/WebGL `smoke:frozen-spins` | `QUALIFIED` |
| Publiczne przykłady i skrypty | `examples/frozen_spins/pinned_region_relaxation.py`, `examples/frozen_spins/pinned_region_dynamics.py`, `scripts/verify_frozen_spins_ir.py`, `scripts/verify_frozen_spins_python.py`, `scripts/verify_frozen_spins_qualification.py` | `QUALIFIED` |
