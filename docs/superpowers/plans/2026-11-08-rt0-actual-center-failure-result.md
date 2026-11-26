# Rzeczywista odmowa J w GSG — wynik ograniczonej diagnostyki

08.11.2026. Rejestr wewnętrznej walidacji, nie kwalifikacja publikacyjna.
Właściciel fizyki i kontraktu: [nota0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md),
sekcje „Exact accepted preimages — planowane native output identities” i opisu carrierów cell-local/cell_centers.
Kontekst publikacji pozostaje w [nocie0951](../../physics/0951-sushruth-2020-forward-volume-reference.md).
Publiczna dokumentacja fizyki, Python API i ProblemIR nie zostały zmienione.

## Wynik i granica wniosku

Checkpoint v2,17 regresji v1/v2 oraz76 regresji restartu/historii przeszły.
Pełne CI42519781724 zakończyło się sukcesem. Jeden managed build grupy3203:
succeeded. Scena i generated source po restore mają identyczne hashe jak wcześniej.

Wykonano jeden Submit. Po timeout klienta potwierdzono jego wynik przez GET,
bez powtórzenia POST. Jedna materializacja uruchomiła jeden task.
Native FEM CPU/double wykonał V/J oraz20/20 targetów H. Po438,805s przeszedł
do validating_result. Exit1, bez timeout lub Stop: cell-local J interpolation mismatch.
Catalog ma Failed i0 accepted artifacts. Brak zaakceptowanego V/J/H tej siatki.

Świadek zachował pierwszą odrzuconą komórkę28881, oś1 (y).
Z czterech kanonicznych strumieni RT0 odtworzono bitowo wszystkie12
składowych J w wierzchołkach i3 składowe w zapisanym środku.
Ta odmowa wynika z porównania próbek w dwóch minimalnie różnych punktach,
nie z wykazanej niespójności tych15 wartości z momentami RT0.
Nie rozstrzyga poprawności pozostałych komórek, H, źródła ani Fig.3 publikacji.

## Parametry i wyniki odczytu

| Token | Znaczenie | Wartość | SI |
|---|---|---|---|
| $N_K$ | źródłowe Tet4 |40728| $1$ |
| $N_H$ | wykonane punkty H |20/20| $1$ |
| $\overline J_y$ | dotychczasowa średnia czterech próbek cell-local |5,173730431328245e-9| $\mathrm{A\,m^{-2}}$ |
| $J_y(\mathbf r_c)$ | retained próbka w zapisanym środku |5,173730431328843e-9| $\mathrm{A\,m^{-2}}$ |
| $d$ | zmierzona różnica bezwzględna |5,972244022632860e-22| $\mathrm{A\,m^{-2}}$ |
| $\tau$ | dotychczasowy budżet128epsilon64 razy max nodalne abs(J_y) |5,881850519618007e-22| $\mathrm{A\,m^{-2}}$ |
| $d/\tau$ | różnica/budżet |1,015368208136769| $1$ |
| $\delta y$ | zapisane y środka minus dokładne y barycentrum |−8,470329472543003e-22| $\mathrm m$ |
| $\lambda_3(\mathbf r_c)$ | waga czwartego wierzchołka w zapisanym punkcie |0,2500000000000288| $1$ |
| $J_{\max}$ | max abs składowej nodalnej tej komórki |591191588,5409169| $\mathrm{A\,m^{-2}}$ |

Nie dopasowano tolerancji do wyniku. Niezależny odczyt barycentryczny użył
faktu, że pierwsze trzy współrzędne y są bitowo identyczne i ich J_y wynosi0.
Dokładne ułamki dla zapisanego punktu dają wagę0,2500000000000288 zamiast1/4.
Interpolacja po zaokrągleniu do binary64 różni się od native J_y o1ULP.
Waga dokładnie1/4 daje bitowo dotychczasową średnią; bramka porównuje ją
z próbką minimalnie innego punktu i odrzuca.

Analiza z momentów używa dokładnych ułamków i jawnego nearest-even binary64;
nie wykonuje ponownie cpp_rational::convert_to lub MFEM. Zgodność15 bitowych
próbek jest obserwacją tego przypadku. Różnica względem największej składowej
komórki to około1,01e-30, nie globalne oszacowanie błędu źródła.

## Wykonanie i provenance

- Run:run-d04ef5217d24a697985f08e449c0648bbc5629402b7be74f6292ce08abfe7046.
- Task:task-bbb58bc0dc7acd815d36f300e9cb94c8d9c8fa711beb288863e8cc4ff114e08d.
- Attempt:attempt-3f8996a1f2a54c54b5d06763059c4c7d, ownership epoch1.
- Request SHA256:d2c8add5027af0fa253643578fe82415c9ed1b1ee33d6f8866217b2c3050d656.
- Payload fingerprint:367163b12b208c5231dd36915e200f3b2d9d5e78c887d24043302e5389ca5a95.
- Build snapshot:e03f86278ae0900f27545eefdfb7c273c6565e4c4d750f931572f9989ecb3c87.
- Build commit:cf7db0ddc58d0c6e546531d8c8046ff22ce4191f.
- Exit receipt SHA256:b15f923959c9e9fc6e389395c091ecbcec52cad6f886e5a97b6cead6cc9880e9.
- Analiza SHA256:57b306e79a897f77215eefa733386b55a1fdc27d40e0cf5c2ceabfdeab2a9117.

Przygotowana siatka i fizyka są identyczne; zmieniono tylko run_id i idempotency_key.
Nie uruchomiono Gmsh. Zwykłe przygotowanie taska użyło zachowanych assetów.
Minimum1CPU/4GiB; grant istniejącej polityki3CPU/5,25GiB RAM i7GiB scratch.

| Realizacja | Dowód tego etapu |
|---|---|
| FDM CPU | nie wykonywano; brak wniosku o kwalifikacji |
| FDM GPU | nie wykonywano; brak wniosku o kwalifikacji |
| FEM CPU | jedna rzeczywista próba double, Failed; świadek i odczyt zachowane |
| FEM GPU | nie wykonywano; build nie stanowi kwalifikacji |

CI bada commit brancha. Managed snapshot wiąże rzeczywisty dirty worktree,
w tym wcześniejsze lokalne zmiany pominięte w commitach diagnostyki.
Nie przypisujemy całemu dirty worktree kwalifikacji na podstawie CI.
Szczegóły pakietu: [raport v2](2026-11-08-generated-authoring-stable-owner-v2-execution.md).

## Dane i źródła implementacji

Dane na ext4 WSL: examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/.
Zachowano captured-script, request, pełny receipt, analizę i odczyt geometrii.
Mały fixture offline-analysis/fixtures/actual-first-center-refusal.json zawiera
tylko świadek, bez tokenów lease. Dowody techniczne buildu są w wolumenie
grupy pod verification/rt0-center-diagnostic-execution-20261108/.

- backends/fem/cpu/mfem/transport/closed_loop_source_snapshot.hpp::export_closed_loop_source_snapshot — centroid i próbki retained.
- backends/fem/cpu/mfem/transport/affine_rt0_element.cpp::AffineRt0Element::retained_current_at — ocena RT0.
- crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs::verify_owned_geometry — geometria środka i kolejność kontroli.
- ten sam plik::verify_center_current — niezmieniona nierówność i świadek.
- ten sam plik::verify_rt0_sample_moments — związanie nodalnych próbek ze strumieniami.
- crates/fullmag-api/src/accepted_study_supervisor.rs::worker_failure_reason — trwały transport raportu.
- examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis/verify_rt0_center_witness.py::analyze — odczyt RT0 i bramki.
- examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis/actual_geometry_readback.py::weight — niezależna waga w zapisanym punkcie.

## Domknięcie i dalsza praca

Oba lokalne lease i obie rezerwacje hosta mają released. Jest dokładnie jeden
worker attempt i jeden exit receipt. Kolejka jest pusta, API odpowiada ok.
Dwa historyczne katalogi zachowały wcześniejsze SHA256. Nie zmieniono Failed,
nie ponowiono Submit/Solve, nie wykonano H-only lub LLG i nie usunięto danych.

Ograniczony cel diagnostyczny jest wykonany. Dalsza naprawa ma uzgodnić
walidację J z deklarowanym punktem próbkowania i kanonicznymi momentami RT0;
wymaga osobnego projektu i decyzji o chronionej bramce. W tym etapie
nie zmieniono predykatu, tolerancji, J ani formatu accepted source.
Reprodukcja publikacji i akceptacja pola pozostają nieukończone.
