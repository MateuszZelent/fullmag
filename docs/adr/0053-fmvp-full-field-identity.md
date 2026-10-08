# ADR 0053 - Pelna tozsamosc pola w FMVP v5

Status: proposed; implementacja i weryfikacja w toku. Nie kwalifikuje runtime.

## Kontekst

Modalne i odpowiedzi czestotliwosciowe uzywaja canonical field_id dluzszego niz
16 bajtow. Producent FMVP ucina go w naglowku, a podglad wymaga zgodnosci
pelnego ID. Dwa rozne mody moga miec ten sam prefix. Nadpisanie ID naglowkiem
HTTP lub skrocenie nazw nie stanowi dowodu tozsamosci binarnego payloadu.

## Decyzja

FMVP v5 pozostaje jednym data plane. Zachowuje zewnetrzny naglowek 48 bajtow,
topologie, indeksowanie, wartosci i istniejace scope semantics. FMMI metadata
version 4 przenosi wymagane pelne quantity/field ID jako tekst UTF-8 z dlugoscia.
Decoder bierze ID z binary metadata i sprawdza zgodnosc bajtowego prefixu
naglowka. Nie korzysta z HTTP do zastapienia ID.

Stala czesc metadata ma 88 bajtow. Wszystkie offsety sa wzgledem poczatku FMMI, a liczby little-endian.
Zachowuje offsety FMMI v3 uzywanego przez FMVP v4: domain ID
length 8, source kind length 10, source ID length 12, field generation length
14, topology revision 16, topology hash 24, indexing 56, node count 60,
scope lengths 64/66, source revision 68 i zera [76,80). Pelna dlugosc quantity
ID (u16) jest pod offsetem 80; [82,88) sa zerami. Zmienne teksty wystepuja
kolejno: scope kind, scope ID, domain ID, source kind, source ID, field
generation ID, quantity ID; potem node indices i zerowy padding do 8 bajtow.

Pelne quantity ID jest niepuste, bez znakow sterujacych/NUL i miesci sie w
u16 bajtach UTF-8. Prefix naglowka to pierwsze 16 bajtow tego UTF-8 z zerami
dla krotszego ID; granica moze przecinac znak. Weryfikacja porownuje bajty. Pelne ID jest dekodowane UTF-8 fatal;
niepoprawna sekwencja nie moze zostac zastapiona znakiem replacement.
Source qualification jest albo calkowicie nieobecna (trzy teksty puste,
revision 0), albo kompletna jak w v4 (live/observation_frame, source ID,
field generation ID, revision). Brak nie oznacza fikcyjnego live source.

Odczyt headless bez dostepnej topologii pozostaje legalny. V5 oznacza ten
stan jawnie: LegacyCountOnly (kod3), brak indeksow, revision0 i hash32zer.
Inna kombinacja LegacyCountOnly jest odrzucana. Decoder prezentuje wtedy
meshTopologyRevision/hash jako null, nie jako znany mesh. Zachowuje rzeczywisty
domain generation i pelne field ID. Podglad3D nadal wymaga full_domain oraz
zgodnej topologii, dlatego takiego payloadu nie renderuje. Nie fabrykuje sie
siatki tylko dlatego, ze artefakt pola istnieje.

## Zgodnosc i rollback

Czytniki v2/v3/v4 pozostaja zgodne z dotychczasowymi wersjami. Producent
artefaktow analizy emituje v5 takze dla krotkich ID. Live/observation v4
pozostaja bez zmiany. Stary klient odrzuca nieznana wersje; aktualizacja
producenta i klienta jest wspolnym etapem. Rollback nie moze polegac na
powrocie do ucinania ID dla modalnych artefaktow: taka trasa pozostaje
niedostepna, dopoki dzialajacy klient nie obsluguje pelnej tozsamosci.

## Obowiazki implementacji i bramki

- Rust field_store serializer i analysis field endpoint; poprawny version header.
- Codec/type union i obie bramki overlay; wszystkie kontrole topology/ID/count
  oraz finite values pozostaja wymagane. Nie pojawia sie drugi viewport.
- Regresje dwoch ID o wspolnych pierwszych 16 bajtach, UTF-8 przecietego na
  granicy, malformed lengths/prefix/padding/identity i source groups.
- Kompatybilnosc v2/v3/v4, v5 z qualification i bez niej, complex XYZ.
- API transport proof prawdziwego dlugiego modalnego ID i browser/WebGL
  handoff z takim ID, nie ze sztucznym krotkim zamiennikiem.
- Testy kompilowane tylko w GHA; managed source checks nie dowodza runtime.

Endpointy, OpenAPI JSON, Python DSL, ProblemIR, jednostki SI i fizyka solvera
nie zmieniaja sie. Requested/resolved execution pozostaja w istniejacych
resource/provenance, nie sa wyprowadzane z wersji binary.
