# ADR 0061 — budowanie i uruchamianie developerskiego backendu w jednym kontenerze

Status: decyzja użytkownika przyjęta; implementacja i runtime **NOT VERIFIED**.
Data: 2026-10-17.

## Kontekst

Development ma być widoczny w Docker Desktop jako jedna grupa wybranego
checkoutu z usługami `frontend` oraz `backend`. Dotychczasowy launcher buduje
backend w jednorazowym kontenerze, publikuje pakiet w storage Windows, a potem
uruchamia osobny kontener runtime. Rozdziela to logi i wydłuża iteracje przez
kopiowanie dużych artefaktów. Użytkownik wymaga jednego stałego kontenera
backendu, który buduje kod i następnie uruchamia aplikację.

## Decyzja

### Aktualizacja 2026-10-22: podstawowy cykl skryptu

Decyzja użytkownika: podstawą obsługi jest uruchomienie wskazanego skryptu,
nie odtwarzanie poprzedniej sesji. Docelowe komendy to
`fullmag-container skrypt.py` oraz `just fullmag-dev-container skrypt.py`.
Stan implementacji tych komend i pełnego cyklu: **w przygotowaniu**.

DEV po terminalnym zakończeniu lub błędzie zadania zachowuje API/frontend
i cache, publikuje wynik/diagnostykę i wraca do bezczynności. Produkcja kończy
kontenery po wykonaniu, chyba że skrypt żąda trybu interaktywnego. Wyniki
i logi pozostają zapisane. Interaktywny workspace zachowuje wyniki do dalszej
pracy. Kolejne uruchomienie nie wymaga przebudowy bez zmienionych źródeł.

Recovery jest odłożone i nie jest etapem normalnego cyklu ani automatyczną
reakcją na błąd zadania. Historyczne ścieżki poniżej zachowują swoje kontrakty,
ale nie są rozszerzane w ramach tego etapu. Niepewne zakończenie workera
pozostaje jawnym stanem niedostępnego wykonania przy dostępnym API; nie jest
oznaczane jako bezczynność przez kasowanie ownera, lease lub wyników.

Jawny `recreate-volume --fresh-state` izoluje także techniczny stan wykonania,
nie tylko hostowy katalog `/state`. Po potwierdzeniu zatrzymania i usunięciu
dokładnej pary usług, pod blokadą operacji grupy, zachowuje całe poprzednie
`runtime-control` w `runtime-archives/<operation-id>` wolumenu kontrolnego.
Mapowanie archiwum do starej sesji jest zapisane poza przenoszonym drzewem.
Powstają puste `runtime-control` i `runtime-control/runtime-services`, wymagane
przez mounty Compose. Nie zmienia to starego OWNER, katalogu runu, lease ani
ledgera; niezakończone rezerwacje nie są uznawane za zwolnione. Cache pozostaje
w tej samej parze wolumenów. Niepewna aktywacja lub obcy konsument blokuje
operację. To jawny start nowej sesji, nie recovery starej ani automatyczna
reakcja na błąd zadania. Niepewny wynik archiwizacji zatrzymuje procedurę
z zachowaną blokadą; nie uruchamia automatycznego ponowienia. Stare ścieżki
`runtime-control/...` odczytuje się historycznie przez zapisane mapowanie
archiwum, nie jako dowód dotyczący nowej sesji.
Stan tej poprawki: implementacja w toku; wykonanie **NOT VERIFIED**.

Start diagnostyczny tego samego API pomija odtwarzanie accepted run,
projekcję zapisującą stan oraz publikację właściciela wykonania. Bramka HTTP
sama nie wystarcza: ograniczenie musi obejmować inicjalizację przed nasłuchem.
Nie tworzymy osobnego serwera diagnostycznego ani alternatywnego solvera.

W trybie dev dokładnie dwie stałe usługi aplikacji należą do projektu
`fullmag-master` lub `fullmag-worktree-<worktree_id>`:

- `frontend` uruchamia Next.js dev i HMR z wybranego checkoutu Windows;
- `backend` przy starcie wykonuje zweryfikowany, przyrostowy build, a następnie
  w tym samym kontenerze uruchamia API i nadzorowany native runtime.

Decyzja użytkownika z 17.10.2026: frontend DEV domyślnie uruchamia Node Inspector
na loopback wewnątrz kontenera. Nie publikuje portu debuggera na hoście i nie czeka
na podłączenie klienta przed startem aplikacji. Log wskazuje adres właściwego
procesu Next.js. Ten tryb dotyczy serwera Node.js; release pozostaje bez Inspectora.

Docker Desktop i `docker logs` pokazują pełen przebieg backendu: przygotowanie
źródeł, kompilację, publikację wyniku i uruchomienie usług. Tryb dev nie tworzy
osobnego `backend-build` i nie przenosi dużego pakietu między kontenerami przez
storage Windows. Toolchain pozostaje przypiętym obrazem Docker; jawne buildy
release i kwalifikacja CI zachowują odrębne procedury.

Źródła są montowane readonly. Kompilator pracuje na zweryfikowanym cieniu ext4
z utrwalonym cache Cargo/CMake/CUDA. Backend obejmuje FDM CPU, FDM GPU, FEM CPU
i FEM GPU; wybór realizacji pozostaje w authored intent i plannerze. Wymuszone
GPU nie ma fallbacku CPU. Zmiana mechaniki budowania nie poszerza kwalifikacji
fizyki ani wspieranych kombinacji modelu.

Każdy start backendu, także zwykły restart w Docker Desktop, samodzielnie sprawdza
aktualne zamontowane źródła i zależności, przygotowuje spójne wejście kompilacji
i korzysta z trwałego cache. Bez zmian uruchamia istniejący wynik; po zmianach
przebudowuje tylko to, co wymaga kompilator. Nie ma dodatkowej czynności użytkownika
odświeżającej manifest na hoście. Manifest i provenance powstają wewnątrz kontenera
z rzeczywistego wejścia danego buildu. Edycja podczas kompilacji nie miesza wersji.

Przed restartem użytkownik zapisuje projekt i kończy aktywną symulację. Zatrzymanie
backendu zachowuje potwierdzony native drain. Przy zgodnym obrazie i mountach
restart używa tego samego container ID, a frontend pozostaje uruchomiony. Zmiana
obrazu lub mountów może wymagać odtworzenia usługi. Nie wolno zastępować kontenera
na podstawie timeoutu ani uznawać utraty obserwacji za potwierdzenie zatrzymania.
Niepotwierdzony owner wymaga kanonicznego recovery przy ponownym użyciu jego
store. Świeży start tworzy osobny namespace; zachowuje dawny store i nie resetuje
jego ownera. Nadal wymaga kanonicznej walidacji wspólnego ledgeru i release proofs.

### Fizyczne miejsce cache DEV

Odczyt działającego backendu wykazał, że dotychczasowy profil cache v1 używa
ext4 na loop device, którego plik backing znajduje się na Windows przez 9p.
Sam typ ext4 nie usuwa więc kosztu tego transportu. Dla nowego trybu DEV
przyjmujemy profil `backend-build-cache-v2` z dwiema jawnymi, prywatnymi
named volumes sterownika Docker `local`, bez driver options mapujących hosta:
`/build` oraz `/opt/fullmag/package`. Inicjalizacja wyłącza automatyczne
kopiowanie zawartości obrazu (`nocopy`). Nie tworzy dodatkowego buildera;
kompilacja i API pozostają w stałej usłudze `backend`.

Para jest jedną jednostką cache, z identycznym kluczem i owner tokenem.
Klucz zależy od checkoutu, profilu i toolchaina; UUID runu, snapshot edytowanych
źródeł i sama zmiana wrappera runtime nie tworzą nowego Cargo/CMake cache.
Etykiety wolumenów, markery i receipt w control named volume wiążą jednostkę
z Docker Engine, grupą oraz tożsamością toolchaina. Host sprawdza rzeczywiste
wolumeny i mounty; nazwa lub prefix nie stanowią dowodu własności. Historyczny
hostowy receipt v1 jest tylko baseline'em migracji i nie jest autorytetem dla
bieżącej ścieżki v2.
Obcy volume, niezgodna para albo niepotwierdzony konsument blokują użycie.
Kontener aplikacji nie otrzymuje Docker socketa ani uprawnień do zarządzania
wolumenami. Ograniczone narzędzie inicjalizacji działa w tej samej grupie.

Zmiana dotyczy wyłącznie pochodnych danych buildu i pakietu. Nie zmienia
profili session storage Windows, `/user-data`, wspólnego host ledgeru ani
kontraktów Python/ProblemIR, solverów i API. Adapter v1 pozostaje do obsługi
istniejących zasobów i rollbacku; nie przełączamy profilu działającego backendu.
Nie kopiujemy ani nie usuwamy starego cache automatycznie. Nowy start z v2
wymaga wolnego miejsca, braku aktywnego właściciela grupy oraz istniejących
bramek recovery, provenance i storage. Niedostatek miejsca blokuje tę operację,
bez fallbacku na 9p i bez kasowania Cargo target.

Wdrożenie v2 jest **w toku, runtime NOT VERIFIED**. Adapter, Compose i launcher
przechodzą kontrakty źródłowe; przygotowanie pary oraz migracja markerów mają
dowód rzeczywistego wykonania. Pozostają runtime preflight, administracyjne
recovery i restart wrappera w pełnym cyklu aplikacji. Odbiór obejmuje
rzeczywisty typ i tożsamość mountów, cold build, restart bez zmian, przyrostową
edycję modułu, izolację grup i zachowanie danych Windows. Stary cache może
zostać wycofany dopiero po osobnej kontroli użycia, referencji i rollbacku.

Kompilację chroni blokada per trwały cache wewnątrz backendu, także bez launchera
na hoście. Odrębne grupy z własnymi cache mogą budować równolegle; nie współdzielą
mutowalnych katalogów Cargo/CMake. Hostowy heavy-build lease obejmuje przygotowanie
obrazu, toolchaina, cache i start receipt w control volume, a kończy się przed
uruchomieniem usług; nie tworzy hostowego receipt buildu.
Nie traktujemy Win32 lock i Linux flock na bindzie Windows jako wspólnej blokady.
Wspólny host ledger nadal chroni przydział fizycznych CPU/GPU podczas symulacji.

Budowanie odbywa się przed startem API; nie podmienia plików wykonywanych przez
aktywną symulację. Nieudany build zachowuje logi i receipt, pozostawia backend
niegotowy i nie uruchamia API z częściowo opublikowanym pakietem. Zachowujemy
ostatni zweryfikowany pakiet, cache i dowody; brak automatycznego resetu stanu.

Sesje i wyniki nadal leżą w fizycznym storage Windows. Ustawienia i historia
pozostają w osobnej bazie grupy. Backend nie publikuje portu hosta; frontend
łączy się z `backend:8081` przez prywatną sieć grupy i udostępnia jeden wybrany
port loopback. Home może działać podczas budowania lub niedostępności API.

Opcjonalny plik `.py` pozostaje wejściem startowym tego samego launchera:
publikuje aktywny model i zachowuje automatyczne Solve albo trwałe oczekiwanie
`wait_for_solve`. Restart backendu nie jest nowym, niejawnym poleceniem Solve.

Dostępność API/native runtime i wynik opcjonalnej aktywacji skryptu są odrębne.
Po atestacji i trwałym markerze `started`, konflikt HTTP `409`, błąd serwera lub
utrata transportu pozostawiają wynik `unknown` i blokują ponowienie POST/Solve.
Nadzorca zachowuje działające API i native ownera, publikując osobną diagnostykę.
Launcher nie uznaje takiej aktywacji za udaną kwalifikację. Błędy integralności,
provenance, polityki i kontraktu odpowiedzi pozostają fatalne. Zmiana nie
poszerza listy znanych odrzuceń fizyki i nie resetuje ownera ani historii.

## Rozszerzenie 20.10.2026 — gotowy, nieopublikowany staging

Po awarii pomiędzy ukończeniem Make a rotacją może pozostać pełny kandydat
`ready`. Make z kodem 0 nie uprawnia do uruchomienia go ani do usunięcia jego
payloadu. Backend pod blokadą cache weryfikuje marker, kompletny pakiet,
inventory, terminalny receipt Make i log oraz brak journalu rotacji. Bieżący
pakiet i jego provenance muszą być zgodne; kandydat nie może być pakietem
wskazanym przez aktywną publikację. Nieznane i niekompletne stany pozostają
zachowane i blokują start.

Przed kolejnym capture zachowujemy dokładny oryginalny manifest źródeł:
capture zapisuje następny manifest pod tą samą ścieżką. Niezmienny zapis
przygotowania w technicznym control volume nie autoryzuje usuwania. Dopiero
porównanie ze świeżymi źródłami, toolchainem i profilem pozwala sklasyfikować
kandydata. Pasujący pakiet może przejść przez istniejącą journalowaną rotację;
nie powstaje drugi mechanizm publikacji. Pakiet niepasujący albo dokładny
duplikat wymaga osobnej transakcji retirementu.

Namespace `backend/candidate-retirements` w control volume ma własny,
ograniczony schemat (64 archiwa, 64 MiB łącznie). Wyczerpanie limitu
zatrzymuje nowy retirement przed alokacją; nie uruchamia ogólnego GC.
Przed usunięciem zbędnego payloadu zapisuje i odczytuje
kontrolnie receipt, marker, pełne inventory, manifesty, provenance i logi.
Trwały intent wiąże dokładny cel i decyzję ze źródłami; sam katalog archiwum,
data ani rozmiar nie są dowodem zbędności. Po przerwaniu usuwania wznowienie
sprawdza niezmienne archiwum i każdy pozostały plik. Obcy plik lub rozbieżność
zatrzymują cleanup. Marker znika na końcu. Bieżący pakiet, rollback, cache,
sesje, wyniki oraz owner/lease/rezerwacje pozostają poza tą operacją.

Ukończona promocja zamyka przygotowanie jako `historical`. Po przerwaniu
tego kroku recovery potwierdza dokładny current receipt, provenance i brak
journalu, zanim domknie sam zapis historii. Przygotowanie archiwum używa
osobnego namespace `backend/candidate-retirement-staging`, ograniczonego
do 4 wpisów i 64 MiB. Przerwany staging pozostaje zachowany i liczony
do limitu; nie jest odczytywany jako finalne archiwum. Budżet danych
sprawdzamy przed kopiowaniem plików i generowaniem JSON.

Brak automatycznego GC historii jest zamierzony: wyczerpanie budżetu blokuje
nowy retirement, a zwykły start zweryfikowanego pakietu nie tworzy kolejnych
archiwów. Archiwum dowodów nie zawiera ponownej kopii binariów.

To rozszerzenie opisuje kontrakt implementowanej ścieżki. Weryfikacja
rzeczywistego odzyskania, ograniczeń zapisu i odporności na przerwanie
pozostaje **NOT VERIFIED** do uzyskania konkretnych receiptów.

## Rozszerzenie 18.10.2026 — wszystkie dane builda w Dockerze

Użytkownik przyjął docelową granicę: zależności, cache, cień źródeł, pakiety,
staging, wygenerowane konteksty, provenance, logi i receipty budowania mają być
w named volumes Dockera lub magazynie BuildKit/obrazów. Hostowe `storage`
pozostaje miejscem sesji, wyników, projektów i ustawień. Źródła są nadal
readonly bindem wybranego checkoutu. Nie zmieniamy ledgeru runtime ani reguł
rezerwacji GPU z powodu przeniesienia danych kompilacji.

Bieżąca ścieżka source-contract v2 rozdziela techniczne namespace'y: `/build`
przechowuje cień źródeł i cache kompilatorów, control volume przechowuje
operacje, manifesty, receipty i provenance, package volume przechowuje
candidate/current/rollback oraz rotację, a BuildKit przechowuje warstwy obrazów.
Hostowe `storage` nie jest miejscem tych danych. Mały run root na hoście może
pozostać operacyjnym handoffem sesji; nie stanowi hostowego build stagingu.

Opis hostowego receipt/context, writable provenance bind oraz frontendowego ext4
backingu/logu dotyczy historycznego baseline'u v1/legacy, a nie aktywnej trasy
v2. Te profile zachowują własne recepty i nie mogą być używane jako fallback
daily DEV. Źródłowe kontrakty v2 i migracja markerów mają częściowy dowód,
ale pełny Docker runtime — cold build, start, restart, HMR, brak hostowego
zapisu technicznego i retencja po kolejnych buildach — pozostaje **NOT VERIFIED**.

Named volumes nie nakładają automatycznej quota. Odbiór wymaga pomiarów
fizycznego dysku hosta, systemu plików VM i danych wolumenów oraz dowodów
retencji po kolejnych buildach. Stare cache i staging pozostają do osobnego
przeglądu użycia; sama decyzja nie autoryzuje ich usunięcia.

Procedura i audyt częściowy:
[fullmag-docker-build](../../.agents/skills/fullmag-docker-build/SKILL.md).
Skill opisuje kontrakt i wykrywanie niezgodności, nie stanowi dowodu migracji.

## Terminalna awaria przed startem workera

Kontrolowany operator `fullmag-runtime-service --cancel-failed-no-spawn`
rozszerza istniejący protokół `WorkerNoSpawn` o przypadek terminalnego ownera
`Failed` z niewykorzystaną rezerwacją solvera. Nie zmienia wyboru CPU/GPU,
publicznego API ani formatu snapshotów. Pod blokadami startup, launch i istniejącego ownera wymaga
przypiętych digestów konfiguracji, ownera, claimu, lease i rezerwacji, terminalnych
procesów potomnych oraz dowodu niewykorzystania bramki startu workera.

Publikuje wyłącznie kanoniczne Stop/Cancelled i release proof. Zachowuje store,
logi, aktywację skryptu i historię rezerwacji; nie uruchamia ponownie symulacji.
Odtwarzanie po częściowym zapisie korzysta z immutable genesis/journal oraz
wyłącznie dozwolonych monotonicznych przejść tej samej rezerwacji. `Consumed`,
`Unknown`, obca tożsamość i inne aktywne rezerwacje blokują operację. Nie wolno
zastępować jej ręcznym resetem ani usunięciem rekordów.

Implementacja: `crates/fullmag-api/src/runtime_service_main.rs`; regresje tej
binarki uruchamia istniejący job CI. Kwalifikacja runtime wymaga rzeczywistego
`WorkerNoSpawn` i potwierdzenia zwolnienia obu lease; do tego czasu pozostaje
**NOT VERIFIED**. Instrukcja operatora znajduje się w przewodniku architektury
Docker dev. Nie zmienia to standardowego restartu zdrowego backendu.

## Retencja technicznych pakietów dev

Decyzja użytkownika z 17.10.2026 rozszerza publikację dev o automatyczne
usuwanie zastąpionych, zweryfikowanych pakietów. Zachowujemy bieżący pakiet
i bezpośredni rollback. O kwalifikacji decydują receipty i łańcuch poprawnie
zakończonych rotacji, nie czas utworzenia ani nazwa katalogu.

Operacja pozostaje w tym samym backendzie i pod blokadą trwałego cache.
Nowy pakiet musi być trwale opublikowany i zweryfikowany przed usunięciem
starszych kopii. Najpierw utrwalamy logi, receipty, metadane rotacji i raport
sprzątania. Nieznane, niespójne lub używane dane są zachowywane z diagnostyką.
Błąd sprzątania nie cofa poprawnej publikacji ani nie usuwa ostatniego rollbacku.

Zakres nie obejmuje mutowalnego cache kompilacji, źródeł, danych użytkownika,
sesji, wyników, ustawień ani historii rezerwacji. Nie zmienia formatu API,
semantyki solverów i reguł aktywacji skryptu. Implementacja dotyczy
`docker/all-in-one/backend_dev.py`, regresji publikacji i tego przewodnika.
Wymaga dowodu retain-current/rollback, ochrony nieudanej publikacji,
zachowania nieznanych danych oraz rzeczywistego odzyskania miejsca w kontenerze.
Do wykonania tych bramek automatyczna ścieżka pozostaje **NOT VERIFIED**.

### Korekta 20.10.2026 — retencja poza startem API

Synchroniczna walidacja wszystkich historycznych rollbacków nie jest warunkiem
uruchomienia opublikowanego pakietu. Zaobserwowany start `fullmag-master`
ukończył Make i publikację, lecz pozostał w hashowaniu 14 kopii przed `_serve`.
Ścieżka `start` zachowuje teraz wszystkie kopie i raportuje
`phase=retention state=deferred reason=outside-startup backups=retained`.
Obowiązkowe sprawdzenie aktualnego pakietu w `_serve`, rotacja, provenance,
admission storage oraz reguły właściciela i ponownego Solve pozostają wymagane.

Automatyczne usuwanie starszych pakietów podczas startu jest odroczone.
Samo istnienie funkcji retencji nie oznacza wdrożonej osobnej operacji
konserwacyjnej. Nie dodajemy procesu w tle ani nowego mechanizmu anulowania.
Nie zwolniono miejsca; aktualny pakiet, rollbacki, cache i dane sesji pozostają
zachowane. Zmiana wymaga nowego obrazu przez właściwy launcher; nie zmienia
działającego procesu i przed takim uruchomieniem pozostaje **NOT VERIFIED**.

### Budżet zasobów aktywnego startu — 20.10.2026

Na jawne polecenie zwiększenia limitów backend może otrzymać większy budżet
RAM i CPU bez odtwarzania kontenera. Operacja korzysta z aktywnej blokady
development i własnego podległego mutexu; nie przejmuje ani nie zwalnia
globalnego ownera. Sprawdza dokładny kontener, obraz, źródła i inkarnację,
a krótkie zatrzymanie przypiętego procesu startowego zapobiega wyścigowi
z delegacją cgroup. Request tej bramki dla bieżącego procesu wyklucza zmianę.

Dozwolone są wyłącznie zwiększenia ograniczonych limitów przed API, z zachowaniem
dotychczasowego zapasu swapu. Nieznany wynik nie jest automatycznie ponawiany;
zachowywany jest osobny intent i receipt. Profil kolejnych startów jest związany
z surowym hashem receipt, control namespace i bazowymi limitami Compose.
Nie zmienia to requested/resolved execution, prawa do Compute, grantów ani
reguł odzyskiwania sesji. Większy limit kontenera nie stanowi rezerwacji zasobów
dla solvera. Szczegóły: przewodnik Docker volume development, sekcja budżetu.

## Admission storage Windows po przebudowie dev

ADR 0059 pozostaje kontraktem filesystemu, ownera i grantów. Dla live dev host
wydaje dodatkową, opcjonalną delegację `development_build` w readonly certyfikacie:
`fullmag.windows-folder-development-build.v1`, `cargo_profile=backend-dev`,
przypięty `toolchain_image_id`, `group_identity`, kanoniczne `package_root` oraz
`provenance_path`, a także `source_identity` pierwszego zweryfikowanego buildu.
To pole jest zakresem autoryzacji zaufanego buildera tego samego obrazu i grupy;
nie jest drugim pinem blokującym przyszłe zmiany kodu. Bez delegacji zachowujemy
dokładne przypięcie źródeł i binariów z dotychczasowej ścieżki release/static.

Każda nowa binarka nadal sprawdza bieżący compiled commit i własny hash, dane
rzeczywistego receipt/provenance, jego digest, profil i toolchain. Walidacja
nowego pakietu nie może zostać zastąpiona flagą środowiskową. Hostowy certyfikat
nie traci powiązania z image, engine, ownerem, lokalnym NTFS/ReFS, no-reparse,
operacyjnymi próbami storage i readback. Runtime weryfikuje aktualny mount grant.

Pierwszy start ma kolejność: build i receipt → hostowy certyfikat → niezależne
próby storage i readback → `restart_verified` → start API/native runtime.
Backend czeka na tę granicę z ograniczonym czasem, zachowując logi po błędzie.
Host aktualizuje pojedynczy bind certyfikatu in-place z flush/readback, ponieważ
podmiana nazwy pliku nie aktualizuje pewnie istniejącego bind mountu. Przejściowa
różnica samego `restart_verified` między certyfikatem i markerem jest stanem
oczekiwania; inna tożsamość ownera lub obrazu pozostaje błędem.

Kolejny zwykły restart używa tej samej delegacji storage, ale sprawdza nowy
rzeczywisty pakiet i ponawia guest storage preflight. Nie wymaga hostowego
odświeżania certyfikatu dla każdej zmiany kodu. Cofnięcie delegacji wymaga
potwierdzonego zatrzymania i jawnego wdrożenia zgodnego pakietu z dokładnym
certyfikatem; zachowuje sesje, wyniki i dotychczasowe dowody.

## Faza przygotowania startupu poza blokadą sesji

Aktywacja pliku `.py` rozdziela przygotowanie sceny od trwałego przyjęcia runu.
Eksport sceny, kompilacja planu oraz materializacja geometrii/Gmsh działają poza
`current_live_session_transition`. W tym czasie read model publikuje tymczasowego
właściciela `activating`, więc status i bieżący run nie czekają na Gmsh.

Przygotowanie nie publikuje żadnego accepted durable state: anulowanie żądania
albo zmiana sesji nie może zapisać RunIntent, CAS ani katalogu runu. Samo
przygotowanie może jednak wygenerować ograniczone pliki siatki, cache lub stagingu
w workspace; są one artefaktami przygotowania, a nie zaakceptowanym wykonaniem,
i podlegają istniejącej retencji. Tymczasowy snapshot źródła jest usuwany przez
RAII. Po zakończeniu backend ponownie przejmuje blokadę i sprawdza dokładną sesję,
placeholder run, epoch, revision oraz serializowaną treść SceneDocument. Dopiero
po tej bramce, z write guardem `current_live_state` już przejętym, wykonuje
synchronizowany, ograniczony commit RunIntent/katalogu i natychmiast przypisuje
wcześniej zweryfikowany snapshot zawierający run, startup metadata i step IDs.
Dopiero potem może nastąpić await publikacji realtime. Niezgodność sceny kończy
starą aktywację bez oznaczania nowej sceny jako uszkodzonej.

To rozdzielenie jest wymagane dla responsywnego Control Room; samo przeniesienie
`drop(transition)` za funkcję, która już zapisuje RunIntent, jest błędem, ponieważ
anulowany `spawn_blocking` mógłby dokończyć zapis po zwolnieniu blokady. Regresja
powinna sprawdzać zmianę revision, zmianę treści przy tej samej revision oraz
brak trwałego zapisu przed ponowną bramką kontekstu. Pełne sprawdzenie wymaga
CI/backend runtime z rzeczywistą materializacją Gmsh; patch źródłowy nie jest
dowodem kwalifikacji GPU ani kompletnego startu aplikacji.

### Prywatne operacje backendu DEV

Backend DEV generuje przy każdym starcie API losowy token operatora w swoim
namespace control volume: `backend/operator-capability/token`. Katalog ma
uprawnienia `0700`, plik `0600`; producent i czytnik odrzucają dowiązania,
niezgodnego właściciela i nieprawidłowy format. Token otrzymuje wyłącznie
środowisko procesu API. Nie trafia do frontendu, hostowego `.env`, argumentów,
logów ani receiptów. Profile frozen/release zachowują dotychczasowe zachowanie.

To przygotowanie mechanizmu autoryzacji dla zarządzanych operacji lokalnych,
a nie dowód wdrożenia zmiany aktywnej symulacji. Token nie zastępuje kontroli
konkretnej grupy, runu, receiptów i zakończenia pracy; nie izoluje też procesów
uruchomionych z tym samym UID wewnątrz zaufanego backendu.

## Wdrożenie i weryfikacja

1. Dodać typowane `build-then-serve` w `backend_dev.py`: istniejący lock, Make,
   hash artefaktów, receipt i walidowany handoff do `entrypoint.py`.
2. Przenieść cache, manifest i wejścia Git do stałej usługi `backend`;
   zachować hardening, osobne sieci, frontend HMR oraz storage Windows.
3. Usunąć jednorazowy build z developerskiego `up`; dodać kontrolowany restart
   ze sprawdzeniem aktualnych źródeł wewnątrz kontenera i zachowaniem container ID,
   gdy konfiguracja zgodna; zwykły restart Docker Desktop nie wymaga host-refresh.
   Uaktualnić README, AGENTS i przewodnik; rozdzielić opis dev od release.
4. Wykonać adekwatne regresje Pythona i rzeczywisty start dwóch usług. Sprawdzić
   log kompilacji w `backend`, API/UI, ponowne użycie cache po restarcie, trwałe
   dane oraz start pliku `.py`. Dowód wykonania GPU pozostaje osobną bramką.

Nie kompilujemy lokalnie testów Rust w czasie obowiązywania zakazu użytkownika.
Udany build nie zastępuje dowodu browser/runtime ani wymaganych kontroli PR.
Wycofanie wymaga potwierdzonego zatrzymania własnej grupy i jawnego wskazania
zachowanego, zweryfikowanego pakietu; nie kasuje cache, sesji ani wyników.

## Odzyskanie przerwanej aktywacji i modelu accepted

Doprecyzowanie 20.10.2026: zatrzymanie kontenerów nie dowodzi wyniku
wcześniejszej aktywacji skryptu. Zachowany marker `started` i niepotwierdzony
wynik nie pozwalają ponownie wysłać skryptu ani Solve. Operacyjne zwolnienie
blokady kontrolera oraz odtworzenie aktywnego modelu są odrębnymi czynnościami;
żadna nie oznacza zakończenia symulacji ani zwolnienia rezerwacji sprzętu.

Zarządzane odzyskanie kontrolera wymaga dokładnej tożsamości grupy, źródeł,
kontenera i jego zatrzymanej inkarnacji oraz trwałych dowodów native drain.
Nieobecność wcześniejszego helpera musi być potwierdzona w Dockerze.
Pod blokadą operacji porównujemy niezmienione wejścia i dowody, zachowujemy
pierwotny receipt oraz historię, zapisujemy trwałe oznaczenie nierozstrzygniętej
aktywacji i dopiero wtedy kończymy techniczną operację kontrolera. Przerwanie
w dowolnym miejscu wymaga idempotentnego dokończenia z tych samych dowodów.
Nowa aktywacja pozostaje blokowana do kanonicznego rozstrzygnięcia poprzedniej.

API może przed rozpoczęciem nasłuchu jawnie odtworzyć istniejący, nadal
zablokowany run `accepted`. Prywatne wejście zawiera identyfikatory tego runu,
projektu i pierwotnego żądania, hashe skryptu i autoryzacji oraz przypięty dowód
odzyskania. API sprawdza również rzeczywiste receipty, nie tylko poprawny format
hashy. Model, niezmienny snapshot, przygotowanie i frontier pochodzą z kanonicznego
store; obowiązują te same reguły gotowości co w schedulerze. Zachowujemy
logiczny identyfikator sesji i jej epokę, a nowy proces API otrzymuje nową
identyfikację procesu. Nie uruchamiamy ponownie Pythona, przygotowania ani Solve
i nie tworzymy nowego RunIntent.

PID 1 przed odzyskaniem ownera i uruchomieniem API porównuje bieżące terminalne
rekordy z niezmiennymi kopiami ich surowych bajtów w katalogu dowodu.
Późniejsza legalna rotacja plików ownera i procesu nie unieważnia tych kopii;
Rust niezależnie sprawdza ich hashe oraz zgodność z journalem zatrzymania.

Każde udane odtworzenie publikuje prywatne, niezmienne potwierdzenie natywnego
API (`restore-ack-<api_instance_id>.json`). Potwierdzenie wiąże pierwotne
żądanie, dowód, run, projekt, konfigurację, logiczną sesję i nową instancję API.
PID 1 zapisuje ten sam identyfikator i hash w receipcie procesu. Dopiero po
uwierzytelnionym zamknięciu natywnego ownera archiwizuje surowe rekordy ready
ownera, terminalnego ownera i procesu, a następnie publikuje przypięty do nich
rekord `successor-drain-<api_instance_id>.json`.

Kolejny restart sprawdza te bajty i łańcuch potwierdzeń zamiast ponownie
porównywać nowego ownera z historycznym ownerem pierwszej awarii. Wejście
`successor_auto` nie wybiera wyniku: kod natywny odczytuje aktualny katalog
runu, zgodę startu i lease. Odtwarza nadal zablokowany model albo terminalny
model bez ponownego Solve. Kolejne restarty nadal oczekującego modelu są
legalne. Brak potwierdzonego drain lub niezgodny rekord zatrzymuje odzyskanie.
Te prywatne potwierdzenia nie zwalniają rezerwacji hosta i nie zastępują
kanonicznych dowodów ledgera ani rozstrzygnięcia nieznanej aktywacji.

PID 1 odczytuje ograniczone, przypięte wejście z wolumenu runtime-control.
Tożsamość docelowego buildu pochodzi z opublikowanego w kontenerze provenance:
pełnego commita i hasha snapshotu źródeł. Rust porównuje je z tożsamością
wkompilowaną w bieżące binarium. To odtworzenie nie korzysta z dawnego watchera
Windows. Wejście jest przekazane przez prywatny deskryptor stdin z EOF;
nie tworzy hostowego pakietu, nie publikuje endpointu odzyskiwania i nie wymaga
udostępnienia Docker socketa aplikacji.

Status: kontrakt wdrażany. Testy transportu i kontrolera są dowodami odrębnych
warstw. Pełny producent i walidacja dowodów, restart, odtworzony model w UI
oraz wykonanie tego samego runu wymagają osobnej kwalifikacji runtime;
pozostają **NOT VERIFIED** do jej rzeczywistego zakończenia.

## Decyzja uzupełniająca 20.10.2026 — owner frontendu per incarnacja kontenera

Receipty właściciela procesu Next.js nie są autorytetem przechowywanym w
named volume. `frontend` otrzymuje prywatny tmpfs
`/run/fullmag/frontend-owner` o pojemności 1 MiB, z `uid=65532`, `gid=65532`,
`mode=0700`, `noexec`, `nosuid` i `nodev`. Bieżący owner receipt jest zapisywany
w tym katalogu, a healthcheck czyta wyłącznie tę ścieżkę. Po utworzeniu nowej
incarnacji kontenera tmpfs jest pusty, więc stary `unknown` z cache nie może
zablokować prawidłowego startu ani udawać żywego ownera.

`/state/development/frontend-dev-receipt.json` pozostaje trwałą kopią
diagnostyczną. Zachowuje ostatni stan, błąd, metadane wygenerowanych plików i
bramę zamrożonych zależności. Kod używa tej kopii wyłącznie jako historii przy
wyliczaniu `generated_files_gate`, `previous_failure_evidence` i potrzeby
instalacji cache; nie wywołuje na jej podstawie przejęcia procesu. W tej samej
incarnacji obecny owner receipt nadal wymaga pełnej walidacji PID, namespace,
grupy procesu i flocka. Flock pozostaje w named volume i chroni równoległe
frontendy przez cały cykl instalacji oraz Next.js.

Walidacja nowo renderowanego Compose przypina tmpfs ownera wraz z obrazem,
źródłem, labelami i mountami usługi. Opcje są normalizowane i porównywane
dokładnie; duplikaty oraz konflikty (`rw,ro`, `exec,noexec`, zmieniony `mode`,
`uid`, `gid` lub `size`) kończą się odmową. Stary zapis Compose bez tego tmpfs
może zostać odczytany wyłącznie jako wejście kontrolowanej recreacji; zwykły
resume takiej konfiguracji jest odrzucany, a nowa deklaracja zawsze zawiera
wymagany tmpfs. Zmiana dotyczy wyłącznie granicy owner frontendu; backendowy
owner, native drain, ledger i recovery pozostają bez zmian.

Implementację źródłową i testy kontraktowe przygotowano w tym fragmencie.
Budowa obrazu, start/restart usługi, Docker inspect oraz browser/runtime proof
pozostają **NOT VERIFIED**.


## Decyzja uzupełniająca 20.10.2026 — pierwsza kompletna publikacja pakietu

Pod runtime build lock wolno dokończyć pierwszą publikację jednego kompletnego
kandydata `ready`, gdy kanoniczny output nie zawiera jeszcze pakietu. Wymagane
są: dokładny owner marker, udany receipt Make związany ze ścieżką kandydata,
zgodny target Make, zgodne SHA i rozmiar kopii logu, zamknięty inventory oraz
zgodność artefaktów z receipt i hashem inventory w markerze. Przeniesienie
używa istniejącej journalowanej rotacji i fsync; receipt oraz kopie logów
pozostają zachowane. Nie wybiera się między wieloma kandydatami. Niekompletny,
nieznany lub niespójny stan nadal zatrzymuje start i zachowuje dane.

Odzyskany pakiet staje się wyłącznie poprzednim zweryfikowanym buildem. Przed
jakimkolwiek startem API obowiązuje nowy spójny capture wybranych źródeł oraz
porównanie ich z provenance pakietu, toolchainem i profilem. Różnica powoduje
zwykły przyrostowy build i zachowanie odzyskanego pakietu jako rollbacku.
Recovery nie wznawia symulacji, nie pomija native owner ani admission hosta.

Źródłowo wdrożono; wykonanie recovery i uruchomienie API pozostają
**NOT VERIFIED** do uzyskania dowodu z zarządzanej recepty. Bez testów na
wyraźne polecenie użytkownika; kontrola AST i diff nie zastępuje runtime.


## Decyzja uzupełniająca 20.10.2026 — kolejność i namespace delegacji CPU

Managed finish wykonuje niezależny guest storage preflight i publikuje host
attestation przed oczekiwaniem na worker cgroup request. Zwykły backend
przechodzi storage gate przed publikacją tego request; odwrotna kolejność
launchera powoduje cykl oczekiwania. Obie bramki pozostają obowiązkowe.

Krótki helper delegacji CPU używa host PID i host cgroup namespace. Przed
pierwszą mutacją porównuje tożsamości cgroup namespace z host PID 1, a launcher
potwierdza wynikową konfigurację Docker inspect. Backend pozostaje uid/gid
65532, bez capabilities i bez privileged, z prywatnym cgroup namespace.
Helper zapisuje wyłącznie w cgroup wskazanego pełnym container ID backendu,
z pinami image, procesu, nonce i boot ID oraz niezmiennymi zewnętrznymi
cpu.max/memory.max. Nie przejmuje istniejących poddrzew ani ich nie usuwa.

[Kernel: containment delegacji](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
wymaga osiągalności źródła i celu migracji z namespace procesu; naruszenie
zwraca ENOENT także przy widocznym pliku cgroup.procs. [Compose cgroup](https://docs.docker.com/reference/compose-file/services/#cgroup)
określa osobno host/private namespace helpera. Zmiana nie przyznaje aplikacji
dostępu do nadrzędnego quota ani hierarchii hosta. Pełna delegacja i start API
pozostają NOT VERIFIED do zakończenia zarządzanego uruchomienia; bez testów.


## Decyzja uzupełniająca 20.10.2026 — generacja enforcement po delegacji

Digest capabilities snapshotu wiąże native capabilities, mapę GPU/runtime,
widoczność GPU oraz raport egzekwowania limitów OS. Zmiana dostępności
cpu_quota po delegacji nie oznacza zmiany native ABI. Przy niezmienionej
polityce i inventory initializer może skierować taką różnicę wyłącznie do
istniejącej rotacji generacji readiness pod host writer lock. Rotacja nadal
wymaga wszystkich rezerwacji Released, braku inventory ownera oraz ponownego
porównania schema/status/source kind, capabilities, mapy GPU, GPU visibility
i inventory SHA. Inna różnica blokuje start. Publiczne porównanie pełnego
readiness pozostaje ścisłe; nie wolno podmienić generacji pod aktywnym ownerem.

Publikacja pozostaje CAS-first, potem pojedynczy dokument pointera. Marker,
polityka, node policy, rezerwacje i legacy evidence pozostają zachowane.
Stary readiness CAS pozostaje; istniejący GC snapshot/sample-order może
usunąć nieosiągalne obserwacje, dlatego recovery wymagające zachowania
poprzednich dowodów archiwizuje ich dokładne bajty przed uruchomieniem.
Nie jest to zmiana fizyki, solverów, planner capability ani publicznego API.
Nie dodaje fallbacku GPU→CPU. Implementacja źródłowa poddana review;
wykonanie rotacji oraz API/runtime pozostają NOT VERIFIED do managed resume.
Bez testów na jawne polecenie użytkownika.


## Decyzja uzupełniająca 20.10.2026 — frontier przygotowania i retencja po Stop

Wybranie początkowego frontieru przygotowania wymaga zależności i wejść
możliwych do rozwiązania oraz braku claimu zadania; nie może wymagać receiptu,
którego publikacji ta ścieżka dopiero oczekuje. Gotowość solvera pozostaje
oddzielna i nadal wymaga receiptu przed queue/claim/dispatch. Rozróżnienie
obejmuje wspólną orkiestrację FDM/FEM, bez zmiany solverów ani GPU intent.

Po nieudanej publikacji przed Compute można zakończyć dokładny accepted task
przez istniejący typowany Stop, zachowując mesh, receipty, launch/exit i released
lease. Wyjątek stale-active-session dla managed idle restart nie może wymagać
usunięcia poprawnych dowodów przygotowania. Dopuszcza wyłącznie jedno dokładnie
związane, zakończone native preparation: receipt run/task/step/input/plan/payload,
launch, exit 0 bez timeoutu, released lease i odpowiadającą released rezerwację
hosta z dowodem zwolnienia. Sekwencja końcowego heartbeat jest zgodna z released
lease i nie mniejsza niż początkowa sekwencja immutable launch. Wciąż brak task
admission, solver owner/lease, artefaktów wyjściowych i compute w kolejce.

Pierwotny unknown receipt i marker started pozostają archiwizowane; technical
lease może zwolnić wyłącznie jego uwierzytelniony helper po trwałym terminal.
Manifesty surowych SHA zachowanych preparation records i zwolnionej rezerwacji
wiążą cancellation proof i świeży preflight, powtórzony po quiesce frontendu.
Historyczny proof bez manifestu jest zgodny tylko przy pustych dowodach tego
typu. Nie jest to ponowienie starego startup request ani ręczne zwolnienie
zasobów. Nowa aktywacja jest możliwa dopiero po terminalnym anulowaniu starego
zadania i natywnym drain/restart. Bez usuwania danych, cache lub wyników.
Implementacja i wykonanie tej rozszerzonej ścieżki wymagają oddzielnych dowodów;
opis nie oznacza zakończenia recovery ani Solve. Testów nie uruchamiano.


Guard weryfikuje fingerprint PreparationPlan v2 według kolejności pól typowanych
struktur Rust (`canonical_json_bytes`), a hash canonical JSON Value stosuje tylko
do kontraktów, które go definiują. Runtime generation jest surowym SHA64. Duży
readonly probe trafia do Pythona przez stdin, aby nie przekroczyć limitu argv
Windows. Read-model current-run może pozostać po Stop w stanie stopping; wyjątek
wymaga native cancelled-before-claim, dokładnego run/session/start, braku final
results i przypięcia raw SHA tego rekordu między kolejnymi preflightami. Obecność
rekordu read-model nie zastępuje dowodu procesu ani zwolnienia lease. Publikacja
terminala nadal wymaga zgodnego, uwierzytelnionego protokołu kontrolera.

## Uzupełnienie — kolejne skrypty w tej samej instancji backendu

`docker-dev-script` po zakończonej symulacji zachowuje oba kontenery i cache.
Prywatne, uwierzytelnione API archiwizuje bieżący model dopiero po potwierdzeniu
terminalnego katalogu runu, dowodów wykonania, zakończenia przygotowania oraz
zwolnienia dokładnych lease i rezerwacji hosta. Freeze mutacji obejmuje capture,
publikację archiwum i CAS bieżącego Workspace. Błąd ponownie otwiera admission;
nie pozostawia nieodzyskiwalnego freeze. Archiwum nie upoważnia do resetu ownera,
zwolnienia zasobów ani powtórzenia Solve.

Archiwum w session store zawiera kanoniczny SceneDocument, wygenerowany
edytowalny `main.py`, typowany stan UI i odwołania do istniejących artefaktów.
Ciężkie wyniki nie są kopiowane. Publikacja jest create-only i związana z jedną
operacją. Replay wymaga zgodnego archiwum, aktualnych dowodów terminalnych i
niezmienionego bieżącego modelu wraz z katalogiem artefaktów.

Intent i receipty transportu pozostają w control volume grupy. Host zapisuje
potwierdzenie retirement przed startupowym POST. Nieznany wynik tego POST
zachowuje istniejącą kwarantannę; retirement nie daje zgody na jego ponowienie.
Prywatny token per instancja API odczytuje wyłącznie obrazowy helper backendu.
Przeglądarka, publiczne OpenAPI i solver lanes nie otrzymują nowej authority.

Zmiana dotyczy orkiestracji, nie semantyki Python/ProblemIR ani wyboru CPU/GPU.
Regresje transportu nie zastępują kwalifikacji kolejnych skryptów w Dockerze;
start, replay po restarcie i odczyt zachowanych danych pozostają **NOT VERIFIED**.

## Uzupełnienie — odtworzenie po awarii przed pierwszym startem API

Niedopuszczony bootstrap storage (`restart_verified=false`) nie daje prawa do
uruchomienia runtime. Może jednak zachować sesję i cache po błędzie samego
buildu. Zarządzane odtworzenie usług dopuszcza ten przypadek wyłącznie po
przypięciu dokładnych kontenerów, obrazu, konfiguracji, niezmienionego certyfikatu
i owner markera z wartościami bootstrap oraz jednej potwierdzonej awarii buildu
odpowiadającej bieżącemu `Docker StartedAt` backendu. Dowodem może być bezpośredni terminal wybranej próby `development` albo terminal `resume` związany z jej pinami. Bezpośredni terminal musi być kanonicznie identyczny z terminalem rodzica odczytanym przez launcher; nie wymaga pól wejściowych występujących wyłącznie w `resume`. Obecność dowodu handoff,
publikacji pakietu lub storage probe wyklucza ten wyjątek.

Selektor odczytuje wyłącznie terminale prób `resume` i `development` w readonly
control volume tej grupy, bez `latest`, z limitem liczby wpisów i bajtów oraz
odczytem względem deskryptorów katalogów bez podążania za symlinkami. Przed
`stop/rm`, pod istniejącą blokadą `recreate-services`, launcher ponawia inspect,
odczyt certyfikatu i całego dowodu. Zmiana lub niejednoznaczność blokuje operację.
Jeżeli istnieje przyjęty run, ponownie waliduje jego niezmienne archiwum i nadal
oczekujący stan przez readonly bundle producenta; nie powtarza aktywacji.

Wyjątek odtwarza usługi z tym samym storage, nie ustawia `restart_verified`, nie
resetuje ownera ani nie zwalnia zasobów. Nowy backend nadal przechodzi zwykły
build i admission przed startem API. Recovery natywnego procesu pozostaje
odrębnym uprawnieniem; pending recovery wyklucza tę ścieżkę. Kod i regresje:
`scripts/docker_volume_pre_admission_recreate.py`,
`scripts/docker_volume_pre_admission_selector.py` oraz ich testy i integracja w
`scripts/docker_volume_dev.py`. Wdrożenie do obrazu i rzeczywisty start wymagają
oddzielnego dowodu; regresje fixture nie kwalifikują runtime.


## Uzupełnienie — nieudany start API przed odtworzeniem przyjętego runu

Pierwsze odtworzenie nadal przypina dokładne bajty historycznego ownera oraz
hashe obu niezmiennych archiwów. Późniejsza awaria samego API może jednak
zastąpić bieżący process-tree, zanim zostanie przypięty native owner. Dla
legacy `fullmag.docker-process-tree.v1` dopuszczamy wyłącznie rozpoznany
terminal `shutdown_unknown`: dokładny zestaw dziewięciu pól, zakończone API
z kodem 101, kanoniczny błąd połączenia loopback i brak ownera oraz ACK.
Binding storage, bootstrap i qualification muszą pozostać niezmienione.
Historyczny READY owner i FAILED owner zachowują tożsamość; zapis awarii
native przed READY nie może zawierać retained ownera.

Ten legacy receipt nie identyfikuje samodzielnie requestu ani proofu. Nie jest
uprawnieniem recovery lub Solve: Rust niezależnie waliduje przypięty request,
niezmienny proof, katalog runu, historię i lease. Gałąź restartu po ACK nadal
wymaga uwierzytelnionego successor drain. Nie przepisujemy bieżących ani
historycznych rekordów dla uzyskania zgodności. Jest to most zgodności dla
receiptu v1; nowy typ receiptu musi wiązać awarię z requestem i proofem,
zanim zastąpi ten wyjątek. Zmiana dotyczy `runtime_service.py` i regresji
`test_fullmag_docker_runtime.py`; nie zmienia OpenAPI, fizyki ani wyboru GPU.

## Uzupełnienie 20.10.2026 — przerwane odtworzenie przed pierwszym ACK

Odtworzenie accepted run może zakończyć się przed publikacją pierwszego
`restore-ack`. Receipt procesu opisuje wtedy nowszą próbę API, podczas gdy
pierwotny proof nadal przypina poprzedni terminal. Nie wolno zastępować tych
historycznych bajtów ani traktować nieudanego startu jako potwierdzonego
odtworzenia. Zwykłe porównanie current == original i ścieżka successor z ACK
pozostają obowiązujące w dotychczasowych przypadkach.

Dopuszczamy osobny, wąski prywatny dowód pierwszej próby pre-ACK: jedno
potwierdzone zatrzymanie po nieudanym starcie API oraz co najwyżej jedną
późniejszą, zakończoną inkarnację, która odmówiła przed spawn API. Są to dwie
różne inkarnacje, każda z własnymi pinami kontenera, obrazu i operacji.
Dowód jest create-only i wiąże surowe SHA pierwotnego request/proof, niezmienionego
ownera, aktualnego terminala oraz journalu zatrzymania. Publikacja wymaga
kanonicznych dowodów braku procesów i aktywnych zasobów, świeżego stanu held run
bez Solve/claim/start_release oraz braku jakiegokolwiek ACK lub successor drain
w przypiętym katalogu. Niespójny albo nieznany stan zatrzymuje operację.

Przeniesienie wcześniejszego `native_failed_restart` jest dozwolone wyłącznie
jako ten sam pełny payload z przypiętej operacji, po ponownej walidacji jego
journalu i całego zestawu pinów. Dowód dodatkowo wiąże hash tego payloadu,
aktualną konfigurację oraz brak późniejszego API/native w osobnej inkarnacji
preflight. Zwykłe `ensure_configuration` zachowuje wszystkie kontrole; sam hash
poprzedniej konfiguracji nie stanowi nowej autoryzacji ownera.

Dla opisanej awarii API z SIGTERM (`api_exit_code=-15`) PID 1 akceptuje
różnicę current terminal wyłącznie przez ten jawnie przypięty wariant; kod Rust niezależnie weryfikuje te same surowe bajty i pełne
pierwotne backing records. Wejście nadal odtwarza ten sam model i nie autoryzuje
ponownego skryptu, przygotowania, Solve, zwolnienia lease ani zmiany ownera.
Requested/resolved execution i granice FDM/FEM CPU/GPU pozostają bez zmian.
Przeglądarka i publiczne OpenAPI nie otrzymują nowego transportu odzyskiwania.

Właścicielem zgodności jest prywatny launcher Docker DEV. Ogólne łańcuchy wielu
kolejnych porażek pre-ACK nie są częścią tego wariantu; bez osobnego kontraktu
pozostają blokowane. Wycofanie wariantu wyłącza jego wybór, zachowując oryginały,
nowy dowód i dane. Nie usuwa się historii w celu powrotu do dawnego porównania.

Status: decyzja i implementacja w toku. Wymagane są review producenta i obu
walidatorów, spójny managed build, start i odtworzenie tego samego runu oraz
oddzielny dowód braku automatycznej nowej próby. Runtime pozostaje
**NOT VERIFIED**; testów nie uruchamiamy na wyraźne polecenie użytkownika.

Integracja 20.10.2026 zachowuje oba rozróżnione przypadki. Most legacy exit101
nie wymaga nowego certyfikatu i zachowuje swój dokładny zestaw pól oraz błędy.
Gdy istnieje `pre-ack-retry.json`, walidowany jest pełny przypięty dowód, bez
fallbacku do legacy po błędzie lub nieznanym stanie. Żaden wariant nie zmienia
niezmiennych archiwów, aktualnego ownera ani uprawnień Solve.


## Rozdzielenie zasobów hosta i grupy DEV — 21.10.2026

Globalne inventory hosta nie może identyfikować fizycznego hosta przez quota
pojedynczego kontenera. Przygotowany opt-in H1 wykorzystuje istniejący,
krótki helper maintenance w host PID/cgroup namespace do publikacji faktów
root/VM: daemon, boot, CPU mask, limit root i pamięć Docker/kernel. Nie powstaje
trzecia stała usługa ani nowa droga budowania. Root cgroup v2 może nie mieć
cpu.max i memory.max; jawne null oznacza udowodniony brak tego limitu, zgodnie
z [kontraktem jądra](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

Descriptor w `/host-ledger/capacity/<sha>.json` jest przypięty bajtami SHA,
root-owned i read-only. Publikacja create-only udostępnia wyłącznie kompletny,
fsynced payload. Backend weryfikuje scope/project/daemon/boot; niepoprawny
jawny descriptor nie uruchamia fallbacku. Prywatny limit procesu jest mierzony
osobno: oferta nie przekracza minimum root/VM i procesu, a placement CPU używa
przecięcia ich masek. Logiczny istniejący host_id może pozostać docker-all-host;
physical daemon SHA pozostaje osobnym, walidowanym faktem.

Włączenie jest utrwalane w istniejącym receipt przed pierwszym renderem.
Częściowe wznowienie zachowuje zapisany tryb i przypięty descriptor. Dawne
operacje bez opt-in pozostają legacy. Zmiana boot/VM wymaga świeżego zarządzanego
renderu; nie odświeżamy po cichu boot-pinned descriptoru podczas resume.
Stary obraz/Compose nie nabywa tej funkcji przez sam zapis źródeł.

H1 jest poprawką zakresu pomiaru, nie migracją istniejącego ledgeru. H2 wymaga
jawnego, wersjonowanego przejścia z zachowaniem starej polityki, released rows,
proof CAS i jednego atomowego punktu publikacji. Przed zastosowaniem wymagane
są blokada writera i potwierdzony brak inventory ownera oraz koordynacja grup.
Zwykły start nie resetuje markera ani historii. Dokładny protokół H2 pozostaje
propozycją; nie jest implementowany ani zatwierdzany przez sam ten opis.

Zmiana nie dotyczy Python/ProblemIR, OpenAPI, fizyki ani wyboru czterech
realizacji FDM/FEM CPU/GPU. Wymuszone GPU pozostaje bez fallbacku CPU.
H1: review i kontrola składni źródeł; build/runtime **NOT VERIFIED**, bez testów.


### H2 — kontrakt wersjonowanej migracji pojemności (implementacja w toku)

Docelowy dokument v5 zachowuje bieżące reservations oraz listę maksymalnie
16 historycznych polityk. Każda pozycja wskazuje CAS dokładnych bajtów dokumentu
sprzed migracji. Pierwotny init marker pozostaje niezmieniony i kotwiczy pierwszą
politykę; publikacja jednego dokumentu v5 jest punktem zmiany generacji.
Starsze klienty odrzucają v5. Nie ma automatycznej migracji przy zwykłym up.

Migracja wymaga jawnych SHA poprzedniego markera, dokumentu i polityki oraz
świeżo zmierzonej docelowej polityki i readiness. Pod host writerem ponownie
weryfikuje piny, wszystkie proofy Released i brak aktywnego inventory ownera.
Zachowuje logiczny host_id, owner_epoch, rodzinę GPU/CPU, GPU UUID/VRAM,
node policy i wszystkie dotychczasowe wiersze. Podnosi policy revision o jeden.
Nie dopuszcza aktywnego wiersza pod historyczną polityką, zmiany GPU ani resetu.

Czytelnik v5 weryfikuje całą ograniczoną historię: kolejne rewizje, dokładne
SHA archiwów, prefiksy historii i niezmienność zachowanych Released rows.
Każdy stary wiersz i jego proof są walidowane pod właściwą dawną polityką;
nowy admission używa wyłącznie bieżącej. Historyczne snapshoty/CAS są chronione
przed istniejącym GC. Readiness nowej generacji nie dziedziczy starego snapshotu.

Wdrożenie wymaga wspólnego przełączenia konsumentów; przed zastosowaniem nadal
potrzebna jest koordynacja innych grup. Rollback przed publikacją zachowuje
stary dokument i ewentualne nieosiągalne CAS; po publikacji nie uruchamia się
starego klienta ani nie cofa rewizji. Retry po utracie obserwacji wymaga odczytu
bieżącej generacji, bez ponownego Solve. To kontrakt źródłowy; protokół i jego
zastosowanie pozostają NOT VERIFIED do zakończenia odpowiednich etapów.


Jawne wejście operatora to `--migrate-host-capacity` istniejącego launchera przy
renderze nowych usług. Receipt przechowuje intencję; backend otrzymuje wyłącznie
digest już zwalidowanego descriptoru H1 jako zakres zgody. Native initializer
sam odkrywa dokładne piny starego dokumentu/markera/polityki pod writerem,
a migrator ponownie je weryfikuje przy publikacji. Operator nie przepisuje SHA.
Bez flagi zwykły start nie migruje. Partial resume nie może dodać zgody ani
zmienić target digestu. Zgodna polityka po wcześniejszej migracji jest odczytywana
bez nowego podniesienia rewizji; ta obserwacja nie ponawia Solve.

Launcher wykonuje odczytowy preflight konsumentów przed odtworzeniem oraz przed
startem usług. Działający kontener z mountem `/host-ledger` blokuje operację;
launcher nie zatrzymuje obcej grupy. Właściwą granicą atomowej migracji nadal są
native writer, owner lock, Released proofs i compare-and-publish, a nie sam
Docker inspect. Receipt native jest przekazywany do logu backendu. Snapshot
recovery w v5 wiąże SHA historii; starsze, puste historie zachowują dawne digesty.


Przejście konfiguracji zatrzymanego backendu musi objąć zatwierdzone budżety
CPU/RAM i CPU masks, nie tylko runtime generation. Istniejący native initializer
zwraca prywatny dowód `capacity_migration` wyłącznie dla jawnego descriptor SHA:
pełne, zwalidowane historyczne polityki. Adapter Python używa tego dowodu na
stosie operacji, bez globalnego stanu ani samodzielnego parsowania ledgera.
Stara polityka musi należeć do tej historii albo być identyczna z nową; nowa
jest dokładnie tą z bieżącego native profilu. Pozostałe resource IDs/kinds,
GPU UUID, ścieżki, concurrency i timeouty muszą pozostać identyczne. Native target
nadal podlega zatwierdzonemu budżetowi i aktualnym ograniczeniom procesu.

Pozostają wcześniejsze dowody owned stop, dokładny previous-config SHA,
backup/readback, OWNER.lock i post-build continuation. Zgoda na capacity nie
zastępuje recovery ownera ani nie zezwala na replay aktywacji/Solve. Migracja
hosta nie może zmieniać storage policy; H1 nie mierzy fizycznej pojemności storage.

Przy porównaniu konfiguracji tylko cpu_millis i memory_bytes są zmienne
w budżetach ofert. storage_bytes, gpu_memory_bytes i nieznane dodatkowe pola
pozostają dokładne; nie wynikają z pomiaru CPU/RAM deskryptora H1.


## Awaria runtime z zachowaniem diagnostyki API (22.10.2026)

Decyzja operatora: błąd zadania nie zamyka API, konflikt writer-lock odracza
pracę schedulera, a utrata sprawnego runtime blokuje nowe operacje bez
odcinania diagnostyki. Nie wolno automatycznie ponawiać Solve ani restartować
symulacji. Implementacja i weryfikacja runtime tej zmiany: **w toku**.

Nadzorca przekazuje każdej nowej instancji API prywatną, unikalną ścieżkę
`FULLMAG_API_RUNTIME_FAILURE_FENCE` w wolumenie runtime-control. Po utracie
nadzoru atomowo i trwale publikuje tam etap, przyczynę oraz zalecane działanie.
Istnienie markera (również błędna zawartość lub błąd odczytu) zatrzaskuje
blokadę nowych operacji w globalnej bramce API. Blokada nie znika po usunięciu
pliku ani zakończeniu innej operacji handoff. Nie oznacza zakończenia już
przyjętych zadań ani zwolnienia ich lease'ów.

API pozostaje uruchomione dopiero po potwierdzeniu przez tę samą przypiętą
instancję stanu health `degraded`. Brak potwierdzenia zachowuje zamknięcie
admission przez zatrzymanie API; nie wolno zostawić starego binarium, które
ignoruje fence. Jawnie bezpieczne odczyty diagnostyczne pozostają dostępne.
Potwierdzenie tożsamości API nie wymaga potwierdzonego ownera schedulera.
Jeśli API zostało zweryfikowane, a późniejsze `service-ensure` zawiedzie,
nadzorca zachowuje tę tożsamość i może uzyskać ACK blokady od tego samego API.
Nie tworzy w tym celu zastępczego ownera ani nie wykonuje drain bez ownera.
Nie oznacza to jeszcze diagnostycznego startu po błędzie występującym przed
spawnem API; wydzielenie tej ścieżki pozostaje wymagane.
Odczyty ostatnich opublikowanych wyników należy dopuścić na podstawie ich
kontraktu bez uruchamiania nowego compute/materializacji. Prywatne recovery i
retirement nadal muszą respektować bramkę i własność runtime.

Publiczny model JSON health nie zmienia kształtu. `status=degraded` oznacza
żywe API z zablokowanymi operacjami. Istniejący zasób runtime-service zachowuje
maszynowy kod i opis stanu właściciela. UI ma zachować workspace i pokazać
problem oraz następne działanie, bez automatycznego restartu/replay.

Rollback wymaga zarządzanego zatrzymania/odzyskania konkretnej grupy; markerów,
receiptów ani danych runu nie usuwa się w celu obejścia blokady. Build nie jest
dowodem poprawności tego scenariusza: potrzebne są obserwacje admission,
dostępności diagnostyki, zachowania wyników i braku powtórzenia zadania.

### Recovery z zachowaniem anulowanego runu — zakres w przygotowaniu

Obserwacja z 22.10.2026 ujawniła stan, którego dotychczasowe recovery nie
obsługuje: cały backend Docker jest zatrzymany, ale accepted store zawiera
zadanie Queued po opublikowaniu start_release. Nie jest to pusty namespace
ani run nadal oczekujący na zgodę Compute. Nie rozszerzamy znaczenia istniejącego
`empty_namespace_recovered` i nie cofamy start_release.

Przygotowywana odrębna ścieżka ma zachować run, siatkę i receipty. Przed zmianą
ownera musi użyć standardowego trwałego intentu anulowania oraz projektora
unclaimed/no-spawn. Samo żądanie anulowania nie wymaga dowodu teardownu:
jest istniejącą operacją na zadaniu, blokuje nowe admission, a projektor
odmawia terminalnej projekcji przy aktywnym lease lub pasującym admission.
Nie zastępuje to osobnego dowodu teardownu wymaganego do zmiany ownera. Następnie wymaga jawnych digestów run_intent i run_catalog,
pełnej zgodności listy zachowanych runów, stanu Cancelled dla wszystkich ich
zadań, dopasowanego intentu anulowania i braku aktywnych lease oraz admission.
Dowód zakończenia dokładnego namespace Docker pozostaje osobnym wymaganiem;
metadane historycznego ownera nie są dowodem śmierci jego procesów.

W źródłach dodano natywne `--cancel-unclaimed`: przypina konfigurację, ownera,
katalog i dokładny snapshot zadania, publikuje standardowy intent anulowania
i korzysta z projektora ledgera. Odroczona projekcja jest osobnym wynikiem;
nie uprawnia do recovery ownera. Polecenie nie uruchamia solvera.

Anulowanie nie jest admission wykonania: otwiera przypięty ledger aplikacji
i polityki, ale nie wymaga zgodności historycznej generacji gotowości ze
świeżo zbudowanym pakietem. Projektor nadal blokuje terminalne anulowanie
przy aktywnym wykonaniu lub nierozstrzygniętej własności. Kontrola generacji
pozostaje obowiązkowa przy uruchamianiu obliczeń.

Natywny request recovery v2 przyjmuje `retained_cancelled_runs` i sprawdza je
pod blokadą ledgera i store. Wynik nazywa się
`retained_cancelled_runs_recovered`; request v1 nadal wymaga pustego store
i zwraca `empty_namespace_recovered`. Digesty requestu i dowodu zakończenia
namespace pozostają powiązane. Odczyt historycznego katalogu Queued nie spełnia
tego kontraktu.

Integracja hostowa musi przypiąć te dowody do autoryzacji i odpornego na
przerwanie journalu. Konsumenci Python rozróżniają oba wyniki; samo przyjęcie
schematu nie oznacza wykonanej migracji. Nie wolno podstawiać nowego requestu
pod stary dowód pustego store. Stan implementacji i wykonania: **NOT VERIFIED**
do zakończenia integracji, zarządzanego buildu i obserwacji runtime.

Hostowa komenda `cancel-unclaimed-volume` wykonuje jawne maintenance w stałej
usłudze backend wybranej grupy. Przed odtworzeniem usług zachowuje przypięte
dowody starego namespace. Nowy backend kompiluje pakiet, przechodzi zwykłe
bramki storage/cgroup/ledger i czeka na admission tej konkretnej próby. Dopiero
wtedy wykonuje natywne anulowanie, zapisuje oddzielny receipt i kończy się bez
uruchomienia API lub solvera. Odroczona albo nieznana projekcja nie jest sukcesem.
Zakończenie tego maintenance nie dowodzi recovery ownera ani gotowości API.

Wznowienie po przerwaniu hosta musi rozróżniać etap przed startem kontenera od
nieznanego wyniku natywnej mutacji. W pierwszym przypadku dopuszczalne jest
kontynuowanie tej samej przypiętej operacji po sprawdzeniu aktualnych dowodów;
w drugim należy odczytać durable intent i wynik, bez ponownego Solve.

### Recovery po usunięciu historycznego kontenera

Dla zachowanych, anulowanych runów request v2 może użyć odrębnego dowodu
`docker_namespace_absence_attestation.v1`. Historyczne piny obu usług są
wiązane z oryginalną próbą i jej identyfikatorem silnika Docker. Host sprawdza
nieobecność dokładnych pełnych ID przez `inspect` oraz `ps -a`, pod blokadą
operacji tej grupy. Manifest zachowuje źródłowe dowody, aktualny wynik
anulowania i digesty obu obserwacji. Brak kontenera nie jest przedstawiany jako
nowy odczyt `exited`, czasu zakończenia ani liczby potomków.

Ten wariant służy wyłącznie recovery ownera v2 z zachowanymi anulowanymi runami.
Nie rozszerza kontraktu worker-orphan teardown ani requestu v1. Nadal wymaga
zgodności konfiguracji, ownera, LAUNCH, ledgera, całego zbioru runów, lease'ów,
admissions i CAS. Po autoryzowanym recovery można uruchomić API; historyczne
anulowane zadanie nie jest ponawiane. Implementacja i runtime tego wariantu
pozostają **NOT VERIFIED** do zakończenia buildu i obserwacji.


### Normalny restart DEV po terminalnym zadaniu (22.10.2026)

Załadowana sesja z zakończonym zadaniem nie oznacza aktywnego solvera.
Zarządzany restart może dopuścić ją do zwykłego native drain, gdy prywatny
frontend jest wyciszony, API i runtime są dostępne, bieżący run jest terminalny,
kolejka obliczeń jest pusta, a tożsamość API/sesji/runu pozostaje zgodna w
ponownym odczycie. Dopiero poprawny drain i istniejący terminalny receipt
pozwalają ponownie uruchomić kontener. Ten preflight nie stanowi dowodu braku
procesów i nie zastępuje drain. Nie resetuje ownera, lease ani stanu zadania,
nie usuwa siatki/wyników i nie ponawia Solve. Nieznany stan oraz awaria samego
runtime pozostają poza tą ścieżką. W obserwacji 22.10.2026 zwykły drain
po failed task zakończył się poprawnie, zachowując run i siatkę. Po poprawie
błędu kompilacji zarządzane resume `5246f32a6e554de5820d4c191ffa0629`
uruchomiło API i runtime-service ready; starego Solve nie ponowiono.
Dowód dotyczy tej próby grupy fullmag-master, nie kwalifikacji wszystkich
ścieżek awarii. Szczegóły: `docs/reports/2026-10-22/runtime-recovery-simplification.md`.


### Zamknięcie nieprzygotowanej aktywacji przed Start (23.10.2026)

Potwierdzony Failed owner może pozostawić ręcznie wstrzymany RunIntent
i zakończony jako Unknown klient aktywacji. Dla tego wąskiego przypadku
`stop-diagnostic-volume --pending-activation <attempt>` dopuszcza techniczne
zamknięcie oryginalnego helpera i późniejsze `recreate-volume --fresh-state`.
Nie jest to recovery solvera ani anulowanie lub ponowienie Study.

Warunki: oryginalny klient HTTP już zakończył się Unknown i potwierdził LOGGED;
helper nadal posiada dokładny lease; API ma uwierzytelniony failure fence;
owner i oba schedulery są zakończone, workerów brak; pasujący RunIntent ma
manual start, katalog accepted/awaiting preparation i tylko intent/catalog
w swoim katalogu. Wszystkie historyczne lease i rezerwacje są released.
Ponowny odczyt przed stopem oraz pełne inventory i hashe po stopie muszą
potwierdzić brak nowego Start, claim, lease, runu lub artefaktu.

Osobny receipt `fullmag.docker-unreleased-preparation-abort.v1` zapisuje
`accepted-preparation-failed`, `execution_state=not-started` i
`restart_policy=fresh-state-only`. Oryginalny marker started i receipt Unknown,
RunIntent, dane i cache pozostają zachowane. Oryginalny helper zwalnia własny
marker dopiero po technicznym terminalu. Nie wolno na tej podstawie wznowić
starej generacji ani powtórzyć requestu. Nowy request dopuszcza dopiero
dowód archiwum runtime i terminal odtworzenia przypiętych usług.

To przejściowa obsługa błędu launchera. Właściciel: Docker DEV launcher;
warunek usunięcia: kanoniczny job aktywacji sam publikuje terminalną porażkę
przygotowania bez pozostawienia Unknown helpera. Nie zmienia Python/IR,
OpenAPI, wyboru FEM/FDM CPU/GPU ani fizyki. Rollback zachowuje stare archiwum
i blokuje jego wykonanie. Source review i parser nie zastępują wykonania
zarządzanej ścieżki; runtime pozostaje NOT VERIFIED do zapisania receiptu.


### Zachowanie przygotowanych modeli z ręcznym startem (28.10.2026)

Po nagłym zatrzymaniu runtime store może zawierać jednocześnie runy terminalne
oraz poprawnie przygotowane modele `Accepted`, które nadal oczekują na Compute.
Ich obecność nie upoważnia recovery do anulowania runu, utworzenia `start_release`,
powtórzenia skryptu ani rozpoczęcia Solve lub Compute Fields.

Osobny request `runtime_service_container_recovery_request.v4` przypina rozłączne
listy `retained_terminal_runs` (dopuszczalna pusta lista) i
`retained_held_manual_runs` (co najmniej jeden wpis). Suma musi dokładnie pokrywać
cały inventory store, łącznie najwyżej 128 runów. Held pin zawiera SHA-256
RunIntent i katalogu oraz jawne `start_release: absent`. Typed manual-start policy,
fizyczny brak release, katalog Accepted/Blocked bez compute claim/attempt,
artefaktów, cancellation intent lub aktywnych zasobów są warunkami koniecznymi.
Zakończone preparation jest dopuszczone wyłącznie z released lease i dokładnymi
receiptami zakończenia z kodem zero. Recovery sprawdza wszystkie referencje
CAS i checkpointy względem sumy obu list, zachowując checkpointy i katalogi.

Budżet agregatu odczytów v4 wynosi 1 GiB, limit pojedynczego obiektu CAS nadal
128 MiB. Operator nie może zwiększyć tych limitów. Kontrakty v1/v2/v3 oraz ich
domyślny agregat 128 MiB pozostają bez zmian. Nowy outcome
`retained_manual_held_runs_recovered` dotyczy wyłącznie odzyskania ownera do
Failed pod istniejącymi blokadami; nie terminalizuje oczekujących runów.

Host, proof abrupt-stop v2 i bridge muszą jawnie przenosić dokładnie te same
piny v4. Przed mutacją bridge sprawdza capabilities faktycznego natywnego
binarium; brak v4 blokuje operację bez fallbacku. Replay również porównuje
request i wynik. Po restarcie istniejący durable manual gate nadal wymaga
osobnego jawnego Compute. Właściciel: native runtime service i Docker DEV
launcher. Rollback zachowuje store i dowody, ale starsze binarium odmawia v4;
nie wolno zmienić requestu na starszą wersję lub pominąć modeli oczekujących.

Stan tej decyzji: implementacja źródłowa i review są oddzielone od kwalifikacji
CI i rzeczywistego recovery. Do uzyskania receiptu zarządzanego wykonania oraz
porównania zachowanych danych runtime pozostaje NOT VERIFIED.

Hostowy preflight uwzględnia także opublikowane obiekty CAS z przypiętego
katalogu artefaktów, zgodne z terminalnym task/attempt/epoch/resource i released
lease. Nie zbiera dowolnych referencji z payloadów workerów. Izolowany helper
pozostaje ograniczony do 64 MiB pamięci: CAS czyta i hashuje strumieniowo,
z kontrolą limitów, liczby bajtów i niezmienności tożsamości pliku przed/po.
