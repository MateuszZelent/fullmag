# P4-C — jawne Build Grid dla FDM

Data: 28.09.2026
Status: zaimplementowany i zweryfikowany fragment UI; bramka P4 pozostaje otwarta

## Zakres

Control Room udostępnia teraz jawne polecenie `Build Grid` dla sesji FDM.
Polecenie jest dostępne w zakładce Mesh ribbonu oraz w menu kontekstowym węzła
Mesh w Explorerze. Obie powierzchnie uruchamiają ten sam command
`grid.build-fdm`; wcześniejsza materializacja siatki jako efekt uboczny `Apply
Grid` nie jest już jedynym wejściem użytkownika.

## Kontrakt wykonania

- availability jest fail-closed i wymaga jawnego lane'u FDM, dostępnego API oraz
  gotowej kanonicznej sceny;
- sesja FEM nie pokazuje FDM `Build Grid`, a nierozstrzygnięty lane nie otrzymuje
  aktywnej akcji;
- polecenie wysyła `fdm_grid_refresh` z powodem `explicit_build_grid`;
- `precondition.scene_revision` pochodzi z aktualnego zasobu sceny, więc
  przestarzały widok nie może zlecić odświeżenia bez revision fence;
- Explorer korzysta z już załadowanej sceny modułu Model i nie wykonuje
  dodatkowego odczytu tylko na potrzeby menu kontekstowego;
- ribbon FDM nie eksponuje akcji budowy meshu FEM.

## Weryfikacja

| Kontrola | Wynik | Dowód |
|---|---:|---|
| TypeScript | PASS | `pnpm --dir apps/control-room typecheck` |
| Node syntax | PASS | `node --check` dla głównego smoke i helpera Build Grid |
| Browser smoke | PASS | ribbon i Explorer: `grid.build-fdm` widoczne i aktywne |
| Payload | PASS | `kind=fdm_grid_refresh`, `reason=explicit_build_grid`, `scene_revision=12` |
| Granica lane'u | PASS | brak `mesh.build-selected` i `mesh.build-shared-domain` w ribbonie FDM |
| Konsola i HTTP | PASS | brak błędów konsoli i odpowiedzi 404 w scenariuszu |
| WebGL | PASS | widoczny canvas, `contextLost=false`, drawing buffer `703×478` |
| Testy jednostkowe | NOT RUN | aktywny zakaz kompilowania i uruchamiania testów jednostkowych |

Scenariusz jest częścią `smoke-inspector.mjs` i uruchamia się przez
`CONTROL_ROOM_INSPECTOR_FDM_BUILD_GRID=1`. Raport wykonania zapisuje dokładny
payload, dostępność Explorera oraz stan bufora WebGL.

## Wpływ na plan

Przyrost realizuje brakującą jawną akcję `Build Grid` oraz jej kontekstową
dostępność z P4-C. Nie zamyka bramki P4: pozostają pełne Operations/Problems,
managed process E2E preparacji FEM, native FEM oraz kwalifikacja naukowa i
release. Powierzchnie Operations/Problems wdrożono w kolejnym checkpointcie;
docelowy pojedynczy trwały dziennik backendowy nadal pozostaje otwarty. Stan
pozostaje: **P4 50%**, cały plan około **49%**.
