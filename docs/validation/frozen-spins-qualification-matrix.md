# Macierz kwalifikacji `frozen_spins.v1`

- Status: `RUNTIME_CONFIRMED / RELEASE QUALIFICATION INCOMPLETE`
- Ostatnia aktualizacja: 2026-08-31
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

Stan implementacji jest potwierdzony, ale macierz pozostaje fail-closed dla
release. Dokumentacja i testy źródłowe nie zastępują dowodu managed runtime,
clean source identity ani kompletnego zestawu receiptów P16.

## Główna macierz lane

Poniższe statusy opisują stan bieżącego, brudnego checkoutu. Historyczne testy
runtime nie są immutable receiptami i dlatego nie podnoszą żadnego lane do
`QUALIFIED`.

| Lane | `scope_status` | `implementation_status` | `qualification_status` | `gate_result` | Stan dowodu |
|---|---|---|---|---|---|
| FDM CPU/reference FP64 single-grid | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Pełny dirty-tree authoring→solver→3D receipt `frozen-spins-browser-2a185f77-03c7-4116-ab14-0728fceae6e7` potwierdza 384/0 preview/solver, dodatnie `source_state_revision=1`, identity parity i WebGL. Dedykowane managed `just verify-frozen-spins-fdm-cpu` wykonało 14/14 testów i zapisało `fdm-frozen-spins-cpu-scientific-v1.json`: invariant/mobility/influence, dokładny two-spin oracle i energy accounting, free-only telemetry/stopping, no-mask parity, fixed-seed thermal reproducibility, monotoniczną energię minimizerów, all-frozen relaxation, persisted reference oraz bitowo zgodne ABM3 checkpoint/resume. Brak czystego source identity i finalnego receiptu P16. |
| FDM CPU/reference FP64 multilayer + ABM3 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Managed `just verify-frozen-spins-fdm-multilayer` wykonało `29` testów runnera + `1` test planera (`30/30 PASS`) w obrazie `fem-cpu`; receipt [`fdm-frozen-spins-multilayer-v1.json`](../../artifacts/qualification/frozen-spins/fdm-multilayer/fdm-frozen-spins-multilayer-v1.json), SHA-256 `44d3c0834ecf2a93ee01cb990141e622e2e1b9a89f84b2cdbd62045ee3c25766` (log `a14fa3a3066209d5b6f9330cb47f0b89e622c6d81039535b333afa36b590d24a`) potwierdza invariant, wpływ frozen→free, Heun/RK4/RK23, all-frozen/no-mask parity i schedule materialization, all-frozen relaxation, stanowy ABM3 checkpoint/resume i mapowanie offsetów. CUDA device-resident multilayer v2 pozostaje jawnie `FAIL_CLOSED_UNQUALIFIED`. Wspólna clean-tree source identity i receipt P16 nadal nie są wykonane. |
| FDM CUDA FP64 single-grid | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Izolowany managed receipt `runs/4193247f-4b90-46fc-9ee9-33660acc572c/fdm-frozen-spins-cuda-runtime-evidence-v1.json` potwierdza Heun/RK4/RK23/DP45/ABM3, exact restore, checkpoint, accepted-step hot-rebuild, `source_snapshot_dirty=false` oraz RTX 4080 SUPER; snapshot ma SHA `c95d16bade0dd00e7ee6685b674d564805b7249b`, ale nie jest bieżącym clean-tree release |
| FDM CUDA FP32 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Ten sam managed run potwierdza pełną macierz FP32, zero-ULP restore i brak fallbacku; globalna kwalifikacja nadal wymaga wspólnego clean tree i P16 |
| FEM CPU/MFEM FP64 explicit/minimizer/TPI | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Explicit, PG-BB, NCG i TPI przechodzą wraz z bitwise restore i free-node mobility; brak clean-tree receiptu P16 |
| FEM GPU MFEM/hypre/libCEED/CUDA FP64 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Managed receipt potwierdza device-resident Heun/PG-BB/NCG, no fallback i zero hot-loop transfers; GPU TPI jawnie unsupported |
| API v2 + standard quantity FDM/FEM | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Katalog/metadata/payload i FEM serial-P1 authored preview respektują `ExplicitLocalToGlobal`, airbox, incydencję i fail-closed ownership. Finalny FEM CPU run potwierdził przez API i UI zgodność constraint ID, epoch 1, resolved-set revision 1, topology/mask/reference hashes oraz counts 124 frozen/0 free; standardowe quantity było `complete`, `spatial_scalar`, 1 component i renderable w lane `fem_cpu_native`. Managed receipts FDM CUDA i FEM GPU mają `interactive_hot_rebuild=PASS`: accepted-step, zachowane continuation, zwiększone epoch/revision, recapture reference oraz solver-owned quantity bez fallbacku. |
| Control Room + browser/WebGL FDM CPU | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Automatyczny receipt `frozen-spins-browser-2a185f77-03c7-4116-ab14-0728fceae6e7` potwierdza `Preview 384/0 → Commit → solve → certificate confirmed → q:frozen_spins`, epoch/set/source-state revision 1/1/1, zgodne mask/reference/topology identities, `complete` scalar field, FDM cuboid instance-colors z targetem colormap, HTTP v2 `/samples/vector`, ACK rendered, WebGL 703×478, brak context loss/degradacji i zero błędów konsoli. Dirty source blokuje `QUALIFIED`. |
| Control Room + browser/WebGL FEM serial P1 | `REQUIRED` | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Automatyczny receipt `frozen-spins-browser-77ee3ce1-9b78-4616-9afd-c35678936f07` potwierdza `Preview 124/0 → Commit → solve → certificate confirmed → q:frozen_spins`, epoch/set/source-state revision 1/1/1, mask/reference/topology identities, HTTP v2 payload, render ACK, WebGL 703×478, zero błędów konsoli oraz kompletny local-node scalar carrier, `fem-surface-vertex-colors` i `degradation=none`. `fullmag.fem-local-node-render.v1` pozostaje fail-closed poza serial P1; dirty source blokuje `QUALIFIED`. |

Aktualizacja 2026-08-31: po propagacji `source_state_revision` przez IR/API/CLI/planner ponowne pełne E2E zakończyły się `PASS`: FEM `frozen-spins-browser-77ee3ce1-9b78-4616-9afd-c35678936f07` oraz FDM `frozen-spins-browser-2a185f77-03c7-4116-ab14-0728fceae6e7`. Fail-closed agregat `preview-solver-parity/frozen-spins-preview-solver-parity-v1.json` potwierdza dla obu lane dokładny schema, solver-owned certificate, dodatnie i zgodne source-state revisions, mask/reference/topology identity i counts, standardowy scalar carrier, właściwy render path, `rendered` ACK oraz zdrowy WebGL 703×478. Zalicza `FS-P15-PREVIEW-SOLVER-PARITY`, ale pozostaje `UNQUALIFIED` bez clean-tree source identity.

Aktualizacja 2026-08-31 — managed FDM CUDA: przebieg `4193247f-4b90-46fc-9ee9-33660acc572c` zakończył wszystkie bramy receptury jako `PASS` (`gate_result=PASS`, `implementation_status=RUNTIME_CONFIRMED`). Receipt zawiera GPU identity (NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9), FP64/FP32, pięć integratorów, checkpoint, hot-rebuild, CPU↔CUDA parity (`max_abs_component_diff=1.1102230246251565e-16`, `max_normalized_error=2.220446049250313e-11`) oraz `source_snapshot_dirty=false`. `qualification_status` pozostaje `UNQUALIFIED`, ponieważ receipt pochodzi z izolowanego snapshotu i nie zamyka globalnej macierzy P15/P16.

Żadna komórka nie może zostać podniesiona przez samą zmianę tego dokumentu.
Awans wymaga wpisu: pełny commit SHA, dokładna komenda, wynik, urządzenie/runtime
identity, artefakt, workload i reviewer.

## P15 scientific cross-discretization runtime

| Case ID | `implementation_status` | `qualification_status` | `gate_result` | Dowód bieżący |
|---|---|---|---|---|
| `FS-P15-CROSS-DISCRETIZATION` | `RUNTIME_CONFIRMED` (reference FDM/FEM) | `UNQUALIFIED` | `PASS` | `crates/fullmag-runner/examples/frozen_spins_cross_discretization_runtime.rs` wykonuje 6/6 planów coarse/medium/fine przez produkcyjne `compile_fdm_frozen_spins`/`compile_fem_frozen_spins`, po jednym rzeczywistym kroku Heun FP64. Artefakt wejściowy: `artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-v1.json` (SHA-256 `6af022660566f0c9028b065be6784f8dae9158f2d8dc9316d2cff2ca844ca5f6`); niezależny walidator `scripts/build_frozen_spins_cross_discretization_runtime_evidence.py` zapisuje `frozen-spins-cross-discretization-runtime-evidence-v1.json` (SHA-256 `38cd65e050e7d4d30143351ffe95b5b4fb70112baac18ec7d0023aabe48ba3ba`) i sprawdza zero-ULP hard restore, free mobility, finite energy, brak fallbacku i per-step frozen transfer, refinements oraz parity obserwabli. `resolved_mask_sha256` jest dyskretyzacyjnie specyficzny i nie jest porównywany jako równość. Status pozostaje `UNQUALIFIED` do czasu managed native receiptu i clean source identity P16. |

Uruchomienie referencyjnego dowodu:

```text
cargo run -p fullmag-runner --example frozen_spins_cross_discretization_runtime -- --output artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-v1.json
python scripts/build_frozen_spins_cross_discretization_runtime_evidence.py --input artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-v1.json --output artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-evidence-v1.json
python -m unittest scripts.test_build_frozen_spins_cross_discretization_runtime_evidence scripts.test_build_frozen_spins_cross_discretization_evidence
```

Ten dowód zamyka wykonanie naukowego case ID, ale nie promuje żadnego lane do
`QUALIFIED`: do tego potrzebne są właściwe managed binary, urządzenie/runtime,
source snapshot i immutable receipt związane z tym samym clean tree.

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

## Stan infrastruktury dowodowej 2026-08-31

| Element | `implementation_status` | `qualification_status` | `gate_result` | Dowód bieżący |
|---|---|---|---|---|
| P0 scope ledger | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | 28 funkcji `REQUIRED`, 1 jawnie `OUT_OF_SCOPE`; rewizja 2 koduje także 13 obowiązkowych bramek naukowych P15, a walidator i 5 testów negatywnych/dodatnich przechodzą |
| Authoring IR/Python | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | `verify_frozen_spins_authoring.py` przechodzi i jawnie nie deklaruje runtime qualification |
| Agregator receiptów | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `PASS` | 6 testów: kompletne pokrycie, brak receiptów, dirty/fallback/SKIP/unknown driver/bad hash, mixed tree/duplicate evidence ID, source binding i append-only ledger |
| Finalny zestaw receiptów | `SOURCE_CONFIRMED` | `UNQUALIFIED` | `NOT_RUN` | Agregator i ledger są zaimplementowane, ale w bieżącym checkoutcie brak zatwierdzonego `source-baseline.json` oraz wspólnego katalogu receiptów; stan wynosi 0/60 ważnych case ID |
| FDM CUDA runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Izolowany receipt `fdm-cuda/runs/4193247f-4b90-46fc-9ee9-33660acc572c/fdm-frozen-spins-cuda-runtime-evidence-v1.json`: FP64+FP32, pięć integratorów, max frozen defect 0, checkpoint PASS, realne GPU, clean source identity w snapshotcie; nie jest to jeszcze P16 |
| FEM GPU runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | `fem-frozen-spins-gpu-runtime-evidence-v1.json`: MFEM 4.9/Hypre 3.1.0, Heun/PG-BB/NCG, no fallback, transfer audit 0; dirty source |
| FEM CPU runtime | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Explicit, PG-BB, NCG i TPI wykonane; brak finalnego receiptu przypisanego do clean tree |
| P5 activation lifecycle FDM | `RUNTIME_CONFIRMED` (CPU persistent runtime) | `UNQUALIFIED` | `PASS` | Jawna reaktywacja zwiększa per-constraint epoch/set revision, przechwytuje nową referencję przy tej samej masce i unieważnia FSAL/ABM; A→inactive→C usuwa maskę w B, zachowuje historię i nadaje epoch 2 w C; błąd zachowuje poprzedni stan. Persistent CPU runtime stosuje stage plan bez rebuild, a API `solver/status.frozen_spins` publikuje solver-owned epochs/revision/hashes/counts przez wersjonowany bridge. Preview/commit są jawnie spekulatywne; Inspector potwierdza certificate po ID/epoch/revisions/hash/counts, kieruje 3D do solver-owned quantity i pokazuje pending revision bez in-place claim. Safe-step consumption i wznowienie z zachowaniem budżetu mają celowane testy `PASS`; Inspector 14/14, OpenAPI, typecheck oraz kompilacja API+CLI również `PASS`. Naprawiono kolejność native FEM: continuation magnetization jest materializowana w planie aktywacyjnym przed konstrukcją backendu, więc `CaptureCurrentAtActivation` nie wiąże już authored initial state; regresja 1/1 `PASS`. Managed FDM CUDA i FEM GPU potwierdzają hot-rebuild/hot-apply; pełny runner ma 1007/1024 `PASS` oraz 17 niezależnych błędów dirty tree, które nie są promowane do release. |
| API/Control Room quantity i authoring activation | `RUNTIME_CONFIRMED` | `UNQUALIFIED` | `PASS` | Pełne workflow browserowe `create → Preview → Commit → solve → confirmed certificate → solver-owned quantity 3D` przeszły automatycznie dla FEM CPU (124/0) i FDM CPU (384/0). Naprawiono kontrakty `field_revision` i `source_state_revision`, jednoobiektowy FDM membership default-region oraz scalar registry colormap. Testy regresyjne UI/Rust, typecheck/static build i oba trwałe JSON/PNG przechodzą. Managed FDM CPU scientific evidence, CPU↔CUDA parity, fail-closed Preview↔Solver evidence oraz referencyjny runtime cross-discretization/refinement 6/6 są dostępne; global performance/transfer, managed cross-lane receipt i clean-tree P16 nadal są wymagane. |

`just verify-frozen-spins-qualification` jest bramką fail-closed. Najpierw
waliduje P0 i authoring oraz własne testy agregatora, a następnie kończy się
niezerowym kodem, dopóki trwały katalog
`artifacts/qualification/frozen-spins/receipts` nie zawiera poprawnych receiptów
pokrywających wszystkie 60 obowiązkowych test case IDs na jednym clean tree.
