# Agent 5 — setup DG0 oraz rzeczywisty backend exchange

Skopiuj poniższy prompt w całości. Nie uruchamiaj przed spełnieniem zależności.

---

Repozytorium: C:\git\fullmag\fullmag.
Kanoniczny worktree integracyjny: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation.
Branch integracyjny: codex/fem-gpu-tasks1-5-remediation.
Historyczny baseline audytu: 4be277e47440a947a30954adb3bbdeef15c9b06f — nie używaj go jako wejścia implementacji. Branche 1–3 scalono w 307ef39994df4c6ca14dbe564afc33154af1942a; rozpocznij od późniejszego pełnego SHA poprawek review przekazanego przez integratora zgodnie z README. Nie zakładaj dostępności tych commitów na remote.
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

Pełny SHA poprawek review: `4ddd9bb6209042c99b75bde35b1d6d92c12df22b`. Analizę i przygotowanie testów DG0 możesz oprzeć na nim; implementację i późniejsze przejęcie sparse uzgodnij z agentem 6 zgodnie z blokadami README.

Zakres: A13 i A11.
A13 możesz rozpocząć równolegle z agentem 4 po przekazaniu wspólnego SHA przez integratora. Agenci 1–3 zakończyli swoje serie; nie powtarzaj ich implementacji. A11 rozpocznij dopiero po correctness baseline, integracji agenta 4 i formalnym przekazaniu sparse. Zmiany mfem_context.cpp z WIP 672bf44188052fe1a0ad1f42cd7188a196162906 nie są zatwierdzonym wejściem — nie scalaj całego WIP.

Własność:
- backends/fem/cpu/mfem/runtime/mfem_context.cpp — wyłącznie AdapterBackedElementwiseCoefficient/DG0 membership.
- backends/fem/gpu/cuda/exchange/exchange_upload.cpp
- backends/fem/gpu/cuda/sparse/
- backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.cu — dopiero po zwolnieniu przez agenta 2.
Nie traktuj całego mfem_context.cpp jako zgody na refaktor Context.

Zadania:
- [ ] A13: zastąp powtarzany liniowy std::find stałoczasowym membership związanym z poprawną tożsamością/wersją listy elementów. Najpierw sprawdź, czy odpowiednia mapa już istnieje.
- [ ] Testuj DG0 i nie-DG0, pusty aktywny zbiór, elementy nieaktywne, zmianę regionów bez zmiany rozmiaru oraz niepoprawny ordinal. Macierze i wartości współczynników muszą pozostać takie same.
- [ ] Zmierz setup oddzielnie od steady-state GPU. Nie ogłaszaj przyspieszenia kroków LLG na podstawie szybszego lookup DG0.
- [ ] A11: udowodnij aktualną ścieżkę legacy_sparse_gpu/custom CSR i allow_cusparse=false; ustal semantykę apply_xyz, fused local fields, masy i PBC przed zmianą backendu.
- [ ] Porównaj własny CSR z kompatybilną bibliotekową realizacją dostępną w przypiętym obrazie. Najpierw istniejący SparseApplyPlan/cuSPARSE; libCEED PA traktuj jako osobny eksperyment reprezentacji, nie obowiązkową szeroką migrację.
- [ ] Zapewnij executed-backend evidence z rzeczywistego producer, uzgadniając API z integratorem. Nazwa planu nie wystarcza.
- [ ] Testuj pole i energię, pochodną kierunkową, symmetry/constant mode tam gdzie właściwe, PBC/frozen, wszystkie wspierane typy siatki objęte wariantem oraz brak host fallbacku.
- [ ] Zmierz end-to-end time-to-accuracy, setup, pamięć, koszt interop i apply dla reprezentatywnych siatek. Własny CSR może pozostać najlepszym wariantem; brak zysku jest prawidłowym wynikiem badania.

Nie zmieniaj wersji bibliotek i nie włączaj globalnie cuSPARSE tylko dlatego, że istnieje. Bramka: porównanie jednakowego operatora i fizyki, nie dwóch różnych discretization/output policies.
