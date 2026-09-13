# Plan rozszerzenia eigensolve: dyspersja i mody dla niezerowego k

Data: 2026-09-12. Status: **plan przyjęty do realizacji; implementacja W TRAKCIE, kwalifikacja NOT VERIFIED**.

## 1. Cel, baza i granice zadania

Rozszerzyć istniejący produkt `modal_eigen` o wiarygodne częstotliwości i zespolone profile modów $f_n(\mathbf k)$, najpierw w periodycznej komórce FEM 3D, a następnie w translacyjnie niezmiennym falowodzie opisanym przekrojem 2D. Wynik ma przechodzić przez jeden Python DSL, ProblemIR, planner, backend, artefakty, API v2 i istniejący workspace Control Room.

Plan powstał jako osobne zadanie w nowym worktree. Po jego przygotowaniu użytkownik zlecił implementację. Bieżący zakres i dowody realizacji zapisuje [checkpoint implementacji](2026-09-12-eigensolve-dispersion-implementation-status.md).

| Tożsamość | Wartość |
|---|---|
| Zweryfikowany lokalny `master` — baza utworzenia worktree | `5084a94ed14b151fc865e8def5a5c28401e98b44` |
| Branch | `codex/eigensolve-dispersion-plan-20260912` |
| Worktree | `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912` |
| Główny checkout według Git | `C:/git/fullmag/fullmag` |
| Właściciel zadania | `codex:01a0941c-eb15-7261-a7ee-7cf099385525` |
| Rejestr resolvera | `C:/git/fullmag/storage/index/eigensolve-dispersion-plan-20260-c5dfad6d7f548079.json` |
| Źródło bazy | lokalny ref `master`; bez fetch/pull i bez kopiowania dirty zmian głównego checkoutu |

Główny checkout był na `fix/viewport-3d-audit-s18-s19-upload-20260910` i miał 34 wpisy `git status --short`. Nie był źródłem niezacommitowanych zmian planu. Historyczne plany K0 służą jako mapa zależności; status poniżej wynika z odczytu źródeł wskazanego commita, nie z historycznych deklaracji wykonania.

**Ważne rozróżnienie:** mod przy k=0 może być przestrzennie niejednorodny wewnątrz komórki. Niezerowy numer modu, fala stojąca w skończonym obiekcie i niezerowy wektor Blocha nie są tym samym. W skończonym izolowanym magnesie k na ogół nie jest dobrym numerem kwantowym. Widmo FFT odpowiedzi wymuszonej również nie jest bezpośrednim wynikiem eigensolve.

## 2. Co już istnieje i co trzeba uzupełnić

Poniższe pozycje są dowodem obecności kodu/kontraktów. W tym zadaniu nie wykonano ich testów numerycznych ani managed runtime.

| Obszar | Zweryfikowane źródło i symbol | Wniosek do planu |
|---|---|---|
| Publiczne próbkowanie k | `packages/fullmag-py/src/fullmag/model/eigen.py` — `KPoint`, `KPath`, `serialize_k_sampling`, `coerce_k_sampling` | Ponownie wykorzystać istniejące typy; nie wprowadzać równoległego DSL dyspersji. |
| Publiczny workflow | `packages/fullmag-py/src/fullmag/world.py` — `eigenmodes_stage`, `add_eigenmodes`; `model/study.py` — `Eigenmodes` | Zachować etap `study.stages.add_eigenmodes(...)` i round-trip eksportowanego skryptu. |
| Faza i śledzenie | `crates/fullmag-ir/src/eigen_contract.rs` — `PhaseConventionIR`, `KPointIR`, `ModeTrackingIR`; `spectral_validation.rs` — `BlochWavevectorIR` | Obowiązuje `exp_minus_i_k_dot_delta_r`; walidacja k i reprezentacja fazy muszą być wspólne. |
| Rozwijanie ścieżki | `crates/fullmag-runner/src/eigen/path.rs` — `expand_k_sampling` | Uzupełnić istniejący sampler o niezbędne metadane i testy, nie pisać drugiego. |
| Wąska ścieżka CPU Floquet bez demag | `crates/fullmag-runner/src/fem/eigen_policy.rs` — `native_cpu_modal_window_has_bloch_floquet_payload_path` | Istnieje routing/payload dla `Full2x2` i odpowiednich par. Funkcja odrzuca `include_demag`; to nie jest pełny demag-k. |
| Obecny payload CPU | `crates/fullmag-runner/src/fem/eigen_native_window.rs` — `execute_native_cpu_modal_window_from_bloch_floquet_complex` | Materializacja kompleksowego operatora i osadzenie w realnym bloku istnieją; nowa produkcyjna ścieżka ma usunąć zależność dużych problemów od takiej materializacji. |
| Jawne braki modalne | `crates/fullmag-runner/src/fem/eigen_capability.rs` — `native_cpu_modal_window_rejection_reason`; `eigen_path_guards.rs` — `gpu_modal_dispersion_path_unavailable_error` | Zachować odrzucenia do kwalifikacji konkretnej kombinacji k, BC, interakcji i urządzenia. |
| Zalążek zespolonej magnetostatyki | `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.hpp` — `assemble_floquet_bloch_scalar_operator`, `assemble_floquet_bloch_scalar_constraint`, `assemble_floquet_bloch_scalar_tangent_source` | Istnieją elementy skalarnego operatora i źródła. Ich obecność nie dowodzi kompletnego sprzężenia z modalnym LLG. |
| Skalowanie redukcji | ten sam nagłówek — `FloquetBlochScalarReducedOperatorResult` | Wynik redukcji zawiera `mfem::DenseMatrix`; traktować tę realizację jako oracle, nie docelową ścieżkę dużego problemu. |
| Assembly K0 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` — `assemble_native_magnetic_a_qq` | Rozszerzać natywnego właściciela MFEM; nie przenosić assembly do Rust runnera ani bridge. |
| Reprezentacja pencila | `backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp` — `RealFrequencyRotatedPencil`, `assemble_real_frequency_rotated_pencil` | Utrzymać istniejącą konwencję widma i jawny koszt real-split; nie zakładać gotowego kompleksowego PETSc. |
| Śledzenie gałęzi | `crates/fullmag-runner/src/eigen/tracking.rs` — `complex_overlap`, `edge_score`, `track_branches` | Obecny overlap jest euklidesowy. `OverlapHungarian` przechodzi do greedy, a brak wektorów do oceny po częstotliwości. Wymaga rzeczywistego uzupełnienia. |
| Istniejące testy referencyjne | `crates/fullmag-runner/tests/physics_validation.rs` — `fem_eigen_full_2x2_floquet_exchange_dispersion_matches_analytic`, `fem_eigen_path_executes_full_2x2_nonzero_k_floquet_phase_reduction`, `fem_eigen_path_rejects_floquet_dynamic_demag_before_sample_solves` | Wykorzystać istniejące fixtures. Ostatni test wymaga odrzucenia dynamicznego demag Floquet przed próbkami; zmienić go dopiero wraz z realnym operatorem i dowodem jego działania. |
| API i pola | `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs` — `get_spectrum_v2`, `get_mode_v2`, `get_dispersion`, `get_branches_v2`; `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` — `write_mode_bundle` | Rozszerzać istniejących właścicieli wyników, zamiast dodawać równoległe endpointy/formaty. |
| Wyniki | `docs/specs/frequency-domain-artifacts-v2.md` — rodzina `spectrum.v2`, `branches.v2`, `dispersion.csv`, `mode_fields.zarr` | Istnieją tożsamości próbki/modu i kompleksowe pola; rozszerzać aktualny kontrakt, nie wracać do V1. |
| Results — zamierzony kontrakt | `docs/specs/frequency-domain-results-product-projection-v1.md` — sekcja „Źródło prawdy i kolejność rozstrzygania” | Dyspersja ma pozostać podproduktem opublikowanego `modal_eigen`, oddzielonym od `driven_response`; wskazany w tej specyfikacji historyczny plik implementacji nie istnieje już w audytowanej bazie. |
| Bieżąca projekcja Results | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts` — `physicsFirstResultsSnapshotFromResources`, `modalFieldTargets`, `buildPhysicsFirstResultsTree` | To aktualny właściciel do rozszerzenia; dane przychodzą przez resource hooks. |
| Bieżący wykres dyspersji | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` — `buildEigenDispersionChartModel`; `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` — `useFrequencyDomainManifestResource` | Uzupełnić istniejący wykres i wybór sample/mode, nie budować drugiego modułu wykresów. |
| Drift wyjść Python/IR | `packages/fullmag-py/src/fullmag/model/outputs.py` — `SaveMode`, `SaveDispersion`; `crates/fullmag-ir/src/study.rs` — `OutputIR::EigenMode`, `OutputIR::DispersionCurve` | Python ma branches/sample_selector/include_branch_table, natomiast aktywny OutputIR jest uboższy. S02/S07 muszą zachować pełną semantykę selektorów, nie zgubić jej przy lowering. |

Źródła normatywne: `docs/architecture/backend-golden-masterplan.md` §7.1–7.2; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/specs/capability-matrix-v0.md`.

Do uporządkowania w pierwszym etapie dokumentacyjnym:

- Starsza `0600-fem-eigenmodes-linearized-llg.md` opisuje także skalarne/dense MVP. Produkcyjny non-k0 ma korzystać z pełnego stycznego LLG z noty 0831.
- Nota 0828 opisuje głównie `driven_response`; należy dopisać modalne zastosowanie wspólnego operatora bez utożsamiania odpowiedzi wymuszonej z modami własnymi.
- `eigenmode-artifacts-v1.md` wymienia stare endpointy `/v1/live/...`. Implementacja ma bazować na specyfikacji artefaktów v2 i zasobach `/v2/sessions/current/...`.
- Specyfikacja projekcji Results wskazuje nieobecny już plik `frequencyDomainExplorerNodes.ts` i symbole `activeFrequencyDomainProduct`/`publishedFrequencyDomainArtifact`. W S07–S08 trzeba poprawić mapę źródeł i sprawdzić bieżących konsumentów, nie kopiować tej kotwicy jako dowodu stanu UI.
- Twierdzenia o dostępności produkcyjnej w dokumentach mogą mieć inny zakres i datę. S00 ma ustalić jedną aktualną macierz dowodów, zamiast uznać dowolny zielony historyczny raport za kwalifikację.

## 3. Wzorce COMSOL i TetraX oraz rekomendacja

### 3.1 Lokalny podręcznik modułu mikromagnetycznego COMSOL — główna referencja

Zgodnie z doprecyzowaniem użytkownika podstawą porównania COMSOL jest **rzeczywisty moduł mikromagnetyczny opisany w lokalnej dokumentacji**, a nie tylko analogia do Wave Optics. Bezpośrednio odczytano `docs/comsol/Manual_for_Micromagnetics_Module.pdf`: *Micromagnetics Module User’s Guide (V2.13)*, Weichao Yu, data okładki 2025-09-29, 74 strony PDF, SHA-256 `91f8f602d82bdec0a7b6c6947c1919e127c6d4f1a71c69819e328b7d54a06e2d`. Strony PDF 27–28 i 30 sprawdzono również wizualnie, wraz z równaniem fazy i ustawieniami interfejsu.

W repo jest także `docs/plans/active/fd_sovler_masterplan/MicromagneticsModuleUsersGuideV2.13.pdf`, 71 stron PDF, SHA-256 `6c212ed2ee9580f2917118c58ed1caafec18488076a3e7bcb3eb15a64b5e49e1`. Bezpośredni odczyt potwierdził opis LLG/Floquet na PDF 21–28, jednostki na PDF 35 i sprzężenie dynamicznego demagu na PDF 40–43. To inny plik; nie należy traktować nazwy wersji jako dowodu identyczności bajtów. Dla kluczowych rozdziałów poniżej numeracja stron obu kopii jest zgodna; tabelę zakotwiczono w kopii 74-stronicowej.

| Rozdział i strona drukowana (strona PDF) w `docs/comsol/Manual_for_Micromagnetics_Module.pdf` | Odczytana funkcja modułu COMSOL | Zastosowanie w Fullmag |
|---|---|---|
| V.A, s. 16 (21), równania 11–13 | Liniaryzowana LLG z konwencją $e^{+i\omega t}$, stycznością perturbacji i statycznym polem przywracającym | Zachować oba człony precesji: reakcję równowagi na dynamiczne pole oraz perturbacji na pole równowagi. W S03 test ich pominięcia ma zmienić wynik. |
| V.B, s. 17–19 (22–24) | `dmX, dmY, dmZ` są zespolonymi phasorami; użytkownik dostarcza stabilną równowagę | Pełne real/imag XYZ i rekonstrukcja czasowa; accepted equilibrium handoff i jawne normowanie. Nie kopiować amplitudy własnej jako amplitudy pomiaru. |
| V.B.1 i V.D, s. 18, 21 (23, 26) | Rozdzielone pole statyczne i dynamiczne; bez wymuszenia response daje zero, natomiast eigenfrequency szuka modów | `modal_eigen` nie wymaga anteny/drive; RF phasor oraz sweep częstotliwości należą do `driven_response`. |
| V.E.2–3, s. 22–23 (27–28), równanie 20 | Wybór źródłowej/docelowej granicy; faza $e^{-i\mathbf k_F\cdot(\mathbf r_{dst}-\mathbf r_{src})}$; sweep k dla pasm kryształu magnonicznego; zastosowanie 1D/2D/3D | To bezpośredni wzorzec authoringu `KPath`, kierunku par, jednostek rad/m i planowanej dyspersji Blocha. Ograniczenia potencjału demag muszą być zgodne z magnetyzacją. |
| V.F, s. 24–26 (29–31) | Fale stojące filmu z exchange i uniaxial anisotropy; eigenfrequency zwraca częstotliwości zespolone i profile | Dodać benchmark funkcjonalny skończonego filmu. Nie nazywać go samodzielnie testem non-k0; wariant Blocha z Floquet jest odrębnym scenariuszem. |
| V.F, s. 25 (30), zrzut ustawień Study | Liczba szukanych modów, jednostki, wyszukiwanie wokół częstotliwości, wybór rozwiązania do prezentacji | Mapować na istniejące count/nearest/window, wybór próbki i tryb widoku; nie kopiować ARPACK jako obowiązkowego backendu, bo Fullmag ma kontrakt SLEPc. |
| V.G, s. 26–28 (31–33) | Dziedziczenie równowagi tekstury skyrmionowej z time-domain do frequency-domain | W S00/S08 sprawdzić handoff i zgodność siatki/parametrów; nowy k nie oznacza nowej dowolnej równowagi. |
| VI, s. 29–30 (34–35), tabele I/III | Współczynniki modułu są skalowane do pól A/m; k w rad/m; parametry statyczne i dynamiczne są rozdzielone | Zrobić tabelę konwersji parametrów referencyjnego modelu i golden round-trip SI przed porównaniem liczb. |
| VII.A.2, s. 35–38 (40–43), także wizualnie PDF 42 | Równowaga i statyczny demag są wynikiem pierwszego kroku. Drugi interfejs `Magnetic Fields, No Currents` rozwiązuje dynamiczne pole ze źródłem `Ms*dmX/Y/Z`, które wraca do liniaryzowanej LLG | Bezpośredni wzorzec dla pełnego sprzężenia w S04: dynamiczny demag nie jest zamrożonym polem równowagi. W eigenproblemie zerowe jest niezależne wymuszenie RF, nie indukowane pole demagnetyzacyjne. |
| V.B.3, s. 20 (25) | Podręcznik wskazuje nierozstrzygniętą poprawność częstotliwościowych warunków brzegowych DMI | COMSOL nie jest samodzielnym oracle dla DMI na krawędziach; S10 wymaga wyprowadzenia energetycznego i osobnych seam/interface tests Fullmag. |
| V.E.4, s. 23 (28), równanie 21 | Powierzchniowa anizotropia EASA jest osobnym warunkiem brzegowym | W S10 odróżnić boundary anisotropy od bulk anisotropy; porównanie tylko po zgodnej konwersji energii powierzchniowej i linearyzacji BC. |

W szczególności moduł zapisuje współczynnik wymiany w A·m jako $A_{\rm COMSOL}=2A_{\rm ex}/(\mu_0M_s)$, podczas gdy Fullmag authoruje $A_{\rm ex}$ w J/m. Dla jednoosiowej energii $K_u[1-(\mathbf m\cdot\mathbf e)^2]$ analogiczny współczynnik pola to $2K_u/(\mu_0M_s)$ w A/m. Symbole $K_u$ i $\mathbf e$ oznaczają energię anizotropii w J/m³ i bezwymiarową oś. DMI/EASA mapować przez definicję energii i wariację brzegową, z pełnym sprawdzeniem znaku. Dla `gamma` test macrospin ma rozstrzygnąć zgodność konwencji częstotliwości kątowej i cyklicznej; sama etykieta Hz/(A/m) z tabeli nie uzasadnia dopisania czynnika $2\pi$.

Przykład VII.A.2 pokazuje dodatkowo wymuszenie `+1 A/m` i krok `Frequency Domain`; to dowód wzorca sprzężenia/odpowiedzi, nie gotowy bezźródłowy benchmark eigenfrequency. Adaptacja na eigensolve usuwa wyłącznie niezależny drive, zachowując sprzężenie `δm → Ms·δm → φ → h_demag → δm`. Przykład dyspersji magnon-polaronów (w kopii 71-stronicowej PDF 53–55, drukowane 48–50) obejmuje dodatkowe Solid Mechanics; pozostaje osobną fizyką poza bieżącym rozszerzeniem.

Nie przenosić ograniczeń ani luk autorskiego modułu COMSOL jako docelowego kontraktu Fullmag. Czerpiemy z jego układu problemu, workflow i odtwarzalnych przykładów, zachowując własne naukowe kryteria kwalifikacji.

### 3.2 Dodatkowe źródła i wybór realizacji

**COMSOL:** parametr k określa relację fazową między przeciwległymi ścianami komórki, a solve eigenfrequency zwraca częstotliwości oraz profile zgodne z tą relacją. To wzorzec dla periodycznych komórek i ścieżek w strefie Brillouina. Dokumentacja Wave Optics potwierdza sposób organizacji obliczenia; nie dostarcza operatora mikromagnetycznego Fullmag. [Modeling Periodic Structures](https://doc.comsol.com/6.3/doc/com.comsol.help.woptics/woptics_ug_modeling.5.10.html).

Autorski moduł Weichao Yu opisany powyżej jest zbudowany przez Physics Builder. Praca Mruczkiewicza i współautorów dodatkowo opisuje weak-form FEM do dyspersji kryształów magnonicznych. Te źródła uzasadniają porównanie LLG + magnetostatyka + Bloch, lecz nie dowodzą zgodności naszych wyników. [Pochodzenie modułu](https://www.comsol.com/blogs/micromagnetic-simulation-with-comsol-multiphysics), [weak formulations](https://www.comsol.com/paper/download/181859/mruczkiewicz_abstract.pdf).

**TetraX:** propagujące mody falowodu wyznacza się z profilu poprzecznego i operatora zależnego od k. Redukcja wymaga translacyjnej niezmienności geometrii, parametrów i równowagi wzdłuż propagacji. Publikacje opisują także realizację dla warstw i wielowarstw, z odpowiednim dynamicznym operatorem dipolowym. Jest to wzorzec dla oszczędnego wariantu przekrojowego, a nie dowód obsługi dowolnej periodycznej geometrii 3D. [TetraX: Numerical Experiments](https://tetrax.readthedocs.io/en/latest/usage/experiments.html), [publikacja o warstwach](https://arxiv.org/abs/2207.01519).

| Realizacja | Zastosowanie | Reprezentacja | Kolejność |
|---|---|---|---|
| Komórka Blocha FEM 3D | periodyczne otwory/antidoty, modulacje geometrii i materiału, niejednorodna równowaga w komórce | jedna komórka objętościowa; periodyczne pary w domenie magnetycznej i powietrzu | pierwszy pełny produkt CPU |
| Falowód FEM 2.5D | dowolny skończony przekrój, stały wzdłuż osi falowodu | siatka przekroju 2D; analityczna zależność wzdłuż osi | drugi produkt w tym planie |
| Redukcja warstwy do profilu grubości | nieskończone warstwy/wielowarstwy | niezależna redukcja 1D o własnych założeniach | poza pierwszym wdrożeniem; benchmark analityczny nie wymaga tego solvera |

Rekomendacja wynika z obecnego kodu Fullmag: komórka 3D wykorzysta istniejącą siatkę shared-domain, pary periodyczne, certyfikaty topologii i infrastrukturę solvera/gauge. **Nie wykorzysta niezmienionego operatora K0 jako operatora non-k0**: obecny Poisson-airbox wymaga `k0_only` i rzeczywistych bloków; nowy `floquet_airbox` otrzyma własnego natywnego właściciela z §6. Wariant przekrojowy wymaga dodatkowego kontraktu topologii oraz normalizacji na jednostkę długości. Nie wolno uruchamiać go dla zwężeń lub innych zmian geometrii wzdłuż propagacji. Obie realizacje korzystają ze wspólnego produktu modalnego i formatu wyników.

## 4. Kontrakt matematyczny do zamrożenia przed implementacją

Poniższe równania określają proponowane rozszerzenie istniejącej noty 0831. Nie są deklaracją, że cały operator jest już zaimplementowany. W S01 należy umieścić je u kanonicznego właściciela naukowego wraz z pełnym source-map i przykładami publicznymi.

### 4.1 Faza, równowaga i widmo

```{math}
:label: eq-plan-bloch-ansatz
\mathbf m(\mathbf r,t)=\mathbf m_0(\mathbf r)+\operatorname{Re}\left[\widetilde{\mathbf m}_{n\mathbf k}(\mathbf r)e^{\mathrm i\omega_n t}\right],
\qquad \widetilde{\mathbf m}_{n\mathbf k}=\mathbf u_{n\mathbf k}e^{-\mathrm i\mathbf k\cdot\mathbf r},
\qquad \mathbf u_{n\mathbf k}(\mathbf r+\mathbf R)=\mathbf u_{n\mathbf k}(\mathbf r),
\qquad \mathbf m_0\cdot\mathbf u_{n\mathbf k}=0.
```

Równowaga musi być zgodna z okresowością fizyczną i pochodzić z zaakceptowanego handoffu. Zmiana k przy stałym modelu nie zmienia równowagi. Skan pola jest inną osią fizyczną i może wymagać ponownej relaksacji. Nie wprowadzać ukrytego nowego progu akceptacji równowagi.

```{math}
:label: eq-plan-modal-pencil
L(\mathbf k)q=\lambda B_\alpha(\mathbf k)q,\qquad
\lambda=\mathrm i\omega,\qquad \omega=\omega_r+\mathrm i\Gamma,
\qquad f=\frac{\omega_r}{2\pi},\quad \lambda=-\Gamma+\mathrm i\omega_r.
```

Dla pasywnego stabilnego modu $\Gamma\geq0$ przy powyższej konwencji. Nie stosować wartości bezwzględnej do maskowania niestabilności. Dodatnią gałąź, partnerów widma oraz relację k do −k weryfikować na rzeczywistym pencilu; niereciproczność wyklucza ogólne założenie $f_n(\mathbf k)=f_n(-\mathbf k)$.

### 4.2 Dwie równoważne reprezentacje Blocha — stosować jedną

W rekomendowanej realizacji 3D niewiadome są **pełnymi polami Blocha** $\widetilde{\mathbf m}=Tq$ oraz $\widetilde\phi$ w komórce. W operatorach stosuje się **zwykłe pochodne**, a cała zależność Blocha jest w ograniczeniach. Macierze $C_m(\mathbf k)$ i $C_\phi(\mathbf k)$ wiążą odpowiednie pary. Dla magnetyzacji trzeba przenosić również lokalne ramki styczne:

```{math}
:label: eq-plan-bloch-constraints
q_{\rm dst}=e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}
T_{\rm dst}^{\mathsf T}Q T_{\rm src}q_{\rm src},\qquad
\widetilde\phi_{\rm dst}=e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}\widetilde\phi_{\rm src},
\qquad L_{\rm red}=C^\dagger L C,\quad B_{\rm red}=C^\dagger B_\alpha C.
```

$C$ jest blokowym połączeniem ograniczeń magnetyzacji i potencjału; dla translacji $Q=I$. Certyfikat musi sprawdzić wszystkie zadeklarowane pary oraz zamknięcie cykli na krawędziach i narożach, także dla powietrza. Zwykłe równanie surowych współrzędnych stycznych jest poprawne wyłącznie przy zgodnych ramkach.

Alternatywnie można operować na **periodycznej obwiedni**, wprowadzając $D_{\mathbf k}=\nabla-\mathrm i\mathbf k$ w operatorach i zwykłe periodyczne ograniczenia. **Nie stosować jednocześnie przesuniętych pochodnych i fazowych ograniczeń dla tej samej zależności przestrzennej.** Test równoważności tych reprezentacji ma wykrywać podwójne naliczenie k w istniejących helperach skalarnego Floqueta.

### 4.3 Dynamiczna magnetostatyka — wybrana realizacja 3D

Dla pełnych pól Blocha stosować następujący operator razem z fazowymi ograniczeniami z §4.2:

```{math}
:label: eq-plan-demag-k
\nabla^2\widetilde\phi=\nabla\!\cdot\widetilde{\mathbf M},
\qquad \widetilde{\mathbf M}=M_s\widetilde{\mathbf m}_{n\mathbf k},
\qquad \widetilde{\mathbf h}_d=-\nabla\widetilde\phi.
```

W powietrzu $\widetilde{\mathbf M}=0$. Na interfejsach zachować ciągłość potencjału i normalnej składowej $\widetilde{\mathbf h}_d+\widetilde{\mathbf M}$, także przy nieciągłym $M_s$. Słaba postać objętościowa, z funkcją testową spełniającą te same ograniczenia Blocha, jest seskwiliniowa:

```{math}
:label: eq-plan-demag-weak
\int_{\Omega}(\nabla v)^*\!\cdot\nabla\widetilde\phi\,dV
=\int_{\Omega_m}(\nabla v)^*\!\cdot\widetilde{\mathbf M}\,dV.
```

Równanie podaje części objętościowe; jawnie wybrana granica zewnętrzna dodaje właściwy człon brzegowy. Nie przenosić statycznego warunku Robin jako dokładnego warunku otwartego dla każdego k. Dla filmu zachować okresowość boczną oraz kontrolowane przybliżenie otwartej przestrzeni w kierunku normalnym. Weryfikować padding i BC zwłaszcza dla małego $|\mathbf k|$, gdzie pole może zanikać na dużej odległości.

**Wyłącznie do niezależnego testu reprezentacji obwiedni:** po podstawieniu $\widetilde\phi=\phi e^{-i\mathbf k\cdot\mathbf r}$ i $\widetilde{\mathbf M}=\delta\mathbf M e^{-i\mathbf k\cdot\mathbf r}$ otrzymuje się $D_{\mathbf k}\cdot D_{\mathbf k}\phi=D_{\mathbf k}\cdot\delta\mathbf M$, $\delta\mathbf M=M_s\mathbf u$ i $\mathbf h_d=-D_{\mathbf k}\phi$. Ten wariant ma **zwykłe periodyczne ograniczenia**, bez fazowego C(k). Wyniki porównuje się po powyższej transformacji. Istniejącego helpera zawierającego $D_{\mathbf k}$ nie można bezpośrednio dołączyć do wybranego 3D C(k); jego składowe trzeba rozdzielić zgodnie z reprezentacją.

Pełny descriptor sprzęga magnetyczne DOF z potencjałem. Schur eliminuje potencjał tylko z prawidłowym rozwiązaniem jego bloku i rekonstruuje go do pełnego residualu. Przy k=0 gauge zależy od rzeczywistego nullspace: pełna periodyczność/Neumann może wymagać mean-zero, lecz Dirichlet lub odpowiednie otwarte BC nie dostają sztucznego pinu. Dla k równoważnych Γ przez wektor sieci odwrotnej badać tę samą symetrię/gauge. Nie dodawać arbitralnego $\varepsilon I$.

### 4.4 Redukcja falowodu

Dla osi $z$ i translacyjnie niezmiennego przekroju S09 rozwiązuje **profil obwiedni** $\phi$, $\delta\mathbf M$ i $\mathbf h_d$, nie pełne pole Blocha 3D. Zależność osiowa jest reprezentowana analitycznie i nie ma podłużnych par fazowych C(k):

```{math}
:label: eq-plan-waveguide-demag
(\nabla_\perp^2-k^2)\phi=
\nabla_\perp\!\cdot\delta\mathbf M_\perp-\mathrm i k\delta M_z,
\qquad \mathbf h_{d,\perp}=-\nabla_\perp\phi,
\qquad h_{d,z}=\mathrm i k\phi.
```

W S09 powstanie własny provider Fullmag dla tego modelu. Wybór przestrzeni zewnętrznej: najpierw kontrolowany przekrój z powietrzem, a ewentualny wariant boundary-integral inspirowany plane-wave Fredkin–Koehler wymaga osobnej realizacji i kwalifikacji. Istniejący 3D Fredkin–Koehler K0 nie staje się automatycznie operatorem falowodu. Całki/normy mają podstawę na jednostkę długości; nie zastępować tego ukrytą grubością elementu 3D. Dla boundary-integral obsługa funkcji Bessela przy małym k wymaga stabilnego limitu i całkowania osobliwości; nie oceniać osobno rozbieżnych składników rozkładu potencjału jako pola fizycznego. [Pierwotny opis metody propagujących fal w TetraX](https://arxiv.org/abs/2104.06943).

### 4.5 Symbole i jednostki

| Symbol | Znaczenie | SI |
|---|---|---|
| $\mathbf r,\mathbf R,\Delta\mathbf r,z$ | pozycja, translacja sieci, translacja pary, współrzędna osi | $\mathrm m$ |
| $t$ | czas | $\mathrm s$ |
| $n$ | identyfikator gałęzi | $1$ |
| $\mathbf k,k$ | rzeczywisty wektor falowy / składowa osiowa | $\mathrm{rad\,m^{-1}}$ |
| $\mathbf m,\mathbf m_0,\widetilde{\mathbf m},\mathbf u,q$ | magnetyzacja znormalizowana, równowaga, pełny phasor Blocha, profil obwiedni, współczynniki styczne | $1$ |
| $T,Q,C,C_m,C_\phi,I$ | mapy ramek, transformacja wektora, ograniczenia i identyczność | $1$ |
| $\mathrm i,*,\dagger$ | jednostka urojona, sprzężenie, sprzężona transpozycja | $1$ |
| $\omega,\omega_r,\Gamma,\lambda$ | częstotliwość kątowa, część oscylacyjna, zanik, wartość własna | $\mathrm{s^{-1}}$; częstotliwości kątowe raportowane jako $\mathrm{rad\,s^{-1}}$ |
| $f$ | częstotliwość cykliczna | $\mathrm{Hz}$ |
| $\alpha$ | współczynnik Gilberta | $1$ |
| $M_s,\widetilde{\mathbf M},\widetilde{\mathbf h}_d,\delta\mathbf M,\mathbf h_d$ | magnetyzacja nasycenia, pełne phasory magnetyzacji/pola demag, odpowiadające im obwiednie | $\mathrm{A\,m^{-1}}$ |
| $\widetilde\phi,\phi,v$ | pełny potencjał Blocha, obwiednia potencjału, funkcja testowa potencjału | $\mathrm A$ |
| $D_{\mathbf k},\nabla,\nabla_\perp$ | pochodne przestrzenne, przesunięta pochodna | $\mathrm{m^{-1}}$ |
| $\Omega,\Omega_m,dV$ | domena magnetostatyczna, domena magnetyczna, miara objętości | domeny w $\mathbb R^3$; $dV$ w $\mathrm{m^3}$ |
| $L,B_\alpha$ | pencil według noty 0831 | bloki magnetyczne: $\mathrm{m^3\,s^{-1}}$, $\mathrm{m^3}$; bloki mieszane zgodnie z jednostkami potencjału w 0831 |

## 5. Docelowe kontrakty obliczeniowe i produktu

### Algebra i wykonanie

- Produkcyjny operator: pełne dwa stopnie styczne na aktywny magnetyczny węzeł, poprawny exchange i restoring field, dynamiczny demag zgodny z k. Nie używać skalarnego MVP jako ogólnego operatora modów.
- Najpierw FEM CPU/double, bez tłumienia; następnie pozostałe interakcje i tłumienie oraz FEM GPU z własnymi dowodami. Interakcja obecna w równowadze musi mieć zgodną linearyzację albo wywołać jawne odrzucenie.
- CPU: PETSc/SLEPc selected spectrum, sparse/matrix-free, certyfikowany Schur albo pełny descriptor. Dane początkowe Krylov z sąsiedniego k są przyspieszeniem; każdy sample przechodzi niezależną kontrolę residualu i kompletności okna.
- Reuse istniejącego `real_frequency_rotated`: $R(L)y=\omega R(\mathrm iB_\alpha)y$. Zweryfikować realifikację zespolonych bloków Blocha, rekonstrukcję wektorów, wybór fizycznej gałęzi i brak zduplikowanych modów. Biblioteki kompleksowe wymagają jawnej decyzji ABI/profilu, nie cichej podmiany managed stack.
- `count` jest maksymalną liczbą wyników. Osiągnięcie limitu, niepełna konwergencja albo brak certyfikatu przeszukania okna musi być widoczny; nie ogłaszać przerwy pasmowej na podstawie brakujących modów.
- Cache: siatka, materiały, equilibrium digest, ramki, BC/gauge, model demag, rzeczywiste k, precyzja, urządzenie i wersja operatora. Dla stałego modelu reuse geometrii i części niezależnych od k; faktor/preconditioner zależny od k nie jest ponownie używany bez walidacji.
- GPU: wymuszone urządzenie nie spada na CPU. Odrębnie mierzyć operator, Poisson, shifted solve, wektory i Krylov/orthogonalization; sam CUDA apply nie oznacza device-resident eigensolve.

### Python → IR → planner

| Wejście | Decyzja planu |
|---|---|
| `k_sampling`: istniejący wektor, `KPoint`, `KPath` | Podstawowa reprezentacja pozostaje w kartezjańskich rad/m; wymaga skończonych wartości wszystkich składowych. |
| Współrzędne ułamkowe sieci odwrotnej | Opcjonalny, jawny helper authoringu; do IR trafia absolutne k oraz oryginalna baza/wartość. Baza spełnia iloczyn wektorów prostych i odwrotnych równy $2\pi\delta_{ij}$. |
| `samples_per_segment`, labels i `closed` | Zamrozić obecne próbkowanie z testami końców odcinków, powtórzeń Γ i odcinków zerowej długości. Nie ukrywać połączeń przez różne osie fizyczne. |
| `spin_wave_bc`, wybrane pary | K poza periodycznymi kierunkami w 3D jest odrzucane. Niezerowy parametr k bez warunku propagacji/periodyczności nie wystarcza. |
| `include_demag`, model magnetostatyki | Dla non-k0 wymagany zgodny provider demag-k; statyczny K0 ani izolowany airbox nie są fallbackiem. |
| wybór komórki 3D / przekroju 2.5D | Proponowany jawny typ realizacji przestrzennej w specyfikacji; nazwa publicznego parametru zostanie ustalona w S01–S02. Nie dodawać udawanego działającego API do przykładów. |
| okno częstotliwości i count | Zachować istniejący target i jednostki Hz. Ograniczenia obecnego walidatora DE/BV 5 GHz / 3e6 rad/m należą do konkretnego benchmarku, nie do ogólnej fizyki dyspersji. |
| `BiasFieldSweep` i `KPath` | Zachować obecne odrzucenia kombinacji. Skan dwuwymiarowy pole×k jest osobnym rozszerzeniem; nie kodować go jako sztucznych powtórzeń Γ. |
| requested/resolved | Oddzielnie produkt, backend, urządzenie, precyzja, metoda, ograniczenia i powód wyboru. `auto` pozostaje w provenance. |

Publiczne przykłady S02/S08 mają być pełnymi skryptami `# %%`: `fm.study(...)`, jawne silnik/urządzenie, geometria i materiał, interakcje, relaksacja i zaakceptowany handoff, `add_eigenmodes`, eksport. Testować realny Python→IR i eksport UI→Python→IR, nie ręcznie wymyślony JSON.

### Branch tracking i dane

- Porównywać profile w tej samej fizycznej bazie i na wspólnej siatce, najlepiej periodyczne obwiednie po zdjęciu znanej fazy Blocha. Stosować dodatnio określoną metrykę masową na aktywnej domenie magnetycznej; wybór ważenia $M_s$ i normalizacji zamrozić w nocie naukowej. Masa nie jest metryką po całym airboxie ani euklidesową normą zależną od gęstości węzłów.
- Zaimplementować rzeczywisty Hungarian matching oraz progi/diagnostykę pewności. Przy degeneracji śledzić podprzestrzeń przez principal angles/SVD; etykieta pojedynczego wektora wewnątrz zdegenerowanej przestrzeni nie jest fizycznie unikalna.
- Faktycznie respektować `max_branch_gap` i zachować brak dopasowania przez restart; testy nie mogą ograniczać się do pola zapisanego w konfiguracji.
- Dla tłumienia/niehermitowskości zachować lewe/prawe wektory lub jawnie ograniczyć metodę dopasowania; nie używać bez uzasadnienia wzoru overlap przeznaczonego dla samosprzężonego problemu.
- Zapisywać `raw_mode_index` oddzielnie od `branch_id`, tożsamość sample, real/imag częstotliwości, residual, status przeszukania, overlap, confidence, degeneracy cluster i informację o zmianie lokalnej fazy. Nazwy nowych pól są propozycją do wersjonowania w S07.
- Wektory potrzebne do trackingu można przechować wewnętrznie dla sąsiednich próbek bez zapisywania wszystkich pól. Brak wektorów ma dawać jawnie słabe/nieustalone dopasowanie, a nie dowód ciągłości gałęzi z samej częstotliwości.
- Grupowa prędkość to pochodna częstotliwości kątowej po k, z jednostką m/s. Pochodna wzdłuż ścieżki daje tylko składową styczną. Przy narożniku, degeneracji, luce lub niskim confidence zwracać brak wyniku/niepewność.
- Przerwa pasmowa stwierdzona na Γ–X–M–Γ dotyczy tej ścieżki. Pełna przerwa wymaga pokrycia całej odpowiedniej strefy i kontroli kompletności widma.

### Artefakty, API i Control Room

Rozszerzyć `frequency-domain-artifacts-v2.md` oraz istniejące writery. Każda zmiana niezgodnego kształtu otrzymuje nową wersję i adapter odczytu; nie reinterpretować po cichu V2. Manifest zachowuje `study_product=modal_eigen`, `calculation_mode=dispersion_modal` i rzeczywiście opublikowane zasoby.

Wynik obejmuje ścieżkę k, komórkę/bazę, reprezentację pola (obwiednia albo pełne pole Blocha), konwencję fazy, `sample_id`, `mode_id`, źródłową tożsamość siatki, requested/resolved execution, signature operatora, equilibrium digest i referencje artefaktów. Zespolone XYZ trafiają do obecnego binary data plane/Zarr; thin status i WS zawierają rewizje oraz postęp. Publikacja częściowych wyników zachowuje ukończone sample, ale nie udaje kompletnej dyspersji. Wznowienie sprawdza pełną zgodność digestów; przy mismatch tworzy nowy run. S07 ma też sprawdzić politykę writerów: CSV/path i pola wyłącznie dla zamówionych wyjść; selectors `branches`/`sample_selector` nie mogą znikać w uproszczonym OutputIR. ID próbki k nie może być bezrefleksyjnie etykietą `bias-field-sample`.

UI: authoring pojedynczego k lub KPath → wykres f(k) z etykietami punktów i jednostkami → wybór próbki/gałęzi → zespolony profil, amplituda/faza i animacja. Użytkownik widzi błędy, luki i confidence; wykres nie łączy automatycznie braków. Rekonstrukcja superkomórki ma dokładnie raz nakładać $e^{-\mathrm i\mathbf k\cdot\mathbf R}$, zgodnie z zapisanym rodzajem pola. Suwak globalnej fazy nie zmienia fizyki ani zapisanych danych. Pole widoku: równowaga plus przeskalowana perturbacja; amplituda eigenwektora nie oznacza absolutnej amplitudy eksperymentalnej.

Wykorzystać rodzinę `analysis/frequency-domain`, istniejący facade/resource hooks, generowany klient i wspólny viewport. Round-trip `.fms` zachowuje sample/mode, k, topology i phase convention; obowiązują niezależne semantyki visualization/replace/resume. Obsługa widocznego canvasa, WebGL, lifecycle i pamięci wymaga dowodu z przeglądarki w etapie UI.

## 6. Etapy wykonawcze i zależności

Aktualizacja 2026-09-13: S00–S07, S09 i S12 są częściowe; rozszerzenia S08, S10 i S11 pozostają do wykonania. Żaden etap nie jest zamknięty według pełnych kryteriów. Poniższa tabela zachowuje wymagany zakres końcowy; aktualny stan wykonania i podzadania naprawcze R01–R05 opisuje [audyt postępu](2026-09-13-eigensolve-dispersion-progress-audit.md).

### Konkretni nowi właściciele S03–S05 (kontrakty źródłowe; runtime pozostaje do kwalifikacji)

Docelowy zakres właścicieli pod `backends/fem/` (obecność pliku nie oznacza realizacji całego opisu; luka pełnego requestu i skalowania: R04):

- `include/frequency_domain/floquet_modal_problem.hpp` — opis geometrii, materiałów, równowagi, k, obu zbiorów par, reprezentacji pola i BC/gauge; przekazany native problem, nie gotowa macierz numeryczna z Rust.
- `cpu/frequency_domain/operators/floquet_magnetic_operator.hpp` oraz `.cpp` — pełny styczny operator magnetyczny na polach Blocha i fazowa redukcja w natywnym MFEM.
- `cpu/frequency_domain/floquet_airbox_operator.hpp` oraz `.cpp` — bounded MFEM bridge właściciela bloków magnetization→potential, potential→field i potential→potential, dwóch ograniczeń C oraz jawnej rekonstrukcji Schura. Używa zwykłych pochodnych z §4.3; pełna assemblacja siatki i residual produkcyjny pozostają do S04.
- `cpu/frequency_domain/modal/floquet_modal_solver.hpp` oraz `.cpp` — wybrane widmo SLEPc nad powyższym operatorem, real-frequency representation i certyfikat zakresu.

Rozszerzyć istniejący `modal_eigen_request.hpp` oraz wrapper `crates/fullmag-runner/src/native_fem/frequency_domain.rs` wersjonowanym requestem/native handle. Zachować aktualny dense caller-supplied payload wyłącznie jako oracle. Zmiana capability od reject do supported następuje dopiero dla dokładnie zweryfikowanej kombinacji i nie usuwa zbiorczo strażników K0/GPU.

Istniejące wejścia kontraktowe managed: `just verify-fem-modal-floquet-magnetic-contract` dla S03 i `just verify-fem-modal-floquet-airbox-cpu` dla S04–S05. Każde ma wywołać natywny target i weryfikator artefaktów, odnotować source identity, requested/resolved oraz końcowy stan w storage. **Obie recepty istnieją w bieżącym branchu, lecz nie mają kompletnego dowodu wykonania.** R03 audytu wymaga uzupełnienia targetów modal/cross-section, jawnego potwierdzenia CPU oraz scenariusza i weryfikatora artefaktów.

W S03 test krzywizny exchange k² sprawdza uzyskane widmo. Nie upoważnia do ręcznego dodania członu k² do wybranej realizacji pełnych pól 3D, gdzie zależność od k wynika już z C(k). Jawny człon k² należy do oddzielnej reprezentacji obwiedni/przekroju.

| Etap | Zakres i pliki | Weryfikowalny rezultat / zależności |
|---|---|---|
| S00 — baza K0 i rejestr dowodów | obecny masterplan K0, `eigen_capability.rs`, `eigen_equilibrium_contract.rs`, bieżące recepty K0 | Zidentyfikować legalne kombinacje i dowody managed K0. Udokumentować źródła/manifest/ABI, nie przejmować WIP innych worktree. Nauka K0 jest warunkiem porównań granicznych i promocji; prace nad kontraktami mogą trwać równolegle. |
| S01 — nauka i decyzja architektoniczna | noty 0828/0831, capability matrix, backend masterplan; nowy ADR o dwóch realizacjach k; lokalny manual COMSOL §V–VI | Zamrozić fazę, 3D vs 2.5D, weak forms, materiały/interfejsy, gauge, damping, normy i ograniczenia; source-map, mapę COMSOL→Fullmag z §3.1, konwersje SI i recenzję semantyczną. Plan sam nie zastępuje tego etapu. |
| S02 — authoring i legality | `model/eigen.py`, `model/study.py`, `world.py`, `eigen_contract.rs`, `spectral_validation.rs`, `crates/fullmag-plan/src/fem.rs` | Wykonywalny round-trip, walidacja jednostek, wszystkich par, wymiarów i k; negatywne testy NaN/Inf, braków par, forced GPU, niedozwolonych interakcji. Zależy od S01. |
| S03 — magnetyczny Bloch bez demag | nowy `floquet_magnetic_operator` i request `floquet_modal_problem`, ABI/wrapper opisane wyżej, istniejące ograniczenia/ramki | Native sparse/matrix-free exchange+restoring field dla dowolnego legalnego k. Zwykłe pochodne + fazowe C(k); osobny test równoważności z obwiednią, transport ramek i exchange k². Nowa managed bramka S03. To oddzielny przyrost diagnostyczny, nie pełna dyspersja dipolowa. S01–S02. |
| S04 — pełny dynamiczny demag-k CPU | nowy `floquet_airbox_operator`, bezpiecznie rozdzielone składowe `floquet_bloch_scalar.*`, preconditioners i modal Schur | Kompletny magnetization→source→potential→field z poprawnymi BC/interfejsami, kontrolą gauge i k→0. Dense tylko mały oracle; oryginalny residual po rekonstrukcji. Nowy właściciel i managed bramka S04; K0 provider pozostaje oddzielny. S03 i dostępny reference K0. |
| S05 — selected spectrum CPU i przebieg skanu | natywne CPU modal engines, `real_frequency_rotated_pencil.*`, runner `eigen_path*`, `eigen_sweep.rs` | Rzeczywiste okno na każdym k, count cap/completeness, cancellation i resume, stabilny cache, telemetry. Macrospin oraz mały coupled oracle vs SLEPc; brak sztucznych częstotliwości lub default K0. S04. |
| S06 — tożsamość gałęzi | `crates/fullmag-runner/src/eigen/tracking.rs`, `types.rs`, `eigen_contract.rs` | Hungarian zgodny z nazwą, metryka masowa i ramki, degeneracje, brakujące profile, zakręty ścieżki, restart; fixtures z crossing/avoided crossing nie mogą się mylić wskutek zmiany kolejności lub fazy wektorów. Wstępne testy niezależnie od S04, integracja po S05. |
| S07 — artefakty i API | `crates/fullmag-runner/src/eigen/artifacts/`, `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs`, `frequency_domain.rs`, specyfikacje v2 | Stabilne sample/mode/branch, kompleksowe pola, wersjonowanie, digest, partial/resume, route/schema tests i regeneracja OpenAPI. Contract-first równolegle z S03–S05, publikacja po integracji. |
| S08 — użytkowy przepływ dyspersji | istniejące Explorer/Study, facade/hooks/codecs, wykres dyspersji i viewport | Pełny script→run→wykres→wybrany mod→eksport/import FMS, zgodność fazy i topology, stan niedostępności. Browser proof widocznego canvasa, aktywnego WebGL, niezerowego drawing buffer oraz stabilnego Inspectora. S05–S07. |
| S09 — falowód 2.5D | nowi właściciele przekroju i demag-k w `backends/fem`; typed geometry/realization contract z S01, adapter topologii/pól | Przekrój niezmienny wzdłuż osi, modified Helmholtz, wymiana k², źródło −ikMz i pole +ikφ; normy na jednostkę długości. TetraX oraz periodyczna ekstrudowana 3D służą za niezależne porównania. Własna ścieżka zbieżności open boundary/k→0. S04–S08. |
| S10 — pełniejsze interakcje i tłumienie | native interaction owners, linearization, modal request/result, validation | Jawnie kwalifikować bulk/surface anisotropy (w tym EASA) oraz DMI z właściwymi seam/interface terms; następnie Gilbert i zespolone częstotliwości. Testy pochodnych, znaków, asymetrii ±k i tłumienia; ograniczenia COMSOL DMI nie zastępują naszych BC tests. Nie włączać STT/termiki/magnetoelastyki przez przypadek. S04–S06; niezależne przyrosty. |
| S11 — GPU | `backends/fem/gpu/cuda/frequency_domain/`, istniejący modal PETSc/SLEPc adapter, device Poisson | Ten sam kontrakt fizyczny i widmowy co zaakceptowany CPU, najpierw double. Per-k parity, pełny residual, telemetry transferów, własność i lifecycle zasobów, dowód wykonania >1024 DOF. Brak prerequisite odrzuca request; nie zamienia ścieżki. Po CPU science odpowiedniej realizacji. |
| S12 — walidacja, dokumentacja i integracja | nowe scenariusze/verify scripts, `justfile`, source-map, public docs | Macierz benchmarków z §7, manifesty, ograniczenia i przykłady do uruchomienia. Dopiero po autoryzacji implementacji: wymagane tests/review → scoped commits/push → PR/merge → FF master → kontrola integracji i exact-worktree cleanup według governance. |

Pierwszy pełny kamień milowy: **S00–S08 + dipolowo-wymienna dyspersja CPU 3D i jej naukowe porównania**. Następne: S09 (falowód), S10 (interakcje/tłumienie), S11 (GPU), S12 (kwalifikacja całego zadeklarowanego zakresu). Nie uznawać ukończenia S03 ani samego wykresu za ukończenie rozszerzenia.


### Aktualny backlog naprawczy i warunki wznowienia

Audyt bazuje na kodzie `3dda82b4e7310f16bb816b6dcc69f59502bc10de`.
Szczegóły źródeł, kontrprzykładu i akceptacji: [R01–R05](2026-09-13-eigensolve-dispersion-progress-audit.md#ustalenia-i-zadania-naprawcze).

- [x] S02.a: walidacja k/ID i przeniesienie selektorów Python→IR.
- [x] S06.a: Hungarian, luki i metryka FE z testami kontraktów.
- [x] S07.a: sample/raw-mode ID, selekcja pól i rozdział osi k/bias-field.
- [x] S04.a: bounded provider oraz osobna trasa K0/non-k0 — kod zapisany, błąd R01 otwarty.
- [x] S05.a: właściciel Floquet, walidacja payloadu/k/okna i handoff fazy.
- [x] S09.a: bounded provider i elementowy assembler przekroju — prototyp.
- [x] S04.R01a (P1): regresja wielokrotnego pivotowania, naprawa LU solve, Schur oracle; natywny MSVC RED→GREEN.
- [ ] S04.R01b: managed wykonanie tej regresji; recipe nadal blokowane przed kompilacją.
- [x] S04.R02a: próg 1e-8, kontrola pominiętego równania i test niezerowego residualu — izolowany native test passed.
- [ ] S04.R02b: kod propagacji certyfikatu zapisany; managed MFEM i artefakty wymagają wykonania.
- [ ] S04.R02c: ogólna identyfikacja nullspace/gauge poza sprawdzeniem zgodności źródła.
- [x] S05.R02a: owned bloki i helper rekonstrukcji kompleksowego potencjału; izolowany test passed.
- [ ] S05.R02b (P1): integracja wektorów SLEPc real-split, publikacja potencjału, residual magnetyczny i BC oraz managed V9.
- [ ] S12.R03 (P1): naprawa trasy runnera; targety modal/cross-section i dokładny receipt MFEM/SLEPc.
- [ ] S03.R04/S04.R04 (P1): pełny native problem i skalowalny operator demag-k.
- [x] S12.R05a: aktualizacja audytu/statusów bez awansu kwalifikacji.
- [ ] S12.R05b: uzgodnienie rejestru storage z rzeczywistym pełnym SHA.
- [ ] S06.b: podprzestrzenie zdegenerowane, faza obwiedni, crossing/restart.
- [ ] S07.b/S08: API/OpenAPI, realne artefakty i przepływ browser/FMS.
- [ ] S09.b: typed realization/routing i porównanie TetraX/3D.
- [ ] S10/S11: interakcje, damping i rzeczywista trasa GPU.
- [ ] S12.b: wszystkie V0–V10, review, autoryzacja GitHub, PR/merge/FF i cleanup.

Najpierw zamknąć błąd algebraiczny R01, następnie certyfikację R02 oraz
trasę wykonania R03. Dopiero wtedy wyniki non-k0 mogą służyć do oceny
zbieżności lub porównania solverów. Nie uznawać pojedynczych zielonych
kontraktów za zamknięcie etapu.

## 7. Walidacja i warunki promocji

Proponowane progi należy zamrozić w S01 przed oglądaniem wyników. Nie podwyższać tolerancji po porównaniu bez udokumentowanej przyczyny fizycznej/numerical error budget. Błąd modelu analitycznego i błąd dyskretyzacji są odrębne.

| Bramka | Problem i warunki | Oczekiwany dowód |
|---|---|---|
| V0 — algebra/BC | losowe zespolone wektory, corner cycles, niejednorodne ramki, rozłączne obiekty, k=0 i granica strefy | Relative operator equivalence ≤1e−11 na małym double oracle; zgodność pola i energii, brak podwójnej fazy, brak aktywnej magnetyzacji w powietrzu. |
| V1 — exchange-only | jednorodny nasycony model, brak demag/anisotropy/DMI, α=0; k=0 oraz ±k | $f(k)=\gamma_0[H_0+2A_{\rm ex}\lVert\mathbf k\rVert^2/(\mu_0M_s)]/(2\pi)$ dla jednorodnego profilu; właściwa krzywizna, znaki i zbieżność do ≤0,1% na najdrobniejszej siatce. $H_0$ w A/m, $A_{\rm ex}$ w J/m, $\mu_0$ w N/A², $\gamma_0$ w rad·s⁻¹/(A/m). |
| V2 — Γ/K0 | ten sam periodyczny model i zaakceptowana równowaga co kwalifikowany K0 | Zgodność częstotliwości ≤0,1% oraz zgodność podprzestrzeni. Izolowany skończony K0 nie jest referencją dla periodycznego Γ. Oddzielny test granicy k→0 falowodu przy zgodnych BC. |
| V2b — workflow z manuala COMSOL | przykład V.F: stojące fale filmu, exchange + anisotropy, równowaga +z; później V.G: import tekstury | Odtworzyć topologię, BC i wartości po odczycie ustawień/modelu; liczby niewidoczne w manualu jawnie ustalić w fixture. Frequency target, liczba modów, kompleksowy profil i handoff; to test zgodności funkcjonalnej, oddzielny od non-k0 i dynamicznego demag. |
| V3 — film DE/BV | jednolita cienka warstwa, nasycenie w płaszczyźnie; k prostopadłe/równoległe do magnetyzacji | Istniejący `kalinikos_slab_n0` tylko w deklarowanym reżimie low-k i słabej hybrydyzacji; jego tolerance 10% nie jest uniwersalną bramką. Poza reżimem: teoria wielomodowa lub zbieżny solver referencyjny; profile i lokalizacja powierzchniowa, nie sam wykres. |
| V4 — kryształ magnoniczny | zamrożona komórka antidotowa, lattice/mesh/BC/material/field identyczne dla obu solverów; Γ–X–M–Γ | Porównanie eigenfrequency z autorskim modelem COMSOL; export tabeli i kompleksowych modów wraz z parametrami, jednostkami i wersją. Cel ≤1% dla pasm po niezależnej zbieżności; globalny phase alignment przy porównaniu wektorów. |
| V5 — falowód | prostokątny przekrój oraz niejednorodna tekstura przekroju; translacyjna niezmienność | Porównanie TetraX i ekstrudowanego 3D na tych samych danych SI: częstotliwości ≤1%, modal MAC ≥0,98 poza degeneracją; dla degeneracji principal angles. Refinement przekroju i exterior osobno. |
| V6 — crossing/nonreciprocity | crossing i avoided crossing; kolejność/faza/baza wektorów zmieniana w fixture; następnie DMI lub dozwolona tekstura łamiąca symetrię | Brak arbitralnego przestawiania gałęzi; brak wymuszania f(k)=f(−k). Test zmiany znaku D i odwrócenia magnetyzacji zgodnie z symetrią modelu. |
| V7 — damping | macrospin z analitycznym Gilbertem i wybrane mody k≠0 | Znak Γ, konwencja linewidth i pełny zespolony residual; dla izolowanego słabo tłumionego rezonansu FWHM mocy = Γ/π w Hz. TetraX perturbacyjne linewidth nie są dokładnym oracle dla dowolnie silnego damping. |
| V8 — CPU/GPU | ta sama siatka, equilibrium, operator, okno i double; wiele k, co najmniej dwa rozmiary w tym >1024 DOF | Proponowane: frequency relative difference ≤1e−5, MAC ≥0,999 poza degeneracjami, odpowiednie subspace checks. Device identity, residency, transfer counters, zero fallback i brak dense production. |
| V9 — oryginalny residual i convergence | pełny descriptor po rekonstrukcji potencjału, nie tylko przetransformowany pencil | Relative residual ≤1e−8 dla double oraz osobne residuale magnetyczne, potencjału i BC. Normować bloki zgodnie z ich jednostkami; nie sumować surowych A i bezwymiarowych DOF. Co najmniej 3 siatki i 3 paddingi tam, gdzie występuje airbox. |
| V10 — produkt | Python/IR/API/FMS/UI; missing/corrupt/partial, przerwanie i wznowienie, ponowny wybór k | Round-trip bez utraty provenance, stary sample nie pojawia się po zmianie revision, poprawna faza w sąsiednich komórkach, brak przecieku zasobów, browser/WebGL proof. |

Benchmarki nie mogą dostarczać częstotliwości do operatora ani poprawiać wyników solve. Porównanie COMSOL/TetraX wymaga rzeczywistego exportu wyniku i identyfikacji wersji/konfiguracji. W tym zadaniu przeczytano źródła, ale **nie wykonano tych solverów i nie uzyskano ich danych porównawczych**. Brak dostępu do COMSOL nie blokuje własnych testów i pracy CPU, lecz V4 pozostaje NOT VERIFIED.

### Obecne polecenia i nowe bramki

W bieżącym `justfile` istnieją poniższe recepty. Ich nazwa nie dowodzi zakresu ani udanego wykonania; przed użyciem sprawdzić wejście, verifier i oczekiwany lane:

```text
just verify-fem-frequency-domain-real-frequency-rotated
just verify-fem-frequency-domain-floquet-bloch-scalar
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-dispersion-runtime
just verify-fem-frequency-domain-eigen-dispersion-window-runtime
just verify-fem-frequency-domain-eigen-dispersion-de-bv-low-k-runtime
```

Dodać w S12 osobne **nowe, jeszcze nieistniejące** managed recipes/scenariusze dla pełnego non-k0 demag CPU, kryształu Blocha, waveguide 2.5D, CPU/GPU parity, pełnego resume i UI. Nie przemianowywać dotychczasowego reference smoke na production gate. Istniejące recepty zawierają legacy `.fullmag/reports` oraz shellowe operacje sprzątania; preflight, bezpieczny nowy katalog runu i końcowy manifest muszą poprzedzać użycie na Windows/container. Nie uruchamiać destrukcyjnych cleanupów istniejących wyników jako części walidacji.

Dokumentacja naukowa S01/S12 wymaga `validate_scientific_docs.py` dla source-map i testów walidatora, a publikacja dodatkowo public-example guard, Sphinx i kontroli renderu. Dla API: generacja z OpenAPI, typecheck, hygiene i testy scoped resources/codecs. W zakończonym etapie planowania kontrola dotyczyła struktury Markdown, poprawności ścieżek/symboli, spójności matematycznej i zakresu Git. Bieżące dowody implementacji zawiera checkpoint.

## 8. Macierz zakresu i ograniczeń

| Realizacja | Cel tego planu | Obecny dowód tego zadania |
|---|---|---|
| FEM CPU | pełne non-k0 dipolar-exchange w komórce 3D; potem przekrój i kwalifikowane interakcje/damping | source audit; runtime/science **NOT VERIFIED** |
| FEM GPU | osobna realizacja i parity dla jawnie zakwalifikowanych produktów CPU | source audit; execution/residency/science **NOT VERIFIED** |
| FDM CPU | niezależna referencja/porównania na geometrii zbieżnej; bez nowego FDM eigensolvera w tym zakresie | nie kwalifikowano nowej możliwości |
| FDM GPU | pomocnicza referencja time-domain/S(k,f), jeśli zamrożony benchmark jej wymaga; piki nie zastępują eigenmodes | nie kwalifikowano nowej możliwości |

Poza zakresem pierwszego wdrożenia: zespolone k przy zadanej rzeczywistej częstotliwości (odwrotny problem propagacji), nieliniowe fale o skończonej amplitudzie, termika, STT, pełne sprzężenie magnetoelastyczne/Maxwell, automatyczny skan pole×k i fazy topologiczne Berry/Chern. Nie odracza to podstawowych falowodów ani GPU poza plan — mają własne etapy i bramki powyżej.

Największe ryzyka: matematycznie niespójne dynamiczne demag-k, podwójne nakładanie fazy, błędny gauge przy Γ, niezgodna masa/ramki w trackingu, niepełne okno udające band gap i promowanie starych artefaktów do dowodu bieżącego CPU/GPU. Każde ma konkretną bramkę V0–V10.

## 9. Kryterium końcowe i przekazanie

Plan będzie wdrożony dopiero, gdy użytkownik może wykonać zapisany skrypt, otrzymać certyfikowane f(k) i profile dla zadeklarowanego modelu, wybrać mod na wykresie, obejrzeć zgodną rekonstrukcję, wyeksportować/importować wynik i odczytać wszystkie ograniczenia oraz provenance. Odrębny wynik dla każdej realizacji ma wskazywać passed/failed/NOT VERIFIED. Brakująca wymagana bramka nie znika po merge.

Etap planowania zakończył się zachowaniem worktree i rejestrem `review`, bez commita, push i PR. Po zleceniu implementacji rejestr reaktywowano; obowiązuje realizacja S00–S12 i cykl integracji opisany w instrukcjach projektu. Bieżący stan zapisuje checkpoint.

## 10. Dowody zakończonego etapu planowania

- Odczytano bieżące źródła ustalonego commita, odpowiednie instrukcje i obie lokalne kopie manuala COMSOL; istotne równania, ustawienia Eigenfrequency/Floquet i źródło `Ms*dm` sprawdzono także na renderach PDF.
- Kontrola dokumentu: UTF-8, zamknięte bloki Markdown, zgodna liczba kolumn tabel, unikalne etykiety równań, obecność S00–S12 oraz 33 wskazane istniejące ścieżki źródeł — PASS. Pliki proponowanych nowych właścicieli oznaczono oddzielnie jako nieistniejące.
- Niezależny przegląd planu zgłosił trzy uwagi dotyczące jednoznacznej reprezentacji Blocha, zakresu reuse K0 i konkretnych właścicieli natywnych. Wszystkie poprawiono i ich zamknięcie potwierdzono w ponownym przeglądzie; brak pozostawionych blokujących uwag w tym zakresie.
- Nie uruchamiano solverów, buildów ani testów runtime/physics/GPU/browser. Ich status pozostaje **NOT VERIFIED** i jest przedmiotem przyszłych etapów, nie dowodem wynikającym z poprawności Markdown.
