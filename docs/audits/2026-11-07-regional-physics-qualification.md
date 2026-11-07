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

Przypadek 1000 ziaren i osobny dowód Compute Fields z zaakceptowanego stanu
fp32 są jeszcze **NOT VERIFIED**. Stan i surowe dowody
są zachowywane w `regional_public_matrix_campaign_phase2.zarr` na ext4 WSL.

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
