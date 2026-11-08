# Odczyt świadka RT0 po odmowie
To samodzielny postprocessor, nie solver. Nie łączy się z API, nie uruchamia
Fullmaga i nie kwalifikuje źródła. Rzeczywistego świadka z nowej próby jeszcze
nie ma. synthetic-*.json zawierają WYŁĄCZNIE syntetyczny test arytmetyki:
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
Nie uruchomiono native builda, Prepare, Submit ani Solve.
