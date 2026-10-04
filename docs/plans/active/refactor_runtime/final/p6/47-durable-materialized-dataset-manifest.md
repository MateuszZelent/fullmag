# Przyrost 47 — trwały manifest MaterializedDataset

Data: 2026-10-01. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod: `a67d220c31f6d3cfb68b6bec7db15b7aba439ff4`, opublikowany na remote master.
Bazowy commit: `a8b9e5a30a7e83c3eb65349991e131f5e911e6d0`.
Końcowy receipt: `C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/9cba2da8dd7d4baeadb9d2c1bd44b1b0/receipt.json`.

## Zmiana

Manifest `fullmag.materialized_dataset.v1` jest typowanym artefaktem CAS
tego samego SolutionSet. Zawiera definicję zbioru, MaterializedDataset,
opis jednego pola i dokładne przypięcie do rewizji właściciela oraz tensora.
Nie powstaje drugi magazyn Results ani dodatkowy mutable indeks datasetów.
Kontrakt opisuje [specyfikacja](../../../../../specs/materialized-dataset-manifest-v1.md)
oraz [ADR 0029](../../../../../adr/0029-analysis-result-dataset-and-slice-selection.md).

Pierwsza publikacja nowego wyniku dołącza manifest do tej samej rewizji
SolutionSet. Publikacja końcowa i ponowienie zachowują pierwotny manifest
oraz przypiętą rewizję. Wyniki legacy zachowują swoje artefakty bez
wstecznego dopisywania manifestów. Poprawne tensory bez bindingu pola
oraz pola poza zakresem real Values pozostają obsługiwane dotychczasową trasą.

Publikacja, recovery, przechodzenie grafu CAS i FMS sprawdzają dokładnego
właściciela, członka, niezmienny tensor, metadane i coverage. Historyczny
właściciel pochodzi z dokładnej rewizji, bez użycia CURRENT. Import musi
odrzucić powtórzoną parę dataset ID / rewizja przed zapisem do store.

`Ready` opisuje dostępność zweryfikowanych danych. Nie podnosi oceny
naukowej ani nie zamienia Running w ukończony runtime. Rewizja datasetu
jest odrębna od rewizji SolutionSet. Pierwszy zakres obejmuje jeden
sample/item/field, rzeczywiste wartości, bez osi, transformacji i gałęzi.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Kontrola produkcyjnych źródeł | PASS, exit 0, source_changed_during_run=false |
| Przegląd grafu i granic zapisu | PASS, brak pozostałych P0/P1 w źródłach |
| Scoped staging i dokumentacja | PASS, canonical HEAD candidates, linki lokalne i diff check |
| Regresje jednostkowe | NOT COMPILED / NOT RUN |
| Managed runtime i FMS round-trip | NOT VERIFIED |
| Peak RAM i kwalifikacja wydania | NOT VERIFIED |

Dodane regresje źródłowe obejmują tożsamość i coverage manifestu, replay
bez zmiany przypiętej rewizji, legacy fieldless tensor, dwa różne manifesty
tej samej rewizji datasetu oraz brak historycznego ownera w obu walkerach.
Końcowy przegląd produkcyjnych źródeł nie wykazał pozostałych P0/P1.
Cache parsed tensora zachowuje najwyżej jeden wpis, a deduplikacja jest
lokalna dla jednego bounded SolutionSet. Nie jest to pomiar peak RAM.

Źródła regresji nie są dowodem wykonania. Bieżący zakaz kompilacji
testów jednostkowych pozostaje w mocy. Trwały manifest nie zamyka API,
generated client, konsumentów UI, materializacji wielopunktowej ani
kwalifikacji czterech realizacji solvera.

Osobny [audyt markerów native FEM](48-native-region-marker-followup-audit.md)
potwierdza niespójność podwójnej normalizacji regionów. Jego poprawka
wymaga rozdzielenia raw region IDs i binary magnetic mask; nie jest
częścią implementacji manifestu.

## Następny wycinek

Odczyt datasetu w API ma identyfikować project/run/SolutionSet/revision/member/artifact.
Wspólny reader magazynu zweryfikuje manifest i dokładnego ownera; odpowiedź
zwróci osobno containing revision oraz owner revision. JSON pozostanie
cienką, typowaną projekcją, a payloady zachowają binarną trasę. Generated
transport i klucz resource hooka muszą obejmować całą przypiętą tożsamość.
