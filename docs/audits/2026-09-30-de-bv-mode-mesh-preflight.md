# DE/BV: wejścia do porównania profili modów — 2026-09-30

## Sprawdzony wynik

19 istniejących zaakceptowanych modów ma poprawne payload_sha256
oraz długość binarnego pola zgodną z complex_pair_count i formatem
complex_f64_pairs_little_endian. Kod zapisuje kolejno węzeł, składową
x/y/z, część rzeczywistą i urojoną.
Źródło: crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs,
write_complex_vector_field_payload.

Wszystkie deklarują tę samą modalną topologię:
sha256:cfbf3da185a0ffa7ff80afacf82c99b1d7c7ac687a32d165e726c277e731f263.
W każdym runie znaleziono artifact cache siatki fullmag-mesh i sprawdzono
hashe oraz rozmiary jego członków z manifestu. Żaden manifest cache
nie deklaruje bezpośrednio tej modalnej tożsamości. Dla DE k2 cache
ma fingerprint v3 sha256:6c074cd249bcf7e2b7680d967e9cda2e864f084e01959b31f849b8ce446fc9ca,
potwierdzony także publicznym load_mesh_artifact / topology_fingerprint_v3.

## Wniosek i brakujący krok

Różnica fingerprintów nie dowodzi błędu solvera: po wczytaniu cache
mogły zajść legalne transformacje siatki lub warunków okresowych.
Jednak zgodna liczba węzłów i tożsamość modów między runami nie dowodzą,
że wolno przypisać im connectivity i wagi z tego cache.
Nie obliczono nowych nakładań consistent-mass i nie zamknięto S06.

Należy odzyskać końcową siatkę modalną w pełnej kolejności węzłów,
wykazać jej transformację z cache i zgodność z deklarowanym fingerprintem.
Dopiero potem można liczyć iloczyny skalarne macierzą masy P1,
usunąć fazę Blocha zgodnie z konwencją solvera i porównać sąsiednie mody.
Jeśli odzyskanie nie jest możliwe, nowy runtime musi zapisać dokładny
artefakt siatki użytej przy eigensolve. Dotychczasowe metryki lumped
pozostają diagnostyczne, a ich powiązanie z końcową siatką wymaga kontroli.

## Dowody

Manifest mode-mesh-input-preflight.json znajduje się obok comparison.json
w katalogu wizualizacji de-bv-ten-20260930 tego wątku. Zawiera ścieżki,
hashe metadanych i pola każdego modu oraz cache siatki.
Nie zmieniono wyników, frequency/residual ani historycznych receipt.
Kwalifikacja naukowa i ciągłość gałęzi: NOT VERIFIED.


## Rozwiązanie tożsamości i wynik — kolejny checkpoint 2026-09-30

Powyższy brak bezpośredniej zgodności manifestów został wyjaśniony.
Planner pack_mesh_by_analysis umieszcza najpierw węzły magnetyczne,
a następnie węzły powietrza; przemapowuje komórki, facety i pary okresowe.
Odtworzenie tej transformacji dla pojedynczego filmu daje dokładnie
modalny fingerprint v3 we wszystkich 19 runach. Nie zmieniono cache ani pól.
W L0 przestawionych jest 668 z 1980 węzłów; film ma 76 węzłów i 191 tetraedrów.
Objętość filmu z elementów wynosi 1.599999999999999e-23 m³.

Dodano scripts/compare_de_bv_mode_profiles.py. Skrypt sprawdza hashe
artefaktów comparison.json, certyfikat full_descriptor, oryginalną bramkę
residualu 1e-8, częstotliwość i wektor k, format i hash payloadu oraz
fingerprint końcowej uporządkowanej topologii. Obsługuje tylko pojedynczy
jednorodny film, tet4/tri3 z markerami 1/0. Inne przypadki odrzuca.

Zastosowano consistent mass P1, nie masę lumped. Wartości węzłowe
odfazowano exp(+i k.r), a następnie porównano ich interpolanty P1.
Definicja i ograniczenia: docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md,
DOC-ANCHOR:de-bv-consistent-mass-profile. Nie zmienia to produkcyjnego trackera.

| Konfiguracja | Liczba modów / par | Minimalny kwadrat nakładania sąsiednich profili | Zakres projekcji na stały wektor |
|---|---:|---:|---:|
| DE | 9 / 8 | 0.9990210150751552 | 0.9999098186640367–0.9999996102692768 |
| BV | 10 / 9 | 0.9999361809765960 | 0.9999752707481893–0.9999998865149904 |

Wynik wspiera podobną, niemal jednorodną rodzinę profili. Nie dowodzi
najniższej gałęzi, kompletności widma, braku degeneracji, pokrycia DE k12
ani zbieżności. S06 nadal wymaga produkcyjnego trackingu i jego bramek.
Dotychczasowych diagnostyk lumped nie należy utożsamiać z tym wynikiem.

7 regresji Python PASS: analityczna macierz masy baz P1, stały profil,
niezmienniczość fazy/skali, hermitowskość, ortogonalne komponenty,
odrzucenie zerowej normy/nonfinite/degenerate, przemapowanie indeksów
i immutable ordinals, niewłaściwa topologia/markery oraz containment.
Source-map noty: exit 0; kontrakty dokumentacji matematycznej: 10 PASS.
Nie kompilowano testów natywnych i nie uruchamiano nowych solve.

Pełne wyniki i hashe: consistent-mass-mode-profiles-final.json obok comparison.json
w katalogu wizualizacji de-bv-ten-20260930. Kwalifikacja pozostaje NOT VERIFIED.
