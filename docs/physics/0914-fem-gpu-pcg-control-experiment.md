# Magnetostatyka — FEM GPU — eksperyment odczytu statusu PCG

Status: kontrakt eksperymentu; wykonanie i przyspieszenie **NOT VERIFIED**.
Model i jednostki pola określa [Poisson FEM](fem_demag_poisson.md), a tolerancje
[polityka solvera](0532-fem-demag-solver-policy-and-runtime-threading.md).

(problem-statement)=
## Zakres

Po osiągnięciu zbieżności urządzenie zamraża iterat rozwiązania. Host dowiaduje
się o zakończeniu dopiero po odczycie statusu na końcu paczki. Pozostałe
wywołania AMG w paczce mogą zatem kosztować czas mimo zerowego RHS. Porównujemy
paczki o długości 4 i 8, bez zmiany operatorów, tolerancji ani certyfikatu.

| Realizacja | Obsługa |
|---|---|
| FEM GPU | Jawny eksperyment: double, Poisson Robin/Dirichlet, CG/AMG, bez PBC |
| FEM CPU | Odrzucenie eksperymentu; inne sterowanie solverem |
| FDM CPU | Odrzucenie; brak tego solvera Poissona |
| FDM GPU | Odrzucenie; brak tego solvera Poissona |

(governing-equations)=
## Równania i niezmienniki

```{math}
:label: eq-pcg-control-system
K\phi=b,\qquad r=b-K\phi.
```

```{math}
:label: eq-pcg-control-batch
q=\min\{N-j,\;s\}\quad(j>0),\qquad
q=\min\{N,5,s\}\quad(j=0).
```

Zmienia się tylko moment hostowego odczytu statusu. GPU nadal kończy aktywną
rekurencję przy tym samym kryterium i zachowuje pierwsze zbieżne rozwiązanie.
Po każdej próbie pozostaje niezależny certyfikat prawdziwego residuum,
obliczany istniejącym kodem z aktualnych operatorów. Pierwsza paczka zachowuje
limit najwyżej siedmiu dodatkowych wywołań AMG po zatrzaśnięciu statusu,
wliczając do dwóch wywołań przed pętlą. Nie utożsamiamy wywołań API z pracą
wykonaną przez kernele AMG.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Token | Znaczenie | SI |
|---|---|---|
| $K$ | Macierz Poissona | $\mathrm{m}$ |
| $\phi$ | Potencjał skalarny | $\mathrm{A}$ |
| $b,r$ | RHS i prawdziwe residuum | $\mathrm{A\,m}$ |
| $q$ | Długość kolejnej paczki | $1$ |
| $s$ | Zadany limit paczki: 4 lub 8 | $1$ |
| $N$ | Limit iteracji solvera | $1$ |
| $j$ | Liczba już zleconych iteracji | $1$ |

(assumptions-and-validity)=
## Warunki stosowania

V1 wymaga jawnego FEM/GPU i podwójnej precyzji oraz aktywnego Poissona
Robin/Dirichlet z jawnie ustawioną polityką CG/AMG bez PBC. Brak jawnej polityki
jest błędem: istniejący domyślny runtime RK GPU może wybrać Jacobi. Pozostałe kombinacje są błędem przed
obliczeniami; nie ma cichego ignorowania ani fallbacku. Nie jest to nowa
domyślna polityka ani kwalifikacja FEM-BEM, eigensolve lub automatycznego
wyboru urządzenia. Brak eksperymentu zachowuje dotychczasowe pierwsze 5,
następnie 8 iteracji.

(python-api)=
## Jawna konfiguracja

Fragment dodawany do pełnego skryptu SP4 z etapami i sąsiednim Zarr:

```python
# %% Diagnostic contract; the surrounding simulation owns stages and outputs.
import fullmag as fm
fm.runtime_metadata("fem_gpu_pcg_control_experiment", {
    "schema_version": "fullmag.fem.gpu.pcg_control_experiment.v1",
    "status_batch_stride": 4,
})
```

| Parametr | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| fm.runtime_metadata(key, value) | str, dict | brak wpisu | $1$ | Zamknięty obiekt, oba pola wymagane | Klucz i konfiguracja diagnostyczna | FEM GPU | `problem_meta.runtime_metadata.fem_gpu_pcg_control_experiment` |
| schema_version | str | wymagany | $1$ | Dokładnie fullmag.fem.gpu.pcg_control_experiment.v1 | Identyfikacja kontraktu | FEM GPU | `problem_meta.runtime_metadata.fem_gpu_pcg_control_experiment.schema_version` |
| status_batch_stride | int | wymagany | $1$ | Wyłącznie 4 lub 8; bool/float/null są błędem | Maksymalna długość paczki | FEM GPU | `problem_meta.runtime_metadata.fem_gpu_pcg_control_experiment.status_batch_stride` |

(problem-ir)=
## ProblemIR i plan

Publiczna funkcja zachowuje obiekt metadata. Planner waliduje zamkniętą
strukturę i przenosi ją do opcjonalnego `FemPlanIR.gpu_pcg_control_experiment`.
Brak pola nie zmienia serializacji starych planów. Requested intent pozostaje
w ProblemIR; resolved execution pochodzi z natywnego gettera, nie z nazwy
skryptu lub etykiety Study.

(round-trip-and-failure-semantics)=
## Odtwarzanie i awarie

Eksport/import zachowuje metadata. Błędy walidacji (`validation errors`)
kończą przyjęcie eksperymentu; nieobsługiwane kombinacje
(`unsupported combinations`) nie degradują urządzenia. Nieznane klucze, zła wersja, niedozwolona
wartość lub realizacja odmawiają wykonania. Addytywny setter ABI po `create_v5`
ustawia politykę przed pierwszą fizyczną próbą PCG. Tworzenie GPU Context
przygotowuje operatory i AMG, lecz nie rozwiązuje magnetycznego RHS. Pierwsza
próba PCG nieodwracalnie blokuje setter, także przy błędzie. Reset workspace
nie cofa tej blokady ani surowych liczników Context. Istniejące ABI nie zmienia
rozmiarów; CPU i nieobsługiwany solver zwracają unavailable.

(discrete-realization)=
## Realizacja GPU

Stan sterowania i liczniki znajdują się w Context, poza workspace GPU i poza
transakcjami accepted/rejected. Getter terminalny odczytuje tylko pamięć hosta,
bez nowego D2H lub synchronizacji. Publikuje requested/resolved stride oraz
liczbę prób solve, zleconych iteracji i wywołań AMG w całym Context oraz
osobno dla `hot_loop_depth>0`. Liczniki obejmują także próby odrzucone i błędne;
nie zastępują istniejących liczników wykonanej aktywnej rekurencji.

### Zakres telemetryki C1, snapshot i rollback

Pola C1 w StepStats oraz legacy liczniki host/device opisują zakres publicznego
kroku integratora. `RkStepTransaction` zapisuje ich stan na granicy tego kroku
i odtwarza go przy zewnętrznym rollbacku całego kroku. Wewnętrzne ponowienia
adaptacyjnego RK w obrębie udanego publicznego kroku zachowują czas i liczniki
faktycznie wykonanej pracy: `RkAttemptCacheSnapshot::restore_preserving_attempt_counters`
unieważnia cache bez odtwarzania tych liczników. Przy rollbacku zewnętrznym
odtwarzany jest również skalarny zakres pomiaru
zdarzeń HYPRE: kursor puli, indeks aktywnej pary, liczniki ukończeń i przepełnień,
akumulator czasu, czasy enqueue oraz flaga aktywności. Uchwyty CUDA i pamięć puli
pozostają własnością workspace i nie są kopiowane.

Przygotowanie statystyk snapshotu rozpoczyna świeży zakres: zeruje liczniki
czasów host/device tego zakresu i kursor oraz akumulatory puli pomiarowej HYPRE,
zachowując już przygotowane zdarzenia. Surowe liczniki `GpuPcgControlRuntimeState`
pozostają kumulatywne przez życie Context; obejmuje to osobne liczniki wywołań
zarejestrowanych przy `hot_loop_depth>0`. Tak samo poza rollbackiem transakcji
pozostają fizyczne liczniki wydajności GPU. Osobną domeną jest
`TransferAudit.device_pcg_hot_loop`, który celowo współdzieli własność,
kopiowanie, reset i rollback pozostałych liczników hot-loop audytu. Jego wartości
opisują zakres audytu, a nie surową liczbę wywołań API PCG.

Zdarzenia CUDA mierzą przedział na strumieniu HYPRE ograniczony wokół wywołania
solver/apply HYPRE; nie izolują czasu poszczególnych kerneli. Hostowy
`step_solver_apply_wall_time_ns` obejmuje szerszą orkiestrację hosta i oczekiwania,
a `step_hypre_host_api_wall_time_ns` mierzy wywołanie API na hoście. Są to
nakładające się obserwacje różnych zakresów; czasu zdarzeń CUDA nie należy dodawać
do hostowego wall time.

(implementation-mapping)=
## Mapa implementacji

Polityka: `pcg_device_scalar_kernels.hpp::demag_pcg_next_batch_iterations`.
Wywołania: `hypre_device_solver.cpp::apply_demag_poisson_device_pcg`.
Stan: `control_state.hpp::GpuPcgControlRuntimeState` w `Context`.
Most: addytywne set/get `gpu_pcg_control_v1` w `fullmag_fem.h`, Rust FFI i
`NativeFemBackend`. Kontrakt metadanych waliduje planner, a finalizer zapisuje
terminalne liczniki do provenance obu workflow: RK i relaksacji.

(validation)=
## Walidacja

Wymagane: test zamkniętego metadata i round-trip, brak zmiany starego planu,
odrzucenie błędnych realizacji, zgodność layoutu C/Rust, natywny test obu
stride dla cold/warm/zero/nonfinite/failure i niezmiennego zamrożonego iteratu.
Następnie porównanie tego samego SP4 RK45 w kolejności przeplatanej 8/4,
z tą samą siatką, m0, gamma, tolerancjami i harmonogramem zapisu. Zachować
każdy `.py`, pełny Zarr, wszystkie energie, pola, torque i certyfikat.
Przyspieszenie wymaga zmierzonego czasu; liczba wywołań nie jest jego dowodem.
Kontrakt C1 jest pokryty regresjami w istniejącym `fem_demag_poisson_contract`:
`direct_pgbb_performance_lifecycle_contract` przebiega z profilingiem wyłączonym
i włączonym, sprawdza świeży zakres snapshotu oraz przywrócenie zakresu po
rollbacku, a `hypre_apply_timing_scope_helpers_round_trip_contract` sprawdza pustą
obserwację CPU/stub i odtworzenie skalarnego stanu bez zmiany tożsamości puli.
`cuda_demag_timing_contract` sprawdza źródłowe podpięcie resetu, pomiaru i
rollbacku. Te regresje wymagają jeszcze uruchomienia w zarządzanym środowisku
native FEM; test GPU/runtime pozostaje **PENDING / NOT VERIFIED**.

(limitations)=
## Ograniczenia

Stride 4 zwiększa częstość synchronizacji. Korzyść może być zerowa lub ujemna.
Ta nota nie zawiera nowych niepublicznych wyników pomiaru i nie stwierdza
kwalifikacji produkcyjnej. Dotychczasowy pełny SP4 jest baseline, a porównanie
nowego wariantu pozostaje do wykonania. Osobny wewnętrzny wariant równoległej
redukcji tych samych norm opisuje [nota o normach certyfikatu Poissona](0915-fem-gpu-poisson-parallel-certificate-norms.md); nie dodaje on nowego parametru Python ani ProblemIR.

(scientific-bibliography)=
## Źródła

- [Kanoniczny model Poissona FEM](fem_demag_poisson.md).
- [Polityka i certyfikat solvera](0532-fem-demag-solver-policy-and-runtime-threading.md).
- [Realizacja preconditionera AMG GPU](0913-fem-gpu-amg-coarse-residency.md).

(source-code-index)=
## Indeks kodu i dowodów

Równania i kontrakty są powiązane z symbolami w sąsiednim source-map. Status
runtime pozostaje NOT VERIFIED do uzyskania nowych receiptów i wyników.

| Ścieżka | Symbol | Odpowiedzialność / dowód |
|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/pcg_device_scalar_kernels.hpp` | `demag_pcg_next_batch_iterations` | Schedule bounded status batches without changing the active recurrence. Source only; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `apply_demag_poisson_device_pcg` | Apply retained AMG and count raw submissions at their call sites. Source only; runtime NOT VERIFIED. |
| `crates/fullmag-ir/src/plan.rs` | `FemGpuPcgControlExperimentIR` | Typed closed diagnostic request and schema/domain validation. Source only; runtime NOT VERIFIED. |
| `crates/fullmag-plan/src/pcg_control_experiment.rs` | `request` | Reject unsupported lanes before planning. Source only; runtime NOT VERIFIED. |
| `crates/fullmag-runner/src/fem/gpu_terminal_provenance.rs` | `gpu_pcg_control_experiment_from_ffi` | Validate actual native identity and terminal raw counters. Dedicated default-feature test selection added; CI and runtime verification pending. |
| `backends/fem/cpu/mfem/runtime/snapshot.cpp` | `context_snapshot_stats_mfem` | Rozpoczyna świeży zakres liczników C1 i pomiaru HYPRE dla snapshotu. Źródło; runtime NOT VERIFIED. |
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp` | `capture_poisson_step_state` | Zapisuje hostowe pola C1 na granicy zewnętrznego publicznego kroku; integracja rollbacku jest w `RkStepTransaction::rollback`. Źródło; runtime NOT VERIFIED. |
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp` | `RkStepTransaction::rollback` | Przywraca zakres całego publicznego kroku oraz audyt hot-loop; surowe liczniki sterowania pozostają poza transakcją. Źródło; runtime NOT VERIFIED. |
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp` | `RkAttemptCacheSnapshot::restore_preserving_attempt_counters` | Unieważnia cache wewnętrznej próby RK, zachowując koszt jej wykonania w publicznym kroku. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp` | `capture_hypre_apply_timing_scope` | Deklaruje zapis skalarnych danych puli HYPRE bez kopiowania uchwytów CUDA. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp` | `restore_hypre_apply_timing_scope` | Deklaruje odtworzenie kursora, akumulatorów i aktywnej pary pomiaru HYPRE. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Ogranicza zdarzeniowy pomiar urządzenia do zakresu HYPRE apply na strumieniu HYPRE. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/demag_poisson/control_state.hpp` | `record_solve_attempt` | Utrzymuje kumulatywne liczniki wywołań PCG, także dla zakresu hot-loop. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/runtime/performance_counters.cpp` | `gpu_performance_reject_attempt` | Zachowuje fizyczną pracę odrzuconej próby w liczniku lifetime. Źródło; runtime NOT VERIFIED. |
| `backends/fem/gpu/cuda/transfer/transfer_audit.hpp` | `record_device_pcg_solve_started` | Deklaruje licznik audytu PCG hot-loop, który współdzieli rollback z pozostałym audytem. Źródło; runtime NOT VERIFIED. |
| `backends/fem/tests/demag_poisson_contract.cpp` | `fullmag_fem_backend_snapshot_stats` | Unikalny punkt wywołania publicznego API w regresji PGBB, świeżego zakresu snapshotu i rollbacku z profilingiem on/off; native PENDING. |
| `backends/fem/tests/demag_poisson_contract.cpp` | `restore_hypre_apply_timing_scope` | Unikalny punkt wywołania helpera w regresji round-trip zakresu HYPRE i pustej obserwacji CPU/stub; native PENDING. |
| `backends/fem/tests/cuda_demag_timing_contract.cpp` | `main` | Źródłowa kontrola granic pomiaru, resetu snapshotu i rollbacku; native PENDING. |
