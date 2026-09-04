# Projekt receiptu v2 i snapshotu v3 dla FEM GPU NCG

- Data: 2026-09-04
- Status: projekt zatwierdzony koncepcyjnie; oczekuje przeglądu spisanej wersji
- Gałąź: `codex/fem-gpu-tasks1-5-remediation`
- Rewizja wejściowa: `cd8046a0d1666c521fb477e300b435281e17d66a`
- Lane: FEM GPU, strict device, double
- Pierwszy algorytm: `nonlinear_cg`
- ADR: `docs/adr/0030-fem-gpu-direct-minimizer-execution-evidence.md`
- Dokument nadrzędny programu:
  `docs/superpowers/specs/2026-09-02-fem-gpu-full-potential-design.md`

## 1. Cel

Celem jest usunięcie blokera Tasku 3 bez zmiany badanego algorytmu. Publiczny
run NCG ma dostarczyć natywny, fail-closed dowód, że dokładny direct minimizer
wykonał wymagane operatory na GPU, nie wykonał cichego fallbacku, zachował
transakcyjny lifecycle wszystkich kandydatów Armijo i opublikował kompletny
snapshot wykonanej pracy.

Projekt nie jest sam w sobie dowodem przyspieszenia. Task 3 zachowuje status
`NOT VERIFIED`, dopóki ta sama source identity nie przejdzie managed CUDA,
parity, dokładnie pięciu powtórzeń baseline'u i pełnego capture Nsight.

## 2. Stan wejściowy i potwierdzone luki

Na rewizji wejściowej:

1. `dispatch.rs` żąda receiptu tylko, gdy nie wybrano direct minimizera.
2. Receipt ABI v1 identyfikuje integrator RK, lecz nie execution kind ani NCG.
3. Performance snapshot v2 publikuje tylko zaakceptowane setup/apply/fence/time.
4. Bogatszy snapshot v1 istnieje, ale nie jest konsumowany przez końcowy
   artifact Tasku 3 i NCG nie otwiera jego attempt lifecycle.
5. NCG nie emituje żadnych zdarzeń execution receipt.
6. Reject/fail receiptu czyści transient maski, fallback i transfery bez
   terminalnego transfer update i monotonicznego latching'u.
7. Control-scalar D2H i stream synchronization są liczone poza compute gate,
   lecz receipt nie publikuje jawnej control policy ani budżetu.
8. Exchange interop może być wyłączony z compute violation i nie trafia do
   receipt v1.
9. Brak alokacji GPU może formalnie skierować direct minimizer do CPU.
10. `accepted_step_count == 0` jest mapowane na `executed=none`, nawet gdy
    wykonano poprawną terminalną obserwację.
11. Snapshot v2 nie jest związany generation ID z receiptem.
12. Runner pobiera snapshot przed terminalnymi snapshotami pól i przed
    zakończeniem artifact pipeline.
13. `backtracks` mierzy redukcje kroku, nie zawsze dokładną liczbę odrzuconych
    kandydatów.
14. Benchmark akceptuje co najmniej pięć rekordów zamiast dokładnych indeksów
    powtórzeń `0..4`.
15. Nsight nie wymaga końcowego snapshotu ani jego identity binding.

### 2.1 Mapa dowodów źródłowych

| Obszar | Ścieżka i symbol |
|---|---|
| Warunek żądania receiptu | `crates/fullmag-runner/src/dispatch.rs` — `requires_gpu_rk_execution_receipt` |
| Kolejność finalizacji | `crates/fullmag-runner/src/fem/relax/finalize.rs` — `finalize_native_fem_relaxation` |
| Mapowanie v1/v2 | `crates/fullmag-runner/src/native_fem/runtime_info.rs` — `NativeFemGpuExecutionReceipt::from_ffi`, `NativeFemGpuPerformanceSnapshot::from_ffi` |
| Layouty ABI | `native/include/fullmag_fem.h` — `fullmag_fem_gpu_execution_receipt_v1`, `fullmag_fem_gpu_performance_snapshot_v1`, `fullmag_fem_gpu_performance_snapshot_v2` |
| Receipt lifecycle | `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` — `gpu_execution_receipt_*` |
| Physical/accepted work | `backends/fem/gpu/cuda/runtime/performance_counters.cpp` — `gpu_performance_*` |
| Transfer categories | `backends/fem/gpu/cuda/transfer/transfer_audit.cpp` — `record_*` |
| Routing NCG/CPU fallback | `backends/fem/cpu/mfem/runtime/backend_step.cpp` — `run_backend_relaxation_step` |
| CUDA NCG i Armijo | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` — `gpu_relax_nonlinear_cg_step` |
| Walidator benchmarku | `scripts/analysis/fem_gpu_benchmark.py` — `collect_case` |

## 3. Granice własności

### 3.1 Natywny backend

`backends/fem` jest właścicielem:

- rozwiązania execution plan i wymaganych operator masks;
- outer/candidate lifecycle;
- rezydencji, transfer auditu i violation latches;
- NCG, Armijo, direct energy, demag, exchange i preconditionera;
- liczników physical/accepted oraz natywnego performance snapshotu;
- natywnych terminalnych snapshot/export-to-host boundaries.

Stan pozostaje we właściwych subsystemach:

- execution identity i lifecycle w
  `backends/fem/gpu/cuda/runtime/execution_receipt.*`;
- praca physical/accepted w
  `backends/fem/gpu/cuda/runtime/performance_counters.*`;
- kategorie transferów w
  `backends/fem/gpu/cuda/transfer/transfer_audit.*`;
- algorytm w `backends/fem/gpu/cuda/relaxation/*`.

Nie dodajemy solver logic do `Context`, `mfem_bridge.cpp` ani Rust runnera.
Istniejące subsystem state może pozostać zagnieżdżone w GPU state; nie tworzymy
nowego globalnego właściciela dublującego te dane.

### 3.2 Rust runner

Runner jest właścicielem:

- wybrania właściwej wersji ABI na podstawie resolved capability;
- mapowania natywnych enumów i fail-closed odrzucenia nieznanych wartości;
- runtime i performance validatorów;
- zachowania terminalnego `RunStatus`;
- publikacji JSON, SHA-256, flush status i immutable binding;
- benchmarkowego i session provenance.

Runner nie wyznacza operator masks, nie interpretuje Armijo i nie prowadzi
drugiej maszyny numerycznej NCG.

### 3.3 Benchmark i Nsight

Benchmark weryfikuje końcowe artefakty oraz porównywalność workloadu. Nsight
jest niezależnym dowodem pokrycia instrumentacji i kolejności transferów. Żaden
z nich nie zastępuje runtime receipt, parity ani physics validation.

## 4. Wersjonowanie ABI

### 4.1 Zasady ogólne

- Każda nowa struktura ma osobny `abi_version`, `struct_size` i symbol.
- Stare struktury nie otrzymują pól, nowych wartości o zmienionym znaczeniu ani
  zapisu poza dotychczasowy `struct_size`.
- Rust ma osobne `#[repr(C)]` i testy `size_of`, `align_of`, `offset_of` oraz
  dostępności symbolu.
- Nieznany enum, bit, rozmiar albo wersja powoduje fail-closed.
- Nowe C ABI używa enumów liczbowych; tekst powstaje dopiero w Rust/JSON.

### 4.2 Receipt v1

Receipt v1 pozostaje projekcją RK. Dla direct minimizera endpoint v1 zwraca
`FULLMAG_FEM_ERR_UNAVAILABLE`. Nie wstawia `integrator=heun` ani innej
wartości zastępczej.

### 4.3 Receipt v2

Receipt v2 zachowuje pola v1 jako zamrożony prefiks. Dla
`execution_kind=direct_minimizer` prefiksowe `integrator` ma wartość zero i nie
jest interpretowane. Tail v2 jest jedynym źródłem identity direct minimizera.

Minimalna kolejność logiczna tailu:

| Grupa | Pola |
|---|---|
| Identity | `execution_kind`, `relaxation_algorithm`, `attempt_model`, `control_policy` |
| Generation | `execution_generation_id` |
| Terminal | `terminal_outcome`, `compute_closed`, `observation_closed` |
| Attempts | `outer_attempt_count`, `rejected_candidate_count`, `failed_candidate_count`, `stationary_observation_count`, `cancelled_outer_attempt_count`, `paused_outer_attempt_count`, `refinement_evaluation_count`; prefiks zachowuje accepted/rejected/failed outer-attempt counters |
| Transfer policy | `allowed_transfer_mask`, `observed_transfer_mask`, `transfer_violation_mask` |
| Transfer counters | setup, compute, control, exchange, snapshot i native-export H2D/D2H/host-sync |
| Residency | initial/final residency, transition count, violation count |
| Coverage | required/resolved/executed operator masks, per-family apply counts lub coverage digest |
| Validity | `accounting_valid`, `lifecycle_valid`, `identity_valid` |

Pola prefiksu v1 oraz tailu v2 muszą być zgodne. Różnica między ich wspólnymi
licznikami/maskami jest błędem ABI projection, nie wyborem nowszej wartości.

### 4.4 Stabilne enumy v2

Pierwszy rejestr wartości:

```text
execution_kind:
  unknown = 0
  rk_time_integrator = 1
  direct_minimizer = 2

relaxation_algorithm:
  none = 0
  nonlinear_cg = 1
  projected_gradient_bb = 2

attempt_model:
  unknown = 0
  rk_candidate = 1
  outer_step_with_armijo_candidates = 2

control_policy:
  unknown = 0
  device_control = 1
  bounded_host_scalar_control = 2

terminal_outcome:
  none = 0
  completed_accepted = 1
  completed_observation = 2
  cancelled = 3
  paused = 4
  failed = 5
```

PG-BB ma zarezerwowaną identity, ale pierwszy rollout nie ogłasza dla niego
receipt capability.

### 4.5 Granice generation

Nowe, addytywne wywołania lifecycle to:

```c
int fullmag_fem_backend_gpu_execution_begin_v2(
    fullmag_fem_backend *handle,
    uint64_t *out_execution_generation_id);

int fullmag_fem_backend_gpu_execution_close_compute_v2(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_terminal_outcome_v2 terminal_outcome);

int fullmag_fem_backend_gpu_execution_close_observation_v2(
    fullmag_fem_backend *handle);
```

`begin_v2` jest wywoływane po skonfigurowaniu backendu, lecz przed pierwszym
krokiem etapu. Zeruje wyłącznie dane nowej generation i zwraca niezerowy,
monotoniczny ID właściciela natywnego. Nie przyjmuje masek ani nie pozwala
runnerowi zadeklarować wykonanych operatorów.

`close_compute_v2` przyjmuje terminalny wynik orkiestracji, zamyka aktywny
outer attempt fail-closed i zamraża liczniki compute. Backend odrzuca wynik
sprzeczny z własnym candidate lifecycle. `close_observation_v2` jest legalne
dopiero po zakończeniu natywnych snapshotów i export-to-host. Każde wywołanie
powtórzone albo w złej kolejności ustawia sticky lifecycle violation.

Zwykły run, który nie żąda nowej capability, może nadal używać starych
endpointów. Kwalifikujący strict NCG wymaga pełnego lifecycle v2 i nie może
inicjalizować generation leniwie po pierwszym kroku.

### 4.6 Operator masks v2

Istniejące bity exchange, demag, local fields, direct torques, LLG RHS, RK i
reductions zachowują wartości. Nowe, addytywne bity obejmują co najmniej:

```text
DIRECT_MINIMIZER
NONLINEAR_CG_UPDATE
RETRACTION
LINE_SEARCH
ARMIJO_ENERGY
DIRECT_ENERGY_REFINEMENT
```

`PRECONDITIONER` jest wymagany tylko wtedy, gdy resolved NCG realization
faktycznie go używa. Nie wolno wymagać go bezwarunkowo ani ukrywać jego użycia.

Required mask wynika z planu i aktywnej fizyki. Jeden ustawiony bit nie dowodzi
pokrycia wszystkich wywołań rodziny; v3 dodaje apply counters/coverage mask, a
Nsight sprawdza niezinstrumentowane luki.

## 5. Model lifecycle

### 5.1 Stage-level state

Maszyna stanów ma następujące granice:

```text
Unconfigured
  -> PlanResolved
  -> OuterAttemptActive <-> PlanResolved
  -> ComputeClosed
  -> ObservationClosed
  -> PerformanceSnapshotFrozen
```

Każdy zaakceptowany outer attempt wraca do `PlanResolved`, zachowując
monotoniczne liczniki i latches. `ComputeClosed` zamyka wykonywanie algorytmu,
`ObservationClosed` zamyka natywne terminalne snapshot/export-to-host, a
`PerformanceSnapshotFrozen` udostępnia niezmienny v3.

Niepoprawne przejście ustawia sticky `lifecycle_valid=false`. Ponowne
`resolve_plan` w tej samej generacji nie naprawia błędu.

### 5.2 Outer attempt

Outer attempt zaczyna się w `run_backend_relaxation_step()` po rozstrzygnięciu
strict GPU planu i przed pierwszym current-state evaluation. Obejmuje:

- sprawdzenie rezydencji i backup;
- current-state field/energy/gradient;
- przygotowanie albo restart kierunku;
- wszystkich kandydatów Armijo;
- refinement;
- accepted finalization albo pełny rollback;
- końcowy transfer snapshot.

Outer attempt kończy się dokładnie jednym wynikiem:

- `accepted`;
- `completed_observation`;
- `cancelled`;
- `paused`;
- `failed`.

### 5.3 Candidate lifecycle

Każdy oceniony `trial_step` emituje:

```text
candidate_begin
candidate_rejected | candidate_accepted | candidate_failed
optional candidate_refined
```

Refinement tego samego trial state zwiększa
`refinement_evaluation_count`, ale nie tworzy nowego kandydata. Restart NCG
rozpoczyna nową serię kandydatów wewnątrz tego samego outer attempt.

`rejected_candidate_count` zwiększa się w punkcie decyzji o odrzuceniu, nie
przez kopiowanie `backtracks`. Pole `backtracks` może pozostać kompatybilną
metryką redukcji kroku w step stats.

### 5.4 Terminalne no-op

Torque confirmation, `gradient_norm_sq == 0` i
`representability_stationary`:

- nie zwiększają `accepted_step_count`;
- zwiększają `stationary_observation_count`;
- ustawiają `terminal_outcome=completed_observation`, jeśli zamykają stage;
- zachowują `executed=cuda_fem`, ponieważ praca faktycznie się odbyła;
- nie tworzą kwalifikującego performance artifact.

### 5.5 Reject, failure, cancel i pause

Każda terminalna ścieżka outer attempt wykonuje kolejno:

1. zamknięcie aktywnego transfer scope;
2. finalny monotoniczny transfer snapshot;
3. latching host/unknown/fallback/transfer/residency violations;
4. agregację physical work;
5. rollback stanu numerycznego, jeśli wymagany;
6. zapis terminal outcome;
7. wyczyszczenie transient candidate/attempt state.

Destruktor guardu wykonuje ten sam fail-closed abort i nie może ominąć kroków
1–4.

## 6. Performance snapshot v3

### 6.1 Źródła danych

V3 jest spójnym odczytem jednej generation z trzech obecnych subsystemów.
Query blokuje albo wykonuje ordered snapshot tak, aby nie łączyć danych z
różnych attemptów.

Nie wolno:

- przepisywać liczników v1 do nowej, niezależnej maszyny;
- wyprowadzać physical work z wall time albo logs;
- pobierać identity z runner metadata;
- zerować rejected/failed physical work przy zaakceptowanym kroku.

### 6.2 Prefiks v2

Pierwsze 88 bajtów v3 zachowuje layout snapshotu v2. Ich znaczenie pozostaje:

- `setup_count` i `apply_count`: zaakceptowane outer steps;
- `kernel_launch_count`: wyłącznie zinstrumentowane launch sites;
- `compute_fence_count`: zabronione compute fences;
- `snapshot_fence_count`: natywne terminalne snapshot fences;
- `export_fence_count`: natywne device-to-host export fences, nie zapis pliku;
- `selected_sparse_kernel_id`: ostatni kwalifikujący wybór;
- czasy setup/apply/accepted finalization dla zaakceptowanej pracy.

### 6.3 Tail v3

Tail zawiera co najmniej:

| Grupa | Pola/znaczenie |
|---|---|
| Identity | execution kind, algorithm, attempt model, control policy, terminal outcome |
| Binding | `execution_generation_id`, wspólny z receiptem v2 |
| Availability | available, compute closed, observation closed, frozen |
| Attempts | accepted steps, physical outer attempts, rejected/failed candidates, failed/cancelled/paused outer attempts, stationary observations, refinements |
| Physical work | effective-field applies, energy evaluations, Armijo candidates, RHS evaluations, exchange applies/launches/NNZ, demag solves/iterations, normalization, reductions, endpoint cache |
| Accepted work | analogiczne liczniki zaakceptowanej logical-step work |
| Memory | D2D, setup/compute/control/exchange/snapshot/native-export H2D/D2H bytes |
| Fences | compute, control, exchange, snapshot, native export host-sync/fence counts |
| Coverage | kernel launch coverage mask, required coverage mask, unclassified event count |
| Residency | initial/final residency, transitions i violations |
| Timings | istniejące czasy v1/v2 oraz NCG gradient/retraction/line-search/update/refinement |

`physical_*` obejmuje accepted, rejected i failed work. `accepted_*` obejmuje
całą pracę należącą do zaakceptowanego logical step, w tym jego wcześniejsze
odrzucone kandydaty. Zależności monotoniczne są walidowane, np.
`accepted_* <= physical_*`.

### 6.4 Kernel coverage

Pierwsza implementacja nie twierdzi, że licznik launchy obejmuje kernele
wewnętrzne HYPRE. `kernel_launch_coverage_mask` deklaruje zinstrumentowane
rodziny:

```text
exchange
demag_rhs
hypre_solve_boundary
demag_recovery
local_fields
gradient
retraction
direct_energy
reductions
direction_update
normalization
```

Brak required coverage albo `unclassified_event_count > 0` blokuje
kwalifikację. Nsight pozostaje niezależnym dowodem pokrycia.

## 7. Transfer i fence policy

### 7.1 Kategorie

Transfer audit otrzymuje stabilne kategorie:

```text
SETUP
COMPUTE
CONTROL_SCALAR
EXCHANGE_INTEROP
SNAPSHOT
NATIVE_EXPORT
UNKNOWN
```

Każda operacja zwiększa observed mask i odpowiednie monotoniczne liczniki.
Operacja niedozwolona przez `allowed_transfer_mask` zwiększa violation mask i
pozostaje zalatchowana do końca generation.

### 7.2 Strict NCG policy

Dozwolone:

- setup H2D przed hot loopem;
- D2D w dowolnej fazie, z pełnym raportowaniem;
- control-scalar D2H/sync w wyliczonym budżecie;
- snapshot/native-export D2H po `ComputeClosed`.

Zabronione:

- compute H2D/D2H/host-sync;
- wszystkie exchange interop H2D/D2H/host-sync;
- snapshot/export podczas aktywnego outer attempt;
- unknown transfer/sync;
- host physics/operator i CPU solver fallback.

### 7.3 Budżet control plane

Budżet nie jest stałą arbitralną. Walidator wyprowadza limit z wersjonowanej
formuły zależnej od:

- physical outer attempts;
- physical Armijo candidates;
- refinement evaluations;
- restart/recovery cycles;
- accepted finalization count;
- stationary observations.

Dokładna formuła i wersja budżetu zostaną zamrożone w implementacyjnym planie
po zinwentaryzowaniu wszystkich call sites readbacku. Fixture może zawierać
mniejszą liczbę, ale przekroczenie górnego limitu zawsze blokuje performance
qualification.

## 8. Plan i routing NCG

### 8.1 Capability-driven request

Runner zastępuje RK-centryczne
`requires_gpu_rk_execution_receipt` decyzją wynikającą z:

- resolved engine `fem_native_gpu`;
- execution mode;
- resolved relaxation algorithm;
- wersjonowanej native receipt capability.

Runner przekazuje request i oczekiwaną identity, ale nie buduje operator masks.

### 8.2 Native plan

NCG otrzymuje neutralny execution plan. Może współdzielić device-resident
effective-field plan z RK, lecz nie ustawia bitów `LLG_RHS` lub `RK_STEPPER`
tylko dlatego, że używa helperów o historycznej nazwie `gpu_rk_*`.

Wymagane maski NCG wynikają z:

- direct minimizer core;
- NCG update;
- retraction i line search;
- Armijo/direct energy;
- aktywnych interaction operators;
- reductions;
- preconditionera tylko wtedy, gdy resolved realization go używa.

### 8.3 Fail-closed allocation

Jeśli request jest explicit/strict GPU i `device.lifecycle.allocated == false`,
`run_backend_relaxation_step()` zwraca `UNAVAILABLE` przed
`run_native_relaxation_step()`. Powód trafia do terminal receipt/failure
provenance. CPU fallback jest dopuszczalny wyłącznie przed wykonaniem dla
udokumentowanego non-forced planner mode i musi mieć osobne requested/resolved
provenance.

## 9. Runner, statusy i artefakty

### 9.1 Rust mapping

Nowe typy Rust zachowują natywne pola bez utraty informacji. `executed`
wynika z execution kind, terminal outcome i rzeczywistego execution evidence,
nie z samego `accepted_step_count`.

Nieznany enum, bit, generation zero po rozpoczęciu albo niespójny prefiks/tail
powoduje błąd mapowania.

### 9.2 Runtime validator

Sprawdza:

- oczekiwaną identity i generation;
- plan resolved i lifecycle valid;
- pełne required/resolved/executed masks;
- brak host/unknown/fallback;
- dozwolone transfer masks i monotoniczne violation latches;
- terminal outcome zgodny z runner status;
- poprawność zero-step observation.

Nie wymaga zaakceptowanego kroku dla cancelled, paused ani completed
observation.

### 9.3 Performance validator

Sprawdza dodatkowo:

- `RunStatus::Completed`;
- `terminal_outcome=completed_accepted`;
- `accepted_step_count > 0`;
- snapshot schema v3 i `frozen=true`;
- ten sam niezerowy `execution_generation_id` w receipcie i snapshocie;
- physical/accepted monotonicity;
- compute/exchange/unknown violations równe zero;
- control counters w wersjonowanym budżecie;
- wymagane coverage;
- publication receipt i zgodne digests.

### 9.4 Artefakty

Kwalifikujący run publikuje:

```text
performance/fem_gpu_execution_receipt.v2.json
performance/fem_gpu_performance_snapshot.v3.json
performance/fem_gpu_performance_publication.v1.json
```

Publication receipt zawiera:

- SHA-256 dwóch pierwszych plików;
- source snapshot SHA-256;
- ProblemIR digest;
- mesh/topology digest;
- runtime bundle digest;
- GPU UUID, driver i toolkit identity;
- `execution_generation_id`;
- status atomowego zapisu i flush;
- runner publication wall time;
- manifest/bundle reference bez samoreferencyjnego hasha.

Brak któregokolwiek pliku, hash mismatch albo dane wyłącznie w metadata/stdout
oznaczają `NOT VERIFIED`.

### 9.5 Kolejność finalizacji

Docelowa kolejność:

1. zamknąć compute i pobrać runtime receipt v2;
2. zwalidować runtime receipt bez performance eligibility;
3. wykonać terminal preview drain i wymagane fresh snapshots;
4. zamknąć native observation/export-to-host phase;
5. pobrać zamrożony snapshot v3;
6. wykonać performance validation dla kwalifikującego statusu;
7. zakończyć artifact pipeline i zapisać receipt/snapshot;
8. atomowo zapisać publication receipt z hashami gotowych plików;
9. dopiero wtedy udostępnić run jako posiadający kwalifikujący performance
   evidence.

Zapis publication receipt nie jest liczony w natywnym v3. Jego własny status i
czas są polami publication receipt.

## 10. Benchmark

Task 3 zachowuje:

- `--relax-algorithms nonlinear_cg`;
- kwalifikujący scenariusz airbox;
- 64 kroki;
- dokładnie pięć zmierzonych powtórzeń po warm-upie.

Walidator wymaga dokładnie indeksów powtórzeń `0,1,2,3,4` dla tego samego:

- source snapshot;
- ProblemIR i mesh/topology digest;
- runtime bundle;
- device UUID, driver/toolkit;
- precision i algorithm identity;
- tolerancji i stop criteria;
- output policy.

Każdy rekord wymaga trzech końcowych artefaktów i zgodnych hashy/generation.
Jedno niekwalifikujące powtórzenie blokuje p50/p95; nie jest pomijane.

Pięć powtórzeń nie jest wykonywane pod Nsight. Capture profilujący jest osobnym
pojedynczym runem o tej samej identity.

## 11. Nsight

Capture wymaga uporządkowanych faz:

```text
plan/setup
outer attempt
current evaluation
Armijo candidate(s)
accepted finalization lub terminal observation
compute close
terminal snapshot/native export
snapshot freeze
runner publication
```

Raport porównuje CUDA API, memcpy/sync i NVTX z:

- receipt generation;
- algorithm identity;
- required/observed transfer masks;
- control budget;
- snapshot coverage mask.

Nieznany H2D/D2H/sync, brak fazy albo połączenie danych z dwóch niezgodnych
przebiegów daje `NOT VERIFIED`. Dwa osobne capture'y compute/host mogą pozostać
diagnostyczne, lecz kwalifikujący report musi wykazać spójność source/workload
identity i nie może udawać jednego timeline'u.

## 12. TDD i bramy

### G1 — source i ABI

RED/GREEN obejmuje:

- zachowanie starych layoutów i symboli;
- nowe layouty i symbole;
- nieznane enumy/bity/rozmiary;
- NCG identity;
- brak fałszywego integratora RK;
- binding przez jeden `execution_generation_id`;
- outer/candidate lifecycle;
- monotoniczne latches na reject/fail/abort;
- stationary zero-step;
- fail-closed brak alokacji GPU.

Dowód G1 nie jest runtime proof.

### G2 — runner i artefakty

- strict NCG żąda v2/v3;
- runtime i performance validator są oddzielne;
- status cancelled/paused/failed nie jest maskowany;
- snapshot v2, metadata i stdout nie kwalifikują NCG;
- finalization zachowuje kolejność z sekcji 9.5;
- publication hashes i generation mismatch failują.

### G3 — managed CUDA

- rzeczywisty NCG na wskazanym GPU;
- prawidłowe device/runtime identity;
- receipt v2 i snapshot v3;
- zero CPU fallback;
- fault injection host/unknown/fallback/compute/exchange/control/identity.

### G4 — terminal outcomes

Osobne uruchomienia:

- completed accepted;
- completed stationary;
- cancelled;
- paused;
- failed przed i po Armijo acceptance.

Tylko pierwszy może publikować kwalifikujący performance artifact.

### G5 — parity i physics

CPU NCG i GPU NCG używają identycznego ProblemIR, mesha, parametrów, stop
criteria i double precision. Porównanie obejmuje stan, energię, torque,
accepted Armijo proof, stop reason i artefakty. Receipt nie zastępuje parity.

### G6 — performance i Nsight

- dokładnie pięć powtórzeń;
- p50/p95 całości i faz;
- CPU oracle;
- wszystkie końcowe receipt/snapshot/publication artifacts;
- pełny ordered capture Nsight;
- brak niesklasyfikowanych transferów/synchronizacji.

Dopiero G6 pozwala zmienić status Tasku 3 z `NOT VERIFIED`.

## 13. Dokumentacja wymagająca aktualizacji przy implementacji

Przed zmianą natywnego zachowania należy zaktualizować:

- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`;
- `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`;
- `docs/physics/0560-all-in-gpu-fem-runtime.md`;
- właściwe fragmenty `docs/physics/0900-native-fem-operator-contracts-and-validation.md`;
- `docs/architecture/backend-golden-masterplan.md`;
- `docs/specs/native-fem-backend-architecture-v1.md`;
- `docs/specs/capability-matrix-v0.md` i `.json`;
- pakiet `docs/performance/fem-gpu-performance-remediation-2026-09-01`;
- nadrzędny projekt pełnego potencjału FEM GPU.

Physics notes zachowują równania i SI bez zmian, lecz dopisują wykonawczą
identity NCG, bounded scalar control, terminal outcomes i drabinę dowodów.
Każda zmieniona terminalna nota musi zachować source map i przejść walidator
scientific documentation contract.

## 14. Non-goals

Pierwszy rollout nie obejmuje:

- zmiany równań, energii, Armijo lub PR+;
- nowego Python API albo pola ProblemIR;
- kwalifikacji PG-BB;
- przeniesienia control policy w całości na urządzenie;
- eliminacji wszystkich dozwolonych readbacków skalarnych;
- FP32;
- zmiany tolerancji, mesha albo output fidelity dla wyniku performance;
- promocji capability na podstawie source tests;
- ogólnego refaktoru `dispatch.rs`, `Context` albo artifact pipeline poza
  granicami wymaganymi przez ten kontrakt.

## 15. Kryteria akceptacji implementacji

Kwalifikujący Task 3 wymaga jednocześnie:

```text
RunStatus                         = Completed
terminal_outcome                  = completed_accepted
execution_kind                    = direct_minimizer
relaxation_algorithm              = nonlinear_cg
attempt_model                     = outer_step_with_armijo_candidates
execution_class                   = device_resident
control_policy                    = bounded_host_scalar_control
accepted_step_count               > 0
fallback_count                    = 0
host_operator_mask                = 0
unknown_operator_mask             = 0
compute H2D/D2H/sync              = 0
exchange interop H2D/D2H/sync     = 0
unknown transfers/sync            = 0
control transfers/fences          = jawne i w budżecie
receipt/snapshot/publication ID   = ten sam execution_generation_id
snapshot schema                   = v3
publication hashes                = zgodne
repeat indexes                    = dokładnie 0..4
```

oraz przejścia source/ABI, managed runtime, terminal outcomes, parity, physics,
pięciokrotnego benchmarku i Nsight jako osobnych bram.

## 16. Kryteria rollbacku

Nowa ścieżka nie jest promowana albo zostaje wyłączona, gdy:

- nie można zachować starego ABI;
- receipt, snapshot i publikacja nie dają się związać jednym ID bez zgadywania;
- strict NCG wymaga CPU/operator fallbacku;
- violation latches nie obejmują rejected/failed work;
- control budget nie daje się wyprowadzić ze wszystkich call sites;
- terminal status zostaje zamaskowany przez performance validator;
- snapshot wymaga przeniesienia artifact ownership do backendu;
- parity/physics failuje;
- p50/p95 nie poprawia się albo Nsight ujawnia niesklasyfikowane koszty.

Rollback nie zmienia workloadu na RK, nie obniża tolerancji i nie publikuje
niepełnego v2 jako dowodu NCG.
