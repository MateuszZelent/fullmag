# CPW — odbiór podglądu w przeglądarce

## Dowód wykonania

`just verify-antenna-cpw-viewport-browser` na HEAD
`789eb413d301da4015898c945a20f17df18f42e4`: **passed**, exit 0.
Receipt `a001bba53d5f4a93ab7fee047734b1de`, profil
`windows-control-room-browser-fixture`, scenariusz `antenna-cpw-viewport`.
Digest źródeł przed/po:
`3e92a3bd9a130bb3c2a276da7817a676b2ec7afd33ba465437c1f336f727cb22`;
`source_changed_during_run=false`, `owned_server_terminal=true`.
Wyniki znajdują się pod resolverowym katalogiem tego worktree:
`windows-control-room-browser-fixture/antenna-cpw-viewport-browser/a001bba53d5f4a93ab7fee047734b1de/`.

Użyto izolowanej kopii frontendu i Chrome na porcie 3260, bez solvera,
kompilowania testów jednostkowych, restartu ani mutacji sesji na porcie 3197.
Fixture korzysta z produkcyjnej warstwy primitive, modelu CPW i placement.
Nie wykonuje transakcji authoringu przez rzeczywisty backend.

## Odebrane wymagania podglądu

- Jeden widoczny canvas; aktywny WebGL, drawing buffer 1000 × 620.
- Trzy przewodniki z własnymi ID: 72 wierzchołki, 396 indeksów.
- Kolor materiału zgodny ze złotym tokenem anteny. Nad próbką odczytano
  20194 złote piksele, pod próbką 16715; przy usunięciu błędnej anteny 0.
- Odstęp między skrajnymi powierzchniami anteny i próbki: 200 nm w world Z,
  zarówno nad, jak i pod próbką. Zrzuty obu położeń sprawdzono wizualnie.
- Zerowa szczelina odrzuca podgląd z diagnostyką `left_gap_m`;
  nie pojawia się zastępczy box.
- Po ustabilizowaniu obu położeń brak dodatkowych klatek w oknie 600 ms.
- Trzy cykle wyłączenia/włączenia warstwy: śledzone geometrie 4 → 0 → 4,
  brak utraty WebGL. Brak błędów konsoli i page errors.

## Korekta historycznego checkpointu i granice odbioru

Stwierdzenie w `2026-10-08-antenna-cpw-preview-model-checkpoint.md`, że CPW
nie jest jeszcze podłączone do viewportu, opisuje wcześniejszy stan.
Aktualny kod zawiera też kreator CPW, edytor pięciu wymiarów stacji
i placement. Obecny dowód potwierdza rendering i lifecycle primitive;
nie potwierdza działania kreatora, Inspectora ani ACK przez API.

Osobno pozostają: browser stability edycji Object/Airbox, eksport/import
przez backend, conductor mesh/current solve, regular publish → cold load
→ reuse, wizualizacja pola źródła, Run/Relax i FFT oraz kwalifikacja czterech
realizacji. Podgląd autorskiej geometrii nie jest polem ani wynikiem transportu.
Nie zamknięto całego T04/T15 ani celu T00–T18. PR #147 pozostaje Draft.
