# Zachowanie object_id magnetyka — wynik wdrożenia, 07.11.2026

## Wynik

Naprawiono utratę istniejącego object_id w typowanym builderze Rust i obu
adapterach SceneDocument. Nazwa użytkownika może się zmieniać, a ID pozostaje
stałe. Poprawka jest na branchu zadania; nie wdrożono nowego pakietu do API 3203.

Zastosowano zatwierdzony patch SHA256
9cc76ed39ca056413a467eb680bc974cb35a7ba591ea9bcbf68a53d2e64fcef2.
Wszystkie pięć plików roboczych odpowiada dokładnym hashom candidate_sha256
z manifest-v3.json. Jedyną dodatkową zmianą jest jawne wait_for_solve(True)
w istniejącym fixture Python, którego nieaktualne założenie ujawniło szersze CI.

Nie wdrożono shared_domain_mesh_source, marker_bindings ani migracji V04.
Ta naprawa jest warunkiem trwałych referencji, nie dowodem poprawnego
roundtripu całego meshu GSG lub reprodukcji Fig. 3.

## Zakres źródeł i zgodność

| Ścieżka + symbol | Odpowiedzialność |
|---|---|
| crates/fullmag-authoring/src/builder.rs::ScriptBuilderGeometryEntry | opcjonalny object_id: Option<String>; brak/null zachowuje None |
| crates/fullmag-authoring/src/adapters.rs::scene_document_to_script_builder | przenosi SceneObject.id jako jawne Some(id) |
| crates/fullmag-authoring/src/adapters.rs::scene_object_from_geometry | wybiera podane ID; name tylko dla None |
| crates/fullmag-authoring/src/adapters.rs::scene_document_to_script_builder_overrides | bez zmiany: końcowy rewrite już zachowywał ID |
| crates/fullmag-api/src/types.rs::tests::sample_builder | pełny inicjalizator pola |
| crates/fullmag-api/src/router_v2/tests.rs::sample_scene_document | pełny inicjalizator pola |
| .github/workflows/bootstrap.yml::rust-contracts | siedem regresji magnetic_object_id_ |
| packages/fullmag-py/tests/test_scene_document_problem_ir.py::test_scene_document_problem_ir_matches_fem_authoring_surface | fixture jawnie deklaruje oczekiwany wait, asercja pozostaje ścisła |

Brak lub null w dawnym builderze nadal daje dawną tożsamość opartą na name.
Jawnie puste ID nie jest naprawiane do nazwy; istniejąca walidacja je odrzuca.
Tak samo odrzucane są zdublowane ID przy różnych nazwach.
Po Scene→builder ID jest jawne, także dla starego dokumentu. Nie obiecujemy
zachowania nieobecności klucza, tylko zachowanie tożsamości.

Starszy pakiet Rust nadal może pominąć nieznane mu object_id. Nie deklarujemy
jego bezpiecznej forward compatibility. Odbiór produkcyjny wymaga spójnego
pakietu authoring/API/Python. Nie zmieniono publicznego writera ProblemIR 0.3,
endpointów, SI, aktywacji fizyki ani zasad walidacji sceny.

## Dowód RED → GREEN

1. [RED 42373884418](https://github.com/MateuszZelent/fullmag/actions/runs/42373884418),
   b7901293e831f9a834463beea7808f6714a23a1f: siedem testów skompilowano
   i wykonano przed poprawką. Jeden legacy przeszedł, sześć nie przeszło.
   Właściwa asercja pokazała left=flower, right=immutable-A. Rename zamieniał
   ID na Renamed sample; odwołanie regionu przestawało odpowiadać rodzicowi.
   To błąd kontraktu, nie awaria konfiguracji testu.
2. Kod poprawki: 9fa93114476cebfa5f1fa9a4a97686dd8dfadfdf.
   [Bootstrap GREEN](https://github.com/MateuszZelent/fullmag/actions/runs/42374520930):
   success: rust-contracts i inspector-actions-browser-smoke zakończyły się poprawnie; pominięte joby profilu nie stanowią dodatkowego dowodu.
3. [Pierwsza pełna kontrola 42374717635](https://github.com/MateuszZelent/fullmag/actions/runs/42374717635)
   potwierdziła pełną bibliotekę authoringu, ale wykryła stary fixture Python:
   64 testy przeszły, jeden oczekiwał wymuszonego wait bez zadania go w DSL.
4. Fixture skorygowano w 6a85162cd73a2256f3c882e64f5a8a26ceec8846,
   zachowując produkcyjną semantykę oraz ścisłą asercję.
   [Pełne CI 42375241700](https://github.com/MateuszZelent/fullmag/actions/runs/42375241700):
   cztery joby success, w tym 198/198 testów fullmag-authoring,
   65/65 konwersji sceny Python oraz 10/10 materializacji profilu aplikacji.

198 testów zawiera siedem nowych regresji: JSON i oba adaptery, rename,
brak/null, puste ID, duplikat, regiony oraz mapowanie FDM przez rename.
Nie należy sumować nakładających się uruchomień jako różnych testów.
Dodatkowe kontrole istniejącego workflow obejmowały polityki IR i solvera
oraz authoring modalny; ich powodzenie nie kwalifikuje solverów fizycznych.

Bootstrap przypięto do kodu poprawki 9fa931144…; pełną kontrolę do 6a85162cd…
Jedyna różnica między tymi commitami to wskazany fixture Python. Pliki Rust,
workflow oraz trzy pliki Python testowane w kroku execution-intent są identyczne.
Nie podmieniono hasha CI na późniejszy commit dokumentacyjny.

## Review, decyzje i niewykonane bramki

Niezależny końcowy przegląd wszystkich zmienionych linii pięciu plików,
inicjalizatorów, walidacji i adapterów nie wykazał wymaganych poprawek.
Przegląd wskazał brak pełnego istniejącego testu roundtrip w filtrach bootstrap;
dlatego uruchomiono istniejący workflow pełnego authoringu.

Decyzje wykonawcze:
- Dokładny zatwierdzony patch rozdzielono na testy/workflow RED i kod GREEN,
  aby testy mogły odtworzyć błąd przed naprawą. Ryzyko błędnego podziału
  wykluczono odczytem asercji RED oraz porównaniem pięciu końcowych hashów.
- Dołożono istniejącą pełną suitę authoringu bez edycji workflow.
  Koszt tej decyzji to dodatkowy czas CI.
- Stary fixture zachował oczekiwanie True, ale teraz jawnie je deklaruje.
  Nie przywrócono produkcyjnego wymuszania flag; osobne przypadki brak/False/True
  pozostają pokryte. Ryzyko zmiany sensu fixture kontroluje pełne CI 65 testów.

Nie ma odroczonych uwag kosmetycznych z tego review.
Chronione 63 wpisy współdzielonego indeksu zachowały hashe raw i binary
sprzed wdrożenia. Nie commitowano pozostałego WIP w plikach API.
Hashe kandydata opisują pliki robocze z zachowanym WIP; CI sprawdza
wskazane commity z selektywną poprawką. Nie jest to kwalifikacja całego
brudnego worktree ani dowód kompilacji pozostałych zmian API.

| Realizacja | Dowód tego etapu |
|---|---|
| FDM CPU | wspólny authoring; test referencji siatki, solver niewykonany |
| FDM GPU | wspólny authoring, solver niewykonany |
| FEM CPU | wspólny authoring, solver niewykonany |
| FEM GPU | wspólny authoring, solver niewykonany |

Nie wykonano native buildu, restartu usług, nowego przygotowania/Solve,
migracji ledgeru ani zwolnienia rezerwacji. Odbiór managed pozostaje
NOT VERIFIED i nie należy do tej zgody.

## Odtwarzalne dowody

Prywatny control volume grupy 3203:
verification/magnetic-object-id-roundtrip-20261107/approved-execution/.

| Plik | SHA256 |
|---|---|
| red-rust-contracts.log | 63f10313a5aa5cbf7d0b712c5acd0be7921b34f56c0a89a1389df1c84f2c9a55 |
| bootstrap-rust-contracts.log | 8d0b8219aa3be8141414b0b45510fb31e971d2a5ac0f1ad6ec55501d5452fd5e |
| full-authoring.log | 524bf8b4279ee3a01d60b07197bd29962b940cb769e94fc28da7912dc018336c |
| scene-lowering.log | 9618d1c0ed4056da0ccc87a536c920276780c165db1d72c73d568d3a12e44723 |
| scene-analysis-lowering.log (zachowany błąd fixture) | 988e1134e8ec2a4e9c88195c788d35be127faaf0bc690c3ad294ee1ce81332bd |

Dodatkowy manifest wykonania przypina commity, CI, pięć plików oraz stan indeksu.
Kopie drobnych metadanych i ledger etapów są w .superpowers/sdd/
2026-11-07-magnetic-object-id-roundtrip-implementation/ na ext4 WSL.

## Osobny odczyt rzeczywistego UI

Przeglądarka na 3203 była dostępna. Zakładka Telemetry → Antenna pokazała
Antenna stage configured — not started, inspect_gsg, Source: antenna,
Transport: gsg_charge. API potwierdziło run=null i stage execution=null.
To dowód rozpoznania zadanej anteny przed Compute, nie dowód nowego obliczenia.

Zachowany projekt five-readruns istnieje i ma poprawny manifest projektu,
SHA256 273097a79355802f6cc6f75b5ff79ca72dd41cf349e81d75ba383bef3efd9306.
Dodano go do indeksu ostatnich projektów, ale przeglądarkowa próba otwarcia
po ścieżce odmówiła z komunikatem wymagającym integracji desktopowej.
Nie uzyskano nowego odbioru H275 w tej karcie i nie zmieniono wyników.

Potwierdzony brak E7 pozostaje otwarty: SavedFieldVisualizationPanel nie
udostępnia clipping controls. Istniejący ClipPlaneLayer stosuje globalną
płaszczyznę renderera, a widok Saved dostarcza własne bounds; nie podpięto
jeszcze tych kontrolek ani nie nazwano tego braku naprawionym.
