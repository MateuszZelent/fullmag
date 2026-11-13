# ADR 0081: Osobny ext4 dla danych jednej grupy DEV w WSL

Status: decyzja przyjęta 12.11.2026 dla autoryzowanej migracji SP4. Wdrożenie
etapowe; provisioning, przełączenie grupy i kwalifikacja runtime pozostają
**NOT VERIFIED** do czasu wykonania i zachowania odpowiednich dowodów.

## Kontekst

Pełne Zarr oraz ślady profilera SP4 zapełniają główny filesystem WSL. Sam nowy
obraz lub pozostawienie drugiej kopii na tym samym filesystemie nie zwolnią
miejsca. Jednocześnie zastąpienie ścieżki katalogu nie dowodzi zastąpienia
bindu widzianego przez Docker Desktop. Istniejący readmit po restarcie celowo
wymaga zachowania inode i nie kwalifikuje skopiowanego StateRoot.

## Decyzja

1. Dane użytkownika jednej grupy mogą otrzymać osobny, jawnie zarejestrowany
   ext4 w nowym dynamicznym VHDX. Lokalizację pliku obrazu wybiera operator
   według obowiązującej decyzji hostowej. Nie przejmujemy markera projektu
   katalogu nadrzędnego obrazu. Utworzenie używa wyłącznie create-new, bez
   usuwania, nadpisywania, compact lub resize istniejących obrazów.
2. Dwa datasety to dokładny katalog `user-data/<compose-project>` oraz dokładny
   StateRoot danej instancji, obejmujący sesje i dowody admission. Kanoniczne
   ścieżki i `FULLMAG_PROJECT_STORAGE_ROOT` pozostają zachowane przez bindy.
   Inne grupy, źródła, prywatne volume control/ledger, shared cache i BuildKit
   zachowują swoje dotychczasowe granice z ADR 0067 i 0076.
3. Rejestracja `fullmag.user-data-volume.v1` jest lokalna dla worktree:
   `storage/index/data-volumes/<worktree_id>.json`. Zamknięty model wiąże
   projekt, grupę, volume ID, obie postacie ścieżki backing file, FSUUID,
   mount root, oba datasety i SHA receiptu zakończonej migracji. Istniejący
   indeks worktree otrzymuje referencję `data_volume_registration` z dokładną
   ścieżką, SHA pliku i volume ID. Brak obu oznacza zwykłą grupę; obecność
   tylko jednej strony, drift albo brak mountu oznaczają odmowę.
4. Rejestracja ma stan `committed` dopiero po kwalifikacji danych, nowej
   admisji, rzeczywistych bindów i zapisu. Przed rejestracją nie wolno używać
   zaproponowanej konfiguracji jako dowodu zakończonej migracji. Po rejestracji
   launcher odmawia przed pierwszym zapisem, jeśli UUID, urządzenie lub inode
   bindów nie odpowiadają wolumenowi. Nie tworzy cichego zastępczego storage.
5. Przeniesienie wymaga zarządzanego drainu jednej dokładnej grupy, blokad
   lifecycle/writer, kontroli konsumentów i niezależnego porównania obu drzew.
   Manifest obejmuje zawartość, ścieżki, UID/GID, tryb, nanosekundowe mtime,
   xattrs/ACL i topologię twardych linków. Odrzuca symlinki, pliki specjalne,
   obce urządzenia oraz drift. Ctime i inode służą kontroli wyścigów; nie są
   przenośnymi metadanymi porównywanymi pomiędzy filesystemami.
6. Oryginalne bajty i metadane zachowujemy także w pełnym archiwum PAX na
   nowym ext4. Chroni to historię, gdy nowy runtime legalnie zmieni katalogi
   sesji, SQLite lub evidence admission. Archiwum oraz kopia robocza znajdują
   się na nowym filesystemie, poza przepełnionym WSL root. Budżet uwzględnia
   dwukrotność rozmiaru logicznego danych oraz co najmniej 25 GiB zapasu na
   następne Zarr. Brak tego miejsca blokuje kopiowanie przed utworzeniem archiwum.
7. Zmiana inode StateRoot otrzymuje osobny, przypięty successor admission.
   Zachowuje owner token, obrazy, źródła oraz oryginalne pięć plików evidence
   w archiwum. Samo przygotowanie następcy nie przyznaje namespace ani nie
   uruchamia runtime; wymagany jest nowy probe z SHA aktualnego certyfikatu
   i inode nowego rootu. Rebootowy readmit nie zostaje poszerzony.
8. Usunięcie starych duplikatów WSL wymaga autoryzacji operatora, pełnego
   porównania/archiwum, dowodu nowego runtime i Zarr oraz świeżej kontroli
   procesów, mountów, kontenerów, lease i referencji. Receipt nie uchyla tych
   bramek. Bez kwalifikacji zachowujemy obie kopie. Nigdy nie kasujemy nowego
   obrazu automatycznie w rollback ani nie dotykamy istniejących danych dysku
   docelowego.
9. Przebudowa grupy przed migracją nie zmienia zatwierdzonego planu ani
   receiptów Create/Attach. Jawny, niezmienny rekord następcy runtime może
   wskazać nową parę kontenerów na tych samych fizycznych datasetach i przy
   tych samych budżetach. Nie przyznaje prawa do drainu, kopii, admission ani
   cutover; każdy z tych etapów nadal wymaga własnych aktualnych dowodów.

## Zobowiązania implementacji

Modele i porównania należą do `fullmag_data_volume.py`,
`fullmag_data_volume_manifest.py` i `fullmag_data_volume_fs.py`. Osobny
`linux_native_data_volume_migration.py` przygotowuje następstwo admission.
Guard hosta, sterownik migracji, helper Windows i recepty launchera mają
odrębne testy. Resolver pozostaje odczytowy: nie tworzy ani nie montuje dysku.
Etapy Linux rozdzielają odczytowy `probe` i `preflight` od jednorazowego
`format-mount`. `docker_data_volume_linux.py` wiąże wybrany checkout, grupę,
dystrybucję WSL oraz SHA requestu i źródeł, utrzymując blokadę grupy podczas
formatowania. Recepty `just` przekazują wyłącznie zamknięte argv; nie uruchamiają
ogólnego `prepare-links` z innym profilem storage. Wywołanie WSL korzysta
z chronionej ścieżki System32, bez wyszukiwania programu przez PATH.

`fullmag_data_volume_runtime_binding` definiuje zamknięty rekord
`fullmag.data-volume-runtime-binding.v1` w
`migrations/data-volumes/<volume_id>/runtime-bindings/<sha256>.json`.
Producent kwalifikuje dokładne receipty stopu, odtworzenia usług i nowego
udanego startu oraz bieżące kontenery, obraz, konfigurację, źródła, admission
i niezmienione device/inode obu rootów. Wspólny uwierzytelniony stop wiąże
odtworzenie i start jako `diamond-by-common-stop`; sam ten związek nie dowodzi
bezpośredniej przyczynowości ani wyłączności pomiędzy tymi operacjami.
Rekord zachowuje SHA obecnego certyfikatu, owner markera i probe oraz wyłącznie
hash obecnego owner tokenu. Nie dowodzi jego historycznej ciągłości:
`historical_owner_continuity=not-proven`. Tę granicę zachowują także dwa
obowiązkowe pola `namespace_admitted=false` i `data_migrated=false`.

Request `fullmag.data-volume-linux-provision.v2` wybiera wyłącznie jawny,
niepusty SHA takiego rekordu. Przypina on także bajty modułu odczytującego
binding. Request v1 zachowuje dotychczasowe zachowanie i nigdy sam nie wybiera
ostatniego znalezionego rekordu. Konsumenci otrzymują oddzielnie oryginalne
bajty planu oraz pochodny widok z nowymi `runtime_pins` i obserwacjami usług;
oryginalny plan i jego SHA w journalu pozostają niezmienione. Pozostałe
historyczne obserwacje nie stają się przez to świeżymi dowodami. Etap kopii
przypina SHA requestu Linux, zachowując powiązanie z tym samym bindingiem,
i ponawia pełną obserwację zatrzymanej grupy pod żywymi guardami.

`linux_data_volume_provision.py` wymaga zgodnych receiptów Create/Attach,
inwentaryzacji sprzed Attach, tego samego bootu i trwałej przestrzeni mountów
PID 1. Wybiera dokładnie jedno nowe, puste urządzenie o zadanej pojemności;
odrzuca partycje, sygnatury, UUID istniejących filesystemów i urządzenie
oryginałów. `linux_data_volume_format.py` utrzymuje przypięty FD urządzenia,
sprawdza chronionego rodzica mountu przed `mkfs` i nie używa wymuszenia formatu.
Nie przyjmuje ścieżki `/dev` od operatora.

Terminalnie nieudana próba pozostaje zachowana. Jawne recovery wskazuje SHA
poprzedniego, nieudanego dziennika oraz nowy dziennik tej samej operacji;
przy ponowieniu Attach wykorzystuje zweryfikowany receipt Create. Stan
`started`, błąd lub nieznany wynik formatowania blokują jego powtórzenie.
Zielone testy tych etapów nie zastępują rzeczywistego Attach, formatu i mountu.
Migrator musi utrzymywać przypięte FD katalogów docelowych i wyłączną kontrolę
ich namespace; nie zakładamy ochrony przed wrogim rootem tego samego hosta.
Kontekst `docker_dev_data_volume_copy.copied_group` zachowuje hostlock również
przez kontynuację po zweryfikowanej kopii. Kończy operację Docker kopii przed
oddaniem sterowania, aby następna faza mogła uzyskać własny lease bez
zagnieżdżania operacji. Samodzielne `copy_data_volume` pozostaje etapem kopii;
nie zastępuje pełnego migratora i nie uprawnia do wznowienia grupy.

Kontynuacja `copied_group` wydaje wyłącznie żywy obiekt związany z aktualnym
ContextVar, PID i wątkiem. Jego zamknięcie albo zmiana przypiętych wejść
unieważnia kontynuację. Słownik odtworzony z pliku ani poprzednio zachowany
obiekt nie potwierdzają utrzymania hostowego flock. Importy kontynuacji muszą
korzystać z tej samej instancji modułu; oddzielne wykonanie dziecka WSL nie
otrzymuje tej zdolności.

Prymityw `fullmag_data_volume_bind.switch_roots` nie ma samodzielnego CLI.
Po świeżym porównaniu obu drzew zachowuje oryginały przez atomowe
`renameat2(RENAME_NOREPLACE)`, tworzy root-owned underlay `000` i przypina
bindy do FD zweryfikowanych kopii. Przed zmianą propagacji nowego bindu musi
potwierdzić dokładny nowy device/inode; błąd pozostawia wszystkie zasoby.
Mount zawierający każdy oryginalny parent musi być `private` przed pierwszym
rename i przy ponownej kontroli przed mutacją. Prywatność źródła nie izoluje
operacji pod `shared` parentem
([semantyka bind kernela](https://docs.kernel.org/filesystems/sharedsubtree.html)).
Prymityw nie wykonuje admission, startu ani usuwania. Przed jego podłączeniem
do rzeczywistego migratora wymagany jest trwały interlock blokujący zwykły
startup w częściowo przełączonym stanie; sam hostlock nie przetrwa zabicia
całego supervisora. To zobowiązanie integracji, nie dowód jej wykonania.

Odczytowy interlock `fullmag_data_volume_pending` rozpoznaje niezmienny marker
`index/data-volumes/<worktree_id>.pending.json`. Migrator ma go opublikować
po potwierdzonej kopii i przed pierwszym rename, poza oboma datasetami, pod
ciągłymi guardami. Marker wiąże dokładny projekt, checkout, grupę, wolumen,
oba kanoniczne rooty oraz SHA planu, requestu Linux i kopii. Domyślny launcher
odmawia przed pierwszym zapisem, także gdy brak zwykłej rejestracji. Uszkodzony,
obcy lub niepełny marker oznacza odmowę; nie uruchamia recovery automatycznie.
Końcowa pasująca rejestracja nadal musi przejść pełne guardy UUID/inode.
Marker pozostaje historycznie zachowany. Grupy bez markerów nie zmieniają
zachowania. Sam interlock pozostaje odczytowy i nie udziela wyjątku
migracyjnemu recreate. Publikację markera realizuje oddzielny etap root
opisany poniżej; jego nadrzędny sterownik nadal wymaga integracji.

Decyzja nie zmienia Python DSL, ProblemIR, fizyki, backendu realizującego krok,
OpenAPI ani zachowania UI. Migracja nie powtarza Solve. Dane wymagane do
interpretacji i wznowienia pozostają na hostowym ext4 lub w pełnym Zarr.

## Awaria i rollback

Przed cutover źródła WSL pozostają aktywne. Po częściowej zmianie bindów grupa
pozostaje zatrzymana, a journal określa dokładny osiągnięty etap. Recovery
uzgadnia istniejący własny obraz; nie formatuje go ponownie. Po nowych zapisach
na ext4 nie wracamy do starszej kopii bez zachowania i uzgodnienia tych zapisów.
Zerwanie mountu po restarcie powoduje odmowę, nigdy zapis do pustego underlay.

Inwentaryzacja migracji może osobno kwalifikować referencję zatrzymanego
kontenera do nieistniejącej już ścieżki Windows. Wymaga dokładnego stanu
`exited`, PID 0 oraz odczytowego dowodu stałego NTFS/ReFS bez reparse points
we wszystkich istniejących przodkach. Nie zmienia to ścisłego probe aktywnych
bindów ani readmission runtime. Stan kontenera i proof trzeba odświeżyć przed
przełączeniem; cache dotyczy tylko jednego snapshotu i uwzględnia stan kontenera.

Kopiowanie wymaga nowego, uwierzytelnionego stop-only receiptu. Historyczny
witness udanego startu nie dowodzi późniejszego drainu. Oprócz blokady hosta
i lease kontrolera trzeba utrzymać pięć istniejących blokad: `STARTUP-GATE`,
`LAUNCH`, `OWNER`, writer ledgera, następnie writer accepted-store. Odczytowy
snapshot zwalniający FD przed kopiowaniem nie spełnia tego warunku.

Moduły `data_volume_copy_fences.py` i `data_volume_copy_fence_service.py`
utrzymują te FD przez całą chronioną operację. Native Ready→Drained jest
uwierzytelniany kodem z przypiętego obrazu backendu. Wspólny walidator
`data_volume_released_state.py` sprawdza release proofs i obie rodziny lease;
dotychczasowy krótki snapshot i nowy dłuższy guard używają tej samej walidacji.

`docker_data_volume_copy_guard.py` wymaga zatrzymanego backendu i aktywnego
lease tej migracji. Helper techniczny ma readonly mounty i oddzielną sesję
procesu; Docker nie przekazuje do niego sygnałów klienta. Zerwanie IPC,
nieprawidłowa wiadomość albo wyjście sterownika bez potwierdzonego wyniku
kopii zachowują guardy i stan nieznanego wyniku. Dopiero jawny terminalny SHA
kopii pozwala na release. [Opcja Docker](https://docs.docker.com/reference/cli/docker/container/run/).
Te moduły nie wykonują samego transferu, drainu ani admission; ich integracja
z pełnym sterownikiem i rzeczywiste wykonanie pozostają **NOT VERIFIED**.

Etap `linux_data_volume_copy.py` wykonuje zachowującą metadane kopię dopiero po
uwierzytelnieniu pierwotnych inode, bootu WSL, receiptu formattera, UUID/dev/inode
nowego mountu i markera jego własności. Zamknięty request przypina źródła etapu,
terminalny drain grupy i obserwację pięciu guardów. Zapisana obserwacja nie
zastępuje ich żywej blokady: nadrzędny sterownik musi utrzymywać helper i lease
do potwierdzonego zakończenia procesu kopii, także po przerwaniu kanału IPC.

Etap tworzy nowe archiwum PAX oraz payload, porównuje pełny manifest i zapisuje
osobny terminalny receipt `copied-and-verified-not-switched`. Nie zmienia bindów,
admission, rejestracji ani oryginałów. Częściowe pliki zachowuje; istniejący cel,
rozpoczęta faza i błąd blokują automatyczne ponowienie. Błąd publikacji journalu
po zapisaniu wyniku jest stanem nieznanym, nie potwierdzeniem sukcesu.
Archiwizacja używa wyłącznie `/usr/bin/tar` z minimalnym środowiskiem;
odziedziczone `PATH` i `TAR_OPTIONS` nie mogą zmienić uprzywilejowanej operacji.
`docker_dev_data_volume_copy.py` wiąże etap z istniejącym stopem grupy,
blokadą hosta, lease kontrolera i żywym helperem pięciu guardów. Przed kopią
ponawia pełną obserwację zatrzymanych kontenerów i konsumentów pod guardami.
Zmiana ID, StartedAt, konfiguracji lub native stop proof powoduje odmowę.
Recepta `docker-dev-data-volume-copy` przyjmuje zamknięte argv i nie wykonuje
drainu, uruchomienia ani ponowienia Solve.

`docker_data_volume_copy_job.py` obserwuje ten sam proces WSL aż do jego
zakończenia oraz zgodnego terminalnego receiptu i journalu. Kontrolowany błąd
obserwacji, brak receiptu lub przerwanie nie wypuszczają supervisora poza
zakres hostowego flock. Pierwszy błąd jest zachowany i zgłaszany po bezpiecznym
potwierdzeniu terminalu; nie uruchamia się nowego procesu i nie zabija starego.
Jeśli potwierdzenie nie jest możliwe, supervisor i guardy pozostają zachowane
do recovery. Twarda śmierć całego supervisora wymaga osobnego uzgodnienia
zachowanych lease i native guardów; nie deklarujemy przeżycia hostowego flock
po `SIGKILL` jego właściciela.

Etap `linux_data_volume_bind` udostępnia API bez samodzielnego CLI. Przyjmuje
zamknięty request z SHA istniejącego requestu kopii, jej terminalnego wyniku,
nowej obserwacji guardów i źródeł etapu. Odczytowy widok zakończonej kopii
w `linux_data_volume_copy.load_context` wymaga dokładnego receiptu i journalu
oczekującego na `binds-switched`; zwykłe wejście kopii nadal odmawia jego
ponowienia. Wspólny walidator wyniku kopii służy także supervisorowi WSL.

Przed cutover etap sprawdza źródłowy manifest i strumieniowo SHA zachowanego
PAX oraz zajmuje istniejący writer lock skopiowanego accepted-store. Nie
tworzy zastępczego pliku blokady. Pod mutexem migracji i wymaganymi żywymi
guardami nadrzędnego sterownika publikuje niezmienny marker pending przez
create-new i fsync, przed pierwszym rename. Każdy callback prymitywu zapisuje
oddzielny trwały intent lub obserwację poza oboma datasetami. Błąd po
publikacji markera zachowuje stan wymagający jawnego recovery, w tym
wszystkie drzewa i blokadę zwykłego startupu. Etap nie wykonuje admission,
startu, rejestracji, rollback ani usuwania.

Zarządzana recepta kopiowania nadal wykonuje tylko kopię. Kontynuacja API
`docker_dev_data_volume_bind.bind_copied_group` wymaga oryginalnego żywego
zakresu hostowego. Po zamknięciu operacji Docker kopii uzyskuje osobną operację
bind, ponawia uwierzytelnienie wejść i pełny inventory zatrzymanej grupy oraz
zajmuje pięć guardów przez nowy helper. Nie zagnieżdża lease kontrolera.
Nieznany dodatkowy konsument, także pozostawiony helper poprzedniej operacji,
blokuje przejście; samo readonly i `exited` nie tworzą wyjątku.

Joby kopii i bindu przypinają literalne argv do wybranego checkoutu, grupy,
WSL i źródeł. Wspólny `docker_data_volume_root_bootstrap` dopuszcza wyłącznie
dwa zamknięte etapy `copy` i `bind`, ich schematy, listy komponentów oraz stałe
funkcje wejścia. Oba używają `/usr/bin/python3 -I -B -c`; bezpośrednie wejście
kopii przez skrypt nie jest już używane przez zarządzany job. Bootstrap ustawia
minimalne zaufane środowisko narzędzi przed kodem Fullmaga, w tym stały PATH.
Izolowany bootstrap WSL przed pierwszym importem Fullmaga
sprawdza SHA requestu i wszystkich modułów, odczytując je przez nofollow FD.
Zachowuje zweryfikowane bajty całego zamkniętego grafu i wykonuje je własnym
loaderem `compile`/`exec` z rzeczywistym `__file__`. Nie korzysta z lokalnego
`.pyc`, nie dopisuje checkoutu do `sys.path` i odmawia, jeśli przypięty moduł
był już wcześniej załadowany. Nie jest to ochrona przed wrogim rootem hosta.
Obie bramki wiążą też nagłówek journalu z wolumenem oraz SHA oryginalnego planu.
Wspólny supervisor kopii i bindu obserwuje ten sam proces
aż do rzeczywistego terminalu i zgodnego receiptu. Wcześnie zapisany plik,
timeout ani utrata obserwacji nie uprawniają do zwolnienia guardów lub replay.
Terminal bindu jest osobnym dowodem. Istniejący protokół copy-fence nadal
otrzymuje wyłącznie oryginalny zweryfikowany SHA kopii jako
`copy_result_sha256`; pole nie zmienia znaczenia na SHA bindu.

Po bindzie `relocated_copied_group` wydaje osobny żywy kontekst OLD/NEW,
oparty na dokładnym terminalu bindu, pending i oryginalnym zakresie hostlock.
Zapisany słownik ani funkcja uwierzytelniająca od wywołującego nie zastępują
rzeczywistej instancji zakresu kopii. Kontekst przypina selector, ścieżkę i
prefix journalu; dopuszcza wyłącznie poprawną kontynuację `admission-prepared`
w stanie started/succeeded. Błąd, unknown lub recovery wymagają osobnej
kwalifikacji. Każde użycie ponawia niezmienne SHA, pending, UUID, inode oraz
ochronę i FSROOT nowych mountów. Pliki certyfikatu/owner/probe przyszłego
admission nie są traktowane jako niezmienne dowody starego etapu.

Observer czyta stary store przez zachowane backupy, nadal sprawdzając
historyczne deklaracje mountów zatrzymanej pary. Inventory obejmuje backupy,
nowe ścieżki kanoniczne, payload i fizyczne aliasy określone przez maj:min oraz
FSROOT; nieudowodniona rozłączność nadal blokuje. Copy-fence może podmienić
wyłącznie readonly `/state` i `/user-data` na uwierzytelnione backupy, z
zachowaniem oryginalnych IDs oraz dokładnego backendu i obrazu. Named mounty
ledger/control pozostają bez zmian. Kontekst jest ponawiany przed startem
helpera i podczas jego obserwacji. Bootstrap helpera wykonuje zweryfikowane
bajty czterech modułów zamiast lokalnego cache `.pyc`; image-owned kod runtime
pozostaje częścią przypiętego obrazu. Guard starego store nie zastępuje
osobnego writer lock nowego store, wymaganego przez etap admission.

Prymityw `fullmag_data_volume_admission.prepare_guarded` zajmuje istniejący
NEW store writer, sprawdza jego inode, bytes i metadane/ACL oraz zapisuje pięć
oryginalnych plików admission i kandydata w `state-admission.json`. Archiwum
powstaje przez O_EXCL, jako plik 0600 w istniejącym root-owned katalogu 0700
nowego filesystemu, z fsync przed zmianą certyfikatu. Root, store, writer,
cert-file inode i canonical archive-parent pozostają przypięte do końca.
Kandydat zmienia wyłącznie device/inode i `restart_verified=False`; nie
przyznaje namespace. Istniejące archiwum blokuje replay. Błąd zachowuje
archiwum i stan częściowy dla jawnego recovery, także gdy helper zapisu
certyfikatu podjął lokalną próbę odtworzenia jego poprzednich bajtów.

Ten root-only prymityw nie ma CLI. Samo przekazanie pinów nie dowodzi lineage,
pending, OLD guardów, obu datasetów, host namespace ani środowiska narzędzi;
te kontrole należą do opisanej niżej integracji. Świeży probe oraz kwalifikacja
runtime i zapisu Zarr pozostają odrębnymi wymaganiami po przygotowaniu admission.

Źródłowe API `linux_data_volume_admission.admission_verified` wiąże zamknięty
request z dokładnymi predecessor receipts provision/drain/copy/bind, oryginalnym
planem, wybranym journalem, pending i nową obserwacją pięciu OLD guardów.
Graf źródeł obejmuje 19 modułów i nie importuje hostowych jobów Docker.
Wspólny, czysty `fullmag_data_volume_bind.validate_switch_result` służy
zarówno hostowemu walidatorowi terminalu bindu, jak i temu etapowi root.
Root API ponawia persistent boot, OLD backup IDs oraz NEW canonical
inode/UUID/ext4/private/FSROOT i weryfikuje zachowany PAX. Przed zmianą
certyfikatu oba pełne manifesty muszą odpowiadać oryginalnemu manifestowi.

Zewnętrzny NEW writer pozostaje zajęty podczas kontroli danych, przygotowania
certyfikatu i publikacji. Prymityw może przyjąć jego deskryptor jako wewnętrzny
parametr: duplikuje OFD, sprawdza canonical writer przed flock i po nim oraz
zamyka wyłącznie swój duplikat, bez LOCK_UN. Obcy deskryptor jest odrzucany
przed zmianą jego blokady. Store FD/path, writer, rooty, cert/owner, chronione
pliki admission i pending są ponawiane także wokół długiego OLD inventory oraz
po zapisie result i journalu. Późny drift zgłasza błąd i zachowuje unknown lub
ambiguous evidence; nawet zapisany success journal nie zastępuje rzeczywistego
terminalnego sukcesu procesu i braku sprzecznego failure receiptu.

Root API nie ma CLI i samo nie dowodzi istnienia żywych parent guardów.
Źródłowa kontynuacja `docker_dev_data_volume_admission.prepare_bound_group`
wymaga oryginalnego żywego `copied_group` oraz zweryfikowanego terminalu bindu.
Zachowuje hostlock, ponawia pełny inventory zatrzymanej grupy przed zajęciem
OLD guardów i pod nimi oraz otwiera osobną operację control po zakończeniu
poprzedniej. Używa przypiętego kontekstu OLD backup / NEW canonical, bez
uznawania starych canonical inode za bieżące i bez zmiany historycznych pinów.

Job admission dodaje trzeci etap do wspólnego izolowanego bootstrapu: 19
modułów ładuje z uprzednio zweryfikowanych bajtów, bez lokalnych `.pyc`, przy
wyczyszczonym środowisku. Supervisor zachowuje kontrolę tego samego procesu do
rzeczywistego terminalu. Sukces wymaga exit code 0, dokładnego result/journalu,
braku sprzecznego failure oraz ponownego porównania cert/owner i chronionych
plików NEW z obserwacją sprzed uruchomienia. Operator nie odczytuje prywatnego
archiwum root jako zastępstwa tej obserwacji. Zwolnienie guardów potwierdza
oryginalny copy receipt, a osobny receipt opisuje przygotowanie admission.

Zwrócony kontekst przygotowania jest ważny tylko w oryginalnym host scope,
procesie i wątku; zapisany lub zmieniony słownik nie zastępuje tej kontynuacji.
Parent zachowuje w nim głęboką kopię obserwacji pięciu plików native i inode
certyfikatu sprzed tego samego wywołania supervisora. Dane pozostają w RAM,
poza receiptem i prywatnym archiwum root; podlegają kontroli niezmienności
kontekstu, a zmiana zwróconej kopii nie modyfikuje obserwacji joba.
Nie daje prawa do namespace, rejestracji ani usunięcia oryginałów.

Wewnętrzny `docker_data_volume_startup_scope.startup_scope` przekazuje żywe
przygotowanie do guardów standardowego startu. Rozpoznaje rzeczywistego issuera
parenta i przed wejściem ponawia walidator jego terminalu z zachowaną obserwacją
native. Request, started, result i journal są przypięte po obu stronach tej
walidacji; failure odmawia wejścia lub dalszego użycia. Kontekst ma jedną
kanoniczną instancję modułu, jest ważny tylko w tym samym PID/wątku i sprawdza
niezmienność dowodów oraz fizyczną tożsamość obu rootów również przy udanym
wyjściu. Standardowy init może później rotować pliki native i wykonać świeżą
guest admission; guard nie zastępuje tych operacji ani nie ustawia readiness.

Opcjonalny wewnętrzny `migration_scope` w guardzie volume wymaga istniejącego
indeksu bez registration, dokładnego pending i żywego kontekstu powyżej.
Sprawdza wyłącznie wskazaną grupę oraz dokładne canonical StateRoot i user-data
root; nowy namespace lub inny root odmawia. Zwykły start nadal jest blokowany
przez pending. Marker, zapisany słownik, CLI i zmienna środowiskowa nie dają
takiego uprawnienia. Wynik kontroli pozostaje `pending-prepared-not-registered`.

Po standardowym starcie odrębny wewnętrzny `qualification_scope(started)`
może udostępnić te same dwa canonical roots istniejącej aktywacji
kwalifikacyjnej. Wymaga rzeczywiście wydanego StartedGroup z lokalnego issuera,
nadal żywego pierwotnego copy host scope, tego samego PID/wątku oraz dokładnego
layoutu i rekordu. Każdy odczyt, kontrola pending i udane wyjście ponawiają
readback StartedGroup; zmiana rekordu, utrata scope lub podmiana issuera odmawia.
Nie ponawia kandydata native sprzed init i nie otwiera ponownie initial startup
scope. Wynik to `pending-started-not-registered`: namespace admission jest już
potwierdzonym faktem, lecz `data_migrated` i `originals_retired` pozostają false.
To kontrola odczytowa pending, nie osobna autoryzacja Solve, rejestracji lub
usuwania; standardowe sprawdzenia aktywacji i jej pinów pozostają wymagane.

Captured terminal observation może przygotować prywatne proof/request pod
posiadanym lease migracji przez wewnętrzny `owned_operation`. Publikacja
korzysta z dokładnego aktywnego helpera, bez drugiego flocka i bez usuwania
`active`. Dopuszcza tylko dwa rekordy o ścieżkach wyprowadzonych z proof SHA,
identyczne istniejące bajty lub nowe pliki O_EXCL, z nofollow/CAS/fsync oraz
ponawianiem tożsamości rootu, rodziców i tokena. Timeout nie uruchamia replay.
Ten wariant obsługuje zwykły successful captured stop w rootowym control oraz
zachowanie istniejącego historycznego proof po dokładnie przypiętym nowszym
zwykłym stopie już odtworzonej sesji;
diagnostic oraz current-backend pre-owner/cold odmawiają przed helper dispatch.
Historyczny pin cold-budget musi być oddzielnie uwierzytelniony i przeniesiony
przez sterownik. Bez `owned_operation` istniejąca ścieżka publikacji nie zmienia
zachowania. Producer nie zastępuje żywych OLD fences callera ani readmission.

Ponowny zwykły stop nie przepisuje API identity w immutable RunIntent ani
oryginalnym proof. `build_stopped_proof` wybiera nowy capture wyłącznie wtedy,
gdy stop zawiera jego pin; błąd takiego capture nigdy nie przełącza się na stary
proof. Przy braku capture odczytuje wyłącznie observation przypięte w dokładnym
successful parent development, sprawdza jego private request/proof i odbudowuje
proof z autorytatywnych rekordów oraz OLD store. Osobny nowy stop SHA pozostaje
w context metadata i podlega ponownej kontroli. Zwykły stopped-group observer
nadal wymaga pełnego inventory kontenerów, braku konsumentów i native fences.

`validate_empty_stop` wiąże ten nowszy drain z tą samą zainstalowaną sesją/runem,
sceną, kolejką i hashami held intents. Sprawdza bieżące API/request epoch,
observation installation, native config, aktualny process receipt oraz zgodność
Ready/Drained właściciela z immutable Ready pinem i persisted OWNER. Nowy run,
zmiana sceny/kolejki albo owner/config drift wymaga innej jawnej ścieżki.
Zakończenie API przez supervisor może mieć kod 0 lub -15 (SIGTERM); oba nadal
wymagają kompletnego native drain. SIGKILL, błąd API i wartość bool odmawiają.
Przypięty stop i oryginalny proof nie zastępują się wzajemnie. Format proof
odczytywany przez Rust pozostaje bez zmian. Są to źródłowe kontrole kontynuacji;
nie dowodzą wykonania migracji lub nowej kwalifikacji naukowej na hoście.

Readonly `docker_data_volume_removed_group.observe_removed_group` potwierdza
brak dokładnych starych ID pod żywym lease i kontekstem relocated. Sprawdza
pełny inventory wszystkich kontenerów, również zatrzymanych, wspólną politykę
obcych konsumentów i fizycznych aliasów oraz ponawia inventory przed wynikiem.
Brak kontenera nie jest wnioskowany z błędu inspect. Observer nie usuwa niczego.

Wewnętrzne `start(capture_terminal=True)` może zwrócić receipt dokładnie tego
wywołania po zamknięciu jego nowej operacji development. Sprawdza sukces, piny
operacji i rzeczywiste bajty jej terminalu, bez odczytu wskaźnika `current`.
Nie może przejąć operacji callera; domyślne API startu pozostaje bez zmian.

Wewnętrzny `docker_dev_data_volume_restart.restart_prepared_group` łączy te
elementy w jednej żywej kontynuacji. Przed usunięciem pary uwierzytelnia dokładny
development/witness/Compose, namespace/ledger, intent GPU i resolved device,
port/UI, operator record, native contracts, allowlist i subnet. Ordinary captured
observation powstaje z OLD backup pod posiadanym lease; historyczny cold-budget
pin jest osobno uwierzytelniony. Dla tej gałęzi `previous_config_sha256` pozostaje
domyślnie None; Compose SHA nie jest zastępstwem native config ani observation.

Osobna operacja migracji ponawia pełny stopped inventory i metadata pod OLD
fences, zapisuje intencję O_EXCL, usuwa wyłącznie dwa przypięte pełne ID bez
force, wymaga terminalnego sukcesu polecenia oraz potwierdzonego braku usług.
Guard potwierdza oryginalny copy SHA. Dopiero po rzeczywistym zamknięciu tej
operacji następuje standardowy start zachowanego state z `script=None`, świeżą
guest admission i exact terminal capture. Weryfikacja po starcie porównuje cały
retained intent, nową parę usług, rzeczywiste raw receipts i Compose oraz NEW
cert/owner, ownerToken, root identity i zachowany inode certyfikatu.

StartedGroup jest wydawany dopiero po udanym wyjściu z pending startup scope
i kolejnym readbacku. Błąd, również późny, zachowuje częściowe rekordy i zasoby;
nie wydaje nowego uprawnienia i nie wykonuje rollbacku lub replay. Każde użycie
StartedGroup ponawia powiązane wyniki i aktualny epoch pod nadal żywym oryginalnym
copy host scope. Wynik to `runtime-started-not-scientifically-qualified`, bez
registration ani prawa do usunięcia oryginałów.

To integracja źródłowa, nie dowód wykonania na hoście. Cała recepta nadal musi
objąć aktywację kwalifikacyjną przy nierozwiązanym pending, nowy pełny Zarr,
rejestrację i kwalifikowane usunięcie dokładnych starych duplikatów. Zwykła
aktywacja/start pozostaje zablokowana przez pending; zapisany StartedGroup JSON
nie zastępuje żywego kontekstu.

Sama integracja źródłowa i zapisane acknowledgements nie dowodzą wykonania
na hoście. Pełny sterownik musi jeszcze połączyć admission, bezpieczny start,
kwalifikację zapisu/Zarr i rejestrację pod ciągłą kontrolą. Rzeczywista kopia,
przełączenie bindów, admission, odtworzenie grupy, kwalifikacja Zarr, rejestracja
i usunięcie starych duplikatów pozostają **NOT VERIFIED**.

## Weryfikacja

Lekkie testy obejmują zamknięte rejestracje, UUID/inode, aliasowanie datasetów,
zachowanie ACL/mtime/hardlinków, podmiany namespace, ctime oraz skopiowane
admission. Nie dowodzą rzeczywistego formatu urządzenia ani działania Dockera.
Odbiór hostowy wymaga osobno create/attach receipts, identyfikacji nowego
urządzenia, rzeczywistych mountów hosta i kontenera, kompletności danych,
świeżego probe oraz kwalifikacji pierwszego pełnego Zarr po migracji.
