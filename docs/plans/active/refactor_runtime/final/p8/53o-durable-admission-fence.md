# P8-53O — trwała blokada admission przed development restart

Data: 03.10.2026. Stan: implementacja źródeł, produkcyjny build Windows i
częściowa weryfikacja procesu zakończone. Pełny restart workspace pozostaje
**NOT VERIFIED**; publiczne `restart_available` nadal jest `false`.

## Zmiana

`SessionStore` pod wspólną transakcją `WRITER.lock` sprawdza intenty, wszystkie
katalogi i aktywne compute/preparation leases niezależnie od konfiguracji poola.
Brak/pusty katalog przy intencie oraz pusty lub nieterminalny katalog bez intentu
odmawiają przejęcia. Dokumenty są ograniczone rozmiarem, sprawdzane jako zwykłe
pliki i wiązane z identyfikatorami ścieżek. Nieznany stan nie oznacza bezczynności.

Ta sama transakcja publikuje `development/ADMISSION-FENCE.json`, związany z
owner token, nonce i czasem utworzenia. Granice nowego intentu, dispatch,
compute/preparation lease, preparation process launch, retry i nieterminalnej
projekcji katalogu sprawdzają marker przed publikacją pracy. Terminalne zapisy,
release i historyczne reconciliation bez tworzenia pracy pozostają możliwe.
Marker nie wygasa automatycznie; jego usunięcie wymaga zgodności pełnego rekordu.

Prywatna komenda owner-control `drain_idle_confirmed` uzyskuje marker przed
zatrzymaniem schedulerów. Busy/unknown odpowiada `idle_not_proven` bez drain.
Transakcja writer kończy się przed oczekiwaniem na dzieci, żeby ich checkpointy
i receipts mogły zostać zapisane. Terminalna odpowiedź
`runtime_service_idle_drain.v1` zawiera owner/configuration i pełny marker.
Marker pozostaje po wyjściu usługi oraz przy nieznanym wyniku.

Klient `drain_idle_confirmed` ponownie przypina ownera i konfigurację przed
mutacją, sprawdza terminalne dzieci oraz porównuje odpowiedź z odczytanym
trwałym markerem. Nie rozpoczyna nowego procesu i nie usuwa blokady.
Dotychczasowe `drain_confirmed` zachowuje swój odrębny kontrakt.

## Dowody

- `just windows-workspace-build dev dev 3197 auto`: końcowy build exit 0,
  bez kompilowania testów jednostkowych; preflight i source identity passed.
- `just verify-windows-development-backend-api`: **53 sprawdzenia, exit 0**.
  Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/c88984667c7c438f899798bfe69d825c/receipt.json`.
- Rzeczywista własna usługa odmawia idle drain przy poprawnym pustym katalogu
  bez intentu oraz nieznanym markerze, pozostając Ready. Przy pustym store
  zatrzymuje oba dzieci, publikuje Drained i zwraca identyczny trwały marker.
  Marker pozostaje po zakończeniu procesu. Wszystkie 12 procesów fixture
  zostały odczekane; port API mostka CLI został zamknięty.
- Źródła backendu przed/po verifierze:
  `a4c696f5ab073aadb5cc483f0cd0325ee019ba78ad44ac2e9ab264b4cc4baaeb`.
  Snapshot buildu:
  `2f5c21fc6d7be8dd9e4dcb7c859d84e27468936636672368de747381a3b51655`.
  Baza: `e66c4779b8a151af34f71bfe8675b1c5144ff227` + ten przyrost.
- Review znalazło pomijanie katalogu bez intentu; poprawka i ponowne review
  zamknęły tę uwagę. Rustfmt, parser Python i diff whitespace przeszły.

Dodano pięć regresji Rust jako źródła. Zgodnie z aktualną instrukcją nie
kompilowano ani nie uruchamiano testów jednostkowych.

## Osobny incydent launchera

Zapis poprzedniego runtime wskazywał nieistniejącego managera. Zarządzane
`just windows-runtime-recover 3197` potwierdziło brak procesów/listenera,
zachowało oryginalny zapis jako
`native-runtime-prior-ea3d85ec83b84614b11577317a098b1b.json` i zakończyło exit 0.
Ponowne `just windows-ui dev` uruchomiło API i frontend na 3197; `/workspace`
zwrócił 200, browser pokazał Welcome to Fullmag bez błędów JavaScript.
Watcher potwierdził nowe binaria bez restartu aktywnego UI.

## Otwarte bramki

Nie potwierdzono runtime wyścigów admission, aktywnego compute/preparation,
wszystkich punktów odrzucenia ani klienta Rust przez docelowego koordynatora.
Źródłowe regresje nie zastępują tych dowodów. Natywne `sync_directory` na
Windows pozostaje no-op: trwałość przy utracie zasilania jest NOT VERIFIED.

Pozostają: manager restartu, podłączenie acquisition i snapshotu szkiców,
kontrola zamknięcia API i procesów, przypięcie nowego API, odtworzenie UI,
kontrolowane release markera i fault gates całego przebiegu. Zakres tego
przyrostu obejmuje accepted compute/preparation; nie kwalifikuje wszystkich
historycznych live-session ścieżek ani pełnego produktu Windows/FEM.
