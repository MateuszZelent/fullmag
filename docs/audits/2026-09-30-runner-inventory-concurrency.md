# Runner — nakładające się inwentaryzacje storage

Stan: poprawka źródłowa i wdrożenie obrazu zweryfikowane; wydajność pełnego
skanu produkcyjnego i obliczenia FEM pozostają NOT VERIFIED.

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

## Aktualizacja po zakończeniu #178 — 2026-09-30 16:06 UTC

- #178 terminalnie blocked przed kontenerem. Stan usługi zapisał:
  `CoordinatorError: Build needs at least 8 GiB free; no automatic cleanup`.
  Nie jest to awaria eigensolve. Stare sesje 45879/48887/83846 zakończyły się
  exit 1; żaden pilot nie ruszył, a raport/wykres nie zostały sfabrykowane.
- Aktywny slot był pusty, #179 i obcy job #180 pozostawały queued.
  Wykonano kontrolowany drain; worker_alive=false, accepting_jobs=false,
  stop_requested=true oraz zero aktywnych jobów potwierdzono przed wymianą.
- Recepta `just runner-coordinator-image` exit 0; obraz:
  sha256:7fa7a4a853f1d08bb21fec7eaa813340c0e1869d0852b2f8ee42a41274b10587.
  Podmieniono dokładnie własny kontener, zachowując siedem profili oraz
  identyczne job_id/source_digest/profile oczekującej kolejki. Wznowiono ją.
- Hash wdrożonego observability.py:
  18cd9146a36eb29f3cbdfd6306c21c82b1577bf66c34797a2586b759e01ffc61.
  Hash wdrożonego StorageView.js:
  2d298a79a9e343aaf7e0329a8ce1237d380e653a92ce36762129b2e8dfa153de.
  Oba zgodne ze zweryfikowanymi źródłami commita
  92c7facc3f8400e7409c22d583919aa3741aefc2, wysłanego na remote.
- Rzeczywisty UI po lokalnej autoryzacji: API OK, wolny slot, #179 pierwszy,
  #180 drugi w FIFO, bez response_too_large. Karta testowa zamknięta.
  Dowód: runner-inventory-deployed-queue.png; receipt wdrożenia:
  deploy_inventory_singleflight.json w katalogu artefaktów wątku.
- Pomiar po wymianie: sześć wątków, CPU 0.02%, RAM 32.32 MiB.
  Restart zakończył również stare żądania. Nie dowodzi to czasu pełnego skanu
  przy dużym obciążeniu ani wyłącznej przyczyny opóźnienia poprzedniego joba.
- Wolne miejsce: 6547595264 B (około 6.10 GiB), poniżej 8589934592 B.
  Usługa zdrowa, lecz kolejka oczekuje na storage. Żadnych danych nie usunięto.
- Sześć wskazanych execution zakończonych jobów #173/#171/#170/#169/#167/#165
  zajmuje 2676782918 B, około 2.49 GiB; dowiązań nie śledzono w pomiarze.
  Poproszono o odrębną zgodę. Przed każdą operacją konieczna ponowna kontrola
  użytkowników, mountów, dokładnych ścieżek i zapasu. Spadająca ilość miejsca
  nie pozwala zagwarantować sukcesu buildu wyłącznie z tego oszacowania.
- Bez nowego zgłoszenia buildu podpięto próby do już istniejącego #179:
  digest e6d33f2ab37f1d529db133f12d0d45813fd2d89721121f740e7de3402e62d0fc.
  Model referencyjny Box nadal 11155c55e76f321ec0bb62399e7a0494655003f9.
  Nowsza kapsuła zawiera poprawki Box oraz ring/A1; nie przypisano #179
  późniejszych zmian koordynatora ani bieżącego HEAD.
- Nowe kontrolery: 66068 (sześć prób), 28993 (odbiór), 2072 (Γ);
  potwierdzone żywe, waiting_for_managed_build/waiting_for_pilots/batch.
  Nowe control znajdują się w scientific-batches i nie tworzą run_root.
  Wszystkie bramki okna, residualu, źródeł i pól pozostają zachowane.
