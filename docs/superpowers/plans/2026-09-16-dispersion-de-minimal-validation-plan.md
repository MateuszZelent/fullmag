# Plan dojścia do pierwszej zweryfikowanej dyspersji DE — 2026-09-16

Punkt wyjścia: [audyt aktualnego kodu i dowodów](../../audits/2026-09-16-dispersion-de-readiness-audit.md). Zakres tego dokumentu to plan, nie deklaracja wykonanej naprawy. Priorytetem jest pięć wiarygodnych punktów podstawowego modu z wymianą i demagiem. Pełny C1 i porównanie COMSOL są następnymi etapami, a nie warunkiem uzyskania pierwszego wykresu.

## Zamrożona konfiguracja DE-SMOKE

Osobny przypadek jednorodnego filmu, bez otworów, DMI, anizotropii i tłumienia w eigensolve. Nie zastępuje kanonicznego C1.

| Wielkość | Wartość |
|---|---|
| Materiał | Py, Ms=800000 A/m, A=13e-12 J/m |
| Gamma0 | 2.211e5 m/(A s), konsekwentnie dla H w A/m |
| Pole | B_ext=0.1 T wzdłuż +x; H_ext=B_ext/mu0 |
| Stan równowagi | m0=(1,0,0), potwierdzony torque i handoff |
| Grubość | t=10 nm |
| Komórka | 40 × 40 nm w xy, film wyśrodkowany w z |
| Periodyczność | x i y, zgodne siatki i pary na przeciwległych ścianach |
| Wektor falowy | k=(0,ky,0), jednostka rad/m; DE: k prostopadłe do M0 |
| Pierwsze punkty | ky=0, 1e6, 2e6, 3e6, 5e6 rad/m |
| Potencjał | Pełne pole Blocha; zwykły gradient; faza exp(-i k·R) zgodna z kontraktem |
| Airbox | Początkowo 2 µm powietrza z każdej strony filmu; domena z=4010 nm |
| Warunek zewnętrzny | phi=0 na górze i dole; szwy xy periodyczne, nie Dirichlet |
| Wykonanie | FEM CPU, double, natywny operator i SLEPc, bez syntetycznego źródła częstotliwości |
| Początkowe okno | 8.5–12 GHz, 2–4 żądane mody; dobór gałęzi przez pole i overlap |

Mniejsza komórka jest dopuszczalna dla jednorodnego nieskończonego filmu i wybranej gałęzi. Zmienia złożenie wyższych pasm, dlatego wynik nie jest pełnym widmem komórki C1 200×200 nm. Nie kopiować tej zamiany do antidotu.

Siatka: jawna geometria manualna, początkowo około 10 nm w xy oraz co najmniej trzy rozdzielone warstwy po grubości. To wymaganie osiągniętej siatki, nie deklaracja istniejącego parametru API. Zapisać rzeczywiste współrzędne, jakość elementów, liczby DOF i nnz. Powietrze stopniować, ale sprawdzić wpływ wąskiej komórki na jakość tetraedrów; przerwać przed solve, jeżeli generator tworzy nieproporcjonalnie dużą domenę obliczeniową.

## Analityka i oczekiwany rząd wielkości

Dla otwartego jednorodnego filmu, diagonalnego przybliżenia n=0:

- x=|k|t, P=1-(1-exp(-x))/x; P(0)=0. Obliczać stabilnie przez expm1 lub rozwinięcie dla małego x.
- H_ex=2 A k²/(mu0 Ms), jednostka A/m.
- f_DE=gamma0/(2 pi) sqrt[(H_ext+H_ex+Ms(1-P)) (H_ext+H_ex+Ms P)].
- Kontrola bez demagu: f=gamma0(H_ext+H_ex)/(2 pi).

| ky [rad/m] | Otwarte n=0 DE [GHz], tylko analityka |
|---:|---:|
| 0 | 9.309814 |
| 1000000 | 9.520135 |
| 2000000 | 9.725724 |
| 3000000 | 9.926925 |
| 5000000 | 10.317376 |

Dla Γ i skończonego Dirichlet-airboxu o paddingu d z każdej strony: Nz=2d/(2d+t), f=gamma0 sqrt[H_ext(H_ext+Ms Nz)]/(2 pi). Przy d=2 µm oczekujemy **9.299250 GHz**, a nie dokładnie 9.309814 GHz. Ta różnica jest fizyczną konsekwencją skończonej domeny. Wzoru Nz nie podstawiać bez wyprowadzenia do wszystkich niezerowych k. KS n=0 jest przybliżeniem profilu po grubości, a nie dokładnym wzorcem wszystkich modów FEM.

## Kolejność prac i kryteria odbioru

### T1. Naprawa spójności dowodów C0 — otwarte, pierwsze

Powiązanie: DE-01. Ujednolicić wersję fingerprintu w `types.rs`, handoffie, `source_mesh_identity`, `comsol_mesh_identity.py` i konsumentach. Wersję zapisać jawnie lub wyprowadzać z jednoznacznie wersjonowanego kontraktu. Istniejące historyczne artefakty obsłużyć przez kontrolowaną migrację/wersjonowanie, bez nadpisywania wyników.

Odbiór: zgodna siatka przechodzi kontrolę tożsamości; zmienione węzły, połączenia lub periodyczność są odrzucane. Ponownie zweryfikować istniejące C0 bez powtarzania 21-minutowego solve, jeżeli naprawa dotyczy wyłącznie poprawnego odczytu jego wersji. Jeżeli artefakt jest faktycznie niespójny, potrzebny nowy eksport z poprawionego producenta. Brak zbieżności ma nadal pozostać jawny.

### T2. Usunięcie kosztu globalnego składania sprzężenia — otwarte

Powiązanie: DE-02. Składać prostokątne sprzężenie magnetyzacja–potencjał lokalnie, na elementach magnetycznych. Utrzymać konwencję pełnego pola i redukcję obu przestrzeni przez właściwe macierze Blocha. Nie przywracać gęstego fallbacku.

Odbiór: porównanie działania na małej siatce z referencyjną słabą postacią, poprawne wsparcie Ms, sprzężenie adjoint z czynnikiem mu0, zgodność wymiarów i faz. Zmierzyć assembly_seconds, Nphi, Nq, nnz i peak memory na dwóch rozmiarach. Brak globalnej pętli po wszystkich kolumnach powietrza. Ten etap poprzedza kosztowne C1.

### T3. Uporządkowanie targetu i diagnostyki solvera — otwarte

Powiązanie: DE-03 i ryzyko preconditionera. Rozdzielić surowy pencil λ=±iω od obróconego pencil z rzeczywistym ω. Zapisać faktycznie wybrany provider, target, transformację, liczbę zbieżnych par, residual oryginalnego równania, EPS reason i KSP reason. Telemetria heartbeat nie zastępuje tych danych.

Odbiór: przykład z co najmniej dwiema znanymi częstotliwościami wybiera mod blisko niezerowego targetu, a nie zawsze najniższy; poprawna konwencja znaku i polaryzacja. Floquet i Γ nie mogą zostać uszkodzone tą samą mechaniczną zmianą. Docelowy residual względny oryginalnego problemu <=1e-8; definicję normowania utrwalić, nie sprawdzać wyłącznie residualu transformacji.

### T4. Operatorowy test demagu przed szukaniem modów — otwarte

Przyłożyć kontrolowane małe zaburzenia poprzeczne do m0. Dla Γ sprawdzić odpowiedź na jednorodne my i mz: składowa w płaszczyźnie nie powinna wytwarzać demagu idealnego filmu; prostopadła powinna dać Hz=-Nz Ms mz dla skończonego pudełka. Sprawdzić potencjał, markery, znaki, jednostki i energię magnetostatyczną.

Dla jednego niezerowego ky sprawdzić fazy potencjału i pola, Hermitowskość odpowiedniego operatora energetycznego, nieujemność energii i porównanie z niezależnym rozwiązaniem jednowymiarowym po z z identycznymi warunkami brzegowymi. Uśrednione czynniki otwartego filmu traktować z uwzględnieniem błędu skończonej domeny i profilu.

Odbiór: jeżeli Γ nie daje Nz z geometrii, diagnozować assembly/BC przed kolejnym eigensolve. Nie dopasowywać sztucznego Ms, gamma ani grubości do starej częstotliwości.

### T5. Dwa punkty, potem pięć — otwarte

Najpierw wykonać Γ z demagiem i ky=2e6 rad/m na małej konfiguracji. Potwierdzić, że to najniższy mod n=0 przez pole, profil po grubości i overlap, nie tylko posortowaną częstotliwość. Po ich przejściu obliczyć pozostałe trzy punkty.

Odbiór: receipt i hash źródeł, rzeczywiste numeric frequencies, pola zespolone, residual, faza Blocha na informatywnych parach i zgodna siatka. Wzrost częstotliwości DE ma wyraźnie przekraczać błąd numeryczny. Wstępne odchylenie od n=0 <=0.3% jest progiem diagnostycznym; przekroczenie uruchamia rozdzielenie błędu modelu, domeny i FEM, a nie automatyczną korektę wzoru lub tolerancji.

Dodatkowo: ky=-2e6 dla wzajemności f(+k)=f(-k) w symetrycznym filmie bez DMI; bardzo małe ±k dla ciągłości z Γ. To testy dodatkowe, nie zamiennik pięciu podstawowych punktów.

### T6. Minimalna zbieżność i jednoznaczna bramka DE — otwarte

Na Γ i ky=2e6 wykonać trzy poziomy siatki (np. 3/5/7 warstw oraz zagęszczenie xy), zmianę liczby modów i kontrolę paddingu. Po każdej zmianie identyfikować ten sam mod przez overlap. Dla kilku pozostałych punktów rozszerzyć zbieżność, jeżeli margines błędu lub profil jest gorszy.

Rozdzielić: (a) błąd dyskretyzacji przy stałej domenie, (b) znane przesunięcie skończonego airboxu, (c) przybliżenie KS. Cel końcowej stabilności podstawowej częstotliwości: 2e-4 dla zmian numerycznych, z jawnie opisanym protokołem. Padding 1/2/4 µm to test trendu, nie automatycznie wystarczający zestaw do granicy otwartej. Dla Γ porównać każdy rozmiar z jego dokładnym Nz; do otwartej granicy zwiększyć d lub zastosować zweryfikowaną ekstrapolację.

Wprowadzić osobny wynik `DE-SMOKE`, ograniczony do podstawowej gałęzi i pięciu punktów. Nie przedstawiać go jako kwalifikacji 61 punktów/8 pasm C1 lub GPU. Bramka powinna wykrywać sztucznie płaski przebieg, podmianę analityki za numerykę, niespójną siatkę i brak demagu.

### T7. Wykres i odtwarzalny pakiet — otwarte

Wygenerować CSV z k, f_num, f_ref, względnym błędem, residualem, identyfikatorem modu i run_id. Wykres PNG/PDF: punkty FEM oraz osobna krzywa analityczna, z opisem finite/open airbox i niepewności. Dołączyć skrypt konfiguracji, parametry SI, manifest oraz tabelę zbieżności. Nie łączyć danych z różnych snapshotów bez jawnego oznaczenia.

Odbiór: pięć rzeczywistych punktów z demagiem, przechodzących ograniczoną bramkę; artefakty pozwalają osobie trzeciej odtworzyć wynik. Wykres samej analityki ani C0 nie spełnia tego etapu.

### T8. Pełny C1/COMSOL i integracja — później

Dopiero po T7 wrócić do kanonicznych 200×200×10 nm, Γ–X–M–Γ, 61 punktów i 8 pasm; dodać agregator dowodów DE-04 i poprawić opisy DE-07. Sprawdzić gałęzie BV, ukośne, wyższe i skrzyżowania; osobno A1 z antidotem. Porównanie COMSOL służy niezależnej walidacji, nie jest potrzebne do samego wykonania Fullmag. FEM GPU wymaga własnych dowodów; nie dziedziczy kwalifikacji CPU.

## Ograniczenia wykonania i raportowanie

- Obowiązuje zakaz kompilowania testów jednostkowych. Wykonywalne regresje przygotować zgodnie z zakresem; korzystać z lekkich kontroli i zatwierdzonych tras runtime. Nie obchodzić zakazu zadaniem builda nazwanym inaczej.
- Pełne buildy przez istniejący managed runner z jawnym worktree/snapshotem. Stan zdrowia i zasoby sprawdzić przed wysłaniem. Nie uruchamiać równoległego ciężkiego buildu poza kolejką.
- Po zamknięciu każdego etapu raportować wynik i artefakty; brakujący dowód pozostaje `NOT VERIFIED`. Działający proces nie jest ukończonym etapem.
- Nie ustalać wiarygodnego czasu pięciu punktów na podstawie samego buildu. Najpierw zmierzyć assembly i jeden solve po T2. Jeżeli brak postępu solvera lub przekroczony budżet, zachować diagnostykę i wrócić do operatora zamiast uruchamiać pełne 61 punktów.
- Ten audyt nie zleca automatycznego commit/push/merge istniejących dirty zmian. Integrację prowadzić w ramach wznowionej implementacji i wymaganych przeglądów.

Obecnie zamknięte dowody: managed build i częstotliwość C0 bez demagu. T1–T8 pozostają otwarte w zakresie kryteriów odbioru powyżej; istniejący kod jest punktem wyjścia, nie zerowym postępem implementacji.

## Aktualizacja realizacji pierwszego pakietu napraw — 2026-09-16

T1–T3 mają teraz wykonany pierwszy pakiet zmian źródłowych: wspólny modalny fingerprint v3, lokalny montaż źródła Floqueta oraz real-frequency-rotated adapter SLEPc. T4 nadal pozostaje osobnym testem fizycznym operatora demagu. Orchestrator T8 otrzymał jawne `--scientific-evidence-root`, dzięki czemu może wczytać zewnętrzne, hashowane porównania bez fabrykowania dowodu; brak tego pakietu nadal kończy się `NOT VERIFIED`.

Nie podnoszę żadnego etapu do `PASS`: po zmianach nie ma jeszcze managed builda, świeżego solvera ani wykresu DE. Kolejność odbioru pozostaje: build z tego worktree → mały operatorowy test demagu → dwa punkty $k$ → pięć punktów i wykres → dopiero pełne C1/A1.

## Mapa zmian i zależności

Ścieżki istniejące są względem worktree. Nowe pliki benchmarku DE mają zostać wybrane przy implementacji; poniższa mapa nie deklaruje ich istnienia.

| Etap | Główne pliki / obszar | Zależność i dowód |
|---|---|---|
| T1 | `crates/fullmag-runner/src/types.rs`, `fem/eigen_equilibrium_contract.rs` w tym samym crate; `scripts/comsol_mesh_identity.py`, `scripts/validate_comsol_dispersion_scientific_gate.py`, producenci modal metadata | Niezależny od T2; ponowny certyfikat istniejącego C0 i negatywna kontrola podmienionej topologii |
| T2 | `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp`, `floquet_airbox_operator.cpp` i odpowiadające nagłówki | Przed T4/T5; zgodność działania operatora i pomiary skali |
| T3 | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`, `modal/floquet_modal_solver.cpp`, `backends/fem/src/frequency_domain/mode_kinematics.cpp` | Przed T5; wynik wyboru targetu i residual oryginalnego problemu |
| T4 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`, blok Floqueta, osobny mały harness operatorowy | Po T2; Nz i odpowiedź potencjału dla identycznych BC |
| T5 | Nowa konfiguracja DE obok `tests/standard_problems/mumag/comsol_nonzero_k_dispersion`, `scripts/run_comsol_dispersion_benchmark.py` lub odrębny wrapper wykorzystujący jego managed route | Po T1–T4; 2, potem 5 numerycznych punktów z manifestami |
| T6 | Nowy ograniczony walidator DE oraz `scripts/validate_comsol_dispersion_scientific_gate.py` dla wersjonowania wspólnych kontraktów | Po T5; trzy poziomy, kontrola liczby modów i domeny; bez osłabiania C1 |
| T7 | Osobny eksport CSV/PNG/PDF w kanonicznym storage | Po T6; weryfikacja danych wejściowych wykresu i zgodności jednostek |
| T8 | `scripts/run_comsol_dispersion_benchmark.py`, kanoniczne config/problem C1, dokumentacja statusu i naukowa | Po T7; pełne evidence bundles, review i osobna kwalifikacja rozszerzonego zakresu |

Dla istniejących zmienionych plików zachować pracę innych etapów, nie stage'ować całego dirty worktree.

## Checkpoint weryfikacyjny po pierwszym pakiecie napraw — 2026-09-16

Przechodzą lekkie kontrole fingerprintu v2/v3, wiązania równowagi i modalnego
źródła siatki, adaptera real-frequency SLEPc, lokalnego montażu źródła Floqueta
oraz stagingu zewnętrznych dowodów (57 testów w wybranym zestawie). Nie
uruchomiono kompilacji MFEM/PETSc/SLEPc: managed runner nie odpowiada na
runner-container-status ani runner-doctor, a repozytorium zabrania zastępowania
tej trasy hostowym buildem. DE-01–DE-04 pozostają więc na poziomie implementacji
źródłowej; runtime, pomiar assembly i pełna bramka naukowa są nadal
NOT VERIFIED.

Po dodatkowej kontroli pakietu poprawiono także istniejące rekordy
`sample_solver_diagnostics`, aby zawsze przechowywały modalny fingerprint v3;
v6 jest wyłącznie identyfikatorem handoffu. Dla adaptera SLEPc podpisany target
jest przekazywany jednocześnie do `STSetShift` i `EPSSetTarget`. Łączny zestaw
kontrolny po tej korekcie: **102 passed, 2 deselected** (w tym pełny moduł
walidatora naukowego). To nadal kontrola źródeł i kontraktów; nie jest dowodem
runtime.

## Próba managed builda po pierwszym pakiecie — 2026-09-17

Profil `fem-cpu-slepc-modal-v1` został uruchomiony przez managed runner.
Pierwszy job `eacae28e4cd740259773b4c2b57c3632` doszedł do kompilacji crate'u
`fullmag-runner` i ujawnił błąd typu: pole
`AcceptedFemRelaxStageHandoff.source_mesh_topology_sha256` było użyte jak
metoda. Poprawka została naniesiona i wysłana w kolejnym snapshotcie.

Retry `0524d64f5e07432387b09a356da5ba89` pozostaje `queued`, ponieważ wolne
miejsce w kanonicznym storage spadło do około 0,98 GB, poniżej wymaganego
progu 8 GiB. Nie wykonano automatycznego cleanupu ani globalnego prune.
Kolejność odbioru nie zmienia się: udany build → pilot DE → 2 punkty $k$ →
5 punktów i wykres → pełna bramka C1/A1.

## Checkpoint po hardeningu granicy wykonania — 2026-09-17

W `execute_fem_eigen_path` dodano fail-closed guard, który odrzuca połączenie
`dispersion_validation` z syntetycznym K0/Kittel demag-factor solverem także
dla planów skonstruowanych bez plannera lub odtworzonych ze starszego artefaktu.
To utrzymuje analitykę w roli porównania postsolve i nie pozwala opublikować
częstotliwości referencyjnej jako wyniku numerycznego.
Referencja Kalinikosa–Slavina ma wspólną walidację domeny `|k|`, grubości,
parametrów materiałowych i `gamma`; niepoprawne dane są odrzucane fail-closed.

Po korekcie kontraktu Compose i izolacji zapisu dowodu w teście orchestratora
wybrany zestaw kontroli daje **85 passed, 54 subtests passed**. `rustfmt --check` dla
zmienionych plików przechodzi. Managed retry pozostaje `queued` z powodu
wolnego miejsca poniżej 8 GiB (ostatni odczyt: około 0,98 GB); T4–T7 nadal wymagają runtime operatora i
rzeczywistych artefaktów. Ten job został utworzony przed bieżącym
hardeningiem, dlatego po udrożnieniu storage trzeba zlecić nowy snapshot.

## Aktualizacja po kontroli dokumentacji — 2026-09-17

Kontrakty źródłowe zostały ujednolicone z obecnym stanem kodu: CPU
Floquet/airbox jest widoczny w źródle i może być podjęty przez dokładny plan
modalny, ale bez managed receipt'u, residualu i zbieżności pozostaje
`NOT VERIFIED`. Driven response z demagiem nonzero-k oraz niepełne metadane
mają nadal fail-closed. Historyczny preset low-k (`3e6 rad/m`, `5 GHz`) nie
ogranicza C1; dla C1 zakres jest parametryzowany przez `pi/a` i jawne okno.

Naprawiono błąd ścieżki w walidatorze podziału produktów oraz dwie stare
asercje fixture'ów runtime. Aktualne kontrole tekstu i kontraktów przechodzą,
ale T4–T7 nadal wymagają managed kompilacji, operatorowego testu demagu,
rzeczywistych punktów FEM i wykresu. Kolejność odbioru pozostaje: nowy
snapshot z bieżącego worktree → pilot DE → 2 punkty → 5 punktów i wykres →
pełna bramka C1/A1.

M6 z audytu ma teraz poprawkę fail-closed na granicy fizycznego bridge'a:
niehermitowski Schur dynamicznego demagu jest odrzucany przy względnym
residuum `>1e-8`, a niski oracle algebraiczny pozostaje dostępny dla testów
manufakturowanych. To nie zastępuje T4: nadal trzeba zmierzyć znak, energię,
residual oryginalnego pencila i zbieżność na rzeczywistym mesh/airbox.

## Kontrola środowiska po dalszej próbie — 2026-09-17

Kolejna próba nie przeszła do buildu: `runner-container-status` i
`runner-doctor` nie otrzymały odpowiedzi od koordynatora Docker Desktop, a
kanoniczny storage ma 0 GB wolnego miejsca. Job `0524d64f5e07432387b09a356da5ba89`
pozostaje `queued`; nie wykonano cleanupu. Pakiet 15 lekkich testów adaptera
SLEPc, bridge'a Floquet i orchestratora przechodzi. Fixture pełnej bramki
naukowej zatrzymał się przy zapisie danych C1/A1 na `OSError: [Errno 28] No
space left on device`. Kolejny krok pozostaje: odzyskać miejsce i przywrócić
koordynator, utworzyć nowy snapshot bieżącego worktree, a potem wykonać T4,
T5 i T7. Żaden z tych etapów nie może zostać oznaczony jako `PASS` na podstawie
samego kodu lub analityki.

Dodano także dwa testy jednostkowe w `crates/fullmag-runner/src/fem/eigen_math.rs`:
ciągłość `thin_film_p00` przy Gamma oraz zgodność gałęzi `expm1` z jawną
formułą poza Gamma. Nie uruchamiano ich zgodnie z obowiązującym zakazem
kompilacji testów jednostkowych; ich wykonanie pozostaje częścią pierwszego
nowego managed builda.

## Aktualizacja po odzyskaniu miejsca i próbie nowego snapshotu — 2026-09-17

Wolne miejsce na kanonicznym dysku wzrosło do około 18,9 GB. Stary job
`0524d64f5e07432387b09a356da5ba89`, utworzony przed ostatnimi zmianami, został
anulowany, aby nie mieszać jego nieaktualnego snapshotu z bieżącym źródłem.
Próba wysłania nowego snapshotu profilu `fem-cpu-slepc-modal-v1` zwróciła
HTTP 503 z API runnera. `runner-container-status` zgłasza błąd żądania do
Docker Desktop, a `runner-doctor` kończy się timeoutem `docker info` po 60 s;
`runner-container-start` nie przywrócił koordynatora. Nie wykonano więc
kompilacji natywnej ani nie powstał nowy receipt.

Lokalne kontrole źródła i bramki fixture'ów są zielone: **128 testów i 54
podtesty**, walidator podziału produktu oraz `git diff --check`; `rustfmt
--check` dla zmienionych plików Rust także przechodzi. Status T4–T7 pozostaje
`NOT VERIFIED`: następny krok to przywrócenie dostępu koordynatora do
`desktop-linux`, wysłanie dokładnie jednego snapshotu i dopiero potem pilot DE,
kilka punktów $k$, wykres oraz pełna bramka C1/A1.

## Snapshot przyjęty, hostowy Docker nadal blokuje build — 2026-09-17

Po wznowieniu koordynatora worker osiągnął `worker_alive=true` i
`accepting_jobs=true`, a bieżący snapshot został przyjęty jako job
`71b182c1f03245a8a6619b033f3d938e` (source digest
`9968a7dcf664f03430ea248aa0fa416291a1a4796a21da6e8ff9f455ea5680a0`). Job
pozostaje `queued`: koordynator cyklicznie zapisuje `job_claimed`, lecz jego
wejście do Docker kończy się `TimeoutError: timed out`, zanim powstanie lease
i kontener builda. Health pokazuje `worker_alive=true`, ale brak aktywnego
kontenera; endpoint overview również timeoutuje na metadanych Docker.

Wolne miejsce wynosi około 16,7 GB. Próba uruchomienia Windowsowej usługi
`com.docker.service` została odrzucona jako `Cannot open ... service` z tej
sesji. Job pozostaje zachowany do wznowienia po przywróceniu Docker Desktop;
nie użyto ręcznego Dockera ani CPU fallbacku. Managed compile, receipt, pilot
DE, punkty FEM i wykres są nadal `NOT VERIFIED`.
