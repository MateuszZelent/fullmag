# Capture zaakceptowanego skryptu — wynik zmiany limitu metadanych

## Zakres

Zatwierdzony patch zwiększa wyłącznie limit JSON metadanych capture z 8 do 12 MiB. Łączny kod i assety źródłowe pozostają ograniczone do 8 MiB; wygenerowany `source.py` również używa tego limitu. Runtime inventory pozostaje ograniczone do 128 MiB, pojedynczy plik do 32 MiB. Nie zmieniono równań, ProblemIR, tolerancji solvera ani kwalifikacji źródła anteny.

Właściciele: `crates/fullmag-application/src/script_source_capture.rs::SOURCE_LIMIT`, `METADATA_LIMIT` oraz `crates/fullmag-api/src/script.rs::render_accepted_scene_source_bounded`. Wygenerowane źródło nie może korzystać z większego limitu metadanych.

## Dowody

- Patch SHA256: `4581df0a0922b415ee81fff101c7fd54a17d31211ccf85a1fc6207b43f85cb2a`.
- Zarządzany build grupy 3203: `04a0fa4008524190b0fb63e073cda098`, Succeeded; snapshot `b6e447035ec862962aef5ec1f4a04eaba1efae5d7c1f182f8554a2cd89e8a74b`.
- Cztery testy plików i jedenaście przypadków sceny capture przeszły. Nie kompilowano testów jednostkowych Rust.
- Publiczne prepare rzeczywistego skryptu GSG 50 nm zakończyło się poprawnie i zachowało zamrożony pełny model. Źródło: 5 941 280 bajtów; historyczny export JSON: 9 582 471 bajtów.
- Rzeczywisty CLI odrzucił stdout przekraczający 12 MiB. Źródło 8 MiB + 1 bajt zostało odrzucone; istniejący helper inventory potwierdził `source_capture_aggregate_budget`.
- Jedyna zatwierdzona próba V/J/H 50 nm osiągnęła Succeeded. Odbiór naukowy i pełne publiczne porównanie danych pozostają oddzielnymi bramkami; ten commit nie kwalifikuje anteny, RF ani LLG.

Dowody techniczne: prywatny control volume grupy, `verification/gsg-50nm-approved-20261104/`, pliki `capture-boundaries.json`, `capture-files.log`, `capture-scene.log` i `50nm-new/prepare-receipt.json`.

## Ograniczenia

To wewnętrzny raport zmiany granicy transportu, nie nowa dokumentacja fizyki ani deklaracja reprodukcji publikacji. Obsługa większego JSON nie zwiększa limitu kodu źródłowego ani budżetu wykonania. Weryfikację opisano dla FEM CPU/double; nie deklarujemy nowej kwalifikacji FDM CPU, FDM GPU lub FEM GPU.
