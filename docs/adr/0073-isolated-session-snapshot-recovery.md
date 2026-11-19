# ADR 0073: Izolowane odzyskanie sesji przez zweryfikowaną kopię

Status: projekt implementacji, runtime NOT VERIFIED.

## Kontekst

Recovery zatrzymanego mastera nie potrafi dowieść odrębności wszystkich obcych
mountów Windows od aktywnego pliku dysku WSL. Nie wolno zastępować tego dowodu
samą konfiguracją/GUID ani zatrzymywać cudzych grup. Zwykły import FMS jest
read-only i zmienia klasyfikację sesji; nie zachowuje dwóch manual-held runów.

## Decyzja

Dodajemy jawny, odrębny kontrakt izolowanego snapshotu. Nie rozszerzamy readmisji
ani istniejących importów. Źródło pozostaje zachowane: certyfikaty, OWNER,
RunIntent, katalogi, CAS i workspace. Nowa przestrzeń tej samej grupy otrzymuje
kopię danych i własną tożsamość store/control/ledger. Historyczne identyfikatory,
receipty, requested/resolved provenance i released leases pozostają faktami
historycznymi; nowa authority wynika z przypiętego receipt-u snapshotu.

Odczyt źródła odbywa się pod istniejącym readonly WRITER.lock, bez zapisu
WRITER.owner.json. Dozwolony inventory to dokładna suma terminalnych runów i
manual-held Accepted bez start_release, aktywnych claims lub rezerwacji.
Wszystkie dane i konfiguracja są przypięte manifestem SHA-256. Kopia musi być
odrębna fizycznie, bez hardlinków, reparse/symlinków ani specjalnych plików.
Nie kopiujemy certyfikatu przyjęcia ani natywnego OWNER do nowej authority.
Workspace SQLite kopiujemy wraz z WAL w spójnym, sprawdzonym inventory,
pod wyłączną blokadą OFD zakresu lock-byte strony DB (otwarcie O_RDWR tylko
do kernellowej blokady, bez zmiany danych) i read fence locków WAL.
WAL nieposiadający jeszcze shm także wymaga wyłącznej blokady DB.
Przy mapowaniu UID wykluczającym właścicielskie otwarcie na hoście używamy
krótkiego przypiętego helpera BuildControl z rzeczywistym UID/GID właściciela
odczytanym przez Docker, bez capabilities. Root/control/registry są readonly,
a jedynym RW bindem jest sam plik workspace.db. Operator przez readonly FD
wiąże blokadę przez handshake na jednym zachowanym FD: najpierw skutecznie
trzyma OFD read lock, helper musi potwierdzić odmowę exclusive, następnie po
jawnym zwolnieniu i GO zdobywa exclusive i host musi zobaczyć konflikt.
Po potwierdzonym RELEASED host ponownie uzyskuje read lock. To odróżnia
blokadę helpera od przypadkowego obcego writera. Tożsamość pliku, helpera,
sidecars i konflikt są ponawiane bezpośrednio przed COMMIT. Obie fazy wskazują
kanoniczną ścieżkę hosta; świeży alias WSL w inspect jest wyłącznie propozycją,
uwierzytelnianą pełną kontrolą helpera i pozytywnym dowodem tego samego pliku.
Brak któregokolwiek etapu oznacza odmowę. Nie ma chmod/chown ani słabszej blokady źródła;
sprawdzenie bazy może modyfikować wyłącznie nową kopię.

Natywny walidator wyłącznie do odczytu ponownie sprawdza pełny union runów,
CAS, checkpointy i brak release przed utworzeniem nowego OWNER/startem API.
Nie uruchamiamy skryptu ani nie odtwarzamy starego requestu. Istniejący trwały
manual-start gate pozostaje wymagany. Nie ma automatycznego Solve/Compute
Fields. Nowy receipt jednoznacznie rozróżnia skopiowanie, walidację natywną,
admission oraz start; brak dowodu któregokolwiek etapu blokuje dalszy etap.

## Zakres i granice

Pierwsza implementacja obsługuje Linux-native source/destination i jawny
świadomy start jednej zatrzymanej grupy. Nie migruje innych grup ani nie
kwalifikuje aktywnego backingu VHDX. Skopiowanie plików nie jest zakończeniem
recovery. Przerwana próba pozostawia staging i oryginał do inspekcji; brak
automatycznego usuwania danych i brak powtórzenia polecenia o nieznanym wyniku.

## Weryfikacja i rollback

Regresje: niepełny union, release/claim, CAS drift, symlink/hardlink, zmiana
źródła podczas kopiowania, przerwany commit, obcy namespace/receipt, SQLite
WAL, brak walidacji przed API oraz próba starej aktywacji. Rust wyłącznie CI.
Runtime: niezmieniony oryginał, te same runy/wyniki/model, held nadal Accepted,
brak Solve/Fields oraz właściwe Quantity Source Airboxa w przeglądarce.
Rollback zachowuje nową kopię i wskazuje stary zachowany namespace; nie
uruchamia starej inkarnacji automatycznie.

## Odtworzenie bieżącego modelu

Snapshot obejmuje także runtime-control/local-live (model bieżący i historyczny
command journal) kopiowany wewnątrz control volume bez native OWNER/config.
Manifest obejmuje pełne hashe tych plików. Dla źródła, którego bieżący model
był tylko w pamięci, operator jawnie przypina restore_run_id należący do held
pins. Nowa prywatna ścieżka API odtwarza model z immutable Study/SceneDocument
i istniejącego przygotowania przed listen, zachowując logiczne session/run IDs,
requested intent i manual gate. Nie produkuje starego Failed-owner proof ani
nie rozluźnia istniejącego reattach. Metadane nowej authority mają osobny typ.
Jest to prywatny startup protocol; publiczne OpenAPI i transport UI nie zmieniają
schematu. Oryginał pozostaje niezmieniony także przy błędzie nowego API.
