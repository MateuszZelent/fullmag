# Kwalifikacja fizyki regionalnej — 7 listopada 2026

Stan etapowy. Kontrakt fizyczny: nota 0104. Kolejność dalszego wykonania określa
`docs/superpowers/plans/2026-11-07-regional-physics-qualification-and-fem-marker-map.md`.
Poniższe wyniki nie oznaczają ukończenia całej macierzy oddziaływań.

## Środowisko i recovery

Źródła aplikacji: czysty commit `af6a066127b62be148020f92694989c91a7bd490`,
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
