# Audyt skalowania i wydajności solverów FEM CPU w Fullmagu

**Data:** 2026-09-01  
**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Analizowany commit:** `cdb3c135901b950871291610c6ba45e62f8cb90a`  
**Zakres:** natywny backend FEM CPU, relaksacja, dynamika LLG, demagnetyzacja Poisson i FEM/BEM, solver częstotliwościowy, eigensolver, konfiguracja OpenMP/MPI, dwa gniazda CPU, wykonanie wielowęzłowe HPC oraz infrastruktura benchmarkowa.  
**Rodzaj audytu:** statyczna analiza kodu i konfiguracji budowania. W ramach tego audytu nie wykonano pomiarów produkcyjnego przypadku na docelowym serwerze ani klastrze; wszystkie przewidywania wydajnościowe wymagają potwierdzenia benchmarkami opisanymi w rozdziale 15.

---

## 1. Streszczenie wykonawcze

### 1.1. Najważniejszy wniosek

Niskie wykorzystanie CPU nie wynika z jednego brakującego przełącznika. Aktualny backend FEM CPU jest zasadniczo **jednoprocesowym solverem szeregowym z punktowo dodanym OpenMP**, a nie pełnym hybrydowym solverem MPI+OpenMP.

W kodzie istnieje mechanizm wyboru liczby wątków, lecz:

1. nie wszystkie warstwy otrzymują tę samą, jednoznaczną konfigurację;
2. `OMP_NUM_THREADS` może po cichu przesłonić `FULLMAG_CPU_THREADS`;
3. domyślna konfiguracja Windows Docker ustawia `OMP_NUM_THREADS=16`, więc żądanie 20 lub 30 wątków wyłącznie przez `FULLMAG_CPU_THREADS` może pozostać nieskuteczne;
4. automatyczny dobór ogranicza małe i średnie przypadki do 8 albo 16 wątków;
5. tylko kilka własnych pętli backendu ma dyrektywy OpenMP;
6. kanoniczny obraz FEM CPU buduje MFEM z OpenMP, ale ścieżka kompilowana bez CUDA konfiguruje urządzenie MFEM na sztywno jako `"cpu"`, a nie `"omp"`;
7. najcięższe obiekty MFEM są klasami szeregowymi: `Mesh`, `FiniteElementSpace`, `GridFunction`, `BilinearForm`, `SparseMatrix`;
8. macierze Hypre są opakowywane na `MPI_COMM_SELF` z partycją `{0,N}`, więc jedna symulacja nie jest dzielona między rangi;
9. PETSc/SLEPc również używają `PETSC_COMM_SELF`, `MatCreateSeqAIJ`, `MatCreateSeqDense` i wektorów sekwencyjnych;
10. w gorących ścieżkach nadal występują pełne hashe danych, alokacje, kopie AoS/SoA, trzy osobne przebiegi dla składowych wektora, atomiki, ponowne budowanie solverów i preconditionerów oraz gęste reprezentacje macierzy.

W rezultacie ustawienie `30` lub `64` wątków może zwiększyć liczbę wątków procesu, lecz nie oznacza, że 30 lub 64 rdzenie otrzymają równomierną pracę.

### 1.2. Co jest możliwe obecnie

Po małej poprawce konfiguracji można uzyskać kontrolowany tryb jednowęzłowy:

- jawny wybór 1, 2, 4, 8, 20, 30 albo wszystkich fizycznych rdzeni;
- przypięcie wątków do rdzeni;
- świadome porównanie `OMP_PROC_BIND=close` i `spread`;
- uruchomienie MFEM z backendem `omp`;
- poprawne raportowanie rzeczywistej liczby wątków;
- równoległe wykonanie większej liczby własnych pętli wektorowych;
- ograniczenie narzutów alokacji, hashy i ponownego setupu solverów.

To powinno przynieść największy efekt przy relatywnie małym ryzyku, ale nie zapewni skalowania jednej symulacji na wiele węzłów.

### 1.3. Co wymaga przebudowy architektury

Rzeczywiste wykorzystanie:

- dwóch gniazd CPU przez hybrydę „ranga MPI na domenę NUMA + OpenMP wewnątrz rangi”;
- całego serwera wieloprocesorowego bez kosztownych zdalnych dostępów NUMA;
- wielu węzłów HPC;
- rozproszonego PETSc/SLEPc;
- rozproszonej demagnetyzacji i globalnych redukcji,

wymaga migracji z serialnych klas MFEM do:

- `mfem::ParMesh`,
- `mfem::ParFiniteElementSpace`,
- `mfem::ParGridFunction`,
- `mfem::ParBilinearForm` / `mfem::ParLinearForm`,
- rozproszonych `mfem::HypreParMatrix`,
- wektorów lokalnych z mapą true DOF,
- halo/ghost exchange,
- kolektywnych redukcji MPI,
- rozproszonych zapisów wyników lub kontrolowanego gatheru.

Samo zastąpienie `MPI_COMM_SELF` przez `MPI_COMM_WORLD` jest błędne: obecnie każda ranga posiadałaby pełną macierz i pełną partycję, więc nie powstałby solver rozproszony.

### 1.4. Priorytety

| Priorytet | Zmiana | Charakter |
|---|---|---|
| P0 | Ujednolicić konfigurację wątków i naprawić benchmark 4/8/20/30/40 | błąd sterowania i pomiaru |
| P0 | Włączyć i certyfikować MFEM `"omp"` w obrazie CPU | brak wykorzystania zbudowanego backendu |
| P0 | Usunąć fałszywy limit 256 MiB w odzyskiwaniu pola demag | bezpośrednie ograniczenie liczby wątków |
| P0 | Zastąpić pełne hashe hot-path licznikami rewizji | narzut seryjny w każdym kroku/stage |
| P0 | Zrównoleglić i scalić pętle LLG, RK, pól lokalnych, masek i kopii | duża część kroku nadal szeregowa |
| P0 | Wprowadzić trwałe bufory i operatory wieloprawej strony dla 3 składowych | alokacje i trzy osobne przejścia |
| P0 | Cache tangent-plane: graf macierzy, solver, preconditioner i warm start | koszt powtarzany w line search |
| P0 | Solver częstotliwościowy: zachować rzadkość, reuse PETSc i usunąć globalny mutex z poziomu całego solve | obecna ścieżka nie skaluje |
| P1 | NUMA/affinity oraz jeden budżet współbieżności dla OpenMP, BLAS, Hypre i Rust | stabilność na dużych CPU |
| P1 | Kolorowanie/segmentowana redukcja demag zamiast atomików | ograniczenie contention |
| P1 | Ocenić MFEM 4.9 oraz partial assembly/libCEED CPU | większa przepustowość operatorów |
| P2 | Migracja solvera domenowego do Parallel MFEM + MPI | dwa sockety i wiele węzłów |
| P2 | Rozproszony PETSc/SLEPc i grupy MPI dla częstotliwości/shiftów | skalowanie frequency/eigen |
| P2 | Skompresowany BEM: H/H²/ACA/FMM | usunięcie bariery `O(N_b²)` |


### 1.5. Rejestr ustaleń

| ID | Ważność | Ustalenie | Główne miejsce w kodzie | Zalecenie |
|---|---|---|---|---|
| CPU-001 | krytyczna | numeryczne `OMP_NUM_THREADS` przesłania numeryczne `FULLMAG_CPU_THREADS` | `runtime/cpu_threads.cpp::requested_cpu_threads()` | jedno źródło prawdy i jawna walidacja konfliktu |
| CPU-002 | wysoka | benchmark 4/8/20/40 ustawia tylko `FULLMAG_CPU_THREADS`, ignoruje możliwe `OMP_NUM_THREADS=16` i ukrywa awarie przez `|| true` | `scripts/bench_fem_cpu_scaling.sh` | naprawić środowisko, fail-fast i receipt observed team |
| CPU-003 | wysoka | `auto` ogranicza kontekst do 8/16 wątków na podstawie wspólnej heurystyki | `runtime/cpu_threads.cpp::auto_cpu_thread_cap_for_context()` | polityka per faza oparta na benchmarku |
| CPU-004 | krytyczna | obraz CPU-only buduje MFEM z OpenMP, ale inicjalizuje `mfem::Device("cpu")` | `runtime/mfem_context.cpp` w gałęzi bez CUDA | honorować `FULLMAG_FEM_MFEM_DEVICE=omp` |
| CPU-005 | wysoka | jawne OpenMP obejmuje tylko niewielką część własnych hot-pathów | `integrators/*`, `interactions/*`, `relaxation/*` | wspólna warstwa kerneli OpenMP/SIMD |
| CPU-006 | wysoka | brak polityki affinity, cpuset i NUMA | compose/skrypty runtime | `OMP_PLACES`, `OMP_PROC_BIND`, hwloc/cpuset receipt |
| CPU-007 | krytyczna dla HPC | domena używa serialnych `Mesh`, `FiniteElementSpace`, `GridFunction`, `BilinearForm` | `runtime/mfem_context.cpp` i lifecycle operatorów | migracja do Parallel MFEM |
| CPU-008 | krytyczna dla HPC | Hypre otrzymuje pełną serialną macierz na `MPI_COMM_SELF` | `runtime/mpi_init.hpp`, wrappery Hypre | rank-local `HypreParMatrix` na communicatorze domeny |
| CPU-009 | krytyczna dla HPC | PETSc/SLEPc używa `PETSC_COMM_SELF` i obiektów `Seq*` | `cpu/frequency_domain/*` | `MPIAIJ`, rozproszone wektory i EPS/KSP |
| CPU-010 | wysoka | pełne hashe niezmiennych danych są wykonywane w hot path | dependency/operator key functions | monotoniczne liczniki rewizji |
| CPU-011 | wysoka | exchange wykonuje trzy osobne SpMV/solve dla x/y/z | `exchange_field.cpp`, `exchange_mass_projection.cpp` | block-RHS/SpMM i wspólny preconditioner |
| CPU-012 | średnia/wysoka | coefficient callback wykonuje `std::find` po aktywnych elementach | `AdapterBackedElementwiseCoefficient::Eval()` | bezpośrednia maska/mapa `O(1)` |
| CPU-013 | krytyczna | recovery demag zmniejsza team według hipotetycznych pełnych buforów per-thread, których nie alokuje | `demag_poisson_recovery.cpp` | usunąć fałszywy cap 256 MiB |
| CPU-014 | wysoka | scatter recovery używa wielu atomików do współdzielonych węzłów | `demag_poisson_recovery.cpp` | kolorowanie lub segmentowana redukcja |
| CPU-015 | wysoka | pole fizyczne i pełnodomenowe pole wizualne są odzyskiwane zawsze | `demag_poisson_recovery.cpp` | cadence i tryb `physical_only` |
| CPU-016 | krytyczna | FEM/BEM materializuje gęsty operator `N_b²` | `demag_fem_bem_operator.cpp` | H/H²/ACA/FMM; krótkoterminowo BLAS i trwałe bufory |
| CPU-017 | wysoka | LLG/RK/lokalne pola wykonują wiele seryjnych pełnych przejść | `llg_rhs.cpp`, `rk_explicit_step.cpp`, `effective_field.cpp` | zrównoleglenie i fuzja pętli |
| CPU-018 | krytyczna | TPI składa `2N×2N`, tworzy solver i preconditioner ponownie dla prób line search | `tangent_plane_implicit.cpp` | cache pattern/symbolic setup, numeric update, warm start |
| CPU-019 | wysoka | relaksacja nadal tworzy duże tymczasowe wektory i obiekty solverów | `relaxation_math.cpp`, PGBB/NCG/TPI | persistent workspace i solver lifecycle |
| CPU-020 | krytyczna | „sparse direct” przyjmuje gęste `N×N`, skanuje `N²` i tworzy real-split CSR | `cpu_sparse_direct_engine.cpp`, `assemble_real_split_csr.cpp` | zachować sparse/block representation od assembly |
| CPU-021 | wysoka | PETSc KSP/PC/Mat/Vec są odtwarzane dla każdego solve | frequency-domain adapters | trwały kontekst, symbolic/numeric reuse, wiele RHS |
| CPU-022 | wysoka | globalny mutex obejmuje całe wybrane solve'y PETSc/SLEPc | frequency-domain adapters | `call_once` tylko dla init, konteksty per grupa |
| CPU-023 | średnia | kanoniczny obraz CPU wyłącza SLEPc | `docker/fem-cpu/Dockerfile` | osobny certyfikowany obraz frequency/eigen |
| CPU-024 | wysoka | distributed scaffold po stronie Rust nie stanowi ścieżki wykonania native FEM | `crates/fullmag-engine/src/distributed.rs` | spięcie ownership/halo/redukcji z ParMFEM |
| CPU-025 | średnia | metryki opisują requested/effective, ale nie obserwowany team, affinity, NUMA i biblioteki | `runtime/step_metrics.cpp` | pełny execution receipt |
| CPU-026 | wysoka | output/snapshot zakłada pełny stan procesu | runner i artifact pipeline | rank-local chunking i kontrolowany preview gather |


---

## 2. Metodyka i ograniczenia audytu

Analiza objęła:

- śledzenie konfiguracji `FULLMAG_CPU_THREADS`, `OMP_NUM_THREADS` i MFEM Device;
- wyszukanie wszystkich jawnych regionów OpenMP w `backends/fem/cpu/mfem`;
- sprawdzenie użycia `MPI_COMM_SELF`, `PETSC_COMM_SELF`, klas sekwencyjnych i klas równoległych;
- analizę cyklu życia macierzy, solverów, preconditionerów i buforów;
- analizę ścieżek exchange, demag Poisson, FEM/BEM, LLG/RK, relaksacji i frequency-domain;
- analizę benchmarku skalowania CPU;
- porównanie architektury z wymaganiami MFEM, Hypre, PETSc/SLEPc i hybrydowego MPI+OpenMP.

Nie wykonano:

- kompilacji obrazu Docker;
- benchmarków na Windows/Docker Desktop;
- profilowania `perf`, VTune, LIKWID lub Nsight Systems;
- pomiarów na dwugniazdowym serwerze;
- uruchomień Slurm;
- walidacji bitowej wyników po proponowanych zmianach.

Wnioski oznaczone jako „potwierdzone” wynikają bezpośrednio z kodu. Wnioski o spodziewanym przyspieszeniu są hipotezami inżynierskimi i muszą przejść bramki pomiarowe.

---

## 3. Obecna mapa wykonania FEM CPU

### 3.1. Warstwa sterująca

Runner tworzy plan, inicjalizuje backend natywny i wywołuje przez FFI:

- relaksację;
- kroki dynamiki;
- snapshoty pól;
- solvery częstotliwościowe i modalne.

Istnieją już wartości `requested_omp_threads`, `effective_omp_threads` i `cpu_thread_cap_reason` w statystykach kroku. To dobry fundament, ale telemetria opisuje głównie zamiar runtime'u, a nie pełny stan sprzętu i bibliotek.

### 3.2. Natywny kontekst MFEM

Kontekst buduje:

- `mfem::Mesh`;
- `mfem::H1_FECollection`;
- `mfem::FiniteElementSpace`;
- osobne `GridFunction` i `Vector` dla `m_x`, `m_y`, `m_z`;
- serialne formy i macierze.

Jest to model pełnej domeny w jednym procesie i jednej przestrzeni adresowej.

### 3.3. Solvery liniowe

Hypre jest używany jako biblioteka solverowa, ale pełna serialna `mfem::SparseMatrix` jest opakowywana jako `HypreParMatrix` na `MPI_COMM_SELF`, z lokalnym zakresem wierszy równym całej macierzy.

To daje dostęp do implementacji Hypre, lecz nie daje podziału domeny między rangi.

### 3.4. Frequency-domain

PETSc/SLEPc otrzymują:

- sekwencyjne macierze `SeqAIJ` albo `SeqDense`;
- sekwencyjne wektory;
- `PETSC_COMM_SELF`;
- bezpośredni LU lub shift-invert;
- globalne mutexy procesu w wybranych wejściach.

Ta ścieżka może wykorzystywać wątki wewnętrznego pakietu LU, jeżeli taki pakiet jest dostępny i skonfigurowany, ale sam kod Fullmaga nie tworzy macierzy rozproszonej ani nie używa rang MPI.

---

## 4. Konfiguracja liczby wątków — potwierdzone problemy

### 4.1. Niejednoznaczna precedencja

`requested_cpu_threads()` stosuje następującą kolejność:

1. `FULLMAG_CPU_THREADS=auto`;
2. numeryczne `OMP_NUM_THREADS`;
3. numeryczne `FULLMAG_CPU_THREADS`;
4. liczba wykrytych procesorów.

Oznacza to, że:

```text
FULLMAG_CPU_THREADS=30
OMP_NUM_THREADS=16
```

daje **16**, nie 30.

W `compose.windows.yaml` oba serwisy mają domyślnie:

```yaml
FULLMAG_CPU_THREADS: "${FULLMAG_CPU_THREADS:-auto}"
OMP_NUM_THREADS: "${OMP_NUM_THREADS:-16}"
```

Jeżeli użytkownik nadpisze tylko `FULLMAG_CPU_THREADS=20` albo `30`, istniejące `OMP_NUM_THREADS=16` wygra.

### 4.2. Automatyczny limit 8/16 wątków

Tryb `auto` ogranicza liczbę wątków:

- do 8, gdy `node_count <= 10000` **lub** `element_count <= 75000`;
- do 16, gdy `node_count <= 50000` **lub** `element_count <= 400000`;
- bez ograniczenia dopiero dla większego przypadku.

Użycie operatora logicznego `||` powoduje, że wystarczy spełnienie jednego warunku. Siatka z relatywnie dużą liczbą węzłów, ale mniejszą liczbą elementów, nadal może zostać ograniczona.

Limit jest stosowany globalnie do kontekstu, choć poszczególne fazy mają bardzo różny optymalny rozmiar zespołu. Demag, DMI, LLG i małe redukcje nie powinny dziedziczyć jednej identycznej heurystyki.

### 4.3. Zmiana środowiska po starcie procesu

Kod wywołuje `omp_set_num_threads()`, co jest właściwe dla własnych późniejszych regionów OpenMP. W trybie `auto` zapisuje także `OMP_NUM_THREADS` przez `setenv()`/`_putenv_s()`.

Nie można jednak zakładać, że wszystkie biblioteki odczytają zmienną środowiskową zmodyfikowaną po inicjalizacji runtime'u. Hypre, BLAS, OpenMP i moduły ładowane wcześniej mogą już mieć własny stan. Konfiguracja musi zostać rozstrzygnięta przed załadowaniem backendu natywnego albo przekazana przez ich API.

### 4.4. Brak affinity i informacji o cpuset

W repozytorium nie znaleziono konfiguracji:

- `OMP_PLACES`;
- `OMP_PROC_BIND`;
- `OMP_DISPLAY_AFFINITY`;
- `GOMP_CPU_AFFINITY`;
- `numactl`;
- `taskset`;
- `--cpu-bind` dla Slurm;
- kontroli cgroup cpuset/quota.

Bez affinity system operacyjny może migrować wątki między rdzeniami i socketami. Na maszynie dwugniazdowej dane zainicjalizowane na jednym węźle NUMA mogą być czytane przez rdzenie drugiego socketu, zwiększając opóźnienie i obciążenie interconnectu.

### 4.5. Brak jednego budżetu współbieżności

Proces może równocześnie zawierać:

- OpenMP Fullmaga;
- OpenMP Hypre;
- wątki biblioteki BLAS;
- pulę Rayon/Rust;
- wątki writerów i usług.

Bez centralnego budżetu łatwo o oversubscription, np. 30 wątków OpenMP × 30 wątków BLAS.

### 4.6. Zalecany kontrakt

Należy wprowadzić jeden obiekt `CpuExecutionPolicy`, rozstrzygany przed inicjalizacją MFEM/Hypre:

```cpp
struct CpuExecutionPolicy {
    int requested_logical_threads;
    int effective_openmp_threads;
    int physical_core_count;
    int logical_cpu_count;
    int socket_count;
    int numa_domain_count;
    int cpuset_cpu_count;
    bool use_smt;
    enum class Placement { compact, spread, socket_local } placement;
    enum class Source { plan, environment, slurm, auto_policy } source;
};
```

Zasady:

- wartość z planu Fullmaga jest źródłem prawdy;
- `OMP_NUM_THREADS` jest generowane z planu przed startem natywnego runtime'u, nie konkurencyjnym ustawieniem;
- konflikt plan/env powoduje jawny warning albo błąd, nie ciche przesłonięcie;
- domyślne `auto` wybiera rdzenie dostępne w cpuset, nie host-wide `hardware_concurrency`;
- osobno raportowane są rdzenie fizyczne i SMT;
- affinity jest częścią kontraktu uruchomienia;
- BLAS ma domyślnie 1 wątek, chyba że konkretna faza jawnie przekazuje budżet do solvera bezpośredniego.

### 4.7. Minimalna konfiguracja do testów już teraz

Do czasu naprawy precedencji należy zawsze ustawiać obie zmienne na tę samą wartość:

```bash
export FULLMAG_CPU_THREADS=30
export OMP_NUM_THREADS=30
export OMP_DYNAMIC=FALSE
export OMP_MAX_ACTIVE_LEVELS=1
export OMP_PLACES=cores
export OMP_PROC_BIND=close
export OMP_DISPLAY_ENV=VERBOSE
export OMP_DISPLAY_AFFINITY=TRUE
export MKL_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1
```

Na dwóch socketach należy porównać co najmniej:

```bash
OMP_PROC_BIND=close
OMP_PROC_BIND=spread
```

Nie należy zakładać, że `spread` zawsze wygra. Dla operatorów ograniczonych przepustowością pamięci rozłożenie po socketach może zwiększyć dostępne pasmo; dla struktur zainicjalizowanych lokalnie może pogorszyć wynik przez zdalne dostępy NUMA.

---

## 5. MFEM OpenMP: biblioteka jest zbudowana, ale kanoniczny CPU runtime go nie wybiera

### 5.1. Stan obrazu CPU

`docker/fem-cpu/Dockerfile` buduje:

- Hypre 2.32.0 z `--with-openmp` i MPI;
- MFEM 4.7 z `MFEM_USE_MPI=YES`;
- MFEM z `MFEM_USE_OPENMP=YES`;
- bez METIS;
- bez libCEED;
- `FULLMAG_FEM_WITH_SLEPC=OFF`.

Sama obecność OpenMP w kompilacji nie oznacza aktywacji backendu MFEM `"omp"`.

### 5.2. Błąd ścieżki bez CUDA

W `context_initialize_mfem()`:

- ścieżka kompilowana z CUDA potrafi utworzyć `mfem::Device(host_device)`;
- ścieżka `#else`, czyli kanoniczny obraz CPU bez CUDA runtime, tworzy na sztywno:

```cpp
global_device = new mfem::Device("cpu");
```

W konsekwencji `FULLMAG_FEM_MFEM_DEVICE=omp` nie jest honorowane w najważniejszym obrazie CPU.

### 5.3. Wymagana naprawa

Ścieżka CPU-only powinna używać:

```cpp
const char *host_device = configured_mfem_device_string(ctx);
global_device = new mfem::Device(
    host_device != nullptr && *host_device != '\0' ? host_device : "omp");
```

Domyślny wybór `"omp"` powinien być uzależniony od:

- `_OPENMP`;
- `MFEM_USE_OPENMP`;
- kontraktu obrazu;
- testu `mfem::Device::Allows(mfem::Backend::OMP_MASK)`.

Fallback do `"cpu"` musi być jawnie raportowany.

### 5.4. Ważne ograniczenie

Włączenie `"omp"` nie zrównolegli automatycznie każdej klasycznej operacji. Duża część kodu używa:

- legacy/full assembly;
- serialnych `SparseMatrix`;
- własnych callbacków współczynników;
- ręcznych pętli C++;
- sekwencyjnych etapów solvera.

Jest to konieczna poprawka, lecz nie pełne rozwiązanie.

### 5.5. Test kontraktowy

Nowy test obrazu CPU powinien sprawdzać:

1. `_OPENMP` jest zdefiniowane;
2. `omp_get_max_threads()` odpowiada polityce;
3. `FULLMAG_FEM_MFEM_DEVICE=omp` daje backend `omp`;
4. `mfem::Device::Print()` trafia do receiptu diagnostycznego;
5. przynajmniej jeden operator MFEM wykonuje się w regionie wielowątkowym;
6. brak cichego fallbacku do `cpu`.

---

## 6. Zasięg OpenMP w kodzie Fullmaga jest zbyt mały

W `backends/fem/cpu/mfem` jawne dyrektywy OpenMP występują przede wszystkim w:

- `interactions/dmi_bulk.cpp`;
- `interactions/dmi_interfacial.cpp`;
- `interactions/demag_poisson_recovery.cpp`;
- `interactions/demag_fem_bem_operator.cpp`;
- `interactions/demag_poisson_energy.cpp`.

Największe pozostałe grupy pracy nadal wykonują wiele pętli szeregowo:

- obliczenie LLG;
- normalizacja magnetyzacji;
- retraction RK;
- estymacja błędu kroku;
- maskowanie;
- lokalne pola anizotropii/Zeeman;
- konwersje AoS ↔ SoA;
- wyznaczanie norm i maksimum momentu;
- wiele operacji relaksacji;
- składanie części operatorów i RHS;
- walidacje i pełne hashe;
- część odzyskiwania pól i postprocessingu.

### 6.1. Zalecany wspólny pakiet kerneli CPU

Zamiast dodawać dyrektywy ad hoc należy utworzyć warstwę:

```text
backends/fem/cpu/mfem/kernels/
  vector_aos.cpp
  vector_soa.cpp
  llg.cpp
  reductions.cpp
  masks.cpp
  rk.cpp
```

Każdy kernel powinien:

- otrzymywać `effective_threads`;
- mieć próg uruchomienia równoległego;
- używać `schedule(static)` dla regularnych pętli;
- stosować `omp simd` tam, gdzie aliasing jest kontrolowany;
- nie alokować;
- publikować czas i liczbę elementów;
- mieć wariant deterministycznej redukcji;
- być testowany dla 1 i wielu wątków.

### 6.2. Fuzja pętli

Aktualny schemat często wykonuje osobne przejścia przez pole dla:

1. normalizacji `m`;
2. obliczenia iloczynów wektorowych;
3. obliczenia RHS LLG;
4. obliczenia normy momentu;
5. maskowania;
6. obliczenia maksimum.

Należy scalić zależne operacje w jeden kernel, np.:

```cpp
#pragma omp parallel for reduction(max:max_torque) schedule(static)
for (std::int64_t i = 0; i < n; ++i) {
    // load m and H once
    // normalize/retract if required
    // compute m x H and m x (m x H)
    // apply mask
    // store RHS
    // update local maximum
}
```

Korzyść wynika nie tylko z liczby wątków, lecz z mniejszej liczby odczytów/zapisów pamięci.

### 6.3. Determinizm

Dla energii, norm i globalnych kryteriów stopu zalecane są:

- statyczny podział pracy;
- lokalne akumulatory per-thread;
- redukcja w ustalonej kolejności;
- opcjonalny tryb „strict deterministic”;
- tolerancyjne porównania w trybie produkcyjnym.

Nie należy serializować całego solvera wyłącznie po to, aby zachować identyczność bitową redukcji zmiennoprzecinkowej.

---

## 7. Exchange: trzy osobne składowe, hashe hot-path i zbędne transfery

### 7.1. Pełne hashowanie zależności

Klucz zależności exchange obejmuje topologię, geometrię, materiały, granice i periodic data. Następnie jest sprawdzany w ścieżce wyznaczania pola.

Jeżeli stan strukturalny nie zmienia się w kroku RK, ponowne przejście po dużych tablicach jest seryjnym kosztem `O(N)` lub `O(E)` przed właściwym operatorem.

### 7.2. Zalecenie: liczniki rewizji

Każdy zasób powinien mieć monotoniczny numer:

```cpp
struct FemRevisions {
    uint64_t mesh_topology;
    uint64_t mesh_geometry;
    uint64_t material;
    uint64_t boundary;
    uint64_t periodicity;
    uint64_t operator_policy;
};
```

Klucz cache jest małą strukturą liczb, nie hash całej zawartości. Hash danych pozostaje:

- przy imporcie;
- przy certyfikacji;
- w testach;
- w artefakcie provenance,

ale nie w każdym stage RHS.

### 7.3. Trzy osobne zastosowania operatora

Pole exchange jest liczone osobno dla `x`, `y`, `z`, co oznacza:

- trzy SpMV;
- przy consistent mass trzy osobne solve;
- trzy przebiegi przez te same indeksy macierzy;
- trzy zestawy narzutów wywołania.

Należy wprowadzić reprezentację `N×3` i kernel SpMM/block-RHS:

```text
Y = A X, gdzie X = [m_x, m_y, m_z]
```

Dla mass projection należy użyć:

- block CG albo trzech RHS obsługiwanych przez trwały obiekt solvera;
- wspólnego preconditionera;
- warm start z poprzedniego stage;
- zbieżności mierzonej per składowa i łącznie.

### 7.4. Alokacje w mass projection

Ścieżki lumped/consistent tworzą tymczasowe wektory w wywołaniach. Bufory powinny należeć do `Context` i zmieniać rozmiar tylko przy zmianie siatki/operatora.

### 7.5. Współczynniki elementowe

`AdapterBackedElementwiseCoefficient::Eval()` wyszukuje ordinal elementu przez `std::find(active.begin(), active.end(), ordinal)`. W callbacku quadrature jest to koszt potencjalnie bardzo wysoki.

Należy zbudować bezpośrednią tablicę:

```cpp
std::vector<uint8_t> active_element_mask;
```

albo mapę ordinal → właściwości, aby lookup był `O(1)`.

### 7.6. Partial assembly

Exchange używa legacy assembly. W repozytorium istnieje uzasadnienie związane z MFEM 4.7 i tetrahedrami. Nie należy usuwać zabezpieczenia bez testu, ale trzeba otworzyć osobny eksperyment:

- MFEM 4.9;
- `AssemblyLevel::PARTIAL`;
- CPU `omp`;
- tetra P1/P2;
- regiony i współczynniki DG0;
- porównanie pola, energii i gradientu;
- pomiar pamięci i czasu operatora.

---

## 8. Demagnetyzacja Poisson–airbox

### 8.1. Dobre elementy obecnej implementacji

Kod zawiera wartościowe mechanizmy:

- cache operatora;
- reuse setupu solvera;
- warm start;
- oddzielne metryki setup/apply;
- dedykowany workspace recovery;
- specjalny P1 tetra fast path;
- walidację energii wariacyjnej.

Należy je zachować podczas refaktoryzacji.

### 8.2. Podwójne sprawdzanie zależności

Ścieżka demag wywołuje kontrolę aktualności operatora na więcej niż jednym poziomie. Jeżeli kontrola generuje pełny hash siatki/materialu/markerów, koszt jest powtarzany dla jednego solve.

Rozwiązanie: jeden snapshot rewizji na wejściu do fazy oraz kontrakt, że niższe funkcje otrzymują już zweryfikowany operator.

### 8.3. Składanie RHS w każdym stage

RHS zależy od magnetyzacji, więc jego wartości muszą być aktualizowane. Nie oznacza to jednak, że cała struktura i geometria powinny być ponownie interpretowane.

Dla P1 tetra należy precompute'ować:

- lokalne indeksy DOF;
- gradienty funkcji bazowych w przestrzeni fizycznej;
- objętość/Jacobian;
- maskę elementu magnetycznego;
- mapę materiałową;
- strukturę scatter.

W stage aktualizowane są tylko kombinacje zależne od `m`.

### 8.4. Krytyczny błąd limitu recovery

`recover_demag_poisson_field()` oblicza:

```cpp
bytes_per_thread = sizeof(double) * (field_len + node_count);
```

i redukuje `recover_threads`, aż hipotetyczna suma zmieści się w 256 MiB.

Jednocześnie `DemagRecoveryWorkspace::prepare()` nie tworzy per-thread pełnych tablic pola i wag. Tworzy jedynie małe obiekty `Scratch`, a właściwe pola globalne są aktualizowane atomowo.

Limit odpowiada więc pamięci, która nie jest faktycznie alokowana.

Dla `N` węzłów:

```text
field_len = 3N
bytes_per_thread = 8 * (3N + N) = 32N
```

Przykłady:

| N | hipotetyczne bytes/thread | limit zespołu wynikający z 256 MiB |
|---:|---:|---:|
| 100 000 | 3,2 MB | około 64 |
| 500 000 | 16 MB | około 16 |
| 1 000 000 | 32 MB | około 8 |
| 2 000 000 | 64 MB | około 4 |

Na dużej siatce kod może więc sam ograniczyć 30/40/64 wątki do 8 albo 4, mimo że pamięć per-thread nie jest zużywana w deklarowanej wielkości.

**Naprawa natychmiastowa:** usunąć ten limit w obecnym wariancie atomowym.  
**Naprawa docelowa:** jeżeli wprowadzone zostaną pełne bufory per-thread, limit liczyć na podstawie rzeczywiście zaalokowanej strategii i dostępnej pamięci, nie stałej 256 MiB.

### 8.5. Atomiki w scatterze element → węzeł

Każdy udział elementu wykonuje atomowe aktualizacje:

- trzech składowych pola;
- wagi;
- osobno dla pola fizycznego i wizualnego.

To daje do ośmiu atomików na węzeł elementu w części magnetycznej. Na regularnej siatce wiele sąsiednich elementów konkuruje o te same linie cache.

Możliwe strategie, w kolejności zalecanej do testów:

1. **kolorowanie elementów** tak, aby elementy jednego koloru nie współdzieliły węzłów;
2. **partition-local accumulation** do buforów dla bloków/partycji siatki i deterministyczny merge;
3. **owner-computes per node** z odwróconą mapą node → incident elements;
4. pełne bufory per-thread tylko dla mniejszych `N`;
5. atomiki jako fallback.

Kolorowanie jest atrakcyjne, ponieważ zachowuje bounded memory i eliminuje atomiki w obrębie koloru.

### 8.6. Pole fizyczne i wizualne liczone zawsze

Recovery akumuluje równolegle:

- `h_demag_xyz` dla fizyki;
- `h_visual_xyz` dla całej domeny;
- dwie tablice wag.

Jeżeli UI ani snapshot nie potrzebują pola wizualnego w danym kroku, połowa scatter traffic jest zbędna.

Należy wprowadzić tryby:

```text
physical_only
physical_and_visual
visual_only_reconstruct
```

Domyślny hot path LLG/relaksacji powinien być `physical_only`, a pole wizualne generowane zgodnie z cadence snapshotów.

### 8.7. Serialny postprocessing

Walidacja wag i część maskowania są osobnymi pętlami. Należy je połączyć z normalizacją recovery i zrównoleglić.

### 8.8. Solver Poisson

Aktualny solver może korzystać z cache AMG/solvera, lecz pozostaje jedno-rangowy. Dalsze usprawnienia bez MPI:

- trwałe wektory Hypre;
- unikanie pełnych kopii host ↔ MFEM ↔ Hypre;
- warm start;
- osobna tolerancja dla stage wewnętrznych i accepted step, z kontrolą wpływu na integrator;
- test PCG vs GMRES/MINRES zgodnie z własnościami operatora;
- pomiar setup, SpMV, preconditioner apply, reductions i recovery osobno.

Nie należy obniżać tolerancji bez bramki energii/pola i kontroli trajektorii.

---

## 9. Demagnetyzacja FEM/BEM

### 9.1. Bariera złożoności

Operator BEM jest materializowany jako gęsta macierz dla `N_b` węzłów brzegowych:

```text
pamięć samych wartości ≈ 8 N_b² bajtów
```

Przykładowo:

| `N_b` | pamięć wartości macierzy |
|---:|---:|
| 10 000 | 0,80 GB |
| 25 000 | 5,00 GB |
| 50 000 | 20,00 GB |

Nie uwzględnia to indeksów, workspace'ów, kopii i faktorów solvera.

Złożoność budowy i zastosowania jest odpowiednio bliska:

- budowa: `O(N_b × N_tri)` / w praktyce kwadratowa;
- matvec: `O(N_b²)`.

OpenMP przyspiesza wiersze, ale nie zmienia ograniczenia pamięciowego ani asymptotyki.

### 9.2. Krótkoterminowe poprawki

- trwałe RHS i bufory rozwiązania;
- brak alokacji `std::vector` w każdym solve;
- BLAS `dgemv` zamiast własnej gęstej pętli, z jawnie kontrolowaną liczbą wątków;
- batch wielu RHS;
- cache eliminacji brzegowej;
- reuse solvera i preconditionera;
- opcjonalne rzadsze pełne sprawdzanie residualu;
- NUMA first-touch podczas budowy macierzy;
- blokowe przejście po macierzy.

### 9.3. Rozwiązanie docelowe

Dla dużych problemów potrzebna jest reprezentacja skompresowana:

- H-matrix;
- H²-matrix;
- ACA;
- FMM;
- ewentualnie zewnętrzny pakiet BEM z MPI.

Kryterium decyzji powinno wynikać z `N_b`, pamięci i docelowego błędu, a nie tylko z nazwy realizacji.

---

## 10. Dynamika LLG i integratory RK

### 10.1. Sekwencyjny łańcuch stage

Typowy stage wykonuje:

1. aktualizację stanu;
2. exchange;
3. demag;
4. pola lokalne;
5. STT/SOT/transport;
6. LLG RHS;
7. kombinację stage;
8. retraction/normalizację;
9. estymację błędu;
10. kryteria stopu i metryki.

Zależności fizyczne wymuszają kolejność głównych pól, ale nie wymuszają szeregowości pętli wewnątrz faz.

### 10.2. LLG RHS

`llg_rhs.cpp` wykonuje operacje per node, idealne dla `parallel for` + SIMD. Należy:

- załadować `m` i `H` tylko raz;
- liczyć oba iloczyny wektorowe w rejestrach;
- zastosować damping i maski w tym samym przebiegu;
- redukować maksimum torque;
- unikać tymczasowych pełnych wektorów.

### 10.3. RK stage/update

Kombinacja liniowa stage, retraction i estymacja błędu to regularne pętle pamięciowe. Powinny używać wspólnego kernela z:

- jednym przebiegiem;
- redukcją normy błędu;
- zintegrowaną kontrolą `isfinite`;
- statycznym schedulingiem;
- jawnie wyrównanymi buforami.

### 10.4. Pola lokalne

Anizotropia, Zeeman i wiele torque'ów można:

- policzyć równolegle per node;
- łączyć z akumulacją `H_eff`;
- nie tworzyć osobnych pełnych tablic, jeżeli quantity nie jest wymagane do zapisu;
- generować quantity diagnostyczne według cadence.

### 10.5. Task parallelism

Nie należy od razu uruchamiać exchange i demag jako niezależnych tasków, jeśli oba silnie wykorzystują pamięć i ten sam zespół OpenMP. Najpierw trzeba zmierzyć:

- czy wykonanie współbieżne nie konkuruje o bandwidth;
- czy biblioteki nie tworzą zagnieżdżonych teamów;
- czy koszt synchronizacji jest mniejszy od korzyści.

Pierwszym krokiem powinno być dobre data parallelism wewnątrz faz, nie OpenMP tasks między ciężkimi operatorami.

---

## 11. Relaksacja

### 11.1. PGBB i NCG

Kod zawiera już część optymalizacji, ale nadal ma wiele:

- pełnych kopii stanu;
- osobnych redukcji;
- uploadów trial state;
- snapshotów;
- serialnych operacji wektorowych;
- powtórzeń przy backtrackingu.

Należy rozszerzyć trwałe workspace'y i skonsolidować:

- dot products;
- normy;
- retraction;
- gradient projection;
- kryteria Armijo.

### 11.2. Exchange+mass preconditioner

Cache operatora istnieje, lecz ścieżki solve nadal tworzą część obiektów solvera i zerują rozwiązania. Należy rozdzielić:

- cache struktury;
- cache wartości;
- cache preconditionera;
- stan Kryłowa;
- initial guess.

Każdy miss musi podawać przyczynę: zmiana siatki, materiału, wagi, tolerancji lub typu solvera.

### 11.3. Tangent-plane implicit — największy problem relaksacji

W `tangent_plane_implicit.cpp` pojedyncza próba:

1. buduje ramy styczne;
2. buduje gradient masowy;
3. składa macierz `2N × 2N`;
4. tworzy solver;
5. tworzy smoother/preconditioner;
6. rozwiązuje z zerowego przybliżenia;
7. projektuje wynik;
8. ocenia trial.

Jeżeli line search odrzuca krok, kolejna próba powtarza kosztowny setup.

To jest szczególnie niekorzystne, ponieważ backtracking jest z natury sekwencyjny i nie da się go „naprawić” większą liczbą wątków.

### 11.4. Wymagana refaktoryzacja TPI

Podział na warstwy:

```text
TangentPlanePatternCache
  - graf 2N×2N
  - mapowanie lokalnych bloków
  - permutacja
  - symbolic factorization / AMG hierarchy

TangentPlaneNumericState
  - wartości zależne od m i kroku
  - diagonal/block diagonal
  - RHS

TangentPlaneSolveWorkspace
  - vectors
  - solver object
  - preconditioner object
  - warm start
```

Dla kolejnego backtracku:

- nie budować grafu;
- nie alokować;
- aktualizować tylko wartości zależne od step size;
- reuse ordering/symbolic setup;
- używać poprzedniego rozwiązania jako initial guess;
- rozważyć skalowanie operatora zamiast pełnej rekonstrukcji.

### 11.5. Matrix-free

Jeżeli macierz jest sumą operatorów o znanej strukturze, należy zbadać `mfem::Operator`/partial assembly i matrix-free Krylov. Warunkiem jest skuteczny preconditioner; matrix-free bez preconditionera może zwiększyć liczbę iteracji i pogorszyć całkowity czas.

---

## 12. Solver częstotliwościowy i eigensolver

### 12.1. „Sparse direct” zaczyna od gęstych danych

`cpu_sparse_direct_engine.cpp` przyjmuje pełne macierze `N×N` w układzie row-major. `assemble_real_split_csr.cpp` następnie:

- waliduje wszystkie `N²` elementów;
- skanuje wszystkie `N²` elementów;
- rezerwuje do `4N²` wpisów;
- buduje blokową macierz real-split;
- wstawia wpisy do nowej macierzy PETSc;
- faktoryzuje;
- po solve ponownie przechodzi przez gęste macierze dla true residualu.

To nie jest produkcyjna ścieżka sparse dla dużego FEM.

Szacunkowy dolny koszt samych wejść i buforów przed faktorami:

```text
K + M:                16 N² bajtów
real-split values:    do 32 N² bajtów
real-split columns:   do 16 N² bajtów
razem:                około 64 N² bajtów
```

Dla `N=20 000` byłoby to około 25,6 GB przed uwzględnieniem PETSc, faktorów LU i kopii.

### 12.2. PETSc jest tworzone od zera

Dla każdego solve:

- nowy CSR;
- `MatCreateSeqAIJ(PETSC_COMM_SELF)`;
- indywidualne `MatSetValue`;
- nowe RHS/solution;
- nowy KSP/PC;
- LU;
- zniszczenie wszystkich obiektów.

Brakuje:

- preallocation bez per-entry insertion;
- bezpośredniego utworzenia z CSR;
- reuse macierzy;
- reuse ordering;
- rozdzielenia symbolic/numeric factorization;
- reuse faktoryzacji przy identycznej częstotliwości i wielu RHS;
- reuse preconditionera między sąsiednimi częstotliwościami.

### 12.3. Globalny mutex

Cały solve jest chroniony statycznym mutexem w wybranych adapterach PETSc/SLEPc. Zapobiega to równoległemu rozwiązaniu niezależnych częstotliwości w jednym procesie.

Bezpieczeństwo inicjalizacji biblioteki należy oddzielić od serializacji pracy:

- `std::call_once` dla inicjalizacji;
- osobny `SolverContext` na zadanie;
- PETSc communicator per grupa;
- brak globalnego locka wokół `KSPSolve`/`EPSSolve`, jeśli konfiguracja biblioteki i lifecycle na to pozwalają.

### 12.4. SLEPc również jest sekwencyjny

Kod używa:

- `MatCreateSeqDense` lub `MatCreateSeqAIJ`;
- `VecCreateSeq`;
- `EPSCreate(PETSC_COMM_SELF)`;
- shift-invert;
- `KSPPREONLY`;
- `PCLU`.

SLEPc potrafi działać równolegle, ale tylko gdy otrzyma rozproszony operator i communicator obejmujący rangi.

### 12.5. Full-coupled field split

Obecna implementacja field-split jest prototypem:

- ograniczenie do małych rozmiarów;
- gęste tablice;
- własna eliminacja Gaussa;
- jawne konstruowanie odwrotności bloku Poissona kolumna po kolumnie;
- gęste matvec.

Nie należy rozszerzać limitu bez zmiany algorytmu.

### 12.6. Docelowa architektura frequency-domain

#### Operator

Zachować rzadkie bloki bez densyfikacji:

```text
A(ω) = K + iωG + C_demag(ω)
```

albo real-split jako operator blokowy, niekoniecznie materializowaną macierz `2N×2N`.

#### PETSc

- `MatCreateAIJ`/`MATMPIAIJ` na communicatorze grupy;
- lokalny zakres wierszy zgodny z partycją true DOF;
- preallocation z rzeczywistego grafu;
- bezpośrednia aktualizacja values;
- `MatAssembly` tylko po zmianie danych;
- `KSPSetReusePreconditioner()` tam, gdzie matematycznie dopuszczalne;
- reuse ordering/symbolic factorization dla stałego sparsity pattern;
- jawny wybór pakietu: MUMPS, SuperLU_DIST, STRUMPACK lub iteracyjny field-split;
- wszystkie opcje i faktycznie użyty pakiet w diagnostyce.

#### Skan częstotliwości

Dwa poziomy równoległości:

1. **task parallelism:** różne częstotliwości/contour shifts na różnych grupach MPI;
2. **domain parallelism:** jedna trudna częstotliwość rozwiązana przez kilka rang wewnątrz grupy.

Przykład:

```text
64 rangi:
  8 grup po 8 rang
  każda grupa rozwiązuje inną częstotliwość
  wewnątrz grupy macierz jest rozproszona
```

Nie należy zawsze przeznaczać wszystkich rang na jedną małą częstotliwość.

#### Wielokrotne RHS

Dla wielu wzbudzeń przy tej samej `ω`:

- jedna faktoracja;
- wiele RHS;
- block Krylov lub MatMatSolve, zależnie od pakietu.

### 12.7. Packaging

Kanoniczny obraz `fem-cpu` ma `FULLMAG_FEM_WITH_SLEPC=OFF`, podczas gdy inne ścieżki mogą mieć `ON`. Należy jednoznacznie rozdzielić:

- `fem-cpu-runtime` bez frequency/eigen;
- `fem-cpu-frequency` z PETSc/SLEPc i wybranymi solverami;
- receipt builda z listą dostępnych pakietów.

---

## 13. Dwa procesory / dwa sockety / NUMA

### 13.1. Dlaczego jeden proces i 100% CPU nie zawsze są optymalne

Sparse SpMV, assembly i duże pętle wektorowe często są ograniczone przez przepustowość pamięci. Po osiągnięciu nasycenia bandwidth dodatkowe wątki:

- nie skracają czasu;
- mogą zwiększyć cache misses;
- zwiększają contention;
- wykonują więcej zdalnych odczytów NUMA;
- podnoszą koszt barier i redukcji.

Celem nie powinno być „100% w Menedżerze zadań”, tylko minimalny wall time przy zachowaniu residualu i fizyki.

### 13.2. Etap przejściowy — obecna architektura

Dopóki pojedyncza symulacja nie jest rozproszona:

- uruchamiać jeden proces;
- pinować do jednego socketu i mierzyć;
- porównać wszystkie rdzenie jednego socketu z rdzeniami obu socketów;
- stosować first-touch;
- nie uruchamiać `mpirun -n 2` dla tej samej symulacji — każda ranga ma pełną domenę.

Drugi socket można skutecznie wykorzystać do innej niezależnej symulacji/parametru, przypinając po jednym procesie na socket.

### 13.3. Architektura docelowa

Po migracji do Parallel MFEM rekomendowany punkt startowy:

```text
1 ranga MPI na domenę NUMA
OpenMP = liczba fizycznych rdzeni przypisanych do rangi
SMT wyłączone w pierwszym benchmarku
```

Dla typowego serwera 2-socket:

```text
2 rangi MPI × rdzenie fizyczne/socket
```

Potem porównać:

- 1 rank × wszystkie rdzenie;
- 2 rank × rdzenie/socket;
- 4 rank × pół socketu;
- flat MPI;
- SMT on/off.

### 13.4. First-touch

Duże tablice muszą być inicjalizowane równolegle zgodnie z docelowym ownership. Serialne `assign/fill` wykonane przez główny wątek mogą umieścić większość stron pamięci w jednym NUMA node.

Dla trwałych buforów:

```cpp
#pragma omp parallel for schedule(static)
for (...) buffer[i] = 0.0;
```

na już przypiętym zespole zapewnia lepszy first-touch.

---

## 14. Wielowęzłowe HPC

### 14.1. Stan obecny

`MPI_Init_thread(..., MPI_THREAD_FUNNELED, ...)` jest inicjalizowane, lecz komunikator solvera jest `MPI_COMM_SELF`. W repozytorium istnieje szkic struktur distributed po stronie Rust, ale nie jest on spięty z natywnym wykonaniem MFEM.

Aktualnie:

```bash
mpirun -n 8 fullmag ...
```

nie dzieli automatycznie jednej domeny na osiem rang.

### 14.2. Minimalny zakres migracji

#### Siatka i DOF

- import globalnej siatki na root lub równoległy odczyt;
- partycjonowanie elementów;
- `ParMesh`;
- rank-local elementy i ghost entities;
- global/local map dla węzłów, elementów, regionów i boundary markers;
- `ParFiniteElementSpace`;
- true DOF ownership.

#### Stan magnetyczny

- rank-local `ParGridFunction`;
- synchronizacja shared DOF;
- halo exchange przed operatorami lokalnymi;
- globalne normy przez `MPI_Allreduce`;
- globalne maksimum torque;
- deterministyczne ID quantity i snapshotów.

#### Operatory

- `ParBilinearForm`;
- `ParLinearForm`;
- `HypreParMatrix`;
- rank-local assembly;
- globalny solver na communicatorze domeny;
- AMG z poprawną partycją.

#### Periodicity

Aktualne globalne mapy par okresowych muszą zostać przekształcone do:

- constraintów true DOF;
- komunikacji między rangami;
- certyfikatu okresowości po partycjonowaniu;
- Bloch phase dla frequency-domain.

#### Demag

Poisson-airbox jest naturalnym pierwszym kandydatem do Parallel MFEM.

FEM/BEM wymaga osobnej strategii, ponieważ gęsty operator brzegowy nie skaluje się przez zwykły podział sparse FEM.

#### I/O

Unikać gatheru pełnych pól na root w każdym snapshot:

- rank-local chunked Zarr/HDF5;
- globalny manifest;
- opcjonalny gather tylko dla małych preview;
- kontrolowana redukcja scalarów.

### 14.3. Proponowany communicator model

```text
MPI_COMM_WORLD
  ├── ensemble communicator
  ├── frequency-group communicator
  └── domain communicator
```

W zależności od study:

- dynamika jednej domeny: cały przydział jako domain communicator;
- sweep parametrów: podział świata na niezależne grupy;
- frequency sweep: grupy per częstotliwość;
- contour eigensolver: grupy per shift, ewentualnie dynamiczna kolejka.

### 14.4. Slurm — wzorzec po implementacji MPI

Przykład hybrydowy dla jednego węzła z dwoma socketami:

```bash
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=2
#SBATCH --cpus-per-task=32
#SBATCH --hint=nomultithread

export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK}"
export FULLMAG_CPU_THREADS="${SLURM_CPUS_PER_TASK}"
export OMP_PLACES=cores
export OMP_PROC_BIND=close
export OMP_DYNAMIC=FALSE

srun --cpu-bind=cores fullmag ...
```

Przykład wielowęzłowy:

```bash
#SBATCH --nodes=4
#SBATCH --ntasks-per-node=2
#SBATCH --cpus-per-task=32
#SBATCH --hint=nomultithread

srun --cpu-bind=cores fullmag ...
```

Te receptury będą poprawne dopiero po przejściu na `ParMesh` i rozproszony stan. Obecnie uruchomiłyby wiele pełnych kopii problemu.

---

## 15. Benchmarki i telemetria — obecny skrypt nie daje wiarygodnej krzywej skalowania

### 15.1. Problemy `scripts/bench_fem_cpu_scaling.sh`

Skrypt:

- testuje domyślnie 4, 8, 20 i 40 wątków;
- ustawia tylko `FULLMAG_CPU_THREADS`;
- nie usuwa istniejącego `OMP_NUM_THREADS`;
- przez precedencję runtime'u może faktycznie testować 16 dla wielu etykiet;
- zawiera `|| true`, więc awaria jest traktowana jak zakończony przebieg;
- mierzy cały proces, w tym startup/meshing;
- nie ma baseline 1-thread;
- nie wykonuje warm-up;
- wykonuje pojedynczy pomiar;
- nie raportuje mediany/p95;
- nie sprawdza rzeczywistej liczby wątków;
- używa małych siatek, które trafiają w auto cap i mogą nie nasycać CPU;
- nie mierzy affinity/NUMA;
- wyznacza speedup względem 4 wątków, nie 1;
- nie ma bramki zgodności fizycznej.

W obecnej postaci skrypt może produkować tabelę poprawną syntaktycznie, ale opisującą inne ustawienie niż podane w kolumnie.

### 15.2. Wymagana poprawka benchmarku

Każdy run musi:

```bash
env -u OMP_NUM_THREADS \
    FULLMAG_CPU_THREADS="$threads" \
    OMP_NUM_THREADS="$threads" \
    OMP_DYNAMIC=FALSE \
    OMP_PLACES=cores \
    OMP_PROC_BIND="$binding" \
    ...
```

oraz przerwać suite po błędzie.

Z logu należy odczytać i porównać:

- requested threads;
- effective threads;
- `omp_get_max_threads`;
- faktyczny rozmiar teamu w regionie testowym;
- MFEM backend;
- cpuset;
- affinity;
- rank count.

Mismatch powinien oznaczać `invalid_run`, nie wynik wydajnościowy.

### 15.3. Macierz benchmarkowa

#### Liczba wątków

```text
1, 2, 4, 8,
physical cores per socket,
all physical cores,
SMT threads
```

Dodatkowo 20 i 30 jako żądane przypadki użytkownika.

#### Rozmiary

- mały: overhead-bound;
- średni: typowa interaktywna symulacja;
- duży: demag/SpMV bandwidth-bound;
- produkcyjny SP4;
- przypadek z dużym airboxem;
- przypadek FEM/BEM z kontrolowanym `N_b`.

#### Solvery

Osobne benchmarki:

- exchange only;
- demag Poisson setup;
- demag Poisson apply;
- demag recovery;
- local fields;
- LLG/RK;
- PGBB;
- NCG;
- TPI;
- FEM/BEM setup/apply;
- driven response;
- modal eigen.

### 15.4. Statystyka

Dla każdej konfiguracji:

- co najmniej jeden warm-up;
- co najmniej pięć mierzonych powtórzeń;
- mediana;
- minimum;
- p95 lub maksimum;
- współczynnik zmienności;
- liczba iteracji solvera;
- residual;
- setup reuse;
- pamięć peak RSS.

### 15.5. Metryki skalowania

```text
S(p) = T(1) / T(p)
E(p) = S(p) / p
```

Dodatkowo:

- CPU time / wall time;
- GB/s;
- LLC misses;
- memory bandwidth;
- NUMA remote reads;
- czas barier;
- MPI communication;
- min/mean/max phase time po rangach.

### 15.6. Bramka poprawności

Wynik wydajnościowy jest ważny tylko, gdy zachowane są:

- liczba kroków/iteracji w tolerancji;
- końcowy residual;
- energia całkowita;
- składowe energii;
- norma pola;
- maksimum torque;
- stan końcowy;
- certyfikat topologii/periodicity;
- brak NaN/Inf.

Dla dynamiki trzeba porównać trajektorię lub wybrane obserwable, a nie tylko stan końcowy.

---

## 16. Telemetria wymagana do diagnozy „dlaczego CPU nie jest pełne”

Do istniejących statystyk należy dodać receipt:

```json
{
  "cpu_execution": {
    "requested_threads": 30,
    "effective_openmp_threads": 30,
    "observed_team_threads": 30,
    "logical_cpus_visible": 64,
    "physical_cores_visible": 32,
    "cpuset_cpus": "0-29",
    "sockets": 2,
    "numa_nodes": 2,
    "smt_enabled": true,
    "omp_places": "cores",
    "omp_proc_bind": "close",
    "mfem_device": "omp",
    "mpi_world_size": 1,
    "mpi_domain_size": 1,
    "hypre_openmp": true,
    "petsc_comm_size": 1,
    "blas_threads": 1
  }
}
```

Per faza:

- wall time;
- CPU time;
- liczba wejść;
- bytes read/write, jeśli szacowalne;
- allocations;
- hash time;
- setup time;
- apply time;
- iteracje;
- residual;
- solver/preconditioner;
- active thread count;
- lock wait time;
- atomics/contention proxy;
- cache hit/miss reason.

Dla MPI:

- min/mean/max czasu po rangach;
- communication time;
- bytes sent/received;
- imbalance;
- global reductions count.

---

## 17. Szczegółowy plan implementacji

### PR A — jednoznaczne sterowanie CPU i wiarygodny benchmark

**Zakres**

- nowy `CpuExecutionPolicy`;
- plan → środowisko przed inicjalizacją biblioteki;
- usunięcie konkurencyjnej precedencji;
- `FULLMAG_CPU_THREADS` numeryczne ma pierwszeństwo albo konflikt jest błędem;
- cpuset-aware detection;
- physical cores/SMT;
- affinity receipt;
- poprawka skryptu benchmarkowego;
- brak `|| true`;
- baseline 1-thread i wielokrotne powtórzenia.

**Kryteria akceptacji**

- żądanie 20 daje observed team 20;
- żądanie 30 daje observed team 30;
- log i JSON zgadzają się;
- benchmark odrzuca mismatch;
- Windows Docker, Linux i Slurm mają spójny kontrakt.

### PR B — MFEM OpenMP w obrazie CPU

**Zakres**

- CPU-only branch używa configured device;
- domyślne `FULLMAG_FEM_MFEM_DEVICE=omp`;
- fallback receipt;
- test `_OPENMP`;
- `mfem::Device::Print`;
- test kontraktowy obrazu.

**Kryteria akceptacji**

- backend raportuje `omp`;
- brak regresji `cpu` 1-thread;
- porównanie pola/energii;
- benchmark operatora MFEM pokazuje rzeczywistą pracę wielu wątków albo dokumentuje, które operacje pozostają legacy-serial.

### PR C — wspólne kernely OpenMP/SIMD i trwałe bufory

**Zakres**

- LLG;
- RK combine/retraction/error;
- maski;
- lokalne pola;
- AoS/SoA;
- normy/redukcje;
- persistent workspaces;
- fuzja pętli.

**Kryteria akceptacji**

- brak alokacji w steady-state hot path;
- brak osobnych pełnych przejść, jeśli można je scalić;
- deterministic mode;
- phase benchmark 1/8/20/30.

### PR D — cache rewizji i exchange block-RHS

**Zakres**

- liczniki rewizji zamiast hashy hot-path;
- direct active-element mask;
- `N×3` operator apply;
- persistent mass-projection solver;
- warm start;
- wspólny preconditioner;
- powód missu.

**Kryteria akceptacji**

- zero pełnych hashy w niezmienionym RK stage;
- trzy składowe nie skanują indeksów macierzy trzy razy;
- identyczna fizyka w tolerancji;
- brak wzrostu iteracji.

### PR E — demag recovery i RHS

**Zakres**

- usunięcie fałszywego limitu 256 MiB;
- precompute P1 tetra geometry/DOF;
- kolorowanie lub segmentowana redukcja;
- tryb `physical_only`;
- zrównoleglenie postprocessingu;
- jedna kontrola rewizji.

**Kryteria akceptacji**

- requested=30 nie jest redukowane bez rzeczywistego powodu;
- zero atomików w głównym wariancie lub zmierzony fallback;
- pola fizyczne/wizualne zgodne;
- energy derivative gate;
- skala 1/8/20/30.

### PR F — relaksacja i tangent-plane reuse

**Zakres**

- persistent `TangentPlanePatternCache`;
- reuse solver/preconditioner;
- warm start między backtrackami;
- numeric-only update;
- trwałe wektory PGBB/NCG/TPI;
- równoległe redukcje.

**Kryteria akceptacji**

- line-search backtrack nie wykonuje symbolic setup;
- brak alokacji `O(N)` w kolejnej próbie;
- jawne setup/apply counters;
- ten sam accepted step i kryteria energii.

### PR G — frequency/eigen sparse lifecycle

**Zakres**

- wejścia CSR/block operator zamiast dense `N²`;
- PETSc matrix preallocation;
- trwały KSP/EPS context;
- reuse symbolic factorization;
- wiele RHS;
- usunięcie globalnego solve mutex;
- jawny solver package;
- osobny obraz CPU z SLEPc;
- test MUMPS/SuperLU_DIST/STRUMPACK vs iteracyjny.

**Kryteria akceptacji**

- brak dense K/M dla produkcyjnego FEM;
- pamięć skaluje się z `nnz`, nie `N²`;
- drugi RHS nie wykonuje ponownej faktoracji;
- sąsiednia częstotliwość reuse'uje pattern;
- niezależne częstotliwości mogą działać współbieżnie;
- residual certyfikowany na rzadkim operatorze.

### PR H — Parallel MFEM, etap 1: Poisson-airbox

**Zakres**

- `ParMesh`;
- `ParFiniteElementSpace`;
- rank-local magnetyzacja;
- `ParLinearForm` RHS;
- `ParBilinearForm`;
- distributed Hypre;
- global reductions;
- rank-local output;
- serial/parallel parity.

**Kryteria akceptacji**

- 1 rank odpowiada staremu solverowi;
- 2/4/8 rang na jednym węźle;
- 2 węzły;
- strong scaling;
- poprawna energia i pole;
- brak pełnej macierzy na każdej randze.

### PR I — Parallel MFEM, etap 2: pełna dynamika/relaksacja

**Zakres**

- distributed exchange;
- local fields;
- LLG/RK;
- PGBB/NCG/TPI;
- periodic constraints;
- output;
- restart;
- quantity framework.

### PR J — rozproszony frequency/eigen

**Zakres**

- MPIAIJ;
- communicator groups;
- distributed KSP/EPS;
- parallel direct/iterative solvers;
- frequency/shift scheduling;
- distributed mode vectors.

### PR K — skalowalny BEM

**Zakres**

- wybór biblioteki/metody H/H²/ACA/FMM;
- error control;
- MPI;
- integracja z istniejącym FEM;
- porównanie z dense oracle.

---

## 18. Kolejność wdrożenia

Zalecana kolejność jest celowo oparta na zależnościach:

```text
A → B → C → D → E → F → G
                      └→ H → I → J
FEM/BEM dense fixes ─────────→ K
```

Najpierw trzeba naprawić pomiar. Inaczej kolejne optymalizacje będą oceniane na podstawie niepewnej liczby wątków i mieszanego startupu.

Nie należy rozpoczynać migracji MPI przed:

- stabilnym 1-thread oracle;
- wiarygodną telemetrią;
- usunięciem hot-path hashów/allocations;
- rozdzieleniem setup i apply;
- testami parity.

---

## 19. Konkretne eksperymenty decyzyjne

### 19.1. Czy 20 czy 30 wątków jest lepsze?

Dla każdej dużej fazy uruchomić:

```text
1, 4, 8, 16, 20, 24, 30, physical-core-count, SMT-count
```

Zmierzyć osobno:

- exchange;
- Poisson assembly;
- Poisson solve;
- recovery;
- LLG/RK;
- całkowity accepted step.

Wybór może być różny per faza. Jeden globalny zespół 30 nie musi być optimum dla małej redukcji.

### 19.2. Czy używać SMT?

Najpierw benchmark tylko fizycznych rdzeni. Potem SMT.

SMT może pomagać w latency-bound kodzie, ale często nie pomaga w sparse/memory-bound. Decyzja musi być pomiarowa.

### 19.3. Jeden czy dwa sockety?

Porównać:

1. jeden socket, `close`;
2. oba sockety, `spread`;
3. oba sockety, `close`;
4. po migracji MPI: dwie rangi po jednym socket.

Do logu dodać NUMA remote traffic.

### 19.4. AMG czy solver bezpośredni?

Dla Poisson:

- czas setup;
- czas apply;
- liczba powtórzeń operatora;
- pamięć;
- reuse count.

Solver bezpośredni może wygrać dla wielu RHS i umiarkowanego rozmiaru, ale fill-in może zdominować pamięć. AMG zwykle lepiej skaluje domenowo, lecz wymaga strojenia.

### 19.5. Partial assembly

Akceptować tylko, jeśli:

- pole/energia przechodzą certyfikację;
- zmniejsza wall time lub pamięć;
- nie zwiększa znacząco liczby iteracji;
- obsługuje wszystkie wymagane typy elementów i materiały.

---

## 20. Ryzyka

### 20.1. Oversubscription

Największe ryzyko po „włączeniu wszystkich wątków” to nakładanie zespołów OpenMP/BLAS/Hypre. Każdy PR musi raportować wszystkie warstwy wątkowania.

### 20.2. Niedeterminizm redukcji

Równoległe sumowanie zmienia kolejność działań. Trzeba rozdzielić:

- zgodność fizyczną/tolerancyjną;
- strict deterministic mode;
- identyczność bitową.

### 20.3. Zmiana liczby iteracji

Inna kolejność sumowania może zmienić residual na granicy tolerancji. Benchmark musi raportować iteracje, a nie tylko czas.

### 20.4. NUMA

Więcej rdzeni może pogorszyć czas, jeżeli alokacje pozostaną serialne i strony pamięci znajdą się na jednym node.

### 20.5. MPI i output

Gather pełnego pola na root może anulować korzyści solvera. I/O musi zostać zaprojektowane razem z dystrybucją.

### 20.6. BEM

Nie należy obiecywać skalowania dense BEM na duże `N_b` przez sam OpenMP/MPI. Asymptotyka i pamięć pozostaną problemem.

---

## 21. Kryteria końcowe projektu optymalizacji CPU

Projekt można uznać za zakończony dopiero, gdy:

1. użytkownik może jawnie wybrać 20 lub 30 wątków z Python API/UI/CLI;
2. requested, effective i observed team są zgodne;
3. affinity i cpuset są widoczne w diagnostyce;
4. kanoniczny CPU image używa certyfikowanego backendu MFEM `omp`;
5. steady-state kroku nie alokuje dużych buforów;
6. brak pełnych hashy niezmiennych danych w każdym stage;
7. exchange używa block-RHS/persistent solver;
8. demag recovery nie ma fałszywego capu i nie jest zdominowane przez atomiki;
9. TPI reuse'uje setup między backtrackami;
10. frequency-domain zachowuje rzadką reprezentację;
11. PETSc/SLEPc nie są ograniczone do `PETSC_COMM_SELF` w wariancie HPC;
12. solver domenowy używa `ParMesh`/`ParFiniteElementSpace`;
13. dostępne są strong/weak scaling wyniki dla 1–wiele węzłów;
14. wszystkie przyspieszenia przechodzą certyfikację fizyczną;
15. regresja wydajności jest blokowana w CI przez stabilne, tolerancyjne progi.

---

## 22. Najważniejsze pliki źródłowe

### Runtime i konfiguracja

- `backends/fem/cpu/mfem/runtime/cpu_threads.cpp`
- `backends/fem/cpu/mfem/runtime/cpu_threads.hpp`
- `backends/fem/cpu/mfem/runtime/mfem_device.cpp`
- `backends/fem/cpu/mfem/runtime/mfem_context.cpp`
- `backends/fem/cpu/mfem/runtime/mpi_init.hpp`
- `backends/fem/cpu/mfem/runtime/step_metrics.cpp`
- `compose.windows.yaml`
- `docker/fem-cpu/Dockerfile`
- `scripts/bench_fem_cpu_scaling.sh`
- `examples/bench_fem_cpu_scaling.py`

### Exchange i pola

- `backends/fem/cpu/mfem/interactions/exchange_operator.cpp`
- `backends/fem/cpu/mfem/interactions/exchange_field.cpp`
- `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp`
- `backends/fem/cpu/mfem/interactions/effective_field.cpp`
- `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`
- `backends/fem/cpu/mfem/runtime/aos_field.cpp`

### Demag Poisson

- `backends/fem/cpu/mfem/interactions/demag.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_dependency.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`

### FEM/BEM

- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp`

### Integratory i relaksacja

- `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`
- `backends/fem/cpu/mfem/integrators/llg_rhs.cpp`
- `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`
- `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`

### Frequency/eigen

- `backends/fem/cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.cpp`
- `backends/fem/cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.cpp`
- `backends/fem/cpu/frequency_domain/engines/field_split/full_coupled_field_split_engine.cpp`
- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- `backends/fem/cpu/frequency_domain/dense_driven_response.cpp`
- `backends/fem/cpu/frequency_domain/contour_interval_solver.cpp`

### Rozproszenie

- `crates/fullmag-engine/src/distributed.rs`

---

## 23. Dokumentacja zewnętrzna wykorzystana do oceny architektury

- MFEM `Device`: https://docs.mfem.org/4.9/classmfem_1_1Device.html
- MFEM parallel/nonconforming mesh: https://mfem.org/howto/ncmesh/
- MFEM `ParFiniteElementSpace`: https://docs.mfem.org/4.8/classmfem_1_1ParFiniteElementSpace.html
- OpenMP `OMP_PROC_BIND`: https://www.openmp.org/spec-html/5.1/openmpse61.html
- OpenMP `OMP_PLACES`: https://www.openmp.org/spec-html/5.1/openmpse62.html
- PETSc `MatCreateAIJ`: https://petsc.org/release/manualpages/Mat/MatCreateAIJ/
- PETSc MUMPS: https://petsc.org/main/manualpages/Mat/MATSOLVERMUMPS/
- PETSc SuperLU_DIST: https://petsc.org/main/manualpages/Mat/MATSOLVERSUPERLU_DIST/
- PETSc STRUMPACK: https://petsc.org/main/manualpages/Mat/MATSOLVERSTRUMPACK/
- SLEPc: https://slepc.upv.es/release/
- Slurm `srun` i CPU binding: https://slurm.schedmd.com/srun.html

---

## 24. Konkluzja

Fullmag posiada już część potrzebnych fundamentów: MFEM/Hypre zbudowane z OpenMP/MPI, mechanizm thread request/effective, cache wybranych operatorów, warm start, szczegółowe statystyki kroku i wydzielone moduły solverów. Obecny niski poziom użycia CPU jest jednak zgodny z architekturą kodu: pełna domena pozostaje serialna, tylko kilka pętli jest jawnie wielowątkowych, a Hypre/PETSc/SLEPc działają na communicatorach jedno-rangowych.

Największy błąd krótkoterminowy to niezgodność między deklarowanym a rzeczywistym sterowaniem wątkami oraz fałszywy cap recovery. Największy koszt algorytmiczny relaksacji to wielokrotny setup tangent-plane w line search. Największy koszt frequency-domain to gęsty interfejs `N²`, sekwencyjne PETSc i brak reuse. Największą barierą HPC jest użycie serialnych klas MFEM.

Prawidłowa strategia ma trzy poziomy:

1. **najpierw wiarygodne sterowanie i pomiar**;
2. **następnie pełne jednowęzłowe OpenMP/NUMA i usunięcie narzutów algorytmicznych**;
3. **na końcu rozproszony Parallel MFEM/PETSc/SLEPc oraz skalowalny BEM**.

Dopiero ten trzeci poziom pozwoli jednej symulacji rzeczywiście wykorzystać dwa sockety w modelu hybrydowym i wiele węzłów HPC. Ustawienie większej liczby wątków w obecnym kodzie jest użyteczne do benchmarku, ale samo nie przekształca solvera w solver wielowęzłowy.
