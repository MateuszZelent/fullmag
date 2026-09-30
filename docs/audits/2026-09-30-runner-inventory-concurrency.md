# Runner — nakładające się inwentaryzacje storage

Stan: poprawka źródłowa zweryfikowana; wdrożenie na koordynator NOT VERIFIED.

## Obserwacja i przyczyny potwierdzone w kodzie

Podczas oczekiwania na #178 koordynator działał z około 94–100% CPU, miał
77, a następnie 92 wątki. Odczyt deskryptorów pokazywał skany historycznego
execution #177 w node_modules. Job #178 był running, lecz jego run_root
nie powstał; nie jest to dowód rozpoczęcia kompilacji natywnej.

Nie zebrano stosu wątku przygotowania #178. Nie wolno na tej podstawie twierdzić,
że wskazano jedyną przyczynę opóźnienia, ani unieważniać aktywnej dzierżawy.
Potwierdzono jednak niezależne błędy w ścieżce odświeżania inwentaryzacji:

1. `ObservabilityHub.get_storage_resources` nie współdzieliło trwającego skanu.
   Dwa równoczesne żądania wykonywały dwa pełne odczyty katalogów.
2. Wiek cache liczono od początku skanu. Skan dłuższy niż 10 sekund
   publikował wynik, który od razu był uznawany za wygasły.
3. `renderStorageView::loadStorageData` rozpoczynało kolejne żądanie podczas
   poprzedniego. Generacja usuwała spóźnioną odpowiedź, ale nie ograniczała pracy.
   Trzy aktualizacje w regresji dawały trzy wywołania zasobów.

## Implementacja

- Osobna blokada współdzieli skan storage, nie trzymając blokady telemetrii
  podczas przechodzenia po katalogach.
- Cache wygasa według zegara monotonicznego liczonego od zakończenia pomiaru.
  Widoczne measured_at pozostaje rzeczywistym znacznikiem odczytu.
- Zmiana polityki lub przypięcia unieważnia generację. Zmiana w trakcie skanu
  wymaga ponownego odczytu przed publikacją kwalifikacji retencji.
- Równoczesne odświeżenia widoku korzystają z trwającego żądania. Wolumeny
  nadal renderują się niezależnie od wolnego endpointu zasobów.
- Opuszczenie widoku odrzuca spóźnione odpowiedzi i blokuje nowe żądania.
- Synchronizowano tylko zmieniony wersjonowany asset StorageView.js.
  Nie uruchamiano usuwającego katalogi skryptu pakowania.

## Weryfikacja

- Python RED: dwa błędy współbieżności i wieku cache odtworzone.
- JavaScript RED: trzy wywołania zamiast jednego odtworzone.
- Python GREEN: 37 testów inwentaryzacji, telemetrii i retencji PASS.
  Pokryto również pin podczas skanu, błąd i kolejne żądanie oraz odrębne kolejki.
- Runner Console: cały istniejący zestaw JS PASS, także wolny zasób,
  niezależne wolumeny, wspólne odświeżenie i opuszczenie widoku.
- Browser fixture: 8/8 widoków, preview_only, błąd storage, 401 i recovery PASS;
  zero błędów wykonania strony. 12 logów konsoli wystąpiło w scenariuszach
  symulowanej awarii/autoryzacji; to nie test produkcyjnej kolejki.
- Zrzut: runner-storage-singleflight-smoke.png w katalogu artefaktów wątku.
  Zrzut sprawdzono wizualnie; przedstawia fixture, nie rzeczywisty status builda.

## Wdrożenie i pełny cel

Nie podmieniono aktywnego Fullmag_build_runner. Nie anulowano #178/#179,
nie zwolniono dzierżaw ani nie usunięto danych. Wdrożenie wymaga zakończonego
aktywnego slotu, nowego obrazu koordynatora, zachowania profili i kolejki
oraz sprawdzenia rzeczywistego UI/API i czasu skanów po wdrożeniu.
Nie przypisywać aktywnemu obrazowi niniejszej poprawki.

Procesy pilotów DE/BV i Γ nadal oczekują na udany runtime #178. Brak nowych
częstotliwości z poprawionej siatki. Cel S00–S12 pozostaje aktywny, włącznie
z nauką, ścieżką k, A1/COMSOL, tracking/API/UI/GPU i pełną integracją.
