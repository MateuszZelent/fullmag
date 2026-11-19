# Checkpoint anteny po restarcie WSL — 28.10.2026

## Cel i bieżący wynik

Celem pozostaje pełny zakres E0–E12 z pierwotnego zlecenia, w tym rzeczywiste
V/J/H anteny, zapis i cold-load, poprawne Inspectory, wizualizacja pola w Universe,
kwalifikowana baza i jej konsumenci. Ten checkpoint dotyczy naprawy środowiska;
nie oznacza zakończenia anten ani kwalifikacji naukowej zapisanego wyniku.

Backend i frontend naszej grupy są zatrzymane. Nie uruchomiono nowego Solve.
Zapisany wynik pozostaje Failed / unassessed. Historyczny poprawny odczyt API
nie zastępuje ponownego odczytu po przywróceniu usług ani odbioru WebGL.

## Odtworzenie Git bez zmiany historii

Po restarcie znaleziono trzy puste loose objects i dwa wyzerowane końce reflogów.
Odtworzenie surowych payloadów z indeksu i znanych metadanych dało identyczne SHA-1:

- commit `0b85a73357aadcd8caaf0943f0d038bd0c35b274`;
- drzewo scripts `51cc6704b2fc94181cc0addb9a737a1e229826c1`;
- drzewo główne `d787c971393243689f34461c83ee7d1963d7766c`.

Przed zapisem zachowano pełny common Git i chroniony FMS w wolumenie kontrolnym.
Archiwum: 2 337 832 960 B, SHA256
`e7e7ba2c7b1ee96931ae492c2862ff1bf42f7e144d3e354d77c5e8703629d901`.
Pełny `git fsck --full --no-dangling` zakończył się kodem 0, bez komunikatów.
Indeks i FMS zachowały swoje SHA256. Nie wykonano reset, prune ani zmiany refs.
Dowody: `verification/git-repair-after-wsl-restart-20261028/`.

Commity `f08d22c227b3020aa3f07b04f38853ff7f81fad9` i
`0b85a73357aadcd8caaf0943f0d038bd0c35b274` wypchnięto na branch PR #247.
Nie zapisano bezpośrednio do mastera.

## Potwierdzenie błędu osieroconego resume

Nowy jawny schemat `fullmag.docker-resume-interrupted.v1` uzupełnia dotychczasowy
`fullmag.docker-development-interrupted.v1`. Stary kontrakt pozostaje zachowany.
Receptura: `just docker-dev-reconcile-resume <request> <SHA256> <source_root> [apply]`.
Domyślnie wykonuje preview; zapis wymaga `apply=true`.

Zakres jest ograniczony do resume zakończonego błędem gotowości frontendu,
którego backend jest teraz Exited255/PID0 po innym uruchomieniu WSL, a oryginalny
helper już nie istnieje. Kontrolowane są dokładne kontenery, obraz, stan, Compose,
base receipt, package/provenance, log, źródła kontrolerów, wolumeny, helper absence,
blokada i brak aktywnych konsumentów. Publication nie jest ponownie kwalifikowana.
Wolumen zasiany i rzeczywiście zamontowany są rozróżnione w wyniku.

Po restarcie numer urządzenia katalogu storage zmienił się z 2096 na 2128;
inode 241587, root, engine i ext4 pozostały zgodne. Nowy request jawnie przypina
oba numery wyłącznie do potwierdzenia błędu operacji. Certyfikat i jego owner
nie są zmieniane. Zwykła bramka admission nadal odmawia starego device;
regresja wywołuje tę rzeczywistą bramkę i sprawdza odmowę.

Końcowe 21 testów interpretowanych: PASS, 0 failures/errors/skips, w zarządzanym
helperze tej grupy, bez Rust compilation. Testy wykonują też rzeczywistą
transakcję shell na odizolowanych plikach fixture: preview, publikację, częściowe
ponowienie, błędne piny i zajętą blokadę. Niezależny source review: 0 Required.

Canonical preview przeszedł, a następnie zastosowano dokładny request:

- request SHA256: `bbf9e8d3b0edda70bff363db44855cca19e9262f62612e534ca9201c33f99441`;
- kontroler SHA256: `49d0bae5b2a3e07c81a30f8efd7167816fe6c6f2498b9af03218dc773e1e02c4`;
- operacja: `42c26e8726dd472780391b98cde2a33b`, stan `failed-confirmed`;
- terminal SHA256: `8abe83c4318bea3b890558149442b9421d8989a39f713d80085a49a4f05b558c`;
- osierocony active został zwolniony pod blokadą kontrolera;
- wszystkie 15 919 plików store, 537 825 914 B: identyczne przed i po;
- natywne OWNER, LAUNCH i process-tree: identyczne przed i po;
- obserwowane certyfikaty i markery storage: identyczne przed i po;
- zero startów usług i zero ponowień Solve.

Dowody: `verification/resume-interrupted-20261028/`, w tym
`apply-49d0bae5b2a3-1c78bbf7.json`, snapshot i log oraz
`final-source-tests/tests.json`. Potwierdzenie błędu operacji nie jest odzyskaniem
natywnego ownera ani dopuszczeniem storage do uruchomienia.

## Native v4 — źródła przygotowane, runtime niezweryfikowany

Osobny `runtime_service_container_recovery_request.v4` zachowuje pełny,
rozłączny inventory terminal history i nigdy niewypuszczonych manual runs.
Obecny store ma 43 runy: 41 terminalnych i dwa held. Nie wystarczy przypiąć
trzech ostatnich runów. v1–v3 nie akceptują held jako terminal evidence.

Held mają osobne intent/catalog/evidence SHA256, canonical manual policy i brak
release/admission/lease solvera. Zakończone przygotowanie pozostaje zachowane
oraz weryfikowane istniejącymi lease→launch→exit→host-release fences.
STARTUP/LAUNCH/OWNER, host-before-store, quiescence, archiwizacja i idempotencja
pozostają wspólne. V4 wymaga Exited attestation; nie rozszerza NamespaceAbsent.

Agregat v4 wynosi jawnie 256 MiB; v1–v3 pozostają przy 128 MiB.
Pomiar bezpośrednich CAS referencji: 119 548 414 B, plus około 30,8 MB intentów.
Read-only CLI `runtime service-inspect-held-manual-run` produkuje nowy pin;
nie tworzy start release ani nie uruchamia zadania.

Osiem nowych regresji Rust jest w źródłach; zgodnie z ograniczeniem lokalnym
nie kompilowano ani nie uruchamiano testów Rust. Source review nie wykazał
Required/Blocker. Parser rustfmt w helperze własnej grupy poprawnie odczytał
osiem zmienionych plików; to kontrola składni, bez kompilacji i testów. Dowód:
`verification/mixed-history-native-v4-20261028/rust-syntax.json`. CI pełnego
`fullmag-session` obejmuje nowe regresje; dodano także jawne sprawdzenie CLI
`cargo check -p fullmag-cli --bin fullmag` na GitHub. Wynik CI pozostaje wymagany.
Nadal wymagane są CI, managed build i rzeczywisty preflight
wszystkich historycznych runów. Obecny binarny pakiet nie obsługuje v4.

## Następne bramki

1. Zarządzana ponowna kwalifikacja storage po zmianie device, z zachowaniem
   oryginalnych certyfikatów i historii; bez ręcznego resetu ownera.
2. Build nowego pakietu wyłącznie we własnym kontenerze backend przez just.
   Istniejący recovery-build wymaga Running + Failed/Unknown i nie jest jeszcze
   bootstrapem dla Exited255 + Ready. Zwykły start może zatrzymać się przy
   diagnostic API; nie wolno zakładać, że sam zakończy PID1 po odmowie ownera.
3. Pełny mixed-history native preview, następnie autoryzowane recovery;
   żadnego syntetycznego shutdown_unknown, drainu ani pomijania starych runów.
4. Przywrócenie UI i saved inspection z prawdziwym ownerem rozwiązania.
5. Odbiór H w Universe w rzeczywistym WebGL: canvas, wektory, jednostki, skala,
   Inspector, poprawny brak danych i screenshoty; bez nowego Solve przy zmianie widoku.
6. Pozostałe wymagania E0–E12 oraz testy/CI i integracja PR. Ten checkpoint nie
   zastępuje odbioru end-to-end ani odtworzenia wyników publikacji.


## Przygotowanie storage po restarcie WSL — kontroler i regresje

Nowy kontrakt `fullmag.linux-native-device-readmission-preparation.v1` przypina
pięć surowych plików admission, engine, root/inode, dawny i obecny device oraz
istniejące image/source/binary binding. Kandydat zmienia wyłącznie `host_device`
i `restart_verified=False`. Nie daje namespace admission; dotychczasowe bramki
`reuse_certificate`, retained storage i rzeczywisty guest probe pozostają zachowane.

Kontroler `scripts/docker_linux_native_readmission.py` udostępnia jawny request
`fullmag.docker-linux-device-readmission.v1` przez receptę
`just docker-dev-readmit-linux-storage <request> <SHA256> <source_root> <image_id> [apply]`.
Domyślne preview nie zmienia certyfikatu ani ownera. Zarządzany helper własnej grupy
trzyma operation/STARTUP/LAUNCH/OWNER oraz host-before-store writer locks na
rzeczywistych inode. Dwa kontenery muszą pozostać w dokładnie przypiętym stopped
state; aktywny konsument lub rezerwacja oznaczają odmowę. Nie zatrzymuje usług.

Archiwum w prywatnym control volume zachowuje bezstratne surowe bajty i kandydata
przed pierwszą zmianą hosta. Publikacja zachowuje inode certyfikatu bind-mountu.
Replay korzysta z archiwum i obsługuje wyłącznie pary old/old, marker-new/cert-old
oraz new/new; nieznane lub torn bytes wymagają osobnego recovery. Helper nie
wykonuje żadnej mutacji Dockera ani admission, a EOF zwalnia blokady. Dlatego
kontroler stosuje istniejący wzorzec transakcji recovery, bez nowej operacji buildu
ani trwałego active; archiwum i zwykłe bramki blokują niejawne dopuszczenie po awarii.

Weryfikacja w interpretowanym Pythonie we własnym zarządzanym helperze:
13 regresji core i 8 regresji wrappera: PASS, bez failures/errors/skips.
Wrapper uruchamia rzeczywisty protokół na prywatnych fixture i sprawdza wszystkie
blokady, przerwanie po EOF, odmowę przy aktywnej operacji/rezerwacji, zmianę danych,
nieczytelny katalog oraz historię większą niż 64 pliki. Dowody:
`verification/linux-native-readmission-20261028/core-tests.log` i
`verification/linux-native-readmission-20261028/wrapper-tests.log`.
Niezależny przegląd core: brak Required; dwa Required wrappera (serializacja raw
archiwum i jawna odmowa błędu enumeracji) zostały poprawione przed użyciem.

W chwili zapisu pierwszego fragmentu rzeczywiste preview/apply były niewykonane;
wynik późniejszego wznowienia v2 opisano poniżej. Nowy probe w docelowym backendzie,
managed build, native mixed-history recovery i odbiór H w WebGL pozostają niewykonane.
Wynik symulacji zachowuje Failed/unassessed. Nie powtarzano Solve.


## Weryfikacja rzeczywistej trasy i jawne wznowienie archiwum v2

Commit `25a3b800558e3dd2ac642a12b28c7d28a5a4c147` zachował pierwszy fragment.
Rzeczywiste preview wykazało jeszcze brak zamkniętej trasy w
`just_storage_shell.sh`, nieprawidłowy import resolvera oraz różnicę pomiędzy
ścieżkami hosta i aliasami bindów Docker Desktop. Trasa jest teraz jawna przed
hostowym preflight; regresja wykonuje pełną powłokę na prywatnym fixture.
Wybrany source/state są potwierdzane istniejącą funkcją samefile. Dla żywych
aliasów podkatalogów kernelowe TARGET/FSROOT i inode muszą dowodzić rozłączności.
Stary runner Windows pozostaje nietknięty: dwa jego bindy zostały sprawdzone
natywnym, odczytowym dowodem stałego NTFS/ReFS bez reparse ancestors.

Pełny final preview requestu
`5dfa89641cca925359bfdafadb44a566086b06356a869dc55c83338b83d2588d`
przeszedł: 15 919 plików, 537 825 914 B, snapshot
`a7def36ae039208a98f6bce55f254afab818bf407528c38af8312765e5fceb41`.
Ledger SHA: `ba6628a5d510d66e40dff31888a68730f0d09e40aa3ef2cdf8ef9638d1e85d8a`.
Nie uruchomiono usług ani Solve.

Apply tego requestu zatrzymał się po publikacji markera, przed certyfikatem.
Przyczyną był błąd nowego kodu: canonical archive sortował klucze candidate dict,
a publisher serializował dict zamiast przypiętych candidate_raw. Semantycznie
zmieniły się tylko host_device i restart_verified, ale raw readback prawidłowo
odmówił kontynuacji. Certyfikat zachował oryginalny SHA
`b9dfce5d6be9ed857b8468f27fcb8be99fe3ad9674e61ca0e3d46f4d7f116c6f`;
marker ma dokładny archive-order SHA
`48ceccfaf51b515b7d48e896f77e502f21645e48d60f29e1dd5402c5f9e1f089`.
Docelowe candidate_raw mają SHA
`954b615bd9006972afffd7405209c37b9d91acdcbfa752b591659d4f66f8ab62`.

Publisher używa teraz dokładnych candidate_raw; bound certificate odtwarza
kolejność z tych samych bajtów. Osobny request
`fullmag.docker-linux-device-readmission.v2` wymaga SHA starego requestu,
oryginalnego przygotowania oraz dokładnego deterministycznego wariantu markera.
Boot/engine/container/storage/native pins pozostają identyczne. Archiwum jest
kopiowane jako surowe bytes; normalizacja markera musi osiągnąć zwykłą fazę
marker-published przed zapisem certyfikatu. V1 i domyślne wywołania core nadal
odrzucają archive-order marker; nie ma ogólnej równoważności JSON.

Końcowe 28 regresji interpretowanych: PASS, zero failures/errors/skips.
Obejmują rzeczywiste canonical archive → restore → publish, jawne wznowienie
częściowej publikacji i odmowę compact/foreign/reversed bytes oraz błędnych CAS
lub zmienionych authority pins. Niezależny review: zero Required po poprawkach.
Dowody: `verification/linux-native-readmission-20261028/v2-source-tests.json`
i `v2-source-tests.log`. Nie kompilowano lokalnie testów Rust.

V2 preview i apply wykonano poprawnie z commita
`1df80cd630e6f7dd58fa8b3c3ddb9aaa9af3b2c3`, przez zarządzaną receptę just.
Request SHA256: `95dc7f5d476f943e63fa011f9829a404e2ff0cbb27a22bf181443c874ac49fa5`.
Wynik: **prepared-not-admitted**, `namespace_admitted=false`.
Niezależna weryfikacja końcowa potwierdziła:

- certyfikat i marker mają dokładnie docelowe bytes/SHA `954b615b…`;
- zmieniły się wyłącznie host_device i restart_verified;
- inode i metadane certyfikatu bind-mountu zostały zachowane;
- probe, sentinel i restart pozostają identyczne;
- wszystkie 15 919 plików / 537 825 914 B i ledger mają te same hashe jak
  przed nieudaną próbą i przed wznowieniem;
- natywne OWNER, LAUNCH i process-tree pozostają identyczne;
- obie usługi pozostały w dokładnie tym samym stopped state, active nie istnieje;
- plik FMS użytkownika pozostał identyczny; brak nowego Solve.

Dowody w prywatnym control volume:
`verification/linux-native-readmission-20261028/v2-preview-preservation.json`,
`v2-apply.log` oraz `final-verification.json`. Oryginalny request, przygotowanie
z surowymi bajtami i historia nieudanej próby pozostają zachowane.

Storage nie jest jeszcze namespace-admitted. Nadal wymagane: nowy build w tym
samym backendzie, rzeczywisty storage probe tej inkarnacji, pełne native v4
mixed-history recovery oraz odbiór H w UI. Rzeczywisty kod starego obrazu różni
się od checkoutu: backend_dev.py SHA `dcea3be09d4be564b406eb9c3287b0ae642c09baeb8aad1fc4286fe1158e9ce2`,
entrypoint.py SHA `55a97db9c023a4324695364a030464f5be2cd67d09593333b17add0e862d300c`.
Sprawdzony kod obrazu publikuje pakiet przed Linux admission i cgroup gate;
nie można zastąpić tej weryfikacji samym odczytem nowego checkoutu.


## Rozstrzygnięcia integracji mastera z 28.10.2026

Integracja obejmuje `origin/master` o pełnym SHA
`2c67d8f904b1dede9268bbbc8bf6257cbe33aa4f` oraz wcześniejszy HEAD zadania
`ab5ac8491ff18722dd21b653409b4ccbe40778ca`. Rozstrzygnięto 13 konfliktów
źródeł; zapis merge i potwierdzenie bieżącego HEAD są osobnymi krokami Git.
Nie zmieniono FMS użytkownika, statusów runów, release ani natywnego OWNER.

Przyjęto kanoniczne recovery v4 mastera, jego walidator manual-held i budżet
agregatu 1 GiB, zachowując limit pojedynczego obiektu oraz budżety legacy.
Usunięto zastąpiony duplikat `retained_mixed_runs.rs`. Held request używa
`run_id`, `run_intent_sha256`, `run_catalog_sha256`, `start_release: absent`;
terminal request używa kanonicznego opcjonalnego `artifact_catalog_sha256`.
Read-only CLI inspekcji terminal/held pozostaje dostępne, lecz jego dodatkowy
hash diagnostyczny nie jest polem requestu v4. Faktyczny odczyt obu run_catalog
runów `36bd51495…` i `6a1ab0dfe…` potwierdził Accepted/Blocked i brak artefaktów,
a więc wcześniejsze podejrzenie Queued nie jest bieżącą blokadą.

Masterowe wznowienie hosta i nasze ukończone przygotowanie pozostają oddzielne:
bieżący certyfikat ma już device 2128 i restart_verified=false. Nie wolno
ponownie wykonywać świeżej migracji host_device ani przepisywać tej flagi na
true. Dalsze admission wymaga autentycznego nowego probe docelowego namespace.
Testy ukończonego przygotowania zachowano pod jednoznaczną nazwą
`test_linux_native_device_preparation.py`; nazwa
`test_linux_native_readmission.py` należy do kanonicznego modułu mastera.

API zachowuje `RetirementAuthority::with_evidence` oraz masterowy ograniczony
retry typed StoreWriterBusy wyłącznie przed wejściem do pointer transition.
Imported observation nie uzyskuje natywnej authority. Niezależny przegląd tego
rozstrzygnięcia nie wykazał wymaganej poprawki; pełne zachowanie tej kombinacji
nadal wymaga runtime/CI i nie jest dowiedzione samym parserem.

Weryfikacja scalonych źródeł w helperze przypisanym do własnej grupy:

- 58 regresji przygotowania urządzenia, readmisji i wrappera: PASS;
- 174 regresje recovery/bridge v3/v4, codegen, WSL, offline network,
  foreign-bind i readmission: PASS;
- łącznie 232 testy interpretowane, zero failures/errors/skips;
- 10 plików Rust przechodzi parser rustfmt; nie kompilowano lokalnie testów;
- `bash -n`, `git diff --check` oraz parser `justfile`: PASS. Parser just
  ujawnił nieprawidłowe przylegające delimitery w masterowej recepturze
  browser-qa; poprawiono zapis, zachowując argument saved_playback_item_id.

Dowody i hashe źródeł znajdują się wyłącznie w control volume grupy pod
`verification/master-integration-20261028/`: `device-and-shell-tests.json`,
`merge-recovery-contracts.json`, odpowiadające logi i `syntax-diagnostics.json`.
Testy fixtures nie oznaczają recovery rzeczywistego store ani wizualizacji.
Obie usługi nadal Exited, bez nowych buildów i Solve. Kolejne bramki:
commit/push integracji, zarządzany build, świeży namespace probe, natywne
recovery pełnych 43 runów, cold-load H oraz rzeczywisty odbiór WebGL.
Cały zakres E0–E12 pozostaje aktywny; zapisany wynik nadal Failed/unassessed.


## Rzeczywisty preflight kanonicznego recovery v4

Po integracji `b875ea8a3fe97250f103f0f4e17ab9a165ab3177` wykonano wyłącznie
odczytowy preflight pełnych 43 runów: 41 terminalnych (22 succeeded, 12 failed,
7 cancelled) i 2 Accepted/Blocked. Kompletne wejścia zachowano w control volume
pod `verification/native-v4-canonical-preflight-20261028/inputs-v4.json`.
Pierwsze odmowy dotyczyły formatu przygotowanego wejścia: request_id wymaga
UUID z separatorami, a artifact_catalog_sha256 ma być obecne także jako null.
Nie zmieniano katalogów ani walidatorów w celu dopasowania tych danych.

Surowe bajty zachowanego Compose mają nadal SHA
`e837e976cfed9ebac25b13ff2824f40e006e05dadb25763de5f13711ef1347b3`.
Kanoniczny hash JSON wymagany przez nowy kontrakt wynosi
`66401b85878924fb0ca043cad95c27b219264e52e78461de7535f014d947ca9c`.
To różne sposoby przypięcia tego samego dokumentu, nie zmiana jego treści.

Rzeczywisty host Python 3.8 wykazał brak PurePosixPath.is_relative_to w nowej
kontroli obcych konsumentów. Dwie hostowe kontrole używają teraz równoważnego
porównania równości i obu list parents; helper obrazu zachowuje własny kod.
40 istniejących regresji abrupt/legacy recovery: PASS, zero failures/errors/skips.
Dowody: `python38-overlap-regressions.json` i odpowiadający log w tym samym
katalogu wolumenu. Faktyczny preflight przeszedł naprawione kontrole i zatrzymał
się na nieobsługiwanym literalnym bind source Windows starego runnera.
To nadal odmowa bez autoryzacji recovery, bez startu usług i bez Solve.

Read-only Windows metadata potwierdziły obecne pliki VHD Ubuntu i Docker
Desktop oraz odrębność ich ścieżek od katalogu runnera. Kwalifikowany,
powtarzalny adapter tej obserwacji do kanonicznego guard nadal powstaje;
jednorazowy odczyt metadanych nie zastępuje tej bramki. Równolegle przygotowywana
jest jawna ścieżka buildu pakietu w zatrzymanym fixed backendzie za zamkniętą
bramką storage. Obie zmiany wymagają osobnych regresji i przeglądu przed użyciem.


## Przyrostowe przygotowanie pakietu za zamkniętą bramką storage

Dodano jawną receptę `docker-dev-build-for-recovery` oraz zamknięty request
`fullmag.retained-recovery-build.v1`. Recepta wybiera dokładnie zachowany attempt,
kanoniczny hash Compose, source root, request z control volume i jego SHA256;
port naszej grupy pozostaje 3203. Nie jest to zwykły resume ani admission.

Przed startem wymagane są niezmienione Ready owner, pełne piny terminal/held,
certyfikat prepared z restart_verified=false, zgodny prywatny cache bez aktywnych
konsumentów i dokładne bajty kontrolera oraz helperów starego obrazu. Obraz
kompiluje i publikuje pakiet przed bramką storage; zgodność funkcji `_serve`
i `validate_host` jest dodatkowo sprawdzana względem przejrzanych źródeł.
Tylko istniejący backend może wystartować. Frontend pozostaje zatrzymany.

Po publikacji najpierw porównywane są source/receipt/provenance i surowe hashe,
a dopiero potem wykonywane read-only CLI capabilities tego samego sealed binary.
Pakiet musi rzeczywiście reklamować recovery v4 oraz przypiętą tożsamość buildu.
Oczekiwanym końcem tej operacji jest naturalna odmowa storage po co najmniej
240 sekundach, exit 2, bez startu API/native. To sukces przygotowania pakietu,
nie sukces runtime. Brak potwierdzenia zachowuje operację do rozpoznania;
nie powoduje automatycznego ponowienia ani zmiany flagi admission.

Docker potrafi zwracać `Mounts` w różnej kolejności dla identycznego kontenera.
Nowe obserwacje sortują wyłącznie tę listę po unikalnym niepustym Destination;
porównania starych archiwów normalizują kopię, nie zmieniając surowych dowodów.
Wszystkie pola Source/RW/options, stan, Config i HostConfig nadal są przypięte.
Przygotowywany osobno adapter Windows wymaga resolvera jawnie wybranej grupy
z pasującym Compose i labelem, z zachowaniem domyślnego ograniczenia legacy
do fullmag-master; ta część pozostaje WIP poza commitem recepty.

Dowody źródłowe: 86 interpretowanych regresji abrupt/legacy/preparation,
retained context, shell i nowego buildu: PASS. Wcześniejsze 74 kontrole obejmowały
również adapter Windows przed rozszerzeniem kontroli potomnych reparse points.
Aktualny adapter Windows nadal wymaga końcowych testów i rzeczywistego preflightu.
Logi: control volume `verification/recovery-mount-order-20261028/`.
Nie kompilowano lokalnych testów Rust i nie wykonano jeszcze nowej recepty.

Pełny snapshot 15 919 plików / 537 825 914 B pozostaje identyczny:
store SHA256 `a7def36ae039208a98f6bce55f254afab818bf407528c38af8312765e5fceb41`,
ledger `ba6628a5d510d66e40dff31888a68730f0d09e40aa3ef2cdf8ef9638d1e85d8a`.
FMS użytkownika ma nadal SHA256
`d1ce5e22d273213da0119492a95a24a46428b75a199a24dbd93dd0c216bf24de`.
Dowód: `full-store-preservation.log` w powyższym katalogu control volume.

Ocena retencji przed buildem: skill `fullmag-build-stage-cleanup` nie istnieje
w worktree ani sprawdzonych katalogach skilli użytkownika. Zastosowano fallback
z build-storage governance. Zachowujemy wszystkie bieżące cache, pakiet rollback,
logi, dokumenty recovery i wyniki, ponieważ są referencjonowane przez aktywne
odzyskiwanie. Brak wykazanego zbędnego kandydata; niczego nie usuwano. Ponowna
ocena dopiero po zweryfikowanym nowym pakiecie i zakończonym recovery.


## Adapter Windows: stan file-only i granica dalszego recovery

Dodano adapter `docker_windows_bind_isolation` do kanonicznego guard obcych
konsumentów. Odczyt łączy Windows serial/FileID i backing VHD z kernelowym
DrvFs, źródłami grupy i ext4 WSL; nie przyjmuje różnej litery dysku jako dowodu.
Mounts jest porównywane bez wpływu kolejności. Root i descendants nie mogą
wprowadzać niezakwalifikowanych reparse; source/reference nie mogą mieć
zewnętrznych submountów. Zwykłe zmiany treści heartbeat nie zmieniają dowodu
samej topologii. Backing hardlinks pozostają ograniczone do jednego tam, gdzie
obiekty są na tym samym natywnym volume; różne serial wykluczają cross-volume
hardlink bez udawania obsługi fsutil, której nie ma na C:.

77 testów bieżącego adaptera file-only i integracji z recovery: PASS, zero
failures/errors. Dowody i dokładne SHA: `windows-contained-tests.json` i log
w `verification/recovery-mount-order-20261028/` control volume. 84 testy
wydzielonego commita recepty a41d4c9cdc46a64ed2d4a1f4ad5f4042636d06f5 również
PASS. Commit jest wypchnięty do PR #247; opis PR został zaktualizowany przez
uwierzytelnione środowisko WSL. Błąd dostępu gh w PowerShell nie wymagał nowego
logowania użytkownika.

Rzeczywisty preflight nie przeszedł. Po usunięciu kosztu Get-Item i zbędnych
metadanych dotarł do istniejącego linku biblioteki libfullmag_fem.so; ten wąski
przypadek ma kwalifikację file-only. Kolejna odmowa dotyczy linku katalogowego
react-doctor w starym node_modules. Przegląd zaakceptował ograniczony model
zawartych LX directory links, ale automatyczna kontrola odrzuciła zapis jako
rozszerzenie autoryzacji. Odrzuconej zmiany nie zastosowano. Konkretna propozycja:
[kwalifikacja katalogowych linków LX](2026-10-28-windows-contained-lx-directory-proposal.md).

Backend i frontend nadal pozostają zatrzymane; nie było nowego buildu aplikacji,
probe admission ani Solve. Nie zmieniono cudzych kontenerów, wyników lub cache.
Dalszy krok zależny: rozstrzygnięcie tego rozszerzenia, jego regresje i rzeczywisty
preflight, dopiero potem już przygotowana recepta buildu i native v4 recovery.
Brak przejścia preflightu nie jest dowodem braku kodu solvera ani poprawnej
kwalifikacji zapisanych danych. Pełny E0–E12 pozostaje aktywny.


## Integracja ochrony bindów z aktualnego mastera

Po pushu c1f8f10602812ebc2b35affd0741b01eb881b5ae GitHub zgłosił PR jako
mergeable=false / dirty, bez check runs dla tego commita. Pobranie origin
potwierdziło nowy master `855a4db407b8a8e5330375e8e8a0e9d8b512b707`, zawierający
PR #303 i poprawkę `a9c0b9da5d2d866a73af1489a00723beea5a21ed`.

Rozstrzygnięto jeden konflikt w `docker_volume_container_recovery.py`.
Zachowano masterowe odrzucanie ścieżek // oraz nierozwiązanych Windows Desktop
host-drive aliases. Literalne ścieżki Windows nadal wymagają całego istniejącego
dowodu file-only. Dodatkowo surowa zgodność chronionego Windows source oraz jego
rodzica/potomka jest sprawdzana przed wywołaniem dowodu, z semantyką wielkości
liter i separatorów PureWindowsPath. Regresja sprawdza także, że resolver
nie zostaje wtedy wywołany. Masterowa ochrona state_alias_sources podczas
host readmission jest zachowana bez rozluźnienia.

145 interpretowanych testów merge (abrupt/host readmission/Windows file-only,
recovery build/preparation/legacy): PASS, zero failures/errors. AST Python3.8
i git diff --check: PASS. Dowody z hashami źródeł:
`verification/master-bind-guards-integration-20261028/tests.json` i tests.log
w control volume grupy. Komunikaty mocked readmission w logu są testami
fixture; nie wykonano readmission ani startu rzeczywistego runtime.

Moduł Windows pozostał byte-identical, SHA256
`4411410a48c18b49dbdfb982683853e3937aabb375d4f36680cfea9a74b372dd`.
Odrzucona obsługa katalogowych dowiązań LX nie jest częścią integracji.
Pytanie o konkretną propozycję nadal pozostaje otwarte. Plik FMS użytkownika
pozostaje poza indeksem; brak nowego buildu aplikacji lub Solve.
