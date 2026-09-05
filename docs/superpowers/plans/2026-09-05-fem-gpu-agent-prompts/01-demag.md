# Agent 1 — kontrakt residuum demag i później FK warm start

Skopiuj poniższy prompt w całości. Nie uruchamiaj przed spełnieniem zależności.

---

Repozytorium: C:\git\fullmag\fullmag.
Kanoniczny worktree integracyjny: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation.
Branch integracyjny: codex/fem-gpu-tasks1-5-remediation.
Audytowany baseline: 4be277e47440a947a30954adb3bbdeef15c9b06f.
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

Zakres: A01, a dopiero po zatwierdzeniu correctness baseline A12.
Możesz rozpocząć A01 równolegle z agentem 2 oraz częścią A13 agenta 5.

Własność:
- backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp
- backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp
- backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp
- backends/fem/core/demag_linear_solve_validation.cpp, gdy konieczne.
Ścieżki są względne wobec twojego izolowanego worktree. Testy demag i dokumentację dobierz po odczytaniu istniejących targetów.

Zadania:
- [ ] Potwierdź wersje MFEM/HYPRE z obrazu i kodu, domyślną normę PCG oraz wszystkie konstruktory używane przez Poisson/FK. Sprawdź CPU dla porównywalności, bez niezwiązanej przebudowy CPU.
- [ ] Dodaj natywny test macierzy SPD A=[[1,1],[1,1e12]], b=[1,0], x0=0 i Jacobi. Po pierwszej iteracji norma preconditionowana wynosi 1e-6, lecz względne L2 wynosi 1; rtol=1e-5 nie może certyfikować L2 sukcesu.
- [ ] Ustaw jawnie właściwą normę PCG, propaguj błędy API, rozróżnij reported recursive residual i niezależne b-Ax. Nie wykonuj castu PCG dla GMRES.
- [ ] Przetestuj rtol/atol, zero RHS, niezerowe x0, forced independent validation, Jacobi/AMG oraz oba układy FK. Nie podnoś tolerancji, gdy wzrośnie liczba iteracji.
- [ ] Oddaj A01 integratorowi. A12 ma osobny commit wejściowy i osobną decyzję po baseline.
- [ ] Dla A12 zachowuj poprzedni potencjał tylko przy zgodnej tożsamości operatora, BC/gauge i rozmiaru. Unieważniaj po błędzie i zmianie problemu. Testuj oba układy FK, cold/warm start i true residual.
- [ ] Porównaj czas całkowity, liczbę iteracji, pole i energię. Warm start bez powtarzalnego zysku pozostaje kandydatem, nie nowym defaultem.

Nie dotykaj RK, NCG, redukcji CUDA ani zbiorczych receiptów. Bramka: A01 wymaga behawioralnego testu natywnego, nie samego grep SetTwoNorm.
