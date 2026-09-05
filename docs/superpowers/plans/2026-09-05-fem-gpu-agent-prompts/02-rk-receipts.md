# Agent 2 — transakcje RK i rzeczywiste receipty RK/PG-BB/NCG

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

Zakres: A02, A08 oraz dodatkowe luki receiptów odkryte w lokalnym audycie; później A07.
Możesz rozpocząć poprawność równolegle z A01. Jesteś wyłącznym właścicielem integracji receiptów i plików RK w pierwszej fali.

Własność:
- backends/fem/gpu/cuda/integrators/rk/
- backends/fem/gpu/cuda/runtime/execution_receipt.cpp i .hpp
- backends/fem/cpu/mfem/runtime/backend_step.cpp — tylko routing/receipt FEM GPU.
- Wymagane istniejące projekcje ABI/runnera i testy receiptów, po uzgodnieniu zakresu.
Nie zmieniaj NCG ani API redukcji w tej fali; agent 3 będzie migrował callery po twojej integracji.

Zadania:
- [ ] A02: testuj nieudany capture przed kopiowaniem i między komponentami, zły rozmiar, stary token, powtórny commit. Propaguj błędy w rk_attempt_loop.cu ORAZ RkGraphPlan::launch w rk_graph.cpp.
- [ ] Dopiero udany capture może publikować ważność. Commit musi sprawdzać spójność kandydata z bazowym stanem/próbą i zużywać token. Nie narzucaj nowej rozbudowanej architektury, jeśli istniejące generacje wystarczą.
- [ ] Sprawdź rollback m, czasu, kroku, FSAL, kontrolera, pól i receiptów. Testuj rzeczywisty krok wszystkich wspieranych jawnych RK, nie tylko ręczne wywołanie helpera.
- [ ] Napraw maskę transferów RK: v1 resolve_plan obecnie nie ustawia allowed_transfer_mask, a rk_scalar_readback rejestruje CONTROL_SCALAR/COMPUTE. Dopuszczaj tylko transfery zgodne z kontraktem, nie wszystkie kategorie.
- [ ] Usuń double counting: bezpośrednie record_transfer i aggregate_attempt_transfers nie mogą naliczać tego samego zdarzenia dwa razy. Wybierz jednego właściciela księgowania, zachowując pokrycie transferów poza próbą.
- [ ] Podłącz prawdziwy lifecycle PG-BB; backend_step obecnie rozpoczyna i zamyka receipt tylko dla NCG. Testuj rzeczywiste kroki NCG→PG-BB→LLG, accepted/rejected/failed/cancelled i zmianę algorytmu.
- [ ] Dodaj testy rzeczywistych odczytów skalarów: dokładna liczba bajtów/synchronizacji, bez fałszywego accounting_valid=false. Nie podstawiaj masek planu jako dowodu wykonania.
- [ ] A08: zgodnie z aktualnym wykonaniem raportuj hostową kontrolę adaptacyjną. Usuń redundantną decyzję GPU dopiero po zidentyfikowaniu wszystkich konsumentów. Zachowaj wspólną politykę PI, estimator i czasy stadium; nie przenoś teraz całego kontrolera na GPU.
- [ ] Oddaj poprawność i receipty do integracji. A07 wykonaj później, po A03: zaprojektuj minimalne role buforów, zachowując rollback i FSAL; zmierz usunięcie roundtrip D2D. Nie utożsamiaj payload 48N bajtów z pomiarem czasu.

Bramka: testy receiptów muszą przejść przez produkcyjny backend step i realny odczyt danych. Sam ręcznie skonstruowany receipt nie zamyka zadania.
