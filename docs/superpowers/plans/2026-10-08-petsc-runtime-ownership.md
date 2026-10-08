# Własność współbieżna runtime’u PETSc/SLEPc w natywnym FEM

**Status:** propozycja planu; wybór architektury oczekuje na odpowiedź użytkownika.

**Data przeglądu źródeł:** 2026-10-08.

**Zakres:** wspólny stan PETSc/SLEPc/MPI w `fullmag_fem`; diagnoza źródłowa nie jest kwalifikacją runtime’u.

> Ten dokument nie jest zatwierdzonym ADR ani zgodą na implementację. Nie wybiera domyślnego modelu, nie zmienia kontraktu publicznego i nie dowodzi, że bieżąca aplikacja już wykonuje opisane wywołania równolegle.

## Cel i granice

Zapewnić jeden zgodny model własności inicjalizacji, wywołań PETSc/SLEPc, żywych uchwytów oraz finalizacji, gdy różne wejścia natywnego FEM korzystają z tej samej biblioteki w jednym procesie. Ustalić granicę współbieżności przed zmianą kodu. Zachować obecną fizykę, residuale, parametry EPS/KSP, semantykę anulowania, selekcję lane’u i provenance.

Plan dotyczy FEM CPU i FEM GPU, ponieważ warunkowo dołączony kod GPU i kod CPU trafiają do tego samego `fullmag_fem` shared library i linkują te same cele PETSc/SLEPc. Wymuszony GPU nadal musi zakończyć się błędem, gdy GPU jest niedostępne; nie wolno kierować go do CPU.

Poza zakresem są zmiana solverów, operatorów, tolerancji, formatów artefaktów, ProblemIR/OpenAPI oraz kwalifikacja fizyczna. Istniejąca pula procesów dla niezależnych próbek k pozostaje odrębną granicą izolacji opisaną w [ADR 0034](../../adr/0034-adaptive-dispersion-process-pool.md) i backend masterplanie.

## Decyzja architektoniczna — oczekuje na wybór użytkownika

Dostępne są dwie rozważane drogi. Żadna nie jest obecnie wybrana ani zatwierdzona.

1. **Wspólny wykonawca właścicielski na proces.** Jeden procesowy wątek właścicielski wykonuje wszystkie potrzebne wywołania PETSc/MPI oraz preassembly MFEM, które musi należeć do tego samego wątku inicjalizacji. Domyślna równoległość próbek k nadal korzysta z już istniejących procesów roboczych; każdy proces ma własny runtime. Rozwiązanie musi zachować albo jawnie przekazywać status, postęp, anulowanie i wynik bez przenoszenia nieprzenośnych callbacków Rust przez wątki.
2. **Proces na sesję.** Każda sesja obliczeniowa ma własny proces z własnym cyklem życia PETSc/SLEPc, a wywołania sesji nie współdzielą DSO ani globalnego stanu z innymi sesjami. W obrębie procesu sesji wywołania PETSc nadal muszą być serializowane zgodnie z obsługiwanym trybem MPI; sama izolacja między sesjami nie upoważnia do równoczesnego wejścia do PETSc z kilku wątków. Istniejący k-process pool pozostaje osobnym mechanizmem tam, gdzie jest już używany.

**Blokada:** prace zależne od wyboru nie zaczynają się przed odpowiedzią użytkownika. Nie zakładać, że którykolwiek wariant jest domyślny ani że mutex sam rozwiązuje ograniczenia MPI/PETSc.

Wariant wykonawcy musi uwzględnić, że lokalny helper MPI żąda `MPI_THREAD_FUNNELED`. Nie wolno po prostu przenieść wyłącznie `SlepcInitialize` na nowy wątek, pozostawiając inicjalizację MPI lub potrzebne preassembly na innym. Wariant procesu na sesję musi jasno określić właściciela inicjalizacji, końcowego cleanupu oraz callbacków w obrębie procesu.

## Zweryfikowane przesłanki ze źródeł

| Obszar | Bieżący dowód źródłowy | Konsekwencja dla planu |
|---|---|---|
| Wspólny obraz biblioteki | `backends/fem/CMakeLists.txt:182–200,349,366,408–418`: adaptery CPU są w `FEM_SOURCES`; kod GPU jest dopisywany warunkowo; `fullmag_fem` buduje jedną bibliotekę `SHARED` i linkuje `PETSC::petsc` oraz `SLEPC::slepc`. | W ramach tego DSO blokady lokalne dla plików nie są wspólnym właścicielem stanu procesu. |
| Generyczny adapter | `slepc_modal_eigen.cpp::slepc_modal_solver_mutex`, `ensure_slepc_initialized`, `solve_slepc_tiny_gyrotropic_modal_eigen`, `solve_slepc_sparse_gyrotropic_modal_eigen` (linie 28, 135–145, 782, 829). | Jedna blokada obejmuje tylko adapter generyczny. |
| Floquet shared-domain | `modal/floquet_modal_solver.cpp::native_floquet_solver_mutex`, `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` (linie 1277, 3450–3528). Wrappery `solve_floquet_modal_spectrum` i `solve_floquet_modal_sparse_spectrum` mogą delegować do adaptera generycznego (3409–3448). | Wspólna blokada dodana jednocześnie do wrappera i delegata grozi samoblokadą. Blokować jeden poziom operacji albo jawnie przenosić własność guarda do wewnętrznej ścieżki. |
| Inne CPU entrypointy | `poisson_airbox_modal_eigen.cpp::pa_e2_slepc_mutex` (922, 1505); `poisson_airbox_schur_matshell.cpp::pa_e3_slepc_mutex` (874, 3895, 5729–5738, 7046); `engines/sparse_direct/cpu_sparse_direct_engine.cpp::petsc_sparse_direct_mutex` (123, 292). Ich helpery inicjalizują PETSc/SLEPc pod odpowiednimi lokalnymi blokadami. | Wszystkie wejścia dotykające wspólnego runtime’u muszą korzystać z uzgodnionego procesu właścicielskiego, nie tylko generyczny i Floquet solver. |
| GPU i finalizacja | `gpu/frequency_domain/modal_petsc_slepc.cpp::gpu_slepc_mutex`, `ensure_slepc_initialized`, `finalize_owned_slepc`, `finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime` (160, 172–215, 3738, 4598–4615); C ABI wywołuje finalizator w `backends/fem/src/api.cpp:4685`. | GPU ma osobną lokalną blokadę i może wykonać `SlepcFinalize`; właściciel musi rozróżniać runtime własny i pożyczony oraz nie finalizować runtime’u z aktywnym użytkownikiem. |
| Zachowane uchwyty | `production_cpu_modal_eigen.cpp` tworzy `floquet_window_context` dla serii podokien (3218–3242). `FloquetSharedDomainSparseModalSolveContext::~FloquetSharedDomainSparseModalSolveContext` wywołuje `destroy_opaque_floquet_window_context` (Floquet solver 3269–3274), które niszczy uchwyty PETSc (2087–2140). | Blokada wyłącznie na pojedynczy solve pozostawia przerwę między podoknami, w której finalizacja może unieważnić zachowany kontekst. Lease/zakres własności musi objąć cały czas życia kontekstu i jego destrukcję. |
| Zagnieżdżone okno K0 | `poisson_airbox_schur_matshell.cpp` blokuje okno na zewnątrz (3895), zapisuje `thread_local active_cpu_window_operator_context` (2535, 3927–3928), a wewnętrzny solve nie blokuje ponownie, gdy kontekst okna jest pożyczony (5730–5738). | Trzeba zachować jawne rozróżnienie „guard już posiadany” i „uzyskaj guard”. Nie używać `recursive_mutex` jako zamiennika kontroli własności. |
| Thread level MPI | `backends/fem/cpu/mfem/runtime/mpi_init.hpp:20–27` inicjalizuje MPI przez `MPI_Init_thread(..., MPI_THREAD_FUNNELED, ...)`. PETSc domyślnie żąda `MPI_THREAD_FUNNELED` przy inicjalizacji MPI i opisuje standardowy PETSc jako nie-thread-safe: [PETSc threading](https://petsc.org/main/manual/getting_started/), [wymagany poziom MPI](https://petsc.org/release/manualpages/Sys/PetscSetMPIThreadRequiredType/). | Mutex wyklucza równoczesną sekcję, ale sam nie przypina kolejnych wywołań do wątku inicjalizacji. Ten kontrakt zależy od wyboru użytkownika. |
| Callbacki | `frequency_response.rs:263,281,322` przyjmuje `&mut dyn FnMut(StepUpdate) -> StepAction`. `native_fem/frequency_domain.rs:53–56` ma pożyczone callbacki bez boundu `Send`; mosty przekazują do C ABI wskaźnik `user_data` na pożyczony obiekt (1254–1283, 1809–1828, 2801–2848). | Callbacków nie wolno przenosić do wątku właścicielskiego jako niebezpiecznych wskaźników. Trzeba zachować ich affinity/lifetime albo jawnie marshalować postęp i anulowanie. |
| Wywołania i pula k | Rust wywołuje synchronicznie `fullmag_fem_modal_eigen_solve[_v20]` i `fullmag_fem_frequency_domain_solve_driven_response` (`native_fem/frequency_domain.rs:1649–1662, 2584–2610`). Header publicznego C ABI deklaruje te funkcje i finalizator (linie 3176–3210), ale nie deklaruje wspólnej blokady. Backend masterplan opisuje k-pool jako izolowane procesy (`docs/architecture/backend-golden-masterplan.md:608–617`). | Process pool izoluje swoich workerów, ale nie synchronizuje innych entrypointów w procesie nadrzędnym ani współdzielonego C ABI. Obecne źródła nie dowodzą, że aplikacja faktycznie uruchamia takie wywołania równolegle. |

## Plan etapów po rozstrzygnięciu

### 1. Ustalić niezmienniki runtime’u dla wybranego wariantu

**Zakres proponowanych plików:** nowy prywatny moduł, np. `backends/fem/cpu/frequency_domain/petsc_slepc_runtime.hpp/.cpp`, oraz `backends/fem/CMakeLists.txt` do dodania go do `fullmag_fem`. Dokładny interfejs pozostaje do projektu po wyborze; ten plan nie predefiniuje klas ani funkcji managera.

**Wynik:** jeden właściciel procesu rozróżnia inicjalizację wykonaną przez Fullmag od runtime’u pożyczonego, chroni init/finalize i wspólne PETSc/SLEPc critical sections, oraz reprezentuje żywotność zachowanych uchwytów. Wspólna blokada jest niezależna od lokalnych mutexów cache/poison state; kolejność blokowania jest jednolita. Zwykły early return, cancel i bezpiecznie obsłużony błąd zwalniają guard oraz normalne lease przez RAII. Twardy błąd EPS może pozostawić celowo quarantined/poisoned graf PETSc z callbackami: jego właściciel i ostatni lifetime lease muszą przetrwać do końca procesu, nawet po zakończeniu operacji. Nie ponawiać użycia tego grafu ani nie wykonywać `SlepcFinalize`, dopóki istnieje taka kwarantanna; nie uruchamiać niebezpiecznych destruktorów tylko dla pozornego braku wycieku. Nie finalizować runtime’u, który ma aktywną operację albo lease zachowanego kontekstu.

**Wariant wykonawcy:** przypisać i utrzymać wątek właścicielski dla inicjalizacji MPI/PETSc, wywołań MPI/PETSc i wymaganej części MFEM preassembly. Nie zakładać, że samo uruchomienie `SlepcInitialize` w dedykowanym wątku wystarcza.

**Wariant procesu na sesję:** uruchomić i finalizować runtime w granicy procesu sesji, a nie współdzielić `fullmag_fem` pomiędzy sesjami. Zachować osobną, istniejącą izolację workerów k.

### 2. Zintegrować wszystkie wejścia i lifetime

**Kandydaci do migracji:**

- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- `backends/fem/cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.cpp`
- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` dla lease’u trwającego przez wszystkie podokna i destrukcję Floquet context
- `backends/fem/src/api.cpp` dla przekazania publicznego GPU finalizatora do wspólnego ownera, jeśli wybrana granica umieszcza finalizację w API.

**Wynik:** `SlepcInitialize*`, `PetscInitialize*`, wszystkie twory/operacje/destruktory PETSc w aktywnych solverach i `SlepcFinalize` współdzielą ten sam model własności. GPU pozostaje ścisłym GPU: brak cichego CPU fallbacku, zachowanie konfiguracji CUDA/device initialization, ownership i attestation. Generyczne wrappery delegujące do adaptera nie uzyskują guarda drugi raz. Okno E3 zachowuje jawnie pożyczony guard. Cleanup kontekstu Floquet wykonuje się przy posiadanej własności runtime’u, bez podwójnego blokowania.

**Granica:** nie zmieniać operatorów, selekcji solvera, wyników ani solverowych tolerancji. Nie dodawać publicznych pól C ABI.

### 3. Zachować callbacki i sterowanie sesją

**Kandydaci:** `crates/fullmag-runner/src/native_fem/frequency_domain.rs` oraz, jeśli wybrany model przenosi wywołania z `frequency_response`, `crates/fullmag-runner/src/frequency_response.rs`.

**Wynik:** Rust progress/cancel callbacki zachowują obecne lifetime, kolejność, stop semantics i affinity. Wariant executorowy nie przenosi borrowed `FnMut`/wskaźników `user_data` poza wątek, który jest ich właścicielem; jeśli wymaga przekazania przez wątek, marshalluje wartości progress/cancel z określoną semantyką i bez callbacku po zakończeniu wywołania. Wariant procesu na sesję zachowuje synchroniczny callback bridge w procesie właścicielskim. Nie zmieniać reakcji użytkownika na cancel ani statusów terminalnych.

### 4. Dodać regresje w jednym procesie

**Proponowane miejsce:** rozszerzyć `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp`, istniejący target `fem_floquet_modal_solver_contract` w `backends/fem/CMakeLists.txt:1107–1108`. Ten plik ma fixture’y generycznego requestu, sparse requestu i kompleksowych CSR. Nie zestawiać dwóch oddzielnych testowych executable, ponieważ nie współdzielą procesu ani globalnego runtime’u.

**Wymagane dowody w GHA:**

- ten sam proces równocześnie zgłasza generyczny modal solve oraz Floquet shared-domain solve przez różne entrypointy; wybrany model gwarantuje brak nakładania operacji PETSc i zwraca poprawne wyniki obu solve’ów;
- konkurencyjna pierwsza inicjalizacja CPU/GPU wykonuje jeden procesowy init; sprawdzone jest użycie runtime’u pożyczonego i owned oraz brak finalizacji przed ostatnim solve/context lease;
- jawna finalizacja, `atexit`, wielokrotny cleanup i destruktor zachowanego Floquet context nie powodują use-after-finalize, deadlocku ani wycieku uchwytów;
- twardy błąd EPS → żądanie finalizacji pozostawia poisoned graf i jego callbacki pod własnością procesu, blokuje reuse/finalizację i nie niszczy niebezpiecznych uchwytów; zwykły cleanup pozostaje osobnym, sprawdzanym przypadkiem;
- regresja chroni delegację Floquet → generic i zagnieżdżone okno E3 przed podwójnym acquisition/non-recursive deadlockiem;
- C ABI postęp/anulowanie zachowuje callback order, affinity/lifetime i stan interrupted/cancelled; w żadnym wariancie callback Rust nie jest przenoszony przez wątek bez jawnego marshallingu;
- istniejąca bramka `fem_gpu_petsc_slepc_runtime_contract` pozostaje osobnym dowodem lane’u GPU; testy CPU nie zastępują GPU.

**Zależności CI:** `fem_floquet_modal_solver_contract`, `fem_modal_eigen_contract`, `fem_poisson_airbox_modal_eigen_slepc_contract`, `fem_gpu_petsc_slepc_runtime_contract` (gdy włączono GPU) oraz istniejące testy mostów callback/cancel w Rust `native_fem/frequency_domain.rs`. Testy jednostkowe uruchamia wyłącznie GHA zgodnie z regułami repozytorium.

### 5. Osobno kwalifikować runtime

Dla wybranego modelu przeprowadzić managed build i runtime dowody z aktualnym snapshotem w kanonicznym pipeline `just`/Fullmag build runner. Sprawdzić CPU SLEPc i GPU SLEPc osobno, wraz z bezpieczną finalizacją i realnym entrypointem użytkowym. Source tests, CTest, sam fakt inicjalizacji PETSc oraz izolacja procesu nie dowodzą kwalifikacji naukowej ani HPC.

**Status po tym planie pozostaje `NOT VERIFIED`:** bieżące źródła i testy nie potwierdzają nowej polityki właściciela, managed runtime, wydajności, bezpieczeństwa HPC ani kwalifikacji fizycznej. Nie promować żadnego lane’u do `validated` na podstawie samej serializacji.

## Kryteria zakończenia planowanego zadania

- Wybrany przez użytkownika model jest zapisany w osobnej decyzji kontraktowej przed implementacją; ten plan sam nim nie jest.
- Każdy produkcyjny PETSc/SLEPc entrypoint i finalizator używa wybranego właściciela; lokalne locki nie dają fałszywego wrażenia globalnej ochrony.
- Zagnieżdżone ścieżki, callbacki, cancel i zachowane konteksty mają udowodniony ownership/lifetime bez reentrancy deadlocku ani przypadkowego scope/lease leak; celowa kwarantanna poisoned grafu zachowuje ostatni lease do końca procesu i jest raportowana oddzielnie od normalnego cleanupu.
- Test cross-entrypoint przechodzi w GHA w jednym procesie, a bramki CPU/GPU i callbacków są raportowane osobno.
- Brak CPU fallbacku przy strict/forced GPU. Nie zmieniono solver physics, residuali, EPS/KSP parametrów ani provenance.
- Managed/runtime i HPC statusy są zgłaszane z ich rzeczywistymi dowodami; brak dowodu pozostaje `NOT VERIFIED`.
