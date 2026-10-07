# Audyt tolerancji solvera dyspersji DE — 2026-09-25

## Wniosek

Nie wykazaliśmy, że `1e-8` jest konieczną ani optymalną tolerancją dla pierwszego wykresu DE. Jest to zadana dokładność algebraiczna konkretnej normy residualu, nie prawo fizyczne ani gwarancja ośmiu cyfr częstotliwości. Nie wykazaliśmy również, że zejście poniżej `2.17e-7` jest niemożliwe w double. Dotychczasowe przebiegi pokazują stagnację obecnej realizacji solvera.

Odrzucenie kandydata przez kod było zgodne z zadanym `solver_rtol=1e-8`. Wcześniejszy wniosek, że nie wolno rozważyć innej tolerancji ani pokazać kandydata na wykresie roboczym, był jednak zbyt kategoryczny. Można jawnie ocenić luźniejszą tolerancję i pokazywać wyniki diagnostyczne z residualem oraz statusem. Nie wolno retrospektywnie zmienić nieudanego przebiegu w zaliczony benchmark ani utożsamić bliskości analityki z walidacją.

Zakres: FEM CPU, double, `floquet_shared_domain_sparse_matshell`, dynamiczny demag, pojedyncze `k=(0,2e6,0) rad/m`. Ten audyt nie kwalifikuje FEM GPU, FDM CPU ani FDM GPU. Nie zmieniono kodu solvera, tolerancji ani konfiguracji runnera i nie uruchomiono nowego buildu. Analiza korzysta z ośmiu zachowanych pilotów #132–#136, bieżącego kodu oraz dokumentacji PETSc/SLEPc.

## Tożsamość i dane

- Worktree: `eigensolve-dispersion-plan-20260912`, branch `codex/eigensolve-dispersion-plan-20260912`, HEAD `4e7ab1528d008ed487c1ed2789f976ba6c8bf3af`; checkout zawiera wcześniejsze niezacommitowane zmiany.
- #136: job `b1e00ef90b494fa08801036bd4d4f17a`, snapshot `c26f2f6f2890cde8955398e91e9d4e50542d31a1d63a152965c67eea4ccf344c`, source digest `1b7ee7adbeb2b83260277eb5285d7f2460b633ff5c7c74440d84d7173704f96b`.
- Powiązania job/run, hashe logów, odczytane wartości i hashe analizowanych źródeł: [evidence JSON](2026-09-25-de-residual-threshold-evidence.json). Zerowe pola kandydata przy zerowej liczbie ocenionych kandydatów oznaczają brak pomiaru, nie zerowy błąd.
- Attestation #136 deklaruje PETSc `3.24.6`, SLEPc `3.24.3`. Są to dane konfiguracji buildu; nie zastępują odczytu wersji załadowanej biblioteki przez jej API. `FindPETSc.cmake` może raportować ścieżkę z `find_library`, podczas gdy target linkuje przez pkg-config; sama rozbieżność ścieżek nie dowodzi pomieszania bibliotek.

| Przebieg | Próg EPS absolutny | Iteracje zewnętrzne na okno | Wynik |
|---|---:|---:|---|
| #132, piloty `8787…`, `ca448…` | `1e-10` | 100 / 500 | Końcowe estymaty EPS `3.4957520e-9`, `6.0189714e-9`; brak zbieżnych par |
| #133, piloty `f45f…`, `f683…` | `1e-8` | 500 / 2000 | Kandydat około 9.723336 GHz; residual magnetyczny `2.1678405e-7`; odrzucony przy `1e-8` |
| #134, piloty `2959…`, `3c7b…` | `1e-11` | 2000 | To samo plateau EPS, brak zbieżnych par |
| #135, pilot `4d5d…` | `1e-11` | 2000 | To samo plateau; nowa telemetria KSP nie mierzy niezależnie prawdziwego residualu |
| #136, pilot `8cbc…` | `1e-11` | 2000 | `nev=8`, `ncv=32`, `mpd=32`; plateau pozostało; zero zbieżnych par |

W #136 liczby iteracji KSP wyniosły 474071 i 416220. Ostatnie raportowane normy KSP to odpowiednio `9.291867865464143e-25` i `5.104141066776643e-24`. Nie są to względne residuale oryginalnego równania. `eps_first_unconverged_error_estimate` opisuje ostatnią obserwację monitora pierwszego niezbieżnego kandydata, nie pomiar z pierwszej iteracji.

Korekta wcześniejszych zapisów: `ca448b26d8934e849c8bb50460e92612` należy do #132, nie #134. `tangent_dof_count=100` na tej ścieżce oznacza 100 zespolonych stopni swobody; rzeczywisty wymiar real-split EPS wynosi 200. Wcześniejszy opis „100 real-split” był błędny.

## Co faktycznie oznaczają progi

Kanoniczne równania i jednostki są w [nocie 0831, sekcja 3.2](../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md#32-residual-and-scaling-contract). W źródle `floquet_magnetic_residual` normuje błąd równania magnetycznego sumą norm trzech działań: magnetycznego, demagnetyzacyjnego i masowego. `floquet_potential_residual` analogicznie normuje równanie potencjału. Te dwie wartości są bezwymiarowe, a normy są euklidesowymi normami wektorów współczynników FEM.

| Wielkość | Znaczenie | Czego nie dowodzi |
|---|---|---|
| `solver_rtol=1e-8` | Dopuszczalny względny defekt oryginalnych zredukowanych bloków dla kandydata | Błędu częstotliwości `1e-8`, zbieżności siatki lub pełnego certyfikatu descriptor/seam |
| EPS `1e-11` | Absolutny residual globalnie przeskalowanego problemu własnego; filtr kandydatów | Automatycznie `1e-8` w normie magnetycznej |
| Shift-invert KSP `rtol=1e-11` | Względne kryterium wybranej normy wewnętrznego solvera liniowego | Prawdziwego względnego residualu bez sprawdzenia rodzaju normy i rekonstrukcji |
| Poisson `PREONLY/LU`, ustawione `rtol` | Metadane tolerancji obiektu KSP; algorytm wykonuje jedno zastosowanie LU | Iteracyjnego dochodzenia do zadanej tolerancji |
| Zgodność FEM–analityka | Łączna różnica dwóch modeli i metod | Izolowanego błędu algebraicznego solvera |

SLEPc ma domyślną tolerancję `1e-8` dla double, ale nasz natywny solver Floqueta ustawia własną politykę (przy braku żądania: `1e-10`), a fixture jawnie żąda `1e-8`. Zbieżność wartości z domyślną tolerancją biblioteki nie jest uzasadnieniem fizycznym. Dla ogólnego problemu niehermitowskiego nie ma prostego uniwersalnego przeliczenia residualu na błąd wartości własnej. Potrzebna jest wrażliwość modu i, dla skupionego widma, kontrola podprzestrzeni. [SLEPc EPS](https://slepc.upv.es/release/documentation/manual/eps.html).

Wspólne skalowanie bloków magnetycznych nie zmienia wartości własnych ani ich oryginalnego względnego residualu, ale zmienia absolutną miarę EPS. W #136 `operator_normalization_scale≈7.953e16` jest mnożnikiem macierzy, **nie liczbą uwarunkowania**. Mianownik residualu zależy od danego modu; jedna stała nie zapewnia przejścia między miarami. Zmiana siatki lub bazy może też zmienić interpretację euklidesowej normy współczynników.

## Ustalenia i problemy do poprawy

| ID | Status | Ustalenie | Działanie |
|---|---|---|---|
| R1 | Potwierdzone | `kFloquetEpsTrueResidualSafetyFactor=1e-3` jest nieskalibrowaną heurystyką. Nie wynika z ograniczenia błędu konkretnego modu. | Rozdzielić w eksperymencie próg pobierania kandydatów od progu akceptacji oryginalnego równania; zapisywać obie miary. |
| R2 | Potwierdzona luka diagnostyczna | `KSPGetResidualNorm` może zwracać normę przybliżoną i preconditioned; brak `KSPGetPCSide`/`KSPGetNormType` i niezależnego `b-Ax`. Komentarz o right preconditioner nie jest poparty jawnym wyborem strony. | Rejestrować rzeczywisty typ normy/stronę, normę RHS i niezależny względny residual każdego solve'a lub jego maksimum wraz z identyfikatorem. |
| R3 | Potwierdzona semantyka | `PREONLY/LU` nie stosuje tolerancji iteracyjnych. Mały residual Poissona jest kontrolą błędu równania, nie bezwarunkową granicą błędu potencjału lub feedbacku demag. | Zmierzyć residual i uwarunkowanie/scalowanie Poissona oraz stabilność magnetycznego feedbacku. |
| R4 | Potwierdzone przekształcenie, wpływ niezmierzony | Kandydat z dopuszczoną małą częścią urojoną obróconej wartości własnej jest oceniany po ustawieniu `lambda_real=0`. Mapowanie pełnej wartości wymagałoby również tej pominiętej składowej. | Zapisać pełną wartość własną oraz residual przed i po projekcji na rzeczywistą częstotliwość; oddzielnie sprawdzić oczekiwaną konserwatywność. |
| R5 | Hipoteza do pomiaru | Rekonstrukcja `q=x1+i*x2` może być źle uwarunkowana dla zespolonego wektora real-split. Kod bada tylko absolutną normę `q>epsilon`. | Zmierzyć normę projekcji względem wejścia i zgodność działania operatora. Nie zakładać, że to przyczyna #133 bez zapisanych wektorów. |
| R6 | Potwierdzony brak kalibracji | Zwiększenie 100→500→2000 iteracji i próba `ncv=32` nie usunęły plateau. | Zmienić eksperyment na porównanie tego samego złożonego operatora z bezpośrednią referencją małego problemu, zamiast kolejnego powtórzenia. |
| R7 | Potwierdzone błędy opisu | Pomylono identyfikator pilota #132/#134, wymiar complex/real-split oraz kolejność ostatnich norm KSP #136. Zbyt mocno zinterpretowano dodatni reason KSP. | Skorygować plan i notę; zachować surowe dowody i brakujące pomiary jako brakujące. |

PETSc potwierdza ograniczenia [`KSPGetResidualNorm`](https://petsc.org/release/manualpages/KSP/KSPGetResidualNorm/) oraz brak zastosowania tolerancji iteracyjnych w [`KSPPREONLY`](https://petsc.org/release/manualpages/KSP/KSPPREONLY/). W [źródle GMRES v3.24.6](https://github.com/petsc/petsc/blob/v3.24.6/src/ksp/ksp/impls/gmres/gmres.c) najwyższy priorytet domyślny ma lewa preconditionowana norma. Brak jawnego ustawienia w Fullmagu wymaga sprawdzenia resolved state, nie założenia right. Zmiana na right może być eksperymentem, ale sama nie gwarantuje naprawy.

W #133 stosunek magnetycznego residualu do absolutnego EPS dla zapisanego kandydata wynosił `62.013567…`, nie 1000. Nie jest to uniwersalny przelicznik. Co więcej, samo cofnięcie mnożnika `1e-3` nie wyjaśnia całej stagnacji: #132 zatrzymywał się również przy EPS `1e-10`.

Proste ustawienie publicznego `solver_rtol=1e-6` nie jest czystym eksperymentem: obecny kod równocześnie zmieni EPS na `1e-9` i KSP na `1e-9`. EPS `1e-9` nadal leży poniżej zaobserwowanego plateau około `3.5e-9`. Te trzy ustawienia trzeba rozdzielić w diagnostyce.

## Dokładność fizyczna i analityka

Parametry rzeczywistego fixture'u: film 10 nm, komórka 40×40 nm, powietrze po 2 µm z obu stron, `Ms=800 kA/m`, `A=13 pJ/m`, `gamma0=221100 m/(A s)`, indukcja zewnętrzna 0.1 T, równowaga wzdłuż x, fala wzdłuż y, periodyczność x/y, warunek Dirichleta na zewnętrznej granicy potencjału. Modalny operator zawiera dynamiczny demag; `demag_mode=none` w relaksacji nie wyłącza tego operatora. Zasadność jednorodnej równowagi należy weryfikować oddzielnie, w tym zgodność ramek na szwach.

| Wielkość przy `ky=2e6 rad/m` | Wartość |
|---|---:|
| Kandydat FEM #133, niezaakceptowany | 9.723336272685 GHz |
| Referencja repozytorium: otwarty film, Kalinikos–Slavin `n=0` | 9.725724283841 GHz |
| FEM minus referencja | −2.388011 MHz, czyli −0.0245536% |
| Oryginalny residual magnetyczny tego kandydata | `2.1678405357802513e-7` |
| Oryginalny residual potencjału tego samego kandydata | `1.2442441494581795e-14` |

Maksymalny residual potencjału wśród ocenionych kandydatów wynosił około `1.4175e-14`; nie należy przedstawiać go jako sparowanej wartości dla najgorszego residualu magnetycznego.

Referencja `kalinikos_slab_n0_frequency_hz` używa `P00=1-(1-exp(-|k|t))/(|k|t)` i jednorodnego profilu przez grubość. Pomija sprzężenie modów grubościowych i ma otwartą przestrzeń na zewnątrz filmu. Te założenia trzeba oddzielić od błędu FEM. Literatura omawia zakres diagonalnego przybliżenia i jego różnice względem pełnego problemu brzegowego: [Harms i Duine, 2022](https://arxiv.org/abs/2109.10597). Nie wolno wybierać innego wzoru tylko dlatego, że daje bliższą liczbę.

Wpływ skończonego airboxu jest szczególnie widoczny w Gamma: referencja otwarta to 9.309814 GHz, a jednorodny model z granicą Dirichleta w odległości 2 µm daje 9.299250 GHz. Tej różnicy nie przenosi się na niezerowe k. Potrzebna jest kontrola wielkości airboxu dla każdego badanego zakresu k.

Należy rozdzielić błędy: rozwiązania dyskretnego równania, dyskretyzacji siatki, obcięcia domeny powietrznej, równowagi i przybliżenia analitycznego. Ustawienie statycznego demagu `rtol=1e-7`, tolerancja relaksacji i rozmiar elementu nie ustanawiają automatycznie dolnej granicy algebraicznego residualu ustalonego problemu własnego. Mogą wpływać na fizyczne wejście lub wynik, ale jest to inny rodzaj błędu.

## Czy `1e-8` może być nieosiągalne?

Dla konkretnej źle uwarunkowanej realizacji i normy — tak. Błąd operatora, niedokładny shift-invert, uwarunkowanie Poissona, utrata ortogonalności albo rekonstrukcja mogą ustanowić praktyczną granicę. Sam fakt użycia double jej nie dowodzi: epsilon double wynosi około `2.22e-16`. Nie wolno obliczać granicy błędu przez utożsamienie skali macierzy `7.95e16` z jej uwarunkowaniem.

Powtarzalność częstotliwości po zwiększeniu liczby iteracji jest użyteczną obserwacją, ale ten sam stagnujący algorytm może powtarzać ten sam obciążony wynik. Dlatego potrzebny jest niezależny sposób rozwiązania **tego samego problemu dyskretnego**, a dopiero potem kalibracja progu.

## Zmieniony plan najbliższych działań

| Krok | Konkretna czynność | Warunek rozstrzygnięcia | Stan |
|---|---|---|---|
| C1 | Dodać true residual KSP, stronę/normę, normy bloków, pełną wartość własną i stabilność projekcji; zapisać odrzucone wektory jako diagnostykę | Pomiar wskazuje, na którym etapie pojawia się defekt; brak pomiaru nie jest zerem | Do wykonania |
| C2 | Dla tego samego małego modelu utworzyć jawny oryginalny operator Schura i `B`; porównać działanie z MatShell, rozwiązać bezpośrednio mały problem uogólniony | Częstotliwość, oba oryginalne residuale i profile porównane z iteracyjnym wynikiem; wyłącznie jawna referencja diagnostyczna | Do wykonania |
| C3 | Przeprowadzić niezależny sweep progów oryginalnego residualu `1e-6`, `1e-7`, `1e-8`; utrzymać kontrolowaną dokładność wewnętrznych solve'ów i jawny filtr EPS | Tabela `próg → f → residual → różnica względem C2 → koszt`; wynik kalibracji, nie wybór pod analitykę | Do wykonania |
| C4 | Po wyborze tolerancji policzyć 3–5 k i zestawić z `n=0`; zachować oddzielny status diagnostyczny/zaakceptowany | Rzeczywiste wektory, residuale, tożsamość modelu i oznaczenia jakości dla każdego punktu | Do wykonania |
| C5 | Sprawdzić zagęszczenie siatki i airboxu, profile oraz kompletność modów | Osobny budżet błędu przestrzennego i modelowego; dopiero to uzasadnia twierdzenie o poprawnej dyspersji | Do wykonania |

### Aktualizacja wdrożenia C1 — 2026-09-25

W worktree dodano pomiar rzeczywistego `b−Ax` ostatniego solve'a KSP oraz
resolved stronę preconditioningu i rodzaj normy PETSc. Dla ocenionego kandydata
zapisują się również residual magnetyczny dla pełnej zespolonej wartości
własnej, pominięta przy projekcji część urojona oraz stosunek normy
zrekonstruowanego modu do normy wektora real-split. Wartości niedostępne mają
znacznik dostępności lub `null`; nie są przedstawiane jako zero. To częściowe
zamknięcie C1: pomiar dotyczy tylko **ostatniego** solve'a, brak jeszcze
rozkładu/maksimum dla wszystkich działań shift-invert, norm poszczególnych
bloków i zapisu odrzuconych wektorów. Kod czeka na managed build i uruchomienie
pilota, więc nie ma jeszcze nowego dowodu liczbowego.

Przy sprawdzeniu kolejki koordynator był zdrowy i bez aktywnych jobów, ale
`allowed_profiles` nie zawierał `fem-cpu-slepc-runtime-v1`. Profil
`fem-cpu-slepc-modal-v1` kompiluje testy kontraktowe, czego tymczasowy zakaz
projektu nie dopuszcza. Nie wolno zastępować go tą trasą. Następny build
runtime wymaga wdrożenia/konfiguracji dozwolonego profilu na współdzielonym
koordynatorze, z zachowaniem bieżącej kolejki i obrazu.

W C2 nie wystarczy podmienić nazwy solvera na `EPSLAPACK` przy zachowanym shift-invert: referencja musi ominąć badaną inwersję przesuniętego układu. Trzeba materializować oryginalne bloki z demagiem, nie macierz już przetransformowaną przez ten sam KSP. To kontrola małego problemu, bez zmiany produkcyjnej ścieżki na ukryty dense fallback. [SLEPc EPSLAPACK](https://slepc.upv.es/release/manualpages/EPS/EPSLAPACK.html).

Implementacja C2 powinna być prywatną, jawną diagnostyką ograniczoną np. do
`2*q_complex_dof_count <= 512`. Dla pilota #136 oznacza to macierz 200×200.
Z tych samych pięciu CSR budujemy kolumnami `S=Aqq−Aqphi P⁻¹ Aphiq`: każdy
wektor bazowy daje jedno rozwiązanie Poissona przez osobny `PREONLY/LU` bez
factorization shift, a potencjału **nie** zagęszczamy. Obrót `−i·phase_sign`
i wspólne skalowanie stosujemy identycznie jak w solverze, po czym rozwiązujemy
oryginalny uogólniony problem `(S_rot,Bqq)` przez `EPSLAPACK`, `EPS_GNHEP`
oraz `STSHIFT` z zerowym przesunięciem, bez `STSINVERT` i bez KSP przesuniętego układu. Przed
porównaniem częstotliwości sprawdzamy działanie jawnej macierzy i MatShell
na deterministycznych wektorach. Dla pary własnej zapisujemy pełne i
projektowane `lambda`, oba residuale magnetyczne, residual potencjału oraz
profil modu. Nie wolno zagęszczać pełnego bloku z zerową masą potencjału:
dałby osobliwy problem z nieskończonymi wartościami własnymi. Oracle ma
pozostać diagnostyką i nie może automatycznie zastąpić solvera produkcyjnego.

Aktualizacja: tę diagnostykę dodano źródłowo za przełącznikiem
`FULLMAG_FLOQUET_DENSE_ORACLE=1`, ograniczono do 512 real-split DOF i
zserializowano oddzielnie od wyniku produkcyjnego. Porównanie z MatShell
obejmuje osiem deterministycznych sond; przed raportowaniem moda filtruje się
rekonstrukcje o zaniedbywalnej normie fizycznej względem wektora real-split.
Zmian C2 **nie ma** w snapshotcie joba #137, który służy tylko do C1. C2
czeka na odrębny managed build i pilota z jawnym opt-in; jego poprawność
numeryczna i możliwość uruchomienia `EPSLAPACK` pozostają `NOT VERIFIED`.

Propozycja roboczego budżetu dla pierwszego wykresu: rozdzielczość fizycznej oceny 1 MHz w okolicy 10 GHz, z wkładem algebraicznym najwyżej 0.1 MHz, sprawdzanym względem C2 i zmian ustawień. To propozycja metody oceny, nie osiągnięty wynik ani automatyczne przełożenie residualu na Hz. Jeżeli `1e-6` wystarczy z takim zapasem i daje poprawny profil, jego jawne użycie w pilocie może być uzasadnione. Jeżeli nie — należy poprawić solver, zamiast dopasowywać próg do otrzymanej liczby.

W C3 można rozpocząć pobieranie kandydatów przy EPS `1e-8`, pozostawiając dotychczasowy shift-invert `rtol=1e-11` i kontrolując jego rzeczywisty residual. Kontrole potencjału, fazy Floqueta, energii i tożsamości operatora zachowują własne kryteria; nie luzuje się ich zbiorczo. Obowiązujący publiczny kontrakt oraz historyczne statusy pozostają bez zmian do jawnej, zweryfikowanej decyzji.

## Mapa sprawdzonych źródeł

| Ścieżka + symbol | Zakres dowodu |
|---|---|
| `examples/fem_de_smoke_numeric.py` + `EIGEN_SOLVER_RTOL`, `study.stages.add_eigenmodes` | Jawne żądanie `1e-8` i parametry benchmarku |
| `packages/fullmag-py/src/fullmag/world.py` + `_fem_eigen_solver_policy` | Python `solver_rtol` → polityka `residual_tolerance` |
| `crates/fullmag-runner/src/fem/eigen_policy.rs` + `native_modal_solver_policy` | Przeniesienie żądania do granicy native |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `floquet_magnetic_residual`, `floquet_potential_residual`, `physical_complex_vector_from_split` | Normowanie i rekonstrukcja |
| Ten sam plik + `solve_floquet_shared_domain_sparse_modal_spectrum`, `normalize_native_floquet_pencil` | EPS, KSP, sprzężenie progów, akceptacja, globalna skala |
| `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` + `sparse_modal_tangent_dof_count` | Semantyka liczby zespolonych DOF |
| `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `kalinikos_slab_n0_frequency_hz` | Faktyczny wzór analityczny użyty w porównaniu |
| `scripts/compare_de_100nm_pilot.py` + `reference`, `finite_airbox_gamma_hz`, `load_comparison_input` | Odczyt parametrów i rozróżnienie 10/100 nm oraz otwartego/skończonego airboxu |

Weryfikacja tej analizy obejmuje ponowny odczyt ośmiu logów, przeliczenie referencji istniejącą funkcją, kontrolę JSON i źródłowej dokumentacji. Nie zastępuje C1–C5 ani nowych obliczeń solvera. Stan nadal: zero punktów zaakceptowanych przy żądanym `1e-8`; istnieje rzeczywiście obliczony kandydat #133, którego użyteczność dla konkretnej dokładności częstotliwości pozostaje do zmierzenia.

Kontrola zmienionej noty 0831 przez `validate_scientific_docs.py` przeszła, podobnie jak parsowanie JSON i lokalne linki audytu. W istniejącym zestawie `test_frequency_domain_math_contract_docs.py` wynik wyniósł **9 passed, 1 failed**. Niepowodzenie `test_modal_dispersion_artifact_contract_names_tracking_and_mode_handoff` dotyczy starszego oczekiwanego nagłówka CSV: wcześniejsze zmiany `frequency-domain-artifacts-v2.md` dodały `sample_id`, `mode_id` i `mode_field_available`, a test nadal oczekuje starej listy. Specyfikacji artefaktów i tego testu nie zmieniano w tej analizie. Rozbieżność należy naprawić wraz z zakończeniem wcześniejszego zakresu eksportu artefaktów; nie jest dowodem błędu wzoru residualu. Nie kompilowano testów natywnych.

Aktualizacja wdrożenia: oczekiwanie testu dokumentacyjnego dopasowano do
obowiązującego nagłówka CSV z `sample_id`, `mode_id` i
`mode_field_available`; ponowny wynik to **10 passed**. Testów natywnych
nadal nie kompilowano.

## Aktualizacja runtime 2026-09-25: awaria pomiaru C1

Managed build #137 (`454a9276184546ec8b64e4dabd681727`) zakończył się
`succeeded`, exit 0. Pilot `de-smoke-k2` z tego dokładnego artefaktu
(`7327c19e1f4b422fa7ad59eb840c9585`) zakończył się PETSc `SIGSEGV`, kod 59,
zanim powstał wynik modu. Skrócona do jednej iteracji EPS kopia modelu,
uruchomiona **wyłącznie diagnostycznie** pod Valgrind, odtworzyła awarię:
nieprawidłowy odczyt następuje w `MatMult_SeqAIJ_Inode` wywołanym przez nowy
pomiar true residualu po `EPSSolve`. Przyczyną w tym pomiarze jest użycie
pożyczonej pary wektorów RHS/solution KSP poza czasem ich ważności. Nie jest
to wynik fizyczny ani podstawa do zmiany progu `1e-8`.

Kod C1 zapisuje teraz własne kopie ostatniej pary RHS/solution w
`KSPSetPostSolve` i dopiero z tych kopii oblicza residual. Job #138
(`289819783c8e4a2bb39920a9a7cedf25`) został zablokowany przed kontenerem,
ponieważ równolegle działał diagnostyczny kontener Valgrind; nie dostarczył
artefaktów ani wyniku C2. Po zakończeniu tego kontenera zgłoszono job #139
(`4c768fc34f814983b811c45e28dc7550`) ze snapshotem zawierającym poprawkę
C1 i diagnostykę C2. Stan przy tym wpisie: `running`, bez dowodu runtime dla
obu poprawek. C1, C2 i dyspersja pozostają **NOT VERIFIED**.

Valgrind osobno wskazał zapisy o 8 bajtów poza obiektem podczas konstrukcji
`mfem::SparseMatrix` w inicjalizacji Poissona, jeszcze przed eigensolve.
Każdy pokazany przypadek dotyczy obiektu alokowanego na 144 bajty; konstruktor
z `/opt/fullmag-deps/lib/libmfem.so.4.9.0` zapisuje pod offsetem 144.
Niezależne skompilowanie samego `sizeof(mfem::SparseMatrix)` z nagłówków obrazu
potwierdziło 144 bajty. W kompilacji klienta `MFEM_USE_CUDA` i
`MFEM_USE_MEMALLOC` są zdefiniowane, lecz `MFEM_USE_CUDA_OR_HIP` nie jest;
ten ostatni warunkuje pola klasy w `sparsemat.hpp`. To mocna przesłanka
niezgodności ABI między konstruktorami biblioteki a kodem klienta, wymagająca
potwierdzenia w konfiguracji budowy MFEM i naprawy obrazu lub linkowania.
Kontrola preprocessora pokazała, że zwykły `g++` nie definiuje
`MFEM_USE_CUDA_OR_HIP`, podczas gdy kompilacja `nvcc` widzi inny układ klasy
(`sizeof(SparseMatrix) != 144`). Obraz buduje MFEM z CUDA, a klient Fullmag
jest kompilowany `g++`; to wskazuje konkretny mechanizm mieszania dwóch
układów ABI, nie tylko ogólną hipotezę o uszkodzeniu pamięci. Próba kompilacji
minimalnego pliku `nvcc` miała też inne błędy nagłówków MFEM, więc nie jest
pełnym dowodem dokładnego rozmiaru obiektu w bibliotece.
Ślad crasha C1 wskazuje jednak bezpośrednio na nieprawidłowy odczyt w pomiarze
residualu; obu problemów nie należy utożsamiać bez dalszego testu.

Build #139 zakończył się błędem kompilacji C2: `STNONE` nie jest zdefiniowane
w używanym SLEPc 3.24.3. Oracle zmieniono na `STSHIFT` z zerowym przesunięciem,
z kontrolą resolved typu i wartości po `EPSSolve`. Jest to wariant bez
shift-invert według dokumentacji SLEPc; kompilacja i wynik tej poprawki
pozostają do ponownej weryfikacji. #139 nie dostarczył binarium ani punktu
dyspersji.

### Aktualizacja po buildzie #140

Job #140 `3243430c4f5341fab4a138d92703b4b7` doszedł do kompilacji FEM,
lecz zakończył się `failed`, exit 2: `production_cpu_modal_eigen.cpp:152`
próbował dodać dwa literały C++ przy tworzeniu pola JSON oracle. Zmieniono
początek wyrażenia na `std::string`. Nie powstało binarium #140, zatem nie ma
ani pomiaru C1, ani danych C2 z tego joba. Po przeglądzie callbacku C1 dodano
też własną referencję PETSc do ostatniej macierzy `Mat`, aby przetrwała do
pomiaru residualu po `EPSSolve`. Job #141
`13d5788e1fab4cfdb3d13d13843eb611`, source digest
`cc9d56011e6b81128f8ff98a84961c672adc12c363f55e54352bd5eadb069258`,
zawiera te zmiany; wynik builda i pilot są nadal otwarte.

Dla osobnej bramki ABI przygotowano profil `fem-cpu-slepc-runtime-v2`: MFEM CPU
bez CUDA w odrębnym prefiksie obrazu, natywny build bez CUDA oraz attestację
ścieżki pakietu CMake i rzeczywistego `libmfem.so` z tego prefiksu. Testy
skryptów przeszły, ale obrazu v2 i managed receiptu jeszcze nie ma. Pilot v2
wymaga przypięcia obrazu w katalogu operatora runnera. Dopiero potem należy
powtórzyć Valgrind, C0 i $k_2$, porównać oracle oraz skalibrować EPS/KSP przy
niezmienionym fizycznym progu. Żaden z tych kroków nie kwalifikuje dziś
dyspersji.
