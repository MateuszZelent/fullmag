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

(limitations)=
## Ograniczenia

Stride 4 zwiększa częstość synchronizacji. Korzyść może być zerowa lub ujemna.
Ta nota nie zawiera nowych niepublicznych wyników pomiaru i nie stwierdza
kwalifikacji produkcyjnej. Dotychczasowy pełny SP4 jest baseline, a porównanie
nowego wariantu pozostaje do wykonania.

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
| `crates/fullmag-runner/src/native_fem/runtime_info.rs` | `gpu_pcg_control_experiment_from_ffi` | Validate actual native identity and terminal raw counters. Source only; runtime NOT VERIFIED. |
