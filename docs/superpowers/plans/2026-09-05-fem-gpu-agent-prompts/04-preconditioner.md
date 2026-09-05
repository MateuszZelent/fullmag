# Agent 4 — działający wybór profilu i optymalizacja preconditionera

Skopiuj poniższy prompt w całości. Nie uruchamiaj przed spełnieniem zależności.

---

Repozytorium: C:\git\fullmag\fullmag.
Kanoniczny worktree integracyjny: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation.
Branch integracyjny: codex/fem-gpu-tasks1-5-remediation.
Historyczny baseline audytu: 4be277e47440a947a30954adb3bbdeef15c9b06f — nie używaj go jako wejścia implementacji. Branche 1–3 scalono w 307ef39994df4c6ca14dbe564afc33154af1942a; rozpocznij od późniejszego pełnego SHA poprawek review przekazanego przez integratora zgodnie z README. Nie zakładaj, że lokalny commit jest na remote.
Raport Astra Pro: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/reports/05.09.2026/fullmag-fem-gpu-audit-2026-09-05/fullmag-fem-gpu-audit-2026-09-05/RAPORT.md.
Instrukcje szczegółowe A01–A16: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/reports/05.09.2026/fullmag-fem-gpu-audit-2026-09-05/fullmag-fem-gpu-audit-2026-09-05/naprawy/.
Macierz fizyki: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/reports/05.09.2026/fullmag-fem-gpu-audit-2026-09-05/fullmag-fem-gpu-audit-2026-09-05/WALIDACJA-FIZYKI.md.
Kolejność zespołu: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/superpowers/plans/2026-09-05-fem-gpu-agent-prompts/README.md.

Przed pracą:
- Przeczytaj AGENTS.md i właściwe skills, raport oraz odpowiednie pliki napraw. Raport jest hipotezą do weryfikacji w kodzie, nie gotowym patchem.
- Sprawdź git rev-parse HEAD, git status --short, git worktree list i historię zmian względem baseline. Nie zakładaj aktualności numerów linii ani dostępności lokalnych commitów na remote.
- Pracuj w osobnym worktree i branchu codex/, utworzonym z zatwierdzonego przez integratora commita wejściowego. Nie twórz kolejnego worktree, jeśli już otrzymałeś właściwy izolowany checkout. Nie pracuj równolegle w integracyjnym checkoutcie.
- Jeżeli otrzymałeś prompt przed zakończeniem zależności, wykonaj wyłącznie analizę i przygotowanie testów; nie implementuj na zgadywanym stanie wejściowym.
- Zachowaj wszystkie cudze zmiany, zwłaszcza stary worktree fem-gpu-full-potential-20260902. Nie resetuj, nie usuwaj cache, nie merguj do master i nie wypychaj na remote bez osobnego polecenia.
- Upoważnienie tego promptu obejmuje własne zmiany i lokalne commity wyłącznie we własnym branchu. Przed commitem osobno sprawdź git diff --cached --name-only.

Zasady wykonania:
- Najpierw potwierdź przyczynę i napisz test RED, potem minimalna naprawa i GREEN. Gdy RED nie da się uruchomić, oznacz brak dowodu, nie deklaruj zamknięcia.
- Dla zmian numerycznych najpierw sprawdź i uaktualnij właściwy kontrakt fizyczny. Nie dodawaj fizyki do mfem_bridge.cpp ani przekrojowego stanu do Context.
- Przed natywnym buildem przeczytaj justfile. FEM/MFEM/CUDA/hypre/libCEED weryfikuj przez repozytoryjne container-backed just i kanoniczny launcher Windows. Hostowe testy nie kwalifikują GPU.
- Koordynuj dostęp do GPU/build runtime z integratorem. Żadnych równoległych benchmarków na tej samej karcie. Build/cache/artifacts poza checkoutem, zgodnie z AGENTS.md.
- Zachowaj double baseline, maski frozen, PBC, jednostki, raw torque, tolerancje, geometrię i output policy. Bez cichego CPU fallbacku, promocji mixed precision czy zmiany wersji stosu.
- Nie dodawaj synchronizacji urządzenia tylko dla wygody obsługi błędów. Zachowaj opt-in profiler i jego istniejący kontrakt.
- Nie zmieniaj plików należących do innego agenta bez uzgodnienia z integratorem. Wspólne ABI, justfile, CMake i dokumenty zbiorcze wymagają serializacji.
- Każdą niezależną poprawkę zamknij osobnym małym commitem i przeglądem. Optymalizacje dopiero na correctness-fixed baseline, nigdy w tym samym commicie co naprawa błędu.

Wynik końcowy po polsku:
1. Branch, worktree, wejściowy SHA i pełne SHA własnych commitów.
2. Rozwiązane ID, dokładne pliki/symbole i pozostałe ograniczenia.
3. Komendy RED/GREEN, kody wyjścia i bezwzględne ścieżki do logów/artefaktów; source i binary/image identity dla runtime.
4. Osobne statusy: source/contract, managed GPU runtime, fizyka, CPU/GPU parity, performance. Brak dowodu = NOT VERIFIED.
5. Instrukcja integracji i potencjalne konflikty. Nie podawaj procentu przyspieszenia bez porównywalnego A/B.
Nie modyfikuj oryginalnego pakietu Astra Pro ani SHA256SUMS; własne ustalenia zapisuj w osobnym raporcie przypisanym do twojego numeru agenta.

## Twoje zadanie

Pełny SHA poprawek review: `4ddd9bb6209042c99b75bde35b1d6d92c12df22b`. To wejście analizy, nie automatyczna zgoda na optymalizacje. Najpierw agent 6 zamyka blokady wskazane w README; jego kolejne pełne SHA będzie wejściem implementacji.

Zakres: brak produkcyjnego loadera profilu, A05, A06, A09.
Start implementacji: dopiero po integracji poprawności agentów 2 i 3. Agent 3 kończy najpierw statusy redukcji i własność historii NCG.

Aktualizacja po review: nie powtarzaj A03/A04/A10/A14/A15. Nie dodawaj backupu previous_preconditioned_gradient bez wykazania stale-read; przegląd ścieżki zapisu przed odczytem nie potwierdził takiego błędu. A10/A14 nadal wymagają testu produkcyjnego cache miss→hit/refined Armijo, którego ręcznie zbudowane liczniki nie zastępują.

WIP 672bf44188052fe1a0ad1f42cd7188a196162906 jest wyłącznie materiałem do przeglądu. Nie scalaj go: rozpoznany token środowiskowy nie upoważnia do ustawienia profile_qualified=true. Rozdziel jawne dopuszczenie eksperymentalnego uruchomienia od naukowej/produkcyjnej kwalifikacji. Nie rozszerzaj publicznego API bez decyzji projektowej.

Możesz działać równolegle z agentem 5 tylko w jego fazie DG0/A13. Sparse pozostaje twoją własnością do przekazania agentowi 5; wspólne receipty/backend_step wymagają uzgodnienia z integratorem.

Własność:
- backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp
- backends/fem/gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.cpp
- backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp i powiązany stan.
- scripts/analysis/fem_gpu_benchmark.py i istniejące testy jego kontraktu.
- Minimalny istniejący native resolver/ABI potrzebny do kwalifikowanego profilu — po zatwierdzeniu granicy przez integratora.

Zadania:
- [ ] Prześledź FULLMAG_FEM_GPU_RELAXATION_PRECONDITIONER_STRATEGY od harnessu do runtime. W audytowanym SHA harness ją przekazuje, ale brak odbiorcy w backendzie/runnerze; request zwykle pozostaje pusty.
- [ ] Zaproponuj minimalne podłączenie przez istniejący wewnętrzny kontrakt kwalifikowanych profili. Nie dodawaj publicznego parametru Python/ProblemIR i nie traktuj dowolnej zmiennej środowiskowej jako dowodu kwalifikacji.
- [ ] Test end-to-end wymusza none/diagonal/cg4/cg8 i sprawdza requested, resolved oraz rzeczywisty apply. Nieznany, niekwalifikowany lub niezgodny profil musi failować, nie wykonywać po cichu none.
- [ ] Zachowaj produkcyjny default none. Ścieżka eksperymentalna nie może oznaczać automatycznej promocji profilu.
- [ ] A05: zachowaj capacity i niezmienne diagonale przy samej zmianie lambda; aktualizuj potrzebne wartości bez resetu całego obiektu. Testuj zmianę masy, maski, operatora i rozmiaru.
- [ ] A06: ogranicz storage/kopie w none tylko po analizie aliasów i lifetime. Nie usuwaj bufora entry snapshot utworzonego przez agenta 3. Zmierzone oszczędności raportuj oddzielnie od teoretycznych 56N bajtów.
- [ ] A09: potwierdź baseline 27/51 wywołań sumowania. Ogranicz redukcje dla x/y/z bez zmiany fixed-iteration recurrence, failure latch i kontraktu operatora. Nie wprowadzaj równocześnie mixed precision ani innego Krylov solvera.
- [ ] Testuj macierz SPD z niezerowymi off-diagonal, dense oracle, lambda=0, zero RHS, niepoprawne masy, frozen/PBC, oba minimizery i propagation failure.
- [ ] Każda optymalizacja ma osobny commit i A/B z tym samym faktycznie wykonanym profilem.

Bramka: zielony test mapowania tokenów w Pythonie nie wystarcza. Potrzebny dowód, że produkcyjny caller wykonuje wybrany operator na GPU.
