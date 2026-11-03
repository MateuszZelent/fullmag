# FMVP: typ wartości podglądu

FMVP v2–v5 może przenosić rzeczywiste wartości f64 lub f32. Typ wartości jest
niezależny od wersji metadanych. Nie zmienia jednostek, indeksów, tożsamości
carriera, źródłowego kroku ani precyzji solvera.

| Element | Kontrakt |
|---|---|
| Bajt 5 równy `1` | little-endian f64, 8 bajtów na wartość |
| Bajt 5 równy `2` | little-endian f32 podglądu, 4 bajty na wartość |
| Bajt 6 | liczba składowych próbki |
| u32 przy offsecie 8 | długość metadanych w bajtach |
| u32 przy offsecie 12 | liczba wartości, niezależnie od rozmiaru liczby |
| Offset danych | 48 + długość metadanych |
| Rozmiar payloadu | offset danych + liczba wartości × rozmiar liczby |

Codec wymaga wyrównania danych do rozmiaru liczby. Encodery zachowują
dotychczasowe dopełnienie metadanych do ośmiu bajtów. Indeksy i pełny kształt
źródłowego carriera nie mogą być odtwarzane z samej długości skompaktowanych
wartości.

Brak jawnego wyboru f32 zachowuje dotychczasowe f64. Format immutable artifact
FMVP v6 oraz złożone dane naukowe zachowują własne kontrakty f64/complex128.
Wybranie f32 nie oznacza zmiany precision w provenance obliczeń.

Klient dekoduje f32 jako `Float32Array`, odrzuca NaN/Inf i zachowuje typ przy
przeliczaniu jednostek podglądu, projekcji tensora, przekazaniu do workera
i diagnostyce. Projekcja odrzuca przepełnienie zamiast wprowadzać Inf do
kolorowania. Żadna ścieżka wymagająca complex128 nie może interpretować f32
jako pełnej precyzji źródłowej.

Właścicielami implementacji są `kernel/api/codecs/fieldVectorCodec.ts` oraz
`kernel/api/codecs/types.ts` w `apps/control-room/src`. Zgodność klienta ma
regresje binarne i testy konsumentów. Backend opt-in wymaga odrębnego codegen
i wdrożenia; samo rozszerzenie codec nie dowodzi aktywnego transportu f32,
działania całego viewportu ani kwalifikacji wyników fizycznych.
