# CoFeB — naprawa granic i wznowienie mastera, 28.10.2026

## Cel i ograniczenia

Zlecenie: poprawić granice cylindra, przywrócić backendowi 128 GiB / 16 CPU,
uruchomić `examples/permalloy_layer_cofeb_rings_relax_300nm.py`, wykonać
10 kroków i sprawdzić magnetyzację oraz H_demag w Airboxie. Master,
bez worktree i testów; zachować cudze zmiany, dane i cache.

Stan początkowy opisuje [audyt](2026-10-28-mx3-master-reassessment.md).
Podczas pracy równoległy merge #304 przesunął HEAD z `3ffd6896a451...` do
`b4eab956b209ee698fede9beb70ad149f8dc1069`. Zachowano go oraz zastane zmiany
`external_solvers/3` i `mx3.md`. Rzeczywisty snapshot buildu należy odczytać
z receiptu; sam HEAD nie opisuje poprawki lokalnej.

## Poprawka geometrii — zbudowana, odbiór runtime oczekuje

`crates/fullmag-authoring/src/geometry.rs::derive_geometry_bounds` używa
teraz unormowanej osi cylindra. Półwymiar AABB w osi i to
`radius * sqrt(max(0, 1 - axis_i²)) + height/2 * abs(axis_i)`.
Normalizacja przez skalowanie obsługuje duże/małe skończone wartości; błędna
lub zerowa oś jest odrzucana. Brak osi zachowuje domyślne Z. Transform
obiektu i wybór geometrii bazowej dla Difference pozostają istniejącą ścieżką.

Review algebry: X daje `[h/2,r,r]`, Y `[r,h/2,r]`, Z `[r,r,h/2]`.
To przegląd kodu, nie uruchomiony test. `git diff --check` bez błędów.

## Uruchomienie grupy

Użyto kanonicznego `scripts/docker_dev.py up`, jawnego source root mastera,
portu 3198 i `--gpu-access required`. Budżet 128/16 przekazano jako
`FULLMAG_DEV_BACKEND_MEMORY_GIB=128`, `FULLMAG_DEV_BACKEND_CPUS=16` wyłącznie
do tej operacji, bez zmiany wspólnych domyślnych ustawień innych grup.
Po starcie trzeba potwierdzić rzeczywisty limit i zapisany Compose.

GPU poza sandboxem: RTX 4080 SUPER,
`GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`. Odmowa NVML w sandboxie nie
oznaczała braku GPU hosta. Nie wybrano CPU jako zastępstwa solvera GPU.

- Recreate services: `bb98cea2057f40b6ae8e43d548cc11e6`, succeeded.
- Toolchain: `8cf415b8bc1746a38961a35f7222e920`, succeeded;
  `sha256:efe1c5b5ef051387c4e6b32f960effd382a6e3cbc7de1627c15508be0ac96ebf`.
  Większość zależności pochodziła z cache; dołożono warstwę MPFR/GMP.
- Build aplikacji zakończony; start native runtime odmówił na polityce ledgeru
  opisanej poniżej. Nowa aktywacja i 10 kroków oczekują.
  Nie ponowiono historycznej komendy o niejednoznacznym wyniku.

Nowy backend `48bdc28bd8d0`, frontend `4447284c5329`. Docker inspect
potwierdza limit backendu 137438953472 B i NanoCpus 16000000000, czyli
**128 GiB / 16 CPU**. Obraz backendu
`sha256:53d469b9313f5b30cb90ef8050031054b3ed8c9c34d56bd6ed5b0a5f6b287173`.
Kompilacja aplikacji odbyła się w tym samym backendzie; obserwowano około 1626%
CPU. Nie uruchomiono kompilacji testów ani hostowego Cargo/CMake.

## Dane i retencja

Zachowano sesje, wyniki, wolumeny, aktualny pakiet/rollback i cache.
Nie wykonano prune ani ręcznego resetu ownera. Storage użytkownika ma około
9,1 GiB wolnego przed nową symulacją; nie jest to pomiar wolnego miejsca
wolumenów buildu Dockera. Ocena zbędności: brak podstaw do usuwania
konkretnych danych przed potwierdzeniem następcy. Ponowna ocena po zakończeniu
builda i odbiorze pól; automatyczna retencja pozostaje pod kontrolą launchera.

## Wynik kompilacji i dokładna blokada startu

Development `d10cf0d2640d42fe9f5afe7b9b7ede83` zakończył się
`failed-confirmed`; config
`18016684fd1bc42a01f49d717f5be5c7030c8914282fcc583f7689707a24edc8`.
**Kompilacja przeszła**: Make exit 0 / 616429 ms; pakiet 24 pliki / 10386 ms,
verify 1647 ms. Snapshot
`9f93b1225de3e535cc95fb819b3f9d4b3ec979ac4e1225e225a9ea97e3a3a3a5`,
build receipt SHA256
`02aa3c964036fddefa969c5a1cdb3cdf234a39dbe691001a735a1b4201e010df`.
Geometry shadow ma ten sam hash co lokalna poprawka:
`e111d1cc3badd27860f2a9d5b7c619e20a23bb86106800f7ceb98350a64c46c9`.

Native host-profile initializer odmówił przed nowym ownerem i publikacją sesji w API:
`stored host resource policy differs from explicit ledger configuration`.
Zachowany ledger grupy ma CPU 8000 / memory 33285996544 B; nowy profil
kontenera żąda CPU 16000 / memory 136365211648 B. Dokładnie jedna zachowana
rezerwacja ma stan released. Nie jest to brak RAM hosta ani awaria kompilacji.
API działa jako diagnostic-only: health HTTP200/degraded/active_session=false.
Nie uruchomiono nowego CoFeB, Solve ani Compute Fields.

## Koordynacja i zachowanie bieżącej sesji

Równoległy agent pracujący nad PR #316 ostrzegł, że namespace 719... przy
zwykłym starcie wskazuje dawny snapshot b781, a rzeczywisty CURRENT to
`session-18e2bfab44a49c1400003460`, „mesh two spheres probe”, scene rev17,
run `run-live-0886fe253e920e06d153e3ef2d2ba2867b3420140f862e8f9744d230be984484`,
FEM CPU, awaiting_command, zero kroków. Uzgodniono wyłączność tego wątku na
lifecycle mastera; druga grupa 3318 pozostaje niezależna. Nie przerywano buildu.

Potwierdzono kopię pełnej sceny/komend i pinów w
`/mnt/c/Users/Mateusz/Documents/ChatGPT/Fullmag/recovery/recovery-input-identity-20261028/master-before-deploy.json`
(33344 B, SHA256
`421baeb3d3117d4fde95b0c0cf340f7658656ce8bde7064132622a17639698e1`).
Rzeczywisty odczyt obecnego store porównał wszystkie **46 hashy w 18 runach**:
zero różnic. API nie odtworzyło sceny. Nie utożsamiamy tego z brakiem wszystkich
efektów admission: `runtime_service_snapshot.admit` jest wywoływany przed
inicjalizacją profilu i jego zachowane markery wymagają osobnego przypięcia.

Potrzebne jest zachowanie CURRENT przez uzgodniony successor-copy i świeża
generacja ledgeru wyłącznie tej grupy z nowym budżetem. Stary ledger i runy
pozostają. `migrate-host-capacity` dotyczy starego globalnego profilu i jest
zabronione dla group-ledger-v1; nie użyto tej flagi.

Istniejące stop-helpery nie obejmują dokładnej kombinacji failed-confirmed
development + pre-owner policy refusal + historyczny Ready process-tree.
Nie fałszowano resume, ownera ani drainu i nie użyto surowego stopu.
Brakujący zakres to przypięty graceful stop samego diagnostic-only backendu,
po dowodzie braku native procesów, aktywnej sesji i aktywnych lease'ów, z
zachowaniem historycznych dokumentów. Successor-copy pozostaje osobną operacją.

## Kontrolowany stop przed następcą — wykonany

Dodano osobny `stop-preowner-policy-volume` w istniejącym launcherze oraz
`scripts/docker_volume_stop_preowner_policy.py`. Nie zmieniono bramek starszych
stop-helperów. Domyślny preview odczytuje dokładny failed-confirmed development,
Compose, cgroup, prywatny startup fence i bieżącą tożsamość API; wymaga
wyłącznie procesów init/supervisor/API/probe, zimnego API diagnostycznego,
zwiększenia CPU/RAM jako powodu odmowy oraz zweryfikowanych released proofs.
Health ma active_session=false, a cold middleware zwraca typowane 503 dla
zasobu sesji. Nie oczekuje się błędnie 404 w tym trybie.

Parser AST i diff-check przeszły, bez testów jednostkowych. Niezależny review
Sol zamknął jedyną wymaganą korektę guardu HTTP; brak pozostałych blockerów
w przydzielonym zakresie. Pierwszy preview odmówił przed jakimkolwiek sygnałem
na błędnym oczekiwaniu 404; nie był nieznanym wynikiem mutacji.

Właściwy preview `78d5f37266c443d084f8f054ba7adec7` przeszedł;
plan SHA256 `91525a8dfed022dd702a114a373549763bba5530391500336ceaee7d261b3ebe`.
Apply `4c8d815899f547b7aa872b5d349053c0` succeeded/stopped-confirmed.
Oba przypięte kontenery zakończyły się exit0 bez SIGKILL, usuwania kontenerów,
wolumenów ani danych. Przed sygnałem plan został ponownie sprawdzony pod lease.

Journal w wolumenie kontrolnym grupy:
`verification/preowner-policy-stop-48bdc28bd8d0feec6b86e56f297628ffc24dfd57caa43ca496e13dc10448bccf.json`.
Jego surowe bajty odczytano po stopie i potwierdzono SHA256
`06ab2551063496f3d460eb46c68a6876eed9805b94590bb9eb75fbfffaec540f`.
Zachowane OWNER, process-tree, config, snapshot markers, provenance, released
leases i 36 run-intent/catalog pins są identyczne przed/po. To nie jest native
drain; receipt jawnie zapisuje `native_owner_drained=false`. Development d10
pozostaje failed-confirmed. Następca i nowe 10 kroków nadal oczekują.

Następca wymaga kończonego równolegle PR #316: dodatkowe wejście przypina
typowany stop proof do failed-confirmed development, który przed Ready nie
zapisał ID usług w terminalnym receipcie. Oryginalnego receiptu d10 nie wolno
uzupełniać ani oznaczać jako succeeded. Drugi wątek nie wykonuje apply, copy,
startu ani Git writes w masterze. Ten wątek wykona ewentualne pojedyncze
fast-forward dopiero do dokładnego, scalonego SHA, po kontroli rozłączności
ścieżek i zachowaniu lokalnych zmian. W chwili tego checkpointu FF nie wykonano;
HEAD nadal `b4eab956b209ee698fede9beb70ad149f8dc1069`, obie usługi stopped exit0.

Core PR #316 został scalony na remote jako
`9c6253fd81b94781a2969bb22643bac02dd5f70b`; main lokalnie nadal nie przesunięty.
Rzeczywisty readonly successor preview dla nowego recovery ID
`c1b31c15d177439fb92ec3df61ca8e26` przeszedł (`preview-no-copy`): 16 terminalnych
runów + 2 held-manual, 1272 pliki store, wszystkie zachowane piny, 18 control
pins. Wybrany restore pozostaje `run-live-0886fe...`. Plik operatora ma SHA256
`96417870b15f32e2707e0dc70e291adc41b7c824fb3771c87a0641bb17f4ddab`, preview
`88f76a38fda6e7b4b20bf6e15ae74590085453921ca7410da47aed76af0afec6`.
To dowód podglądu, nie wykonania kopii ani admission. Końcowy adapter jest
integrowany w osobnym follow-up PR. Historyczny manifest kopii ma około
1,55 GB runów; aktualny odczyt wolnego storage to 8771600384 B. Apply ponowi
właściwy pomiar pełnej bieżącej kopii i bramkę miejsca przed zapisem.

W trakcie oczekiwania inny wątek wykonał o 22:04:39 czasu lokalnego FF main do
`297f6b8db373d5cacc03b6c0bdb7a16be0825af3` (PR #320 i wcześniejszy #300).
Zachowano tę aktualizację. Hashe lokalnej poprawki cylindra i kontrolera stopu
są niezmienione; index pusty. Kandydat follow-up PR #323
`b98cc38025a968839c74fe70bfe98ef4abd057a6` jest potomkiem 297 i ma zero
wspólnych ścieżek z zastanymi tracked dirty files. Przed właściwym FF kontrola
będzie ponowiona dla końcowego merge SHA. Wątki uzgadniają okno bez zapisów
w main; powyższe starsze heady i pomiary pozostają historycznymi checkpointami.

## Pozostałe dowody

Odczytać terminalny receipt bieżącego startu i limity. Następnie aktywować
przykład jednym nowym request ID, odczekać na mesh i sprawdzić limit 10 kroków
minimizacji BB. Jeden Solve; przy niejednoznacznej odpowiedzi odczytać journal
tego samego intentu. Po zakończeniu: pola/binary metadata z właściwym accepted
step i GPU execution, energie, widoczny canvas/WebGL, obejrzany render m i
H_demag Airbox. Brak testów jednostkowych; smoke nie kwalifikuje zbieżności.

## Bieżący start i zamknięcie starego modelu

Successor `c1b31c15d177439fb92ec3df61ca8e26` skopiowano przez przypięty
executor `b98cc38025a968839c74fe70bfe98ef4abd057a6`; operacja
`e2cfa5d28ca7441586e10780926eed9c` succeeded. Zachowano poprzednią kopię
719, jej ledger oraz wszystkie 46 naukowych pinów. Wykonano jeden
sprawdzony fast-forward 297→6944 z kontrolą rozłączności i hashów lokalnych
zmian; kolejny równoległy FF do `b502a4c2a838301e5091ea8b840918ee854fc399`
zastano i zachowano. Nie wykonywano commit, stage, push, reset ani stash.

Development `38f78cc1c38d4fbaa7b246836ce1c1f4` succeeded, Compose SHA256
`803df9985a9bd7b84b1d0a95f18eb2925b0b1d54f52914cfae2e093e2ea7d728`.
Backend `c5a560366efeb272319b79e468537bf569877ff7c6f57e347c0d54c9938f4fef`
ma potwierdzone 137438953472 B / 16000000000 NanoCPU. Build aplikacji
120001 ms, exit0; snapshot
`89d8507532033820afcf3c15c7983173872b33e4cc0c3ecd95b0d421478ef14e`
zawiera poprawkę granic cylindra. API zdrowe, runtime Ready, compute node
current; te ostatnie obserwacje należy odświeżyć przed Solve.

Odtworzony stary model to **mesh two spheres probe**, run
`run-live-0886fe253e920e06d153e3ef2d2ba2867b3420140f862e8f9744d230be984484`.
Jedyny Stop, intent `cofeb-master-retire-spheres-20261028-01`, journal
`fm-d3ee7ce2-9914-4dc5-bac4-6167e737a1a3`, completed: Cancelled, 0 kroków.
Nie uruchomiono jego Solve. CoFeB activation
`b53027ac0d0a4cc0ba6045336afc8bad` failed-confirmed **przed mutacją**:
`live_retirement_busy`, brak rozpoznania `isolated_snapshot_restore`
w whitelist ukończonego mesh workspace. Lokalny fix dodaje tylko ten
identyfikator, zachowując wszystkie pozostałe kontrole planu i runu.

Native readonly preflight wykazał, że kopia starych runów zawiera historyczne
lease rows innego ledgera oraz dodatkowe CAS obserwacji. Odrzucono pomysł
rozszerzenia terminalnego restore; szkic zachowano wyłącznie w
`/tmp/fullmag-cancelled-snapshot-terminal-draft-20261028.patch`. Nie zmieniono
native validatorów, lease rows ani pinów. Wybrano istniejące stop-idle
stop-only i recreate fresh-state, zachowujące cały poprzedni state root,
ledger oraz runtime-control jako archiwum. Poprawka hostowa dezaktywuje
wyłącznie stary bootstrap dopiero po dokładnym succeeded archive, succeeded
recreate i zachowanym uwierzytelnionym nativeDrained. Przed mutacją wykonano
review źródeł i parser AST; **bez testów**.

Kontrolowany stop/fresh recreate, CoFeB mesh, 10 kroków i browser/WebGL
pozostają w tym checkpointcie **NOT VERIFIED**. Nie wolno powtórzyć Solve
ani starej aktywacji na podstawie niejednoznacznej odpowiedzi.

## Kontynuacja po północy 29.10 — rzeczywiste wykonanie i nowy blocker

Stop-idle `253ab971617f43ed83240779f69adb9c` succeeded: oba kontenery exit0,
uwierzytelniony nativeDrained. Fresh recreate
`350581e06fed49cba45663c84814e7eb` succeeded: poprzedni state root, ledger
`fullmag-dev-group-ledger-v1-a1db296696d074397d19fc95` oraz runtime-control
zachowane. Qualified archive dezaktywował stary bootstrap zgodnie z nowym
guardem; start nie odtworzył starych spheres.

Development `77e17c7143a046ddb9b562d67bc46533` succeeded, config SHA256
`39a90a438d859ed0ffd2b3b5e38c3c5576908348d2ceb228237c5a38ff1b4ba5`.
Backend `c5dc30c6e4278d6d2b2fef627567f55cd0665d79083a9dde746dfafd63dadef3`,
128 GiB /16CPU, GPU required. Build 102852 ms/exit0, snapshot
`eb22d8bcd08ced7644e32a8029e4c0c907d2bb4d13efb73d2df8313a6a5a8648`.
API health ok, native Ready, compute-node current.

Jedyna nowa aktywacja `cofeb-master-gpu-20261028-restore-02`, operation
`0ea965e051da4a758f67adc1fa92d77d`, script SHA256
`c986e1d8472cca81aef393d24118f4e0dbd215e1587727d114e3a859f8045cf6`.
Bounds API potwierdziło zmax=3.108e-7m i Universe
[2.8e-6,2.1e-6,1.2e-6]m. Gmsh:1087250komórek, kontrole Jacobianów
i zgodności poprawne, zapis cache; Python/Gmsh zakończył po143489ms.
Cały etap trwał342324ms i zakończył się błędem trwałego katalogu.

Run `run-live-97479634fcbc48acbb10e4595a03ee3f9a7ab3c9dee9064f38067cf5bec5c5d9`
zapisany manual/closed; brak RunCatalog, brak Solve,0kroków. Katalog Study
CAS `0cd427c2e30959497fb6999fadf3510caddc30050e0b470cf3e1253d2d37acc0`
ma81275356B, lecz native reader używał limitu16MiB dla metadanych.
To **inny** limit niż historyczne64MiB geometrii. Aktywacja ma unknown-retained
techniczny lease; nie wolno powtórzyć POST ani usuwać markerów. API nadal działa.

Poprawka źródłowa: osobny MAX_ACCEPTED_MODEL_DOCUMENT_BYTES=256MiB
dla definition/catalog, StudyPlan pozostaje16MiB. Precommit i batch Submit
sprawdzają te same limity **przed** CAS/RunIntent. Hash,typed,project/plan
i capability walidacja zachowane; review źródłowe bezRequiredP1/P2.
Potrzebny managed drain dokładnego Ready backendu po catalog failure,
fresh-state archive i przebudowa; nowe10kroków/pola/browser nadalNOT VERIFIED.

Ocena retencji: wszystkie stare state roots, ledgery, wyniki i pakiet
rollback zachować; żadnego prune/usuwania cache. Docker VM przy recreate
miała176313122816B wolnego, przy aktywacji173392908288B. Te pomiary nie
są rozmiarem ani wolnym miejscem hostowego VHDX.

## Odczytowa kwalifikacja restartu po błędzie katalogu

Istniejący abort_pending_preparation rozszerzono o jawny `--catalog-failure`.
Nowy helper `docker_volume_catalog_failure.py` sprawdza bieżący Ready owner,
pin, żywe schedulery, build/store/API identity, exact session/script, zero
solver_steps i pusty journal komend. Kolejka zawiera jeden dokładny wpis
`pending_materialization`; jest to projekcja RunIntent bez RunCatalog, a nie
praca solvera. Zablokowano wszelkie obce/paginowane wpisy, claim/attempt/resource.
Store pod blokadą musi mieć wyłącznie manual RunIntent, bez start_release,
task/admission/output state oraz bez aktywnych rezerwacji/lease. Wariant zachowuje
stary marker i receipt bajt w bajt, wymaga prawdziwego nativeDrained po stopie
i pozwala następnie wyłącznie na archiwizację fresh-state.

Pierwszy readonly preview odmówił **przed sygnałem**, bo raw SHA ledgera
zmieniał się przy każdej próbce compute-node. Dwa odczyty Ready/store
potwierdziły różnicę tylko ledger_sha256; dwa surowe dokumenty ledgera
potwierdziły zmianę wyłącznie runtime_state.snapshot_sha256. Dla CF dodano
kanoniczny fingerprint wszystkich pól z pominięciem wyłącznie tego wskaźnika;
readiness, owner, policy i wszystkie rezerwacje nadal porównywane ściśle,
a raw SHA nadal zachowany w dowodach. Pozostałe ścieżki nie zmieniają porównania.

Preview po korekcie passed: SHA256
`8422bc336a2b9be0d7f00ce5e0fa4c5b45e2422bd97eb026c7e1c23a74a73ae1`,
store_mode `unmaterialized_catalog`, stop_applied=false. Review źródeł
i parsery AST modułów oraz guest probe bez błędów; bez testów.
Właściwy managed stop jest w toku; nie wolno powtórzyć go bez odczytu
jego preflight/native drain i stanu kontenera.

CF drain wykonany: stopped-awaiting-fresh-archive, backend exit0/noOOM,
oba schedulery exited_success; genuine native drain SHA256
`60a23d7d53132b7f1cb1ed118343b13212b0c4b99501cfaf06e0c5e592fb6ab0`.
RunIntent hash `ab45df8ea183d7a02e5748df3ee489f4258c9e09262c01de68dd01af08de6838`
niezmieniony, run directory zawiera wyłącznie run_intent.json. Kontrolny
fingerprint ledgera `007b8bf8afbe86e35b2938f6f44a5b59689dc1b16f028cab146b58e882f395ac`
zgodny przed/po. Oryginalny receipt/marker zachowane; oryginalny helper
potwierdził techniczne zakończenie i sam zwolnił lease. Krótka kolizja
flock przy pierwszej próbie odmówiła przed intentem i sygnałem; dodano
wyłącznie dla odczytu CF ograniczone2s oczekiwania na blokadę.
Następny krok: fresh archive tej generacji i build poprawionego budżetu.

## Wynik końcowy tej kontynuacji

[Odbiór29.10.2026](2026-10-29-cofeb-master-runtime-result.md): native/API Completed10FEMGPUdouble/strict, mesh1087250, pola m/H_demag/H_eff source_step10 i finite, widoczny render/WebGL potwierdzone. API i frontend pozostają uruchomione. Zachowano oddzielną niespójność scalar telemetry step0 oraz historyczne odmowy opisane powyżej.
