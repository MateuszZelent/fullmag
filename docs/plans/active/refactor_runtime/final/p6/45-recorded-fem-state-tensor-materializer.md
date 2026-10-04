# Przyrost 45 — binarny tensor zapisanego pola FEM P1

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod: `b9259dbff226d62118dec37dadd826e5a276d6b7`, opublikowany na remote master. Kontrola końcowych źródeł:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/731e10a8fbf14b67be70e0cb345ec8be/receipt.json`.

## Wynik

Zwykły plan FEM H1 P1 zapisuje wersjonowany `layout.field_semantics`
w istniejącym codec `fullmag.runner.field_json@v1`. Envelope obejmuje
pełny descriptor pola `m`, kolejność node/component oraz aktywną maskę
węzłów. Istniejący digest layoutu wiąże dokładne metadane z tożsamością
stanu. To zgodne rozszerzenie otwartego layoutu zastępuje wcześniejszy
zamiar wprowadzenia codec v2 z checkpointu 44.

Producent wymaga poprawnego kompletnego mesha. Fingerprinty supportu
oraz layoutu mają jawne wersjonowane preimage; nie hashuje się descriptoru
zawierającego własny hash. Writer sprawdza długość pola i skończone wartości.
Błąd semantyki kończy zapis `m`, zamiast usuwać envelope.

Warstwa aplikacji waliduje scope i pełny descriptor. Runtime-control
porównuje metadane z fabryką uruchomioną na dokładnym accepted planie,
weryfikuje oryginalny CAS JSON i zapisuje dodatkowy F64 tensor little endian.
Chunk obejmuje najwyżej 8192 węzły, czyli 196608 bajtów. Nowy root otrzymuje
binding dataset/sample/item/field, producenta i grupę oraz zachowuje
oryginalny accepted state. Publikacja obejmuje ten sam SolutionSet member,
przed jego terminal close; oryginalny JSON pozostaje artefaktem.

Tożsamość dataset/group wynika z run/RunSpec, źródłowego artefaktu i CAS,
portu, case oraz codec. `item_id` oznacza źródłowy JSON, a derived tensor
ma własny artifact ID. Binding nie zastępuje autoryzacji właściciela przez
exact pinned SolutionSet root i RunIntent. Powtórzenie tych samych wejść
wytwarza tę samą tożsamość i root; nie dopisuje się danych do zamkniętych
rewizji. Reader wdraża się przed writerem, writer wraz z materializatorem.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| Produkcyjna kompilacja API i zależności | PASS, exit 0, źródła nie zmieniły się podczas kontroli |
| Nieprzerwany fingerprint źródeł podczas kontroli | PASS, exit 0, źródła nie zmieniły się podczas kontroli |
| Rustfmt parser nowych modułów i scoped diff | PASS |
| Niezależny przegląd źródeł | PASS, brak pozostałych P0/P1 w sprawdzonym zakresie |
| Regresje jednostkowe | NOT COMPILED / NOT RUN |
| Producent → publikacja → pinned read w rzeczywistym wykonaniu | NOT VERIFIED |
| Peak RAM, FMS round-trip, nauka i release | NOT VERIFIED |

Pierwsza kontrola źródeł `cb04433487d64054b26ef095a23da088` przeszła
z exit 0 i `source_changed_during_run=false`. Dotyczy wersji przed poprawką
obsługi błędów i limitu. Końcowy receipt podany na początku odpowiada
wersji po tych poprawkach.
Kontrola kompiluje produkcyjny binary API z `--locked`, bez testów jednostkowych.

Review wskazał możliwość cichego pominięcia materializacji po błędzie
semantyki i po przekroczeniu limitu. Obie ścieżki otrzymały jawne błędy.
Dodatkowa uwaga o `item_id` została rozstrzygnięta w przeglądzie:
identyfikuje źródłowy JSON, a nie artifact ID derived tensora. Exact owner,
root hash i weryfikacja chunków wykluczają podstawienie innej rewizji;
nie dodaje się sprzecznego wymogu równości obu artifact IDs.

## Granice i dalsza praca

Limit źródłowego JSON wynosi 64 MiB. W obsługiwanym planie FEM P1
przekroczenie zatrzymuje publikację, również dla dużego starego JSON;
nie powstaje niejawny wynik bez tensora. Legacy bez envelope w budżecie
zachowuje oryginalną obsługę. Nieobsługiwane plany są rozpoznawane przed
pełnym odczytem JSON. Dekodowanie wejścia nadal jest pełne, dlatego
chunkowany zapis nie dowodzi bounded peak RAM.

FDM CPU/GPU, FEM eigen/response, wyższe rzędy i snapshot/Zarr pozostają
poza producentem. Nie zmienia się StudyOutputManifest ani portów,
nie wykonuje solve, projekcji lub normalizacji. `Quantitative` opisuje
pełną rozdzielczość zapisanego pola; nie dowodzi zbieżności, normy,
kwalifikacji CPU/GPU ani parytetu. Ocena naukowa i status pozostają oryginalne.

Następny etap to trwały MaterializedDataset z coverage i przypiętym
właścicielem, publikacja wyników signed-difference, API/generated client
oraz consumer istniejącego UI. Cały P6 oraz P7/P8 pozostają otwarte.

Kontrakt: [przypięty tensor](../../../../../specs/pinned-solution-tensor-v1.md).

Dodatkowy przegląd natywnej ścieżki wskazał brak pełnej bramki geometrii
i brak współdzielonej walidacji reguł regionów. Poprawki oraz dokładne
rozstrzygnięcie zgodności masek opisuje [przyrost 46](46-fem-field-runtime-support-parity.md).
Nie zmienia to źródłowego PASS z tego przyrostu w dowód wykonania runtime.
