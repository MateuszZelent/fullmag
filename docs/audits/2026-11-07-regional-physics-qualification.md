# Kwalifikacja fizyki regionalnej — 7 listopada 2026

Stan etapowy. Kontrakt fizyczny: nota 0104. Kolejność dalszego wykonania określa
`docs/superpowers/plans/2026-11-07-regional-physics-qualification-and-fem-marker-map.md`.
Poniższe wyniki nie oznaczają ukończenia całej macierzy oddziaływań.

## Środowisko i recovery

Pierwsze pomiary: czysty commit `af6a066127b62be148020f92694989c91a7bd490`,
baza `master` po PR #408: `08820339454b6e31856dd0a9b858f3220978e9b1`.
Snapshot: `7455d442fe0413b8991495d916fe098478976422635ea3c78d0dd3d9c73ef63e`.
Grupa: `fullmag-worktree-fullmag-eacd36ead0850e14`, frontend na porcie 3345.
Build i API działają w stałym backendzie tej grupy. Źródła i common Git są
bindami WSL readonly; wybrane `examples` jest osobnym bindem script-output.
Backend, frontend i ledger mają prywatne subpaths jednego wolumenu grupy;
frontend nie ma dostępu do rootu control, backendu ani ledgeru.

Rozszerzony reconciler zamknął oryginalną awarię sieci bez zmiany dotychczasowych
kryteriów. Terminal/current `failed-confirmed` i zwolnienie `active`
potwierdzono osobnym odczytem. Development `0f8284392daa4426b6a895d03c467953`
zakończył się `succeeded`; config SHA-256:
`fc04753a928ed4705ddf5e02f70dcb4be3e7b5b918bdbef54c564e4300f89ecf`.

## Natywny FEM CPU z MFEM: DG0 i dokładny zbiór elementów

Sprawdzenie: `scripts/benchmarks/fem_dg0_analytic_abi_checks.py::main`.
Nie kompiluje binarium testowego. Ładuje opublikowaną bibliotekę, wymaga
tożsamości MFEM/HYPRE i potwierdza faktyczny device CPU. Wykonano je w backendzie
grupy, a dowody zapisano na ext4 WSL jako parę skrypt i samowystarczalny Zarr.

- MFEM 4.10, HYPRE 3.1.0; mesh ABI 2.
- Biblioteka FEM SHA-256:
  `2316522b5cccf9018db63985f8f9ee4320969328d65be57378ec434143b342f1`.
- Urządzenie: `mfem_cpu_exchange_ready`; HYPRE memory/execution: host,
  policy owner: `cpu_lane`.

| Kontrola | Oczekiwane | Zmierzone |
|---|---:|---:|
| Cztery zewnętrzne tetraedry, bez obcego centralnego | 1/2 | 0,4999999999999999 |
| Ten sam zbiór z duplikatami indeksów | 1/2 | 0,4999999999999999 |
| Sam centralny tetraedr | 1 | 1 |
| Cała siatka i starsza redukcja po pełnym zbiorze węzłów | 9/14 | 0,6428571428571429 |
| Pole wymiany z consistent mass i DG0 Ms | Niezależny oracle P1 | Maksymalny błąd względny 1,4638e-16 |

Oracle pola złożono osobno na ułamkach wymiernych dla geometrii pięciu
tetraedrów. Rozwiązanie bezwymiarowego `M d = K m` ma współczynniki
`[900,90,90,90,-840,-1480,-1480,-1480]/47`; skalowanie SI wynosi
`-2 A/(mu0 * 400000 * edge^2)`. Tolerancję `1e-8` ustalono przed pomiarem.
Nie wywołuje to buildera operatora Fullmaga jako wyroczni.

Zakres dowodu: inicjalizacja produkcyjnego MFEM CPU, początkowe pole wymiany
i redukcje obiektów DG0. Dynamika DG0, GPU i publiczna ścieżka API pozostają
odrębnymi bramkami. Pierwszy harness odmówił przed utworzeniem backendu z powodu
odczytu makr jako enumów; poprawiono parser. Zapis jako UID backendu ujawnił
brak praw do hostowego `examples`; dowód zapisano jako UID operatora 1000,
z grupowym odczytem biblioteki. Nie zmieniano praw całego checkoutu.

## Natywny FDM CUDA: ograniczone kontrole analityczne

`scripts/benchmarks/fdm_cuda_analytic_abi_checks.py::main` wykonano na RTX 4080
SUPER, w tym samym backendzie i pakiecie. Biblioteka FDM SHA-256:
`88ab77a5c11387359500d99a36e797ff1667417207dd38f33f291df3edd1ba2d`.

| Kontrola | Wynik |
|---|---|
| Energia MEL i gęstość energii, fp64 i fp32 | ΔE = −2,72e-23 J, gęstość −3400 J/m³; błąd względny 0 |
| Pole ścinające MEL przy Ms 800/400 kA/m | −1551,760695 / −3103,521390 A/m; iloraz 2, błąd względny 0 |
| Późny bind transportu z polami Ms lub alpha | Jawna odmowa `fdm_cuda_heterogeneous_material_unsupported:gpu_transport` |
| T0 i brak korekty dla wyrównanej powierzchni swobodnej | Zgodne z analitycznym polem; względna różnica około 1e-16 |
| Niezakwalifikowane T1 | Jawna odmowa `fdm_boundary_correction_t1_unqualified` |
| Całka gęstości energii wymiany dla komórki częściowej T0 | Zgodna z energią skalarną 1,04e-19 J; błąd względny 0 |

Dowód zawiera surowe stdout/stderr, źródło testu i nagłówek, hash biblioteki,
pakietu i inkarnację kontenera przed/po. SHA-256 stdout:
`26471bd3af0b910949df32ce9dc91b7ce728035ad39f34380e435a95259a274b`.
To kwalifikacja wymienionych kontroli ABI, nie całej ścieżki Python/API,
wszystkich integratorów, geometrii ani długich trajektorii fp32.

## Znaleziony bloker publicznego wykonania

Zarządzana aktywacja małego analitycznego przypadku FDM CPU została terminalnie
odrzucona przed Solve. Próba aktywacji `968e0dbfce044c4498977c4cfa6d94bb`,
request `regional-mean-cpu-20261107-01`: Python eksportuje przechwycone parametry
Run, ale odbiornik Rust odrzuca `integrator`, `fixed_timestep`, `sampling`
i pozostałe pola przechwyconego stage. Nie ponawiano requestu.

Właściciel P22 potwierdził istniejącą poprawkę w PR #411, commit
`6c67336b141fa2f500fcaf47fe62853aae47dc3e`. Należy wydzielić wyłącznie odbiornik
`script_imported` i jego regresję, zachowując konfigurację Pythona oraz ścisłe
odrzucanie ukrytej konfiguracji w zwykłym Run. Integracja i ponowne wykonanie
tego przypadku pozostają otwarte.

## Browser QA i dalsze bramki

Pierwszy browser QA odmówił podczas początkowej kompilacji strony; późniejsze
niezależne odczyty loopback potwierdziły HTTP 200. Drugi dotarł do aplikacji bez
błędów konsoli, ale świeża grupa bez sesji wróciła na Home i nie miała canvasu.
Nie jest to dowód WebGL. Następna próba ma nastąpić po opublikowaniu rzeczywistego
Study przez naprawioną ścieżkę API, bez wstrzykiwania fixture.

Dowody znajdują się obecnie w `examples/regional-qualification-20261107/`,
w parach `fem_dg0_analytic_abi_checks.py/.zarr` i
`fdm_cuda_analytic_abi_checks.py/.zarr`. Przed usunięciem worktree trzeba zachować
te pary poza usuwanym drzewem na WSL oraz uaktualnić lokalizację w rejestrze.
Pozostają: pełna macierz regionalna, publiczne wykonanie i browser QA,
mapowanie FEM, CI/integracja kolejnych zmian i kwalifikowany cleanup.

## Kontrolowany stop przed przebudową

Próba stopu `9bb673ef87ed4eb2a2cb494f2e6a5455` odmówiła przed drain:
preparation zawierało początek `1794071334511` i koniec `1794071277906` ms.
Różnica wynosi −56605 ms; przyczyny rozbieżności zegara nie ustalono.
Nie zmieniano surowych timestampów, receiptów ani ownera w celu obejścia odmowy.

Dodano wykonywalną regresję `scripts/test_docker_preaccepted_clock.py`.
Preflight odróżnia teraz porządek zegara jako metadane diagnostyczne; nadal
wymaga oryginalnego odrzucenia tej aktywacji, dwóch identycznych widoków API,
braku przyjętego run, pustej kolejki i command ledger oraz gotowego runtime.
Nie stanowi to dowodu drain — ten musi zakończyć się osobno. Testy: 3 nowe,
12 runtime-state i 25 stop-unadmitted PASS.

Ponowny managed stop-only zakończył się sukcesem:
`d8f675cacfa044488fd21ec5672bded3`. Bieżąca przebudowa i wykonanie naprawionego
Run pozostają do potwierdzenia. Pierwszy CI portu wskazał brak pomocniczego
parsera `payload_string_value`; zależność uzupełniono z tego samego źródła P22
wraz z regresją nieprawidłowego typu integratora.


## Kontynuacja w grupie WSL: publiczny CPU, geometria i tabele

Przebudowa/resume `a78de313e98a4b34af8b8ab71a12f2f2` zakończyła się sukcesem
na commicie `689816fd2bd4350944eb163b5f98a7f03e9f141a`, ze snapshotem
`45413df7a5a18badd41c3f21622fd1ee90dec26e4a751693af5ee5dcdcd772de`
(dirty: własne skrypty i wyniki kwalifikacji). Kontrakty bootstrap CI tego
commita przeszły, w tym Rust, Python, generated API i Control Room.

Próba CPU `regional-mean-cpu-20261107-02` została przyjęta, ale zakończyła się
`Permission denied` przy przygotowaniu output storage, **bez uruchomienia
solvera**. `total_steps=1` w tym widoku oznaczało zadanie, nie krok solvera.
Backend UID 65532 ma dodatkową grupę 1000 i zapis do `/state`; nasz nowy katalog
kwalifikacji miał jednak 0755. Wyłącznie ten katalog otrzymał zapis grupowy
(0775). Nie zmieniano praw całego `examples`, checkoutu ani storage.

Próba 03 wykonała dwa kroki, bez jawnego zapisu tabeli. Próba 04 została
poprawnie odrzucona za krokową cadence tabeli w physical-time Run. Próba 05
nie wystartowała: retirement nie umiał wyeksportować przechwyconego
`sampling.table_autosave`. Naprawiono odbiornik eksportu i odtwarzanie tabel
każdego Run. Review wykrył także dziedziczenie poprzedniej tabeli przy
missing/null oraz tolerowanie stringowego `every_steps`; obie uwagi mają
regresje i poprawki. Publiczne `study.tableautosave(enabled=False)` oraz
`fm.tableautosave(enabled=False)` wyłączają tabelę bez dodatkowego authored
stage. IR i OpenAPI zachowują dotychczasowy kontrakt.

Próba 06 wykonała solver, ale niezależna kontrola wykazała **mx=0 zamiast −1/3**.
Przyczyną była utrata przesunięcia regionu Box w SceneDocument → Python,
nie redukcja momentu. Dodatkowa regresja wykazała ten sam problem dla sfery
oraz utratę osi cylindra. Eksport zachowuje teraz center/axis, pełne CSG
oraz odmawia nieznanego typu zamiast podstawiać mały Box. Wykonywalne regresje
przeszły RED → GREEN. Pełny moduł round-trip: **64/64 PASS** w backendzie.
Dodatkowa próba pytest nie wykonała testów: obraz nie zawiera modułu pytest;
nie instalowano zależności na hoście.

Publiczna próba 07, aktywacja `9f4fce71118c40fe92ba5e9174024358`, run
`run-live-1e56b97d62bff28ba6a3d53d419735f5abc9145a1baa225f58cd5835b9b72683`,
zakończyła się na CPU/double po 2 krokach do 2e-14 s. Tabela w krokach 0/1/2
zawiera mx = −0,3333333333333333 przy Ms 400/800 kA/m; tolerancja 1e-12.
Surowe dane RED (06) i GREEN (07), pola Ms, stany, tabelę, mesh provenance,
skrypt i hashe zachowano w `fdm_moment_weighted_mean_cpu.zarr/qualification_evidence`
obok skryptu na WSL. Biblioteki aplikacji pochodzą z powyższego pakietu;
Python renderer korzystał z live bind źródeł opisanych tą poprawką.

Browser QA `8d9e3d994aa6417ca976d23d3ab087c2`: **PASS** dla istniejącej sesji,
Home round-trip, widoczny WebGL2 canvas 617×495, drawing buffer 617×495,
context_lost=false przed/po, brak błędów strony i konsoli. Renderer przeglądarki
korzysta z SwiftShader; to dowód lifecycle canvasu, nie sprzętowego renderingu
RTX ani materializacji wszystkich pól. Nie powtarzano Solve w QA.


## Rozszerzony natywny FDM CUDA: wariacja, energia i lokalna alpha

Harness `scripts/benchmarks/fdm_regions_interaction_abi_checks.py` wykonano
w tej samej grupie, biblioteka FDM SHA-256
`6ef5859d1b732eb1477b5eed5b6c7b677bcb9939457a65b16cf5323ab617d72c`.
Dwie komórki mają Ms 400/800 kA/m, alpha 0,1/0,4 przy odmiennych wartościach
scalar fallback. Przypadki zmieniają także lokalne Ku1/Ku2, Kc1/Kc2/Kc3 i A.

| Kontrola | Zakres | Wynik i zadana tolerancja |
|---|---|---|
| Pochodna energii na sferze jednostkowej | Zeeman, uniaxial, cubic, MEL, exchange uniform/local A, iDMI+exchange, bulk-DMI+exchange; fp64/fp32 | 16 PASS; max 9,55e-11 / 2,59e-5 przy limitach 1e-7 / 3e-3; epsilon 1e-5 / 1e-3 |
| Niezależne różnice energii z wielomianów not fizycznych | Zeeman, uniaxial, cubic, MEL; fp64/fp32 | 8 PASS; max 1,96e-16 / 1,14e-8 przy limitach 1e-12 / 1e-6 |
| LLG w stałym polu +z, m(0)=+x, lokalna alpha | Heun, RK4, RK23, DP45, ABM3; fp64/fp32; 100 kroków po 1e-14 s | 10 PASS; max błąd składowej 7,21e-13 / 2,43e-8 przy limitach 5e-8 / 1e-5 |
| Raw demag bez widm Newella | fp64/fp32 | 2 oczekiwane odmowy; **fizyka demagu NOT VERIFIED w tym harnessie** |

Lokalne A wymaga rzeczywistego ABI v2 FACES; starsze wejście z a_field
prawidłowo odmówiło. Połączenie ma niezależnie obliczoną harmoniczną średnią A.
Osi długości 1/2 użyto ze swobodnymi brzegami, bez PBC. Test nie kwalifikuje
planera, wszystkich DMI/geometrii, adaptacji ani długiego horyzontu fp32.
Błąd harnessu podczas rozbudowy nadpisywał zmienną tolerancji gradientu
ostrzejszą tolerancją energii; rozdzielono nazwy bez zmiany kryteriów odbioru.

Pięć unit checks wyroczni i pomiaru: PASS; wykrywają podmianę lokalnego Ms,
czynnik 2, NaN oraz nieinformatywny zerowy gradient i sprawdzają invariants LLG.
Surowy raport SHA-256
`ffb9614bc8c3d23115895abbf583d1c7613b9cc13c7fafc536eacfae9fc125cf`
zachowano w parze `fdm_regions_interaction_abi_checks.py/.zarr` na WSL,
wraz z wejściami, kodem, nagłówkiem i hashem biblioteki przed/po.


CI dokumentacji dla `067fbd11c3c600e07d64500e1c1c74a907f24d56` wykryło
niepoprawny zapis dwóch symboli w source-map i brak dwóch wierszy indeksu 0910.
Poprawiono odwołania na jednoznaczne `class GradientMeasurementTests` i
`class StudyBuilder` oraz uzupełniono indeks. Walidatory obu zmienionych
manifestów źródłowych zakończyły się kodem 0. Nie zmieniano kryteriów naukowych.


## Publiczna macierz CPU/CUDA i wznowienie fp32

Plan wejść `public_matrix_plan.json` przypiął 20 jawnych skryptów, pięć przypadków
(two_materials, two_materials_scaled, uniform, uniform_regions, grains=1000)
oraz limity istniejącego benchmarku przed pomiarem. Pierwszy fixture a1 został
odrzucony bez solvera: `.autosave(...)` należy do `study.stages.add_run`,
nie do zwracanego przez `study.run` obiektu Problem. Poprawione 20 fixture a2
przeszło lekkie wczytanie w backendzie; pierwotny plan zachowano.

Pierwsza para two_materials CPU/GPU double: **PASS** przez publiczne API,
demag + Zeeman + lokalne Ms/A/alpha + jawna wymiana między regionami.
Zakończono czas fizyczny 2e-11 s: 2000 nominalnych kroków i jeden krok końcowy
wynikający z akumulacji roundoff, łącznie 2001 zaakceptowanych kroków. Dla CPU
ostatni dt wynosi 5,9454e-25 s; terminalny GPU snapshot raportuje dt=0,
co nie jest pomiarem ostatniego rzeczywistego dt. Nie nazywamy tego dokładnie
2000 zaakceptowanymi krokami. Wejścia fizyczne planów porównano jako równe.

- CPU run: `run-live-e590d6537da4bd87bbed1f049db0252dd849629dc4203e6b5161ef3c50bb6fe2`.
- GPU run: `run-live-747b743829aec80e2b35bbb583a6aef6089e522fdde6843b34a02c11d4e7736a`.
- max |dm| = 3,3865e-8 przy limicie 1e-6.
- max względna różnica porównywanych energii = 5,3303e-11 przy limicie 1e-8.
- Moment początkowy odtworzony niezależnie z M i lokalnych wag Ms: zgodny
  z tabelą do 1e-12. CPU ma dodatkowo zgodność readback Ms z planem; GPU
  nie publikuje tu readback tablicy materiałowej, więc jego wagi pochodzą
  z zaakceptowanego planu, a poprawność wykonania wspiera parytet pól/energii.
- CPU: energia maleje w pełnym śladzie 2001 zaakceptowanych kroków, także
  względem stanu początkowego. GPU zapisuje w tym biegu tylko trzy obserwacje
  (0/2000/2001); monotoniczność tych próbek nie jest dowodem dla każdego kroku.

Surowe stany, pola, tabele, konfigurację, mesh/provenance i hashe wyeksportowano
na WSL do odpowiednich par `regional_two_materials_*_double_long.py/.zarr`.
Krótki CPU/double 10 kroków również zakończył się i zachował dane. Kampania
zatrzymała się na następnym GPU/single, zanim rozpoczęła pozostałe przypadki.

Próba `regional-matrix-a2-two_materials_gpu_single_short`, aktywacja
`6a7ecb46f4f345be9378b42717e5fb57`, run
`run-live-1f0e8d9f30edb2d597cde8cdd6ab803831d46a7e2ad2d28d8cd769a6a09385dd`
została przyjęta przez API, ale worker odmówił **przed rezerwacją attempt i
uruchomieniem solvera**: `accepted worker currently supports only FDM CPU/GPU
double strict`. Nie było fallbacku ani replay. Przygotowanie i diagnostyka
znajdują się w sąsiednim Zarr tego nieudanego przypadku.

Źródłowa poprawka wiązania request/IR/plan/precision policy dopuszcza tylko
single-grid GPU/single w strict i zachowuje odmowy CPU/single,
multilayer/single oraz frozen terminal/single. Dodano trzy testy Rust
legalności i mismatch oraz ich bramki CI. Review źródeł: bez uwag.
Kompilacja poprawki oraz pierwszy publiczny GPU/single: **PASS**. Po ponowieniu
kontroli uprawnień oficjalny drain/stop `c2841aa5a57e484bb79fe6540f66fcc9`
zakończył oba kontenery z exit code 0 i PID 0. Resume
`51ed941194ca487e8fd5189169a842bd` przebudował aplikację w tym samym backendzie
(`cache_hit=false`), na HEAD `0f4479a7d84ac87442d758eaaabdedc7471aa90b`
i dirty snapshot SHA-256
`6dc3881503622a317d682a585af26f9094a0b60350ae7b9f6836e9df46d4d54f`.
Nie zmieniono grupy, container ID, źródeł WSL ani granic mountów.
Nowe testy Rust nadal wymagają wykonania w CI po commicie tego etapu.

Nowy request `regional-matrix-a3-two_materials_gpu_single_short`, run
`run-live-20b780ac4eda0d9870b0efd28d923e1b9b3f550d20baab15d52a545cc11ae66c`,
zakończył 10 kroków i porównanie z zachowanym CPU/double. Max |dm| = 1,8382e-7,
max względna różnica energii = 1,3847e-7, względne różnice H_ex/H_eff =
1,6531e-7 / 1,5959e-7, poniżej wcześniej przyjętych limitów 1e-5.
Receipt potwierdza CUDA, brak fallbacku i operatorów host/unknown, single
storage/compute/FFT oraz double reduction. Kanoniczny transfer pól f64
nie stanowi deklaracji wewnętrznego wykonania fp64.

Kampania phase2 zachowuje trzy wcześniej zaakceptowane lane i uruchamia
pozostałe żądania sekwencyjnie; nie odtwarza starej odmowy a2 GPU/single.
Dla two_materials_scaled również przeszły oba porównania: fp64 max |dm|
6,1163e-8 i max względna różnica energii 6,6033e-11; fp32 max |dm|
1,8385e-7, energia 1,1006e-7, H_ex/H_eff 1,6534e-7 / 1,5757e-7.
Przypadki uniform i uniform_regions przeszły zarówno fp64, jak i fp32;
max |dm| względem CPU wynosi odpowiednio 7,7993e-8 i 1,8944e-7. Największa
względna różnica energii to 6,0030e-9 dla fp64 i 1,9282e-7 dla fp32.
Osobne porównanie uniform z uniform_regions w każdej z czterech ścieżek
również przeszło: max |dm| = 0, max względna różnica energii 1,0050e-14,
a H_ex/H_eff w fp32 są identyczne. Tolerancje tego porównania zapisano
w `uniform-invariance-plan.v1.json` przed wykonaniem przypadków uniform.

Krótki przypadek 1000 ziaren CPU/double–CUDA/single również przeszedł;
pełne długie porównanie ziaren i osobny dowód Compute Fields z zaakceptowanego
stanu fp32 są jeszcze **NOT VERIFIED**. Stan i surowe dowody są zachowywane
w Zarr kampanii phase2 oraz phase3 na ext4 WSL.

## Dodatkowa natywna kontrola PBC, singleton axes i u32

`scripts/benchmarks/fdm_regions_pbc_abi_checks.py`: **52 przypadki PASS**.
Osie o długości 1/2, wszystkie trzy orientacje pary, włączana okresowość
osi singleton, etykiety [0,u32::MAX]/[257,1] oraz lokalne A/FACES. Pole i energię
porównano z niezależną wyrocznią jednej/dwóch krawędzi. Tolerancje przed pomiarem:
1e-12 dla fp64 i 1e-6 dla fp32. Maksymalne błędy względne fp64:
H 8,99e-17, E 1,16e-16; fp32: H 7,38e-8, E 0.

Review wykrył błąd harnessu pod `python -O`: assert usuwał także wywołanie
snapshot i kontrole. Nowa regresja z błędem native oraz niepoprawnym H/E dała
2 RED subcases, potem GREEN po zmianie na jawne wywołania i `if: raise`.
Rzeczywiste 52 przypadki pod `python -O` także PASS. Początkowy raport bez
optymalizacji zachowano (SHA 48030973953d98c06ff15d1f7d19c9e009f07f2770813f69a15ca3dfa6c31d5b);
raport po poprawce z optymalizacją:
`7883ba7b71a946f65f2cf182cef8678f90b4fad151fe82dab4ee4e0e03db2f59`.
Oba mają samowystarczalne pary skrypt/Zarr, nagłówek i źródła helperów na WSL.
Biblioteka pozostaje `6ef5859d1b732eb1477b5eed5b6c7b677bcb9939457a65b16cf5323ab617d72c`.
Ponowny niezależny review poprawek harnessu również nie uruchomił się z powodu
`builder error`; wynik testów jest odrębnym dowodem. Publiczna bramka
GPU/fp32/PBC pozostaje bez zmian. To nie jest kwalifikacja całej macierzy,
większych siatek okresowych ani zakończenie mapowania FEM.


## Narzut obserwacji CPU ujawniony przez 1000 ziaren

Kampania phase2 zachowała 16 ukończonych wykonań. Długi CPU/double dla ziaren,
request `regional-matrix-a2-grains_cpu_double_long`, run
`run-live-104b64b087045c7bb5e4bf8b662e2ad0277e0c66efb78723c588395ec5320123`,
zatrzymano jedną oficjalną komendą Stop przypiętą do API/session/run.
Obserwator potwierdził terminal `cancelled`; anulowania nie uznano za sukces
fizyki. Zachowano częściowe M/H_ex/H_eff, energie i telemetrię 493 kroków
(17 plików, 70 232 960 bajtów) w `performance_baseline_red` sąsiedniego Zarr.

Mediany dodatnich kroków: callback 2,5830 s, raport solvera 0,1504 s,
`field_copy_wall_time_ns` 2,3855 s. Ostatnia nazwa obejmuje materializację pól,
nie tylko memcpy ani samą metrykę `preview_wall_time_ns`. Źródłowo dwa pola
pełnego capture tworzyły nowy FftWorkspace z jądrami Newella przy każdym
stanie. Poprawka utrzymuje osobny, dopasowany do geometrii workspace obserwacji
przez bieg, bez zmiany integratora, lokalnego Ms ani kadencji wyjść.

Nowa regresja porównuje świeże i ponownie użyte pola/gęstości dla dwóch stanów,
lokalnego Ms i nieaktywnych komórek oraz sprawdza lifecycle i oddzielenie
liczników solvera. Review źródeł bez konkretnych uwag. Kompilacja i runtime
poprawki: **PASS**, resume `435c60d597bd4dc99c0915259e6f9815`,
HEAD `bee88a7b6a88fffa39e627fb1789e17e830efe9e` i dirty snapshot SHA-256
`afc3613400276fac1475b17099ed853290935856e765c11c25aa22d0e60e7d1c`.
Kontrakt FEM Poisson przeszedł; testowana i opublikowana biblioteka mają
identyczny SHA-256. Nowa regresja Rust wymaga jeszcze wykonania w CI.

Przed nowym buildem przypięto limit mediany materializacji najwyżej połowy
baseline. Dziesięć dodatnich zaakceptowanych kroków nowego problemu z tymi
samymi wejściami dało **95,8049 ms**, stosunek **0,04017** do baseline,
czyli około **24,9 razy krótszą** materializację. Gate: **PASS**.
Jest to pomiar ścieżki obserwacji DEV, nie kwalifikacja przepustowości release
ani czasu samych kerneli GPU. Wejścia, kadencja i tolerancje fizyczne pozostały
te same. Nowy krótki CPU run:
`run-live-991ea1adb0960e73fa664a3682d31a4ea2d1c6e58efa642fa8b2756dc91e271f`.

Krótki CUDA/single dla 1000 ziaren również zakończył się **PASS**, run
`run-live-fcabe337235f0e66732d28e63c97071a1105527899f492e961354acd5bb86e45`.
Max |dm| = 2,0305e-7, max względna różnica energii = 7,2792e-8,
H_ex/H_eff = 1,9927e-7 / 2,1468e-7, poniżej limitów 1e-5.
Tym samym wszystkie pięć krótkich porównań fp32 przeszło; globalne maksima:
|dm| 2,0305e-7, energia 1,9282e-7, pola 2,1468e-7.
Phase3 zachowuje 16 wcześniejszych lane i dwa nowe krótkie lane ziaren.
Długi CPU ma nowy request `regional-matrix-a3-grains_cpu_double_long`;
anulowany request a2 nie jest odtwarzany. Długie porównanie ziaren nadal trwa,
a osobna kontrola 1000 zwycięskich regionów i ich wartości materiałowych
pozostaje wymaganą bramką po ukończeniu wszystkich czterech lane.

## Niezależna kontrola ujawniła brak jawnego sharp w benchmarku

Macierz phase3 ukończyła **20/20 wykonań**, a końcowy odczyt potwierdził
rzeczywiste CPU/rustfft i CUDA oraz brak fallbacku. Dla ziaren po 2000
nominalnych krokach max |dm| = 2,7145e-7, max względna różnica energii =
9,5064e-11. Dodatkowe porównanie pól fp64 dla wszystkich pięciu przypadków
również przeszło: max względny błąd 1,8973e-7 przy limicie 1e-6.

Jednak niezależna wyrocznia wartości materiałowych odmówiła kwalifikacji
**ostrych** ziaren. Maska ma poprawnie 1000 ID po 64 komórki, ale pierwszy Ms
wynosi 855 283,3820 A/m zamiast zadanego dla ziarna 874 632,5657 A/m.
Powód: benchmark odziedziczył udokumentowaną politykę
mesh_relative(cells=3, scope="boundary"). Film ma jedną komórkę grubości;
waga mieszania pierwszego ziarna wynosi 20/27. Ten sam wpływ dotyczy A i alpha.
Nie jest to dowód błędu domyślnej polityki solvera: domyślne wygładzanie jest
jawnie opisane w nocie 0104, sekcja 2.4. Błąd dotyczył doboru fixture do oracle.

Wyniki phase3 pozostają ważnym dowodem parytetu dla **rzeczywiście wykonanych
przejść wygładzonych** i nie są promowane do kwalifikacji ostrych współczynników.
Raport odrzucenia zachowano jako grain-cardinality-rejection.v1.json.

Benchmark teraz jawnie ustawia material_transition(kind="sharp") przed
nadpisaniem materiału. Nowa wykonywalna regresja publicznego skryptu do IR
pokazała RED dla wszystkich trzech przypadków niejednorodnych, następnie GREEN.
Odrębna kampania sharp ma 12 nowych wejść/requestów: dwa rodzaje pary materiałów
i 1000 ziaren, CPU/double oraz CUDA/double i CUDA/single. Każdy lane musi przed
zaliczeniem przejść niezależną kontrolę wszystkich wartości Ms/A/alpha
i przestrzennego przypisania. Kadencja i tolerancje parytetu nie zostały
poluzowane; niezmienione przypadki jednorodne zachowują poprzednie dowody.
Ostra macierz została następnie zweryfikowana w kampanii phase2 opisanej poniżej.

Pierwszy nowy lane sharp zakończył solve, ale dokładna wyrocznia wykryła jeszcze
zaokrąglenie przy kanonicznym eksporcie: Ms 874632.565711 zamiast
874632.5657107424, analogicznie A i alpha. Jest to niezależny problem round-trip,
wynikający z użycia formatera .12g w eksporcie współczynników. Wyrocznia nie
została poluzowana. Poprawka wykorzystuje istniejące renderery z dokładnym
repr dla parametrów materiału, lokalnych pól, szerokości przejść i sił sprzężeń.
Nowa regresja stałego/liniowego/radialnego pola przez eksport Problem i Scene
pokazała RED w sześciu podprzypadkach, następnie GREEN na źródłowym SDK.
Test podaje jawnie oś anizotropii, aby nie utożsamiać braku wartości z jej
kanonicznym domyślnym wektorem.

Pierwszy GREEN dotyczył źródłowego SDK. Następnie oficjalna przebudowa z commita
`73960796d3e3d55058d95ebbcb3fb79a60c07419` zakończyła się **PASS**, resume
`6e5646a475a840e08dee6ed781300a54`. Snapshot SHA-256:
`1466ee3b76f155b3b115dfeb9c12915b41c8ca725988c0edd849fa6de8eb0a5d`;
receipt buildu SHA-256:
`dc97b29c2e70dffac327abdf7153247dbd244b83af4635b5f17fc2d32778b52d`.
Test dokładności przeszedł również na domyślnie importowanym SDK opublikowanego
pakietu. Kontrakt FEM Poisson przeszedł, a testowana i opublikowana biblioteka
FEM mają identyczny SHA-256:
`7fbbe7ec92e601791d150155c8d428625d8c7f17f74eae995a617e761cb926e8`.

Nowy request sharp CPU a2 przeszedł dokładną kontrolę 192 000 wartości
Ms/A/alpha, 1000 zwycięskich ID po 64 komórki oraz momentu ważonego Ms.
Run: `run-live-de412fa0b84d821c3736e49fb13cd01e05d5139567de883b24e2a5175216f12e`.
Odpowiadający CUDA/single również przeszedł: max |dm| = 2,1725e-7,
max względna różnica energii = 7,2801e-8, pól = 2,2077e-7 przy limitach 1e-5.
Run: `run-live-bdacbeb432084004d246e775e7205e4941a7dc2931d8dce0560dcfca2d933f23`.
Dowody: `regional_public_sharp_matrix_phase2_campaign.zarr` i sąsiednie Zarr
poszczególnych skryptów na WSL. Pierwszego odrzuconego requestu a1 nie odtwarzano. Poprawka dokładności SDK
w runtime: **PASS**. Kampania phase2 ukończyła **12/12 lane** i sześć porównań;
końcowy niezależny odczyt potwierdził requested/resolved/actual CPU lub CUDA,
precyzję, brak fallbacku i tę samą partycję właścicieli regionów. Wszystkie
wartości materiałowe i przestrzenne przypisania przeszły dokładną wyrocznię.


| Sharp: porównanie | Max norma Δm | Max względna różnica energii | Max względna różnica pola |
|---|---:|---:|---:|
| grains_short | 2.17240e-07 | 7.28007e-08 | 2.20761e-07 |
| grains_long | 3.28816e-07 | 3.04454e-10 | 3.05711e-07 |
| two_materials_short | 1.70226e-07 | 2.52374e-07 | 1.92910e-07 |
| two_materials_long | 5.95728e-08 | 1.96518e-09 | 5.56560e-08 |
| two_materials_scaled_short | 1.86185e-07 | 7.77028e-08 | 1.72623e-07 |
| two_materials_scaled_long | 5.61399e-08 | 4.58375e-10 | 4.05960e-08 |

Limity nie zmieniły się: fp64 |Δm| ≤ 1e-6, energia ≤ 1e-8, pola ≤ 1e-6;
fp32 wszystkie trzy ≤ 1e-5. Długie pary obejmują 2000 nominalnych kroków
RK4 po 1e-14 s, krótkie dziesięć kroków. Snapshot końcowy GPU z dt=0
nie jest krokiem solvera. Ślad dyssypacji CPU obejmuje zaakceptowane kroki,
a rzadsze próbki GPU nie dowodzą monotoniczności na każdym kroku.

To kwalifikacja wymienionych konfiguracji FDM; nie zastępuje brakujących
publicznych odmów, materializacji/recovery fp32 ani mapowania i zbieżności FEM.

## Publiczne odmowy: wykryta utrata termiki w Scene

CPU/single odmówił przed utworzeniem runu: `accepted_execution_plan_invalid`,
HTTP 422, `execution_precision='single' requires a CUDA device`. Dowód zachowano
przy `regional_reject_cpu_single.py` w sąsiednim Zarr.

Heterogeniczny CUDA/double z `ThermalNoise(300, seed=17)` nieoczekiwanie
zakończył Run, zamiast dojść do istniejącego zakazu termiki.
Run: `run-live-7153c7517cccdef723b62512d08159cbc4c17a21d63d16a84992234feb8e33c9`.
Loader oryginalnego skryptu zachował ThermalNoise, ale builder/Scene pomijały
konfigurację i zaakceptowany plan nie zawierał termiki. Ten wynik jest
**odrzucony jako dowód fizyki stochastic**, nie stanowi obsługi termiki CUDA.
Zachowano 25 plików naukowych (2 643 266 B), źródło, hashe i diagnozę w
`regional_reject_cuda_heterogeneous_thermal.zarr/thermal_intent_red`.

Nowa regresja pokazała brak termiki w Scene oraz zaokrąglenie temperatury przez
bezpośredni eksporter Problem (RED czterech podprzypadków). Poprawka przenosi
typowane study.thermal_noise, z dodatnią skończoną temperaturą i opcjonalnym
seedem. Seed jest decimal-string w Scene/builder/API, co zachowuje pełne u64
w JS; w DSL i ProblemIR pozostaje integer. Missing override zachowuje termikę,
null ją usuwa; parametry zmieniają tożsamość fizycznego modelu.

Źródłowe kontrole w usługach grupy: cztery testy Python termiki **PASS**,
321 testów API Python **PASS**, dwa testy TypeScript payload/history **PASS**,
15 kontraktów workflow **PASS**, source-map i gate dokumentacji **PASS**.
Review bez konkretnej usterki. Rust, regeneracja API i wdrożenie poprawki
w pakiecie wymagają jeszcze zarządzanego buildu; publiczna odmowa termiki
po tej poprawce pozostaje **NOT VERIFIED**. Oryginalnego requestu nie ponawiać.

Przebudowa poprawki termiki: resume `f49aab3221444367b4c608a44545186d`,
HEAD `6367397a08248516aa3c0aab62f2d1c349f0d82d` z roboczą deltą; snapshot
`c817339af77c0428bc3bae2356012cd67dabce04b9d44f4bb07a89c281996109`.
Receipt buildu SHA-256
`02ed0ba5422237867a19e16b5d3e7fc67a74ad25c8385460439e82dde90848eb`.
Natywny kontrakt Poisson **PASS**, SHA-256 biblioteki testowanej i opublikowanej
`4bbc8a784c86954823029ca9813ad53bac94c939e09f9a967f6e3f0e107d01e2`.
Zarządzana regeneracja OpenAPI/TS **PASS**, schema SHA-256
`476819958270f2bc7932e82a9b4451ea766f1be6c421d82dc74c3fd02c81069e`;
receipt codegen `e12613eb454998ef2a2edea447787026ae355fbead80d8cc639dd1ca68f07ac3`.
Regeneracja modeli Python w usłudze frontend i kontrola zgodności nie wymagały
zmian (study zachowuje tam ogólny typ). Typecheck Control Room **PASS**.

Nowy request termiczny a2 został odrzucony wcześniej niż oczekiwano: ścisła
allowlista `scene_document_ir.py` pomijała nowe pole. To pominięty konsument
poprawki, nie poprawna odmowa fizyki. Rozszerzona regresja rzeczywistego
`scene_document_to_execution_config` wykazała RED dla seed 17, u64 MAX i entropy,
po uzupełnieniu allowlisty GREEN. Helper publicznego DEV wykonuje tę ścieżkę
z live bindu źródeł WSL; nowa publiczna próba ma odrębne ID a3.
Nie kopiowano zmian do shadow/pakietu. Samodzielna kopia SDK z pakietu wymaga
jeszcze synchronizacji przy następnym oficjalnym buildzie; nie utożsamiać jej
z rozszerzonym źródłowym GREEN. Publiczna próba a3: **PASS** — HTTP 422, accepted_execution_plan_invalid,
`fdm_cuda_heterogeneous_material_unsupported:thermal`, bez dopuszczenia runu.
Dowód: `regional_public_thermal_refusal_a3.zarr`.

## Materializacja i odtworzenie terminalnego stanu fp32

Nowy, odrębny fixture `regional_fp32_materialization_gpu_single.py` wykonał
10 nominalnych kroków (11 zaakceptowanych z końcową różnicą zaokrągleń czasu),
4096 komórek, CUDA/single/strict, bez fallbacku. Run:
`run-live-d866e9a6a74b1dd193dae325ed41717e67c53c5565dccac97def225cce76f64e`.
Receipt potwierdza single storage/compute/FFT i double reduction. Moment
ważony Ms odpowiada początkowej magnetyzacji. Fizyczny czas końcowy 1e-13 s.

Pierwsza próba QA `d3b5cbe295b641e1ae93efbea2e7d9b0` zakończyła się
failed-confirmed na loopback probe podczas zimnej kompilacji frontendu;
scenariusz komendy nie został wykonany. Po potwierdzonym HTTP 200:

- QA `9b981c8ecf4c40358ec04dbb85bad247`: **PASS**. Jeden POST compute_fields,
  utrata zaakceptowanej odpowiedzi, jeden intent/command w journal, UI pending
  → completed, zero Solve. Command `fm-d857481c-4fec-4833-ad34-738c0a6e18d6`
  zachowuje requested/resolved GPU/single/strict i engine fdm_cuda.
- QA `397003e396894e099e6b3d11b562be5d`: **PASS**. Po page.reload ten sam API
  instance, session i run, source_step=11, energia 5.000430118880073e-16 J
  zgodna między status/run/scalars i widoczną stopką. Brak ponownego Solve.
- Canvas WebGL2 widoczny, drawing buffer 617×495, context_lost=false.
  Renderer SwiftShader; nie jest to dowód renderowania przez RTX.

Źródła, dane runu i wybrane wyniki przeglądarkowe z PNG są na WSL w sąsiednim
Zarr, pod `qualification_evidence` i `publication_browser_proof`. SHA-256
wyniku Compute Fields `615d7f842507123da73b90449b1069b51aa90182a542b37b8ea549314526aafa`;
reload `c2e9bb9eab6d692e7affe6de2bb98b7aa4387714a019a78a738a562062c8849d`.
To dowód publikacji i odzyskania komendy/stanu, a nie sam w sobie dowód świeżej
reewaluacji kernela dla każdego pola — poprawne zachowane dane nie były
usuwane w celu wymuszenia takiej ścieżki. Numeryczny parytet pól fp32
kwalifikuje osobna macierz i testy analityczne.

Pozostają zwarte mapy FEM wraz ze wszystkimi konsumentami, wspólna relaksacja
i zbieżność FDM/FEM, synchronizacja kopii SDK przy następnym buildzie oraz
CI/review/integracja i kwalifikowany cleanup.

## Zwarte markery FEM — runtime 8 listopada

Poprzedni wpis o brakujących mapach FEM jest historyczny. Mapy osobno dla
regionów domen i faset należą teraz do importu/kontekstu. Publiczne u32,
kanoniczne fingerprinty i liczba stopni swobody pozostają zachowane;
wewnętrzne atrybuty MFEM mają rozmiar 1..R, a obecne zero ostatni atrybut.
Przeniesiono BC Poisson i PBC, modalne airbox/Floquet, transport/terminale,
accepted-source digest, selektory oraz Python/IR/NPZ/Gmsh/COMSOL. Legacy
transport zachowuje domeny per-element dla swoich współczynników.
Nowe create_v5/descriptor_v4 zachowuje pełny u32 selektora Poisson przed
inicjalizacją; stare layouty 1616/1640/1656 bajtów pozostają zgodne.

Oficjalna przebudowa w tej samej grupie WSL zakończyła się **PASS**:
resume `97e662e5c6e34dfbbf7c57a9f851687d`, snapshot
`de74c7f8f7924d6171b67b3be3f24184fb422785b7527370206446e4deec86fe`,
native contract `263de806dcce4c11a3e789cf516e73c0`. Biblioteka FEM SHA-256
`173dfad1a2a7ba358fc952584d00acedeedcfdf2bc3afe8d756d6adcc391d7bb`,
plik testowy `e0b46c42a3bf0aef4f84706f87aa92e8ad63f4009a9c8b25e6147a9833a63d4c`.
Poprzednie nieudane próby zachowano. Obejmowały brakujące ordinale fixture,
nieaktualny stable-vertex version/source assertions i konflikt dwóch
process-lifetime urządzeń MFEM w harnessie. Testy publicznego CPU/GPU ABI
uruchamiają się teraz w oddzielnych procesach, z kontrolą kodów wyjścia.

- Import MFEM: 255/256/257/1000, rzadkie ID do UINT32_MAX, rozróżnienie
  domen i granic 0/1, permutacje, powtórzenia, reimport i odmowy — **PASS**.
- CPU oraz GPU/double: niezależne H_ex/E_ex, jeden RK4 i centralna pochodna
  energii; marker 1 vs UINT32_MAX daje identyczną trajektorię — **PASS**.
  Maksymalny względny błąd H 2,89e-16 i E 5,21e-16. Względny błąd pochodnej
  energii CPU 2,39e-10, GPU 8,47e-11 przy epsilon=1e-6 i progu 1e-6.
- Robin/Dirichlet: wysoki selektor u32 vs legacy99, H i energia,
  brak selektora, zły rozmiar/reserved i ujemny legacy — **PASS**.
  Strict GPU: required/device=449 lub 975, accepted=1, fallback/host/unknown=0.
- Charge ABI 14 przypadków i steady ABI 9 przypadków — **PASS**, w tym
  per-element sigma przy powtarzanych markerach, reverse-canonical rekord,
  wysokie terminale i pełne wektorowe warunki brzegowe M2.
- Publiczny Python: pełny u32 i legacy NPZ/fingerprint, sidecar Gmsh/COMSOL,
  air0+UINT32_MAX, nazwa geometry airbox, lead selectors — 7/7 **PASS** w
  kontenerze; persistence 27/27 i script builder 64/64 **PASS**.
- DG0 z domain/facet UINT32_MAX — **PASS**. Dokładny zbiór elementów daje
  moment 1/2, suma węzłów 9/14, consistent-mass H: błąd 1,47e-16.

Wyniki naukowe: `regional_fem_compact_marker_native_a1.zarr` oraz
`regional_fem_dg0_high_u32_a1.zarr`, z sąsiednimi skryptami i hashami na WSL.
Pełne techniczne logi/receipty buildu pozostają w volume grupy. To kwalifikacja
zmierzonych przypadków, bez FEM/single ani rozszerzenia DG0 GPU.

## Wspólna zbieżność FDM/FEM

`regional_fdm_fem_convergence_a4.zarr` — **PASS**, również z `python -O`.
Nowa regresja sprawdza przy optymalizacji odmowy native query, brak dowodu
CUDA oraz NaN energii. Obowiązkowe wywołania ABI i bramki nie używają assert.
Pręt 64×4×4 nm, dwa regiony 257/UINT32_MAX, DG0 A/Ms o stałym ilorazie,
Neumann x, periodyczne y/z, RK4 100×1e-14 s. Kryteria z noty 0104 zachowano.

| Metryka na siatce 32 | FDM CUDA/double | FEM CPU/double |
|---|---:|---:|
| Względny błąd energii, początek/koniec | 0,0033044 / 0,0031511 | 0,0033044 / 0,0034500 |
| Względny L2 pola, początek/koniec | 0,0040473 / 0,0039382 | 0,0040706 / 0,0039597 |
| Względny błąd amplitudy końcowej | 7,4870e-5 | 7,5099e-5 |

Różnica amplitud między metodami dla 8/16/32 wynosi
0,00239535 / 0,00059983 / 0,00014997; maleje około 4× na zagęszczenie.
Norma i monotoniczność energii spełniają przypięte progi. Receipt FDM
potwierdza CUDA, required/device=163, brak fallbacku i host operators;
FEM potwierdza mfem_cpu_exchange_ready.

Pierwszy skrypt a1 nie rozpoznawał makr typów komórek FEM. Pomiar a2
bez periodycznego przekroju nie spełnił silnej normy pola: początkowy błąd
1,10→0,72→0,48 mimo zbieżnej energii/dynamiki. Niezależne złożenie macierzy
Ms-mass i A-stiffness odtwarza native H z błędem 1,47e-10
(`regional_fem_rod_discrete_oracle_a1.zarr`). To artefakt silnego laplasjanu
interpolantu na jednej warstwie tetraedrów, nie błąd mapy regionów. Jawne
więzy periodyczne przekroju w a3/a4 zachowują analityczną podprzestrzeń 1D;
nie zmieniono progów ani nie usunięto negatywnego dowodu. Wynik nie
kwalifikuje ogólnego trójwymiarowego silnego pola FEM.

Pozostaje terminalna relaksacja: publiczny PG-BB ujawnił błędną klasyfikację
stanu poniżej progu torque jako stagnacji przy osiągniętej dokładności
energii. Run i dane zachowano; poprawka, GREEN, CI oraz integracja/retencja
są kolejnymi wymaganymi bramkami.
