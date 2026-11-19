# Odtworzenie wrapperów po poprawnym drain — 25.10.2026

## Problem i zakres

Zatwierdzona finalizacja próby 743a85 została wykonana; nie należy jej ponawiać.
Stare wyniki V/J/H i kanoniczne archiwum pozostają zachowane. Pełne Universe
nie zostało jeszcze obliczone. Dotychczasowe H obejmuje 14 punktów, nie siatkę objętościową.

Aktywacja przygotowanego skryptu Universe została odrzucona przed mutacją:
`docker_startup_script.py` różnił się od helpera w działającym obrazie.
Zarządzane `docker-dev-images` przygotowało nowe obrazy, bez zmiany usług:
backend `sha256:4b54ecd6b33649dda5532b6a185bc6e9547d077b80ac7bd7e159cf402a946b58`,
frontend `sha256:b7a46c24c1b4e9316b3d820272f192326f7e958ff7f77e9ce356caee0551e821`.

Kanoniczne API zapisało prawdziwą pustą sesję authoring i zachowało wcześniejsze
źródło jako opaque source. Native preflight checkpointa przeszedł, wiążąc
12 zachowanych historii runów. Managed stop-only zakończył się sukcesem:
`0dced3e444f549388f37e6acf16f1ac1`, checkpoint SHA256
`adb7dfe708a384f734c9d587ba0cbae8e3f795254ba78c37edb61f6766545167`.

Recreate odmówił, ponieważ per-container failed-stop journal odnosił się do
starszej inkarnacji, a bieżący receipt poprawnie opisywał późniejszy drain.
Nie usunięto ani nie nadpisano journala. Managed resume `61832d440b8f4536ac8a428b705a6fc3`
zbudował pakiet (Make exit 0, 184384 ms) i uruchomił API/runtime na tym samym
backendzie; cały resume ma jednak status failed-confirmed, ponieważ frontend
odmówił startu z powodu tożsamości zapisanej konfiguracji. Nie wolno przedstawiać
go jako zakończonego sukcesem.

Dodatkowo frontend refresh w WSL używał czytnika Windows (`msvcrt`). To osobny
błąd wyboru adaptera hosta; nie dowodzi braku wyników naukowych.

## Poprawka

- Frontend refresh wybiera kanoniczny adapter hosta, ścieżkę certyfikatu i owner.
  Pozostają sprawdzenia zgodności owner/certificate, końcowych dokładnych bajtów,
  źródeł, pakietu, inkarnacji backendu i gotowości API.
- Jawny proof `fullmag.drained-successor-proof.v1` przypina konkretny successful
  managed stop-only, historyczny journal i aktualną konfigurację native.
- Walidator porównuje zatrzymane inkarnacje usług, nowy drain, persisted OWNER,
  immutable Ready pin oraz nieaktywny rejestr zasobów. Saved-authoring zachowuje
  dodatkowe istniejące kontrole archiwum i historii; zwykły idle stop musi
  potwierdzać brak aktywnej sesji i zapisać dokładny snapshot zatrzymanych usług.
- Pusty typed context nie przekazuje recovery authority do native. PID1 nadal
  uwierzytelnia drain i rotuje generację wyłącznie pod istniejącym OWNER.lock.
  Nie zmieniono równań, tolerancji, limitów ani native admission.
- Ten sam witness jest ponownie sprawdzany pod blokadą recreate i po potwierdzonym
  usunięciu usług. Kontynuacja korzysta wyłącznie z przypiętego terminalnego
  receiptu, sprawdza nieobecność obu starych ID i nie powtarza usuwania.
- `just docker-dev-stop-idle` udostępnia istniejące `restart-idle-volume --stop-only`.
  Recreate otrzymuje parę jawnych pinów proof/sha; nie ma fallbacku do świeżego storage.

## Dowody i odbiór

Frontend WSL: regresja RED odtworzyła błędy `msvcrt`; GREEN 1203 testy,
24 pominięte, exit 0. Raporty w wolumenie kontrolnym:
`verification/frontend-refresh-host-profile-20261025/{red,green}.json`.

Pierwszy wspólny zestaw z zarejestrowanym modułem native failed-recreate:
1255 testów, 24 pominięte, 3 failures i 2 errors. Ujawnił błędną ścieżkę
czytnika rejestru oraz nieaktualną fixture dodatkowego optional read. To nie
jest GREEN nowej ścieżki. Po poprawkach skupiona diagnostyka 53 regresji
przeszła (0.724 s); rzeczywisty readonly odczyt ledgera przez helper również
przeszedł. Końcowy wspólny zestaw managed: **1256 testów, 24 pominięte,
84.427 s, exit 0**, wraz z walidacją source-scene capture. Receipt zachowano
jako `verification/wrapper-refresh-20261025/green-all-1256.json`.

Przed wykonaniem: zakończyć regresje, przejrzeć diff i zapisać commit, potwierdzić
brak aktywnych zadań/rezerwacji, wykonać managed stop-only i pełny readonly proof
preview. Dopiero potem odtworzyć usługi bez zmiany storage/cache, potwierdzić
native start i publiczne API oraz uruchomić przygotowanie Universe z
`wait_for_solve(True)`. Rzeczywiste liczby source tet i domain nodes muszą spełniać
zatwierdzony budżet przed jednym Solve. Nie ponawiać operacji o nieznanym wyniku.

Wyników przeglądarkowych/WebGL nie uzyskano; wcześniejsza blokada narzędzia
pozostaje. Nowe obrazy, GREEN testów czy poprawny build nie są dowodem obliczenia
pełnego pola ani kwalifikacji bazy LLG/FFT. Cel E0–E12 pozostaje nieukończony.

## Doprecyzowanie granicy shell

Pierwsze wywołanie nowego stop-only zostało odrzucone przez allowlistę shell
przed wykonaniem lifecycle. Dopisano dokładną parę nowych flag recreate i
przeniesiono istniejące opcjonalne stop-only poza grupę saved-authoring.
Nie poszerzono dispatchu do dowolnego polecenia. Cztery nowe regresje wykonują
rzeczywisty blok dispatchu z podstawionym wyjściem argv: ordinary stop-only,
saved-authoring stop-only, obie pary pinów i odmowa niepełnych/nadmiarowych flag.
Po tej korekcie cały moduł recreate: **57 testów PASS**, wraz z wcześniejszymi
guardami native/owner/retained state. Bash syntax PASS. Raport:
`verification/wrapper-refresh-20261025/native-focused-shell-final.json`.
Wynik 1256 testów powyżej dotyczy wersji przed tą wąską korektą shell.

## Kolejność mountów Docker

Rzeczywisty readonly preview odmówił porównania pełnego inspect. Odczyt różnic
potwierdził wyłącznie permutację Mounts; żadne ich pole nie zmieniło wartości.
Walidator używa teraz istniejącego fingerprintu, który sprawdza unikalne
kanoniczne destinations i sortuje mounty z zachowaniem wszystkich pól.
Pozostała część inspect nadal wymaga dokładnej zgodności. Regresja dopuszcza
permutację, lecz odrzuca zmianę flagi RW. Nowy helper wpisano również do
opcjonalnego manifestu implementacji kontrolowanych przez offline checks.

Zarządzane kontrole offline w grupowym helperze dla zatrzymanego backendu:
**85 testów PASS**, 7.985 s, wejścia źródłowe stabilne, source readonly,
control writable. Receipt:
`verification/wrapper-refresh-20261025/offline-mount-order-85.json`.
To końcowy zakres po korekcie kolejności mountów; nie jest dowodem startu
nowych usług ani obliczenia Universe.

## Bieżący checkpoint: grupa odtworzona, próba Universe nieudana — 25.10.2026

Zarządzane odtworzenie grupy zakończyło się sukcesem: removal
`7d6f913f9349430ab78f5d81b721af56`, development
`8ea82405252446628c12e041485547c3`, konfiguracja
`60b3af127cc966b8bbe1add9addd7066ed75d10952dbfe082bf9f3190ecebfeb`.
Obie rzeczywiste usługi używają obrazu
`sha256:4b54ecd6b33649dda5532b6a185bc6e9547d077b80ac7bd7e159cf402a946b58`;
obraz dev-wrapper `b7a46c24…` był przygotowany, lecz nie jest obrazem
uruchomionego frontendu. API przez port 3203 odpowiada HTTP 200, usługi healthy.
Pakiet pochodzi z `a71b4c628dd8e9f9fc6916caf5e834a791eb5d25`, snapshot
`7bce56b94d281910c51ae984c916721e93f76c0656d0979f7993260fbca11c79`.
Wyniki wcześniejszej próby: 70/70 plików i oba archiwa FMS bez zmian;
ponowna walidacja publicznego HTTP V/J/H: 31 kontroli PASS.
Nie jest to dowód wizualny UI/WebGL.

Aktywacja skryptu Universe `84ad00cc34f0452c8145098a0cc59df3` zakończyła
się sukcesem z `wait_for_solve(True)`. Odczyt niezmiennego katalogu CAS
`47beccc34f358c02887cc18c157793657153e3d30d73ad77fd06302092fbc9bc`
potwierdził oddzielne źródło 677 węzłów / 1862 Tet4 oraz globalną domenę
1154 węzłów / 6503 Tet4 (4777 powietrza, 1726 przewodnika).
Manifest aktualnie wybranego source mesh nie opisuje całego Universe.
Nie wykonywano dodatkowego mesh_build. Budżet wejścia: 2148748 par < 4000000.

Po ponownym sprawdzeniu ready receipt i rewizji wysłano dokładnie jeden Solve:
`fm-20b49703-375a-4cf1-8eb6-4ce2fca64a0f`, client intent
`antenna-universe-surface-20261025-solve-01`, HTTP 200 accepted.
Run `run-live-ace433241f22879d2bc6fc8c5df1b24368fb4f68ecbd973799ec8e3460ab1992`,
attempt `attempt-3519d1b2bee5418d8b17784621fd4fb0`, ownership epoch 1.
Próba zakończyła się Failed, retryable=false, bez opublikowanych artefaktów:
`surface RT0 wall-time exhausted`. Zdarzenie terminalne: sequence 340,
`5948bf8fe8e742428caf3bcde5b7fbdd`, raw SHA256
`767c07d08a4c3774d200f4d16771a0ac6575d714fdee2a04330e46b01cf4a4fd`.
Worker exit 1, timed_out=false w receipcie procesu: limit zgłosił natywny
moduł, nie zewnętrzny watchdog. Proces nie istnieje; kolejka jest pusta,
obie rezerwacje tej próby (preparation/compute) są released. Nie ponowiono Solve
ani nie zwiększono limitów. Nie ma nowej mapy H do pokazania w UI.
Kontrola przed buildem: 70/70 wcześniejszych plików i oba archiwa bez zmian,
sześć niezmiennych plików wejścia/dowodów tej próby przypięto SHA256.
Raporty: `failure-checkpoint.json` i `pre-build-retention.json` w katalogu
`verification/universe-surface-trial-20261025/`.
Dowody: `verification/universe-surface-trial-20261025/` i
`verification/wrapper-refresh-20261025/` w wolumenie kontrolnym grupy.

Ponowny fetch potwierdził `origin/master`
`f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48`; nie został jeszcze scalony.
Integracja nastąpi po terminalnym rozstrzygnięciu tej próby. E0–E12 pozostaje
nieukończone: wykonanie próby nie oznacza kwalifikacji bazy, LLG/FFT ani BORIS.

Integracja źródeł mastera została następnie zapisana w merge
`3babed412bf8af3ac681f3ea3a920b535085052b`; zgodność ze współdzielonymi
typami w `db4e2da2e2b13303edb0db6f5af61af269442dc8`. Bieżący plan
realizacji rozróżnia tę integrację od oczekującego buildu i GREEN zapisu anteny.


## Zapis anteny po aktualizacji mastera — 25.10.2026

Master `f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48` jest zintegrowany przez
`3babed412bf8af3ac681f3ea3a920b535085052b`. Zarządzany resume
`140a9536ec134565ae55ded40a906b90` zakończył się sukcesem; Make trwał
498150 ms. Pakiet pochodzi z czystego `0aaac63298eb70a0ccf5bbbd695a4dec0d38139f`,
snapshot `9814adfd25698311d69e02e57efedf26d5e27b26a440c041dc97793efb058e2e`.
To dowód buildu i startu, nie zakończenia obliczeń Universe.

Rzeczywiste API zapisuje źródło Python anteny bez magnetyka, lecz ponowne
otwarcie nie udostępnia sceny authoringu: publiczny create nie zapisuje
provenance, a czytnik odrzuca własną historię źródła. Poprawka dodaje
prawdziwe puste provenance wyłącznie nowym projektom oraz dopuszcza historię
źródła tylko przy dokładnej ścieżce SHA256 zgodnej z bajtami. Nie dopisuje
historii zastanym archiwom. Create zwraca rewizję po inicjalizacji; klient
musi używać zwróconej rewizji. Regresja HTTP obejmuje kolejne edycje, no-op
i osiem przypadków niepewnych archiwów. Weryfikacja nowego pakietu pozostaje
do wykonania; wynik cold-open obecnego pakietu jest FAIL.


### Weryfikacja poprawki cold-open

Commit aplikacji: `498a36ae53c36b79a2dda7aa06d4eed270e6c120`.
Stop zapisanej sesji `4f4a9204bf134160af50ac3a335d38d3` przeszedł pełny
preflight z 13 zachowanymi historiami. Resume/build
`3abcda48ff874ad5ba8722a348298ea7` zakończył się sukcesem w tej samej grupie,
snapshot `5c476c60ae72f5f169f68419fd147827ec15453b91fd316aa0e5b9f9ac85db22`.
SHA256 terminalnego receiptu:
`8d3ab1cb3451fa1a56487cec47dca186b8ed477be29ee25c1e6d2a810dccc88f`.

Regresja HTTP: **PASS** — świeży projekt bez magnetyka, źródło Python,
dwie kolejne edycje z zachowaniem wcześniejszych bajtów, cold-open, no-op,
osiem przypadków niepewnego archiwum, obca tożsamość i nieaktualna rewizja.
Aktywna sesja pozostała niezmieniona. Klient regresji poprawiono po buildzie:
kanoniczny kodek zmienia formatowanie manifestu, dlatego test porównuje jego
semantykę, a bajty wszystkich dokumentów nadal dokładnie. Końcowy SHA256
walidatora: `3e3045cc832269b380c855c55edccfb05d9877e5e1224b61198cf6c9206bb2da`.
Raport: `verification/antenna-authoring-source-20261025/validator-cold-open-canonical-metadata.json`.

Odczyt wcześniejszych V/J/H: **31 kontroli PASS**, niezmienione skróty danych,
bez ponownego Solve. Raport: `accepted-vjh-after-498a36ae.json` w tym samym
katalogu kontrolnym. Przed bieżącym buildem potwierdzono 70 plików wyników,
dwa archiwa i sześć niezmiennych dowodów nieudanej próby.

Przywrócono scenę przez publiczne PUT model/scene w sesji
`session-18e1bf739fabe3b800000d06`, rewizja 1. Obiekt ma rolę `antenna`,
Universe i definicja etapu pola pozostały zachowane. Nowe archiwum użytkownika:
`/state/runs/projects/antenna-universe-authoring-restored-498a36ae-20261025.fms`,
8571 B, SHA256 `cae2d6a4c4044e07a9711ca4efa1b3a876fec4f1b93aa46d59742904a3c6166e`.
Jego cold-open zwraca identyczną scenę. Nie wykonano nowego Solve.
Kontrola UI/WebGL nadal NOT VERIFIED. Pełny wynik Universe nadal nie istnieje:
ostatnia próba zakończyła się limitem czasu surface RT0.
