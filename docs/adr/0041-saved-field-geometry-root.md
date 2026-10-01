# ADR 0041 — trwała geometria zapisanego pola FEM P1

Status: accepted for implementation. Data: 01.10.2026.

## Kontekst i decyzja

Przypięty tensor i jego `topology_id` nie wystarczają do odtworzenia geometrii
po zamknięciu sesji. Dodajemy dwa niezmienne obiekty CAS:
`fullmag.solution_field_geometry.v1` wiąże dokładnego właściciela i tensor,
a `fullmag.fem_p1_field_geometry.v1` zawiera kanoniczny `MeshIR` w metrach
oraz pełną semantykę pola, w tym maskę aktywnych węzłów.

Mały manifest wskazuje run, SolutionSet, origin revision, member, RunSpec
digest i dokładny `SolutionArtifactRef` tensora. Powstaje w tej samej
prospektywnej rewizji co tensor i MaterializedDataset. Rewizja terminalna
przenosi istniejący artefakt bez zmiany origin. Odczyt sprawdza zarówno
zawierającą rewizję, jak i historycznego właściciela. Nie rozszerzamy
automatycznie starych wyników o brakującą geometrię.

Payload zachowuje kolejność węzłów, wszystkich typów komórek i faset,
oryginalne markery, pary periodyczne oraz quality metadata. Mapę quality
serializujemy w deterministycznej kolejności kluczy. Semantyka obejmuje
topology fingerprint v6, aktywne wsparcie, layout i producenta. Walidacja
porównuje ją z dokładnym descriptor-em tensora. Nie interpretuje ponownie
markerów jako maski magnetycznej. Identyczny payload może być współdzielony
przez różne manifesty właścicieli dzięki adresowaniu CAS.

## Granica dowodu reprezentacji

Jedyną dopuszczoną wartością `representation_evidence` jest `not_verified`.
Kanoniczny plan i opis producenta nie dowodzą rzeczywistej natywnej
reprezentacji użytej przez solver. Natywny representation receipt nie jest
jeszcze przenoszony do publikowanego wyniku; local/true DOF oraz mapowanie
indeksów, zwłaszcza dla periodyczności, pozostają osobną bramką.

Ten artefakt nie włącza renderera przestrzennego ani nie certyfikuje wykonania
FEM CPU/GPU. Przyszły konsument ilościowy musi dostać potwierdzoną mapę
kanonicznych indeksów do reprezentacji wartości. Brak tej mapy nie może
być zastąpiony domniemaniem opartym na liczbie węzłów. Zachowujemy kontrakt
geometrii z [noty naukowej](../physics/0100-mesh-and-region-discretization.md),
bez zmiany fizyki, jednostek ani metod numerycznych.

## Integralność, retencja i ograniczenia

Publication, recovery, katalog durable objects oraz live/archive reachability
rozpoznają nowy root i sprawdzają pełny graf: binding → geometry i tensor →
chunki. Rozpoznany błędny root, konflikt właściciela, zmieniony tensor lub
powielony binding blokują operację. Brak obiektu w archive graph pozostaje
niekompletnym grafem; nie daje zgody na GC. Geometria zostaje trwałym
referencjonowanym obiektem, a pin roboczy jest zwalniany po publikacji.
Nieznane schematy zachowują istniejącą politykę opaque legacy.

Manifest ma limit 1 MiB, payload 64 MiB. Writer kontroluje limit przed
powiększeniem bufora; readery sprawdzają długość, SHA-256 i typowaną strukturę.
Parser odrzuca niekanoniczny kształt lub ignorowane pola MeshIR. Nie wymusza
bajtowej kolejności kluczy JSON; deterministyczność dotyczy generatora,
a integralność konkretnego odczytu zapewnia exact CAS hash. Jest to wewnętrzny
payload JSON w CAS, nie nowy ciężki JSON endpoint ani WebSocket message.
Limit bajtów nie jest limitem RAM: istnieją kopie MeshIR i JSON Value oraz
ponowne walidacje. Streaming, binarna/chunkowana geometria i pomiary dużych
siatek pozostają zadaniami P6 przed kwalifikacją wydajności.

## Implementacja i weryfikacja

Właścicielem kontraktu jest `fullmag-session::solution_field_geometry`.
`fullmag-runtime-control::study_dataset::attach_recorded_datasets` publikuje
root z accepted resolved planem, a replay przenosi istniejące referencje.
`SessionStore`, `SolutionSetCatalog` i oba walkery reachability egzekwują
closure. API, generated client i workspace otrzymają osobny kontrakt
transportu; discovery geometrii nie wymaga osobnego Results store.

Wymagane są review i produkcyjna kontrola źródeł. Regresje opisują corruption,
brak payloadu, historycznego ownera, duplicate binding, pin release i archive
closure. Obecny zakaz kompilacji unit tests oznacza, że ich wynik pozostaje
NOT RUN. Runtime publication/FMS round-trip, HTTP, WebGL, RAM, natywna
reprezentacja, nauka i release wymagają odrębnych dowodów.

Rollback wyłącza nową produkcję, zachowując reader i traversal już zapisanych
rootów. Usunięcie readerów przy istniejących danych naruszyłoby retencję.
