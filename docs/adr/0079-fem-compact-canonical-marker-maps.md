# ADR 0079: zwarte atrybuty FEM dla kanonicznych markerów u32

Status: przyjęte. Implementacja i opisane poniżej ograniczone bramki runtime
CPU/GPU zostały zweryfikowane; zakres wyników określa raport kwalifikacji.

## Kontekst

Publiczne identyfikatory regionów i markerów mają domenę u32. MFEM wymaga
atrybutów typu dodatni int, a jego tablice markerów mają długość max(attribute).
Przenoszenie publicznego ID bezpośrednio do atrybutu powoduje alokacje zależne
od wartości ID, odrzuca rzadkie wysokie ID i może utożsamiać granice 0 i 1.
Zmiana reprezentacji nie może zmieniać stopni swobody ani praw fizycznych.

## Decyzja

Każdy import posiada osobne mapy domen i granic: canonical u32 → compact int
oraz mapy odwrotne. Dodatnie atrybuty 1..R odpowiadają uporządkowanym rosnąco
niezerowym markerom; obecne zero otrzymuje ostatni atrybut. Zero pozostaje
markerem powietrza w kanonicznych danych domen, a nie indeksem MFEM.
Mapa granic obejmuje tylko rzeczywiście wyemitowane fasety exterior/seam.
W głównym builderze brak tablicy markerów zachowuje canonical default 1.
Accepted transport bez markerów domen zachowuje dotychczasowe atrybuty
per element (ElementNo+1); nie tworzy dla nich pozornej mapy regionów.

Mapy należą do konkretnego kontekstu/importu, są publikowane z udaną siatką
oraz usuwane przy jej zniszczeniu. Nie ma globalnego mutable cache. Pamięć map
zależy od liczby różnych markerów, nie max-ID ani liczby powtórzeń. Lookup
forward jest średnio O(1), reverse O(1); sortowanie R markerów odbywa się tylko
przy imporcie. Ograniczenie liczby encji przez int w MFEM nadal obowiązuje.

Wszystkie selektory publiczne są tłumaczone przed assembly: BC Poisson,
periodyczność, modalne airbox/Floquet i transport. Nieznany marker jest błędem,
nie pustym warunkiem. Istniejące ograniczenia konkretnego BC i facet0
transportu pozostają w mocy. Legacy transport zachowuje atrybuty domen
ElementNo+1, ponieważ jego PWConstCoefficient jest per-element; nie wolno
zastępować ich markerami materiałowymi bez zmiany współczynników. Jego granice
oraz jawnie oznaczone domeny accepted transport używają oddzielnych map.
Digest accepted source odtwarza kanoniczne ID przez mapę odwrotną.

Kanoniczne bufory i ich publiczne fingerprinty nie zmieniają znaczenia.
Wewnętrzna tożsamość operatorów zawiera politykę zwartej reprezentacji, aby
nie przyjąć starego operatora przy nowym mapowaniu. Mapowanie nie rozcina pola
magnetyzacji na regiony i nie zmienia ciągłości ani fizycznego strumienia.

## ABI i zgodność

Dotychczasowy signed selector w plan desc v2/v3 zachowuje layout i semantykę.
Nowy desc v4/create v5 przenosi jawny canonical u32 selector z wersją,
rozmiarem i zachowanym prefiksem v3. Nie reinterpretujemy ujemnych int jako
wysokich ID. Override trafia do inicjalizacji przed importem demag/BC.
Publiczne MeshData, lead intent i parser accepted source zachowują pełne u32.
Stare nieujemne bufory NPZ int32 są czytane bez zmiany oryginalnych bajtów
i semantycznych fingerprintów; nie reinterpretujemy ujemnych wartości.
Robocze tablice ze znacznikiem braku -1 używają int64. Gmsh/COMSOL otrzymują
zwarte dodatnie tagi eksportowe; istniejący hash-bound sidecar odtwarza
kanoniczne ID. W tym trybie nazwa grupy nie zastępuje jawnej mapy markerów.

Rust FFI i runner przechodzą razem z biblioteką; nie ma cichego użycia starego
ABI dla wysokiego ID. Role granic w IR używają u32; stare nieujemne dokumenty
pozostają zgodne, ujemne markery są nieprawidłowe.

## Weryfikacja i migracja

Wymagane są rzeczywiste importy z 255/256/257/1000 markerami, rzadkimi ID ponad
INT_MAX aż do UINT32_MAX, domain0/1, boundary0/1, permutacją, nieznanym
selektorem i ponownym importem. Testy ABI zachowują stare layouty i klienty.
Assembly oraz H_ex/E_ex i pochodna energii wymagają legalnych ścieżek FEM CPU
i GPU/double; DG0 GPU pozostaje ograniczone. Wspólny problem FDM/FEM ma
wykazać zbieżność przy zagęszczaniu, nie bitową równość różnych dyskretyzacji.

Wyniki zapisuje raport kwalifikacji regionów. Sam nowy typ mapy ani kompilacja
nie stanowią dowodu przejścia tych bramek. Rollback przywraca poprzednią
implementację i jawne odmowy wysokich markerów; nie przepisuje wyników ani
kanonicznych ID użytkownika.
