# Review bieżącej implementacji non-k0 — 2026-09-14

Status: **wymaga poprawek i kwalifikacji; nie gotowe do zatwierdzenia jako zweryfikowany solver dyspersji**.

## Zakres i wersja

Worktree `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`, branch `codex/eigensolve-dispersion-plan-20260912`, HEAD `55aadf7f2cbfd2fced91b3cf896e8e17cbb7ce61` oraz bieżące niezacommitowane zmiany bramki i profilu runtime. Pliki są równolegle rozwijane; ustalenia dotyczą odczytanego snapshotu, nie przyszłego commita. Przegląd objął routing, oracle P00/KS, walidację benchmarku, diagnostykę i wybrane miejsca native o wysokim ryzyku. Nie jest to przegląd każdej linii całego brancha ani kwalifikacja UI/GPU.

Podstawa: checkpoint implementacji z 12 września z aktualizacją 14 września, plan Floquet airbox nr 23, spec frequency-domain-artifacts-v2, kanoniczny benchmark COMSOL parameters.json oraz bieżący kod producentów artefaktów.

## Ustalenia wymagające działania

1. **P1 — bramka naukowa nie ma działającego pozytywnego testu na formacie native.** `scripts/test_validate_comsol_dispersion_scientific_gate.py:243` nadal buduje przypadek bez metadata.json i eigen/diagnostics/solver.v1.json, ze starym frequency_source i solver_model. Aktualny validator słusznie go odrzuca, ale nie ma tym samym dowodu, że zaakceptuje prawidłowe wyniki rzeczywistego solvera. Testy bramki i runnera: 11 passed, 2 failed. Drugi błąd to nieaktualny tekst oczekiwanego powodu odrzucenia analityki. Naprawa: fixture zgodny z producentem, pozytywny przepływ od artefaktów oraz negatywne kontrole naruszeń; następnie rzeczywisty run.

2. **P1 — niespójne mapowanie gamma blokuje prawidłową metadokumentację benchmarku.** `scripts/validate_comsol_dispersion_scientific_gate.py:251` pobiera canonical_material.get("gamma_m_per_A_s"), podczas gdy parameters.json:21 zawiera `gamma0_m_per_A_s`; config.py:194 wystawia `gamma_m_per_A_s`. Oczekiwana wartość staje się None zamiast 221100. Naprawa: jawne mapowanie nazw z zachowaniem jednostek, test z kanonicznym plikiem parametrów. Problem przekazany właścicielowi aktualnych poprawek.

3. **P1 — brak zamknięcia fizycznej walidacji B4–B6.** Plan wymaga C0/C1, A1 61 punktów i 8 gałęzi, kontroli siatki, airboxu i liczby modów. Checkpoint nadal oznacza te etapy jako niewykonane runtime. Testy wzorów i małe residuum tego samego operatora nie dowodzą poprawnego demagu ani kompletności widma. Wymagane są powiązane z wersją źródeł wyniki native, porównania Kittel/KS w zakresie stosowalności oraz zbieżność. Nie stwierdzono tu nowego potwierdzonego błędu fizycznego operatora; stwierdzono brak dowodu jego kwalifikacji.

4. **P2 — kwalifikator i producent mają rozchodzące się schematy.** Manifest nie zastępuje `metadata.json.execution_plan.backend_plan` ani `eigen/diagnostics/solver.v1.json`. Profil n=0 nie ma gotowego artefaktu: musi wynikać z wektorów modów i geometrii. Deklaracje w evidence nie mogą same dowodzić parametrów wykonania, jednorodności profilu czy zbieżności. Aktualna przebudowa bramki musi zostać oceniona na rzeczywistych polach planu i binarnych modach. To dług kontraktowy i ryzyko fałszywego zaliczenia/odrzucenia.

5. **P2 — ograniczenie skalowania solvera.** `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp:414` używa sekwencyjnego PETSc. Polityka single-process CPU jest już jawna; nie oznacza realizacji docelowej skalowalności dużego airboxu. Wymagane pomiary pamięci/czasu oraz kryteria wykonalności benchmarku. Nie jest to samodzielny dowód błędu fizycznego.

6. **P2 — checkpoint wskazuje starszy HEAD.** Początek implementation-status.md nadal podaje 28f552..., podczas gdy sprawdzony HEAD to 55aadf.... Niezacommitowane zmiany profilu runnera i bramki dodatkowo wykraczają poza commit. Przed zewnętrznym review należy utrwalić dokładny zakres zmian i źródła dowodów.

## Poprawki już obecne w źródłach

- Analiza KS nie przejmuje już routingu numerycznego FEM; manifest odróżnia wynik solvera od porównania analitycznego. Native wykonanie tej wersji nadal wymaga dowodu.
- P00 ma stabilne rozwinięcie w pobliżu zera. Python jest kontrolowany wysokoprecyzyjną referencją i ciągłością częstości. Rust nie był kompilowany w tym sprawdzeniu.
- 3e6 rad/m i 5 GHz pozostały ustawieniami presetu, a nie uniwersalnymi ograniczeniami walidacji.
- Sprawdzana jest stosowalność prostego jednorodnego modelu KS: materiał, kierunek pola, brak dodatkowej anizotropii/DMI.
- Przykład low-k ma oddalone granice Dirichleta. Zmniejsza to oszacowany błąd Gamma, lecz nie zastępuje testu zbieżności airboxu.
- Zamiast zgadywanego max_iterations=300 diagnostyka ma pobierać rzeczywiste ustawienia KSP.

## Hardkodowane wartości i podejrzenia wymagające ostrożności

Limit 512 DOF w floquet_airbox_operator.cpp i ograniczenie workspace dotyczą ograniczonego oracle; nie należy przedstawiać ich automatycznie jako limitu produkcyjnego sparse solvera. Stałe tolerancje należy wiązać z konkretną bramką, jednostką i skalą problemu, a nie usuwać mechanicznie.

`MAT_SHIFT_NONZERO` w faktoryzacji Poissona wymaga sprawdzenia zachowania przy Gamma i gauge. Sama obecność opcji nie dowodzi, że PETSc zmienił daną macierz lub widmo. Podobnie sprzężenie przez operator sprzężony w warstwie energetycznej nie dowodzi błędu LLG bez prześledzenia konwencji macierzy gyrotropowej. W tym review te dwa punkty pozostają hipotezami do walidacji, nie potwierdzonymi błędami fizycznymi.

## Wykonane kontrole

- `python -B -m pytest -p no:cacheprovider scripts/test_generate_comsol_analytic_reference.py scripts/test_kalinikos_model_applicability.py scripts/test_comsol_gate_aggregation.py -q`: **51 passed**.
- `python -B -m pytest -p no:cacheprovider scripts/test_validate_comsol_dispersion_scientific_gate.py scripts/test_run_comsol_dispersion_benchmark.py -q`: **11 passed, 2 failed**; szczegóły wyżej.
- Odczyt Git potwierdził HEAD, branch oraz dirty pliki. Nie wykonano push, merge ani cleanup.
- Zgodnie z zakazem nie kompilowano testów jednostkowych. Nie wykonano w tym review native MFEM/SLEPc, kwalifikacji GPU ani kontroli przeglądarki.

## Kolejność zamknięcia

1. Spójny schemat bramki/producenta, mapowanie gamma i wiarygodny pozytywny test.
2. Weryfikacja profilu produkcyjnego SLEPc bez kompilacji unit testów i build dokładnego snapshotu.
3. C0/C1 z demagiem i porównaniem analitycznym; następnie A1 oraz kontrole siatki, airboxu i liczby modów.
4. Aktualizacja checkpointu i ponowne review utrwalonego commita. Dopiero potem ocena gotowości do integracji.
