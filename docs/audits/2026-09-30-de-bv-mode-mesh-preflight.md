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
