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

## Granice i zgodność

Nieznane schema IDs zachowują istniejącą semantykę opaque leaf.
Nie stosuje się heurystycznego skanowania JSON ani typowania po nazwie pliku.
To ograniczenie pozostaje otwarte: nowego formatu strukturalnego nie wolno
publikować przed dodaniem jego typed grafu do publication, recovery, GC
i export/import. Kontrakt nie certyfikuje kompletności nieznanych schematów.

Ten przyrost nie publikuje MaterializedDataset ani wyniku porównania,
nie definiuje mapowania dataset→tensor i nie dodaje konsumenta UI.
Stan `integrity=not_verified` istniejącego endpointu artefaktów pozostaje
niezmieniony. Kwalifikacja runtime, testy recovery/import i pomiary pamięci
wymagają osobnych dowodów; source check ich nie zastępuje.
