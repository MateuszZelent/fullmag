# P6-54 — niezmienna geometria zapisanego pola FEM P1

Data: 01.10.2026. Baza: `42178e04fd7aa388d0b9ec357202e62115b22069`.
Commit implementacji: `1e731f023a83482fab8a97ab82b549196ee81c12`.
Status: przyrost kontraktu storage; P6 **IN PROGRESS, około 52%**,
cały plan około **49%**. Nie jest to kwalifikacja renderera ani solvera.

## Wykonany zakres

Nowy `solution_field_geometry` zapisuje mały typowany binding właściciela
oraz deduplikowany payload geometrii w CAS. Binding wskazuje dokładny tensor,
run, SolutionSet, origin revision, member i RunSpec digest. Payload zachowuje
kanoniczny MeshIR w SI, wszystkie komórki i fasety, ich kolejność, markery,
periodyczność, quality metadata i pełną semantykę FEM H1/P1 z aktywną maską.
Quality HashMap jest serializowana deterministycznie.

`attach_recorded_datasets` dodaje geometrię z accepted resolved planu do tej
samej prospektywnej rewizji co tensor i dataset. Replay przenosi istniejący
binding bez przepisywania origin revision. Stare SolutionSet nie dostają
automatycznie nowych artefaktów. Nie powstał drugi magazyn Results.

Publication i recovery porównują exact tensor ref, descriptor, topology,
support i producenta. Sprawdzają historycznego ownera przy późniejszej
rewizji. Nowy root jest rozpoznawany przez durable catalog oraz live/archive
walkery, włącznie z geometry payloadem i tensor chunks. Powielone bindingi,
zmiana tensora, niezgodny hash/length/schema lub uszkodzona geometria są
odrzucane. Payload jest trwałą referencją; roboczy pin może zostać zwolniony
po publikacji. Niekompletny archive graph nie upoważnia do GC.

Manifest ma limit 1 MiB, geometria 64 MiB; writer kontroluje budżet przed
powiększeniem bufora. Parser nie przyjmuje ignorowanych pól ani legacy mesh
shape jako nowego kanonicznego payloadu. Limit bajtów nie certyfikuje RAM:
klonowanie MeshIR/JSON i pełna walidacja pozostają kosztami do pomiaru.
To wewnętrzny CAS JSON; API z binarną geometrią i streaming pozostają otwarte.

Decyzja i rollback: [ADR 0041](../../../../../adr/0041-saved-field-geometry-root.md).

## Rozstrzygnięcie audytu producenta

Audyt potwierdził brak trwałego rootu geometrii oraz brak przekazania actual
native representation receipt do study output/SolutionSet. Pierwszą lukę
obsługuje ten przyrost. Druga pozostaje jawna: schema dopuszcza wyłącznie
`representation_evidence = not_verified`. Payload z planu nie jest dowodem
local/true DOF ani mapy indeksów rzeczywistego solvera.

Nie przyjmujemy bez dowodu tezy, że owner hash jest słaby wyłącznie dlatego,
że nie powtarza topology i mask w preimage: zawiera CAS source object ref,
którego bytes już wiążą dokładną semantykę. Brak native receipt jest osobną
luką dowodową. Blanket rejection periodic wymaga analizy eksportu true→local;
różna liczba local i true nodes sama nie dowodzi błędnego wektora lokalnego.
Przestrzenny konsument ilościowy musi jednak dostać potwierdzone mapowanie.

## Dowody

Produkcyjny `just check-api-source` zakończył się PASS, exit 0, bez kompilacji
unit tests i bez buildu natywnego FEM:
`windows-api-source-check/api-source-check/b8601e26b0ba407c865f3a686759628a/receipt.json`.
Path jest względny wobec `storage/builds/fullmag-0950f4dca4ffe38f`.
Receipt opisuje dirty source snapshot; zachowane obce zmiany nie stają się
częścią commita zadania. Kontrola spójności repozytorium również PASS.

Review nie znalazł P0/P1. Korekta P2 odkłada obliczenie semantyki geometrii
do znalezienia materiałizowalnego tensora, aby plan bez pola nie dostał
zbędnego błędu attach. Druga uwaga P2 dotyczy canonical JSON: parser sprawdza
typowany kształt, nie bajtową kolejność kluczy ani duplicate keys na poziomie
JSON Value. Deterministyczny generator i exact CAS hash pozostają gwarancjami;
nie deklarujemy silniejszej kanonizacji parsera. Native receipt nadal otwarty.

Końcowy source check po korekcie review: PASS, exit 0,
`windows-api-source-check/api-source-check/ff742064bba5446ab3064389af8980ea/receipt.json`.
Follow-up review potwierdził lazy semantics bez P0/P1. Staged diff obejmował
wyłącznie zmiany zadania; 107 obcych dirty paths pozostało zachowanych.

Dodano źródła regresji: canonical parse/unknown fields, false native evidence,
mask mismatch/nonfinite nodes, publication i live/archive closure, pin release,
missing payload, historical owner, duplicate binding i limit writer-a.
**Nie zostały skompilowane ani uruchomione** zgodnie z aktualnym zakazem.

| Bramka | Stan |
|---|---|
| Produkcyjne źródła Rust | PASS |
| Spójność repozytorium | PASS |
| Źródła regresji | Dodane; NOT RUN |
| Actual publication/recovery/FMS round-trip | NOT VERIFIED |
| Native representation i periodic index map | NOT VERIFIED |
| FEM CPU / FEM GPU wykonanie | NOT VERIFIED dla tego przyrostu |
| HTTP geometry transport / renderer / WebGL | Jeszcze nie wdrożone |
| Duże siatki / RAM / nauka / release | NOT VERIFIED |

## Następny krok

Przenieść rzeczywisty representation receipt i tożsamość mapy z eksportu
solvera do niezmiennego wyniku. Następnie ustalić binarny transport geometrii
z exact pinned identity i podłączyć go do istniejącego workspace/viewportu.
Nie podnosimy procentów za sam pomocniczy kontrakt, zanim domkniemy te bramki.
