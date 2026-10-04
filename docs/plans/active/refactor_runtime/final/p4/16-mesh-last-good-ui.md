# P4-C — zachowanie ostatniej poprawnej siatki w Control Room

Data: 28.09.2026
Status: zaimplementowany i zweryfikowany fragment UI; bramka P4 pozostaje otwarta

## Zakres

Control Room rozdziela teraz nieudanego kandydata budowy siatki od ostatniego
opublikowanego artefaktu. Inspector i Explorer pokazują, że kandydat nie został
promowany, oraz wskazują zachowaną siatkę, jej rewizję, build i generację.
Niepowodzenie budowy nie usuwa danych aktywnego edytora ani nie destabilizuje
Inspectora.

Poprawiono także odczyt zasobu `latest-successful`: właściwym rekordem sukcesu
jest `last_success`, a błąd może pochodzić zarówno z aktywnej budowy, jak i z
zasobu historii ostatniej budowy.

## Kontrakt prezentacji

- `last_success` pozostaje historią zakończonej budowy i nie jest traktowany
  jako aktywny kandydat.
- Manifest oraz rewizja siatki opisują opublikowaną tożsamość używaną przez
  workspace.
- UI deklaruje stan `retained` wyłącznie wtedy, gdy występuje błąd najnowszego
  kandydata, istnieje `last_success` i dostępna jest opublikowana tożsamość
  siatki wraz z jej rewizją.
- Przy niepełnej tożsamości UI pokazuje `identity unavailable` i nie twierdzi,
  że rollback został potwierdzony.
- Explorer oznacza korzeń Mesh i Build Pipeline jako `failed · retained`, a
  Inspector wyjaśnia, że kandydat nie został promowany.
- UI nie wylicza ani nie pokazuje wymyślonego procentu postępu etapu.

## Weryfikacja

| Kontrola | Wynik | Dowód |
|---|---:|---|
| TypeScript | PASS | `pnpm --dir apps/control-room typecheck` |
| ESLint zmienionych plików | PASS | zakres Explorer, Mesh Inspector i browser smoke |
| Browser smoke Inspectora | PASS | zachowany build `mesh:inspector-good`, generacja `1`, rewizja siatki `7`, rewizja sceny `12` |
| Stabilność Inspectora | PASS | oba scenariusze Object/Airbox zachowały panel, focus i pozycję przewijania; render count `2` |
| WebGL | PASS | widoczny canvas, `contextLost=false`, drawing buffer `703×478` |
| Testy jednostkowe | NOT RUN | aktywny zakaz kompilowania i uruchamiania testów jednostkowych |
| Managed/native process E2E | NOT VERIFIED | niedostępny koordynator Docker Desktop; bez hostowego fallbacku |

Dodane regresje źródłowe obejmują dokładną zachowaną tożsamość, stan
fail-closed przy niepełnej tożsamości oraz brak stanu rollbacku bez błędu.
Pozostają nieuruchomione do czasu zniesienia zakazu testów jednostkowych.

## Wpływ na plan

Ten etap domyka fragment P4-C dotyczący zachowania i jawnego przedstawienia
ostatniej poprawnej siatki. Nie zamyka całej bramki P4: nadal brakuje managed
process E2E preparacji FEM oraz pozostałych elementów workflow
Geometry/Mesh/Compute. Jawne FDM `Build Grid` oraz powierzchnie
Operations/Problems zrealizowano w kolejnych checkpointach; docelowy pojedynczy
trwały dziennik backendowy nadal pozostaje otwarty. Stan pozostaje: **P4 50%**,
cały plan około **49%**.
