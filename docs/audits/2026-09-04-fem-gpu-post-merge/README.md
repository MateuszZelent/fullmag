# Audyt FEM GPU po scaleniu gałęzi — 4 września 2026

## Werdykt

Kierunek optymalizacji jest uzasadniony, ale obecny stan nie uzasadnia deklaracji, że wszystkie zadania są poprawnie zakończone ani że uzyskano już mierzalne przyspieszenie względem starego kodu. Istnieją rzeczywiste implementacje GPU, lecz część mechanizmów nie jest podłączona do produkcyjnego przebiegu, część pozostaje zmianami roboczymi, a historyczna tabela ukończenia miesza test kontraktu z kwalifikacją solvera.

Blokady poprawności: ścieżka Captured uznaje niepełny graf za wykonanie RK; finalizacja RK ignoruje błąd commit_candidate; w roboczej integracji PG-BB awaryjna kopia gradientu ma odwrócony kierunek. Graf jest domyślnie wyłączony i nie znaleziono produkcyjnego capture, więc pierwsze ustalenie blokuje jego włączenie, nie dowodzi błędności domyślnego przebiegu. Najważniejsza luka minimizerów: działający osobno rdzeń sparse fixed-CG nie oznacza jeszcze poprawnego preconditioned NCG/PG-BB. Największa luka dowodowa: brak aktualnego, źródłowo przypiętego A/B mierzącego czas osiągnięcia tej samej tolerancji.

To audyt przekrojowy architektury, zmienionych ścieżek i gorących pętli, nie certyfikat przeczytania każdej linii. Inwentaryzacja obejmuje 731 śledzonych plików FEM, w tym 268 pod GPU/CUDA. [Inwentarz SHA-256](source-inventory.json) identyfikuje zawartość zastaną podczas audytu; obecność pliku w inwentarzu nie oznacza pełnego przeglądu wszystkich jego wariantów. Rzadkie kombinacje topologii, wszystkie instancje szablonów, wykonanie wielowęzłowe oraz pełna walidacja fizyczna pozostają poza potwierdzonym zakresem.

## Tożsamość i granice integracji

| Stan | Tożsamość | Znaczenie |
|---|---|---|
| Scalona baza | `codex/fem-gpu-tasks1-5-remediation`, `5c96cacf0af005ed58a7ad83696281e00eb02136` | HEAD i odpowiadający ref origin są zgodne |
| Rodzice merge | `d61dee428e8379c564ac7aa1c42d12b82ce45915`, `a1ba0369e2d8a9cd9e62eb9c0cde5b3873fd5401` | Dwie historie scalone bez przepisywania |
| Stara gałąź | `codex/fem-gpu-full-potential-20260902`, drugi rodzic powyżej | Porównanie starego origin z HEAD: 0 commitów tylko na starej, 8 tylko na scalonej |
| Bieżący WIP | Integracja PG-BB/preconditionera i harness benchmark/Nsight | Nie jest częścią wskazanego commitu ani potwierdzonego remote |
| Stary WIP | 19 zmienionych plików receipt/NCG/ABI/runner/launcher | Nie wszedł do merge; nie wolno go uznać za zintegrowany |

Aktywny katalog: `C:\git\fullmag\fullmag\.worktrees\fem-gpu-tasks1-5-remediation`. Stary katalog: `C:\git\fullmag\fullmag\.worktrees\fem-gpu-full-potential-20260902`. W tym audycie nie zmieniono kodu solvera, nie scalano WIP, nie wykonano commitu ani push.

## Ustalenia minimizerów

### M1 — P1: odwrócona kopia w fallbacku PG-BB (WIP)

`backends/fem/gpu/cuda/relaxation/pgbb.cpp:812`, ścieżka `raw-gradient descent fallback`, przekazuje `preconditioned_gradient` jako źródło i `rk.k[0]` jako cel. `integrators/rk/rk_component_copy.cu::gpu_rk_copy_component_device` ma kontrakt `(src, dst)` i wykonuje `dst <- src`. W rezultacie nadpisuje surowe g wartością z, zamiast odtworzyć z z g. Następnie deklaruje pochodną odpowiadającą kierunkowi -g. Dotyczy uruchomienia awaryjnej gałęzi po wykryciu kierunku niezstępującego; nie każdego kroku.

Naprawa: zamienić argumenty, zachować g i wymusić ten przypadek testem wykonywalnym. Test musi sprawdzać z=g, nienaruszony surowy gradient, spójność pochodnej i poprawność następnej próby oraz rollbacku.

### M2 — P1: nieukończone preconditioned NCG (commit)

`relaxation/nonlinear_cg.cpp::gpu_relax_compute_effective_field_energy_gradient_and_direction` najpierw oblicza kierunek i częściowe redukcje, następnie warunkowo nadpisuje g diagonalnym preconditionerem. Wynik bool i tekst błędu aplikacji są ignorowane. Produkcyjny setup tego obiektu nie został znaleziony w scalonej bazie: jest to przede wszystkim luka integracji, a nie dowód, że domyślny NCG już wykonuje błędną preconditioning operację.

`relaxation/pgbb_kernels.cu::ncg_gradient_norm_and_pr_plus_kernel` operuje surowym g i jego normą. Referencja `cpu/mfem/relaxation/nonlinear_cg.cpp::next_direction_pr_plus` rozróżnia g i z oraz transportuje poprzednie z. Podłączenie sparse CG wymaga poprawienia całej rekurencji, kierunku, transportu, pochodnej line search i restartów, nie tylko wywołania apply. Błędy CUDA/preconditionera muszą propagować się do kontrolowanego odrzucenia/rollbacku.

### M3 — P1: brak osiągalnego wyboru profilu fixed-CG (WIP)

W `relaxation_memory.cpp` request jest inicjalizowany pustym profilem; `pgbb.cpp::gpu_relax_pgbb_prepare_preconditioner` przekazuje istniejący stan. Nie znaleziono produkcyjnego loadera kwalifikowanego profilu ustawiającego CG4/CG8. W `scripts/analysis/fem_gpu_benchmark.py` mapowanie nazw runtime nadal nie zapewnia wykonania pełnego exchange-mass, choć walidacja rozszerza słownik. Samo przyjęcie nazwy przez harness nie dowodzi wykonania strategii.

### M4 — P2: diagonalny setup zależy od każdego nowego lambda (WIP)

`relaxation_memory.cpp::setup_cache_matches` odrzuca cache przy zmianie exchange_weight dla diagonali. `gpu_relaxation_prepare_preconditioner` czyści dispatch, a setup diagonali ponownie alokuje/przesyła współczynniki. Przy zmiennym kroku BB może to wprowadzić alokacje i H2D do kolejnych iteracji. Jest to zidentyfikowana możliwość kosztu w kodzie, nie wynik pomiaru. Zachować stałe bufory i aktualizować zależne współczynniki na urządzeniu; sprawdzić licznik alokacji oraz trace Nsight.

### M5 — P2: koszt nowego stanu także dla niewykorzystanej strategii (WIP)

`cpu/mfem/runtime/mfem_context.cpp::context_upload_mfem_exchange_to_gpu_state` buduje dodatkowe wejścia preconditionera. Alokacja z (3N double) i mass_ms (N double) oznacza dodatkowe około 32N bajtów, poza CSR i workspace CG. Należy ograniczyć przygotowanie do rzeczywiście wybranej ścieżki. Nie zakładać, że każda symulacja RK potrzebuje tych danych. Materializacja diagonali pełnego K jest potrzebna generic SpMV; sama zmiana tego zapisu nie jest błędem fizycznym, ale wymaga testu zgodności operatorów.

### M6 — co jest rzeczywistym postępem

`relaxation/gpu_exchange_mass_preconditioner.cpp` zawiera pełny rdzeń device-resident fixed-CG4/CG8, kontrolę aliasowania i generacji planu, trwały workspace oraz urządzeniowy stan błędu. Nie jest to już wyłącznie diagonala. Historyczne stwierdzenie, że sparse solve nie istnieje, jest nieaktualne; brakujące są integracja i kwalifikacja całej metody. W reduce_components wykonywane są oddzielne redukcje komponentów: kandydat do zredukowania liczby wywołań CUB, dopiero po profilu. Synchronizacja walidacji podczas setupu nie jest automatycznie błędem gorącej pętli.

## Korekta znaczenia statusów dokumentacji

Dokument `docs/audits/2026-09-02-fem-gpu-solver-completion.md` nie może służyć jako bieżący certyfikat ukończenia. Zadania 2 i 3 oryginalnego planu oznaczają performance receipt i źródłowo przypięty benchmark, a nie launcher i UUID. Test manifestu mixed precision nie kwalifikuje obliczeń mixed precision; binding urządzeń nie dowodzi skalowania MPI; test grafu nie dowodzi jego użycia w całej produkcyjnej pętli. Niniejszy raport zastępuje taką interpretację historycznych statusów, nie przepisuje historycznych artefaktów.

`docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` wymaga aktualizacji stanu implementacji: rdzeń sparse istnieje, ale ukończenie NCG/PG-BB pozostaje niepotwierdzone. Nie zmienia to kanonicznych równań, jednostek ani publicznego kontraktu.

| Zadania oryginalnego planu 14-punktowego | Bezpieczna interpretacja stanu |
|---|---|
| 1–3: baseline, receipt, benchmark | Są artefakty i infrastruktura; aktualne A/B i kompletność nowego receipt niezamknięte |
| 4–5: DMI field-only, FEM/BEM stream | Rzeczywiste zmiany kodu; brak podstaw do deklaracji pełnej asynchronii wnętrza hypre |
| 6–7: sparse, geometria/fuzja/ACA | Rozdzielić działający komponent od osiągalności produkcyjnej; szczegóły w aneksie podsystemów |
| 8–9: RK transaction/graphs | Wymagana osobna kwalifikacja każdej wspieranej metody RK i ścieżki odrzucenia |
| 10: preconditioner | Rdzeń sparse obecny; integracja i czas do tolerancji nieukończone |
| 11: upgrade/mixed precision | Polityki i testy manifestów nie są kwalifikacją numeryczną |
| 12: frequency domain | Kontrakty małych solverów nie kwalifikują pełnej sesji PETSc/SLEPc |
| 13: multi-GPU | Preflight/binding nie jest dowodem rozproszonego solvera i skalowania |
| 14: końcowa kwalifikacja | Nieukończona |

Nowszy plan phase1 ma inną numerację: 1 dokumentacja, 2 diagonala, 3 rdzeń CG, 4 PG-BB, 5 NCG, 6 receipt, 7 pomiary, 8 kwalifikacja. Nie sumować tych zadań z poprzednimi ani nie wyliczać procentu przyspieszenia z procentu zamkniętych punktów. Aktualnie 4 i 7 zawierają WIP; 5, 6 i 8 wymagają dalszej pracy i integracji, a dokumentacja 1 wymaga odświeżenia po 3.

## Co wiemy o prędkości

Historyczny baseline `benchmarks/fem-gpu/accepted/rtx4080-sm89` istnieje. Średni total CPU około 10492,66 ms i GPU 5177,70 ms daje około 2,03x CPU/GPU; średnia faza demag około 115,18/54,13 ms daje około 2,13x. Są to dane wcześniejszego runtime, dla ograniczonej liczby kroków NCG, nie dowód osiągnięcia tolerancji ani zysk ostatniego merge. Nie przypisywać tych liczb obecnym poprawkom.

Świeżo odczytany sprzęt: RTX 4080 SUPER, sm_89, 16376 MiB, sterownik 591.86. Nie ma podstaw do liczbowej prognozy przyspieszenia ostatnich zmian bez profilu i A/B. Priorytet należy wyznaczyć według udziału fazy w czasie całkowitym, liczby RHS/iteracji i czasu do tej samej tolerancji. Spadek czasu pojedynczego SpMV może zostać zniwelowany wzrostem liczby iteracji lub transferów.

## Najnowszy stos: kandydaci, nie automatyczne zalecenie aktualizacji

Stan sprawdzony 2026-09-04. Repo używa bazowo CUDA 12.4.1, hypre 3.1.0 i MFEM 4.9.

- hypre 3.2.0 dodaje GPU mixed precision i flexible cycle BoomerAMG. Najpierw porównać sam upgrade w FP64. Zmienny preconditioner wymaga sprawdzenia zgodności Krylova; PCG potrzebuje odpowiednich własności symetrii/dodatniej określoności. [Wydanie](https://github.com/hypre-space/hypre/releases/tag/v3.2.0), [changelog](https://raw.githubusercontent.com/hypre-space/hypre/v3.2.0/CHANGELOG).
- MFEM 4.10 zawiera usprawnienia GPU/partial assembly. Ocena musi dotyczyć rzeczywistych integratorów i mieszanych topologii Fullmag, nie samej wersji. Nie promować niejawnego host fallbacku komunikacji. [Changelog](https://raw.githubusercontent.com/mfem/mfem/v4.10/CHANGELOG), [assembly levels](https://mfem.org/howto/assembly_levels/).
- Aktualna dokumentacja CUDA opisuje 13.3 Update 1. Dolna granica kompatybilności rodziny 13.x nie gwarantuje działania każdej nowej funkcji/PTX na sterowniku 591.86. CUDA 13 usunęła offline support starszych architektur: obecne listy hypre zawierające sm_60/sm_70 i pakiety Docker z sufiksem 12-4 wymagają osobnej migracji. [Release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html), [zmiany CUDA 13](https://developer.nvidia.com/blog/whats-new-and-important-in-cuda-toolkit-13-0/).
- Dla stałego sparsity pattern zbadać amortyzację `cusparseSpMV_preprocess`, trwałość deskryptorów/buforów oraz koszt pack/unpack. Nie zakładać przewagi biblioteki nad małym własnym kernelem. [cuSPARSE](https://docs.nvidia.com/cuda/cusparse/index.html).
- W BoomerAMG porównać obsługiwane na GPU coarsening/interpolation/relaxation, reuse setupu, operator complexity, pamięć i czas całego solve; nie stroić wyłącznie liczby iteracji. [BoomerAMG](https://hypre.readthedocs.io/en/latest/solvers-boomeramg.html).
- Conditional nodes CUDA wymagają rzeczywistego warunku/handle na urządzeniu. Zwykły graph replay z hostowym if to inny mechanizm. Funkcje Hopper/Blackwell nie są automatycznie dostępne na Ada sm_89. [CUDA Graphs](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/cuda-graphs.html), [Ada](https://docs.nvidia.com/cuda/ada-tuning-guide/index.html).

## Dowody i ograniczenia uruchomień

W bieżącym audycie: zgodność Git i ancestry potwierdzona; `git diff --check` bez błędów whitespace; `python scripts/test_fem_gpu_benchmark_contract.py` — 20 testów OK. Testy `test_capture_fem_gpu_nsight.py` zablokowane brakiem pytest również w sprawdzonym bundled Python; nie zaliczono ich.

Wcześniejsze w tej sesji 13/13 managed native contract oraz sanitizer rdzenia CG są dowodami historycznymi dla ich ówczesnych źródeł, nie świeżym testem bieżącego WIP. W tym audycie nie wykonano nowego native build, profilu Nsight ani pełnego benchmarku numerycznego. Runtime, fizyka i przyspieszenie aktualnego WIP pozostają **NOT VERIFIED**.

## Mapa źródeł i dalsza praca

Ścieżki powyżej są względem aktywnego worktree. Numery linii odnoszą się do dirty snapshotu, nie gwarantują stałości po następnej edycji. Kanoniczna nauka: `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`; kontrakty produkcyjne: `docs/adr/0030-fem-gpu-direct-minimizer-execution-evidence.md`; punkt wyjścia: `docs/superpowers/plans/2026-09-02-fem-gpu-full-potential.md` i `2026-09-04-fem-gpu-direct-minimizers-phase1.md`.

To wewnętrzny raport źródłowo-operacyjny, nie nowa publikacja fizyczna ani nowy publiczny API. Nie wprowadza równań, jednostek, parametrów Python ani zmian ProblemIR. FDM CPU/GPU pozostaje poza zakresem zmian; FEM CPU jest referencją porównawczą, FEM GPU przedmiotem audytu. Aktualizacje publikacji naukowej przy implementacji muszą przejść jej source-map i walidator scientific-documentation-contract.

Szczegóły podsystemów: [aneks](SUBSYSTEMS.md). Dalsze zadania i bramki: [plan](../../superpowers/plans/2026-09-04-fem-gpu-post-merge-remediation.md).
