# Odczyt świadka RT0 po odmowie
To samodzielny postprocessor, nie solver. Nie łączy się z API, nie uruchamia
Fullmaga i nie kwalifikuje źródła. Rzeczywisty świadek z jednej próby jest zachowany jako
fixtures/actual-first-center-refusal.json; pełny receipt i analiza leżą katalog wyżej. synthetic-*.json zawierają WYŁĄCZNIE syntetyczny test arytmetyki:
współrzędna przesunięta o 2^52 m nie przedstawia fizycznej anteny.

verify_rt0_center_witness.py odczytuje JSON świadka lub worker exit receipt
z polem failure_reason. Weryfikuje długości, hex16, unikalne ID i klucze JSON.
Odtwarza istniejące compensated_sum, skalę i predykat128epsilon64.
Z dokładnych ułamków odtwarza centroid oraz RT0 z canonical sorted-ID
face moments, z orientacją opposite_local_vertex. Nie dysponuje nieopublikowanymi
współczynnikami MFEM; jawnie stosuje nearest-even binary64 do rekonstrukcji.
Zgodność bitów z obserwacją jest osobną liczbą, nigdy automatyczną kwalifikacją.
Rzeczywisty cpp_rational::convert_to i C++ nie są wykonywane przez ten skrypt.

Jednostki: współrzędne m, J A/m², strumienie A. Python standard library only.
Przykład odczytu istniejącego pliku:
python3 -B verify_rt0_center_witness.py receipt.json nowy-raport.json
Wyjście tworzone wyłącznie jako nowy plik; istniejący raport nie jest nadpisywany.

Źródła kontraktu:
crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs::
compensated_sum / verify_center_current / verify_rt0_sample_moments;
backends/fem/cpu/mfem/transport/closed_loop_source_snapshot.hpp::
export_closed_loop_source_snapshot;
backends/fem/cpu/mfem/transport/affine_rt0_element.cpp::
AffineRt0Element::retained_current_at.
Właściciel interpretacji publikacji: docs/physics/0951-sushruth-2020-forward-volume-reference.md.

Siedem testów przeszło: pole stałe bez dywergencji, jednostkowe affine RT0,
przesunięcie ujawniające błąd centroidu, rozbieżny center J, NaN/missing face,
niepoprawne bity/ID oraz ramka receipt i zduplikowane klucze JSON.
Sam postprocessor i jego testy nie uruchamiają native builda, Prepare, Submit ani Solve.

## Rzeczywisty odbiór08.11.2026

Jedna próba run-d04ef521… wykonała H20/20 i zakończyła się Failed przy
elemencie28881, składowej y. Siedem testów syntetycznych pozostaje PASS.
Ten sam weryfikator odtworzył bity istniejącej bramki i wszystkie15 wartości
native J z czterech kanonicznych strumieni. Nie wymusił akceptacji wyniku.

actual_geometry_readback.py jest dodatkowym odczytem tej konkretnej komórki:
trzy wierzchołki mają tę samą współrzędną y i J_y=0. Dokładna waga czwartego
wierzchołka w zapisanym punkcie wynosi0,2500000000000288. Interpolacja w tym
punkcie odtwarza J_y środka z różnicą1ULP, podczas gdy1/4 daje inną próbkę.
Przeczytano ten sam materiał; bez nowego Solve lub zmiany metody produkcyjnej.
Pełny raport: docs/superpowers/plans/2026-11-08-rt0-actual-center-failure-result.md.
