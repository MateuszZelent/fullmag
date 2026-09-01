# Audyt wydajności, wielowątkowości, NUMA i skalowania wielowęzłowego solverów FEM CPU w Fullmag

**Data audytu:** 1 września 2026  
**Repozytorium:** `MateuszZelent/fullmag`  
**Audytowany stan kodu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`  
**Stan `master` przy zapisie raportu:** `cdb3c135901b950871291610c6ba45e62f8cb90a` — commit potomny dodał wyłącznie dane walidacyjne CSV FEM/BEM i nie zmienił audytowanego kodu solverów.  
**Zakres:** natywny backend FEM CPU/MFEM, dynamika LLG, relaksacja, demagnetyzacja Poisson i FEM/BEM, wymiana, DMI, warstwa uruchomieniowa, PETSc/SLEPc oraz gotowość do pracy na komputerach dwuprocesorowych i klastrach HPC.

> **Status dowodu:** jest to szczegółowy audyt statyczny kodu i konfiguracji kompilacji. Nie uruchomiono jeszcze kontrolowanych benchmarków na docelowej maszynie dwuprocesorowej ani wielowęzłowym klastrze. W związku z tym raport identyfikuje przyczyny źródłowe i priorytety, ale nie przypisuje niezmierzonych wartości przyspieszenia. Repozytorium samo deklaruje, że zaakceptowany zestaw bazowych wyników FEM CPU nadal nie został zapisany.

---

## 1. Najważniejszy wniosek

Obecny backend FEM CPU **nie jest jeszcze solverem hybrydowym MPI + OpenMP** i nie potrafi rozdzielić jednej symulacji na dwa procesory, dwa gniazda NUMA ani wiele węzłów klastra w znaczeniu domenowego skalowania FEM.

Aktualnie występują cztery różne, częściowo niespójne warstwy równoległości:

1. **OpenMP w kilku ręcznie oznaczonych pętlach**, głównie DMI, fragmentach rekonstrukcji pola demagnetyzującego i obliczaniu energii.
2. **Hypre skompilowane z OpenMP**, lecz używane na pełnej, szeregowej macierzy opakowanej komunikatorem `MPI_COMM_SELF`.
3. **MFEM skompilowane z OpenMP**, ale kanoniczny CPU-only runtime tworzy `mfem::Device("cpu")`, a nie `mfem::Device("omp")`.
4. **MPI obecne jako zależność techniczna Hypre**, ale bez `ParMesh`, `ParFiniteElementSpace`, rozdzielonych true DOF i komunikacji halo.

Dlatego samo ustawienie 20, 30, 64 lub 128 wątków nie może zapewnić wysokiego wykorzystania CPU. Duża część ścieżki krytycznej nadal pozostaje szeregowa, pamięciowa albo wykonuje kosztowną pracę, której nie powinno być w pętli czasowej.

### 1.1. Odpowiedź na trzy praktyczne cele

| Cel | Stan obecny | Wniosek |
|---|---|---|
| Wybrać ręcznie 20/30 wątków | Technicznie możliwe przez zmienne środowiskowe, ale konfiguracja Windows może po cichu zatrzymać wykonanie na 16 wątkach | Wymaga naprawy precedencji oraz pierwszoklasowego pola w planie/API/UI |
| Użyć obu CPU w komputerze dwuprocesorowym | Jeden proces może rozciągnąć OpenMP na oba sockety, ale nie ma kontroli NUMA, pinningu ani first-touch | Może to zwiększyć użycie CPU, lecz także pogorszyć czas wykonania przez zdalny dostęp do pamięci |
| Użyć wielu węzłów HPC dla jednej symulacji | Nieobsługiwane | Potrzebna jest przebudowa na `ParMesh`/`ParFiniteElementSpace` i rozdzielone operatory |

### 1.2. Najbardziej pilne problemy

| ID | Priorytet | Problem | Skutek |
|---|---:|---|---|
| CPU-001 | P0 | `OMP_NUM_THREADS` ma pierwszeństwo przed `FULLMAG_CPU_THREADS`; Windows ustawia domyślnie `OMP_NUM_THREADS=16` | Żądanie 20/30 wątków może być ignorowane |
| CPU-002 | P0 | CPU-only runtime wymusza `mfem::Device("cpu")` | MFEM nie korzysta z backendu `omp`; większość operatorów pozostaje szeregowa |
| CPU-003 | P0 | Pełne hashowanie siatki, geometrii i materiałów w hot path | Koszt O(N) przed wieloma wywołaniami wymiany i demagnetyzacji |
| CPU-004 | P0 | Demag wylicza klucz zależności wielokrotnie dla jednego świeżego solve | Powtarzana praca szeregowa w każdym etapie RK |
| CPU-005 | P1 | Brak topologii CPU, affinity, NUMA, first-touch i rozróżnienia rdzeni fizycznych od SMT | Słabe lub niestabilne skalowanie na 2 socketach |
| CPU-006 | P1 | AoS↔SoA, normalizacja, maski, redukcje i składanie pola wykonują wiele osobnych pętli szeregowych | Niski poziom użycia CPU i duży ruch pamięci |
| CPU-007 | P1 | RHS Poissona jest składany od nowa metodą elementową w każdym etapie | Powtarzana praca na stałej siatce, mimo liniowości operatora względem `m` |
| CPU-008 | P1 | Rekonstrukcja demag ponownie liczy geometrię i używa kontencyjnych atomików | Słabe skalowanie OpenMP i koszt pamięciowy |
| CPU-009 | P1 | Solvery/preconditionery części ścieżek relaksacji są odtwarzane lub działają domyślnie szeregowo | Duży narzut setupu i brak wykorzystania wątków |
| CPU-010 | P1 | Brak zaakceptowanych bazowych benchmarków CPU | Nie można wiarygodnie zatwierdzić regresji ani przyspieszeń |
| CPU-011 | P2 | PETSc/SLEPc tworzą sekwencyjne macierze na `PETSC_COMM_SELF` | Brak skalowania częstotliwościowego/eigen na wiele rang |
| CPU-012 | P3 | Wszystkie ścieżki Hypre dla głównego FEM używają `MPI_COMM_SELF` | `mpirun -n 2` nie rozdziela jednej symulacji |
| CPU-013 | P3 | Brak rozdzielonej siatki, własności DOF, redukcji globalnych i I/O rangowego | Brak solvera wielowęzłowego |
| CPU-014 | P2 | FEM/BEM przechowuje i mnoży gęsty operator O(N_b²) | Słaba złożoność dla dużej granicy |
| CPU-015 | P1 | Tangent-plane implicit może wykonywać pełny solve demag wewnątrz każdego `GMRES::Mult` | Zagnieżdżony bardzo kosztowny solver w każdej iteracji Krylova |

---

## 2. Dlaczego „100% CPU” nie jest właściwym jedynym celem

Wykorzystanie wszystkich logicznych procesorów nie oznacza automatycznie najlepszego czasu do rozwiązania. FEM jest mieszaniną faz:

- obliczeniowych, które dobrze skalują się z liczbą rdzeni;
- ograniczonych przepustowością pamięci;
- ograniczonych opóźnieniem i synchronizacją;
- szeregowych;
- wymagających globalnych redukcji;
- zależnych od jakości preconditionera, a nie wyłącznie od szybkości pojedynczej iteracji.

Podstawowe miary powinny być następujące:

\[
S(p)=\frac{T(1)}{T(p)},
\qquad
E(p)=\frac{S(p)}{p},
\]

gdzie \(T(p)\) jest czasem rozwiązania dla \(p\) wątków lub rang. Dodatkowo należy raportować:

- czas do osiągnięcia zadanej dokładności fizycznej;
- liczbę iteracji solvera liniowego;
- medianę i p95 czasu każdej fazy;
- efektywną przepustowość pamięci;
- udział dostępu zdalnego NUMA;
- liczbę synchronizacji;
- użycie pamięci i liczbę alokacji;
- stosunek czasu CPU wszystkich workerów do czasu ściennego;
- zmianę trajektorii adaptacyjnej wskutek innej kolejności redukcji.

Dla fazy ograniczonej pamięcią 100% wskazania w menedżerze zadań może oznaczać jedynie, że wiele wątków konkuruje o ten sam kontroler pamięci. Po osiągnięciu nasycenia jeden socket może być szybszy niż dwa sockety, jeżeli strony pamięci zostały zaalokowane na jednym węźle NUMA.

---

## 3. Mapa aktualnej architektury wykonania CPU

Uproszczony przepływ jednej ewaluacji RHS dynamiki:

```text
Python plan
  -> fullmag-runner (Rust)
     -> natywny ABI FEM
        -> Context
           -> AoS m_xyz
           -> MFEM GridFunction x/y/z
           -> exchange
           -> demag Poisson albo FEM/BEM
           -> DMI + pola lokalne
           -> sumowanie H_eff
           -> LLG RHS
           -> etap RK / kontrola błędu
           -> snapshot / artefakty
```

W tej architekturze:

- stan autorytatywny jest przechowywany jako przeplatany `std::vector<double>` AoS;
- MFEM korzysta z trzech skalarnych `GridFunction` dla `m_x`, `m_y`, `m_z`;
- wiele wywołań wymaga deinterleave, kopiowania, projekcji periodycznej i ponownego pack;
- wymiana i demag są wykonywane kolejno;
- pole efektywne jest składane przez serię osobnych przejść po całym polu;
- integrator wykonuje kolejne osobne pętle do tworzenia etapów, kandydata, błędu, normalizacji i redukcji;
- Hypre otrzymuje pełną macierz szeregową na `MPI_COMM_SELF`;
- runner nie posiada pierwszoklasowej polityki zasobów CPU/MPI.

Ta organizacja jest poprawna jako referencyjny backend szeregowy, lecz nie jest jeszcze architekturą zoptymalizowaną pod pamięć, NUMA i MPI.

---

## 4. Audyt wyboru liczby wątków

### 4.1. Rzeczywista precedencja ustawień

W `backends/fem/cpu/mfem/runtime/cpu_threads.cpp::requested_cpu_threads()` obowiązuje:

1. `FULLMAG_CPU_THREADS=auto`;
2. dodatnia wartość `OMP_NUM_THREADS`;
3. dodatnia wartość `FULLMAG_CPU_THREADS`;
4. automatyczne wykrycie przez `omp_get_num_procs()` albo `hardware_concurrency()`.

To jest nieintuicyjne. Zmienna specyficzna dla Fullmag powinna mieć wyższy priorytet niż ogólny fallback OpenMP.

W `compose.windows.yaml` usługa CPU ustawia równocześnie:

```yaml
FULLMAG_CPU_THREADS: "${FULLMAG_CPU_THREADS:-auto}"
OMP_NUM_THREADS: "${OMP_NUM_THREADS:-16}"
```

W efekcie:

```powershell
$env:FULLMAG_CPU_THREADS = "30"
```

nie wystarcza, jeżeli `OMP_NUM_THREADS` nadal wynosi `16`. Parser wybiera 16 i raportuje tryb manualny.

### 4.2. Obecne automatyczne limity

Dla trybu `auto` kod stosuje:

- do 10 000 węzłów **lub** 75 000 elementów: maksymalnie 8 wątków;
- do 50 000 węzłów **lub** 400 000 elementów: maksymalnie 16 wątków;
- powyżej: brak limitu.

Problemy:

1. Progi nie są poparte zaakceptowaną bazą benchmarków.
2. Użycie operatora `||` może wymusić limit, gdy tylko jedna z dwóch metryk jest mała.
3. Ta sama polityka jest stosowana niezależnie od dominującej interakcji i algorytmu.
4. Nie rozróżnia pracy elementowej, SpMV, AMG, BEM, relaksacji ani lokalnych pól.
5. Nie uwzględnia fizycznych rdzeni, SMT, socketów, cpusetów kontenera ani quota CPU.
6. Nie uwzględnia rozmiaru pamięci roboczej na wątek.
7. Jest ustalana dla kontekstu, ale `omp_set_num_threads()` działa procesowo/globalnie.

### 4.3. Ryzyko wielu kontekstów w jednym procesie

`omp_set_num_threads()` oraz konfiguracja `mfem::Device` są zasobami procesu, podczas gdy wynik jest przechowywany w `Context`. Jeżeli dwa konteksty zostaną utworzone z inną polityką wątków:

- późniejsza inicjalizacja może zmienić globalne ustawienie OpenMP;
- telemetria wcześniejszego kontekstu może nie odpowiadać realnemu wykonaniu;
- równoległe symulacje mogą się wzajemnie oversubskrybować.

Potrzebny jest procesowy `CpuResourceManager`, który:

- rozwiązuje politykę raz;
- przydziela budżet symulacjom;
- blokuje sprzeczne ustawienia globalne albo uruchamia symulacje w osobnych procesach;
- publikuje jeden receipt zasobów.

### 4.4. Wymagany kontrakt konfiguracji

Docelowa precedencja:

```text
jawne pole planu/API/UI
  > FULLMAG_CPU_THREADS
  > OMP_NUM_THREADS jako kompatybilnościowy fallback
  > cpuset-aware auto
```

Wymagana reprezentacja:

```cpp
struct CpuExecutionPolicy {
    enum class ThreadMode { auto_detect, manual };
    enum class Affinity { none, close, spread };
    enum class SmtPolicy { physical_cores_first, allow_smt, require_smt };
    enum class NumaPolicy { local, first_touch, interleave, bind };
    enum class Determinism { fast, deterministic_reductions };

    ThreadMode thread_mode;
    int omp_threads;
    int rayon_threads;
    int blas_threads;
    int hypre_threads;
    int mpi_ranks;
    int threads_per_rank;
    Affinity affinity;
    SmtPolicy smt;
    NumaPolicy numa;
    Determinism determinism;
};
```

Receipt wykonania powinien zawierać co najmniej:

```json
{
  "requested_threads": 30,
  "effective_threads": 30,
  "logical_cpus_visible": 64,
  "physical_cores_visible": 32,
  "sockets": 2,
  "numa_nodes": 2,
  "cpuset": "0-29",
  "omp_places": "cores",
  "omp_proc_bind": "spread",
  "mpi_ranks": 1,
  "threads_per_rank": 30,
  "mfem_device": "omp",
  "hypre_openmp": true,
  "oversubscription": false
}
```

### 4.5. Tymczasowe uruchomienie 30 wątków

Do czasu wdrożenia pierwszoklasowego parametru należy ustawić **obie** zmienne:

```powershell
$env:FULLMAG_CPU_THREADS = "30"
$env:OMP_NUM_THREADS = "30"
$env:RAYON_NUM_THREADS = "30"
$env:OMP_PLACES = "cores"
$env:OMP_PROC_BIND = "spread"

# Następnie zwykły launcher Fullmag FEM dla Windows.
```

Linux/container:

```bash
FULLMAG_CPU_THREADS=30 \
OMP_NUM_THREADS=30 \
RAYON_NUM_THREADS=30 \
OMP_PLACES=cores \
OMP_PROC_BIND=spread \
just fem-managed-headless cpu path/to/problem.py
```

Należy porównać `OMP_PROC_BIND=close` i `spread`. Dla jednej domeny NUMA często korzystniejszy jest `close`; dla dwóch socketów i dobrze rozłożonej pamięci `spread` może być lepszy. Nie wolno uznać jednej wartości za uniwersalną bez pomiaru.

> To obejście nie zmienia faktu, że wiele operatorów pozostaje szeregowymi operatorami MFEM/legacy sparse.

---

## 5. MFEM jest skompilowane z OpenMP, ale CPU runtime nie wybiera backendu `omp`

Obraz `docker/fem-cpu/Dockerfile` buduje:

```text
MFEM_USE_MPI=YES
MFEM_USE_OPENMP=YES
MFEM_USE_METIS=NO
MFEM_USE_CEED=NO
MFEM_USE_HYPRE=YES
```

Jednocześnie gałąź CPU-only w `context_initialize_mfem()` tworzy:

```cpp
global_device = new mfem::Device("cpu");
```

i ignoruje ewentualne `FULLMAG_FEM_MFEM_DEVICE=omp`.

Zgodnie z dokumentacją MFEM backend `cpu` jest domyślnym backendem szeregowym na każdej randze, natomiast `omp` aktywuje backend OpenMP. Zmiana na `omp` jest więc koniecznym krokiem kwalifikacyjnym, ale nie wystarczającym:

- część legacy `SparseMatrix` może nadal nie skalować się jak operator matrix-free;
- ręczne pętle Fullmag muszą nadal zostać zrównoleglone;
- trzeba sprawdzić bezpieczeństwo wielowątkowe coefficientów i element transformations;
- `mfem::Device` jest konfiguracją globalną i nie może być bezkarnie przełączane per `Context`.

### Zalecana poprawka

1. Ujednolicić gałąź CPU-only i CUDA-capable:
   - pobierać `configured_mfem_device_string(ctx)`;
   - domyślnie wybierać `omp` dla produkcyjnego CPU, jeżeli build potwierdza OpenMP;
   - zachować jawny `cpu` jako tryb referencyjny/deterministyczny.
2. Opublikować capability:
   - `openmp_compiled`;
   - `mfem_omp_available`;
   - `mfem_device_requested`;
   - `mfem_device_effective`.
3. Dodać test uruchomieniowy, nie tylko test tekstowy:
   - `cpu` kontra `omp`;
   - zgodność pól/energii;
   - pomiar faz na dużej siatce.
4. Nie zmieniać domyślnej ścieżki na `omp` przed uzyskaniem evidence dla wszystkich obsługiwanych elementów i interakcji.

---

## 6. Brak rzeczywistego MPI dla jednej symulacji

`backends/fem/cpu/mfem/runtime/mpi_init.hpp` zawiera jednoznaczny kontrakt:

- Fullmag FEM jest obecnie solverem szeregowym;
- szeregowa `mfem::SparseMatrix` jest opakowana w `HypreParMatrix`;
- komunikatorem jest `MPI_COMM_SELF`;
- partycja `{0,N}` jest poprawna tylko dla jednego procesu.

Nie znaleziono produkcyjnego użycia:

- `mfem::ParMesh`;
- `mfem::ParFiniteElementSpace`;
- `mfem::ParGridFunction`;
- `mfem::ParBilinearForm`;
- lokalnych/true DOF per rank;
- ghost/halo exchange;
- globalnych redukcji na `MPI_COMM_WORLD`;
- rangowego checkpointingu i I/O.

### 6.1. Co stanie się po `mpirun -n 2`

Uruchomienie dwóch rang nie rozdzieli jednej macierzy. Każda ranga otrzyma własny `MPI_COMM_SELF` i pełny problem. W najlepszym przypadku zostaną wykonane dwie niezależne kopie. W najgorszym przypadku wystąpi konflikt w artefaktach, portach lub globalnym stanie procesu.

Nie należy reklamować obecnych testów `n=2` jako dowodu distributed FEM. Mogą one dowodzić jedynie, że kod nie używa błędnie `MPI_COMM_WORLD` dla szeregowego wrappera.

### 6.2. Co można skalować na HPC już teraz

Bez przebudowy domenowej można wdrożyć **skalowanie zadaniowe**:

- jedna ranga/proces = jedna niezależna symulacja;
- różne pola zewnętrzne, częstotliwości, parametry materiałowe albo realizacje termiczne;
- scheduler przydziela niezależne zadania;
- osobne katalogi artefaktów;
- agregacja po zakończeniu.

To nie przyspiesza pojedynczej symulacji, ale może wykorzystać cały klaster dla sweepów.

### 6.3. Co jest potrzebne do skalowania domenowego

Minimalna architektura:

1. Partycjonowanie siatki na rank 0 albo wczytanie już rozdzielonej siatki.
2. `ParMesh(MPI_COMM_WORLD, serial_mesh, partitioning)`.
3. `ParFiniteElementSpace` dla skalarnych i wektorowych pól.
4. Rozdzielony właściciel:
   - magnetyzacji;
   - materiałów;
   - masek regionów;
   - periodycznych klas DOF;
   - pola demag i potencjału.
5. Operatory:
   - `ParBilinearForm`;
   - `HypreParMatrix`;
   - prawidłowe row starts;
   - rozdzielone preconditionery.
6. Redukcje:
   - energia;
   - maksymalny torque;
   - norma błędu;
   - kryteria adaptacyjne;
   - statystyki.
7. Komunikacja halo przed operatorami lokalnymi.
8. Rank-aware I/O i zapis tylko z rank 0 dla danych globalnych.
9. Kontrola przerwania rozgłaszana na communicatorze.
10. Testy 1/2/4 rang oraz różne partycje.
11. METIS/ParMETIS albo jawnie dostarczony produkcyjny partitioning.
12. Receipt: `world_size`, rank, local/global DOF, imbalance, communication time.

---

## 7. Gotowość komputera dwuprocesorowego i NUMA

### 7.1. Aktualny problem

`omp_get_num_procs()` zwraca procesory widoczne dla runtime, zwykle logiczne CPU. Nie zapewnia informacji o:

- liczbie socketów;
- liczbie rdzeni fizycznych;
- wątkach SMT na rdzeń;
- domenach NUMA;
- cpuset cgroup/Docker;
- lokalizacji stron pamięci;
- affinity workerów.

Duże wektory są zwykle alokowane/zerowane szeregowo. Polityka first-touch umieszcza wtedy większość stron na NUMA node procesu inicjalizującego. Gdy OpenMP rozciągnie pracę na drugi socket, połowa workerów może stale czytać i zapisywać zdalną pamięć.

### 7.2. Miejsca szczególnie wrażliwe na first-touch

- gęsta macierz FEM/BEM;
- `m_xyz`, pola składowe i bufor etapów RK;
- per-thread residual DMI;
- macierze CSR i wektory Hypre;
- bufory demag recovery;
- tangent-plane operator;
- duże wyjściowe pola wizualizacyjne.

### 7.3. Zalecana warstwa topologii

Wprowadzić `hwloc` jako preferowany provider topologii, z fallbackiem systemowym:

```text
visible processing units
physical cores
sockets
NUMA nodes
core -> PU map
NUMA node -> CPU map
container cpuset
```

Polityka `auto` powinna:

1. używać fizycznych rdzeni pierwszego socketu jako bezpiecznego punktu startowego;
2. dopiero dla dużego problemu porównywać oba sockety;
3. uruchamiać SMT dopiero po nasyceniu rdzeni fizycznych;
4. respektować cpuset, a nie host-wide `nproc`;
5. unikać mieszania OpenMP i wielowątkowego BLAS/Hypre ponad budżet.

### 7.4. Dwa tryby do kwalifikacji

**Tryb A — jeden proces, wszystkie fizyczne rdzenie:**

```text
MPI ranks = 1
OMP threads = wszystkie rdzenie fizyczne
OMP_PLACES=cores
OMP_PROC_BIND=spread
NUMA=parallel-first-touch albo interleave
```

**Tryb B — jedna ranga na socket:**

```text
MPI ranks = liczba socketów
OMP threads per rank = rdzenie fizyczne socketu
rank binding = socket
OMP_PROC_BIND=close
memory binding = local
```

Tryb B wymaga już rozdzielonej domeny MPI. Dopóki jej nie ma, dwóch procesów nie wolno używać dla jednej symulacji.

---

## 8. Audyt hot path: kosztowne hashowanie zależności

### 8.1. Exchange

`make_exchange_operator_dependency_key()` hashuje m.in.:

- connectivity;
- typy elementów;
- współrzędne;
- geometrię MFEM;
- materiały;
- warunki brzegowe;
- periodyczność.

`compute_exchange_field()` wywołuje ten mechanizm w trakcie ewaluacji pola. Dla stałej siatki i stałych materiałów oznacza to pełne szeregowe skanowanie danych przed właściwym operatorem.

### 8.2. Demag

Analogiczny klucz zależności Poissona skanuje geometrię, topologię, materiały, granice, periodyczność i politykę solvera. Jest wywoływany:

- na poziomie ogólnej demagnetyzacji;
- ponownie w ścieżce Poisson solve.

W efekcie jeden świeży solve może wykonać dwa pełne hashe.

### 8.3. Poprawny model invalidacji

Zamiast hashowania danych w hot path należy utrzymywać monotoniczne rewizje:

```cpp
struct FemRevisionSet {
    uint64_t mesh_topology;
    uint64_t mesh_geometry;
    uint64_t regions;
    uint64_t materials;
    uint64_t boundary_conditions;
    uint64_t periodicity;
    uint64_t solver_policy;
};
```

Każda mutacja zwiększa odpowiednią rewizję. Operator zapisuje snapshot rewizji. Sprawdzenie ważności staje się O(1).

Pełny hash należy zachować:

- przy imporcie planu;
- w trybie diagnostycznym;
- w metadanych artefaktu;
- w testach wykrywających nielegalną mutację bez podbicia rewizji.

### 8.4. Testy wymagane

- zmiana `A` invaliduje exchange;
- zmiana `Ms`/boundary invaliduje odpowiedni operator;
- zmiana samej magnetyzacji nie invaliduje stałego operatora;
- brak jakiegokolwiek skanowania connectivity w profilerze etapu;
- licznik `dependency_validation_bytes` wynosi zero w hot path;
- debug hash i revision key dają zgodną decyzję dla zestawu mutacji.

To jest jedna z najbezpieczniejszych poprawek P0: nie zmienia fizyki ani dyskretyzacji.

---

## 9. Reprezentacja pola i ruch pamięci AoS↔SoA

### 9.1. Stan obecny

Fullmag przechowuje magnetyzację jako:

```text
[mx0, my0, mz0, mx1, my1, mz1, ...]
```

MFEM używa trzech skalarnych pól:

```text
mx[0..N), my[0..N), mz[0..N)
```

Adapter wykonuje wielokrotnie:

- walidację map periodycznych;
- sprawdzanie równości reprezentantów;
- deinterleave AoS;
- kopię do `GridFunction`;
- `GetTrueDofs`/`SetFromTrueDofs`;
- ponowny pack;
- normalizację;
- zerowanie węzłów niemagnetycznych;
- projekcję periodyczną.

Znaczna część tych pętli nie ma OpenMP.

### 9.2. Zalecenia krótkoterminowe

1. Walidować mapę periodyczną tylko po zmianie rewizji.
2. Pisać bezpośrednio do pamięci `GridFunction`, bez bufora pośredniego.
3. Łączyć w jedną pętlę:
   - deinterleave;
   - maskę magnetyczną;
   - frozen spins;
   - normalizację, gdy jest wymagana.
4. Zrównoleglić pętle przez statyczne bloki i SIMD.
5. Utrzymywać persistent scratch zamiast tworzyć wektory tymczasowe.
6. Nie wykonywać pack do AoS, jeżeli konsument pozostaje w MFEM/SoA.

### 9.3. Zalecenie architektoniczne

Docelowo rozważyć wektorowe `FiniteElementSpace` albo trwałą reprezentację SoA jako autorytatywną dla solvera. AoS powinno być formatem API/artefaktu, nie formatem wymuszającym konwersję przed każdym operatorem.

Należy przy tym zachować dokładny kontrakt porządku DOF i periodyczności.

---

## 10. Dynamika LLG i integratory Rungego–Kutty

### 10.1. Szeregowe pętle

W ścieżce LLG/RK pozostają osobne skany dla:

- normalizacji;
- obliczenia torque;
- tłumienia;
- wyzerowania niemagnetycznych/frozen DOF;
- maksymalnej amplitudy RHS;
- utworzenia kolejnego etapu;
- utworzenia kandydata;
- oszacowania błędu;
- normy adaptacyjnej;
- strażnika kąta;
- porównania endpointu.

Te operacje są proste arytmetycznie i dobrze nadają się do OpenMP/SIMD, ale są wrażliwe na deterministyczność redukcji.

### 10.2. Fuzja pętli

Przykładowa bezpieczna fuzja:

```text
dla każdego aktywnego węzła:
  odczytaj m i H_eff
  oblicz m × H i m × (m × H)
  dodaj torque bezpośredni
  zastosuj frozen/magnetic mask
  zapisz RHS
  zaktualizuj lokalne maksimum
```

Redukcję maksimum wykonać deterministycznie:

1. stałe bloki indeksów;
2. lokalny wynik per blok;
3. sekwencyjne złożenie wyników bloków w ustalonej kolejności.

Daje to stabilniejszy przebieg niż standardowa redukcja o nieokreślonej kolejności.

### 10.3. Adaptacyjna kontrola błędu

Aktualna norma masowa i guard kąta wykonują drogie operacje na każdym DOF. Możliwości:

- jedna wspólna pętla dla normy błędu, finite check i guard;
- porównanie iloczynu skalarnego z `cos(theta_max)` zamiast `acos` dla decyzji;
- `acos` tylko dla końcowej telemetrii maksymalnego węzła;
- wektorowe obliczanie wag;
- chunked deterministic reduction.

### 10.4. Endpoint refresh

Pełne `std::equal` pola i dodatkowe odświeżenie zaakceptowanego endpointu mogą powodować:

- pełny skan O(N);
- dodatkową ewaluację pola;
- w konsekwencji dodatkowy solve demag.

Należy zastąpić porównanie generacją:

```text
state_generation
field_generation
rk_stage_generation
```

Jeżeli ostatni etap jest matematycznie endpointem i nie został zmodyfikowany przez projekcję, cache może być uznany bez pełnego porównania. Dla FSAL należy przechowywać jawny dowód zgodności.

---

## 11. Pole efektywne: zbyt wiele osobnych przejść po pamięci

Składanie `H_eff` wykonuje osobne kroki dla:

- exchange;
- demag;
- anisotropy;
- Zeeman;
- field drive;
- DMI;
- Oersted;
- thermal;
- magnetoelastic;
- periodyczności;
- energii i statystyk.

Dodatkowo wyłączone interakcje często zerują pełne bufory.

### Zalecana strategia

1. `InteractionActiveSet` ustalony raz na etap/stage.
2. Nie materializować pola interakcji, jeżeli:
   - jest wyłączona;
   - nie jest żądana jako quantity;
   - może być dodana bezpośrednio do `H_eff`.
3. Użyć jednej pętli kompozycji:
   - odczytać tylko aktywne bufory;
   - dodać pola lokalne on-the-fly;
   - zastosować maskę i periodyczność;
   - opcjonalnie akumulować energię.
4. Oddzielić tryb:
   - `field_only`;
   - `field_and_energy`;
   - `field_energy_and_quantities`.

Integrator zwykle potrzebuje pola, ale nie musi w każdym wewnętrznym etapie produkować pełnego zestawu quantity i energii diagnostycznych.

---

## 12. Exchange

### 12.1. Pozytywne elementy

- stałe formy exchange/mass są przechowywane;
- istnieje workspace;
- część cache solvera consistent-mass jest utrzymywana;
- dostępne są liczniki faz.

### 12.2. Główne problemy

1. Trzy komponenty są obsługiwane kolejno.
2. Konwersja AoS/SoA jest szeregowa.
3. Legacy sparse operator ogranicza wykorzystanie backendu MFEM.
4. Lumped projection jest szeregową pętlą.
5. Ścieżka periodyczna tworzy i zeruje tymczasowe wektory dla każdego komponentu.
6. Consistent-mass:
   - wykonuje trzy oddzielne CG;
   - startuje od zera;
   - ma stałą tolerancję niezależną od błędu zewnętrznego;
   - wykonuje dodatkowe residual SpMV.
7. Klucz zależności jest budowany w hot path.

### 12.3. Zalecenia

**P0:**

- rewizje zamiast hashy;
- persistent periodyczny scratch;
- precompute reduced mass i reduced `Ms`;
- zrównoleglony lumped projection;
- warm start dla consistent-mass;
- telemetria czasu pack/operator/projection oddzielnie.

**P1:**

- trzy RHS jako blok/SpMM;
- wektorowe FE albo trzykomponentowy operator;
- `mfem::Device("omp")` kwalifikowany testami;
- tolerancja mass solve sprzężona z wymaganym błędem pola, nie sztywno z jednym globalnym numerem.

**P2:**

- kwalifikacja partial assembly/libCEED na aktualnie obsługiwanych elementach;
- aktualizacja MFEM dopiero po porównaniu fizyki i wydajności;
- zachowanie legacy sparse jako oracle.

---

## 13. Demagnetyzacja Poissona

Demag zwykle dominuje pełną dynamikę FEM, dlatego największe przyspieszenie będzie pochodzić z usunięcia powtarzanej pracy, a nie tylko zwiększania zespołu OpenMP.

### 13.1. RHS jest liniowy względem magnetyzacji

Dla stałej siatki, materiałów i warunków brzegowych dyskretny RHS można zapisać w postaci:

\[
b(m) = B_x m_x + B_y m_y + B_z m_z,
\]

albo jako jeden operator blokowy:

\[
b(m)=B\,m.
\]

Obecna ścieżka ponownie wykonuje integrację elementową i restrykcję true DOF przy każdym etapie RK. To jest niepotrzebne, jeżeli operator \(B\) został już złożony i nie zmieniły się zależności.

### 13.2. Zalecana przebudowa RHS

1. Podczas setupu złożyć sparse coupling operator.
2. Zapisać go w cache zależnym od rewizji mesh/material/boundary.
3. W hot path wykonać wyłącznie:
   - pack/deinterleave;
   - 1–3 SpMV albo blokowy SpMM;
   - nałożenie warunków.
4. Dodać oracle porównujący nowy RHS ze starym elementowym assembly.
5. Zmierzyć:
   - błąd względny;
   - czas setupu;
   - czas apply;
   - pamięć CSR.

### 13.3. Solve

Pozytywne elementy:

- istnieje cache macierzy i AMG;
- warm start potencjału jest możliwy;
- osobno mierzone są setup i apply.

Problemy:

- pełna macierz jest opakowana w `HypreParMatrix` na `MPI_COMM_SELF`;
- kopie RHS/solution są szeregowe;
- accepted solution jest kopiowane dla rollbacku;
- część setupu może być odtwarzana przy niepotrzebnej invalidacji;
- fixed Krylov parameters nie są strojone względem problemu;
- brak baseline potwierdzającego rzeczywistą liczbę cache hitów.

Zalecenia:

- revision key;
- podwójny bufor potencjału zamiast pełnego backup copy;
- delayed commit transakcji;
- persistent Hypre vectors;
- jawny licznik setup rebuild reason;
- polityka solvera wybierana benchmarkiem;
- tryb mixed/flexible tolerance zależny od etapu zewnętrznego, ale wyłącznie po walidacji fizyki.

### 13.4. Rekonstrukcja pola

Aktualna rekonstrukcja:

- ponownie pobiera elementy i transformations;
- liczy shape derivatives na stałej geometrii;
- akumuluje nodal output atomikami;
- wykonuje dodatkowe pętle walidacyjne;
- tworzy pola physics/visual;
- może od razu liczyć energię.

Problemy z atomikami rosną przy zagęszczonej siatce, gdzie wiele elementów zapisuje do tych samych węzłów.

Lepsze warianty:

1. **Preassembled recovery operator**
   \[
   h = G \phi,
   \]
   gdzie \(G\) jest stałym operatorem gradientu/projekcji.
2. **Node gather**
   - precompute node→element adjacency;
   - każdy wątek jest właścicielem zakresu węzłów;
   - brak atomików.
3. **Element coloring**
   - elementy jednego koloru nie współdzielą nodal output;
   - koszt kolejnych kolorów kontra brak atomików.
4. **Blocked sparse accumulation**
   - lokalne bufory dla kafla, nie pełne `threads × 3N`.

Należy usunąć heurystykę ograniczającą liczbę wątków na podstawie hipotetycznego pełnego bufora per thread, jeżeli rzeczywista implementacja go nie alokuje. Polityka pamięci musi opierać się na faktycznym `workspace_bytes_per_thread`.

### 13.5. Energia

W etapach wewnętrznych RK często wystarczy pole. Energia może być potrzebna:

- w zaakceptowanym endpoint;
- w relaksacji z Armijo;
- podczas publikacji/quantity;
- dla diagnostyki.

Należy jawnie przekazywać `EvaluationIntent` i nie wykonywać rekonstrukcyjnej energii, jeżeli wynik nie jest konsumowany.

---

## 14. Demagnetyzacja FEM/BEM

Aktualna implementacja przechowuje gęsty operator graniczny. Dla \(N_b\) granicznych DOF:

- pamięć: \(O(N_b^2)\);
- budowa: \(O(N_b^2)\);
- apply: \(O(N_b^2)\).

OpenMP może przyspieszyć wiersze, ale nie zmieni złożoności.

### 14.1. Problemy krótkoterminowe

- szeregowe `assign` dużej macierzy powoduje first-touch na jednym NUMA node;
- ręczny GEMV może przegrywać z dopracowanym BLAS;
- solver/preconditioner mogą być odtwarzane;
- wybór Hypre zależy od stanu inicjalizacji MPI, co może kierować czyste uruchomienie do ścieżki szeregowej;
- nadal używany jest `MPI_COMM_SELF`.

### 14.2. Poprawki

**P1:**

- równoległy first-touch macierzy;
- benchmark własnego GEMV kontra BLAS;
- wyraźny budżet BLAS threads;
- cache symbolic/factorization/preconditioner;
- poprawa wyboru Hypre niezależnie od wcześniejszego `MPI_Initialized`;
- workspace bez per-call allocations.

**P2/P3:**

- H-matrix/ACA;
- FMM;
- distributed boundary operator;
- kompresja bloków i kontrola błędu.

FEM/BEM nie powinno blokować wdrożenia skalowalnego Poisson airbox, ale musi mieć jasno oznaczony zakres rozmiarów.

---

## 15. DMI

DMI jest jednym z nielicznych miejsc z jawną równoległością elementową. Jest to dobry wzorzec organizacyjny, ale obecna metoda akumulacji ma ograniczenia.

### 15.1. Aktualny wzorzec

- elementy są dzielone przez `omp for`;
- każdy wątek ma lokalne obiekty MFEM;
- każdy wątek ma pełny residual `3N`;
- po zakończeniu następuje szeregowa redukcja `threads × 3N`.

### 15.2. Problemy

Dla 30 wątków pamięć residuali wynosi:

\[
30 \times 3N \times 8\ \text{bajtów},
\]

bez uwzględnienia pozostałych pól. Dla dużego N koszt zerowania i redukcji może przewyższyć pętlę elementową. Szeregowa redukcja staje się częścią Amdahla.

### 15.3. Zalecenia

- raportować dokładny `workspace_bytes`;
- równoległa redukcja po blokach indeksów;
- adaptive strategy:
  - mały N: full per-thread residual;
  - średni N: blokowe bufory;
  - duży N: coloring/ownership;
- nie walidować mapy periodycznej przy każdym wywołaniu;
- nie kopiować ponownie całej magnetyzacji, jeżeli aktualny MFEM state ma tę samą generację;
- sprawdzić thread safety wszystkich użytych obiektów MFEM pod ThreadSanitizerem i dedykowanym stress testem.

---

## 16. Relaksacja: projected-gradient BB i nonlinear CG

### 16.1. Szeregowa algebra wektorowa

Relaksacja wykonuje wiele pełnych skanów:

- projekcja na przestrzeń styczną;
- normy i iloczyny skalarne z masą/energią;
- transport secant;
- `negative_field`;
- retraction;
- finite checks;
- walidacja stanu;
- BB1/BB2;
- kopie poprzednich pól.

Część funkcji tworzy nowe wektory wynikowe i wykonuje kolejne przejścia po tych samych danych.

### 16.2. Preconditioner exchange + mass

Domyślna polityka direct minimizer wybiera szeregowe:

```text
MFEM CG + GSSmoother
```

Hypre jest tylko opt-in przez zmienną środowiskową. Po wybraniu Hypre ścieżka:

- tworzy `HypreParMatrix`;
- tworzy wektory;
- tworzy AMG;
- tworzy PCG;
- robi to dla kolejnych komponentów;
- nadal używa `MPI_COMM_SELF`.

To kasuje znaczną część korzyści preconditionera.

### 16.3. Plan naprawy

1. Persistent `RelaxationWorkspace`.
2. Funkcje `_into`, które nie alokują.
3. Fuzja:
   - tangent projection;
   - norm;
   - finite check;
   - frozen mask.
4. Deterministyczne równoległe redukcje.
5. Block solve dla trzech komponentów.
6. Cache Hypre matrix/AMG/vectors przy stałym operatorze.
7. Warm start.
8. Wybór serial/Hypre jako jawna polityka planu.
9. Profile:
   - preconditioner setup;
   - preconditioner apply;
   - line-search field evaluations;
   - state copy;
   - metric/retraction.
10. Zmniejszenie liczby pełnych snapshotów w backtrackingu przez transakcyjny double buffer.

---

## 17. Tangent-plane implicit

To najbardziej ryzykowna ścieżka CPU pod względem złożoności zagnieżdżonej.

### 17.1. Aktualne koszty

Dla każdego backtracku:

- budowane są tangent frames;
- składany jest tangent operator;
- tworzony jest solver/preconditioner;
- wykonywany jest solve;
- wykonywana jest pełna próba i snapshot;
- w razie odrzucenia procedura jest powtarzana z innym krokiem.

Gdy aktywne są matrix-free termy DMI/demag, `MatrixFreeTangentPlaneOperator::Mult`:

- rozszerza wektor styczny do pola;
- ponownie oblicza DMI;
- może wykonać świeży solve demag Poissona;
- składa wynik;
- robi to dla każdej iteracji GMRES.

Jeżeli GMRES wykonuje \(k\) iteracji, jedna próba line search może wywołać około \(k\) pełnych solve demag, poza zwykłymi snapshotami. To jest algorytmiczny blocker, nie problem samego OpenMP.

### 17.2. Wymagana przebudowa

1. Stały liniowy operator demag:
   \[
   \delta H_\mathrm{demag} = D\,\delta m,
   \]
   złożony jako kompozycja preassembled RHS, Poisson inverse i recovery.
2. Reuse operatorów i preconditionera między Krylov iterations.
3. Persistent tangent frames, aktualizowane tylko gdy zmieni się `m`.
4. Rozdzielenie części:
   - stałej mass/exchange;
   - lokalnie zmiennej anisotropy;
   - liniowej DMI/demag.
5. Preconditioner blokowy przybliżający Schur.
6. Warm start między backtrackami.
7. Nie składać całej sparse matrix od nowa, jeżeli zmienia się tylko skalar kroku; użyć operator sum/scaled operator.
8. Wprowadzić twardy profiler:
   - liczba demag applies wewnątrz jednego tangent solve;
   - liczba Krylov iterations;
   - liczba rebuildów;
   - koszt preconditionera.

Dopóki ten punkt nie zostanie naprawiony, tangent-plane implicit nie powinien być używany jako dowód skalowania CPU.

---

## 18. PETSc/SLEPc i częstotliwościowe solvery CPU

### 18.1. Canonical CPU image

`docker/fem-cpu/Dockerfile` ustawia `FULLMAG_FEM_WITH_SLEPC=OFF`. Oznacza to, że część kodu PETSc/SLEPc nie jest aktywna w kanonicznym obrazie CPU, mimo że istnieje w repozytorium.

### 18.2. Sparse direct driven response

Ścieżka `cpu_sparse_direct_engine.cpp`:

- przyjmuje macierze wejściowe jako gęste row-major;
- skanuje \(N^2\);
- buduje real-split CSR dla każdej częstotliwości;
- tworzy `MatCreateSeqAIJ(PETSC_COMM_SELF, ...)`;
- tworzy sekwencyjne wektory;
- tworzy KSP;
- używa `KSPPREONLY + PCLU`;
- niszczy wszystko po solve;
- blokuje globalnym mutexem;
- oblicza true residual przez gęstą pętlę \(O(N^2)\).

Ta ścieżka nie jest produkcyjnym skalowalnym sparse direct solverem.

### 18.3. Modal/eigen

W kilku adapterach występują:

```text
MatCreateSeqAIJ(PETSC_COMM_SELF, ...)
```

co oznacza jednorankowe macierze. Docelowo potrzebne są:

- `MATMPIAIJ` albo `MatCreateAIJ` na communicatorze wielorangowym;
- rozdzielone Vec;
- SLEPc na `PETSC_COMM_WORLD`/subcommunicator;
- MUMPS/SuperLU_DIST albo iteracyjny shift-invert;
- podział zespołów rang na niezależne contour points/frequencies;
- reuse symbolic factorization dla sweepu częstotliwości;
- CSR-native payload, bez przejścia przez dense row-major.

### 18.4. Równoległość częstotliwości jako szybki etap pośredni

Nawet przed distributed matrix można uruchamiać niezależne częstotliwości w osobnych procesach, pod warunkiem:

- wspólnego read-only operator cache;
- osobnych obiektów PETSc;
- braku globalnego mutexa blokującego cały sweep;
- jawnego limitu pamięci;
- dedykowanych katalogów wyników.

To jest równoległość zadaniowa, nie domenowa.

---

## 19. Profilowanie i observability

Repozytorium ma rozbudowane timery solvera, co jest mocną stroną. Brakuje jednak danych niezbędnych do diagnozy wielowątkowości.

### 19.1. Brakujące metryki

- CPU model;
- sockets/cores/SMT/NUMA;
- cpuset kontenera;
- affinity workerów;
- aggregate process CPU time;
- per-thread CPU time;
- context switches;
- migrations między CPU;
- remote/local NUMA pages;
- memory bandwidth;
- cache miss;
- OpenMP team size obserwowany wewnątrz regionu;
- Hypre thread count;
- BLAS vendor/thread count;
- PETSc communicator size;
- local/global DOF;
- load imbalance per rank;
- MPI communication time;
- bytes copied w AoS/SoA;
- dependency hash bytes;
- workspace allocation/zeroing bytes.

`CLOCK_THREAD_CPUTIME_ID` w warstwie Rust mierzy tylko bieżący wątek, a nie cały zespół workerów C++/OpenMP. Nie może służyć jako wskaźnik wykorzystania całego CPU.

### 19.2. Proponowany profiler

Dodać trzy poziomy:

1. **Receipt statyczny**
   - sprzęt, build, affinity, polityka.
2. **Phase timers**
   - obecne timery rozszerzone o pack/hash/reduction/setup.
3. **Counters**
   - iteracje, cache hit, bytes, allocations, OpenMP regions, MPI reductions.

Opcjonalna integracja na Linux:

- `perf stat`;
- `perf record`;
- `numastat`;
- `hwloc-bind`;
- LIKWID;
- Intel VTune albo AMD uProf na odpowiedniej platformie.

Pomiar zewnętrzny musi być skorelowany z natywnymi phase IDs.

---

## 20. Brak zaakceptowanego baseline

`docs/performance/fem_cpu_baselines.md` stwierdza, że:

- wiring benchmarków istnieje;
- zaakceptowany baseline nadal jest otwarty;
- nie zapisano kontrolowanego CSV dla CPU;
- większość rodzin pomiarowych ma status open.

Istniejący `scripts/benchmark_permalloy_fem_demag.py` jest dobrym początkiem:

- wykonuje sweep 10/20/30/40;
- ustawia jednocześnie `FULLMAG_CPU_THREADS`, `OMP_NUM_THREADS` i `RAYON_NUM_THREADS`;
- zbiera fazy demag i iteracje.

Brakuje jednak:

- committowanego, zatwierdzonego raportu;
- thread sweep od 1 do physical/logical maximum;
- affinity/NUMA matrix;
- exchange-only/local-only;
- różnych rozmiarów siatki;
- relaksacji i pełnego RK;
- dual-socket i MPI;
- porównania czasu do dokładności;
- hardware receipt.

Bez baseline nie należy zatwierdzać „przyspieszenia o X%”.

---

## 21. Plan implementacji

## P0 — naprawić sterowanie i usunąć pewną pracę szeregową

### P0.1. Pierwszoklasowa polityka CPU

Pliki:

- `backends/fem/cpu/mfem/runtime/cpu_threads.cpp`
- `backends/fem/cpu/mfem/runtime/cpu_threads.hpp`
- `crates/fullmag-runner/src/fem/execution.rs`
- `crates/fullmag-runner/src/solver_profile.rs`
- `compose.windows.yaml`
- `scripts/windows/run_fullmag_wsl.ps1`
- `scripts/windows/run_fullmag_fem.ps1`
- Python API/plan schema i UI resource controls.

Zmiany:

- precedencja plan > Fullmag env > OMP fallback;
- `-CpuThreads 30` w launcherze;
- jawne `auto|manual`;
- wykrycie cpuset;
- receipt requested/effective;
- warning przy oversubscription;
- brak cichego nadpisania 30 przez 16;
- kontrolowany budżet Rayon/BLAS/Hypre.

Testy:

- `FULLMAG=30`, `OMP=16` => effective 30 oraz warning o konflikcie;
- plan 20, env 30 => effective 20;
- cpuset 0-7, auto => maksymalnie 8;
- manual 30 przy cpuset 8 => błąd albo jawne clamp, nigdy cisza;
- dwa konteksty o sprzecznych politykach => typed error albo process-level arbitration.

### P0.2. Revision counters

Pliki/symbole:

- exchange dependency key;
- demag Poisson dependency key;
- mutation/import paths Context.

Zmiany:

- O(1) check;
- debug hash poza hot path;
- reason-coded rebuild.

Testy:

- wszystkie legalne mutacje;
- zero hash bytes na etap;
- identyczny wynik operator reuse.

### P0.3. Wiarygodny benchmark CPU

Rozszerzyć `scripts/benchmark_permalloy_fem_demag.py` albo dodać `benchmark_fem_cpu_scaling.py`.

Wymagane outputy:

- JSON machine receipt;
- raw CSV;
- Markdown summary;
- phase speedup/efficiency;
- correctness deltas;
- commit i image digest;
- logs.

## P1 — skalowanie jednego socketu i bezpieczne skalowanie NUMA

### P1.1. Kwalifikacja MFEM `omp`

- usunąć CPU-only hardcode `"cpu"`;
- dodać `cpu_reference` i `omp_production`;
- porównać wszystkie elementy/interakcje;
- nie zakładać, że legacy sparse automatycznie stanie się równoległy.

### P1.2. Równoległe i scalone pętle

Priorytet:

1. LLG RHS;
2. RK stage/candidate/error;
3. adaptive norm/guard;
4. H_eff composition;
5. exchange lumped projection;
6. AoS/SoA;
7. relaxation vectors;
8. serial reductions DMI.

Wymagania:

- static partition;
- SIMD;
- deterministic mode;
- brak per-thread pełnego N, jeśli nie jest konieczne;
- minimalny próg rozmiaru wyznaczony benchmarkiem.

### P1.3. Persistent workspace i double buffering

- demag potential;
- trial/accepted fields;
- Hypre vectors;
- relaxation scratch;
- periodic reduced arrays;
- PETSc objects, gdy feature włączony.

### P1.4. NUMA

- hwloc;
- pinning;
- parallel first-touch;
- `close`/`spread`;
- physical cores first;
- telemetry remote memory.

## P2 — usunięcie powtarzanej pracy algorytmicznej

### P2.1. Preassembled demag RHS

\[
b=B\,m
\]

z oracle przeciw obecnej integracji elementowej.

### P2.2. Preassembled recovery

\[
h=G\,\phi
\]

z eliminacją atomików i geometry recomputation.

### P2.3. Operator block/vector-valued

- trzy komponenty exchange jako blok;
- wiele RHS;
- mniej pack/unpack;
- SpMM zamiast trzech niezależnych ścieżek.

### P2.4. TPI linear-response operator

- brak pełnego solve demag w każdym Krylov `Mult`;
- cache i preconditioner;
- reuse między backtrackami.

### P2.5. FEM/BEM complexity

- kompresja H-matrix/ACA/FMM;
- BLAS tylko jako krok przejściowy.

### P2.6. Frequency-domain reuse

- CSR-native;
- symbolic/factorization reuse;
- równoległość frequency groups;
- brak dense residual w produkcji.

## P3 — rzeczywisty dual-socket przez hybrydę

Warunek wejściowy: distributed FEM core.

- jedna ranga na socket;
- local memory binding;
- OpenMP w ramach socketu;
- globalny budget;
- rank/thread receipt;
- porównanie 1×all-cores kontra 2×socket-local;
- load balancing i partition quality.

## P4 — wiele węzłów HPC

- `ParMesh`;
- `ParFiniteElementSpace`;
- distributed state;
- Hypre na `MPI_COMM_WORLD`;
- distributed Poisson/exchange;
- globalne normy i adaptacja;
- rank-aware output;
- SLEPc distributed;
- restart z inną liczbą rang;
- strong i weak scaling;
- fault/interrupt propagation.

---

## 22. Konkretna macierz zmian plik po pliku

| Plik/moduł | Problem | Zmiana |
|---|---|---|
| `runtime/cpu_threads.cpp` | błędna precedencja, brak topologii | nowy resolver, cpuset/hwloc, jawne konflikty |
| `compose.windows.yaml` | domyślne OMP=16 blokuje Fullmag=30 | jedna zmienna źródłowa albo zsynchronizowane wartości |
| Windows launchers | brak parametru | `-CpuThreads`, `-Affinity`, `-UseSmt`, `-NumaPolicy` |
| `runtime/mfem_context.cpp` | hardcoded `"cpu"` | kwalifikowany `omp`, capability receipt |
| `runtime/mpi_init.hpp` | wyłącznie COMM_SELF | pozostawić jako `SerialHypreLane`, zbudować osobny distributed runtime |
| exchange dependency | pełny hash | revision set |
| demag dependency | pełny/duplikowany hash | revision set i pojedyncza walidacja |
| `runtime/aos_field.cpp` | wiele kopii i skanów | generation cache, direct copy, fused OMP |
| `integrators/llg_rhs.cpp` | serial | OMP/SIMD i deterministic max |
| `integrators/rk_explicit_step.cpp` | serial stage/candidate/equal | fused kernels, generation IDs |
| `integrators/adaptive_dt.cpp` | serial reductions i acos | chunk reductions, cosine guard |
| `interactions/effective_field.cpp` | wiele passów/zeroing | active-set, fused composition, intent |
| exchange projection | 3 serial solves/allocations | block RHS, persistent scratch, warm start |
| demag RHS | per-stage element assembly | preassembled B |
| demag recovery | atomiki/recompute | preassembled G lub node gather |
| demag Hypre | serial copies/backups | persistent vectors, double buffer |
| DMI workspace | T×N memory + serial reduction | blocked/colored accumulation |
| relaxation math | allocations/serial reductions | persistent workspace, `_into`, OMP |
| direct minimizer solver | serial default albo rebuilt Hypre | policy + persistent AMG/Krylov |
| tangent plane | rebuild i nested demag solve | reusable operator/preconditioner |
| FEM/BEM | dense O(N²), first-touch | parallel touch, BLAS, potem compression |
| sparse direct FD | dense input, SeqAIJ, rebuild | CSR input, reuse, MPIAIJ/distributed package |
| modal/eigen | PETSC_COMM_SELF | distributed communicator/matrices |
| solver profiler | brak hardware/NUMA | topology and aggregate CPU metrics |

---

## 23. Proponowany benchmark kwalifikacyjny

### 23.1. Przypadki

Co najmniej:

1. **Exchange-only**
   - izoluje SpMV/projection/AoS.
2. **Poisson demag-only**
   - izoluje RHS/solve/recovery.
3. **Exchange + demag**
   - realistyczna dynamika.
4. **DMI-heavy**
   - test per-thread residual.
5. **Local fields-heavy**
   - test fuzji H_eff.
6. **Projected-gradient BB**
   - line search i preconditioner.
7. **Tangent-plane implicit**
   - nested operator/Krylov.
8. **FEM/BEM bounded case**
   - boundary scaling.
9. **Frequency response/eigen**
   - tylko w obrazie z PETSc/SLEPc.
10. **Kanoniczny FEM SP4**
    - jako stabilny problem end-to-end.

Każdy przypadek w trzech rozmiarach:

- mały — wykrywa narzut tworzenia zespołu;
- średni — typowy workstation;
- duży — nasyca pamięć i uzasadnia wiele rdzeni.

### 23.2. Sweep wątków

```text
1, 2, 4, 8,
physical_cores_per_socket,
all_physical_cores,
all_logical_cpus
```

Dodatkowo:

```text
OMP_PROC_BIND=close
OMP_PROC_BIND=spread
SMT off/on
NUMA first-touch/interleave
```

### 23.3. Dual-socket

Przed MPI:

- 1 proces na jednym socketcie;
- 1 proces rozciągnięty na oba sockety;
- porównanie local/remote memory.

Po MPI:

- 1 rank × wszystkie rdzenie;
- 2 ranks × rdzenie/socket;
- 4 ranks × połowa socketu, wyłącznie jako eksperyment.

### 23.4. HPC

Strong scaling:

\[
T(1), T(2), T(4), T(8)\ \text{węzłów}
\]

przy stałym problemie.

Weak scaling:

\[
\frac{N_\mathrm{DOF}}{\text{rank}} \approx \text{const}.
\]

Raportować:

- compute;
- communication;
- global reductions;
- halo;
- imbalance;
- setup;
- apply;
- I/O.

### 23.5. Procedura

- stały governor i zanotowany turbo;
- brak konkurencyjnych obciążeń;
- warm-up;
- co najmniej 5 mierzonych powtórzeń;
- mediana i p95;
- ten sam mesh artifact/cache;
- ten sam commit/image digest;
- pinned threads;
- zapis temperatury/throttlingu, jeśli dostępny;
- osobny cold setup i warm steady-state;
- correctness gate przed rankingiem.

---

## 24. Bramy poprawności i wydajności

### 24.1. Poprawność

Każda optymalizacja musi zachować:

- normę `|m|=1` w aktywnych DOF;
- frozen spins;
- periodyczność;
- maski regionów;
- energię i pole względem oracle;
- residual solvera;
- kryterium adaptacyjne;
- licznik zaakceptowanych/odrzuconych kroków w ramach zdefiniowanej tolerancji;
- brak NaN/Inf;
- poprawność restartu;
- zgodność CPU reference vs CPU OMP.

Dla redukcji równoległych należy mieć dwa tryby:

- `fast`;
- `deterministic_reductions`.

### 24.2. Proponowane wstępne progi wydajności

Progi muszą zostać zatwierdzone na rzeczywistym baseline. Jako pierwszy gate można przyjąć:

- brak regresji większej niż 3–5% dla 1 wątku;
- brak wzrostu liczby iteracji solvera bez uzasadnienia;
- monotoniczne przyspieszenie dużego przypadku co najmniej do nasycenia socketu;
- brak oversubscription;
- brak niejawnego clampu ręcznego żądania;
- setup reuse hit rate bliski 100% w stałej dynamice;
- zero pełnych dependency hash w hot path;
- zero per-stage geometry recomputation dla preassembled demag RHS/recovery;
- dual-socket akceptowany tylko, gdy skraca wall time względem jednego socketu;
- distributed lane akceptowany dopiero po pokazaniu realnego podziału local/global DOF.

Nie należy wymagać „100% CPU” jako gate.

---

## 25. Kolejność prac o najwyższym zwrocie

1. **Naprawić wybór 20/30 wątków i receipt.**  
   To usuwa obecny błąd użytkowy i pozwala mierzyć właściwy eksperyment.

2. **Usunąć hashowanie zależności z hot path.**  
   Niskie ryzyko fizyczne, pewne usunięcie pracy O(N).

3. **Zbudować zaakceptowany benchmark 1…all cores.**  
   Bez niego dalsze optymalizacje są zgadywaniem.

4. **Zrównoleglić/fuzjować LLG, RK, H_eff, AoS i redukcje.**  
   Umożliwia skalowanie całego kroku, nie tylko DMI.

5. **Preassemble demag RHS i recovery.**  
   Największa szansa na algorytmiczne skrócenie dominującej fazy.

6. **Utrwalić solvery, AMG, wektory i bufory transakcyjne.**  
   Mniej setupu, kopii i alokacji.

7. **Wdrożyć topologię NUMA i first-touch.**  
   Warunek sensownego użycia dwóch CPU.

8. **Naprawić tangent-plane nested demag.**  
   Bez tego implicit lane może pozostać wielokrotnie wolniejszy niezależnie od liczby rdzeni.

9. **Wprowadzić distributed FEM na `ParMesh`.**  
   Dopiero ten etap daje pojedynczej symulacji wiele socketów/rang/węzłów w sposób produkcyjny.

10. **Przenieść PETSc/SLEPc na distributed matrices i reuse.**  
    Osobny strumień dla frequency-domain/eigen.

---

## 26. Ryzyka wdrożenia

### 26.1. Reprodukowalność

Inna kolejność sumowania zmienia ostatnie bity, co może:

- zmienić decyzję adaptacyjnego kroku;
- zmienić liczbę backtracków;
- rozdzielić trajektorie chaosu/termicznego szumu.

Rozwiązanie: deterministic chunk reductions, jawny seed i tolerancje porównania trajektorii.

### 26.2. Thread safety MFEM

Nie należy automatycznie opatrywać wszystkich pętli `#pragma omp`. Obiekty z mutable state, coefficienty, transformations i forms muszą zostać zakwalifikowane. Wymagane:

- dokumentacja upstream;
- ThreadSanitizer dla testów bez MPI/Hypre, gdzie możliwe;
- stress test wielu powtórzeń;
- per-thread scratch/transformations, jeśli wymagane.

### 26.3. Oversubscription

Możliwe mnożenie:

\[
N_\mathrm{MPI}\times N_\mathrm{OMP}\times N_\mathrm{BLAS}\times N_\mathrm{Rayon}.
\]

Jedna warstwa musi być właścicielem budżetu. Dla operatorów MFEM/Hypre zwykle:

- OpenMP = budżet na rank;
- BLAS = 1, jeżeli zewnętrzna pętla już jest równoległa;
- Rayon = ograniczony do pracy control-plane albo 1 w hot solve;
- nested OpenMP = wyłączone.

### 26.4. Tolerancje solverów

Poluzowanie tolerancji może skrócić solve, ale jest zmianą numeryczną. Należy optymalizować czas do zadanej dokładności fizycznej i posiadać oracle, nie tylko minimalizować liczbę iteracji.

### 26.5. Upgrade bibliotek

MFEM 4.7 jest przypięte w obrazie. Nowszy MFEM może zawierać poprawki i nowe backendy, ale upgrade nie zastąpi:

- usunięcia kopiowania;
- preassembly;
- NUMA;
- distributed data model.

Upgrade powinien być osobną kwalifikowaną gałęzią z macierzą wyników, nie zmianą „w ciemno”.

---

## 27. Ostateczna diagnoza

Niskie wykorzystanie CPU nie wynika z jednego brakującego przełącznika. Jest skutkiem kombinacji:

- konfliktu zmiennych ograniczającego ręczny wybór wątków;
- wymuszonego backendu MFEM `cpu`;
- wielu szeregowych pętli i konwersji;
- powtarzanego O(N) hashowania;
- ponownego assembly stałych liniowych map;
- atomików i szeregowych redukcji;
- odtwarzania solverów/workspace w niektórych ścieżkach;
- braku NUMA-aware placement;
- braku rozdzielonego modelu danych MPI;
- sekwencyjnych macierzy PETSc/SLEPc.

Najbardziej realistyczna strategia nie polega na natychmiastowym „włączeniu 128 wątków”. Powinna przebiegać kolejno:

```text
prawidłowa kontrola zasobów
-> pomiar
-> usunięcie pracy zbędnej
-> równoległe/fused kernels
-> preassembled operators
-> NUMA
-> distributed FEM
-> hybrid MPI + OpenMP
```

Po etapach P0–P2 Fullmag powinien być w stanie sensownie wykorzystać jeden wielordzeniowy socket i część maszyn dwusocketowych. Dopiero P3–P4 stworzą produkcyjny solver jednej symulacji na wielu socketach i węzłach HPC.

---

## 28. Najważniejsze dowody w repozytorium

- `backends/fem/cpu/mfem/runtime/cpu_threads.cpp`
- `backends/fem/cpu/mfem/runtime/mfem_context.cpp`
- `backends/fem/cpu/mfem/runtime/mpi_init.hpp`
- `docker/fem-cpu/Dockerfile`
- `compose.windows.yaml`
- `backends/fem/cpu/mfem/runtime/aos_field.cpp`
- `backends/fem/cpu/mfem/interactions/exchange_operator.cpp`
- `backends/fem/cpu/mfem/interactions/exchange_field.cpp`
- `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp`
- `backends/fem/cpu/mfem/interactions/demag.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_dependency.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`
- `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp`
- `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp`
- `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp`
- `backends/fem/cpu/mfem/interactions/dmi_workspace.cpp`
- `backends/fem/cpu/mfem/interactions/effective_field.cpp`
- `backends/fem/cpu/mfem/integrators/llg_rhs.cpp`
- `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`
- `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`
- `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`
- `backends/fem/cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.cpp`
- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- `crates/fullmag-runner/src/fem/execution.rs`
- `crates/fullmag-runner/src/solver_profile.rs`
- `scripts/benchmark_permalloy_fem_demag.py`
- `docs/performance/fem_cpu_baselines.md`

---

## 29. Źródła upstream

1. MFEM — assembly levels i backendy urządzeń:  
   <https://mfem.org/howto/assembly_levels/>

2. MFEM — `mfem::Device`:  
   <https://docs.mfem.org/4.9/classmfem_1_1Device.html>

3. MFEM — `ParMesh`:  
   <https://docs.mfem.org/4.7/classmfem_1_1ParMesh.html>

4. MFEM — klasy równoległe:  
   <https://docs.mfem.org/4.7/namespacemfem.html>

5. OpenMP — `OMP_PROC_BIND`:  
   <https://www.openmp.org/spec-html/5.1/openmpse61.html>

6. OpenMP — `OMP_PLACES`:  
   <https://www.openmp.org/spec-html/5.1/openmpse62.html>

7. PETSc — równoległa macierz `MATMPIAIJ`:  
   <https://petsc.org/release/manualpages/Mat/MATMPIAIJ/>

8. PETSc — wybór typu macierzy zależnie od communicatora:  
   <https://petsc.org/release/manualpages/Mat/MatSetFromOptions/>

---

## 30. Status rekomendowanych działań

| Działanie | Status w audytowanym commitcie |
|---|---|
| ręczny parametr threads w planie/API/UI | brak |
| spójna precedencja Fullmag/OMP | brak |
| topology/cpuset/NUMA receipt | brak |
| MFEM `omp` w CPU-only runtime | brak |
| revision-based operator invalidation | brak |
| zaakceptowany CPU baseline | brak |
| preassembled Poisson RHS | brak |
| preassembled demag recovery | brak |
| persistent setup we wszystkich ścieżkach relaksacji | częściowo |
| dual-socket NUMA policy | brak |
| `ParMesh` distributed FEM | brak |
| PETSc/SLEPc distributed matrices | brak |
| task-level benchmark sweep 10/20/30/40 | istnieje |
| phase-level demag telemetry | istnieje |
| ręczne OpenMP w DMI/recovery/energy | częściowo istnieje |
| cache macierzy/AMG głównego Poissona | istnieje częściowo |
