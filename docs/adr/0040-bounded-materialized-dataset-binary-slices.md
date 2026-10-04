# ADR 0040 — binarny odczyt fragmentów przypiętego datasetu

Status: accepted for implementation. Data: 01.10.2026.

## Kontekst i decyzja

Zapisane pole musi dać się odczytać bez sesji i bez pobierania całego tensora.
Istniejące `DatasetFieldSlice` i adapter CAS pozostają właścicielami semantyki
zakresów, precyzji, płaszczyzn i checksum. HTTP dodaje wyłącznie opakowanie
transportowe FMDS v1; nie zmienia FMVP ani representation pola.

`GET .../materialized-dataset/slice` ma pełną ścieżkę projektu, runu,
SolutionSet, rewizji, membera i artefaktu. Query podaje wersję istniejącego
kontraktu slice, dataset/revision, sample/item/field, oczekiwany hash manifestu,
offset, count i budżet. Wszystkie u64 są kanonicznymi stringami dziesiętnymi.
Brak albo konflikt źródła daje błąd; żądanie nie uruchamia obliczeń.

Odpowiedź zawiera 12-bajtowy nagłówek: `FMDS`, u16 LE version=1, u16 LE
flags=0, u32 LE długość metadata. Dalej jest JSON
`MaterializedDatasetSliceEnvelopeResource` (maks. 1 MiB), a następnie dokładne
little-endian F32/F64 bytes części w kolejności `slice.parts`. Budżet query
dotyczy payloadu (maks. 64 MiB); całe body dodaje najwyżej 1 MiB + 12 B.
Offsety części wewnątrz płaszczyzny są względne wobec wycinka.
Legalne 4096 części storage nie gwarantuje zmieszczenia ich HTTP metadata.
Zbyt rozdrobniony wycinek albo zbyt duży descriptor zwraca HTTP 422 z jawnym
`DATASET_SLICE_METADATA_BYTE_LIMIT`; nie jest oznaczany jako uszkodzony zapis.
Backend i klient odrzucają NaN/Infinity zgodnie z istniejącym dekoderem
storage-neutralnym; checksum nie zastępuje tej kontroli.

Jedna odpowiedź wiąże tożsamość, descriptor i bytes. Nie powstaje osobny
odczyt metadata slice, którego wynik mógłby zostać pomylony z innym body.
Odczyt manifestu, typed root i touched CAS chunks weryfikuje integralność.
`verified_returned_ranges` nie certyfikuje nieodczytanych chunków ani fizyki.
CAS może przeczytać cały dotknięty chunk w celu sprawdzenia hasha; ograniczenie
payloadu nie jest deklaracją identycznego limitu I/O.

## Zgodność i dalsza implementacja

Manifest `fullmag.materialized_dataset.v1` nadal dopuszcza tylko rzeczywiste
`Values`. Nie wyszukujemy partnera imaginary ani geometrii w sesji. Produkcyjna
obsługa zespolona wymaga nowego schema ID manifestu z jawnymi exact plane
sources i ich wspólną walidacją. Renderer wymaga trwałego topology/support
artifact ref i potwierdzonego mapowania indeksów; samo `topology_id` nie jest
geometrią. Te bramki pozostają częścią P6.

Istniejący metadata endpoint zachowuje pełną weryfikację payloadu. Bounded
reader rozdziela sprawdzenie metadanych i bytes, nie osłabiając publication,
recovery, FMS ani dotychczasowych pełnych readerów. Jednocześnie żywe bufory
części i opakowania HTTP mogą zajmować około dwukrotnego limitu payloadu;
nie deklarujemy streamingowego HTTP ani stałego zużycia RAM.

Kontrakt obejmuje OpenAPI i generowane typy, centralną fasadę, codec z kontrolą
exact source, zakresu, descriptoru i range checksum. Resource hooks oraz
renderer dołączą do istniejącego workspace; WebSocket i status nie dostają
ciężkich danych. Rollback usuwa nową trasę i konsumentów bez migracji CAS.

## Weryfikacja

Wymagane są source check, codegen, produkcyjny TypeScript i API hygiene.
Regresje obejmują historycznego ownera, forged manifest/field, bounds/budget,
corrupt touched chunk oraz brak certyfikowania unread chunks. Browser/WebGL,
rzeczywisty backend HTTP, testy jednostkowe, science i release są osobnymi
dowodami; nie wynikają z kompilacji źródeł.
