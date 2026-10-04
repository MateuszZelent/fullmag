# P8-31 — inicjalizacja zasobów pakietu z handshake API

## Zmiana

`prepare_packaged_application_service` w runtime-control łączy dotychczasowe
granice canonical accepted store, API identity, stabilnej konfiguracji P8-29
i budżetów P8-30. Metoda przygotowuje konfigurację i zwraca przypiętą instancję
API. Nie uruchamia procesu, nie przyznaje nowej lease i nie zastępuje ownera.

Kolejność jest istotna:

1. Własny executable musi należeć do rozpoznanego pakietu Windows; canonical
   install root musi odpowiadać rootowi API. Checkout developerski nie wybiera
   domyślnych ofert przez przypadek.
2. Wspólny resolver wybiera accepted store; nie używa local-live store,
   tymczasowej ścieżki ani alternatywnego wolumenu.
3. API musi mieć zgodny build, kontrakt, binding accepted store i UUID przed
   inicjalizacją storage.
4. Jawny `FULLMAG_RUNTIME_SERVICE_CONFIG` ma pierwszeństwo. Błędny plik lub
   obcy root odmawia operacji przed utworzeniem store, bez generatora zastępczego.
5. Bez override store inicjalizuje się przez istniejącą granicę writer/FS.
   `for_application` odczytuje persisted konfigurację albo mierzy zasoby raz
   pod launch guard i writer lease. Target jest identyczny jak w generatorze.
6. Po inicjalizacji ponowny handshake musi potwierdzić ten sam UUID API.
   Odmowa nie uruchamia usługi i nie usuwa poprawnie zapisanej konfiguracji.

Istniejący explicit ensure korzysta z tej samej funkcji przygotowania
konfiguracji, nadal sprawdza API po ensure i odmawia nieznanego startu.
Retry obejmuje tylko istniejący typed StoreWriterBusy. Busy launch guard,
uszkodzenie konfiguracji, orphan i błąd pomiaru kończą operację; nie są
traktowane jako zgoda na reset lub ponowne uruchomienie.

Wynik przygotowania jest obserwacją, a nie lease instancji API. Konsument
uruchamiający usługę musi ponownie sprawdzić UUID po ensure oraz przekazać pin
do klienta. Nie wolno przedstawiać samej przygotowanej konfiguracji jako ready.

## Weryfikacja

- `rustfmt --check` i scoped diff check: PASS.
- Niezależny source review kolejności walidacji, precedencji konfiguracji
  i locków: PASS, bez P0/P1.
- Trzy regresje Rust zapisane: zachowanie persisted snapshotu bez ponownego
  pomiaru; błędny explicit config nie inicjalizuje store; checkout nie spełnia
  granicy installed package. NOT RUN / NOT COMPILED — obowiązuje zakaz unit builds.
- Build, realny handshake konkurencji, Windows FS i clean install: NOT VERIFIED.
- Brak zmian zależności, OpenAPI i generated frontend; metoda pozostaje
  wewnętrzną granicą natywnego launchera, nie zasobem przeglądarki.

## Otwarta integracja

Domyślny autorun nie jest jeszcze włączony w launcherach UI. Aktualizacja
audytu konsumentów 03.10.2026: CLI i Tauri używają już
`application_attach::prepare_for_authoring` z [P8-37](37-authoring-before-runtime-attach.md).
Jawnie skonfigurowane dołączenie rozpoczyna się w tle po otwarciu authoringu;
błąd tego dołączenia nie kończy startupu UI. Bez
`FULLMAG_RUNTIME_SERVICE_CONFIG` ścieżka nie tworzy konfiguracji, wątku ani
procesu usługi. `prepare_packaged_application_service` nadal nie ma
produkcyjnego konsumenta; samo jego istnienie nie dowodzi inicjalizacji
zasobów po instalacji.

Osobny zasób `GET /v2/platform/runtime-service` jest zarejestrowany po stronie
Rust w P8-33. Wygenerowany klient, globalny resource hook i widoczny status
w Control Room pozostają otwarte; dotychczasowy status solvera opisuje sesję
interaktywną. Kolejność odbioru: realny eksport OpenAPI → generated klient →
resource hook niezależny od aktywnej sesji → jawny status usługi w UI →
domyślna inicjalizacja i attach pakietu w tle po otwarciu authoringu. Każdy
krok musi zachować edycję i zapis podczas niedostępności obliczeń. Sam log
launchera nie spełnia wymagania widocznego stanu dla użytkownika.

Ponowny audyt packagingu potwierdził deklarowane programy usługi,
schedulerów i publisherów w Windows MSI; nie wykazał osobnego brakującego
pliku pakietu. Nie zastępuje to rzeczywistego Windows build/install/run.

Plan P0–P8, Windows lane qualification oraz odbiór produktu pozostają otwarte.
Sesji na 3104 nie zatrzymano. Nie zmieniono danych innych zadań.
