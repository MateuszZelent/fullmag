# P8-53AB — prywatne zatwierdzenie i graceful exit API

Data: 04.10.2026. Zakres: natywny Windows workspace dev, prywatny owner-control,
bez skonfigurowanego resident service. P8-53 pozostaje w realizacji.

## Zachowanie

Właściciel CLI utrzymuje przejęcie kanonicznej sceny oraz rzeczywisty cold-idle
fence magazynu. Przed wysłaniem `commit_cold` ponownie odczytuje staging i
kandydata oraz sprawdza pin API i binding magazynu. Osobny hash pełnego manifestu
pakietu wykrywa zmianę metadanych przy niezmienionym source build ID.

API porównuje kapsułę z przechwyconą sceną i tożsamością bieżącej generacji,
sprawdza staged receipt, pliki oraz trzynaście produkcyjnych EXE kandydata.
Istniejący semantyczny loader Python dostarcza tę samą weryfikację hashy payloadu,
składników i kompletności plików sceny, której używa późniejszy restore.
Prywatny helper jest przypięty do repozytorium i zarządzanego Pythona; jego
wejście, wyjście i czas życia są ograniczone. Nie zapisuje receipt ani kapsuły.

Przed próbą trwałego zatwierdzenia API zamyka admission do końca procesu i
zachowuje transition guard. Nierozstrzygnięta publikacja nie przywraca mutacji.
Po poprawnym zatwierdzeniu wysyła ACK i sygnalizuje graceful shutdown także,
gdy zapis ACK zawiedzie albo zadanie zostanie anulowane. CLI traktuje ACK jako
potwierdzenie rekordu; osobno oczekuje na zakończenie dokładnie własnego API.
Fence i commit pozostają na dysku. Nie ma automatycznego ponowienia commit,
odblokowania magazynu ani wymuszonego zakończenia na ścieżce sukcesu.

## Weryfikacja

`just verify-windows-development-handoff`: **116 interpretowanych regresji**,
bez pominięć, exit 0. Receipt względem
`storage/builds/fullmag-0950f4dca4ffe38f`:
`development-handoff-checks/checks/4cf701cc5af74069a9930f766fbdc46b/receipt.json`.
Digest źródeł przed/po:
`8d855b1b849f6f7d499732169f36a22f485e46cb4095e4489644774ac8828791`.
Nowe regresje sprawdzają uszkodzone hashe składników i payloadu mimo poprawnie
przeliczonego snapshotu/receipt, brak semantycznego assetu mimo poprawnych hashy,
obcy root/worktree/binding/digest oraz odrzucenie nieznanych pól.
Poprawna kapsuła importu jest sprawdzana bez zmiany bajtów i receipt.

Pierwszy produkcyjny build EXE przeszedł z exit 0. Natywna sonda wykryła różnicę
zwykłej ścieżki Windows i prefiksu verbatim podczas porównania namespace
kandydata; zakończyła się przed zatwierdzeniem handoffu. Receipt zachowano:
`development-backend-api-checks/checks/1e57b163e0e14350ac7998460b79514e/receipt.json`.
Klient porównuje teraz oba katalogi po kanonikalizacji i kontroli ancestorów.
Druga sonda ujawniła tę samą różnicę zapisu w semantycznym helperze Python
(receipt `819c22a9facf4a80b77e66d63bf91d27`). Po walidacji ścieżki helper
porównuje teraz tożsamość katalogu przez `samefile`, zachowując pozostałe
kontrole root/worktree/runtime. Regresja Windows pokrywa prefiks verbatim.
Zachowaną kapsułę odczytano poprawnie przez ten helper bez zmiany receipt.
Review poprawek nie znalazło nowych actionable findings. Końcowy zarządzany
build produkcyjnych EXE i natywna sonda przeszły z exit 0.

`just verify-windows-development-backend-api`: **139 kontroli**, **42 zapisane
procesy z potwierdzonym wait**. Receipt:
`development-backend-api-checks/checks/3f40ced1eb394d7bbd9df7334c45ff6c/receipt.json`.

- Digest backendu przed/po:
  `3b439da8d6a6fb9f79c3adc410d323fbcd8d82fd9bf9567dc5417c34864a8abe`.
- Snapshot buildu:
  `ef44f05e56063bdd7e0e3eb0c2700cfd1e58e341d323aad2516d7dd65b4410c4`.
- Zatwierdzony handoff: `d5385f23-9f34-4684-930c-756ee4cc6c9e`.
- Snapshot handoffu:
  `e8fd6ba3b035c181f7b9b63814413ba72c25e7e8b72a627129f46edb30108539`.

Własna sonda używa rzeczywistego przejęcia kanonicznej sceny. Odrzuca brak
fence, obcy hash snapshotu, target, kandydata, manifest i handoff bez publikacji
commit. Przy potwierdzonej odmowie jawnie kończy wyłącznie swój probe fence.
Poprawna ścieżka utrzymuje guard dziecka do terminalnego wait z exit 0,
porównuje rzeczywisty rekord i pełny fence, a po zwolnieniu kernel guards
zachowuje trwały fence. Kapsuła nadal ma receipt `staged`, nie `restored`.
Sonda nie jest dowodem odtworzenia geometrii, regionów czy materiałów w nowym UI.
Po sondzie bieżący workspace użytkownika na 3197 odpowiadał HTTP 200.
Nie kompilowano testów jednostkowych. Procent pełnego P8 pozostaje bez awansu.

## Pozostałe bramki

Pełny restart nadal jest NOT VERIFIED: utrata ACK wymaga własnej sondy runtime,
resident service wymaga połączonego drain, a replacement wymaga sprawdzonego
zakończenia lifecycle fence, restore przed listen, nowego pinu API oraz hydration
szkiców i niepustego modelu w przeglądarce. `restart_available` pozostaje `false`.
Zakończenie własnego API nie dowodzi odtworzenia workspace, wykonania solvera
ani kwalifikacji wydania. Działająca sesja użytkownika na 3197 jest zachowana.
