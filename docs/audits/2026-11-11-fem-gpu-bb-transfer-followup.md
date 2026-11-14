# FEM GPU SP4 — BB, transfery i Poisson, 11 listopada 2026

Aktualizacja 12 listopada: transfery przeszły test CUDA i porównanie numeryczne
SP4. Trzy realizacje FEM przeszły porównanie wszystkich energii przy wspólnym
torque `1e-8 T`. Pełna kwalifikacja BB (w tym pięć naprzemiennych par), nowego
Poissona oraz czterech solverów względem MuMax3 GPU pozostaje otwarta.
PR #424 nie jest jeszcze scalony.

## Tożsamość pomiaru transferów

- Baza master: `526a0bbdfd5fe321e07991b8615c40e00cdb9e26`.
- Branch: `codex/sp4-fem-gpu-bb-preconditioner-20261111`, worktree
  `sp4-comparison-20261102/fullmag`.
- Przed: snapshot `580a7b6151a96ae5ee4580fef14334da3bf77d2d3676011c44c0c7a475220449`,
  biblioteka FEM `f207e5e9bb12d4f8c8e37377bce17f9b627452c8ef1ce487f87472b88874188f`.
- Po: snapshot `ffa3b5bedef4bddf5f7fc7d24b99afb869eddb4f1ef80d82fffc6914fb35481a`,
  biblioteka FEM `142438c67ff181cbd85a0c1c8170a1244b7eab89cd865e3aa643321377682c92`.
- Zamrożona siatka `ca54d1274a06180d222f8507a7a8451a94913e846f0dc7dc05b0f41d68a6bf5f`:
  26 149 węzłów, 138 199 tetraedrów, 56 047 tetraedrów filmu,
  193 155 DOF potencjału P2. Ms=800 000 A/m, A=13 pJ/m.
- RTX 4080 SUPER; grupa `fullmag-worktree-fullmag-a8342df1f0247d61`,
  limit 40 CPU i 32 GiB. Profiler wyłączony; brak fallbacku CPU.

Wejścia, sąsiednie skrypty, pełne Zarr, CSV/JSON, provenance i analizy są
zachowane na ext4 WSL w storage użytkownika grupy, pod
`sp4-comparison-20261102/campaign-bb-gpu-526a-20261111`.
Kryteria zadeklarowano przed pomiarami w `transfer-and-component-criteria.json`.
Dowód z trzech prób przed i trzech po: `2026-11-11-transfer-comparison.json`
oraz sąsiedni skrypt analizy. Każdy bieg zakończył 92 zaakceptowane kroki;
wszystkie 6 numerycznych tablic Zarr (21 chunków na porównanie) są identyczne
bitowo między sześcioma biegami, łącznie z zapisanymi polami i tabelą.

## Pomiary transferów

| Wielkość | Przed | Po |
|---|---:|---:|
| Mediana czasu workera, 3 próby [s] | 42.654899 | 43.431922 |
| Zakres czasu workera [s] | 41.879–43.828 | 42.385–44.621 |
| Mediana sumy fazy inicjalizacji [s] | 15.700497 | 16.087721 |
| Mediana sumy materializacji pól [s] | 3.410247 | 2.034621 |
| Mediana sumy Poissona [s] | 18.536742 | 19.032291 |
| Średni obserwowany odstęp callbacków, mediana prób [s] | 0.258055 | 0.254968 |

Iloraz median czasu workera wynosi 0.982109×.
Nie jest to izolowany czas kroku GPU ani czas aktywacji w UI. Czas workera
obejmuje zimną inicjalizację; fazy mogą się nakładać i nie należy ich sumować.
Mała liczba nieprzeplatanych prób nie dowodzi statystycznej przewagi całej
symulacji. Zysk samej kopii nie może zastępować pomiaru SP4.

Test sprzętowy `fem-cuda-snapshot`, próba
`a12d935a1a544b0895f428076369e76f`, przeszedł w 0,725 s. Dla 26 149 węzłów
i 20 kopii zmierzył 65,092→2,568 ms według CUDA events oraz
59,729→2,477 ms host wall: około 25,35× / 24,11× dla samego transferu.
Sprawdził bity NaN i -0, niepełny blok, osiem niezależnych slotów, ponowne
użycie, limit pojemności, ważność cache H_demag i pełnodomenowy H_eff.

Zmiana używa istniejącego kernela SoA→AoS na GPU, jednego ciągłego D2H
do przypiętej pamięci i osobnego bufora device dla każdego slotu puli.
Rust tworzy od razu końcowy `Vec<f64>`, bez pośredniego wektora trójek
i kolejnego flatten. Alokacje slotów pozostają poza gorącą pętlą.

W sześciu biegach końcowe torque=8,569782386358024e-7 T,
Eex=8,226281838169194e-20 J, Edemag=5,408388162452866e-19 J,
Etotal=6,231016346269785e-19 J. Pozostałe składowe energii są zerowe.
Niezależny certyfikat rzeczywistego residuum Poissona wynosi
4,1050530326666786e-13 przy wymaganym rtol=1e-12, 66 iteracjach i limicie500.

## Exchange: różne stany końcowe

Historyczny pilot BB trwał45,692 s /92 kroki, stary GPU bez prekondycjonowania
409,618 s /1567 kroków, CPU90,099 s /85 kroków. Porównanie9× /2× dotyczy
pojedynczych nieparowanych biegów; nie jest benchmarkiem pięciu par.

Niezależna całka P1 po tetraedrach filmu odtwarza exchange dla czterech
zapisanych stanów CPU/GPU z maksymalnym błędem względnym5,4e-14.
Przeliczone z pól średnia magnetyzacja i fizyczne torque zgadzają się z tabelą.
Nie zaobserwowano więc rozbieżności ewaluatora energii dla tego samego stanu.
Dowody: `2026-11-11-independent-p1-exchange.json` i
`2026-11-11-exchange-endpoint-decomposition.json` z sąsiednimi analizami.

Między pilotem a starym GPU magnetyzacja różni się o RMS1,4134e-6.
Powoduje to ΔEex=+4,6443000522e-25 J oraz ΔEdemag=−4,6453708623e-25 J,
które niemal się znoszą w ΔEtotal=−1,0708103083e-28 J. Rozkład kwadratowej
energii exchange daje składnik liniowy4,6442262014e-25 J i kwadratowy
7,3850845967e-30 J. Mała zmiana tekstury wyjaśnia tę różnicę składowych,
mimo niemal takiej samej energii całkowitej.

Historyczna różnica exchange 5,646 ppm przekracza bramkę 2 ppm. W kolejnym
porównaniu CPU/GPU raw/GPU preconditioned przy wspólnym torque 1e-7 T
największa różnica wyniosła 2,103205 ppm: ta próba również nie przeszła
niezmienionej bramki. Nie podnosiliśmy limitu komponentów.

### Wspólny próg 1e-8 T

Zgodnie z zadeklarowanym wcześniej kolejnym krokiem wykonano wszystkie trzy
biegi z progiem 1e-8 T, bez zmiany siatki, fizyki ani certyfikacji Poissona.
Użyły tej samej biblioteki `142438c6…`. Wszystkie Zarr są kompletne i skończone;
CSV nie mają luk ani utraconych wierszy.

| Realizacja FEM | Kroki | Czas workera [s] | Końcowe torque [T] | Rzeczywiste residuum Poissona |
|---|---:|---:|---:|---:|
| CPU | 109 | 123,572094 | 7,076274e-9 | 3,948764e-13 |
| GPU bez prekondycjonera | 1945 | 535,705042 | 8,502109e-9 | 4,107678e-13 |
| GPU z exchange-mass | 113 | 48,947291 | 8,895426e-9 | 4,117029e-13 |

CPU zachował requested/resolved 30 wątków, a zmierzona wartość
`effective_fem_omp_threads` wyniosła 16; GPU raportował 1 wątek hostowy MFEM.
Optymalna liczba wątków CPU wymaga oddzielnego benchmarku.
Średnie obserwowane odstępy callbacków wyniosły odpowiednio 0,864958 s,
0,265291 s i 0,263806 s. Obejmują sterowanie i obserwację; osobny pomiar
pojedynczego kernela GPU nie jest z nich wyprowadzany.

Wszystkie osiem składowych/energii przeszło bramki we wszystkich trzech
parach. Największa różnica względna exchange wynosi 0,217735 ppm (CPU/raw),
demag 0,033119 ppm, a energii całkowitej 3,493e-14. Para dwóch GPU różni się
w exchange o 0,043986 ppm. Zerowe składniki zachowują limit 1e-30 J.
Raport: `2026-11-11-fem-common-stop-tight8.json` i sąsiednia analiza.

Niezależny oracle odtwarza także pole wymiany z macierzy sztywności P1 i
lumpowanych objętości węzłowych. Dla tych trzech stanów maksymalny względny
błąd ważonego L2 wynosi 2,471e-13, a składowej pola 4,935e-8 A/m. Energia
odtworzona z gradientu i z zapisanego H_ex przechodzi limit 1e-10 względnie.
Dowód: `2026-11-12-independent-exchange-field-common8.json` z kodem oracle.
Nie zaobserwowano błędu ewaluatora exchange ani jego pola dla tych stanów.

Ilorazy pojedynczych czasów wynoszą 2,524595× względem CPU i 10,944529×
względem GPU raw. To porównanie kosztu dojścia do tego samego progu,
obejmujące zimną inicjalizację; nie jest izolowanym czasem kernela, czasem
aktywacji w UI ani wymaganym benchmarkiem pięciu naprzemiennych par.
Wynik nie zmienia kwalifikacji historycznych stanów przy luźniejszym progu
1e-6 T ani nie rozstrzyga różnicy dyskretyzacji FEM i MuMax3 GPU.

## Poisson — pierwszy pomiar 12.11.2026

Profil 105 zaakceptowanych kroków z dokładniejszym stopem wykazał 131 solve
HYPRE i 8665 iteracji: 23,325 s host API oraz 23,311 s przedziałów CUDA.
Przedziały obejmują przerwy launchów i nie są sumą aktywnych kerneli.
Kandydat przenosi skalary PCG i test zbieżności na GPU. Pierwsza paczka ma
najwyżej 5 iteracji, następne 8; macierz, AMG i niezależny certyfikat pozostają
takie same. Biblioteka `69de34b3…` przeszła zarządzany test
`fem-demag-poisson` (4,212311 s), obejmujący zero RHS, dokładny warm start,
Nonfinite, limity paczek i księgowanie zakresów. Snapshot źródeł:
`2b6cf43905212371bf2dbbf06ef2e648a16c765891294a99350b81053b2d11ea`.

Przed pomiarem przywrócono historyczny budżet grupy 40 CPU / 32 GiB.
Odtworzenie usług początkowo przyjęło domyślne 8 CPU / 64 GiB; istniejąca
procedura `cold-resume-restore-stored-budget` odrzuciła ten rozjazd i
przywróciła zapisany budżet bez zmiany ledgeru. Pomiar nie używał limitu 8 CPU.

Pierwszy kompletny SP4 (`sp4_gpu_poisson_device_01_20261111`) wykonał 92 kroki
w 45,124280 s, z torque 8,573588e-7 T i certyfikatem 4,114078e-13.
Pełny Zarr jest zachowany; osiem energii przechodzi niezmienione bramki
względem wszystkich trzech wcześniejszych powtórzeń. Pojedynczy czas nie
potwierdza przyspieszenia względem wcześniejszej mediany 43,431922 s.

Kwalifikacja całości pozostaje **niezaliczona**: HotLoop zarejestrował 113
solve, 7477 iteracji i 1017 odczytów statusu po 104 B, ale PhysicalLifetime
oraz mandatory Physical pozostały zerowe. Gałąź direct minimizer otwierała
execution receipt bez cyklu liczników performance. Testy natywne ręcznie
otwierały ten cykl, przez co nie wykryły błędu rzeczywistej ścieżki BB.
HotLoop zachował prawidłową resztę 386 odczytów / 58784 B przy budżecie 389;
nie zastępuje to brakujących obserwacji Physical. Dowód:
`sp4_gpu_poisson_device_01_20261111.physics-observation.json`.
Kolejne powtórzenia wstrzymano do naprawy zakresu lifetime; tego pilota nie
należy mieszać z późniejszą kohortą innej biblioteki.

## Aktualizacja: lifecycle v2 i ponowne użycie AMG, 12.11.2026

Pierwszy niezaliczony pilot zachowano. Po naprawie rzeczywistego cyklu
performance direct minimizer, biblioteka `35d15e3f…` przeszła native gate i
trzy SP4: 44,536875 / 44,611956 / 44,748926 s. Physical i HotLoop są poprawne;
niezmienione bramki energii, torque, residuum i pełnego Zarr są zaliczone.
Mediana 44,611956 s wobec poprzednich 43,431922 s nie wykazała przyspieszenia.

Następna poprawka dotyczy tylko deklarowanego zerowego startu PCG.
Ponieważ r0=b, zachowuje pierwsze z=Cb i kopiuje D=b^TCb do rho na urządzeniu.
Pomija drugie początkowe AMG, matvec A*x0 i ponowny dot; warm start pozostaje
bez zmian. Kopia8B D2D jest rozliczana. Brak nowej alokacji, odczytu skalaru
na CPU, fallbacku, zmiany tolerancji, paczek5/8 i certyfikatu residuum.

Zarządzany native gate `2a6aa743ff164657b17b1c5f80123e3c` przeszedł w5,514 s:
fresh wymaga queued+1 AMG, warm nadal queued+2; obejmuje też zero RHS,
NaN, czyszczenie odrzuconego kandydata i40B dla pięciu fresh apply.
Snapshot `a90bb40e93e072a93ea3099e568bc19708c67834ba9b489d5a52711446d11f94`,
biblioteka `0bd7e6f11fceb5eafa7d22e546c636f9dc7c24259895326a4f997a4031986494`.

| Wielkość | Lifecycle v2, 3 próby | Fresh reuse, 3 próby |
|---|---:|---:|
| Mediana czasu workera [s] |44,611956|42,858635|
| Zakres [s] |44,536875–44,748926|42,625113–46,091595|
| Mediana sumy Poissona [s] |19,719933|20,276239|
| Mediana sumy materializacji pól [s] |2,076776|0,643992|
| Zaakceptowane kroki |92|92|

Nowe czasy to46,091595 /42,858635 /42,625113 s. Mediana workera spadła o3,93%,
ale mediana inkluzywnego licznika Poissona wzrosła o2,82%. Fazy mogą się
nakładać; spadek całkowitego czasu nie dowodzi zysku samego AMG. Próby były
sekwencyjne, nie naprzemiennie parowane; rozrzut nowej kohorty jest znaczny.
Nie podajemy izolowanego czasu kroku lub kernela.

Wszystkie numeryczne tablice Zarr trzech nowych biegów są bitowo identyczne
z pierwszą bazą v2. Osiem energii, torque8,573588023048801e-7T i rzeczywisty
certyfikat4,1140783817602217e-13 przechodzą niezmienione bramki.
HotLoop ma113solve /7477aktywnych iteracji /1017odczytów po104B;
Physical114 /7544 /1026. Pozostały budżet to386odczytów /58784B przy limicie389.
Skrypty, pełne Zarr i provenance zachowano na WSL. Utracono tylko uchwyt
klienta pierwszego biegu; jego terminalny stan odzyskano odczytowo przez
przypięty API/run/session, bez ponowienia Solve.

Dowody: `2026-11-12-poisson-device-v2-comparison.json`,
`2026-11-12-poisson-fresh-reuse-comparison.json`, `poisson-runtime-fresh-reuse.json`
i `2026-11-12-progress-v7.json` w tym samym katalogu kampanii.
Oddzielny właściwy profil CUPTI Activity nie jest częścią median OFF.
Jego 92-krokowy SP4 również przeszedł kontrolę energii, torque, certyfikatu
i pełnego Zarr. Tożsamość śladu zweryfikowano przez PID z osobnego receiptu
supervisora, accepted claim i UUID przydzielonej RTX4080 SUPER.
Zapis zatrzymał limit512MiB: 1021904 rekordy, 5690 dropped records,
`limit_flags=1`, status `partial`, timing qualification `not_verified`.
Zachowane rekordy zawierają383414 kerneli,54711 wywołań `cudaMemcpy`
i55505 kopii D2D. Są to niepełne liczniki, bez kwalifikacji czasów całego
przebiegu lub wykorzystania sprzętu. Dalszy profil powinien objąć krótszy,
jawnie opisany workload; nie zwiększono limitów i nie skopiowano dużego
surowego śladu. Dowód: `2026-11-12-poisson-fresh-reuse-cupti.json`, ze
wskazaniem kanonicznego śladu na WSL. To kieruje dalszą diagnozę na dużą
liczbę uruchomień SpMV i synchronicznych kopii wewnątrz ścieżki HYPRE;
nie dowodzi, że każda taka kopia jest transferem CPU/GPU.

Review integracji ABI i liczników nie znalazł problemu implementacyjnego.
Wykrył za to, że bezpośredni entrypoint modułu testowego poprzedzał osiem
nowych testów. Reprodukcja RED nie znajdowała klasy; po przeniesieniu
entrypointu na koniec przechodzi osiem testów bezpośrednio i wszystkie110
testów verifier/matrix. Wcześniejszy tryb `python -m unittest` obejmował
te testy już przed naprawą.
Pięć naprzemiennych par BB, wszystkie cztery solvery względem MuMax3 GPU
oraz integracja tych późniejszych zmian z masterem pozostają otwarte.

## Źródła

- [Kontrakt BB i literalne bramki](../physics/0581-fem-gpu-direct-minimizer-preconditioning.md#116-validation-and-qualification-gates).
- `backends/fem/src/api.cpp::schedule_gpu_snapshot_payload` i `gpu/cuda/transfer/snapshot_pool.cpp` — kopie i własność buforów.
- `backends/fem/tests/snapshot_contract.cpp` — test sprzętowy oraz mikropomiar.
- `crates/fullmag-runner/src/native_fem.rs::into_flat_vector_field` — końcowy bufor i walidacja układu.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — HYPRE i zachowana hierarchia.
