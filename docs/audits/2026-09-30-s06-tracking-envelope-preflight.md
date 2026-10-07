# S06: przygotowanie envelope w trackingu — 2026-09-30

## Znalezione przyczyny błędów

`eigen_path_mode_vector_entries` używał filter_map i unwrap_or(0), przez co
uszkodzony wiersz mógł przesunąć indeksy węzłów, a brakujące komponenty
stawały się zerem. `eigen_path_mode_tracking_vector` ignorował błąd JSON,
wybierał pierwszy duplikat, nie wiązał długości pól z pełną siatką ani
ID/k z punktem ścieżki. Porównywał fizyczne pola Blocha zamiast envelope.

## Przygotowane źródła — jeszcze nie skompilowane

Adapter korzysta teraz ze wspólnego ścisłego parsera Cartesian XYZ eksportu
pól. Wymaga pełnych real/imag, zgodnego ID/k i unikalnej selekcji węzłów.
Błędne obecne pole zwraca błąd runu; brak obu pól pozostawia unavailable.
Dla Floqueta mnoży pole przez exp(+i k·r), odwracając przestrzenne
exp(-i k·r). Dla Gamma/niefloquetowych granic nie odfazowuje pola.
Zmiana dotyczy wektora trackingu; publikowane pola pozostają oryginalne.
Dodano osiem regresji Rust w tracking_payload_tests, bez kompilacji i runu.

Źródła: crates/fullmag-runner/src/fem/eigen_path_artifacts.rs +
eigen_path_mode_tracking_vector; crates/fullmag-runner/src/fem/eigen_output.rs +
mode_vector_entries; integracja w crates/fullmag-runner/src/fem/eigen_path.rs.
Te pliki mają również wcześniejsze niezakończone zmiany i pozostają robocze.

## Dowody

Rustfmt parse/check trzech zmienionych plików: exit 0. To nie jest kompilacja.
Sprawdzono 19 zaakceptowanych historycznych modów: każdy ma 1980 pełnych
węzłów XYZ real/imag, zgodne ID i k. Odtworzono ich pełną uporządkowaną siatkę,
sprawdzono oryginalne hashe, porównano envelope z legacy JSON z odfazowanym
polem binarnym. Maksymalny względny defekt: 0.0.

Hashowany raport zawiera tożsamości bieżących trzech źródeł, wejść i siatek:
C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\tracking-payload-compatibility.json

Raport dotyczy zgodności historycznych wejść, nie wykonania zmienionego Rust.
Nie wykonano nowych częstotliwości ani nowej ścieżki dyspersji.

## Otwarte wymagania S06

Produkcyjny overlap i transport podprzestrzeni nadal używają diagonalnej
metryki wag nodalnych. Wymagane jest wdrożenie consistent P1 tet4,
provenance reprezentacji i pełnej mesh/equilibrium identity między próbkami,
regresje dla rotacji zdegenerowanych podprzestrzeni i crossingów oraz
kompilacja/runtime na wspólnej ścieżce. Osiem nowych testów Rust: NOT RUN.
Dla bieżącego native runtime i CPU/GPU trackingu: NOT VERIFIED.

Stan realizacji całego S06 nie został podniesiony do ukończonego.

## Tożsamość przygotowanych źródeł

| Plik | SHA-256 (WIP) |
|---|---|
| `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `2687361a7daa4f402fadf3f795176cdedf4eec34076467bb989b5ad6b291479b` |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `6f0763d0273b85154c914f81d9ab13d2ff91f52624fb6549d2c0638881efaccf` |
| `crates/fullmag-runner/src/fem/eigen_output.rs` | `32ffc2bb428ce4a9dd329860a1cdb73febbd2582b7f2a0d2cca8fa037b107645` |
