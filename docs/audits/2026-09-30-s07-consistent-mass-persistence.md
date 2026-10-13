# S07: zapis i odczyt consistent P1 mass — źródła WIP

## Zakres i wynik

Dodano jawny rekord `fullmag.tracking_consistent_p1_metric.v1`: definition_id,
tożsamość siatki, uporządkowane physical_node_indices, tetra w indeksacji
kompaktowej i objętości SI m³. Odtwarzanie przechodzi przez walidowany
konstruktor. Nieznane pola, wersja, definicja, sprzeczna siatka i niepoprawne
objętości/indeksy są odrzucane. Rekord jest zapisywany przez oba writery
metadanych modów: adapter FEM oraz publikację mode_bundle.

Adapter Kittel odtwarza metrykę i wybiera fizyczne węzły z pełnego pola
global_xyz. Zachowuje pełne lifted real/imag do publikacji; nie obcina
ich do kompaktowego pola trackingowego. Zapis odrzuca sprzeczne diagonalne
wagi, niezgodną siatkę i indeksy poza polem przed tworzeniem plików.
Odczyt odrzuca wadliwe XYZ zamiast usuwać wiersze oraz nie traktuje
uszkodzonego/niejednoznacznego JSON-u jako brakujących metadanych.

## Dowody

| Kontrola | Wynik | Zakres |
|---|---|---|
| Rustfmt parse/check 4 plików | exit 0 | Składnia/format; bez kompilacji |
| Walidator source-map 0831 | exit 0 | Kontrakt dokumentacji |
| Testy walidatora dokumentacji | 32 PASS | Python interpretowany, nie solver |
| Diff check zmienianych plików | exit 0 | Format zmian |
| 4 nowe regresje Rust | NOT RUN | Roundtrip, korupcja, selekcja globalnych węzłów, mieszane metryki |
| Runtime i nowe częstotliwości | NOT VERIFIED | Nie zlecono joba |

## Pozostałe bramki

Źródła są niezacommitowanym WIP. Nie skompilowano ani nie uruchomiono
regresji Rust; trwa zakaz kompilacji testów. Nowy tracking_mass.rs pozostaje
untracked i wymaga jawnego include-untracked przed snapshotem. Legacy
artefakty bez rekordu nadal mają legacy normę i nie dowodzą consistent P1.
Nie zamknięto pełnej equilibrium identity, persistent nonzero-k branch
reload/transport, crossingów ani kwalifikacji pełnej ścieżki. Inline rekord
powtarza metrykę per mod; wydajny współdzielony artefakt i jego integracja
z kontraktem API pozostają do oceny S07.

Runner odczytany na żywo w poprzedniej turze: zdrowy, 0 aktywnych jobów,
8 483 958 784 B wolnego przy wymaganych 8 589 934 592 B. Runtime-only
nie ma w allow-list. Nie zmieniono profili ani nie usunięto danych.
Wyniki pozostają 19 punktów; przygotowana ścieżka to 52 punkty DE/BV.
Cały plan S00–S12 pozostaje aktywny i nieukończony.

## Tożsamość roboczych źródeł

| Plik | SHA-256 |
|---|---|
| `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `277fa9e86bd80edb003d13c703e9c5092757d98f8c2c12aa00f6d85a135df998` |
| `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `7d89da6b439cb107f0067684d10abaa3d31e34a27ae952dfa5818b81ecaa3f7f` |
| `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` | `878dc3df22b851af54349906599173d32b3cca1f23438e6ea4ee342bced32521` |
| `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `daa1b2f25627b233f38651d01bf66b403de5fa4e87b50c9ee67164f65839f4bf` |


## Następny przyrost: integralność legacy i identity

Usunięto filter_map wadliwych wag, obcinanie globalnych pól do liczby
wag, dopisywanie zerowych komponentów i porzucanie niezgodnych wag.
Wagi muszą być dodatnie, skończone i mieć dokładnie długość pola.
Starsze artefakty z krótszymi wagami bez jawnej mapy są odrzucane,
ponieważ prefix nie dowodzi wyboru węzłów magnetycznych.

Jawne real/imag wymagają obu niepustych tablic. Wadliwe lub puste
tablice nie uruchamiają binary fallback. Wyszukiwanie binary i metadanych
odrzuca duplikaty. Zadeklarowany mode_field_sample_count wiąże liczbę
węzłów pola. Raw/index i opcjonalny sample_index muszą odpowiadać
żądaniu; adapter Gamma odrzuca niezerowy lub wadliwy k_vector.

Dodano 4 dalsze regresje Rust: wagi, niepełne/empty pola, identity
metadanych i duplicate binary. NOT RUN — zakaz kompilacji pozostaje.
Rustfmt parse/check, focused source-map validator i diff check: exit 0.
Wynik 32 PASS z wcześniejszego przyrostu dotyczy niezmienionego walidatora
dokumentacji; nie jest wykonaniem tych regresji ani solvera.

WIP nadal wymaga kompilacji/runtime i kontroli konsumentów oraz
wersjonowanej integracji API. Ten przyrost nie zamyka S07 ani planu.
Nowych częstotliwości brak.

Aktualny hash kittel.rs po tym przyroście: `561fa7024e8e7efa97d7ddc432569d3091bdacd6bbd755e2cf3540b6e8d75f96`.


## Następny przyrost: selektor Gamma w pamięci

Przegląd potwierdził, że branch_candidate wymaga poprawnej obserwabli
jednorodności; same częstotliwości bez pola nie wystarczają do wyboru.
Jednak k0_kittel_mode_uniformity_score po błędzie projekcji ważonej
próbował normy euklidesowej, a potem lifted pola. Ten fallback usunięto.
Zadeklarowana metryka wymaga poprawnego reduced_vector; jego błąd
nie przełącza na inne pole. Lifted real/imag wymagają tej samej niezerowej
liczby węzłów; brakująca część nie jest zastępowana zerami.

Dodano 2 regresje Rust obejmujące błędne wagi, brak reduced_vector,
asymetryczne lifted i wadliwą długość reduced. NOT RUN. Rustfmt
parse/check, focused source-map validator i diff check: exit 0.
Żadnego testu Rust nie kompilowano i nie zlecono runtime.

S07 i pełny plan pozostają otwarte. Legacy rozróżnienie reprezentacji
XYZ/tangent nadal opiera się na dawnym układzie/lenghcie — nie jest
kwalifikacją nowej metryki consistent P1. Osobnego przeglądu wymagają
pozostałe defaulty metryk certyfikatów, zwłaszcza seam/tangent/overlap;
nie zaliczono ich przez tę poprawkę. Nowych częstotliwości brak.

Aktualny kittel.rs SHA-256: `cf57e288e77f56cbd5a29a2331c73b46a820ca4c5eb2d168a6a2a436451b547d`.


## Następny przyrost: brak pomiaru seam nie jest zerem

Znaleziono hardkodowane max_periodic_seam_mismatch=0.0. W źródłach
zmieniono tę miarę na Option; adapter bez pomiaru emituje pustą
komórkę CSV. Summary rozdziela frequency_comparison_status od statusu
pełnej walidacji. Nieobliczony seam daje partial i NOT VERIFIED,
nie passed pomimo zgodności częstotliwości. Obliczenia per-mode seam
nadal brak — usunięcie fałszywego certyfikatu nie jest jego implementacją.

Dostosowano dwie istniejące regresje Rust do partial; NOT RUN. Dodano
interpretowaną regresję bramki dla pustego seam. Wynik: 2 PASS
(nowy przypadek odrzucenia i dotychczasowy kompletny fixture), 211 deselected.
To wykonanie walidatora Python, nie zmienionego Rust. Focused scientific
source-map i Rustfmt parse/check obu plików: exit 0.

Aktualny live runner: worker_alive=true, accepting_jobs=true, 0 active
jobs; storage_free_bytes=8 950 689 792 > 8 589 934 592. Blokada
progu miejsca ustąpiła. Runtime-only nadal nie jest w allow-list,
a modal-v1 kompiluje unit tests objęte zakazem. Brak zgody na
zmianę profilu/wyjątek; nie zlecono joba ani nie zmieniono runnera.
Nowych częstotliwości brak.

Źródła pozostają WIP. Kittel kittel.rs SHA-256: `0a0532f067b7ded781ad1eee0381abe4ef7727f557cca7cf38e1972a1e43a87f`.


## Następny przyrost: rzeczywisty pomiar magnetycznego seam (WIP)

ConsistentP1TrackingMetric.periodic_seam_relative odtwarza fizyczne pole
z envelope i porównuje slave z fazowanym reprezentantem klas redukcji.
Zwraca liczbę rzeczywiście sprawdzonych slave i maksimum defektu XYZ
znormalizowane globalnym maksimum normy XYZ. Skalowanie redukuje ryzyko
overflow. Brak slave zwraca None, nie zerowy certyfikat.

Adapter wywołuje pomiar wyłącznie dla BC periodic/floquet. Zapisuje
mode_periodic_seam_measurements związane z mesh, sample/raw ID, k
i częstotliwością. Kittel używa pojedynczego zgodnego rekordu i
consistent mesh identity; sprzeczności/duplikaty pozostają bez pomiaru.
Zakres magnetic_cartesian_field_only nie obejmuje phi ani równowagi.
Summary nadal ma partial przy zgodnej częstotliwości: dostępność pomiaru
nie ustanawia tolerancji ani runtime qualification. Missing_evidence
obejmuje seam acceptance gate, phi certificate i managed runtime.

Dwie nowe regresje Rust: poprawny/odwrócony znak fazy, amplituda/faza
globalna oraz brak par/niepoprawny wektor. NOT RUN. Rustfmt parse/check
trzech plików, focused source-map po naprawie etykiety i tabeli symboli,
diff check: exit 0. To dowód składni/dokumentacji, nie wykonania Rust.

Źródła pozostają WIP; runtime-only poza allow-list i zakaz kompilacji
unit tests nadal blokują modalny build. Nowych częstotliwości brak.
Cały S00–S12 pozostaje aktywny. Kolejne bramki: tolerancja rzeczywistego
seam, phi/airbox, kompilacja i runtime, pełna ścieżka oraz nauka.

| Plik | Aktualny SHA-256 |
|---|---|
| `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `27bb3e9bf0302550525034620c307339254506770e592c15a1e7a35e18500f08` |
| `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `41a695c48aa3549ac09d13785ea77371cd97212abaee82d1412808a1dd72cd47` |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `979940287787c0967c55f335eec0ca6a92c6b6050fb89b0284a4f1b0c4eb771a` |


## Checkpoint niezależnego audytu pól

Narzędzie explicit-pair diagnostic, 7 PASS, raport 19 prawdziwych modów
i jego naukowa dokumentacja: commit
`bd70b6d9215662fe10b5a21180402fb95b253593`, push na branch zadania.
Exact staged source-map validation exit 0; staged tools identyczne
z wykonanymi źródłami. Raport: docs/audits/2026-09-30-archived-de-bv-magnetic-seams.md.
Max defekt 3.3852323788985243e-16, po 28 par/mod; błędny znak
fazy wykrywa defekt 0.1598…1.68294. To dowód historycznych
magnetycznych pól, nie zmienionego Rust, phi ani nowego solve.
Pozostały solver WIP nie dołączony do commita; pełny cel nadal aktywny.


## Checkpoint archiwalnego phi/H_demag

Commit 3d7690c1a39adfed4bbc4757b060a5f257cf9694 został wysłany; local HEAD=remote ref.
6 interpretowanych regresji PASS; 19 rzeczywistych pełnych phi i H_demag
powiązanych hashami i operatorem. Max defekt Floqueta phi
2.2887833992611187e-16, phi=0 na zewnętrznych z planes,
volume-weighted -grad(phi)/H_demag defect 1.6741805960076105e-15.
Staged scientific validator exit 0; staged narzędzia zgodne z przetestowanymi.
Dowód spójności historycznych pól, nie niezależnego Poissona,
weak flux, zbieżności ani wykonania nowego Rust. Solver WIP
nie dołączony do commita; brak nowych częstotliwości.
