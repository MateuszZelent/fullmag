# Projekt naprawy Airboxa i końcowej telemetrii FDM

## Cel

Airbox FDM ma być niezależnym celem wizualizacji, udostępniającym wyłącznie pola zdefiniowane w pełnej domenie. Zakończenie etapu ma bezwarunkowo publikować końcową telemetrię, a średnia magnetyzacja ma obejmować wyłącznie aktywne komórki magnetyczne.

## Kontrakt

- Wybór `airbox.visualization` zachowuje kanoniczny cel `airbox`; nie jest zastępowany przez `fdm-domain`.
- Techniczny węzeł `mesh.grid.universe-outside-support` zachowuje osobny cel `fdm-universe-outside-support`.
- Lista quantity Airboxa powstaje wyłącznie z dostępnych pozycji katalogu o domenie `full_domain`; `m`, energie i parametry materiałowe są niedostępne.
- Tryby Wireframe, Points i Off modyfikują ustawienia celu konsumowanego przez renderer Airboxa.
- Końcowy wiersz skalarów omija okres `tableautosave` i jest publikowany również wtedy, gdy etap kończy się pomiędzy regularnymi próbkami.
- `avg mx`, `avg my`, `avg mz` oraz `|avg m|` dla FDM wykorzystują aktywną maskę materiałową; komórki Airboxa nie rozcieńczają średniej.

## Granice zmiany

Naprawa nie zmienia semantyki FEM, nie przechowuje buforów roboczych solvera i nie dodaje wyjątków dla pojedynczych identyfikatorów quantity. Stan serwera pozostaje w resource hooks/cache, a ustawienia viewportu pozostają w istniejącym kontrolerze wizualizacji.

## Weryfikacja

Testy regresyjne obejmą rozdzielenie celów Airbox/FDM, filtrowanie katalogu quantity, końcową publikację przy niedue autosave oraz maskowaną średnią magnetyzacji. Po testach jednostkowych i typechecku wymagany jest test w rzeczywistej przeglądarce: dropdown bez `m`, widoczny wireframe i poprawna końcowa telemetria.
