# Status napraw — audyt eigensolve dyspersji (aktualizacja 2026-09-16, wersja 2)

Uzupełnienie do `2026-09-15-eigensolve-dispersion-correctness-audit.md`. Gałąź `codex/eigensolve-dispersion-plan-20260912`, worktree na `orion` (`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912`).

**Ta wersja koryguje poprzednią**: kilka pozycji oznaczonych wcześniej jako „otwarte" (B3, H4) okazało się być aktywnie naprawianych/naprawionych przez proces zewnętrzny — po prostu nie doczytałem całego pliku za pierwszym razem, bo funkcje zostały dodane dalej w środku dużego, wciąż-niezacommitowanego diffa.

## Kontekst

Po zleceniu „napraw wszystkie błędy" 5 subagentów zostało wysłanych równolegle. Wszystkie 5 zostało ucięte przez rate limit, **zanim wprowadziły jakąkolwiek realną zmianę** — ich cały „diff" okazał się być wyłącznie zmianą końców linii (CRLF↔LF) na 13 plikach. Cofnięte.

Niezależnie od tego, **na tej samej gałęzi aktywnie pracuje inny, znacznie bardziej zasobny autonomiczny proces** — commituje jako `Mateusz Zelent`, cytuje ten audyt wprost w treści commitów i w nowym pliku `docs/audits/2026-09-16-dispersion-de-readiness-audit.md`, ma dostęp do rzeczywistego managed builda (`895df90a7cc9434b805f0318322c43b4`, profil `fem-cpu-slepc-runtime-v1`, **zakończony powodzeniem**) i realnych przebiegów solvera (C0 Γ bez demagu: **2.800264212917637 GHz** vs analityka 2.800264212915110 GHz, błąd względny ~9·10⁻¹³). To coś, czego ja nie mam — kompilatora ani działającego builda MFEM/PETSc/SLEPc.

Ten proces właśnie (stan **niezacommitowany**, w locie) implementuje poprawkę H4 — nowy moduł `backends/fem/src/frequency_domain/real_frequency_rotated_pencil.{hpp,cpp}` + `real_frequency_rotated_pencil_test.cpp`, i przebudowuje `slepc_modal_eigen.cpp` (+219 linii realnej treści) żeby użyć obróconego pencila zamiast surowego `(K,G)`. Napisał też własny, bardzo rzetelny audyt gotowości DE (`2026-09-16-dispersion-de-readiness-audit.md`) z nowymi ustaleniami DE-01…DE-07 (patrz niżej) — proszę go przeczytać, jest lepszy niż to podsumowanie.

**Z tego powodu przestałem edytować pliki, które ten proces ma aktualnie otwarte** (`slepc_modal_eigen.*`, `validate_comsol_dispersion_scientific_gate.py`, `floquet_bloch_scalar.cpp`, `contour_interval_solver.cpp` i cała reszta dużego niezacommitowanego diffa) — dalsza ingerencja z mojej strony groziłaby kolizją z żywą pracą, bez korzyści (on ma build, ja nie).

Osobna obserwacja: **3242 pliki** w drzewie roboczym mają zmiany, które po `git diff --ignore-space-at-eol` znikają całkowicie — czysty szum końców linii, prawdopodobnie z jednego globalnego zdarzenia (np. `core.autocrlf` albo edytor). Na to nałożone są realne zmiany procesu zewnętrznego w kilku plikach (np. `slepc_modal_eigen.cpp`: 219 linii realnej treści + reszta to szum EOL). Nie ruszałem tego — poza zakresem, nie wiadomo czy celowe.

## Tabela statusu

| # | Waga | Status | Uwagi |
|---|---|---|---|
| B1 (gęsta+rzadka, shared-domain) | BLOCKER | **NAPRAWIONE** (proces zewnętrzny) | `qphi_feedback_scale`/`-mu0` w `poisson_airbox_shared_domain.cpp:3246-3248,3322`. Potwierdzone też niezależnie w nowym audycie DE (sekcja „co już istnieje") |
| B1 (falowód, duplikat) | BLOCKER | **NAPRAWIONE (ja)** | `qphi_feedback_scale` (domyślnie 1.0) dodane do `FloquetWaveguideCrossSectionProblem` |
| B2 | BLOCKER | **NAPRAWIONE** (proces zewnętrzny) | `form`/współczynniki przeniesione do `FloquetBlochScalarAssemblyResult` jako `unique_ptr` |
| B3 | BLOCKER | **NAPRAWIONE** (proces zewnętrzny) | Nowa funkcja `_validate_dispersion_analytic_coverage` (linia ~1354) — samodzielna, bez zależności od zewnętrznej listy „evidence", sprawdza **wszystkich 61** próbek ścieżki C1 gałęzi fundamentalnej wobec `_kalinikos_frequency_hz_general_phi` (dowolny kąt, nie tylko BV/DE). Wpięta w `reasons` (blokuje `qualified`) w głównej funkcji raportu, linia ~2512. To dokładnie naprawia problem opisany w oryginalnym audycie |
| B4 | BLOCKER | **NAPRAWIONE** (proces zewnętrzny) | `KS_RELATIVE_TOLERANCE`: 2% → 0.3% |
| H1 | HIGH | **NAPRAWIONE** (proces zewnętrzny) | `MassWeightedOverlapOutcome::{Computed,LengthMismatch,NotComputable}` — fail-closed zamiast cichego fallbacku euklidesowego |
| H2 | HIGH | **OTWARTE, ale teraz ilościowo policzone przez proces zewnętrzny (DE-02)** | Ich audyt DE liczy: dla N=108843 węzłów to ~217686 globalnych składań i ~23.7 miliarda odwiedzin wierszy — potwierdza wagę problemu, koszt konkretnego C1 jeszcze niezmierzony. Nie naprawiałem — plik (`floquet_bloch_scalar.cpp`) jest właśnie edytowany przez proces zewnętrzny |
| H3 | HIGH | **NAPRAWIONE** (proces zewnętrzny) | `STSetPreconditionerMat(..., context.a_qq)` zamiast `rotated_a_qq`. Ich nowy audyt DE (ryzyko #1) zaznacza: to przybliżenie energetyczne, nie automatycznie przekątna obróconego operatora — zalecają zmierzyć residual/iteracje KSP, nie deklarują tego za w pełni zamknięte |
| H4 | HIGH | **W TRAKCIE NAPRAWY (proces zewnętrzny, niezacommitowane)** | Ich własny audyt DE-03 potwierdza dokładnie to samo, co ja: rzeczywisty target na widmie ±iω, ale **explicite ostrzegają, żeby nie kopiować mechanicznie** rozwiązania z `floquet_modal_solver.cpp` na `slepc_modal_eigen.cpp` — inny kontrakt. W międzyczasie zaczęli już pisać właściwe rozwiązanie: nowy dzielony moduł `real_frequency_rotated_pencil.{hpp,cpp}` + test, i przebudowują `slepc_modal_eigen.cpp` (obecnie +219 linii realnej treści, niezacommitowane). Nie ruszałem — plik aktywnie edytowany |
| H5 | HIGH | **NAPRAWIONE (ja)** | `floquet_waveguide_cross_section.cpp`: `axial_weight = area·scale·ms·(local_test==local_source ? 1/6 : 1/12)` zamiast błędnego `area/3` dla członu osiowego (spójna macierz mas P1). Test zaktualizowany |
| H6 | HIGH (praktycznie MEDIUM) | **OTWARTE** | Nie ruszałem — ryzyko błędu w konwencji znaku bez kompilatora przewyższa wartość niepewnej poprawki. Moduł bez wywołującego produkcyjnego |
| H7 | HIGH | **NAPRAWIONE** (proces zewnętrzny) | `angular_frequency_from_eigenvalue` → `Option<f64>`, `None` na ujemnej/nieskończonej wartości własnej |
| H8 | HIGH | **CZĘŚCIOWO NAPRAWIONE + nowe, głębsze ustalenia (DE-01, DE-04, DE-05)** | `_validate_benchmark_metadata` teraz sprawdza `k_sampling` (linie ~95, ~526 — nie było tego w poprzedniej wersji tego raportu, źle sprawdziłem). Co ważniejsze, `_validate_dispersion_analytic_coverage` (fix B3) już wymusza analitykę na *każdym* z 61 punktów pod ich faktycznym kątem ukośnym — to silniejszy test niż pojedynczy „prawdziwy" punkt DE, bo łapie błędną zależność kątową na segmentach X–M i M–Γ. Proces zewnętrzny znalazł jednak nowe, poważniejsze problemy w tym samym obszarze: **DE-01** (niespójność wersji hash siatki v2 vs v3 blokuje bramkę niezależnie od poprawności fizyki), **DE-04** (orchestrator benchmarku zostawia `analytic_controls` puste, `pending` dla mesh/airbox/mode_count — pojedynczy przebieg C1 strukturalnie nie może sam zamknąć kwalifikacji), **DE-05** (`fem_eigenmodes_dispersion_de_bv_low_k.py` ma inne parametry materiałowe niż C1 i nie jest jego zamiennikiem) |
| H9 | HIGH | **NAPRAWIONE (ja)** | `DEGENERACY_RELATIVE_FREQUENCY_TOLERANCE`: 1e-9 → 1e-4 |
| M7 | MEDIUM | **NAPRAWIONE** (proces zewnętrzny) | String testu i źródła teraz zgodne |
| M16 | MEDIUM | **NAPRAWIONE (ja)** | `kDefaultZeroFrequencyToleranceRadPerS`: 1e-9 → 1e5 rad/s |
| M1, M6 | MEDIUM | **OTWARTE** | `robin_beta` w `fem.rs:1092` nadal k-niezależne; `max_abs_hermitian_residual` nadal liczony, ale nieczytany w `floquet_modal_solver.cpp` — nie sprawdzałem ponownie po odkryciu skali aktywnej pracy zewnętrznej, plik może być w trakcie zmian |
| M2–M5, M8–M15, M17–M19, LOW/NIT | — | **NIE ZWERYFIKOWANE PONOWNIE** | Nie miałem czasu przejść punkt po punkcie po odkryciu skali równoległej pracy; część mogła zostać naprawiona przy okazji |

## Nowe ustalenia procesu zewnętrznego spoza mojego audytu (z `2026-09-16-dispersion-de-readiness-audit.md`)

- **DE-01 (P1)** — `fem_mesh_topology_fingerprint` produkuje v3, ale `validate_comsol_dispersion_scientific_gate.py` bezwarunkowo liczy i porównuje v2 (`comsol_mesh_identity.py`). Różne hashe dla tej samej siatki → bramka odrzuca poprawny wynik liczbowy. To osobny, potwierdzony blocker dla samej kwalifikacji, niezależny od poprawności fizyki.
- **DE-02 (P1)** — ilościowe potwierdzenie H2: globalne składanie kolumna-po-kolumnie w `floquet_bloch_scalar.cpp:418-481` plus brak `magnetic_reduced_node` w `floquet_airbox_operator.cpp:584-600` → dla N=108843 ok. 217686 globalnych składań / 23.7 mld odwiedzin wierszy (szacunek strukturalny, nie pomiar).
- **DE-03 (P1)** = H4, z ważnym zastrzeżeniem: nie kopiować mechanicznie rozwiązania z `floquet_modal_solver.cpp` — inny kontrakt algebraiczny, potrzebny osobny test z ≥2 znanymi częstotliwościami.
- **DE-04 (P1 dla walidacji)** — `scripts/run_comsol_dispersion_benchmark.py:918-945` zostawia `analytic_controls` puste i mesh/airbox/mode_count jako `pending`; pojedynczy przebieg C1 nie może sam zamknąć kwalifikacji — to *prawidłowe* odrzucenie niepełnego dowodu, nie fałszywy sukces bramki.
- **DE-05 (P2)** — kanoniczna ścieżka Γ–X–M–Γ zaczyna się BV, potem ukośnie; 61 punktów/24 mody to nadmiar do pierwszej diagnozy. `fem_eigenmodes_dispersion_de_bv_low_k.py` ma inny materiał (Ms=140 kA/m vs 800 kA/m) i tolerancję 10% — nie jest zamiennikiem C1.
- **DE-06 (P2)** — protokół zbieżności airboxu (coarse/medium/fine vs primary) jest silniejszy niż standardowe badanie zbieżności; dla poprawnego Γ z Dirichletem fizyczne przesunięcie przy paddingu 1→2→4 µm może przekraczać próg 2e-4 — potrzeba rozdzielić błąd granicy fizycznej od błędu FEM.
- **DE-07 (P2)** — dokumentacja statusu (w tym mój poprzedni raport) miesza „kod istnieje" z „fizyka zweryfikowana"; nowszy managed build się powiódł, co unieważnia tezę „nie da się nic policzyć", ale NIE dowodzi C1.
- Historyczna rozbieżność C1 Γ ≈ 8.906582 GHz pozostaje niewyjaśniona na konkretnym artefakcie; „efektywny airbox ~50 nm" to dopasowanie modelu odwrotnego, nie dowód.

## Co dalej

1. **Nie duplikować pracy nad H4/H2/H6/B3-follow-up/mesh-identity (DE-01)** — proces zewnętrzny ma nad tym przewagę (działający build, realne przebiegi) i już to robi lub ma to w planie (`docs/superpowers/plans/2026-09-16-dispersion-de-minimal-validation-plan.md`).
2. Moje 5 poprawek (H5, H9, M16, B1-falowód, plus ten dokument) są odizolowane, samodzielnie zweryfikowane algebraicznie i nie kolidują z niczym aktualnie edytowanym.
3. M1, M6 i reszta M/LOW wciąż czekają na przegląd — bezpieczne do podjęcia później, o ile pliki nie są akurat otwarte przez proces zewnętrzny (sprawdzić `git status`/rozmiar diffa przed edycją).
4. Priorytet realnej weryfikacji: odtworzyć/użyć managed builda (już raz się udało: `895df90a7cc9434b805f0318322c43b4`) i przepuścić pełny `backends/fem/tests/frequency_domain/` oraz benchmark DE z `dispersion-de-minimal-validation-plan.md`.
5. Świadomie zdecydować, co zrobić z 3242 plikami szumu końców linii w drzewie roboczym.

## Korekta statusu po rozpoczęciu pierwszego pakietu DE-01–DE-04 — 2026-09-16

Powyższa tabela opisuje wcześniejszy stan historyczny. W bieżącym worktree
wykonano już źródłowe poprawki czterech punktów: modalny fingerprint mixed-mesh
v3 został ujednolicony między Pythonem i Rustem, montaż źródła Floqueta jest
element-lokalny, adapter SLEPc używa real-frequency-rotated pencil z podpisanym
shiftem, a orchestrator potrafi przyjąć zewnętrzny, hashowany pakiet dowodów
przez scientific-evidence-root i pozostaje fail-closed bez niego.

Lekki zestaw kontrolny obejmujący te ścieżki przechodzi (57 testów). Nie ma
jeszcze nowego managed builda ani przebiegu solvera z tego snapshotu: Docker
Desktop nie odpowiedział na runner-container-status i runner-doctor. Dlatego
DE-01 i DE-03 mają status implementacji źródłowej z runtime NOT VERIFIED,
DE-02 nie ma pomiaru assembly, a DE-04 nie ma pełnego agregatu C0/C1/A1.

## Kontrola po hardeningu pakietu — 2026-09-16

Usunięto jeszcze jeden wariant DE-01: istniejące `sample_solver_diagnostics`
otrzymują modalny fingerprint v3 także wtedy, gdy nie są tworzone od nowa;
fingerprint handoffu v6 pozostaje w osobnym polu
`relax_to_eigen_source_mesh_topology_sha256`. W adapterze DE-03 zarówno
`STSetShift`, jak i `EPSSetTarget` używają podpisanego targetu wynikającego z
konwencji fazowej.

Po tej korekcie wybrany zestaw lekkich kontroli ma wynik **102 passed, 2
deselected** (w tym 44 testy pełnego walidatora naukowego). Fixture’y
syntetycznej zbieżności zostały dostosowane do obowiązującego progu 0,02%; próg
walidacji ani fizyka nie zostały osłabione. Kompilacja i wykonanie managed
pozostają `NOT VERIFIED` do czasu uzyskania poprawnego receiptu i przebiegu.

## Próba managed builda po hardeningu — 2026-09-17

Runner został ponownie udostępniony i przyjął snapshot tego worktree. Job
`eacae28e4cd740259773b4c2b57c3632` profilu `fem-cpu-slepc-modal-v1` zakończył
się błędem kompilacji Rust w `fem/eigen_equilibrium.rs`: pole
`AcceptedFemRelaxStageHandoff.source_mesh_topology_sha256` zostało omyłkowo
wywołane jak metoda. Poprawiono to na odczyt pola.

Retry `0524d64f5e07432387b09a356da5ba89` został przyjęty z nowym digestem
źródeł `eab2c741…`, ale pozostaje w stanie `queued`, ponieważ storage ma tylko
około 0,98 GB wolnego miejsca. Runner wymaga co najmniej 8 GiB i nie wykonuje
automatycznego cleanupu. Docker raportuje 13,54 GB reclaimable image layers,
lecz nie uruchomiono żadnego prune ani usuwania danych. Build, solver i wykres
DE pozostają `NOT VERIFIED`.

## Kontynuacja hardeningu wykonania — 2026-09-17

Dodano drugi, wykonawczy bezpiecznik dla rozdzielenia analityki od solvera
numerycznego. `execute_fem_eigen_path` odrzuca plan, który jednocześnie
deklaruje `dispersion_validation` i syntetyczny solver K0/Kittela, nawet jeżeli
plan został zbudowany bez przejścia przez planner albo odtworzony ze starego
artefaktu. Analityka pozostaje wyłącznie porównaniem postsolve.
Wspólna walidacja referencji Kalinikosa–Slavina odrzuca teraz również
niepoprawne `|k|`, grubość filmu, parametry materiałowe i `gamma`, zamiast
pozwolić na ciche wygenerowanie pustego lub niefizycznego wiersza porównania.

Naprawiono także dwa regresy testów orchestratora benchmarku: test Compose
uwzględnia jawne pliki bazowy/override, a test ścieżki `completed_unqualified`
izoluje etap zapisu dowodu od walidacji statusu. Wybrany zestaw kontroli
Pythonowych zakończył się wynikiem **85 passed, 54 subtests passed**; kontrola
`rustfmt --check` dla zmienionych plików Rust przechodzi. Nie uruchamiano
kompilacji testów jednostkowych ani managed builda; retry runnera nadal czeka
na wolne miejsce. Job `0524d64f5e07432387b09a356da5ba89` został utworzony
przed tym ostatnim hardeningiem, więc po zwolnieniu miejsca trzeba wysłać nowy
snapshot, aby receipt obejmował także bieżące zmiany.

## Kontynuacja kontroli dokumentacji i kontraktów — 2026-09-17

Usunięto sprzeczne opisy w kontraktach `0600`, `0700`, `0710`, `0828` i
`0831`: CPU Floquet/airbox jest source-visible, lecz pozostaje bez managed
runtime i physics qualification. Dokumenty rozróżniają teraz możliwość
próby ściśle określonego CPU modalnego planu od promocji wyniku; driven
response i niepełne kombinacje nadal kończą się capability error bez fallbacku.
Zakres `3e6 rad/m` i `5 GHz` jest opisany jako historyczny preset low-k, a nie
limit modelu; C1 ma jawne `pi/a` i własne okno częstotliwości.

Naprawiono także ścieżkę `scripts/validate_frequency_domain_product_split.py`,
która wskazywała nieistniejący katalog masterplanu po zmianie nazwy na
`old_frequency-domain-fem-masterplan-2026-06-11`. Po korekcie przechodzą:
walidator mapy źródłowej, walidator podziału produktów, 32 testy kontraktu
dokumentacji oraz 79 testów kontraktów/targetów runtime. Nie wykonano
kompilacji jednostkowej ani nowego managed builda; storage runnera ma około
0,74 GB, a bieżący job pozostaje poza dowodem dla aktualnego HEAD.

W ramach dalszej korekty zamknięto M6 na granicy fizycznego bridge'a:
`assemble_floquet_airbox_dynamic_demag_k` odrzuca Schur z niehermitowskim
residualem większym niż `1e-8` względnie do największego wpisu i publikuje
operator error zamiast przekazywać wadliwy blok do modalnego solvera. Niski
oracle algebraiczny zachowuje ogólną diagnostykę dla fixture'ów
manufakturowanych. Dodano źródłowy test kontraktowy; przechodzą 2 testy tej
ścieżki bez kompilacji backendu.

## Kontynuacja kontroli środowiska — 2026-09-17

Nie udało się przejść do managed builda. `runner-container-status` oraz
`runner-doctor` nie otrzymały odpowiedzi od koordynatora Docker Desktop, a
sprawdzony root `C:\git\fullmag\storage` jest na dysku z zerową ilością
wolnego miejsca. Istniejący job `0524d64f5e07432387b09a356da5ba89` nadal ma
stan `queued`; nie anulowano go i nie wykonano cleanupu.

Kontrole, które nie wymagają backendowego buildu, nadal są zielone: 15 testów
adaptera SLEPc/bridge'a/orchestratora oraz wcześniejszy pakiet dokumentacji i
targetów runtime. Fixture pełnej bramki naukowej nie zmieścił danych C1/A1 i
zakończył się `OSError: [Errno 28] No space left on device`; ten wynik oznacza
blokadę środowiska, nie kwalifikację ani błąd fizyczny. Nowy snapshot bieżącego
worktree, C1/DE, zbieżność i wykres nadal wymagają najpierw odzyskania miejsca
i przywrócenia koordynatora.

## Korekta stanu środowiska po kolejnej próbie — 2026-09-17

Wolne miejsce zostało odzyskane: bieżący odczyt kanonicznego dysku to około
18,9 GB. Nieaktualny job `0524d64f5e07432387b09a356da5ba89` anulowano, a próba
wysłania nowego snapshotu `fem-cpu-slepc-modal-v1` zakończyła się HTTP 503 z
API runnera. `runner-container-status` nadal zgłasza błąd żądania do Docker
Desktop, `runner-doctor` timeout `docker info` po 60 s, a uruchomienie
koordynatora nie przywróciło usługi. Nie ma zatem managed receipt'u dla
bieżącego HEAD.

Po stronie źródła przechodzą **128 testów i 54 podtesty**, walidator podziału
produktu, `git diff --check` oraz `rustfmt --check`; nie uruchamiano kompilacji
testów jednostkowych. T4–T7, rzeczywisty solve FEM, punkty dyspersji i wykres
pozostają `NOT VERIFIED` do czasu przywrócenia koordynatora.

## Snapshot przyjęty, blokada Docker Desktop — 2026-09-17

Po wznowieniu koordynatora worker wrócił do `worker_alive=true` i
`accepting_jobs=true`. Bieżący snapshot został przyjęty jako job
`71b182c1f03245a8a6619b033f3d938e` z digestem
`9968a7dcf664f03430ea248aa0fa416291a1a4796a21da6e8ff9f455ea5680a0`, lecz
pozostaje `queued`: kolejne próby wejścia do Docker kończą się
`TimeoutError: timed out` przed utworzeniem lease/kontenera. Health pokazuje
brak aktywnego kontenera, a endpoint overview timeoutuje na metadanych Docker.
Usługa Windows `com.docker.service` jest `Stopped` i nie może być otwarta z
tej sesji. Storage ma około 16,7 GB wolnego. Nie wykonano managed compile ani
receipt'u; T4–T7 oraz wynik dyspersji pozostają `NOT VERIFIED`.
