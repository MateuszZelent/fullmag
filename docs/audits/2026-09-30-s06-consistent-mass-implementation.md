# S06: consistent P1 mass — źródła WIP, 2026-09-30

## Zmiana implementacji

Dodano ConsistentP1TrackingMetric. Lokalny embedding tet4 zawiera cztery
nodalne XYZ oraz ich sumę; ich iloczyn daje pełną consistent P1 mass,
łącznie z wyrazami pozadiagonalnymi. Wspólna normalizacja objętości stabilizuje
metrykę i kasuje się w znormalizowanych overlapach. Macierz globalna nie jest
budowana. Metrykę podłączono do overlapu oraz SVD/Procrustes zdegenerowanych
podprzestrzeni; odzyskane ramki pozostają fizycznymi nodalnymi envelope.

FEM adapter zachowuje wszystkie węzły magnetyczne, w tym slave nodes PBC,
i wiąże pola legacy z rzeczywistym fingerprintem pełnej uporządkowanej siatki.
Arc/cache współdzieli metrykę przez ścieżkę. Zmiana mesh identity zatrzymuje
run; asymetryczne lub mieszane metryki nie przechodzą na euklidesowy fallback.
Ocena jednorodności Gamma używa tej samej consistent mass. Starsze ścieżki
bez kontekstu zachowują jawne legacy metryki; nie jest to ich kwalifikacja.

## Aktualne dowody

Kontrola Rustfmt wszystkich zmienionych konsumentów: parse/check exit 0.
Nie wykonano kompilacji ani Rust regression runu. Do ośmiu przygotowanych
regresji payload/envelope dołączono siedem regresji metryki i integracji.

Niezależna kontrola matematyczna Python porównała embedding z bezpośrednią
integracją P1 na 19 zachowanych modach i 17 sąsiednich parach:

| Kontrola | Maksymalny defekt |
|---|---:|
| Norma w consistent mass (względny) | 4.4343018897494473e-16 |
| Odzyskanie nodalnego pola (względny) | 1.7245868222581087e-16 |
| Overlap kwadratowy (bezwzględny) | 8.881784197001252e-16 |

Każdy profil: 76 fizycznych węzłów magnetycznych, 191 tetraedrów,
2865 składowych zespolonych embeddingu. Jest to niezależne sprawdzenie
formuły na realnych zachowanych danych, nie wykonanie zmienionego Rust,
nie nowa częstotliwość, nie qualification trackingu.

Raport hashów, wejść i ograniczeń:
C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\consistent-tracking-embedding-diagnostic.json

## Granice realizacji i następne wymagania

Źródła są niezacommitowanym WIP; brak kompilacji i runtime uniemożliwia
uznanie przyrostu za ukończony. Nowy moduł tracking_mass.rs jest untracked:
przed snapshot buildem wymagane jest jawne include-untracked tego pliku,
chyba że zostanie wcześniej poprawnie włączony do wersjonowania.

Runner jest zdrowy, bez aktywnych jobów, ma 5 108 162 560 B wolnego przy
progu 8 GiB. Runtime-only jest poza allow-list. Profil fem-cpu-release ma
SLEPc OFF i nie zastępuje wymaganego modalnego buildu. Zakaz kompilacji
unit tests i wcześniej zadane decyzje operatora pozostają aktualne.

S06 nadal wymaga kompilacji/regresji, pełnej runtime ścieżki, kontroli identity
równowagi, crossingów/luk i kwalifikacji podprzestrzeni. S07 wymaga utrwalenia
provenance metryki i jej rekonstrukcji przy ponownym odczycie artefaktów.
S00–S12, nauka A1/COMSOL, zbieżność, UI, GPU i integracja pozostają otwarte.
Nie podniesiono żadnej naukowej bramki ani procentu do ukończonego.

## Tożsamość bieżących źródeł WIP

| Plik | SHA-256 |
|---|---|
| `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `d3a3e7abf27028bee7134031510a05de453bee29a412a54ffaf49a1f40738434` |
| `crates/fullmag-runner/src/eigen/tracking.rs` | `78cdeaa4f85adabc964bf24f55282c60025efb88d39ecd525f511ba90afc5520` |
| `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | `43aac10b50515c1db51fa32a04d32be0163ee23021533905f4d4c47cfde37797` |
| `crates/fullmag-runner/src/eigen/types.rs` | `4a44d925125f4ef4608f0b11b2e5f8f929d93b105406ea5559c8137a7c75c717` |
| `crates/fullmag-runner/src/eigen/mod.rs` | `f669926e9c76919710e17d1cd42043ab8dbf6eb8123963c258c07502f820afa6` |
| `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `baee7ca5855ac78c501fcae333f8723660691609ddf0505c90add063faa26312` |
| `crates/fullmag-runner/src/eigen/artifacts/tests.rs` | `a54ef6585601f861afbffeb2f41511d484086af4610c54c34daa258159f74192` |
| `crates/fullmag-runner/src/eigen/output_selection.rs` | `df757197f22fee93aceca3d544efb984956c45d4a5a73f7c43edb13fb05589af` |
| `crates/fullmag-runner/src/eigen/orchestrator.rs` | `f3874159424f151d8ef8122d89ee985b3c6de299a7c13947a5436c3d55975553` |
| `crates/fullmag-runner/src/dispatch.rs` | `82a267c8e4306ad12688bb96fa4390a5cdc6be2701a7e9d64f09fb58b6b12f69` |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `74d709b549c0f4f2496e974c77e209f9010405062530504e1e62d571e22249ac` |
| `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `c5a626e6e54e6496e1440c4dd236f6e44a9a461ce58e442fa8fb26caf9b3667e` |
| `crates/fullmag-runner/src/fem/eigen_output.rs` | `32ffc2bb428ce4a9dd329860a1cdb73febbd2582b7f2a0d2cca8fa037b107645` |
| `crates/fullmag-runner/src/fem/eigen_path_guards.rs` | `5789939cef3bea24c6e36e9a5cc157b0d531ecd2d1b5a379bc38a66684eabe3e` |
