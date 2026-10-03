# Floquet — ograniczona próba Flexible GMRES

Data: 2026-10-03. Zakres: FEM CPU, diagnostyczny wybór Krylov dla przesuniętego układu Schura. Bez deklaracji naprawienia błędu lub kwalifikacji fizycznej.

## Potwierdzone dane i hipoteza

Build #221, digest fa998c121f9288ab255011d1a36ffe0cce66e55108603546cd1a22c3d59c637c, przeszedł receipt/ABI/runtime dla MFEM4.10, PETSc3.24.6 i SLEPc3.24.3. Kampania signed15-adaptive-v1 zatrzymała się na k=-25 rad/µm. Jednopunktowe odtworzenie schur-km25-restart8-v1 powtórzyło dokładnie normy GMRES: recursion8.54271e-16, recomputed3.94672e-13, początek cyklu1.21126e-13.

Schur action przed EPS: repeatability0, homogeneity/additivity około2e-16, Poisson residual3.64e-15. To nie test preconditionera na faktycznych wektorach Arnoldiego i nie dowód dokładności shifted inverse. Modalny Poisson używa PREONLY/LU bez shiftu; wcześniejszy komentarz o iteracyjnym wewnętrznym solve nie opisuje tej realizacji. PC_RIGHT i norma unpreconditioned są potwierdzone przed EPS.

Hipoteza do rozdzielenia: rekonstrukcja prawego preconditionera może wzmacniać roundoff/cancellation. GMRES rekonstruuje rozwiązanie przez zastosowanie preconditionera do kombinacji wektorów Krylov; FGMRES zachowuje osobne preconditioned kierunki. W arytmetyce dokładnej przy stałym liniowym preconditionerze metody dotyczą tego samego układu. Nie zakładamy, że PCLU jest nieliniowy, ani że sama zamiana algorytmu naprawi błąd.

## Granice próby

- Kanoniczna fizyka, równania, jednostki SI i residual oryginalnego układu pozostają w [0828](../physics/0828-fem-frequency-domain-floquet-demag.md). Nie zmieniamy demaga, siatki, stanu równowagi, znaków fazy, regularizacji Poissona, EPS/KSP rtol, physical residual1e-8 ani kryteriów window/field.
- Opt-in `FULLMAG_FLOQUET_SHIFTED_KSP_TYPE=fgmres`, sterowany jawnym `--shifted-ksp-type fgmres` w managed driverze. Brak opcji zachowuje GMRES; inne wartości są odrzucane. Opcja dotyczy tylko tego natywnego właściciela FEM CPU Floquet, nie K0, GPU lub FDM.
- Restart i CGS refine-always pozostają wspólne. Breakdown tolerance GMRES nie jest reklamowana jako aktywna dla FGMRES: diagnostyka podaje null. Faktyczny typ jest sprawdzany przez KSPGetType przed EPS, bez fallbacku.
- Run-request i run-result wiążą żądany wariant. Native diagnostics publikuje rzeczywisty typ. To nadal `NOT VERIFIED`; nie wolno przepisać starego wyniku GMRES jako FGMRES.

## Odbiór i dalsze kroki

Kontrole interpretowane sprawdzają opt-in, odrzucenie nieobsługiwanej wartości, przepływ do managed command i receipt. Nie są wykonaniem PETSc. Kompilowanie native unit tests nadal zabronione. Nowa kapsuła runtime-v2 musi przejść kolejkę, atestację i konkretny punkt -25, z pełnymi polami oraz original-pencil residual. Porównanie całych EPS runów zmienia kolejne RHS, więc jest testem zachowania metody, nie izolowanym replay tego samego RHS. Do przypisania przyczyny potrzebny jest pomiar rzeczywistych wektorów i działania preconditionera; brak takiego replay pozostaje jawny.

Po poprawnym punkcie wymagane Γ/±10 i docelowe15 rzeczywistych punktów, walidacja oraz wykres. Parytet serial/adaptive, zbieżności, COMSOL, GPU i cały S00–S12 pozostają otwarte. Nie zmieniono wersji PETSc/SLEPc.

## Mapa źródeł i źródła pierwotne

- `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `floquet_diagnostic_shifted_ksp_type`, `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context`: wybór oraz konfiguracja native KSP.
- `scripts/run_de_100nm_pilot.py` + `compose_command`, `execute`, `main`: jawna opcja i provenance receiptu.
- `scripts/test_de_shifted_ksp_type.py`: kontrola scope i provenance, bez native compilation.
- [PETSc FGMRES](https://petsc.org/release/manualpages/KSP/KSPFGMRES/), [kod GMRES](https://petsc.org/release/src/ksp/ksp/impls/gmres/gmres.c.html). Dokumentacja online jest nowsza od runtime3.24.6; zgodność API wymaga managed builda.

## Kontrola odbioru próby — przyrost źródłowy

Jawny wariant wymaga natywnego frequency_window oraz co najmniej jednego k≠0. Nearest i dense oracle są odrzucane przed storage/Docker, ponieważ nie publikują kompletnego pomiaru tej próby. Γ w mieszanej ścieżce pozostaje w swoim właścicielu; nie reklamujemy dla niego FGMRES.

Postsolve observer wylicza dla każdego shifted solve normę rzeczywistą z b−Ax. Przy potwierdzonym zerowym initial guess, PC_RIGHT i normie unpreconditioned porównuje ją z max(atol, rtol·norma RHS), z faktycznymi tolerancjami powiązanymi z konfiguracją przed EPS. Zerowy RHS jest oceniany absolutnie; zerowy próg wymaga dokładnie zerowego residualu. Każdy solve trafia do solve_count i dokładnie jednego measured/unavailable; violation_count obejmuje niespełniony próg albo niedodatni convergence reason. Maximum_tolerance_ratio obejmuje wszystkie pomiary i nie jest interpretowane przez normę ostatniego RHS.

Agregat jest diagnostic-only: observer nadal zwraca zero i nie zmienia zbieżności KSP/EPS. Konsument jawnej próby wymaga pełnego pokrycia, zerowych violations/unavailable i zgodnego rzeczywistego typu w każdej próbce i podoknie. Stary runtime bez nowego agregatu nie jest akceptowany jako dowód FGMRES. Fizyczny residual1e-8 pozostaje odrębną bramką. Native compilation/runtime oraz 15 punktów nadal NOT VERIFIED.

Źródła: floquet_modal_solver.cpp::capture_last_floquet_shifted_solve; slepc_modal_eigen.hpp::SLEPcTinyGyrotropicModalEigenResult; production_cpu_modal_eigen.cpp::production_window_diagnostics_json; scripts/de_shifted_ksp_trial.py::validate_shifted_ksp_trial; run_de_100nm_pilot.py::execute.

## Wynik ograniczonej próby #222

Build #222 i atestacje CPU przeszły; źródła runtime: f7ecb100648b57fb69fe2de4a932efba02717190, digest19e38280b5da573d6fc193a09c04b6578727ddd149234d755af1beeb725559f8. Bez native unit tests. Punkt DE k=-25rad/µm z L2/t3 i modelem71ba0d18225ffcc83f7f18e676de8dc051e87fd1: f=13.557588586290586GHz, pełny residual1.926591054747952e-10. Wszystkie169 shifted solves z trzech podokien zmierzono: zero violations/unavailable, maximum_tolerance_ratio0.9964145193323742. Demag i rekonstrukcja potencjału oraz identity binding przeszły. Potwierdza to poprawne wykonanie tego przypadku FGMRES; nie dowodzi jeszcze źródła awarii GMRES ani zbieżności/identyfikacji pasma n0.

Pierwotny receipt failed zachowano. Jego konsument oczekiwał innego schematu diagnostyki niż faktyczny frequency_domain_modal_solver_diagnostics.v1 i odrzucał exhausted subwindow bez modów. Konsument teraz rozróżnia pusty zakres dokładnie według natywnych dodatnich EPS/KSP i liczników kandydatów/odrzuceń; nadal sprawdza kryterium każdego inverse solve. Nie traktuje pustego podokna jako dowodu kompletności widma. Schur action jest odczytywany ze wszystkich indeksowanych podokien, bez utraty obserwacji. Regresje:15 consumer +42 driver PASS; unknown schema, candidate failure i wcześniejsze naruszenie solve pozostają odrzucane.

Dowód rewalidacji (osobny, bez nadpisania wyniku): storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/nonzero-k-validation/15418192c13e4a119e6f75d14dde9c88/fgmres-km25-restart8-v2/posthoc-validation-v1.json. Wiąże hashe oryginalnych request/result, artefaktów i konsumentów. Status completed_unqualified; reszta bramek naukowych pozostaje otwarta.

Mapa korekty: scripts/de_shifted_ksp_trial.py::validate_shifted_ksp_trial/_validate_window; production_cpu_modal_eigen.cpp::subwindow_is_clean_empty_window; scripts/run_de_100nm_pilot.py::validate_schur_action_diagnostic/_validate_schur_action_payload.
