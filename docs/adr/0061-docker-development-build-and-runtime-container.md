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
