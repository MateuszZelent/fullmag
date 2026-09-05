# Agent 3 — rollback NCG, metryki kierunku i statusy redukcji

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

Zakres: A03, A04, A15, A10; później A14.
Implementację rozpocznij z commita integrującego pierwszą falę agenta 2. Wcześniej możesz wyłącznie analizować i projektować testy.
Ta kolejność jest obowiązkowa: A04 wymaga zmian callerów w plikach RK należących wcześniej do agenta 2.

Własność w twojej fali:
- backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp
- backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu
- backends/fem/gpu/cuda/reductions/reduction_kernels.hpp i .cu
- Callery fullmag_cuda_device_sum/max/min, w tym finalizacja RK, tylko w zakresie propagacji statusów.
- Wymagane bufory historii w relaxation_state/memory po uzgodnieniu z agentem 4, który zaczyna później.

Zadania:
- [ ] A04: zwracaj cudaError_t z max/min/sum, sprawdź wszystkich callerów query i execute. Test wymusza błąd API przy pozostającym success last-error oraz starym skończonym skalarze. Nie zastępuj statusu CUB przez cudaPeekAtLastError.
- [ ] A03: potwierdź nadpisywanie nonlinear_cg_direction_backup po snapshotcie wejściowym i podczas restartu. Oddziel niezmienny entry backup od working history minimalną zmianą. Alternatywa unieważnienia historii zmienia semantykę retry i wymaga jawnej decyzji; nie wybieraj jej po cichu.
- [ ] Test late failure po restarcie porównuje m, kierunek, jego ważność i metadata oraz wynik kolejnego kroku z kontrolą. Nie zgłaszaj jako osobnego błędu previous_z bez prześledzenia jego ponownego wyliczania.
- [ ] A15: po zastąpieniu p przez -z/-g metryki p·g i normy muszą opisywać nowy kierunek. Preferuj prostą ponowną redukcję tylko w recovery, jeżeli nie wymaga przebudowy normalnej ścieżki.
- [ ] Testuj NaN starego kierunku przy poprawnych g/z, finite non-descent, znacznie różne normy g/z, frozen/PBC. Awarii masy/operatora/CUDA nie ukrywaj fallbackiem -g.
- [ ] A10: rozdziel logiczne żądanie pola, fizyczny apply i cache hit. Nie zmieniaj znaczenia wersjonowanego pola ABI bez uzgodnienia; nie licz w dwóch warstwach.
- [ ] Po oddaniu correctness baseline przejdź osobno do A14. Reuse accepted energy tylko dla tego samego stanu, czasu, operatora i tej samej dokładności — szczególnie refined Armijo. Nie zakładaj, że każda końcowa redukcja jest zbędna.
- [ ] Zachowaj source/contract i managed runtime jako odrębne dowody.

Nie zmieniaj solvera demag ani wyboru profilu preconditionera. Bramka: fault-injection chroni akceptację i ponowny krok, a nie tylko sprawdza komunikat błędu.
