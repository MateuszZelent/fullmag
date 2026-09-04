<!-- GENERATED FROM fem-gpu-performance-remediation-2026-09-01/*.md; edit source files, then regenerate. -->

> Wersja scalona. Kanoniczne pliki źródłowe znajdują się w podkatalogu `fem-gpu-performance-remediation-2026-09-01/`.

<!-- BEGIN README.md -->

# Plan naprawczy wydajności FEM GPU

- **Status:** skorygowany po audycie źródłowym `HEAD`; plan implementacyjny, nie
  dowód wydajności ani kwalifikacja produkcyjna.
- **Repozytorium:** `MateuszZelent/fullmag`
- **Gałąź dokumentacyjna pochodzenia:** `docs/fem-gpu-performance-remediation-2026-09-01`
- **Rewizja bazowa planu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`
- **Rewizja pierwotnego audytu:** `7faa259c5597ba447c413f2aea0ff66d6110b297`
- **Rewizja weryfikacji kodu:** `c3f49db708868f3649a3e894416d230269718920`
- **Data:** 2026-09-01
- **Lane:** natywny FEM GPU, MFEM 4.9, HYPRE 3.1.0, CUDA.
- **Przypadek referencyjny:** µMAG SP4 FEM, `mixed_p1`, `layers=1`, `mesh=medium`,
  `airbox=baseline`, `device=gpu`, double precision.

## 0. Zakres i status dowodów

Pakiet został ponownie sprawdzony względem kodu, testów kontraktowych i
`justfile`. Nie uruchomiono aktualnego managed runtime na GPU, dlatego wyniki
wydajności, parytet urządzenia i kwalifikacja naukowa pozostają `NOT VERIFIED`.
Szczegółowy werdykt dla każdego ID znajduje się w
[10-finding-coverage-matrix.md](fem-gpu-performance-remediation-2026-09-01/10-finding-coverage-matrix.md).

Korekta RL-01 z 2026-09-04: bieżąca klasa
`GpuDiagonalRelaxationPreconditioner` realizuje tylko nieaktywną aproksymację
diagonalną/Jacobiego. Pełny sparse
`exchange_mass_cg4|cg8` jest zatwierdzonym projektem, ale jego capability,
runtime, CPU/GPU parity, physics validation i performance pozostają
`NOT VERIFIED`. Domyślna strategia pozostaje `none`.

Stosowane statusy:

- `POTWIERDZONE` — diagnoza wynika bezpośrednio z aktualnego kodu;
- `CZĘŚCIOWO` — część mechanizmu już istnieje albo teza wymaga zawężenia;
- `NIEPRAWDA` — opis stanu obecnego jest sprzeczny z kodem;
- `NOT VERIFIED` — oczekiwany wpływ wydajnościowy lub zachowanie runtime nie
  ma aktualnego, immutable receipt z managed GPU.

Pseudokod, nowe pliki, typy i testy w dokumentach 01–09 są celami
implementacyjnymi, o ile nie oznaczono ich jako istniejące. Ścieżki zaczynające
się od `gpu/` lub `cpu/` są względne wobec `backends/fem/`.

## 1. Cel

Celem jest skrócenie czasu rozwiązania FEM GPU bez zmiany równań,
warunków brzegowych, definicji energii, kryteriów zbieżności ani jakości siatki.
Plan zamienia ustalenia audytu na zadania implementacyjne na poziomie:

- właścicieli stanu,
- konkretnych plików i symboli,
- nowych interfejsów wewnętrznych i wersjonowanego C ABI,
- kolejności RED–GREEN–REFACTOR,
- testów poprawności fizycznej i numerycznej,
- benchmarków na rzeczywistym GPU,
- jednoznacznych kryteriów zakończenia.

Nie jest celem sztuczne podniesienie wskaźnika `nvidia-smi`. Metryką główną jest
**wall time do tego samego wyniku**, np. czas zaakceptowanego kroku RK,
czas do `tolA` w relaksacji albo czas symulacji 1 ns przy tej samej dokładności.

## 2. Reguły nienegocjowalne

1. Produkcyjny kod pozostaje w `backends/fem`; Rust runner jedynie orkiestruje.
2. Nie dodawać kolejnych przypadkowych pól do centralnego `Context`. Stan należy
   do modułu: exchange, RK, demag, reductions, relaxation albo runtime diagnostics.
3. Jawne `device=gpu` w trybie strict nie może przechodzić do
   `hybrid_cpu_poisson`, consistent-mass CPU ani innego hostowego operatora.
4. P0 nie luzuje `rtol`, `max_err`, `tolA`, jakości meshu ani fizyki.
5. Każda zmiana wydajności musi mieć:
   - baseline,
   - licznik wykonanej pracy,
   - test parytetu,
   - managed GPU runtime proof.
6. Autorytatywne buildy i testy FEM używają kontenerowych receptur `justfile`.
   Hostowe `cargo`, `cmake` i bezpośrednie binaria są wyłącznie diagnostyką.
7. Nie łączyć wszystkich operatorów w jeden monolityczny kernel bez profilu
   rejestrów i occupancy.
8. Nie włączać globalnego `--use_fast_math`.
9. Nie zmieniać istniejącego ABI przez dopisywanie pól do niewersjonowanych
   struktur. Nowa telemetria i sterowanie muszą mieć wersjonowane struktury.
10. Nie usuwać ścieżki referencyjnej przed kwalifikacją następcy.

## 3. Dokumenty wykonawcze

| Dokument | Zakres |
|---|---|
| [01-runtime-truth-build-and-instrumentation.md](fem-gpu-performance-remediation-2026-09-01/01-runtime-truth-build-and-instrumentation.md) | RT-01, BL-01, baseline, wykonane operatory, wersjonowana telemetria |
| [02-exchange-operator-remediation.md](fem-gpu-performance-remediation-2026-09-01/02-exchange-operator-remediation.md) | EX-01…EX-08, fused xyz CSR, PBC reduction, row mapping, prekomputacja |
| [03-rk-pipeline-and-synchronization-remediation.md](fem-gpu-performance-remediation-2026-09-01/03-rk-pipeline-and-synchronization-remediation.md) | RK-01…RK-06, deferred validation, FSAL, kopie D2D, output mask |
| [04-adaptive-error-controller-remediation.md](fem-gpu-performance-remediation-2026-09-01/04-adaptive-error-controller-remediation.md) | AD-01…AD-03, brak `acos` per node, specjalizacje BS23/DP54 |
| [05-demag-hypre-remediation.md](fem-gpu-performance-remediation-2026-09-01/05-demag-hypre-remediation.md) | DM-01…DM-05, FieldOnly, residual validation, HYPRE, recovery |
| [06-effective-field-reductions-and-memory-remediation.md](fem-gpu-performance-remediation-2026-09-01/06-effective-field-reductions-and-memory-remediation.md) | HF-01, HF-02, RD-01, MEM-01, LLG metric, fuzja redukcji |
| [07-relaxation-preconditioning-remediation.md](fem-gpu-performance-remediation-2026-09-01/07-relaxation-preconditioning-remediation.md) | RL-01, GPU NCG preconditioner, PG-BB/Armijo control |
| [08-operator-planner-partial-assembly-and-autotuning.md](fem-gpu-performance-remediation-2026-09-01/08-operator-planner-partial-assembly-and-autotuning.md) | PA-01, CSR/SpMM/PA, histogram wierszy, kwalifikowany planner |
| [09-pr-sequence-tests-and-definition-of-done.md](fem-gpu-performance-remediation-2026-09-01/09-pr-sequence-tests-and-definition-of-done.md) | kolejność PR, managed gates, rollout, rollback i finalne DoD |
| [10-finding-coverage-matrix.md](fem-gpu-performance-remediation-2026-09-01/10-finding-coverage-matrix.md) | pełne mapowanie ustalenie → kod → test → telemetria → PR |

## 4. Źródłowy i docelowy graf wykonania RK23

Baseline przed remediacją dla zaakceptowanej, adaptacyjnej próby BS23 po
rozgrzaniu FSAL, wyprowadzony z grafu wywołań w `rk_stage_schedule.cu` i
`rk_final_refresh.cu`, wyglądał następująco:

```text
backup D2D
  -> predictor + normalize + host fence
  -> RHS k1 [exchange x3 + demag solve + stage demag energy + H_eff + LLG/max]
  -> predictor + normalize + host fence
  -> RHS k2 [jak wyżej]
  -> accept + normalize + host fence
  -> RHS k3 endpoint [jak wyżej]
  -> adaptive reductions x3 + host fence
  -> ponowny final RHS [jak wyżej]
  -> final energies/observables + host fence
```

W bieżącym worktree ścieżka endpoint/FSAL i FieldOnly jest już zaimplementowana
źródłowo, więc wariant bez odrzuceń może dojść do budżetu P0 poniżej. Dopóki
nie ma managed receipt, tabelę należy czytać jako cel/hipotezę, nie wynik.

Cel P0:

```text
attempt transaction
  -> fused predictor/normalize, deferred finite flag
  -> RHS k1 [exchange xyz + demag FieldOnly + H_eff + LLG bez max]
  -> fused predictor/normalize
  -> RHS k2
  -> exact endpoint candidate + normalize
  -> RHS k3 endpoint
  -> specjalizowana redukcja błędu + jeden control packet readback
  -> accept:
       reuse k3 i endpoint fields
       policz wyłącznie wymagane final metrics
  -> reject:
       restore transaction i powtórz próbę
```

Docelowy budżet no-reject dla adaptacyjnego RK23. Liczby są bramką
implementacyjną, a nie zmierzonym baseline SP4:

| Licznik | Przed | P0 |
|---|---:|---:|
| pełne RHS | 4 | 3 |
| Poisson demag solve | 4 przy aktywnym demag | 3 przy aktywnym demag |
| exchange sparse launches | 12 | 3 |
| stage demag energy kernel + reduce | zależne od aktywnego demag | 0 |
| normalizer host fences | 3 | 0 |
| adaptive host fences | 1 | 1 |
| final-stat host fences | 1 | 0 lub 1 zależnie od output/control mask |

### Orientacyjny wpływ na wall time — hipoteza, nie wynik

Na podstawie samego grafu pracy nie można uczciwie obiecać jednej wartości
procentowej. Dla zwykłego, nieperiodycznego SP4, bez odrzuceń prób i przy
kwalifikacji wszystkich ścieżek P0, mój roboczy szacunek całego kroku to około
**15–30% krótszy wall time** (punkt środkowy około 20–25%). Wynika on głównie z
4 → 3 pełnych RHS/demag solve, usunięcia stage demag energy oraz ograniczenia
launchy exchange; nie jest to pomiar.

W przypadku, w którym Poisson demag dominuje koszt, górna granica może dojść do
około **30–40%**, natomiast przy dominacji innych operatorów, częstych
odrzuceniach lub pozostawieniu ścieżki zgodności zysk może spaść do kilku–
kilkunastu procent. Periodyczny reduced CSR może dać wielokrotny zysk w samym
komponencie exchange względem skanu O(N²), ale zysk całego kroku pozostaje
`NOT VERIFIED` i może być ograniczony przez Poisson, projekcję oraz koszt
liftu.

Powyższe widełki są jedynie hipotezą planistyczną. Do dokumentu kwalifikacyjnego
wolno wpisać wyłącznie medianę/p95 z aktualnego managed GPU receipt dla tego
samego ProblemIR, meshu, tolerancji, runtime bundle i źródła.

Priorytet poniżej jest klasyfikacją inżynierską wynikającą ze struktury kodu,
nie rankingiem udziału w wall time:

| Klasa | Ustalenia | Podstawa |
|---|---|---|
| Błąd skalowania | EX-01 | pełny skan `source_row=0..N` dla każdego wiersza |
| Gwarantowane usunięcie pracy | RK-03, DM-01, DM-02, RK-01, EX-02 | graf wywołań i liczniki pracy |
| Kandydat sprzętowy | EX-03, EX-04, DM-04, DM-05, RL-01, PA-01 | wymaga A/B na rzeczywistym GPU |
| Refaktor architektoniczny | RK-05, HF-02, RD-01 | samodzielnie nie gwarantuje skrócenia czasu |

## 5. Fale realizacji

### Fala A — prawda i baseline

- scalenie istniejących statystyk kroku, endpoint cache, transfer audit,
  execution receipt i fazowych timerów w wersjonowany snapshot pracy,
- zachowanie i rozszerzenie istniejącego fail-closed strict-device receipt,
- zachowanie istniejącego gate'u exportera dla Ada
  (`FULLMAG_FEM_EXPECTED_COMPUTE_CAPABILITY=8.9`, `fullmag_fem=sm_89`,
  `hypre=sm_89`) oraz zastąpienie stałego `sm_89` mapowaniem z wykrytego
  compute capability, związanym z digestem finalnego bundle i benchmark receipt,
- stabilny benchmark SP4 i mikrobenchmark operatorów.

Nie optymalizować przed zapisaniem baseline.

### Fala B — usunięcie pracy zbędnej

- jeden właściciel polityki HYPRE,
- warunkowe `Norml2(rhs)`,
- demag `FieldOnly` w etapach,
- LLG bez redukcji maksimum w etapach,
- statystyki liczone zgodnie z maską zapisu/kontroli.

### Fala C — usunięcie barier i duplikatu endpointu

- deferred normalization status,
- jeden control packet na próbę,
- specjalizowany adaptive error,
- endpoint FSAL reuse dla BS23, następnie DP54.

### Fala D — przebudowa wymiany

- precomputed row scale,
- off-diagonal CSR,
- jeden fused xyz kernel,
- wariant strict/accurate,
- zredukowany operator PBC.

### Fala E — fuzja element-wise i redukcji

- fused xyz `H_eff`,
- lazy materialization,
- wielokanałowe redukcje adaptive/Armijo,
- ograniczenie kopii D2D przez role buforów.

### Fala F — algorytmy

- GPU NCG preconditioner,
- inexact stage Poisson po kwalifikacji,
- planner CSR/SpMM/partial assembly,
- ewentualny CUDA Graph po usunięciu hostowych zależności.

## 6. Kanoniczny przypadek benchmarkowy

Dla `mixed_p1` należy użyć `FULLMAG_SP4_COMPATIBILITY=native`, ponieważ profil
`mumax3` wymaga `all_tet`.

Przykładowa konfiguracja środowiska:

```bash
export FULLMAG_SP4_PHASE=relax
export FULLMAG_SP4_DEVICE=gpu
export FULLMAG_SP4_TOPOLOGY_VARIANT=mixed_p1
export FULLMAG_SP4_LAYERS=1
export FULLMAG_SP4_MESH=medium
export FULLMAG_SP4_AIRBOX=baseline
export FULLMAG_SP4_COMPATIBILITY=native
export FULLMAG_SP4_RELAX_ALGORITHM=llg_overdamped
export FULLMAG_SP4_RELAX_MAX_STEPS=64
export FULLMAG_FEM_STEP_PROFILE=1
```

Autorytatywna ścieżka managed runtime:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just fem-sp4-run gpu <output_dir>
```

Alternatywnie skrypt może zostać uruchomiony przez aktualny cel
`fem-managed-headless`. `fem-gpu-headless` buduje i uruchamia binarium ad hoc;
jest przydatne diagnostycznie, ale nie stanowi managed-runtime proof.

Istniejące cele `verify-fem-gpu-performance-regression` i
`capture-fem-gpu-pre-remediation-performance-baseline` dotyczą przypadku
`box500`, a nie tej dokładnej konfiguracji SP4. Należy dodać osobny cel SP4,
który utrwali source/runtime identity, ProblemIR i mesh digest, liczniki
rzeczywistej pracy oraz medianę/p95. Przykładowe liczby siatki i zerowe czasy
nie są baseline i nie mogą trafić do zaakceptowanego artefaktu.

## 7. Warunki zakończenia całego programu

Program optymalizacji jest zamknięty dopiero, gdy:

- strict receipt potwierdza wszystkie wymagane operatory na GPU;
- nie ma pełnego H2D/D2H w accepted-step hot loop;
- wszystkie host fences są policzone i mają jawnego właściciela;
- liczba RHS i demag solve odpowiada metodzie;
- periodyczna wymiana nie skanuje `N` węzłów dla każdego wiersza;
- CPU/GPU operator, energia, krok i trajektoria przechodzą parytet;
- SP4 przechodzi bramki przestrzenne, czasowe i energii;
- relaksacja zachowuje dowód Armijo i skraca time-to-`tolA`;
- benchmark raportuje medianę i p95 z rozgrzanych powtórzeń;
- finalny runtime zawiera właściwy cubin/PTX dla testowanego GPU;
- dokumenty architektury, fizyki, capability i provenance są zaktualizowane.

<!-- END README.md -->

---

<!-- BEGIN 01-runtime-truth-build-and-instrumentation.md -->

# 01. Prawda o wykonaniu, buildzie i telemetrii

**Ustalenia:** RT-01, BL-01 oraz wspólna warstwa pomiarowa dla wszystkich
pozostałych punktów.

## 1. Problem

Aktualny kod ma:

- `GpuRkPlan`, który opisuje planowane miejsce wykonania,
- `FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1`, który potwierdza wykonane
  operatory po zaakceptowanej próbie,
- `fullmag_fem_transfer_audit`, który liczy transfery i wybrane synchronizacje,
- fazowe eventy CUDA dla exchange, demag i RHS.

Istnieją ponadto `fullmag_fem_step_stats`, wersjonowana telemetria endpoint
cache oraz transactional execution receipt. RT-01 nie oznacza więc braku
fail-closed dowodu wykonania: `gpu_rk_plan_is_strict_device_resident` oraz
`validate_strict_fem_gpu_execution_receipt` już odrzucają host, hybrid,
unknown, brak wymaganej maski i bulk compute transfer. W tym worktree dodano
osobny, transakcyjny snapshot **rzeczywiście wykonanej pracy**; pozostała luka
dotyczy pełnego pokrycia bezpośrednich synchronizacji i publicznego provenance.

Snapshot odpowiada już na pytania:

- ile pełnych RHS wykonano,
- ile solve’ów Poissona wykonano,
- ile razy liczono normę RHS,
- ile razy liczono energię demag w etapie,
- ile exchange kernel launches wykonano,
- ile normalizacji odczytało hosta,
- ile host fences przypadło na zaakceptowany krok,
- czy endpoint cache został użyty,
- ile D2D bytes wykonano,
- ile czasu fazowego zapisano dla exchange, demag i RHS.

Faktyczny tryb operatora pozostaje w resolved planner/provenance, a nie w
wersji ABI v1 snapshotu. Nie należy dopisywać go do istniejącego layoutu bez
nowej wersji ABI.

Bez tych liczników można skrócić pojedynczy kernel i jednocześnie pogorszyć
time-to-solution przez większą liczbę RHS, odrzuceń albo iteracji.

## 2. Właściciel stanu

Nie dodawać pól bezpośrednio do `Context`.

Wprowadzono:

```text
backends/fem/gpu/cuda/runtime/performance_counters.hpp
backends/fem/gpu/cuda/runtime/performance_counters.cpp
```

oraz dodano `GpuPerformanceCounterState` do `GpuStateRuntimeState` w
`gpu/cuda/runtime/gpu_state_runtime.hpp`:

```cpp
struct GpuPerformanceCounterState {
    bool available = false;
    bool attempt_active = false;
    GpuPerformanceCounterDelta active{};
    GpuPerformanceCounterDelta physical_lifetime{};
    GpuPerformanceCounterDelta accepted_lifetime{};
    fullmag_fem_gpu_performance_snapshot_v1 completed{};
};

struct GpuStateRuntimeState {
    ...
    GpuPerformanceCounterState performance_counters{};
};
```

`performance_counters.*` jest jedynym właścicielem:

- resetu liczników kroku,
- commit/rollback liczników prób,
- eksportu C ABI i walidacji layoutu,
- mapowania metadanych snapshotu.

Poszczególne moduły wywołują wąskie funkcje właściciela stanu:

```cpp
gpu_performance_begin_attempt(state, step, execution_id, operator_id);
gpu_performance_note(state, delta);
gpu_performance_commit_attempt(state);
gpu_performance_reject_attempt(state);
gpu_performance_fail_attempt(state);
```

Nie mogą samodzielnie publikować ABI ani modyfikować liczników innych modułów.

## 3. Wersjonowany snapshot C ABI

### Pliki

- `native/include/fullmag_fem.h`
- `backends/fem/src/api.cpp`
- `backends/fem/gpu/cuda/runtime/performance_counters.hpp/.cpp`
- `crates/fullmag-fem-sys/src/lib.rs` lub kanoniczna procedura regeneracji bindów
- `crates/fullmag-runner/src/fem/execution_receipt.rs`
- test layoutu ABI w `backends/fem/tests/`

### Struktura obowiązująca w ABI v1

Nie rozszerzać istniejącego niewersjonowanego `fullmag_fem_transfer_audit`.
Wprowadzony snapshot append-only ma następujący layout (bez pola operatora,
które pozostaje w planner/provenance):

```cpp
#define FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION 1u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t available;
    uint32_t execution_class;
    uint32_t precision;
    uint32_t integrator;
    int32_t device_ordinal;
    uint64_t completed_step;
    uint64_t completed_execution_id;
    uint64_t completed_operator_id;
    uint64_t completed_attempt_count;
    uint64_t rejected_attempt_count;
    uint64_t failed_attempt_count;

    uint64_t physical_rhs_evaluations;
    uint64_t physical_exchange_applies;
    uint64_t physical_exchange_launches;
    uint64_t physical_exchange_nnz_visited;
    uint64_t physical_demag_solves;
    uint64_t physical_demag_iterations;
    uint64_t physical_demag_rhs_norm_evaluations;
    uint64_t physical_demag_stage_energy_evaluations;
    uint64_t physical_normalization_launches;
    uint64_t physical_normalization_readbacks;
    uint64_t physical_adaptive_readbacks;
    uint64_t physical_control_fences;
    uint64_t physical_endpoint_cache_hits;
    uint64_t physical_endpoint_cache_misses;
    uint64_t physical_endpoint_cache_invalidations;
    uint64_t physical_device_to_device_bytes;
    uint64_t physical_control_d2h_bytes;
    uint64_t physical_bulk_d2h_bytes;
    double physical_demag_rhs_norm_sum;
    double physical_demag_stage_energy_sum_joules;

    uint64_t accepted_rhs_evaluations;
    uint64_t accepted_exchange_applies;
    uint64_t accepted_exchange_launches;
    uint64_t accepted_exchange_nnz_visited;
    uint64_t accepted_demag_solves;
    uint64_t accepted_demag_iterations;
    uint64_t accepted_demag_rhs_norm_evaluations;
    uint64_t accepted_demag_stage_energy_evaluations;
    uint64_t accepted_normalization_launches;
    uint64_t accepted_normalization_readbacks;
    uint64_t accepted_adaptive_readbacks;
    uint64_t accepted_control_fences;
    uint64_t accepted_endpoint_cache_hits;
    uint64_t accepted_endpoint_cache_misses;
    uint64_t accepted_endpoint_cache_invalidations;
    uint64_t accepted_device_to_device_bytes;
    uint64_t accepted_control_d2h_bytes;
    uint64_t accepted_bulk_d2h_bytes;
    double accepted_demag_rhs_norm_sum;
    double accepted_demag_stage_energy_sum_joules;

    uint64_t physical_exchange_elapsed_ns;
    uint64_t physical_demag_assemble_elapsed_ns;
    uint64_t physical_demag_recover_elapsed_ns;
    uint64_t physical_demag_energy_elapsed_ns;
    uint64_t physical_rhs_elapsed_ns;
    uint64_t accepted_exchange_elapsed_ns;
    uint64_t accepted_demag_assemble_elapsed_ns;
    uint64_t accepted_demag_recover_elapsed_ns;
    uint64_t accepted_demag_energy_elapsed_ns;
    uint64_t accepted_rhs_elapsed_ns;
} fullmag_fem_gpu_performance_snapshot_v1;
```

Nie deklarować ponownie `fullmag_fem_gpu_execution_class_v1`: ten enum już
jest częścią `FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1` w
`native/include/fullmag_fem.h` i obejmuje również klasy host-solver oraz CPU.
Snapshot używa istniejących wartości klasy wykonania. CPU zwraca jawne
`FULLMAG_FEM_ERR_UNAVAILABLE`; nie publikuje zerowego snapshotu udającego GPU.

Funkcja:

```cpp
int fullmag_fem_backend_gpu_performance_snapshot_v1(
    fullmag_fem_backend *backend,
    fullmag_fem_gpu_performance_snapshot_v1 *out_snapshot);
```

Walidacja:

- `out_snapshot != nullptr`,
- `abi_version` i `struct_size` sprawdzane zgodnie z obowiązującym wzorcem ABI,
- CPU backend zwraca jawne `ERR_UNAVAILABLE`, a nie zerowy snapshot udający GPU,
- snapshot dotyczy ostatniego ukończonego kroku, nigdy częściowej próby.

## 4. Transakcyjność liczników

Adaptive RK może odrzucać próby. Należy rozdzielić:

- **physical work counters** — liczą również odrzucone próby;
- **accepted result counters** — odnoszą się do zaakceptowanego kroku;
- **lifetime counters** — monotoniczne od utworzenia backendu.

Model wdrożony:

```cpp
struct FemGpuPerformanceAttemptDelta {
    uint64_t rhs_evaluations = 0;
    uint64_t demag_solves = 0;
    ...
};

begin_attempt(step):
    ensure pending_accepted_step belongs to step;
    current_attempt = {};

reject_attempt():
    physical_lifetime += current_attempt;
    pending_accepted_step += current_attempt;
    current_step.rejected_attempts++;
    current_attempt = {};

accept_attempt():
    physical_lifetime += current_attempt;
    pending_accepted_step += current_attempt;
    accepted_lifetime += pending_accepted_step;
    current_attempt = {};
    pending_accepted_step = {};

commit_step():
    last_completed_step = current_step;
```

Liczników pracy nie wolno cofać po reject. `pending_accepted_step` sprawia, że
po późniejszym accept licznik wyniku zaakceptowanego wskazuje koszt całego
kroku wraz z odrzuconymi próbami; po failure pending jest porzucany, ale praca
fizyczna pozostaje w lifetime.

## 5. Zachowanie istniejącego strict receipt i rozszerzenie artefaktu

Właściciel planowania nadal ustala required/resolved masks, a receipt
potwierdza wykonanie. Runner powinien po pierwszym zaakceptowanym kroku
opublikować:

```text
requested_device=gpu
requested_execution=strict
resolved_execution_class=device_resident
exchange_operator=csr_fused_xyz
mass_projection=lumped_device
demag_operator=device_hypre_poisson
hypre_memory=device
hypre_execution=device
preconditioner=amg_device
executed_host_mask=0x0
executed_unknown_mask=0x0
executed_device_mask=...
hot_loop_compute_h2d_bytes=0
hot_loop_compute_d2h_bytes=0
```

### Miejsca zmiany

- `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — wyłącznie resolved plan.
- `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` — wykonane operatory.
- `backends/fem/gpu/cuda/runtime/performance_counters.cpp` — snapshot pracy.
- `crates/fullmag-runner/src/fem/execution_receipt.rs` — walidacja i artefakt.
- istniejący moduł provenance/manifest runnera — serializacja bez duplikowania
  logiki planera.

### Istniejący fail-closed invariant

Dla `requested_execution=strict` zakończyć przebieg błędem, gdy:

```text
execution_class != device_resident
executed_host_operator_mask != 0
executed_unknown_operator_mask != 0
executed_device_operator_mask != required_operator_mask
hot_loop_compute_h2d_bytes != 0
hot_loop_compute_d2h_bytes != 0
```

Warunki te są już egzekwowane przez plan/receipt/runner. Nowa praca ma je
zachować, dodać snapshot liczników i objąć audytem bezpośrednie readbacki oraz
synchronizacje, których obecny `fullmag_fem_transfer_audit` nie widzi. Control
scalar D2H pozostaje osobną dozwoloną kategorią, ale jego liczba i
synchronizacje muszą być jawne.

## 6. Walidacja architektury CUDA

CMake ustawia domyślną listę architektur CUDA, gdy CUDA jest dostępna, a
`crates/fullmag-fem-sys/build.rs` warunkowo przekazuje niepusty override
`FULLMAG_CUDA_ARCHITECTURES`. To nie dowodzi zawartości finalnego `.so`.
`scripts/inspect_cuda_architectures.py` i jego testy już obsługują
`--cuda-required` oraz `--require-native-cubin`. Ponadto
`scripts/export_fem_gpu_runtime.sh` już waliduje finalny bundle przez
`validate_managed_fem_runtime_bundle.py`, domyślnie wymaga compute capability
`8.9` oraz cubinów `fullmag_fem=sm_89` i `hypre=sm_89`. Brakującym elementem
jest uogólnione mapowanie wykrytego `major.minor` na `sm_xy` zamiast stałego
`sm_89` oraz immutable receipt łączący wynik gate'u z digestem dokładnego
bundle i benchmarkiem.

### Zmiany

- zachować istniejące testy `scripts/test_inspect_cuda_architectures.py`,
- zachować istniejącą walidację finalnego bundle w exporterze,
- wyprowadzać wymagany cubin z wykrytego compute capability; nie wymagać
  `sm_89` dla H100 ani innego nie-Ada GPU,
- zapisać w `manifest.json`:
  - lista cubin `sm_*`,
  - obecne PTX `compute_*`,
  - CUDA toolkit,
  - target GPU compute capability,
  - wynik `native cubin present`.

### Gate

Dla RTX 4080:

```text
target_compute_capability=8.9
required_native_cubin=sm_89
```

Dla H100:

```text
target_compute_capability=9.0
required_native_cubin=sm_90
```

PTX-only nie jest równoważne z natywnym cubinem w benchmarku kwalifikacyjnym.

Przykładowa diagnostyka wewnątrz managed container:

```bash
cuobjdump --list-elf libfullmag_fem.so
cuobjdump --dump-resource-usage libfullmag_fem.so
```

Nie wpisywać bezpośrednich hostowych ścieżek buildów do dokumentacji jako
autorytatywne. Skrypt ma dostać ścieżkę z manifestu managed runtime.

## 7. TDD

### RED 1 — layout i snapshot

Dodany kontrakt `backends/fem/tests/gpu_performance_snapshot_contract.cpp`
sprawdza:

- layout/version/size,
- null checks,
- CPU unavailable,
- snapshot nie publikuje aktywnej próby,
- reject zwiększa physical work,
- commit atomowo publikuje last completed step.

### REGRESSION 2 — strict execution

Zachować i w razie potrzeby rozszerzyć istniejące kontrakty
`gpu_strict_execution_contract.cpp`, `gpu_execution_receipt_contract.cpp` oraz
Rust `validate_strict_fem_gpu_execution_receipt`:

- explicit hybrid jest odrzucony,
- host mask jest odrzucona,
- unknown mask jest odrzucona,
- control scalar nie jest błędnie zaliczany do bulk D2H.

### REGRESSION 3 — final architecture

Istniejące testy inspektora i walidatora bundle pokrywają poniższe przypadki;
RED ma dotyczyć mapowania compute capability na wymagania wszystkich bibliotek
i związania wyniku z immutable benchmark receipt:

- fixture tylko `sm_52` musi failować dla `--require-native-cubin sm_89`,
- fixture `sm_89` przechodzi,
- brak danych nie daje fałszywego PASS.

### GREEN

Implementować dopiero po czerwonych testach. W profiler-off:

- nie tworzyć dodatkowych eventów,
- nie wykonywać zegarów hostowych,
- liczniki całkowite mogą być inkrementowane prostymi operacjami CPU;
  nie dodawać atomików device tylko dla telemetrii.

## 8. Benchmark baseline

Dodać managed cel, np. `verify-fem-gpu-performance-baseline`, który używa
`ensure-managed-fem-runtime`, kanonicznego SP4 i walidatora JSON.

Każdy rekord JSON:

```json
{
  "commit": "4c7897f218eb0c32612db1f43a844502a316b4f6",
  "gpu": {"name": "...", "compute_capability": "...", "driver": "..."},
  "mesh": {"digest": "...", "nodes": "MEASURED", "cells": "MEASURED", "facets": "MEASURED"},
  "solver": {"integrator": "rk23", "rtol": 1e-12},
  "performance": {"snapshot": "fullmag_fem_gpu_performance_snapshot_v1"},
  "wall": {
    "warmup_steps": 8,
    "measured_steps": 64,
    "median_step_ms": "MEASURED",
    "p95_step_ms": "MEASURED"
  }
}
```

Powyższy JSON jest schematem, nie wynikiem. Liczby siatki i czasy muszą pochodzić
z receipt dokładnego przebiegu; placeholder nie może zostać zaakceptowany jako
baseline. Nie porównywać przebiegów z różnymi mesh digestami.

Repo ma już `verify-fem-gpu-performance-regression` i
`capture-fem-gpu-pre-remediation-performance-baseline`, lecz ich fixture to
`box500` z Heun/NCG. Nie są dowodem dla SP4 mixed-P1 RK23. Nowy cel ma użyć
`fem-sp4-run` lub `fem-managed-headless`; `fem-gpu-headless` pozostaje
diagnostyczny.

## 9. Definition of Done

- nowy snapshot ma stabilne v1 ABI;
- każdy licznik ma jednego właściciela i test;
- strict receipt rozróżnia bulk i control transfers;
- profiler-off nie tworzy eventów ani alokacji;
- final runtime manifest potwierdza cubin;
- baseline SP4 został zapisany przed pierwszą optymalizacją;
- managed build i testy przechodzą.

<!-- END 01-runtime-truth-build-and-instrumentation.md -->

---

<!-- BEGIN 02-exchange-operator-remediation.md -->

# 02. Naprawa operatora wymiany FEM GPU

**Ustalenia:** EX-01, EX-02, EX-03, EX-04, EX-05, EX-06, EX-07, EX-08.

**Status po weryfikacji:** EX-01 ma źródłowy reduced CSR/mass/lift dla ścieżki
RK oraz osobne reduced-kernel paths dla pola, energii exchange i różnicy energii
używanej przez Armijo; EX-02 ma fused XYZ z zachowaną ścieżką split. EX-03
pozostaje częściowy: typed operator kinds istnieją, ale strict/FMA precision
modes nie. EX-04 ma deterministyczny fail-closed resolver, bez
histogramu/autotune. EX-05 nadal failuje przed strict GPU step dla consistent
mass. EX-06 potwierdza obecną `LEGACY` assembly, a PA pozostaje
nieprodukcyjnym celem. Builder off-diagonal CSR i row-scale są kontraktami
źródłowymi, lecz integracja wszystkich konsumentów, parytet i managed runtime
są `NOT VERIFIED`.

## 1. Aktualny przepływ

`cpu/mfem/interactions/exchange_operator.cpp` montuje `BilinearForm` na poziomie
`LEGACY`, pobiera `SparseMatrix`, kanonizuje ją do postaci grafowego
Laplacjanu i publikuje metadane. `gpu/cuda/exchange/exchange_upload.cpp`
kopiuje pełny CSR oraz lumped mass na GPU.

`gpu/cuda/integrators/rk/rk_exchange_dispatch.cu` zachowuje split x/y/z jako
compatibility path, ale dla nieperiodycznego row-scale wybiera fused XYZ, a dla
kwalifikowanej mapy PBC może wybrać reduced CSR/lift. Publiczny planner nadal
nie promuje tych wariantów bez kwalifikacji.

Wariant periodyczny używa kernela, w którym każdy docelowy wiersz skanuje
wszystkie `source_row`, aby znaleźć członków swojej klasy. To nie jest problem
block size; to niewłaściwa reprezentacja operatora.

## 2. Docelowa własność

Zastąpić nazwę i strukturę `LegacyGpuExchangeDeviceState` modułowym stanem:

```cpp
enum class GpuExchangeOperatorKind : uint32_t {
    LegacySparse,
    FusedXYZ,
    PeriodicReduced,
    CuSparse,
    PartialAssembly,
};

struct GpuExchangeCsrDeviceState {
    uint32_t *row_offsets = nullptr;
    uint32_t *col_indices = nullptr;
    double *values = nullptr;
    double *row_scale = nullptr;
    uint64_t rows = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
};

struct GpuPeriodicExchangeDeviceState {
    GpuExchangeCsrDeviceState reduced{};
    uint32_t *full_to_reduced = nullptr;
    uint32_t *reduced_representatives = nullptr;
    double *reduced_lumped_mass = nullptr;
    FemGpuComponentField reduced_field{};
    uint64_t full_rows = 0;
    uint64_t reduced_rows = 0;
    uint64_t device_bytes = 0;
};

struct FemGpuExchangeDeviceState {
    GpuExchangeOperatorKind kind = GpuExchangeOperatorKind::LegacySparse;
    GpuExchangeCsrDeviceState full{};
    GpuPeriodicExchangeDeviceState periodic{};
    bool uploaded = false;
    uint64_t apply_count = 0;
    uint64_t kernel_launch_count = 0;
};
```

### Pliki

- zmienić `gpu/cuda/exchange/exchange_state.hpp`,
- zmienić `gpu/cuda/state/gpu_state.hpp`,
- zmienić `gpu/cuda/exchange/exchange_upload.hpp/.cpp`,
- zmienić `gpu/cuda/exchange/exchange_plan.hpp/.cpp`,
- zmienić `gpu/cuda/exchange/exchange_kernels.hpp/.cu`,
- zmienić `gpu/cuda/integrators/rk/rk_exchange_dispatch.cu`,
- wydzielić backend-neutralny host artifact z istniejącego właściciela
  `cpu/mfem/interactions/exchange_operator.cpp`; moduł CUDA nie może stać się
  drugim właścicielem MFEM assembly,
- zaktualizować energy/direct-energy consumers,
- zaktualizować CMake i testy source ownership.

Przejściowy adapter może zachować starą funkcję uploadu, ale po migracji
wszystkich konsumentów usunąć słowo `legacy` z aktywnej ścieżki.

## 3. EX-07 — prekomputacja skali wiersza

### Problem

Każdy komponent i każdy apply liczy:

\[
s_i=-\frac{2}{\mu_0M_{s,i}}M_{L,i}^{-1}.
\]

To są dane niezmienne względem etapu RK.

### Implementacja

W `exchange_operator.cpp` oraz uploadzie przygotowano deviceowy row-scale:

```cpp
std::vector<double> build_exchange_row_scale(
    span<const double> ms,
    span<const double> inv_lumped_mass,
    span<const uint8_t> magnetic_mask)
{
    std::vector<double> scale(ms.size(), 0.0);
    for (size_t i = 0; i < ms.size(); ++i) {
        if (magnetic_mask[i] == 0 || ms[i] <= 0.0 ||
            inv_lumped_mass[i] <= 0.0) {
            scale[i] = 0.0;
        } else {
            scale[i] = -2.0 * inv_lumped_mass[i] / (kMu0 * ms[i]);
        }
    }
    return scale;
}
```

Builder ma używać kanonicznych hostowych pól `Ms` i lumped mass podczas setupu.
Nie wykonywać device→host readbacku.

### Invalidation

Przebudować/uploadować skalę przy zmianie:

- mesh dependency key,
- `Ms_field`,
- lumped mass,
- magnetic node mask,
- periodic equivalence classes.

Nie przebudowywać przy zmianie `m`, `alpha`, Zeeman ani czasu.

### Testy

- uniform `Ms`,
- nodal `Ms`,
- nonmagnetic node → scale zero,
- invalid `Ms<=0` zgodnie z istniejącym kontraktem,
- CPU formula parity.

## 4. EX-08 — off-diagonal CSR

### Problem

Pełny CSR zawiera przekątną, a kernel wykonuje branch `col != row`. Dla postaci:

\[
\sum_{j\ne i}K_{ij}(m_j-m_i)
\]

przekątna nie wnosi pracy.

### Builder

Kanoniczny builder GPU-only znajduje się w `exchange_operator.cpp`:

```cpp
struct HostExchangeCsr {
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
    std::vector<double> row_scale;
};
```

Algorytm:

1. sprawdź monotoniczność `row_offsets`;
2. dla każdego wiersza pomiń `col == row`;
3. odrzuć indeks poza zakresem;
4. scal duplikaty kolumn deterministycznie;
5. zachowaj sortowanie kolumn;
6. nie usuwaj małych wartości na podstawie heurystycznego epsilon;
7. zachowaj pełny MFEM operator po stronie CPU dla oracle;
8. policz digest GPU CSR.

### Inwarianty

- usunięcie przekątnej nie zmienia pola różnicowego;
- nie wykonywać drugiej symetryzacji w GPU builderze;
- błędny CSR failuje podczas setupu, nie w kernelu.

## 5. EX-02 — jeden fused xyz CSR kernel

### Interfejs

```cpp
void fullmag_cuda_exchange_fused_xyz(
    const GpuExchangeCsrDeviceState &op,
    const FemGpuComponentField &m,
    FemGpuComponentField &h_ex,
    int rows,
    cudaStream_t stream,
    GpuExchangeAccumulationMode mode);
```

Kernel:

```cpp
template <AccumulationMode Mode>
__global__ void exchange_fused_xyz_kernel(
    const uint32_t *__restrict__ row_offsets,
    const uint32_t *__restrict__ columns,
    const double *__restrict__ values,
    const double *__restrict__ row_scale,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ hx,
    double *__restrict__ hy,
    double *__restrict__ hz,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) return;

    const double scale = row_scale[row];
    if (scale == 0.0) {
        hx[row] = 0.0;
        hy[row] = 0.0;
        hz[row] = 0.0;
        return;
    }

    const double mxi = mx[row];
    const double myi = my[row];
    const double mzi = mz[row];

    Accumulator<Mode> sx{}, sy{}, sz{};
    for (uint32_t p = row_offsets[row]; p < row_offsets[row + 1]; ++p) {
        const uint32_t col = columns[p];
        const double a = values[p];
        sx.add_scaled_difference(a, mx[col], mxi);
        sy.add_scaled_difference(a, my[col], myi);
        sz.add_scaled_difference(a, mz[col], mzi);
    }
    hx[row] = scale * sx.value();
    hy[row] = scale * sy.value();
    hz[row] = scale * sz.value();
}
```

### SoA pozostaje

Nie zmieniać głównego layoutu na AoS tylko dla wymiany. Fused kernel czyta trzy
strumienie SoA, ale tylko raz odczytuje strukturę CSR.

### Launch

- początkowo `block=256`;
- później wybór 128/256 na podstawie Nsight;
- bez `cudaStreamSynchronize`;
- `cudaPeekAtLastError` zgodnie z obecnym wzorcem;
- liczniki `exchange_applies += 1`, `exchange_kernel_launches += 1`.

## 6. EX-03 — tryby akumulacji

```cpp
enum class GpuExchangeAccumulationMode : uint32_t {
    StrictCompensated,
    AccurateFp64Fma,
};
```

### StrictCompensated

- przenieść obecną arytmetykę double-double do
  `exchange_accumulator.cuh`;
- trzy niezależne akumulatory;
- zachować kolejność NNZ;
- sprawdzić rejestry przez `-Xptxas=-v`.

### AccurateFp64Fma

- suma FP64 z `fma(a, m[col]-m_i, sum)`;
- opcjonalnie Neumaier, jeżeli zwykłe FMA nie przechodzi oracle;
- bez globalnego fast-math.

### Wybór

Początkowo strict GPU używa `StrictCompensated`. Tańszy wariant jest kandydatem
produkcyjnym dopiero po kwalifikacji i otrzymuje własny provenance mode ID.

### Testy numeryczne

- jednorodny i prawie jednorodny stan,
- ściana domenowa,
- losowe unormowane `m`,
- kontrast `A` i `Ms`,
- energia i directional derivative,
- 1000 apply bez narastającego driftu.

## 7. EX-04 — mapowanie wierszy

Builder oblicza histogram:

```cpp
struct SparseRowHistogram {
    uint32_t min, p10, p50, p90, p95, p99, max;
    double mean;
};
```

Warianty:

1. `ThreadPerRow`,
2. `WarpPerRow`,
3. `Bucketed`,
4. `CusparseSpmm`.

Nie wdrażać runtime autotune. Najpierw offline benchmark i statyczne,
kwalifikowane progi według histogramu oraz GPU architecture ID.

Warp-per-row dla strict compensated wymaga deterministycznego łączenia
akumulatorów; dlatego pierwsza wersja warp może dotyczyć tylko
`AccurateFp64Fma`.

## 8. EX-01 — zredukowany operator periodyczny

Niech `full_to_reduced[i]=r` opisuje klasy periodyczne, a `P` prolonguje:

\[
m=P\widehat m.
\]

Przygotować raz:

\[
\widehat K=P^T K P,\qquad
\widehat M_L=P^T M_L.
\]

### Host builder

1. zwaliduj mapę i liczbę klas;
2. zbuduj listy członków;
3. dla każdego pełnego NNZ `(i,j,Kij)` dodaj `(ri,rj,Kij)`;
4. scal duplikaty i sortuj;
5. usuń zredukowaną przekątną dla różnicowego apply;
6. policz zredukowaną lumped mass;
7. wybierz reprezentantów;
8. zwaliduj klasę materiałową.

W jednej klasie wymagane są zgodne:

- magnetic status,
- `Ms`,
- material/region identity na sparowanych granicach,
- frozen status/reference, jeżeli obowiązuje.

`A` jest już zawarte w `K`, lecz ogólny kontrakt PBC powinien odrzucać
fizycznie niespójne sparowanie materiałów.

### Apply

```text
fused xyz apply na reduced rows
lift h_full[i] = h_reduced[full_to_reduced[i]]
```

### Energia i Armijo

Zaktualizować równocześnie:

- `rk_exchange_energy_reductions.cu`,
- `relaxation/direct_energy_increment.cpp`,
- exchange difference kernel,
- final stats.

Nie wolno mieć reduced field apply i full unreduced energy o innej semantyce.

### Skalowanie

Source contract zabrania pełnej pętli `source_row=0..N` w kernelu. Runtime
liczy `visited_nnz`, a test potwierdza koszt `O(nnz_reduced + N)`.

## 9. EX-05 — consistent mass

Strict GPU z `use_consistent_mass=true` już failuje przed krokiem w
`gpu/cuda/exchange/exchange_plan.cpp::gpu_exchange_plan_stage_exchange` i
publikuje przyczynę. To zachowanie należy zachować podczas przebudowy.

Docelowy osobny moduł:

```text
gpu/cuda/exchange/consistent_mass_solver.hpp/.cpp
```

- persistent operator/preconditioner,
- trzy device RHS,
- Jacobi/Chebyshev baseline,
- warm start,
- residual validation,
- CPU parity.

Nie łączyć z fused lumped CSR w jednym PR.

## 10. EX-06 — partial assembly

Aktualny P1 tetra używa component-split legacy CSR. P1 tetra ma przejść
najpierw przez kwalifikację fused CSR. PA jest osobnym operator kind,
capability i benchmarkiem. Szczegóły w dokumencie 08.

## 11. Testy i DoD

Nowe testy:

- `exchange_gpu_operator_builder_contract.cpp`,
- `cuda_exchange_fused_xyz_contract.cpp`,
- `cuda_exchange_periodic_reduced_contract.cpp`,
- `cuda_exchange_accuracy_contract.cpp`,
- rozszerzenia `gpu_rk_plan.cpp` i source-facade tests.

DoD nieperiodyczne:

- 1 kernel/apply zamiast 3;
- field/energy parity;
- brak host sync/alokacji w apply;
- poprawa full RHS.

DoD PBC:

- brak O(N²);
- field/energy/direct-energy parity;
- material mismatch reject;
- resolved kind `periodic_reduced_fused_xyz`;
- skalowanie z `nnz_reduced`.

<!-- END 02-exchange-operator-remediation.md -->

---

<!-- BEGIN 03-rk-pipeline-and-synchronization-remediation.md -->

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

<!-- END 03-rk-pipeline-and-synchronization-remediation.md -->

---

<!-- BEGIN 04-adaptive-error-controller-remediation.md -->

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

<!-- END 04-adaptive-error-controller-remediation.md -->

---

<!-- BEGIN 05-demag-hypre-remediation.md -->

# 05. Naprawa demagnetyzacji Poissona i HYPRE

**Ustalenia:** DM-01, DM-02, DM-03, DM-04, DM-05 oraz podwójne ustawianie
polityki HYPRE wykryte na aktualnym `master`.

**Status po weryfikacji:** DM-01 ma typed `FieldOnly` dla RK i frequency
tangent, DM-02 ma warunkową walidację RHS norm/residual, a duplikacja setterów
HYPRE została usunięta. DM-03 ma wspólny-pattern fused recovery z digestem i
split fallback. DM-04 jest częściowy: timingi host API/device/wait/iteracji są
zachowane i trafiają do snapshotu, ale brak profilu AMG levels i benchmarku.
DM-05 pozostaje hipotezą kwalifikacyjną; purpose nadal używają wspólnego
`ctx.demag.solver.relative_tolerance`. Managed/runtime parity jest
`NOT VERIFIED`.

## 1. Co zachować

- persistent Hypre matrix/vectors/solver/preconditioner,
- setup poza każdym RHS,
- warm/fresh-zero policy,
- device memory/execution,
- eventowy most Fullmag ↔ HYPRE,
- device RHS/recovery,
- phase telemetry.

Nie zastępować eventów globalnym `cudaDeviceSynchronize`.
Twierdzenie dotyczy stage hot path. Ścieżki wizualizacji i scalar readback mają
osobne synchronizacje i nie są dowodem pełnego grafu bez fence.

## 2. Jeden właściciel polityki HYPRE

`runtime/hypre_device_policy.cpp` jest jedynym właścicielem process-wide
`HYPRE_Set*`; lokalne settery zostały usunięte z `hypre_device_solver.cpp`.

Naprawa:

1. zachować usunięcie `configure_hypre_device_vendor_kernels`;
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

Wprowadzony pure helper:

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

Persistent solver i warm/fresh counters już istnieją. RK ma endpoint token
związany z exact time/signature; nie ma jeszcze jednego ogólnego tokenu
obejmującego równocześnie RK, HYPRE i PG-BB. `FemGpuAcceptedEvaluationToken`
dotyczy GPU NCG. Poniższe punkty są wymaganiami docelowymi.

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

<!-- END 05-demag-hypre-remediation.md -->

---

<!-- BEGIN 06-effective-field-reductions-and-memory-remediation.md -->

# 06. Składanie H_eff, redukcje, LLG i pamięć

**Ustalenia:** HF-01, HF-02, RD-01, MEM-01 oraz część RK-04/RK-05.

**Status po weryfikacji:** HF-01/HF-02 nadal są component-split passes; `has_ext`
jest już wyznaczane z rzeczywistego planu pola zewnętrznego, nie stałe.
Typed reducers, maski materializacji i fused base compose nie istnieją. MEM-01
ma dedykowany pinned `GpuRkAttemptControlPacket`, lecz generyczne readbacki
nadal mają pageable fallback. Wpływ wszystkich fuzji na rejestry, occupancy i
wall time pozostaje `NOT VERIFIED`.

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

<!-- END 06-effective-field-reductions-and-memory-remediation.md -->

---

<!-- BEGIN 07-relaxation-preconditioning-remediation.md -->

# 07. Relaksacja GPU: preconditioner, Armijo i sterowanie

**Ustalenia:** RL-01 oraz RD-01/RK-02 w NCG i PG-BB.

### Current source status (2026-09-04)

Obecna klasa `GpuDiagonalRelaxationPreconditioner` ma status: diagonal/Jacobi approximation.
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

<!-- END 07-relaxation-preconditioning-remediation.md -->

---

<!-- BEGIN 08-operator-planner-partial-assembly-and-autotuning.md -->

# 08. Planner operatorów: CSR, SpMM i partial assembly

**Ustalenie:** PA-01 oraz docelowa decyzja dla EX-04/EX-06.

**Status po weryfikacji:** `exchange_operator.hpp/.cpp` dodaje jeden typed
resolver dla legacy/fused/reduced/cuSPARSE/PA z fail-closed gates profilu,
VRAM i runtime. Nie ma jeszcze produkcyjnego cuSPARSE SpMM ani PA exchange,
a resolver nie jest podłączony do publicznego `GpuExchangePlan`. `pa_benchmark.cpp`
 nadal mierzy ogólny assembled-vs-PA Laplacian, nie operator wymiany, i nie
emituje opisanego JSON. Cały wybór wariantu oraz break-even pozostają
`NOT VERIFIED`.

## 1. Problem

Jeden assembled CSR nie jest uniwersalny dla regularnych pryzmatów, wyższych
rzędów, nieregularnych wierszy i różnych GPU. Runtime autotune utrudnia
reprodukowalność. Planner ma wybierać tylko warianty zakwalifikowane offline.

## 2. Typowany plan

```cpp
enum class GpuExchangeOperatorKind : uint32_t {
    LegacySparse,
    FusedXYZ,
    PeriodicReduced,
    CuSparse,
    PartialAssembly,
};

enum class GpuExchangeRowMapping : uint32_t {
    ThreadPerRow,
    WarpPerRow,
    Bucketed,
};

struct GpuExchangeResolvedPlan {
    bool enabled;
    GpuExchangeOperatorKind kind;
    GpuExchangeRowMapping row_mapping;
    GpuExchangeAccumulationMode accumulation;
    uint32_t block_size;
    const char *qualification_id;
};
```

To jest ten sam canonical enum co w dokumencie 02; nie wolno definiować dwóch
wariantów nazw. `qualification_id` musi mieć owned/fixed-size representation
wewnętrzne oraz wersjonowaną reprezentację provenance/ABI, a nie niezarządzany
`const char *` przekraczający granicę C ABI.

Przykład qualification ID:

```text
fem.exchange.gpu.ada.sm89.p1_tet.csr_xyz.v1
```

Brak profilu:

- explicit kind → fail,
- auto → konserwatywny qualified fused CSR,
- nigdy silent niewalidowany PA.

## 3. Inputs

- FE order,
- cell families,
- N/NNZ,
- row histogram,
- PBC,
- strictness,
- compute capability,
- VRAM,
- expected applies,
- output/materialization mode.

Nie używać bieżącego load ani losowego runtime microbenchmarku.

## 4. Harness

Rozszerzyć `backends/fem/examples/pa_benchmark.cpp` albo utworzyć
`exchange_operator_benchmark.cpp`.

- canonical fixture/operator,
- warmup,
- >=100 batched applies,
- CUDA event timing,
- jeden sync po batchu,
- correctness,
- JSON z histogram/register/device.

Warianty: fused strict/accurate, cuSPARSE SpMM, row mappings, PA, PBC reduced.

## 5. cuSPARSE SpMM

\[
K[m_x,m_y,m_z]
\]

Persistent:

- SpMat descriptor,
- dense descriptors,
- external buffer,
- no per-apply layout conversion.

Uwzględnić row scaling i graph-Laplacian semantics. Vendor path musi przejść
oracle; nie zakładać zwycięstwa.

## 6. Partial assembly

Osobny owner:

```text
gpu/cuda/exchange/partial_assembly_operator.hpp/.cpp
```

Persistent:

- restrictions,
- quadrature data,
- coefficient data,
- geometry,
- device vectors,
- operator handle.

Zero assembly in steady state.

Początek: przypadki, gdzie PA ma sens — wyższy order/tensor-product. P1 tetra
nie musi przechodzić.

## 7. Qualified profiles

Źródłowy artifact:

```text
docs/performance/fem_gpu_exchange_operator_profiles_v1.json
```

Wpis zawiera device family, FE order, cells, PBC, kind, mapping, accumulation,
qualified commit, validation i benchmark artifact.

Runtime korzysta ze zwalidowanej projekcji profilu, nie parsuje arbitralnie docs
w hot path.

## 8. Break-even

\[
T_\mathrm{total}=T_\mathrm{setup}+n_\mathrm{apply}T_\mathrm{apply}.
\]

Raportować break-even apply count. Krótka symulacja może preferować CSR.

## 9. Testy i DoD

- deterministic resolution,
- unsupported fail,
- explicit no fallback,
- qualification ID,
- device mapping,
- VRAM preflight,
- no setup in apply,
- operator parity,
- stale profile reject.

DoD: każdy resolved kind ma proof i poprawia time-to-solution w swoim profilu.

<!-- END 08-operator-planner-partial-assembly-and-autotuning.md -->

---

<!-- BEGIN 09-pr-sequence-tests-and-definition-of-done.md -->

# 09. Kolejność PR, testy i Definition of Done

W bieżącym worktree wykonano część zmian z PR-00–PR-13 (kontrakty źródłowe,
fail-closed paths i testy kontraktowe). Poniższa kolejność nadal opisuje bramy
kwalifikacyjne: bez managed GPU, parytetu naukowego i benchmarku żaden PR nie
jest oznaczony jako produkcyjnie zamknięty.

## 1. Reguła

Każdy PR ma jeden główny mechanizm, test/licznik przed optymalizacją,
compatibility path, managed GPU A/B i nie zmienia tolerancji razem z kernelem.

## 2. Sekwencja

### PR-00 — baseline i snapshot

Runtime performance owner, ABI v1 i SP4 managed benchmark. Zachować istniejący
strict receipt, execution masks, transfer audit, step stats, endpoint telemetry
i phase event ownership; nie implementować ich ponownie. Zachować istniejący
Ada-specific gate exportera (`8.9`, `fullmag_fem=sm_89`, `hypre=sm_89`), a
stałe wymaganie `sm_89` zastąpić mapowaniem wykrytego compute capability i
zapisać wynik z digestem bundle w immutable benchmark receipt.

### PR-01 — HYPRE owner + conditional RHS norm

Usuwa duplicate setters; omija normę w converged relative-only.

### PR-02 — demag FieldOnly

Zero stage energy w RK, final energy parity.

### PR-03 — LLG no-metric + output mask v2

Bez intermediate reduction; control stopping nadal działa.

### PR-04 — deferred normalizer + control packet

Zero normalizer readbacks; one fence/attempt; rollback.

### PR-05 — adaptive specializations

ErrorOnly bez acos; one typed reduction.

### PR-06 — BS23 endpoint reuse

Warm accepted = 3 RHS/3 demag.

### PR-07 — DP54 exact endpoint + FSAL slot

Exact state, no duplicate RHS/copy.

### PR-08 — fused exchange xyz

Row scale, offdiag CSR, strict fused kernel.

### PR-09 — accumulation variants + row mapping

Qualified accurate mode and static profiles.

### PR-10 — periodic reduced exchange

No O(N²), full field/energy/direct-energy parity.

### PR-11 — fused recovery + H_eff

Shared pattern recovery, compose launches, lazy fields.

### PR-12 — typed multi-channel reductions

Adaptive/Armijo/NCG proofs.

### PR-13 — NCG preconditioner

Diagonal first, correct PR+, time-to-tolA.

### PR-14 — purpose-dependent Poisson tolerance

Dopiero po pełnej kwalifikacji; default bez zmian.

### PR-15 — operator planner/PA

Qualified profile i break-even.

## 3. Testy każdego PR

Statyczne:

- source ownership,
- ABI layout,
- forbidden sync/allocation,
- CMake registration.

Actual GPU:

- operator fixture,
- accepted step,
- reject/failure,
- SP4 smoke,
- transfer/receipt snapshot.

Fizyka:

- field/energy,
- residual,
- macrospin/norm,
- damping energy,
- trajectory,
- PBC/frozen, gdy dotyczy.

## 4. A/B policy

- identyczny mesh digest,
- 8 warmup,
- >=31 micro repeats albo 64 steps,
- median/p95,
- bez GUI dla solver benchmarku,
- pełny device/build provenance.

Proponowane początkowe progi po zmierzeniu szumu:

```text
correctness/receipt fail -> block
median > 1.03 baseline -> investigate/block
p95 > 1.10 baseline -> investigate
work counter grows unexplained -> block
```

## 5. Managed commands

Zawsze sprawdzić aktualny `justfile`. Typowa sekwencja:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-fem-demag-poisson-contract
just verify-fem-time-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just fem-sp4-run gpu <output_dir>
```

Jeżeli target zmienił nazwę, użyć aktualnego odpowiednika z `just --list`.
Nie zastępować host buildem.
`fem-managed-headless` jest alternatywnym managed entrypointem.
`fem-gpu-headless` jest ścieżką ad hoc/diagnostyczną i nie spełnia tej bramki.

## 6. Dokumenty przy merge

- `docs/architecture/backend-golden-masterplan.md`
- `docs/physics/0560-all-in-gpu-fem-runtime.md`
- właściwe exchange/demag/RK/relaxation docs
- `docs/specs/capability-matrix-v0.md`
- provenance schema
- benchmark index.

## 7. Rollback

Każdy nowy operator ma compatibility implementation podczas kwalifikacji.
Rollback przełącza planner na poprzedni qualified kind i zachowuje telemetrię.
Niewalidowany feature flag nie jest publicznym production option.

## 8. Final DoD

Wykonanie:

```text
execution_class=device_resident
host_mask=0
unknown_mask=0
bulk hot-loop transfer=0
global sync=0
```

Warm no-reject RK23:

```text
rhs=3
demag_solves=3
exchange_applies=3
exchange_kernel_launches=3
stage_demag_energy=0
normalizer_readbacks=0
adaptive_readbacks=1
```

PBC:

```text
O(nnz_reduced + N lift)
no full source-row scan
```

Poprawność:

- operator/energy derivative,
- residual,
- temporal order,
- SP4,
- Armijo,
- frozen/PBC.

Produkcja:

- cubin matches GPU,
- actual-device CI,
- docs/capability/provenance,
- compatibility removal condition.

<!-- END 09-pr-sequence-tests-and-definition-of-done.md -->

---

<!-- BEGIN 10-finding-coverage-matrix.md -->

# 10. Macierz weryfikacji i pokrycia ustaleń

**Baza planu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`

**Zweryfikowano względem:** `c3f49db708868f3649a3e894416d230269718920`

**Zakres:** kod, testy kontraktowe i `justfile`; managed GPU runtime oraz wyniki
wydajnościowe: `NOT VERIFIED`.

Werdykt dotyczy diagnozy bieżącego kodu. W tym worktree część kontraktów
źródłowych, implementacji i testów kontraktowych z dokumentów 01–09 została
dodana. Samo istnienie symbolu nie oznacza jeszcze poprawnej kompilacji,
parytetu fizycznego ani kwalifikacji managed GPU; te lanes pozostają jawnie
oznaczone jako `NOT VERIFIED`.

| ID | Werdykt diagnozy | Dowód w aktualnym kodzie | Korekta / stan celu | Runtime i wydajność | PR |
|---|---|---|---|---|---|
| EX-01 | `POTWIERDZONE` | `exchange_operator.cpp::build_gpu_exchange_periodic_reduced_csr`, upload metadanych, `fullmag_cuda_periodic_reduced_exchange_xyz`, `fullmag_cuda_periodic_reduced_exchange_energy_blocks` i `fullmag_cuda_periodic_reduced_exchange_difference_blocks` tworzą/używają reduced CSR/mass/lift; stary kernel nadal istnieje jako kompatybilność | Reduced field/energy/direct-energy consumers są teraz spójne źródłowo; dowód stałości `m` w klasie periodycznej, parytet i promocja runtime nadal wymagają kwalifikacji | `NOT VERIFIED` | PR-10 |
| EX-02 | `POTWIERDZONE` | `rk_exchange_dispatch.cu::gpu_rk_compute_legacy_sparse_exchange` wybiera fused XYZ dla nieperiodycznego row-scale; split x/y/z pozostaje ścieżką zgodności | Fused XYZ i typed state istnieją źródłowo, lecz profil nie jest jeszcze publicznie zakwalifikowany | `NOT VERIFIED` | PR-08 |
| EX-03 | `CZĘŚCIOWO` | `exchange_operator.hpp` ma typed kinds `LegacySparse/FusedXYZ/PeriodicReduced/CuSparse/PartialAssembly`; DD pozostaje w kernelach relaksacji | Brak typowanych trybów strict/FMA i zwycięskiego wariantu precision; wymagana kwalifikacja profilu | `NOT VERIFIED` | PR-09 |
| EX-04 | `CZĘŚCIOWO` | `exchange_operator.cpp` ma deterministyczny resolver fail-closed i builder CSR; brak histogramu/autotune | Planner nie wybiera jeszcze wariantu na podstawie kosztu/nieregularności, a zysk pozostaje niezmierzony | `NOT VERIFIED` | PR-09 |
| EX-05 | `POTWIERDZONE` | `exchange_plan.cpp::gpu_exchange_plan_stage_exchange` już odrzuca consistent mass w strict GPU | Fail-closed zachować; device consistent-mass solver nie istnieje | `NOT VERIFIED` | później |
| EX-06 | `POTWIERDZONE` | `cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem` używa `AssemblyLevel::LEGACY` | Produkcyjny exchange PA/libCEED nadal nie istnieje; ogólny `pa_benchmark.cpp` nie jest dowodem exchange | `NOT VERIFIED` | PR-15 |
| EX-07 | `POTWIERDZONE` | `exchange_kernels.cu::exchange_row_scale_kernel` oraz lazy setup w dispatchu precomputują skalę wiersza | Row-scale istnieje źródłowo, ale koszt i poprawność dla wszystkich ścieżek nie mają jeszcze runtime proof | `NOT VERIFIED` | PR-08 |
| EX-08 | `POTWIERDZONE` | `build_gpu_exchange_off_diagonal_csr` usuwa diagonalę i deterministycznie scala duplikaty; obecny upload nadal może używać pełnego CSR | Builder kontraktowy istnieje, lecz off-diagonal CSR nie jest jeszcze globalnie podłączony do wszystkich konsumentów | `NOT VERIFIED` | PR-08 |
| RK-01 | `POTWIERDZONE` | `rk_attempt_control_kernels.cu` wykonuje deferred validation, a RK używa pinned `GpuRkAttemptControlPacket`; stary normalizer pozostaje kompatybilnością | Hot path ma odroczony packet i fail-closed fallback; pełny transfer audit oraz każda ścieżka legacy nie są jeszcze zunifikowane | `NOT VERIFIED` | PR-04 |
| RK-02 | `CZĘŚCIOWO` | `rk_adaptive_decision_readback.cu` czyta packet flags/error/norm/rotation jednym pinned D2H i fence | PI decision nadal jest hostowy, a packet nie jest jeszcze publicznym API v2 | `NOT VERIFIED` | PR-04 |
| RK-03 | `POTWIERDZONE` | `rk_stage_schedule.cu` publikuje endpoint token dla BS23/DP54 na ścieżce bez aktywnej projekcji okresowej, a `rk_final_refresh.cu` ma exact-time/signature FSAL reuse | Przy aktywnej mapie okresowej projekcja `m` jest wykonywana przed RHS, lecz FSAL jest fail-closed; bitowa tożsamość DP54 i wpływ na trajektorię wymagają testu managed/scientific | `NOT VERIFIED` | PR-06/07 |
| RK-04 | `POTWIERDZONE` | `gpu_rk_compute_rhs_for_magnetization(..., compute_metric)` pozwala pominąć stage metric; final RHS jawnie żąda metryki | Typed `NoMetric`/global reducer dla wszystkich konsumentów nie istnieje; obecny kontrakt jest częściowy | `NOT VERIFIED` | PR-03 |
| RK-05 | `POTWIERDZONE` | Attempt-control packet/journal i endpoint invalidation ograniczają rollback; pełne D2D backupy nadal są używane | Typed buffer roles i swap-on-accept nie są wdrożone | `NOT VERIFIED` | PR-07+ |
| RK-06 | `POTWIERDZONE` | `rk_step_stats.cu::finalize_step_stats_impl` nadal liczy finalne energie/observables bez output mask | Step request/output mask v2 nie istnieje | `NOT VERIFIED` | PR-03 |
| AD-01 | `POTWIERDZONE` | `adaptive_error_norm_blocks_kernel` używa dot/cosine zamiast per-node `acos`, z policy resolverem dla kanałów | Generic kernel nadal oblicza wspólne kanały; pełne wyspecjalizowane `ErrorOnly/ErrorAndNorm/Rotation` nie są gotowe | `NOT VERIFIED` | PR-05 |
| AD-02 | `POTWIERDZONE` | `rk_error_norm_runtime.cu` warunkowo uruchamia redukcje kanałów; rotation kończy się jednym device min + scalar `acos` | Typed `AdaptivePartial` i pojedynczy wspólny combine nie istnieją | `NOT VERIFIED` | PR-05 |
| AD-03 | `POTWIERDZONE` | Kernel nadal przyjmuje k0…k6 i runtime `stages > s` | BS23/DP54 specialization nie istnieje; wpływ na register pressure niezmierzony | `NOT VERIFIED` | PR-05 |
| DM-01 | `POTWIERDZONE` | `stage_compute.cpp` ma typed `GpuDemagEvaluationMode::FieldOnly`; RK i frequency tangent żądają FieldOnly | FieldOnly jest w źródle, ale parity każdego konsumenta i brak energii w publicznym snapshotcie wymagają runtime proof | `NOT VERIFIED` | PR-02 |
| DM-02 | `POTWIERDZONE` | `hypre_validation_policy.cpp` rozstrzyga RHS normę/independent residual; solver wywołuje je warunkowo | Force-independent policy nie jest jeszcze publiczną konfiguracją, a managed HYPRE proof nie istnieje | `NOT VERIFIED` | PR-01 |
| DM-03 | `POTWIERDZONE` | `operators.cpp`/`demag_kernels.cu` mają wspólny-pattern fused recovery z digestem i split fallback | Fused path jest fail-closed do zgodnego patternu; legalność i przewaga nie są zakwalifikowane | `NOT VERIFIED` | PR-11 |
| DM-04 | `CZĘŚCIOWO` | Istnieją wait/host API/device/iterations oraz fazowe timingi zapisywane do performance snapshot | Brak AMG level metrics i aktualnego A/B solverów; „host-paced bottleneck” pozostaje nieudowodniony | `NOT VERIFIED` | tuning |
| DM-05 | `CZĘŚCIOWO` | Wszystkie purpose nadal używają jednego `ctx.demag.solver.relative_tolerance`; nie dodano cichej zmiany defaultu | Purpose-dependent tolerance pozostaje hipotezą kwalifikacyjną | `NOT VERIFIED` | PR-14 |
| HF-01 | `POTWIERDZONE` | `rk_effective_field.cu` nadal składa component-wise, ale przekazuje rzeczywiste `has_external_field` zamiast stałego `true` | Fused base compose nie istnieje; ext on/off wymaga jawnego planu/testu | `NOT VERIFIED` | PR-11 |
| HF-02 | `POTWIERDZONE` | Separate field buffers i component-wise adds pozostają w `rk_effective_field.cu` | Lazy materialization i masks nie istnieją w plannerze/API | `NOT VERIFIED` | PR-11+ |
| RD-01 | `POTWIERDZONE` | `reduction_kernels.*` ma scalar sum/max, a LLG metric można wyłączyć dla stage RHS | Typed adaptive/Armijo/NCG/observable reducers nadal nie istnieją | `NOT VERIFIED` | PR-12 |
| RL-01 | `NOT VERIFIED` | `gpu_relaxation_preconditioner.cpp::build_gpu_relaxation_diagonal` tworzy tylko diagonalę; błędnie nazwana klasa nie używa off-diagonal CSR, setup nie jest podłączony do NCG/PG-BB, a benchmark odrzuca `exchange_mass` | Historyczny no-go pozostaje osobny; `diagonal` i pełny sparse `exchange_mass_cg4\|cg8` są zatwierdzonym projektem fazy 1. Capability, runtime, parity, physics i performance są nieudowodnione; default pozostaje `none` | `NOT VERIFIED` | faza 1 |
| RT-01 | `NIEPRAWDA` w pierwotnym brzmieniu | Istniejący strict receipt nadal odrzuca hybrid/host/unknown/maski/transfers; dodano transactional `GpuPerformanceCounterState`, C ABI snapshot i Rust validator | Snapshot nie jest jeszcze wpięty do pełnego publicznego provenance, a managed runtime pozostaje niezweryfikowany | `NOT VERIFIED` | PR-00 |
| MEM-01 | `CZĘŚCIOWO` | RK ma dedykowany pinned `GpuRkAttemptControlPacket`; inne redukcje nadal mają pinned scalar buffer z pageable fallback | Packet nie obejmuje jeszcze wszystkich control/data-plane readbacków | `NOT VERIFIED` | PR-04 |
| BL-01 | `CZĘŚCIOWO` | Inspektor i walidator bundle mają `--require-native-cubin`; `export_fem_gpu_runtime.sh` już wymaga domyślnie `8.9`, `fullmag_fem=sm_89` i `hypre=sm_89` | Brak ogólnego wykryte CC→`sm_xy` zamiast stałego `sm_89` oraz immutable benchmark receipt; historyczne `sm_52` nie dowodzi aktualnego `sm_89` | `NOT VERIFIED` | PR-00 |
| PA-01 | `POTWIERDZONE` | `exchange_operator.hpp/.cpp` ma jeden typed resolver dla legacy/fused/reduced/cuSPARSE/PA z fail-closed profile/VRAM/runtime gates | Planner i profile są kontraktem źródłowym, ale nie są jeszcze podłączone do publicznego runtime; SpMM/PA nie są produkcyjną realizacją | `NOT VERIFIED` | PR-15 |
| NEW-HYPRE-01 | `POTWIERDZONE` | `runtime/hypre_device_policy.cpp` jest jedynym właścicielem process-wide setterów; lokalna konfiguracja z solvera została usunięta | Solver-local tolerancje/iteracje pozostają w solver owner; trzeba potwierdzić build i HYPRE runtime | `NOT VERIFIED` | PR-01 |

## Reguła zamknięcia

Ustalenie może zostać oznaczone jako zamknięte wyłącznie, gdy jednocześnie:

1. wskazany kod produkcyjny jest zmieniony;
2. test RED został pokazany przed zmianą albo istnieje równoważny reproducer;
3. test GREEN przechodzi w managed runtime;
4. licznik dowodzi usunięcia pracy/barier, a nie tylko zmiany etykiety;
5. physics/numerics parity przechodzi;
6. benchmark pełnego kroku/time-to-solution nie regresuje;
7. capability/provenance odzwierciedla resolved implementation.

## Zależności

- `EX-03`, `EX-04`, `DM-04`, `DM-05`, `RL-01` i `PA-01` wymagają sprzętowej kwalifikacji; plan nie przesądza zwycięskiego wariantu.
- `RK-05` jest po `RK-03`, aby nie mieszać oszczędności duplicate RHS z refaktorem własności buforów.
- `DM-05` nie wchodzi przed stabilną telemetrią odrzuceń i trajektorii.
- `HF-02` zależy od output mask `RK-06`.
- `EX-01` obejmuje field, energy i direct-energy paths w jednym PR.

<!-- END 10-finding-coverage-matrix.md -->

---

