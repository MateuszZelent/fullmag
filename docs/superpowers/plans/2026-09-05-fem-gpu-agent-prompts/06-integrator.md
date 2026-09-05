# Agent 6 — koordynacja, przegląd integracji i kwalifikacja

Skopiuj poniższy prompt w całości. Nie uruchamiaj przed spełnieniem zależności.

---

Repozytorium: C:\git\fullmag\fullmag.
Kanoniczny worktree integracyjny: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation.
Branch integracyjny: codex/fem-gpu-tasks1-5-remediation.
Historyczny baseline audytu: 4be277e47440a947a30954adb3bbdeef15c9b06f. Stan scalenia 1–3: 307ef39994df4c6ca14dbe564afc33154af1942a. Odczytaj aktualny HEAD kanonicznego worktree i poprawki review; zapisz pełny wejściowy SHA. Sam merge nie jest kwalifikacją poprawności ani wydajności.
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

Pełny SHA startowy po poprawkach review: `4ddd9bb6209042c99b75bde35b1d6d92c12df22b`. Natywne kontrakty 4/4 PASS, ABI 3/3 PASS; pełny run just zatrzymany podczas części Rust, więc nie ma pełnego PASS recepty. Odtwórz brakującą bramkę i rozwiąż poniższe blokady przed zwolnieniem optymalizacji. Patrz docs/reports/05.09.2026/agent-1-3-integration-review.md.

Zakres: integracja pięciu agentów, A16, dokumentacja statusu i końcowy raport.
Najpierw przeczytaj README z harmonogramem. Nie uruchamiaj od razu wszystkich implementacji. Ten prompt nie upoważnia do tworzenia nowych zadań w aplikacji ani do push/master; koordynuj dostarczone branche.

Aktualizacja po integracji: nie twórz kolejnego konkurencyjnego głównego brancha. Używaj istniejącego kanonicznego worktree po potwierdzeniu wyłącznej własności. WIP jest zabezpieczony na codex/fem-gpu-pre-integration-wip-20260905 (672bf44188052fe1a0ad1f42cd7188a196162906), nie został scalony. Nie przywracaj go automatycznie. Agent 3 miał wcześniejszy wariant agenta 2; finalny wariant został scalony przez 27f7feede57d3669f5d93d03b92443bf24ac5483, a agent 1 przez 307ef39994df4c6ca14dbe564afc33154af1942a. Nie powtarzaj tych operacji.

Pierwsza bramka: sprawdź poprawki review normy CPU PCG, czasu i publikacji decyzji RK, polityki hostowej kontroli oraz rzeczywistych producerów PG-BB. Sprawdź stationary observation bez fikcyjnego line-search/accepted candidate. Wymagaj regresji NCG cache miss→hit i refined Armijo przez produkcyjny caller; source assertions i ręczne liczniki nie wystarczają. Bez pełnego dowodu pozostaw właściwe lane NOT VERIFIED.

Blokady przed zwolnieniem agenta 4 do implementacji: przetestuj stationary-only observation (pełna maska w native/Rust oraz mapper v2 ukrywający executed przy zerowym accepted), opcjonalny bit DIRECT_ENERGY_REFINEMENT w NCG przy dokładnej równości required/executed i produkcyjne regresje NCG. Runtime validator v2 już ogranicza wymaganie accepted_step_count > 0 do CompletedAccepted; nie przenoś tego wymagania na CompletedObservation. Nie rozluźniaj globalnie walidatora. STT/SOT nie są legalnym wariantem PG-BB: crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation odrzuca je zgodnie z docs/physics/0580 sekcja 2.4. Sprawdź regresję odrzucenia wszystkich algorytmów, nie dopisuj LLG direct-torque do executed mask. Szczegóły: docs/reports/05.09.2026/agent-1-3-integration-review.md. Do zamknięcia bramki agent 4 może prowadzić analizę; agent 5 może przygotować izolowane testy DG0 bez przejmowania sparse.

Twoja odpowiedzialność:
- Potwierdź repo/worktree i baseline, zapisz jawne SHA wejściowe każdej fali.
- Ustal własność plików i kolejkę dostępu do GPU/container builds. Nie benchmarkuj równolegle z buildem/innych runem.
- Wykonuj lokalną integrację zatwierdzonych commitów w osobnym branchu integracyjnym codex/, bez modyfikacji master i bez niszczenia dirty worktrees. Zapisuj pełne hashe; rozstrzygaj konflikty po odczytaniu obu intencji.
- Zbiorcze AGENTS/justfile/CMake/ABI i dokumenty mają jednego właściciela. Nie akceptuj tego samego zdarzenia liczonego przez dwa subsystemy.

Bramki:
- [ ] Odbierz poprawki review istniejących A01, A02/receipts i A03/A04/A15/A10; A13 dopiero dostarczy agent 5. Nie oznaczaj go jako już scalonego.
- [ ] Sprawdź wszystkich callerów redukcji i rzeczywiste kroki RK/PG-BB/NCG. A14 już jest w branchu; nie zlecaj powtórnej implementacji, lecz brakujący dowód runtime i A/B.
- [ ] Przekaż agentowi 4 SHA po tej integracji. Zweryfikuj E2E wybór profilu, nie tylko dostępność kernela.
- [ ] Zbuduj correctness-fixed baseline przez just i zarchiwizuj source/binary/image identity oraz wyniki fizyki. Wykonaj nowy build/test po merge, nie przenoś automatycznie wyników z branchy.
- [ ] Dopiero teraz zwolnij pozostałe optymalizacje A05–A09/A11/A12, zgodnie z README. Dla każdej grupy zachowaj osobny rodzic baseline i pomiar. A14 weszło przed kwalifikacją: jawnie rozdziel jego wpływ w projekcie A/B, nie przepisuj historii współdzielonych branchy.
- [ ] Kwalifikacja obejmuje operator E/H i derivative, niezależne residual demag, rollback/fault injection, macrospin i dynamikę RK, frozen/PBC oraz CPU/GPU parity na legalnych konfiguracjach.
- [ ] Zachowaj kanoniczny benchmark sinc-layer 500×500×10 nm i istniejące scenariusze/parametry. Nie zastępuj go łatwiejszym fixture; małe fixture są uzupełnieniem.
- [ ] A/B: ta sama geometria/topologia i fingerprint, fizyka, normy i tolerancje, GPU, output policy; warm-up oddzielnie, pięć pomiarów zgodnie z notą 0581, osobny Nsight. Nie porównuj starego solve w innej normie z nowym L2 jako równoważnej dokładności.
- [ ] Raportuj medianę, rozrzut, p95 z jawną liczbą próbek, cały czas do tolerancji, retry/failure, setup, transfery, fences, peak VRAM i faktyczny backend. Pięć próbek daje mało precyzyjne oszacowanie ogona — ujawnij ograniczenie.
- [ ] Dla promocji preconditionera zachowaj progi 0581: co najmniej 10% poprawy p50 na dwóch z trzech rozmiarów, brak regresji p50/p95 >5% i wszystkie bramki fizyki/rezydencji. Jeśli aktualny kontrakt się zmienił, zgłoś różnicę zamiast wybierać luźniejszy.
- [ ] Zaktualizuj polskie dokumenty zbiorcze i statusy, w tym nieaktualne opisy 0581, które na baseline nadal mówią o braku implementacji full sparse. Rozróżnij implemented, wired, runtime verified i qualified. Oryginalny audyt zachowaj niezmienny.
- [ ] Przygotuj raport końcowy z macierzą A01–A16 oraz dodatkowymi lukami receipt/profile, SHA każdego rozwiązania i linkami do dowodów. Przy blokadzie runtime podaj dokładny blocker i nie ogłaszaj przyspieszenia.

Kryterium ukończenia: zintegrowany kod z dowodami właściwymi dla każdej deklaracji. Liczba commitów i zielone source tests same nie wystarczają. Nie promuj nowych defaultów automatycznie; przedstaw decyzję z dowodami użytkownikowi.
