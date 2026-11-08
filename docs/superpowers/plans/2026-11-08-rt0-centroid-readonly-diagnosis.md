# Odczytowa diagnoza centroidu RT0 — 08.11.2026

## Wynik i granice

Poprzedni turn zmienił autorytatywny stan: naprawa preflightu, udany managed
build/Prepare i jedna rzeczywista próba V/J/H zakończona Failed.
Obecna diagnostyka nie uruchomiła nowego buildu, Prepare, Submit lub Solve.
Potwierdza możliwość niespójności próbkowania centroidu; nie identyfikuje
rzeczywistej komórki, która spowodowała Failed i nie kwalifikuje E3/LLG/Fig.3.
Właściciel fizyki i ograniczeń: [nota0951](../../physics/0951-sushruth-2020-forward-volume-reference.md).

Ponowny odczyt potwierdził: worker nie istnieje, task jest terminalny,
w worker-attempts zostały tylko execution_started i live_observation,
temp jest pusty. Scena UI nadal awaiting_command.
closed_loop_execution.rs::execute_native przekazuje snapshot do
closed_loop_v2.rs::build, który waliduje tożsamość przed tworzeniem artefaktów.
Nie ma podstaw do odczytu odrzuconego pola jako poprawnego wyniku.

## Niezależny świadek arytmetyczny

Wejście: compact request80b177c9f483ae5288c9d7dc80cc121bc63d6e3ebde25a8bf28faa262bc2a8d0,
odebrana siatka40728Tet4, komórka5843.
Współrzędne są rzeczywiste, wszystkie cztery współczynniki pola RT0
są **syntetyczne**, po2^-100 A. Nie rozwiązano równania transportu.

Model diagnostyczny: dokładne ułamki dyadyczne, symulowane sumowanie
centroidu z64bitami mantysy, końcowe nearest-even binary64,
istniejąca kolejność kompensowanego sumowania próbek w Rust.
To nie wykonanie Boost/C++ i nie dowód jego trybu zaokrąglania.

| Kontrola osi y | Wynik |
|---|---:|
| Średnia zapisanych próbek J w wierzchołkach |0 A/m² |
| J w zaokrąglonym centroidzie |6,333070233679038e-29 A/m² |
| Różnica |6,333070233679038e-29 A/m² |
| Dotychczasowy budżet128epsilon64 razy skalę składowej |3,450721313193274e-30 A/m² |
| Różnica/budżet |18,3528881612826 |
| Błąd współrzędnej centroidu |8,470329472543003e-22 m |
| Ten sam model po dokładnej translacji y do początku |Różnica0, ta sama orientowana objętość |

Kontrola stałego pola przechodzi. Kontrole ties-to-even dodatnie/ujemne,
dodatniego det i translacji zachowują zadane asercje; sześć kontroli PASS.
Wcześniejszy geometry-only skan wskazał5682potencjalne komórki osi y;
nie jest to liczba rzeczywistych błędów solvera i nie użyto jej jako kwalifikacji.

Wniosek ograniczony: obecną nierówność może naruszyć zaokrąglenie miejsca
próbkowania, nawet gdy wartości pochodzą z jednego jawnego pola afinicznego.
Syntetyczne dane nie są pełnym zachowawczym rozwiązaniem obwodu.
Bez rzeczywistych próbek odrzuconej komórki nie wykluczamy błędu producenta,
nośnika lub innych przyczyn. Nie dopasowywać tolerancji do tego świadka.

## Mapa kodu i brakujący dowód

| Path + symbol | Potwierdzona odpowiedzialność |
|---|---|
| backends/fem/cpu/mfem/transport/affine_rt0_element.cpp::AffineRt0Element::retained_current_at | Dokładny frozen-binary64 ewaluator i końcowa konwersja J do double |
| backends/fem/cpu/mfem/transport/closed_loop_source_snapshot.hpp::export_closed_loop_source_snapshot | Osobne próbkowanie wierzchołków i centroidu zaokrąglonego do double |
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs::verify_owned_geometry | Aktualna nierówność mean/center J, przed kolejnymi affinity/moments |
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs::verify | Bitowe przypięcie XYZ przed odmową; dalsze preimage bindings dopiero później |
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_v2.rs::build | Walidacja przed tworzeniem końcowych artefaktów |
| crates/fullmag-api/src/accepted_study_supervisor.rs::worker_failure_reason | Normalizacja stderr i początek2816B raportu workera |
| crates/fullmag-api/src/accepted_worker_exit_observation.rs::RawObservation::outcome | Odtworzenie wait/reap bez gwarancji odzyskania stderr po awarii nadzorcy |

Nie zmieniono tych plików. Niezależny odczyt przez subagenta potwierdził
kolejność kontroli i granice transportu. W Rust są cztery canonical face flux,
lecz nie ma czterech zamrożonych współczynników MFEM.
Potrzebny jest numer elementu/oś, bity4XYZ/4J/center/centerJ, aktualna
różnica/budżet i strumienie. Limit4KiB nie wystarcza, bo wcześniejszy transport
obcina raport do2816B. Świadek<=2048B ma zostawić miejsce na konteksty błędu.

Nie zwiększać progu i nie zastępować center J średnią wierzchołków.
[Osobny plan diagnostyki](2026-11-08-rt0-center-first-failure-diagnostic-proposal.md)
zachowuje predykat i wymaga nowej decyzji przed implementacją/buildem/próbą.

## Dowody i odtwarzalność

Prywatny control:verification/rt0-centroid-diagnosis-20261108/.
Kopia naukowych danych na ext4:
examples/sushruth_2020_closed_gsg/centroid_arithmetic_20261108/.

- arithmetic_audit.py:9d7a0969205cdb6a10a94291a8c40e9c548d0ff4cb075b7b60a8f88cd763c2f9.
- arithmetic-audit.json:07916965091ec3260aadad72840afd3a71b0f98218756cc666a5269f659ce7b3.
- manifest.json:76a134c48f7d197b24f80ede395451285078b7d814f936c53357ebc8edcbc4d0.
- Interpreter Python3.10, exit0; stdout/stderr zachowane.
- Zależność: przypięty przygotowany request, bez ponownego Gmsh lub transportu.

Skrypt audytu jest odtwarzalny z tego requestu, lecz zawiera jego ścieżkę
w kontrolnym wolumenie; kopia na WSL nie jest samodzielnym solverem.
To audyt źródeł i niezależna arytmetyka, nie nowa metoda produkcyjna,
test skompilowanej bramki ani publikacja dokumentacji użytkownika.
