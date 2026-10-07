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


## T4 — niezależny wzorzec potencjału 1D, 2026-09-22

Dodano `scripts/de_film_demag_reference.py::film_response`, pomocniczy wzorzec
P1 dla jednorodnych po grubości amplitud magnetyzacji. Nie jest to solver
modów Fullmag, wynik SLEPc ani dowód odbioru T4. Nie zmienia Python DSL/IR
ani wsparcia FDM CPU/GPU lub FEM CPU/GPU. Jedynym zastosowaniem jest
niezależne porównanie potencjału i pola z natywnym operatorem FEM CPU.

Punktem wyjścia są równania potencjału i energii z
`docs/physics/0800-fem-static-pbc-demag.md` oraz słaba postać
`eq-0828-full-bloch-weak` w
`docs/physics/0828-fem-frequency-domain-floquet-demag.md`.
Po wydzieleniu czynnika $\exp(-\mathrm{i}ky)$ otrzymujemy:

$$
\int (v'^*\phi'+k^2v^*\phi)\,dz
=\int_{-t/2}^{t/2}(\mathrm{i}k v^*M_y+v'^*M_z)\,dz,
\qquad H_y=\mathrm{i}k\phi,\quad H_z=-\phi'.
$$

Tutaj $z,t,d$ są w metrach, $k$ w rad/m, $M_y,M_z,H_y,H_z$ w A/m,
a $\phi$ w A; $d$ oznacza padding po każdej stronie. Końce domeny
$z=\pm(t/2+d)$ mają potencjał zero. W solverze użyto $s=z/t$ i
$p=\phi/t$, aby uniknąć mieszania skali nanometrów ze współczynnikami
macierzy. Interfejsy filmu są dokładnymi węzłami; P1 używa dokładnej
lokalnej macierzy masy i sztywności oraz źródła powierzchniowego ze słabej
postaci. Rozwiązanie trójdiagonalne nie korzysta ze wzoru częstości.

Raportowana energia na jednostkę powierzchni to kwadratowa forma
$\mu_0\int(|\phi'|^2+k^2|\phi|^2)dz/2$ w J/m². Jest porównywana z
$-\mu_0\operatorname{Re}\int_{film}\mathbf M^*\cdot\mathbf H\,dz/2$.
To konwencja normy amplitud zespolonych, nie średnia czasowa pola rzeczywistego
(ta wymaga dodatkowego czynnika 1/2).

Sześć lekkich testów Pythona przeszło: dokładny czynnik Gamma
$N_z=2d/(2d+t)$, brak pola dla jednorodnego $M_y$ w Gamma, znak odpowiedzi,
zgodność obu energii, faza i sprzężenie zespolone przy zmianie znaku k,
zbieżność do otwartego czynnika $N_z=(1-e^{-|k|t})/(|k|t)$ oraz odrzucanie
niepoprawnych danych. Ostatnia kontrola dotyczy jednorodnego wymuszenia,
nie dokładności jednomodowego przybliżenia widma.

Dla t=10 nm, d=2 µm i Mz=1 A/m otrzymano średnie Hz=-0.997506234414 A/m
w Gamma oraz -0.990059656628 A/m dla ky=2e6 rad/m (12 warstw filmu,
256 elementów na każdy obszar powietrza). Residuale algebraiczne obu
rozwiązań były poniżej 2e-15. Te liczby są wyłącznie referencją 1D.
Nadal trzeba wyeksportować i porównać pola natywnego operatora, kontrolować
jego siatkę i wykonać T5–T7; nie policzono nowych częstości Fullmag.

## Checkpoint wykonania native Floquet — 2026-09-23

Branch `codex/eigensolve-dispersion-plan-20260912` ma HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`; najnowszy pobrany `origin/master`
(`93f11dbc564c00b725d174ccb2fd0ff9a96493c`) jest jego przodkiem. Główny
checkout nie został zmieniony.

Managed runtime-only build `2439cca257fb49ffb42bc8adba739623` zakończył się
`succeeded`, `exit_code=0`, profilem `fem-cpu-slepc-runtime-v1`, obrazem
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`
i source capsule `929e43712e1b4eba9b83cb585e1c26390125eb519df9702b977739963aaaa968`
(snapshot `1b08965de92b603f016f6905f736a7cbd0d7321289125b8776143726247d0c11`,
HEAD `479d5c5...`). Receipt jawnie ma `runtime_only=true`, pustą listę
`unit_test_targets` i `qualification=NOT VERIFIED`: jest to dowód kompilacji,
nie testów ani fizyki.

Smoke `de-smoke-k2` (`run id d1ec2507a7fc493db96e5761208a3a3e`) uruchomił
FEM CPU/double/SLEPc z dynamicznym demagiem dla
$\mathbf k=(0,2\times10^6,0)\,\mathrm{rad\,m^{-1}}$, mesh 1980 węzłów / 5720
tetraedrów i 1195 par Floqueta. Nowa konfiguracja LU ominęła wcześniejszy
zero-pivot; solver zwrócił 23 kandydatów SLEPc, ale żaden mod nie został
zaakceptowany. Okno 8.5–10.25 GHz zgłosiło
`floquet_original_descriptor_residual_not_met`; okno 10.25–12 GHz nie miało
dodatniego kandydata wewnątrz okna. Nie powstał poprawny punkt częstotliwości,
wiersz CSV ani wykres. Wartości `residual_rejections=0` i residualów `0` w tym
starym runie nie są pomiarami: źródło nie wypełniało tych pól diagnostycznych.

W lokalnym źródle dodano teraz liczniki kandydatów i liczby kandydatów z
pełnym wyliczonym residualem, rozdzielne maksima EPS/bloku magnetycznego/
potencjału oraz breakdown najgorszego kandydata. Wartości residualu zaczynają
się jako „nie zmierzono” i są serializowane jako `null`, a nie zero, dopóki
nie ma próbki. Dodano też asercje do istniejącego testu źródłowego;
zgodnie z bieżącym zakazem testy jednostkowe nie są kompilowane ani uruchamiane.
Ten przyrost nie wszedł do joba `2439...` i wymaga nowego managed runtime
builda przed interpretacją liczb residualu.

Koordynator jest zdrowy, ale kolejkę zajmuje aktywny job
`b0635ee724444977bae6402221f82990` z worktree
`eigensolve-k0-finalization-db0fde795ab86411`; aktualny allowlist nie zawiera
profilu runtime-only. Nie restartować ani nie przekonfigurowywać współdzielonego
runnera podczas tego joba. Po zwolnieniu kolejki trzeba odtworzyć/zweryfikować
runtime-only profil, zbudować bieżący snapshot, uruchomić ponownie `k2`, odczytać
nowy breakdown residuali i naprawić jego przyczynę przed drugim punktem $k$.

Stan bramek: T3 — częściowo wykonana poprawka LU, otwarta diagnostyka i
akceptacja residualu; T4 — operatorowy test pola nadal otwarty; T5 — pierwszy
punkt $k\ne0$ wykonany, ale bez zaakceptowanej częstotliwości, zatem niezaliczony;
pozostałe trzy punkty, zbieżność T6, wykres/pakiet T7 i pełny C1 T8 pozostają
otwarte. Nadal nie istnieje numeryczna relacja dyspersji do wykreślenia.

### Uzupełnienie kontroli demag seams — 2026-09-23

Artefakt `periodic_pairs.v1` z tego runu potwierdza topologię parowania:
`validation_status=ok`, sześć grup parowanych ścian, 3585 sparowanych węzłów,
zerowy maksymalny residual translacji i fingerprint
`sha256:2fde44d7d0e2f8ba58de35c3055ae167866e18fbdd90a41ad5f7302110f8fa2e`.
`pair_count=6` liczy grupy ścian, nie pojedyncze pary węzłów, a certyfikat
topologii nie weryfikuje fizyki pola demagnetyzującego.

Diagnostyka `fem_static_pbc_demag_seams.v1` zakończyła się statusem
`failed`, ponieważ w końcowych snapshotach relaksacji brakowało pól
`H_demag` i `demag_phi`; seamów nie dało się obliczyć. To jest brak danych do
oceny, a nie wykazany błąd fizyczny operatora. Kontrola statycznego demagu
przez szwy pozostaje `NOT VERIFIED` i wymaga runu eksportującego oba pola.

Wejściowy `examples/fem_de_smoke_numeric.py` żąda teraz terminalnych
artefaktów `H_demag` oraz `demag_phi`; okres zapisu jest wyprowadzony z kroku
i limitu czasu relaksacji, aby nie tworzyć gęstej historii pól. Jest to zmiana
źródłowa. Dopiero następny managed run może potwierdzić oba snapshoty na tym
samym kroku i rozstrzygnąć kontrolę szwów.

### Aktualizacja kolejki runnera — 2026-09-23

Job `b0635ee724444977bae6402221f82990` (profile `fem-cpu-slepc-modal-v1`,
worktree `eigensolve-k0-finalization`) zakończył się `failed`, exit code 2,
po około 31 min natywnego builda. Błąd jest poza tym worktree:
`crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs:345` przekazuje
`&Vec<f64>` do argumentu `&[bool]` (`E0308`). Nie wprowadzano tam zmian.
Koordynator wrócił do `idle`, `active_jobs=[]`; jego allowlist nadal nie
zawiera `fem-cpu-slepc-runtime-v1`. Następny krok to bezpieczne przywrócenie
tego profilu, potem managed build aktualnego snapshotu z telemetrią.

Profil przywrócono przez nowy obraz koordynatora
`sha256:eed020f1664bde606b20412968681094a885f3e7080679c6d21c90a4160253e4`;
health potwierdził `worker_alive=true`, `accepting_jobs=true`, allowlistę
z runtime-only oraz `active_jobs=[]`. Job 109
`d4a26468c5124354b9956ac5ddb92aef` przyjął snapshot tego worktree:
`source_digest=054d139d6474a378c587974c5652af65eda4fad922afa241eabeba58efd2eec8`,
`source_snapshot_sha256=8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`,
HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Job przeszedł do `running`;
wynik builda i jego receipt są jeszcze niedostępne. Snapshot obejmuje pięć zmienionych
plików runtime/wejściowego modelu DE; doc-only zmiany pozostają poza nim.

### Checkpoint po jobie 109 i pierwszym nowym `k2` — 2026-09-23

**Odświeżenie mastera.** Worktree
`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912` ma branch
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`, i zawiera świeżo pobrany
`origin/master` `93f11dbc564c00b725d174ccb2fd0ff9a96493c` jako przodka. Ma 209
commitów tylko po stronie brancha i 0 tylko po stronie mastera. Nie wykonano
merge, rebase ani resetu; lokalne zmiany pozostają zachowane.

**Build 109 — wykonany i zaliczony jako build.** Job
`d4a26468c5124354b9956ac5ddb92aef`, sequence 109, profil
`fem-cpu-slepc-runtime-v1`, zakończył się `succeeded`, exit 0. Source digest:
`054d139d6474a378c587974c5652af65eda4fad922afa241eabeba58efd2eec8`, snapshot
`8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. `runtime-attestation.json` ma
`status=pass` i `native_fem_cpu_available=true`; receipt oznacza
`runtime_only=true`, `unit_test_targets=[]` i `qualification=NOT VERIFIED`.
Build potwierdza kompilację natywnego runtime/CLI, nie testy ani poprawność
fizyki. Pomocniczy odczyt wersji Rust w receipt zwrócił permission error na
zamontowanym rustup, ale etap właściwego `native-build` zakończył się 0.

**T5 — punkt k2 uruchomiony, ale niezaliczony.** Pilot
`de-smoke-k2` (`50d824f803ef45d1a9bedb0b647ac8a5`) działał jako FEM CPU,
double, SLEPc, strict, z dynamicznym Floquet demagiem i
$\mathbf k=(0,2\times10^6,0)\,\mathrm{rad\,m^{-1}}$. Model utworzył siatkę
1980 węzłów / 5720 tetraedrów, 1195 par Floqueta; relaksacja zakończyła się po
3 krokach i dostarczyła pola wejściowe do modalnego solve. SLEPc zwrócił 23
kandydatów; kandydat 9.7233362727 GHz miał magnetic residual
`2.1678405357802513e-7` przy limicie `1e-8`, a potencjał residual
`1.4175187550539143e-14`. Zaakceptowanych modów: zero. Wynik `failed`, cleanup
kontenera `verified_absent`, CSV częstotliwości pusty/brak, wykres nieważny.

**Kontrola demagu — statyczna kontrola szwów wykonana.** W tym runie oba pola
`H_demag` i `demag_phi` są obecne. `fem_static_pbc_demag_seams.v1` ma
`status=ok`; dla sześciu grup par graniczne różnice `m`, `H_demag`, `demag_phi`
i normalnego strumienia B wyniosły zero (jedno podsumowanie ładunku bocznego
ma tylko `3.28e-47 A·m`). Certyfikat przeliczonej liniaryzacji stanu końcowego
ma `status=matched`, różnica `H_demag` `1.67e-24 A/m`, różnica potencjału
`1.10e-30 A`. To jest tylko kontrola statycznej, jednorodnej równowagi
in-plane przy $k=0$, nie walidacja dynamicznego demagu Floqueta dla
niezerowego $k$. Artefakt relaksacji ma `status=not_evaluated`; nie jest to
kwalifikacja naukowa.

**N2 — poprawka w źródle, czeka na runtime.** Stary adapter zatrzymywał EPS
na `EPS_ERROR_RELATIVE = ||r||/|lambda|` i tę wartość mieszał z relatywnym
residualem bloków oryginalnego pencil. W runie pierwsza wartość wyniosła
`5.72e-20`, ale bezpośrednia reszta magnetyczna `2.17e-7`. Źródło zmieniono
na absolutny true residual znormalizowanego pencil (`EPS_CONV_ABS`), z
wewnętrzną tolerancją
`max(100*epsilon_machine, 0.01*requested_rtol)`. Twarda bramka wynikowa
pozostaje `max(magnetic_relative_residual, potential_relative_residual) <=
requested_rtol`. Nowe pola diagnostyczne określają metrykę jasno; regresję
źródłową uzupełniono, ale testów nie wolno kompilować ani uruchamiać.

**Następny krok wykonawczy:** zlecić nowy managed runtime-only build bieżącego
snapshotu, zweryfikować receipt i source identity, potem ponownie wykonać
`de-smoke-k2`. Sukces oznacza zaakceptowany mod z residualami poniżej `1e-8`
oraz niepusty wiersz artefaktu. Dopiero potem porównać wynik z odrębnym
analitycznym modelem DE uwzględniającym dynamiczny demag; nie dopasowywać ani
nie stroić analityki do wyniku numerycznego. Jeśli residual nadal nie przejdzie,
zebrać nowy breakdown zamiast luzować limit.

Status bramek po tym checkpointcie: T1 managed runtime build — **wykonany**;
T4 statyczny seam/control snapshot — **wykonany w ograniczonym zakresie**, LLG
formalnie `not_evaluated`; T5 nonzero-k frequency — **uruchomiony, niezaliczony**;
N2 — **poprawka źródłowa, runtime pending**; analityka, dalsze k-punkty,
zbieżność, wykres/T7 i pełna kwalifikacja C1 — **otwarte**. Nie ma jeszcze
zweryfikowanej numerycznej relacji dyspersji.

### Blokada runnera — 2026-09-23

Job `8dead9c4716741bba741e72055a756b2` z innego worktree nadal działa na
współdzielonym koordynatorze. Jego natywny build przeszedł (`exit_code=0`), lecz
cały job pozostał `running` podczas instalacji zależności frontendowych.
Runner jest w graceful stop i ma wyłączone przyjmowanie zadań. Nie zmieniać
allowlisty ani obrazu i nie anulować joba, dopóki jego receipt nie będzie
terminalny, a `active_jobs` puste.

Po zakończeniu joba włączyć `fem-cpu-slepc-runtime-v1` dla bieżącego obrazu
`sha256:e9f46ae4690d96dfcdfa915584265733b6d9930fdecf60b16b95f6bfb26101fc`,
bez budowania testów. Następnie wykonać managed build snapshotu worktree,
zweryfikować jego receipt/source identity i ponowić jeden punkt `k2`. Dopiero
zaakceptowany mod z residualami poniżej `1e-8` i niepustym wierszem wyniku
odblokuje porównanie numeryczne z analityką DE oraz wykres kilku punktów.

### Najnowszy stan kolejki — 2026-09-23

Live runner działa i zgłasza `accepting_jobs=true`, ale jego aktywna allowlista
nie zawiera `fem-cpu-slepc-runtime-v1`, którego potrzebuje build tej poprawki.
W kolejce jest aktywny job #111 (`e087d668915e4e6099d5404d5b8ebc0c`) z innego
worktree. FIFO może kolejkować dozwolone profile, lecz nie przyjmie profilu
spoza allowlisty. Nasza poprzednia próba zakończyła się HTTP 503 i wpisu N2
brak. Poprzedni wpis o jobie #110 jest historyczny i nie opisuje bieżącego
stanu.

Dwa odczyty statusu oddalone o około 30 s pozostawiły #111 bez zmian;
`updated_at` wskazuje 21:26:09 czasu lokalnego. Live health nadal widzi go jako
`running`, podczas gdy `coordinator.active_job_ids=[]` i `waiting_until` to
21:26:08. Worker jest żywy i nie zgłasza błędu. To nierozstrzygnięta
niespójność stanu, nie dowód wolnego slotu. Nie restartować, anulować ani
automatycznie odzyskiwać joba innego worktree.

Późniejszy odczyt rozstrzygnął, że sam worker jest aktywny: kontener
`337f0cae831ede0d92e46a4714ddeafd49bf45f6934669df295ce7ed1af0361f` ma
`running=true`, a `docker top` pokazał `cargo`. `runner-wait` po 30 s nie
zakończył zadania. Wolne storage wynosiło `8,650,276,864` bajtów, około
60 MB ponad próg 8 GiB; podgląd retencji timeoutował i nie uzasadnia żadnego
usunięcia. Profil runtime ma skonfigurowany i dostępny obraz workera
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`
z limitami 2 CPU/8 GiB RAM, lecz aktywny koordynator nadal go nie dopuszcza.

Po zakończeniu #111: potwierdzić brak aktywnych zadań, bezpiecznie przywrócić
zweryfikowany obraz koordynatora z obsługą runtime-only oraz allowlistę,
sprawdzić je przez live health API i przesłać snapshot worktree do kolejki.
Nie zmieniać wspólnego runnera w trakcie obcego joba. Do uzyskania managed
runtime receipt N2 jest `NOT VERIFIED`; ponowne `de-smoke-k2`, porównanie z
analityką, kolejne punkty i wykres pozostają otwarte.

### Aktualizacja kolejki — 2026-09-23

Live `/health` potwierdza `accepting_jobs=true`, ale uruchomiony koordynator
nie dopuszcza `fem-cpu-slepc-runtime-v1`, mimo że hostowy plik konfiguracji go
wymienia. Aktywny job #111 należy do innego worktree. Snapshot z kluczem
`24aa119e7f5848e1b927dc12b3a24f82` zwrócił HTTP 400; wpisu nie ma w kolejce.
Wolne miejsce to `5,807,996,928` bajtów, poniżej progu 8 GiB.

Po zakończeniu #111 i odzyskaniu wymaganego miejsca zastosować hostową
allowlistę przez wspierany cykl koordynatora, potwierdzić ją w live health i
ponowić zgłoszenie snapshotu. Nie zmieniać koordynatora podczas aktywnego joba.
Do przyjęcia buildu, poprawnego wyniku `k2` i porównania z analityką kilka
punktów oraz wykres pozostają `NOT VERIFIED`.

Kontrola o 20:24 UTC: job #111 nadal `running`; `runner-wait` timeoutował na
API, nie kończąc zadania. Wolne miejsce wynosi `4,866,473,984` bajtów. Nie
przeładowywać koordynatora i nie ponawiać buildu przed terminalnym #111,
przywróceniem live allowlisty oraz odzyskaniem progu 8 GiB.

Kolejny odczyt o 20:27 UTC nadal pokazuje aktywny #111 i brak profilu runtime;
wolne miejsce wynosi `4,772,020,224` bajty.

### Snapshot bieżących poprawek w kolejce — 2026-09-24

Runner przyjął #123 (`c62f1d5990ec4806bba82d8fb33beda3`) z profilem `fem-cpu-slepc-modal-v1`, stan `queued`, za aktywnym #122. Snapshot: digest `c5768e4253f359e16e993af2d4a91ab1ae1a349f7713df1801c3d6d3eb5abeb0`, capture `6fcb48331d8e48028c1e42fea2da021a`, SHA `f05ba3d65e0cf3f0be98d01aabfa6a8fa1c6b0cd6d02bfeb75dbaab4304775af`, HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Odczyt zdrowia runnera: `health.ok=true`, worker przyjmuje joby, wolne ok. 29 GB; `active_jobs` zawierał #122 mimo pustego `active_job_ids`. Zachowano kolejkę i nie przerwano joba. Po buildzie nadal wymagane są receipt oraz uruchomienie DE-SMOKE z dokładnie tego runtime. Wyniku `k != 0`, porównania z analityką i wykresu jeszcze nie ma.

### Wynik joba #123 i stan runnera — 2026-09-24

Job #123 osiągnął stan terminalny `failed`, `exit_code=2`. `native-build` i instalacja zależności frontendu zakończyły się sukcesem; `web-build-static` dwukrotnie zatrzymał się na błędzie TypeScript w `frequencyDomainChartModels.ts:1106` (`kind: string` zamiast `"line" | "scatter"`). Źródło poprawiono przez jawne zachowanie typu literalnego, ale poprawka nie była częścią snapshotu #123.

Po odczycie listy kolejki nie ma aktywnego joba. `just runner-container-status` z ograniczonego środowiska nie mógł poświadczyć kontekstu Docker Desktop. Odczyt tej samej, wspieranej recepty z dostępem hosta potwierdził istniejący kontener `Fullmag_build_runner`: `health.ok=true`, `worker_alive=true`, `accepting_jobs=true`, `active_jobs=[]`, profil `fem-cpu-slepc-modal-v1` dozwolony, wolne miejsce 14,895,345,664 B. Można wysłać świeży snapshot do wspólnej kolejki; przed capture wstrzymać edycję.

Następny krok to managed build snapshotu zawierającego poprawkę typów i fail-closed probe K0. Sukces builda nie zastąpi wykonania Gamma/k2, odbioru residuali i pola demagu, porównania z analityką ani wykresu.

### Job #124 — świeży snapshot po poprawkach — 2026-09-24

Job #124 (`40e05e4a2bff497fbcd6f1c853a24221`) został przyjęty przez istniejącą
wspólną kolejkę, profil `fem-cpu-slepc-modal-v1`. Digest źródeł:
`30cc17ad49fdd7df6ad9876bc006187a1f3b5724f92cea397496ea3475c067fc`, capture:
`ff908a7894f94d1faaa2e3af61ccd895`, snapshot SHA:
`453398d2c4b6d96d8131a2864946b88d0b52a78ed92c73a864327194c503613d`, bazowy
HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Odczyt potwierdził, że job
przeszedł do stanu `running`. Build zawiera poprawkę TypeScript i fail-closed
agregację obu kierunków probe K0; nie dowodzi jeszcze żadnej częstotliwości
solverowej ani poprawności naukowej.

Po terminalnym buildu należy zweryfikować receipt i hashe, a przy sukcesie
uruchomić Gamma oraz `k_y=2e6 rad/m` na tym runtime. Nie ma jeszcze zaakceptowanej
częstotliwości `k != 0`, porównania z analityką ani wykresu.
### Wynik #124 i świeży build po poprawce — 2026-09-24

Job #124 zakończył się `failed`, `exit_code=2`, w `native-build` po
592414 ms. Kompilator wskazał błędne łączenie dwóch literałów `const char[]`
w `backends/fem/src/frequency_domain/modal_eigen_solver.cpp:467`. Pierwszy
operand zmieniono na `std::string`, a kontrola `git diff --check` przeszła.
Błąd wystąpił przed receipt runtime; nie uruchomiono pilota z #124.

Wspólna kolejka przyjęła #125 (`b03024288adc4cf0849a1b9c51b375be`), profil
`fem-cpu-slepc-modal-v1`, digest
`a21e7963914525b5c635f4130e6aad3b3473fc08d64df3473e0145fb21e2bee3`, capture
`195d849d85b34eca8405fcffa575ed0f`, snapshot SHA
`2f53f1eface1e332aa37b07f1b79cf243273f8ba0db099dbd964b3a215613b3c`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Job przeszedł do `running`.
Po sukcesie wymagane są kontrola receipt/tożsamości oraz ponowny
`de-smoke-k2` z dokładnie tego runtime. Częstotliwości dla niezerowego k,
porównania analitycznego ani wykresu nadal nie ma.

### Aktualizacja T3/T5 — EPS absolutny a fizyczny residual — 2026-09-25

Nowszy runtime-only build #133 zakończył się poprawnie, lecz pilot `k_y=2e6 rad/m` nie przyjął żadnego modu. Powtórka z limitem 2000 iteracji nadal dała residual magnetyczny `2.1678405e-7` wobec wymagania `1e-8`, mimo że EPS raportował absolutny true residual `3.4957520e-9`. Limit iteracji zwiększono bez zmiany progu fizycznego; wynik potwierdza, że sama dłuższa iteracja nie rozwiązuje problemu.

Wniosek T3: absolutny residual pencila po globalnym skalowaniu nie jest tym samym co znormalizowany residual per modu. W źródle zaostrzono wyłącznie wewnętrzny EPS prefilter do `max(100*machine_epsilon, 1e-3*requested_rtol)`; fizyczna bramka oryginalnych bloków pozostała `1e-8`. Ta zmiana jest jeszcze **niezbudowana i niezweryfikowana runtime**. Następnie wykonać jeden świeży managed build i ponownie pilot `k2`. T5 pozostaje **uruchomione, niezaliczone**: brak zaakceptowanego punktu niezerowego k, więc nie przechodzić jeszcze do pięciu punktów ani wykresu.

Job #134 (`f29dad61e46048ff934ada17e75cde53`) przyjęto do kolejki profilu `fem-cpu-slepc-runtime-v1`. Snapshot SHA `8a7b9ff2e8c91609a925055d31ee51ae3c3135090bef40873c40c3336c6ecd5f`, source digest `d90df5fb5da8eb13cd15326c1b44b527cd54dbd571645ca1ab636ffeab7e84a0`, stan początkowy `queued`; receipt jeszcze nie istnieje. Po zakończeniu builda i kontroli hashy powtórzyć tylko punkt `k2`.

Aktualizacja 2026-09-25 01:53 UTC: koordynator zalogował `job_claimed` o 01:40:48 UTC, a worker potwierdzono jako aktywny. Materializacja 7413 plików (304198252 B) i kontrola ich hashy trwały około 12 min; następnie pojawiły się logi `native-build` oraz procesy `make install-cli-dev` i Cargo. Job nadal `running`; końcowy receipt jeszcze nie istnieje. Nie uruchomiono pilota i nie wysłano duplikatu. Po buildzie nadal obowiązuje odbiór receipt/hashy, dry-run, a potem jeden rzeczywisty pilot `k2`.

### Aktualizacja T3/T5 — próba kontrolowanego `ncv` — 2026-09-25

Po wynikach #135 (EPS `DIVERGED_ITS`, 2000 iteracji; ostatni KSP zakończył się `KSP_CONVERGED_RTOL`) podjęto pojedynczą zmianę algorytmu Krylov–Schura: `ncv=min(N,max(32,2*nev))`, z `N` równym rozmiarowi real-split. Wartość rzeczywistą zwróci `EPSGetDimensions` i raportuje ją artefakt. EPS cutoff `1e-11` oraz obie bramki fizycznego residualu pozostają niezmienione. To hipoteza diagnostyczna o rozmiarze podprzestrzeni, nie zatwierdzona przyczyna plateau.

Job #136 `b1e00ef90b494fa08801036bd4d4f17a` (#136) jest `running` w istniejącej kolejce, profil `fem-cpu-slepc-runtime-v1`; source digest `1b7ee7adbeb2b83260277eb5285d7f2460b633ff5c7c74440d84d7173704f96b`, snapshot SHA `c26f2f6f2890cde8955398e91e9d4e50542d31a1d63a152965c67eea4ccf344c`, capture `f26b01f74dcd4d9ba49769873bb6b54b`, HEAD `4e7ab1528d008ed487c1ed2789f976ba6c8bf3af`. Bramka `runtime build → receipt/hash → dry-run → jeden k2` pozostaje otwarta. Nie ma zaakceptowanego punktu niezerowego k, porównania z analityką ani wykresu.

### Aktualizacja T3/T5 — wynik #136 i korekta statusu — 2026-09-25

Job #136 zbudował runtime-only CPU/SLEPc poprawnie (exit 0, source digest 1b7ee7adbeb2b83260277eb5285d7f2460b633ff5c7c74440d84d7173704f96b, snapshot c26f2f6f2890cde8955398e91e9d4e50542d31a1d63a152965c67eea4ccf344c). Kontrolowany większy ncv=32 został zmierzony przez EPSGetDimensions; następny pilot de-smoke-k2 zakończył się jednak failed, exit 1. Oba podokna wyczerpały limit 2000 iteracji (EPS_DIVERGED_ITS), przy nev=8, ncv=32, mpd=32, bez zbieżnej pary i bez częstotliwości.

Dynamiczny demag był włączony w operatorze modalnym (include_demag=true, floquet_airbox). Informacja demag_mode=none dotyczy wyłącznie kroku relaksacji LLG. Ostatni KSP w każdym oknie zbiegał się (KSP_CONVERGED_RTOL), ale EPS nie zwrócił eigenpary; nie wolno interpretować estymat błędu jako zaakceptowanego residualu fizycznego.

Próba ncv=32 nie odblokowała T3. T5 pozostaje uruchomione i niezaliczone: 0 zaakceptowanych punktów, 0 wierszy CSV, brak wykresu. Następny krok to odrębna diagnoza dokładnego operatora Schura Floqueta oraz preconditionera shift-invert; progi fizyczne pozostają bez zmian. Analityczna referencja dla t=10 nm, ky=2e6 rad/m wynosi 9.725724 GHz (otwarty film), a szacunek Gamma dla airboxu 2 µm wynosi 9.299250 GHz. Żadna z tych wartości nie jest wynikiem numerycznym Fullmaga.

### Korekta T3/T5 — kalibracja progu zamiast założenia `1e-8` — 2026-09-25

[Audyt tolerancji](../../audits/2026-09-25-de-residual-threshold-audit.md) zastępuje wcześniejsze traktowanie `1e-8` jako bezwzględnego wymogu fizycznego. To próg algebraiczny w konkretnej normie; nie wykazano jego konieczności dla żądanej dokładności częstotliwości ani nieosiągalności w double. Obecny cutoff EPS `1e-11` pochodzi z nieskalibrowanego mnożnika `1e-3`. #132–#136 pokazują stagnację obecnej metody, nie dowód granicy precyzji.

Korekta diagnostyki: `KSP_CONVERGED_RTOL` oznacza zbieżność według skonfigurowanej normy. Zapisywany `KSPGetResidualNorm` może być przybliżony/preconditioned; bez niezależnego `b-Ax` nie wyklucza błędu shift-invert. `PREONLY/LU` Poissona nie stosuje iteracyjnego `rtol`.

| Podzadanie | Sposób wykonania | Stan |
|---|---|---|
| T3-C1 | Zmierzyć true residual KSP, RHS, resolved stronę/normę, pełną wartość własną oraz defekt rekonstrukcji real-split | Do wykonania |
| T3-C2 | Jawna mała referencja oryginalnego Schura z demagiem i `B`, zgodność z MatShell; bez badanego shift-invert i bez ukrytego fallbacku produkcyjnego | Do wykonania |
| T3-C3 | Rozdzielić próg EPS od akceptacji, porównać `1e-6/1e-7/1e-8` przy kontrolowanej dokładności inner solves; ocenić błąd częstotliwości względem C2 | Do wykonania |
| T5-C4 | Policzyć 3–5 k po kalibracji; wykres może odróżniać punkty diagnostyczne od zaakceptowanych, z residualem każdego punktu | Do wykonania |
| T5-C5 | Oddzielnie potwierdzić zbieżność siatki/airboxu, identyfikację modów i adekwatność referencji `n=0` | Do wykonania |

Roboczy budżet do kalibracji: 1 MHz dokładności fizycznej oceny w okolicy 10 GHz, z wkładem algebraicznym ≤0.1 MHz. To propozycja, nie zmierzona niepewność ani bezpośrednie przeliczenie residualu na Hz. Jeśli jawny próg `1e-6` zapewni ten zapas względem niezależnej referencji i stabilny profil, można uzasadnić jego użycie w pilocie. Samo ustawienie `solver_rtol=1e-6` obecnie zmienia również EPS i KSP; bez rozdzielenia polityk nie jest kontrolowanym eksperymentem.

Nadal 0 punktów przyjętych przy żądanym `1e-8`. Kandydat #133 przy 9.723336272685 GHz pozostaje odrzucony w historycznym runie; może być pokazany jako wynik diagnostyczny z oznaczeniem jakości. Analiza, evidence JSON i korekta planu są wykonane; C1–C5 nie zostały wykonane w tej aktualizacji. Nie uruchomiono nowego buildu ani kompilacji testów.
