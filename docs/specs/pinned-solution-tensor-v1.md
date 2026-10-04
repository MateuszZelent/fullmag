# Przypięty tensor SolutionSet — kontrakt v1

## Tożsamość i właściciel

Resolver `fullmag-session::solution_tensor_source::resolve_solution_tensor`
odczytuje dokładnie `run_id`, `solution_set_id`, dodatnią `solution_revision`,
`member_id`, `artifact_id`, `tensor_object_ref` oraz `run_spec_digest`.
Nie wybiera bieżącej rewizji, aktywnej sesji ani pierwszego dostępnego artefaktu.
`tensor_object_ref` jest surowym lowercase SHA-256 CAS, a RunSpec digest ma
postać `sha256:<64 znaki>`. Run intent jest odczytywany z limitem 16 MiB;
jego identyfikator, zweryfikowany digest payloadu i provenance SolutionSet
muszą odpowiadać przypiętemu źródłu.

Właścicielem projektu nadal jest warstwa aplikacji/API. Ten resolver sesji
nie zastępuje autoryzacji projektu i nie jest publicznym endpointem data plane.
Zwraca oryginalne statusy wykonania, oceny naukowe i accepted state.
Poprawne metadane nie zmieniają wyniku w converged, quantitative ani qualified.

## Typowany graf CAS

Wyłącznie artefakt z `schema_id=fullmag.tensor.v1` aktywuje typed traversal.
Root musi mieć zgodną pełną długość i SHA-256, najwyżej 4 MiB i poprawny
`TensorDescriptor` bez nieznanych pól. Wymagane są little endian, niepusta
nazwa, unikalne niepuste logical axes, zgodna liczba osi i wymiarów (maksimum 32),
niezerowy rozmiar bez overflow oraz od 1 do 16384 chunków.
Chunk references mają poprawne hashe; opcjonalny checksum jest zgodny z CAS.
Zakresy po uporządkowaniu są ciągłe, bez nakładania, zgodne z rozmiarem shape
i wyrównane do szerokości dtype. Oryginalna kolejność descriptora zostaje zachowana.

Publikacja pod writer lease sprawdza strumieniowo SHA-256 i pełną długość
wszystkich chunków przed zapisem rewizji. Po publikacji zarówno root, jak
i chunky należą do trwałego grafu, więc pin retirement obejmuje cały tensor.
Odzyskiwanie katalogu sprawdza typed graf przed promocją current manifest.
GC oraz oba walkery archiwów przechodzą od root do chunków, zachowując
dotychczasowe reguły incomplete/missing. Incomplete graf nie pozwala na GC.
Odczyt metadanych root z pliku jest ograniczony przed parsowaniem i alokacją;
binary payloady są weryfikowane strumieniowo w ścieżkach plikowych CAS.

Resolver metadanych weryfikuje root, lecz nie czyta wszystkich payloadów.
Odczyt wycinka nadal musi sprawdzić rzeczywiste CAS bytes; wcześniejsza
publikacja nie zastępuje integralności późniejszego odczytu.

Przed odczytem payloadów i zapisem typed SolutionSet wymagany jest zgodny,
bounded `run_intent.json` właściciela. Ta sama bramka obowiązuje przy
idempotentnym replayu, odzyskiwaniu katalogu, odkrywaniu durable objects
i StoreWalker GC. Usunięty intent albo zmieniony digest nie upoważnia do
nowej publikacji, promocji current ani zwolnienia pinów. Inspekcja istniejącej
rewizji przez read-only API pozostaje możliwa bez automatycznej naprawy;
nie usuwa się historycznych metadanych jako skutku błędu właściciela.

## Granice i zgodność

### Opcjonalny binding pola

`TensorDescriptor.field_binding` jest opcjonalnym, strict obiektem
`fullmag.tensor_field_binding.v1`. Zawiera dodatnią rewizję datasetu,
sample/item/field ID, grupę płaszczyzn, identyfikator i wersję producenta,
rolę płaszczyzny oraz pełny `DatasetFieldDescriptor`. Jest częścią tych
samych immutable root bytes i nie dodaje nowych referencji CAS.
Nieznane pola nadal są odrzucane. Brak bindingu zachowuje odczyt tensora,
ale nie pozwala na odczyt przypiętego pola przez nowy adapter.

Przed publikacją oraz w recovery/GC/FMS binding musi przejść walidację
semantycznego kontraktu i dokładnego layoutu tensora. Obsługiwane są
little-endian F32/F64, skalar `[element]` albo field `[element, component]`;
component-major i native-with-mapping wymagają oddzielnej realizacji.
Pełne osie, ich długości, component axis i rola Values/Real/Imaginary muszą
się zgadzać. Adapter nie rekonstruuje ani nie normalizuje wartości.

Odczyt `read_pinned_solution_field_slice` przyjmuje tylko request i dokładne
przypięte źródła. Opis fizyczny odczytuje z rootu, zamiast przyjmować go od
caller-a. Para real/imag wymaga dwóch różnych artefaktów/rootów w tej samej
rewizji i memberze, zgodnej grupy/producenta oraz identycznego opisu pola.
Tożsamość dataset/sample/item/field z requestu musi odpowiadać bindingowi.
Odczyt zwraca również oryginalne statusy i oceny właścicieli; nie awansuje
ich do converged, quantitative ani qualified.

Ten kontrakt sam nie dowodzi prawdziwości deklaracji producenta. Pierwszy
adapter producenta i jego walidacja opisane są poniżej; nadal wymagane są
trwały manifest MaterializedDataset oraz konsument API/UI.
Nie kwalifikuje się tego etapu jako ukończonej materializacji datasetu.
Starsze wersje strict readera odrzucają rozszerzone rooty, więc reader musi
zostać wdrożony przed włączeniem writera. Rollback wyłącza emisję bindingu,
zachowując nowe immutable rooty i reader do ich odczytu.

### Producent zapisanego stanu FEM H1 P1

Pierwszy producent korzysta z istniejącego `fullmag.runner.field_json@v1`.
Wersjonowany `layout.field_semantics` jest częścią layoutu objętego
`state_identity.layout_sha256`; top-level codec i stare layouty pozostają
zgodne. Wdrożenie nie wymaga planowanego wcześniej codec v2.

Fabryka `fullmag-runner::fem_p1_magnetization_field_semantics` odczytuje
dokładny mesh z przyjętego zwykłego planu FEM P1. Wymaga pełnej bramki
`validate_mesh_for_execution`, a markery aktywnych regionów pochodzą ze
wspólnej z runtime funkcji `normalized_runtime_element_markers`.
Maska korzysta z oryginalnej topologii i jawnych normalizowanych markerów,
bez pełnej kopii mesha. Nie korzysta z fallbacku brakujących markerów
ani nie akceptuje niejednoznacznego kontraktu regionów. Envelope `fullmag.fem_p1_m_field_semantics.v1`
zawiera jawną maskę oraz descriptor z osiami `node/component`.
Fingerprint supportu obejmuje topologię i maskę, a fingerprint layoutu
obejmuje jawny preimage przestrzeni i kolejności. Nie hashuje sam siebie.

Tylko zapis `m` otrzymuje envelope, po sprawdzeniu kompletnej liczby
węzłów i skończonych wartości. Warstwa aplikacji waliduje go względem
state layoutu. Przy tworzeniu SolutionSet materializer porównuje go także
z fabryką uruchomioną na dokładnym accepted execution planie, zamiast
ufać samemu deklarowanemu topology ID lub producentowi.

Oryginalny JSON stanu pozostaje artefaktem. Materializer zapisuje dodatkowy
F64 tensor little endian w chunkach po najwyżej 8192 węzły (196608 bajtów),
z bindingiem dataset/sample/item/field i oryginalnym accepted state.
Tożsamości wynikają z immutable ownera i dokładnego źródła, bez joinów
po indeksach lub wartościach float. Artefakt trafia do tego samego membera
przed terminal close; ponowny zapis tych samych danych daje ten sam root.
Root i chunky przechodzą dotychczasową bramkę publikacji i pin retirement.
`item_id` identyfikuje źródłowy artefakt JSON; nowy tensor ma własny,
niezmienny `artifact_id`. Binding nie jest samodzielnym dowodem właściciela:
odczyt wymaga dokładnego run/set/revision/member/artifact/root z resolvera.
Pola dataset/group są deterministyczną tożsamością tego producenta, a nie
ogólną regułą autoryzacji wszystkich producentów tensorów.

Writer i materializer wdraża się razem, po readerze rozszerzonych rootów.
Nie dodaje się tensoru wstecz do terminalnego membera lub zamkniętej rewizji;
istniejąca bramka publikacji odrzuca taki late append.

Źródłowy JSON ma budżet wejścia 64 MiB. W obsługiwanym planie FEM P1
przekroczenie budżetu zatrzymuje publikację z jawnym błędem, również dla
starego dużego JSON. Błąd budowy semantyki zatrzymuje zapis `m`; nie jest
zamieniany na brak envelope. Legacy bez envelope mieszczące się w budżecie
pozostaje oryginalnym artefaktem bez nowego pola ilościowego.
Nie powstaje zastępcze zero ani implicit solve. Chunkowany output nie jest
streamingowym dekoderem wejściowego JSON — pomiar peak RAM pozostaje osobną
bramką. Nie zmienia się StudyOutputManifest ani jego portów.

FDM CPU/GPU, FEM eigen/response, wyższe rzędy FEM oraz snapshot/Zarr
pozostają poza tym producentem. Nie oznacza to zmiany ich obsługi solvera.
`Quantitative` opisuje rozdzielczość pełnego zapisanego pola; normalization
pozostaje `None`. Nie deklaruje się converged, jednostkowej normy wektorów,
kwalifikacji FEM CPU/GPU ani parytetu urządzeń. Status i scientific assessment
pochodzą nadal z właściciela. Pełny manifest MaterializedDataset i consumer
API/UI wymagają następnego etapu.

Nieznane schema IDs zachowują istniejącą semantykę opaque leaf.
Nie stosuje się heurystycznego skanowania JSON ani typowania po nazwie pliku.
To ograniczenie pozostaje otwarte: nowego formatu strukturalnego nie wolno
publikować przed dodaniem jego typed grafu do publication, recovery, GC
i export/import. Kontrakt nie certyfikuje kompletności nieznanych schematów.

## Właściciel w archiwum FMS

Eksport typed SolutionSet dołącza jego dokładny `run_intent.json`, również
gdy właściciel nie znajduje się w `session.run_refs`. Wybór SolutionSet
oraz same `run_refs` pozostają zgodne z istniejącym profilem; nie dodaje się
niezwiązanych run manifests, leases ani działającego runtime'u.
Tożsamość intentu i zweryfikowany digest payloadu muszą odpowiadać
`run_id` i `provenance.run_spec_digest` każdej eksportowanej typed rewizji.
Brak lub konflikt właściciela zatrzymuje plan eksportu przed zapisem ZIP.

ArchiveWalker konsumuje ten intent jako właściciela typed SolutionSet,
weryfikuje powiązanie i przechodzi także jego definition/study/assets CAS refs.
Archiwum z typed tensorem bez właściciela lub z obcym digestem jest odrzucane
przed publikacją importu. Opaque SolutionSet zachowuje istniejącą kompatybilność.
Source-only round-trip regression nie jest dowodem wykonanego importu/runtime.

Ta ścieżka nie publikuje pełnego MaterializedDataset ani wyniku porównania
i nie dodaje konsumenta UI. Binding określa tożsamość pola i jego tensor;
nie zastępuje właściciela pełnego manifestu datasetu ani jego definicji.
Stan `integrity=not_verified` istniejącego endpointu artefaktów pozostaje
niezmieniony. Kwalifikacja runtime, testy recovery/import i pomiary pamięci
wymagają osobnych dowodów; source check ich nie zastępuje.
