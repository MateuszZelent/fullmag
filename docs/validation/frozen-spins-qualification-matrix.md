# Macierz kwalifikacji `frozen_spins.v1`

- Status: `SOURCE_CONFIRMED / RUNTIME QUALIFICATION INCOMPLETE`
- Ostatnia aktualizacja: 2026-08-29
- Kontrakt: `docs/physics/0996-frozen-spins-constraint.md`
- Normatywny zakres: `docs/validation/frozen-spins-v1-scope.yaml`
- Zasada: obecność źródła, wykonanie i kwalifikacja produkcyjna są odrębnymi osiami

## Statusy

| Oś | Dozwolone wartości | Znaczenie |
|---|---|---|
| `scope_status` | `REQUIRED`, `OUT_OF_SCOPE` | Decyzja produktowa z normatywnego scope ledgeru |
| `implementation_status` | `NOT_IMPLEMENTED`, `SOURCE_CONFIRMED`, `RUNTIME_CONFIRMED` | Stan kodu i wykonania; nie jest kwalifikacją release |
| `qualification_status` | `UNQUALIFIED`, `BLOCKED`, `QUALIFIED` | `QUALIFIED` wymaga ważnego immutable receiptu |
| `gate_result` | `PASS`, `FAIL`, `SKIP`, `NOT_RUN` | Wynik dokładnie nazwanej bramki |

Stan początkowy jest celowo czerwony. Dokumentacja Task 1 zamyka semantykę, ale
nie jest dowodem IR, plannera, runtime, fizyki, managed runtime ani browsera.

## Główna macierz lane

Poniższe statusy opisują stan bieżącego, brudnego checkoutu. Historyczne testy
runtime nie są immutable receiptami i dlatego nie podnoszą żadnego lane do
`QUALIFIED`.

| Lane | `scope_status` | `implementation_status` | `qualification_status` | `gate_result` | Stan dowodu |
|---|---|---|---|---|---|
| FDM CPU/reference FP64 single-grid | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `NOT_RUN` | Testy źródłowe/runtime istnieją; brak czystego source identity i receiptu P7 |
| FDM CPU/reference FP64 multilayer + ABM3 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `NOT_RUN` | Multilayer i historia ABM3 mają runtime tests; brak clean-tree receiptu P16 |
| FDM CUDA FP64 single-grid | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Trwały dirty-tree receipt potwierdza Heun/RK4/RK23/DP45/ABM3, exact restore i checkpoint na RTX 4080 SUPER |
| FDM CUDA FP32 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Ten sam managed run potwierdza pełną macierz FP32 i zero-ULP restore; finalna kwalifikacja wymaga clean tree |
| FEM CPU/MFEM FP64 explicit/minimizer/TPI | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Explicit, PG-BB, NCG i TPI przechodzą wraz z bitwise restore i free-node mobility; brak clean-tree receiptu P16 |
| FEM GPU MFEM/hypre/libCEED/CUDA FP64 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Managed receipt potwierdza device-resident Heun/PG-BB/NCG, no fallback i zero hot-loop transfers; GPU TPI jawnie unsupported |
| API v2 + standard quantity FDM/FEM | `REQUIRED` | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | Katalog/metadata/payload i FEM serial-P1 authored preview respektują `ExplicitLocalToGlobal`, airbox, incydencję i fail-closed ownership. Jednorazowy token `Preview → Activate` jest atomowo konsumowany dopiero po commitcie; replay/stale/mismatch są fail-closed. Filtr API `frozen_spins` 32/32 `PASS`; nadal brak solver-launch epoch/certificate P5/P13 |
| Control Room + browser/WebGL FDM CPU | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Realny static build: HTTP v2 `frozen_spins`, WebGL 703×478, render ACK `rendered`, screenshot i receipt `frozen-spins-browser-5061bc04-6edd-442d-bdef-09ad3d3e634a.json`; Inspector `Preview → Activate` 10/10 i transport 1/1 `PASS`; browserowy workflow aktywacji nadal nieuruchomiony; dirty source |
| Control Room + browser/WebGL FEM serial P1 | `REQUIRED` | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `NOT_RUN` | `fullmag.fem-local-node-render.v1` consumer 5/5 i authored-preview payload mają testy źródłowe; fail-closed poza P1; brak live FEM smoke |

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
- widoczny overlay/standard quantity dla FDM i FEM bez obniżania jakości innych warstw; FEM serial P1 używa zweryfikowanego local-node → published vertex carrier, a inne przestrzenie FE kończą się fail-closed;
- browser smoke: aktualny resource, canvas visible, WebGL context healthy,
  drawing buffer niezerowy.

## Macierz algorytmów i predykatów wykonania

Tabela nie publikuje statusu kwalifikacji. Jest wejściem do testów capability
covering-array; każda wymagana dodatnia komórka pozostaje `UNQUALIFIED`, dopóki
agregator nie znajdzie receiptu dla jej pełnej krotki.

| Algorytm / efekt | FDM CPU | FDM CUDA | FEM CPU | FEM GPU |
|---|---|---|---|---|
| explicit LLG fixed/adaptive RK | runtime potwierdzony | FP64 i FP32 pełna macierz runtime | runtime potwierdzony | Heun runtime potwierdzony na GPU |
| `projected_gradient_bb` / `nonlinear_cg` | runtime potwierdzony | runtime potwierdzony | runtime potwierdzony | runtime potwierdzony device-resident |
| ABM3/history | runtime potwierdzony | FP64 i FP32 runtime potwierdzony | nie dotyczy | nie dotyczy |
| `tangent_plane_implicit` | nie dotyczy | nie dotyczy | runtime potwierdzony | fail-closed: `frozen_spins_fem_gpu_tpi_unqualified` |
| STT / SOT / termika | wymagane testy pairwise P7 | wymagane testy pairwise P9/P10 | wymagane testy pairwise P11 | wymagane testy pairwise P12 |
| all-frozen relaxation | wymagane zero-ULP P7 | wymagane zero-ULP P9/P10 | wymagane zero-ULP P11 | wymagane zero-ULP P12 |
| all-frozen time evolution | wymagany analityczny advance P7 | wymagany analityczny advance P9/P10 | wymagany analityczny advance P11 | wymagany analityczny advance P12 |

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

## Stan infrastruktury dowodowej 2026-08-29

| Element | `implementation_status` | `qualification_status` | `gate_result` | Dowód bieżący |
|---|---|---|---|---|
| P0 scope ledger | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | 27 funkcji `REQUIRED`, 1 jawnie `OUT_OF_SCOPE`; walidator i 4 testy negatywne/dodatnie przechodzą |
| Authoring IR/Python | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | `verify_frozen_spins_authoring.py` przechodzi i jawnie nie deklaruje runtime qualification |
| Agregator receiptów | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | 6 testów: kompletne pokrycie, brak receiptów, dirty/fallback/SKIP/unknown driver/bad hash, mixed tree/duplicate evidence ID, source binding i append-only ledger |
| Finalny zestaw receiptów | `NOT_IMPLEMENTED` | `UNQUALIFIED` | `NOT_RUN` | 0/47 obowiązkowych test case IDs ma obecnie ważny trwały receipt bieżącego clean tree |
| FDM CUDA runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | `fdm-frozen-spins-cuda-runtime-evidence-v1.json`: FP64+FP32, pięć integratorów, max defect 0, checkpoint PASS, realne GPU |
| FEM GPU runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | `fem-frozen-spins-gpu-runtime-evidence-v1.json`: MFEM 4.9/Hypre 3.1.0, Heun/PG-BB/NCG, no fallback, transfer audit 0; dirty source |
| FEM CPU runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Explicit, PG-BB, NCG i TPI wykonane; brak finalnego receiptu przypisanego do clean tree |
| API/Control Room quantity i authoring activation | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Quantity/render-adoption 290/290, API Frozen Spins 32/32, Inspector 10/10, typed transport 1/1, typecheck i ukierunkowany ESLint przechodzą. FDM live browser/WebGL ma trwały receipt i PNG; pełna suite UI ma niezależne błędy dirty-tree, FEM live pozostaje `NOT_RUN` |

`just verify-frozen-spins-qualification` jest bramką fail-closed. Najpierw
waliduje P0 i authoring oraz własne testy agregatora, a następnie kończy się
niezerowym kodem, dopóki trwały katalog
`artifacts/qualification/frozen-spins/receipts` nie zawiera poprawnych receiptów
pokrywających wszystkie 47 obowiązkowych test case IDs na jednym clean tree.
