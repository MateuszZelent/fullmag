# Wspólny właściciel runtime PETSc/SLEPc — review 4060116271

Status: plan implementacji, nie dowód wykonania. Stan źródeł: branch `codex/eigensolve-dispersion-plan-20260912`, bazowy commit `2e351065da285dbbb4e7320a61135f9104ce21b5`. Nie zmieniamy równań ani polityki wyboru backendu.

## Potwierdzony problem

CPU Gamma, Floquet, PA-E2, PA-E3 i sparse-direct oraz GPU mają niezależne blokady dla tego samego procesu PETSc/SLEPc. Chronią własny moduł, lecz nie wspólną inicjalizację ani równoczesne operacje różnych modułów. Nie odtworzono crashu; źródła dowodzą braku wspólnej granicy synchronizacji.

| Rodzina | Bieżący właściciel | Istotna zależność |
|---|---|---|
| Gamma/CSR/tiny | `slepc_modal_eigen.cpp::slepc_modal_solver_mutex` | Dwa publiczne entrypointy dzielą jedną blokadę tylko w tym module. |
| Native Floquet | `modal/floquet_modal_solver.cpp::native_floquet_solver_mutex` | Blokada obejmuje też diagnostyczny dense oracle; prosty wrapper deleguje do generic przed native entrypointem. |
| PA-E2 | `poisson_airbox_modal_eigen.cpp::pa_e2_slepc_mutex` | Dispatch do PA-E3 następuje przed zdobyciem lokalnej blokady. |
| PA-E3 | `poisson_airbox_schur_matshell.cpp::pa_e3_slepc_mutex` | Rekurencja podokien korzysta z już aktywnego operatora; nie wolno ponownie zdobywać nierekurencyjnej blokady. |
| Sparse-direct | `engines/sparse_direct/cpu_sparse_direct_engine.cpp::petsc_sparse_direct_mutex` | Zewnętrzny modal_response nie powinien dokładać drugiego lease. |
| GPU | `gpu/modal_petsc_slepc.cpp::gpu_slepc_mutex` | Jawny finalizer i atexit wymagają objęcia wspólnym właścicielem; CPU może już korzystać z inicjalizacji wykonanej przez GPU. |

## Kontrakt docelowy

1. Jeden prywatny właściciel procesu obejmuje inicjalizację, operacje PETSc/SLEPc i sprzątanie uchwytów wszystkich tych rodzin. Nie wolno ograniczyć poprawki do podmiany dwóch nazw mutexów.
2. Publiczna operacja zdobywa lease raz. Prywatne helpery i rekurencja PA-E3 otrzymują jawnie już posiadany lease; nie maskujemy zagnieżdżenia przez dodanie recursive_mutex. Dispatch PA-E2 zachowuje dotychczasową kolejność.
3. Obiekty runtime nie mogą uciekać poza czas życia właściwego lease bez udokumentowanego właściciela. Współdzielony cached operator musi mieć jawny kontrakt przekazania i destrukcji.
4. Init oraz finalizacja korzystają z tego samego właściciela. Nie wolno finalizować SLEPc z GPU, gdy aktywny lease CPU używa tego runtime. Trzeba zachować rozróżnienie runtime zainicjalizowanego zewnętrznie i przez Fullmag; cudzej inicjalizacji Fullmag nie finalizuje.
5. Nie zmieniamy requested/resolved CPU/GPU ani nie wprowadzamy fallbacku. Równoległa pula procesów pozostaje legalna: każdy proces ma własny owner; ograniczenie dotyczy wywołań wewnątrz jednego procesu.

## Kolejność implementacji

- [ ] Opisać prywatne init/shutdown/cached-object lifecycle, zwłaszcza GPU explicit finalizer i atexit, oraz dobrać jeden punkt definicji ownera w bibliotece. Dokumentacja przed zmianą kodu.
- [ ] Wprowadzić owner/lease oraz helpery init i sprzątania, z wyraźnym zakazem podwójnego acquire na tym samym wątku.
- [ ] Przenieść generic i native Floquet; następnie PA-E2/PA-E3 wraz z rekurencją i cache; sparse-direct; GPU i finalizację. Żadna rodzina nie może pozostać na odrębnej blokadzie.
- [ ] Dodać wykonywalny kontrakt rzeczywistych entrypointów Gamma/Floquet: równoczesne wywołania nie nakładają sekcji runtime; rezultat i status odpowiadają wykonaniu sekwencyjnemu.
- [ ] Sprawdzić rekurencję okien, błędy i anulowanie pod ograniczonym timeoutem w CI; brak deadlocku, lease zwalnia się po każdym terminalnym wyjściu.
- [ ] Dodać osobny CI kontrakt inicjalizacji/finalizacji CPU/GPU bez wymyślania dowodu GPU z testu CPU. Gdy brak realnego GPU runtime, pozostawić tę bramkę NOT VERIFIED.
- [ ] Review całego diffu, commit/push i aktualizacja audytu na podstawie nazwanych wyników. Bez lokalnej kompilacji/testów zgodnie z bieżącym zakazem.

## Kryteria odbioru

Wspólną serializację musi dowodzić test rzeczywistych rodzin, a nie sam test nowej klasy mutexa. Nie wystarczy brak błędów kompilacji lub brak reprodukcji crashu. Dowody runtime i deterministyczności oraz dowód GPU są odrębnymi bramkami. Pozycja 4060116271 pozostaje `valid_unfixed` do implementacji, a po implementacji `implemented_pending_ci` do uzyskania adekwatnych dowodów.
