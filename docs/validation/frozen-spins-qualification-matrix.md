# Macierz kwalifikacji `frozen_spins.v1`

- Status: failing qualification fixture
- Ostatnia aktualizacja: 2026-08-20
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
| FDM CPU/reference FP64 | single-grid relaksacja i dynamika | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM CUDA FP64 | single-grid relaksacja i dynamika | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM CUDA FP32 | single-grid relaksacja i dynamika | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM multilayer CPU/reference | aligned shared grid | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FDM multilayer CUDA | aligned shared grid | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FEM CPU/MFEM FP64 | magnetic true DOF, P1 i osobna bramka P2 | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| FEM GPU MFEM/hypre/libCEED/CUDA FP64 | device-resident true DOF | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |

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

Każdy wpis jest osobnym gate'em; kwalifikacja jednego nie przechodzi na sąsiada.

| Algorytm / efekt | FDM CPU | FDM CUDA | FEM CPU | FEM GPU |
|---|---|---|---|---|
| `llg_overdamped` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| dynamika LLG fixed-step | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| wszystkie wykonywalne explicit RK | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| adaptive RK error reduction po free DOF | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| ABM/history reset i restore | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| `projected_gradient_bb` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| `nonlinear_cg` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| `tangent_plane_implicit` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| STT | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| SOT | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| termika | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |
| all-active-frozen | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` | `UNQUALIFIED` |

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

## Minimalny ledger przyszłego dowodu

| Pole | Wymaganie |
|---|---|
| commit | pełny SHA |
| lane tuple | solver, device, precision, stage, algorithm, selector/reference/membership |
| command | dokładna repozytoryjna receptura albo test |
| runtime identity | backend build, device, driver i biblioteki właściwe dla lane |
| artifact | immutable path/hash oraz schema version |
| oracle | analityczny, CPU reference, zewnętrzny solver albo convergence study |
| tolerances | jawne wartości i uzasadnienie |
| result | PASS albo dokładny blocker; skipped nie jest PASS |
| reviewer | physics i właściciel lane |

Aktualny ledger nie zawiera dowodu frozen spins. Wszystkie lane'y pozostają
`UNQUALIFIED`.

## Stan dowodów po implementacji 2026-08-20

Poniższy wpis nie promuje żadnego lane'u do `QUALIFIED`; rozdziela jedynie
wykonane kontrakty od brakujących bramek produkcyjnych.

| Lane | Wykonane dowody | Pozostaje otwarte |
|---|---|---|
| FDM CPU/reference single-grid | IR/planner materialization, runtime final-RHS/candidate restore, 21 testów planner, 5 testów runner, Python/IR testy | pełna macierz scientific, managed executable proof, browser |
| FDM CUDA | append-only ABI, C++ ABI 1/1, Rust FFI 1/1, managed `verify-frozen-spins-fdm-cuda`, fail-closed capability 1/1 | CUDA kernels/integratory/minimizers, CPU↔GPU parity, device proof |
| FDM multilayer | jawny typed rejection przed emisją planu | per-layer maska i runtime |
| FEM CPU/GPU | true-DOF planner materialization, append-only descriptor, managed build, fail-closed guards | native mask/restore/reductions, FEM preview true-DOF, parity |
| Control Room FDM | resource-first API, ribbon/Explorer/Inspector/overlay, 93 focused tests, typecheck | real browser/WebGL, FEM carrier |

Wartości `QUALIFIED` są nadal zarezerwowane dla immutable scientific/managed
evidence; sama kompilacja zarządzanego runtime nie jest dowodem wykonania
frozen spins przez backend.
