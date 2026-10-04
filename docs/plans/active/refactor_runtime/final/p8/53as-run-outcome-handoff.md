# P8-53AS — ochrona zapisu wyniku runu podczas restartu

Status: poprawka i regresje fokusowane potwierdzone; wspólne kontrole
frontendu zablokowane przez niezależne zmiany Start/About. Nie jest to
potwierdzenie pełnego natywnego restartu ani zakończenie P8.
Baza: lokalny checkpoint P8-53AR
`f5400a7c6eb8c56b7ba3f84b62d37a27020c9a88`.

## Przyczyna

Po integracji recorderów wyników `RunOutcomeConnector` czeka 400 ms na
końcową klatkę viewportu i pobiera thumbnail, zanim wywoła kontroler
dokumentu. Ta praca nie jest aktywną operacją API ani dokumentu.
Restart może więc zdobyć guard i capture wcześniej. Późniejszy
`recordRunOutcome` dopisuje wtedy wynik do `pendingOutcomes` starego
właściciela. Snapshot handoff nie obejmuje tej kolejki, a świeży właściciel
jej nie posiada. Review wykazał konkretny trigger utraty wyniku/thumbnailu.

## Kontrakt poprawki

Zapis wyniku otrzymuje synchroniczną rezerwację kontrolera dokumentu
przed advancement trackera, timerem i pobraniem thumbnailu. Zwalnia ją
idempotentnie w `finally`, po zakończeniu zapisu lub przekazaniu do
dotychczasowej kolejki. Capture/begin/restore handoff oraz `assertCurrent`
odrzucają aktywną rezerwację, nieopróżnioną kolejkę i trwający flush.
Nie rozszerzamy ogólnej blokady operacji o kolejkę: Save i flush muszą
mieć możliwość jej opróżnienia.

Connector nie konsumuje obserwacji runu podczas pauzy ani przy zajętym
guardzie dokumentu. Subskrypcja snapshotu dokumentu pozwala ponownie
rozpatrzyć obserwację po zwolnieniu guardu. Zachowujemy kolejkę wyniku
dla brudnego projektu i jej dotychczasowy flush po Save. Nie usuwamy
wyników ani nie dodajemy nowego payloadu lub schematu handoff.

## Zakres weryfikacji

- Rzeczywisty kontroler: rezerwacja przed opóźnionym zapisem blokuje
  capture/begin/restore; release jest idempotentny.
- Kolejka i flush nie mogą zostać pominięte przez handoff; normalny zapis
  i Save nadal je kończą.
- Connector zachowuje obserwację, gdy pauza/guard blokują rozpoczęcie;
  brak częściowego advancement trackera przed rezerwacją.
- Interpretowana regresja przez
  `just verify-control-room-development-run-outcome-handoff`, bez
  kompilacji testów jednostkowych; produkcyjne typowanie, API hygiene i lint.
  Driver JS wczytuje rzeczywiste źródła; transformacja w pamięci obsługuje
  parameter property konstruktora TS. Nie zapisuje plików wynikowego kodu.
  Hooki React mają harness protokołu, nie wykonanie React w przeglądarce;
  właściwy dowód komponentu pochodzi z osobnej fixture browser.
- Review interakcji oraz
  `just verify-development-run-outcome-handoff-browser`: rzeczywisty
  komponent React, kontroler, resource hook i registry thumbnaili z
  kontrolowanymi odpowiedziami API/Tauri. Obejmuje opóźniony zapis,
  pause/resume i zwolnienie guardu bez podwójnego konsumowania obserwacji.
  Minimalny kernel fixture nie dowodzi wymiany całego KernelProvider;
  ta ma osobny dowód P8-53AR.

## Wyniki, 04.10.2026

Końcowe przebiegi dotyczą `master` na bazie
`c8936c7fe4ac375c76d03bbe81a42a435d9b6886` z lokalną poprawką.
Digest źródeł przed i po każdej kontroli:
`0d07d9ca450f1d44596d457c1288e80dd65e59ff15b5447a7343c009256399f8`.
Kontrole nie kompilowały testów jednostkowych.

Lokalny commit poprawki i regresji:
`194903d2a43b0336fba82438a12a4b97a22024e4`
(`fix: guard run outcomes during development handoff`, 15 plików).
Nie obejmuje równoległych zmian Start/About ani przygotowanego planu P8-53AT.
Hook React Doctor zakończył się jednym ostrzeżeniem dotyczącym
`JSON.parse(JSON.stringify(...))` w driverze regresji: służy jednorazowej
normalizacji obiektu z kontekstu VM przed porównaniem. Nie jest to ścieżka
renderowania ani kod produktu; nie zmieniono reguły ani nie wyciszono jej.
Commit zakończył się exit 0. Publikacja na remote pozostaje oddzielną,
wcześniej zablokowaną czynnością.

Receipts są pod rozwiązywanym storage projektu:
`builds/fullmag-0950f4dca4ffe38f/`. Identyfikatory poniżej wskazują
podkatalog przebiegu; każdy zawiera `receipt.json` i log.

| Recepta | Profil / przebieg | Wynik i zakres |
|---|---|---|
| `verify-control-room-development-run-outcome-handoff` | `windows-control-room-source-check/development-run-outcome-handoff-check/f12c7557851041d88c7da4bf8d343906` | PASS, 5 grup, exit 0; rzeczywiste źródła kontrolera i connectora, hook protocol harness |
| `lint-control-room-development-run-outcome-handoff` | `windows-control-room-source-check/development-run-outcome-handoff-lint/0205e133765f484d9db980ee22435da8` | PASS, exit 0; wyłącznie 6 plików poprawki i jej regresji, stała lista zapisana w receipt |
| `check-control-room-api-hygiene` | `windows-control-room-source-check/api-hygiene/74a32156441f4120a1afb4177c679f3a` | PASS, exit 0; wspólna kontrola granic API |
| `verify-development-run-outcome-handoff-browser` | `windows-control-room-browser-fixture/development-run-outcome-handoff-browser/7719604b5e114d348ea081e6eb9654a3` | PASS, 9/9, exit 0; Chrome, rzeczywisty React/connector/kontroler/resource hook/registry, kontrolowane API i Tauri |
| `check-control-room-production-source` | `windows-control-room-source-check/production-source/3f3355034ca64abb87f0144805fb3810` | FAILED, exit 2; 5 diagnostyk w niezależnych plikach Start/About, bez diagnostyk w plikach poprawki |

Browser potwierdził blokadę capture/begin podczas settle, deferred thumbnail
i deferred zapisu Tauri; rozpoczęty recorder dokończył zapis również po
włączeniu pauzy. Każdy z trzech przypadków zapisał dokładnie jeden właściwy
`run_id` i preview oraz przyjął dokładnie jedno ponowne otwarcie zmienionego
archiwum. Obserwacje terminalne zatrzymane przez pauzę lub guard zostały
rozpatrzone po ich zwolnieniu. Brak page/console errors i nieobsłużonych
żądań. Własny serwer na 3253 ma `owned_server_terminal=true`.

Pomiar czasu jawnie instrumentuje instancję prawdziwego kontrolera:
wrapper deleguje przyznanie i release do oryginalnych metod. Początek
400 ms pochodzi z aktywnej rezerwacji, nie z publikacji statusu serwera
przed asynchronicznym fetch. Nie podmieniamy timerów ani zachowania
kontrolera. Screenshot sprawdzono wizualnie; fixture nie renderuje WebGL.
Kontrolowany host nie zapisuje prawdziwego pliku projektu ani nie dowodzi
walidacji ZIP/PNG, durability lub wykonania solvera.

Review źródeł nie pozostawił Required finding dla pierwotnego P2.
Kolejka zachowuje dotychczasową semantykę Save/flush. Nie zastępuje to
otwartych kontroli integracji całego frontendu.

### Blokady wspólnych kontroli

Końcowe produkcyjne typowanie zgłosiło brak `RecentIndexState` w
`src/modules/start/inspector/ProjectInspector.tsx` oraz brak `institution`
w `ExtendedAuthor` używanym przez `model/aboutFullmag.ts` i
`sections/AboutSection.tsx`. Tych równoległych zmian nie edytowano ani
nie dołączono do checkpointu.

Pełny lint z przebiegu
`windows-control-room-source-check/lint/f7ebbe5ac2c042be893b4fe29110081a`
zakończył się FAILED: wykrył diagnostyki fixture oraz 9 ostrzeżeń w cudzym
Start/About. Nasze diagnostyki usunięto i potwierdzono osobną stałą listą
6 plików; nie oznaczamy całego lint jako PASS. Wspólne bramki muszą być
ponownie wykonane po ukończeniu zmian Start/About, przed integracją.

### Historia prób

- Pierwsza trasa źródeł odmówiła przed utworzeniem runu: `Storage is busy`.
  Potwierdzono uruchomienie użytkownika na 3197 i późniejsze zwolnienie
  blokady; nie usuwano locka ani nie zatrzymano jego workspace.
- Typecheck `4aab5a5502554e11a49e2b19fd05c208` wykrył nielegalny typ koloru
  fixture. Użyto produkcyjnego `Viewport3DThumbnail` i wartości `none`.
- Typecheck `777b2e48ee9b4451bb66113ac2cdc2f5` miał tsc exit 0, lecz source
  changed; wynik managed pozostał FAILED. Późniejszy
  `8a0254f3544346ea826c20123382e973` wskazał błędy równoległego Start/About.
- Browser `be45780059bc459ba18fd677c379c024` ujawnił niewłaściwy początek
  pomiaru i zmianę źródeł; FAILED, własny serwer terminalny. Po korekcie
  pomiaru `73ecbc6ea1214a4084e48ae5709bc71d` przeszedł 9/9, ale następna
  korekta obserwatorów fixture wymagała ponownego wykonania. Finalnym
  dowodem jest wyłącznie `7719604b5e114d348ea081e6eb9654a3`.

Pusty browser fixture P8-53AR nie dowodzi zapisu wyniku runu. Pełny
natywny restart niepustego workspace, warm-service, fault/power-loss
i kwalifikacja wydania pozostają odrębnymi bramkami.
`restart_available=false`; procenty całego planu bez awansu.
