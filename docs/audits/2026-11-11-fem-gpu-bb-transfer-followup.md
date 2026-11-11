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

## Poisson — następny pomiar

Profil105 zaakceptowanych kroków z dokładniejszym stopem wykazał131 solve
HYPRE i8665 iteracji:23,325 s host API oraz23,311 s przedziałów CUDA.
Przedziały obejmują przerwy launchów i nie są sumą aktywnych kerneli.
Hierarchia AMG jest już zachowywana. Kandydat przenosi skalary PCG i test
zbieżności na GPU, z odczytem statusu najwyżej co8 iteracji; nadal używa tej
samej macierzy, hierarchii AMG i niezależnego certyfikatu. Jego kompilacja,
runtime, parytet oraz przyspieszenie pozostają **NOT VERIFIED**.

## Źródła

- [Kontrakt BB i literalne bramki](../physics/0581-fem-gpu-direct-minimizer-preconditioning.md#116-validation-and-qualification-gates).
- `backends/fem/src/api.cpp::schedule_gpu_snapshot_payload` i `gpu/cuda/transfer/snapshot_pool.cpp` — kopie i własność buforów.
- `backends/fem/tests/snapshot_contract.cpp` — test sprzętowy oraz mikropomiar.
- `crates/fullmag-runner/src/native_fem.rs::into_flat_vector_field` — końcowy bufor i walidacja układu.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — HYPRE i zachowana hierarchia.
