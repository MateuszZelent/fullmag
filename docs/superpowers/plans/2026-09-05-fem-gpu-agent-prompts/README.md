# FEM GPU — prompty dla sześciu agentów

Pakiet delegacyjny po audycie z 2026-09-05. Każdy plik zawiera samodzielny prompt z kontekstem, zakresem i bramką odbioru. Skopiuj całą jego treść do zadania danego agenta.

**Cel:** naprawić potwierdzone błędy, udowodnić rzeczywiste wykonanie optymalizacji, następnie zmierzyć ich wpływ.
**Architektura:** jeden integrator, izolowane branche/worktrees i sekwencyjne przekazywanie plików współdzielonych.
**Stos:** istniejący FEM/MFEM/hypre/libCEED/CUDA; bez upgrade’u i mixed precision w tym pakiecie.
**Historyczny baseline audytu:** 4be277e47440a947a30954adb3bbdeef15c9b06f. Nie zaczynaj kolejnych implementacji od niego.
**Status:** Odbiór agentów 1–3 oraz domknięcie NCG refinement ukończone i zweryfikowane. Zweryfikowany SHA kodu: `95a1876ed496c757849707f599c418613b7db603` (snapshot `c32dd20a220b89a3632b2cc8dde3266023a67232ad9dd842c9f18a49c62707cd`). Wyniki: container-backed `just verify-fem-gpu-execution-receipt-contract` PASS (exit 0), 6/6 native PASS bez SKIP, 28/28 Rust PASS, 50/50 Python PASS. Stan bramki: READY dla Agenta 4 i Agenta 5 (DG0/A13); A11 sparse nadal BLOCKED. Poprzednie SHA (4be277..., 307ef3..., 4ddd9b..., 3f3fff..., fc4410...) są historyczne. Prompty 1–3 są historyczne.

## Obowiązujący punkt wejścia

Kanoniczny worktree: `C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation`, branch `codex/fem-gpu-tasks1-5-remediation`.
Scalenie wszystkich trzech branchy: `307ef39994df4c6ca14dbe564afc33154af1942a`. To punkt integracji, **nie correctness-qualified baseline**. Przed utworzeniem kolejnego worktree integrator musi przekazać pełny SHA obejmujący także późniejsze poprawki review i wskazać wyniki ich testów. Odczytaj `git rev-parse HEAD` oraz `git status --short`; sam aktualny branch name nie jest niezmiennym wejściem.

**Aktualne wejście do dalszego review: `4ddd9bb6209042c99b75bde35b1d6d92c12df22b`. Najpierw prompt 6.** Trwa [domknięcie integracji](../2026-09-05-fem-gpu-integration-closure.md): kontrakt stationary/refinement i produkcyjne regresje NCG. Agent 6 musi je zamknąć przed zwolnieniem implementacji agenta 4. STT/SOT są już odrzucane przez kontrakt konserwatywnej relaksacji — nie są brakującą funkcją PG-BB do implementacji. Aktualna kompletna recepta just nie ma statusu PASS: po udanej części native/ABI poprzedni run celowo zatrzymano podczas kompilacji Rust. Szczegóły i log: [raport integracji](../../../reports/05.09.2026/agent-1-3-integration-review.md).

Zabezpieczony WIP: `codex/fem-gpu-pre-integration-wip-20260905`, commit `672bf44188052fe1a0ad1f42cd7188a196162906` (15 wcześniej zmienionych plików). WIP nie został scalony ani zakwalifikowany. Nie cherry-pickuj go w całości: zawiera m.in. loader automatycznie nadający profilowi kwalifikację na podstawie tokenu środowiskowego. Dopuszczalne jest tylko wybiórcze odtworzenie uzasadnionych zmian z testami.

Zmiany są lokalne; ten dokument nie dowodzi dostępności na remote. Agent na innym komputerze potrzebuje osobno zatwierdzonego push i potwierdzenia remote SHA. Nie kasuj żadnego worktree, `.freebuff/` ani starego WIP.

To instrukcje zlecenia, nie gotowe patche ani deklaracja kwalifikacji. Wykonawca przed zmianą zachowania stosuje właściwe skills projektowe; do realizacji kolejnych kroków używa executing-plans lub subagent-driven-development zgodnie z wybranym trybem pracy.

## Podział

| Agent | Zakres | Plik |
|---|---|---|
| 1 | norma PCG; później FK warm start | [Prompt 1](01-demag.md) |
| 2 | RK transakcje, receipty, adaptive control; później kopie RK | [Prompt 2](02-rk-receipts.md) |
| 3 | rollback NCG, statusy CUB, fallback, liczniki; później reuse energii | [Prompt 3](03-ncg-reductions.md) |
| 4 | wybór profilu, cache/pamięć i redukcje preconditionera | [Prompt 4](04-preconditioner.md) |
| 5 | DG0; później backend exchange | [Prompt 5](05-exchange-dg0.md) |
| 6 | integracja, kwalifikacja A16, dokumentacja | [Prompt 6](06-integrator.md) |
| 7 | niezależna weryfikacja i audyt (propozycja) | [Prompt 7](07-independent-verifier.md) |

## BRAMKA STARTOWA AGENTÓW 4–5 (RENUMERACJA I REWIZJA NUMERYCZNA)

Stan bramki:
- **Agent 4 (loader / preconditioner A05, A06, A09):** **READY** do prac optymalizacyjnych na osobnym worktree (bez przypisywania produkcyjnej kwalifikacji fizyki).
- **Agent 5 (sparse A11):** nadal **BLOCKED** do czasu zakończenia, weryfikacji i integracji prac Agenta 4 ze sparse operatorami. Wybiórczo i równolegle dozwolone wyłącznie niezależne zadania DG0/A13.
- **Agent 7:** rola niezależnego audytora i weryfikatora pozostaje propozycją do zatwierdzenia przez użytkownika.

Status tożsamości kodu i weryfikacji numerycznej:
- Commit `95a1876ed496c757849707f599c418613b7db603` zawierał nieuzasadnione tłumienie granicy błędu zaokrągleń `demag_roundoff_bound_j * (refined_rtol / ordinary_rtol)`, sztucznie wymuszające akceptację kroku Armijo.
- Nieuzasadniona redukcja została usunięta z `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`; certyfikat błędu zaokrągleń IEEE 754 jest niezmienniczy względem tolerancji solvera (zgodnie z uaktualnioną notą `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`).
- Dodano rygorystyczną regresję numeryczną w `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` potwierdzającą niezmienniczość certyfikatu i odrzucanie nierozstrzygniętych przedziałów (PASS, 0.64s).
- Native 5/6 PASS: `fem_gpu_execution_receipt_contract`, `fem_demag_poisson_contract`, `fem_gpu_rk_device_controller_contract`, `fem_gpu_relaxation_preconditioner_contract`, `fem_cuda_periodic_demag_contract`.
- NCG Armijo refinement: wejście w procedurę i wykonanie 6 fizycznych rozwiązań Poissona na CUDA zweryfikowane; na siatce 1-czworościennej CG zbiega do precyzji maszynowej, więc doprecyzowanie nie przesuwa energii, a nierozstrzygnięty przedział jest kanonicznie odrzucany (`rejected = 1`), po czym linia backtrackingu akceptuje krok (`cand = 2`, `stats.step = 1`). Asercja izolowanego zaakceptowanego świadka z `rejected = 0` pozostaje **NOT VERIFIED**.
- Rust 28/28 exact tests PASS przez `validate_exact_rust_test_log.py`.
- Host Python 50/50 PASS.

Zasady realizacji dla fali:
- Agent 4: loader/preconditioner; osobny worktree ze sprawdzonego SHA `95a1876ed496c757849707f599c418613b7db603`.
- Agent 5: wyłącznie DG0/A13; osobny worktree z tego samego SHA `95a1876ed496c757849707f599c418613b7db603`.
- Agent 5 / A11 sparse: zablokowane do integracji i przekazania przez agenta 4.
- Agent 6: integruje zamrożone commity i weryfikuje wynik po scaleniu.
- Agent 7 (propozycja): niezależny audyt i weryfikacja przed scaleniem do gałęzi głównej.
- Ograniczenie GPU: buildy i testy z dostępem do GPU oraz benchmarki muszą być wykonywane sekwencyjnie (żadnych równoległych procesów na karcie).

Nie uruchamiać nowej fali automatycznie.
Wspólne ABI, CMake, justfile, launcher, receipts i dokumenty zbiorcze
mają jednego właściciela w danym momencie: integratora albo jawnie wskazanego agenta.

## Harmonogram i blokady

1. Agent 6/integrator kończy odbiór 1–3: rzeczywista norma CPU PCG, transakcje RK, prawdziwe zdarzenia PG-BB oraz regresje NCG. Nie powtarza wykonanych merge. Zapisuje SHA po poprawkach i zakres świeżych testów.
2. Po przekazaniu tego SHA mogą równolegle pracować **agent 4 (loader profilu)** i **agent 5 (wyłącznie A13/DG0)**. Nie współdzielą checkoutu. Agent 6 może równolegle czytać/testować zamrożone commity, ale nie edytuje plików ich własności.
3. Agent 6 scala i sprawdza oba wyniki. Dopiero pozytywna bramka correctness pozwala rozpocząć optymalizacje; brak kwalifikacji musi być jawny.
4. Agent 4 wykonuje A05/A06/A09, po kolei i w osobnych commitach. Dopiero po jego integracji agent 5 przejmuje sparse i wykonuje A11. **A11 nie jest równoległe z edycjami sparse/preconditionera agenta 4.**
5. A12 (demag warm start) i A07/A08 (kopie/kontrola RK) pozostają osobnymi zleceniami po bramce correctness. Nie są wykonane tylko dlatego, że branche agentów 1–3 zostały scalone. A14 już istnieje: potrzebuje testu produkcyjnego reuse i pomiaru, nie ponownej implementacji.
6. Agent 6 prowadzi A16 po każdej integracji. Buildy i testy wykorzystujące GPU oraz benchmarki na tej samej karcie są kolejkowane; żadne równoległe A/B.

A08: poprawne nazwanie hostowej kontroli należy do poprawności; usuwanie redundantnej pracy jest oddzielną optymalizacją. A13 pozostaje osobnym commitem/pomiarem. Historyczna seria agenta 3 połączyła w historii poprawki i A14 przed kwalifikacją; zachowaj historię i wskaż to ograniczenie przy doborze baseline A/B, nie przedstawiaj jej jako czystego correctness-only baseline.

## Własność wspólna

- execution_receipt i backend_step: agent 2; potem zmiany wyłącznie przez integratora.
- redukcje CUDA i migracja wszystkich callerów: agent 3, po pierwszej fali RK.
- nonlinear_cg/pgbb_kernels: agent 3; późniejsze callery profilu agent 4 dopiero po przekazaniu.
- relaxation_memory/state: agent 3 najpierw snapshot; następnie agent 4 optymalizacja pamięci.
- rk_step_stats/energy: agent 2 najpierw transakcje, agent 3 następnie statusy/reuse.
- sparse: agent 4 najpierw preconditioner, agent 5 następnie backend exchange.
- justfile/CMake/ABI i dokumentacja zbiorcza: koordynacja przez agenta 6. Nie wolno scalać sprzecznych znaczeń pola ABI.
- Każdy agent zapisuje własny raport; oryginalny pakiet Astra Pro pozostaje niezmienny.
- Żaden prompt nie upoważnia do push, merge do master, kasowania worktrees/cache ani promocji defaultów.

## Odbiór

- [ ] Każde ID ma właściciela i osobny sprawdzalny wynik.
- [ ] Integrator przekazał dokładne SHA zależności, bez zgadywanych branchy remote.
- [ ] RED/GREEN i rzeczywista integracja zweryfikowane; brakujące dowody oznaczone NOT VERIFIED.
- [ ] A/B porównuje jednakową dokładność, fizykę i wykonany profil.
- [ ] Raport końcowy rozróżnia source, wiring, managed runtime, fizykę, parity i performance.
