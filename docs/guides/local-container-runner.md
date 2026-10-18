# Lokalny runner kontenerowy

## Obecna architektura i ograniczenia

Jeden stały `Fullmag_build_runner` posiada kolejkę SQLite, API i dostęp do Docker
Engine. Windows jest klientem: rozwiązuje worktree/storage, przygotowuje niezmienną
kapsułę kodu i zgłasza job. Koordynator uruchamia osobny kontener builda z katalogu
profili. Tylko jeden ciężki job może zajmować slot; praca edytorów na innych
worktree nie wymaga zatrzymywania bieżącej kompilacji.

Socket Docker jest szerokim uprawnieniem zaufanego operatora. API wymaga bearer
tokena i jest publikowane tylko na `127.0.0.1:48765` (domyślnie, konfigurowane przez `FULLMAG_RUNNER_PORT`); nie wystawiaj go do LAN.
Token pozostaje w lokalnym storage, nigdy w repozytorium ani w payloadzie joba.
Worker nie otrzymuje socketu/tokena, `.env` ani checkoutu hosta. Ma UID 65532,
rootfs readonly, ograniczenia CPU/RAM/PID oraz prywatne katalogi wykonania.
Sieć workera służy pobieraniu zależności. To nie jest izolacja niezaufanych PR.

Stan wdrożenia: koordynator uruchomiony i API sprawdzone; testy modułów przechodzą.
Pełny build FEM CPU release potwierdzono terminalnym sukcesem kolejki, receipt
i hashami 109 artefaktów; źródła i obrazy są zapisane w
[checkpointcie](../superpowers/plans/2026-09-11-local-runner-implementation-status.md).
Crash/restart aktywnego workera, FEM GPU, uruchomienie aplikacji, kwalifikacja
naukowa i wydania pozostają **NOT VERIFIED**.
Nie nadawaj etykiety `fem-managed` na podstawie samego startu kontenera.

## Konfiguracja i obsługa

Hostowe `FULLMAG_PROJECT_STORAGE_ROOT` pozostaje w `.env` głównego checkoutu.
Nowy worktree korzysta z resolvera i rejestru, nie potrzebuje kolejnego runnera
ani własnego `.env`. Konfiguracja kontenera i profili jest współdzielona.

```text
just runner-coordinator-image
just runner-container-configure sha256:<image-id-koordynatora>
just runner-container-start
just runner-container-status
```

Pole `allowed_profiles` w konfiguracji i odpowiedzi `container-configure` jest
żądaną, zapisaną listą dozwolonych profili; samo `configure` nie kontaktuje się
z działającą usługą ani jej nie przeładowuje. Odpowiedź zawiera wtedy
`profile_activation.status = unverified`, listę `desired_allowed_profiles`,
`observed_allowed_profiles = null` i przyczynę. Dla zgodności `allowed_profiles`
pozostaje nazwą skonfigurowanej listy; nie oznacza profili aktywnych w procesie.

`container-status` najpierw atestuje dokładną tożsamość kontenera, a dopiero
potem wykonuje jedno uwierzytelnione, ograniczone czasowo `GET /health` dla
działającego kontenera. `profile_activation` pokazuje listy żądaną i
zaobserwowaną oraz status `active`, `mismatch` albo `unverified`. `active`
oznacza zgodność zbiorów profili z health; nie oznacza gotowości workera ani
akceptowania zadań. Te informacje nadal są raportowane oddzielnie w `health`.
Brak, błąd lub niepoprawna lista health daje `unverified`; brakująca usługa albo
zatrzymany kontener również nie potwierdza aktywacji.

`container-start` oraz start po kontrolowanej wymianie sprawdzają allowlistę
uwierzytelnionym health przed zgłoszeniem aktywacji. Przy mismatchu lub braku
potwierdzenia start kończy się czytelnym błędem i nie zatrzymuje ani nie usuwa
kontenera automatycznie. Nowy start ponawia brakujące potwierdzenie najwyżej
trzykrotnie, z istniejącym 10-sekundowym timeoutem każdego odczytu health;
nie czeka bez ograniczenia. Start wcześniej zatrzymanego kontenera może wznowić
jego istniejącą kolejkę, lecz żądane profile uznaje za aktywne dopiero po
zgodnym odczycie health. Aby zastosować zmienioną allowlistę w działającym
koordynatorze, najpierw jawnie go wstrzymaj i opróżnij kolejkę, a następnie użyj
`runner-container-replace`; `configure` ani `start` nie wykonują takiej wymiany.

Obraz workera powstaje z istniejącego, świadomie wybranego obrazu toolchaina:
`just runner-build-image <lokalny-tag-toolchaina>`; sprawdź jego immutable ID,
a następnie `just runner-configure-build fem-cpu-release sha256:<image-id-workera>`.
Sama obecność profilu w katalogu nie oznacza konfiguracji obrazu ani walidacji.

Dla pełnego stosu modalnego CPU z `CPU_MFEM_ONLY=1` recepta musi mieć sieć
na pobranie przypiętych źródeł i pakietów, np.
`just runner-build-image <zweryfikowany-lokalny-tag> <nowy-tag-workera> 1 default`.
W Docker BuildKit wartość `bridge` nie jest poprawną opcją build network.
Sprawdź immutable ID tagu bazowego przed wywołaniem; surowy image ID
`sha256:...` w `FROM` może zostać zinterpretowany jako nazwa repozytorium,
więc użyj osobnego lokalnego aliasu przypiętego do tego sprawdzonego obrazu.
Nie zastępuje to kontroli końcowego immutable ID workera.

Przy prefix-based PETSc/SLEPc usuń odziedziczone `PETSC_ARCH` przed
konfiguracją SLEPc i nie przekazuj `PETSC_ARCH=` jako argumentu poleceń
`make` SLEPc. Własny build PETSc nadal jawnie używa `PETSC_ARCH=arch-linux-cpu`.
Configure wybiera tymczasowy katalog `installed-arch-...`; command-line
pusta wartość nadpisuje ten wybór i powoduje brak `slepcrules`/`slepcconf.h`.
Procedura wynika z [instrukcji SLEPc](https://slepc.upv.es/release/documentation/manual/intro.html#prefix-based-installation).
Nie zmienia to kontraktu uruchomieniowego: po instalacji API używa jawnego
prefixu CPU, a attestacja weryfikuje rzeczywiste pliki i konfigurację bibliotek.

Zaufany executor pochodzi z obrazu koordynatora, nie z kapsuły workera.
Po zmianie środowiska runtime-v2 lub walidacji receiptów aktualizuj oba obrazy
w pustym, zapauzowanym slocie. Przed wymianą porównaj źródła wdrożonego
executora; zachowaj działającą obsługę pozostałych profili i atestowanych
ograniczonych instancji managed browser. Nie przenoś kodu nieznanego
pochodzenia ani lokalnych sekretów. Po wdrożeniu sprawdź health, profile,
źródła executora i stan kolejki, a następnie jawnie wznów FIFO.
Aktualnie konfigurowana trasa to FEM CPU; FEM GPU/FDM CPU wymagają osobnych dowodów.

Z wybranego, zarejestrowanego worktree:

```text
just runner-build snapshot fem-cpu-release
just runner-build commit fem-cpu-release <pelny-commit-sha>
just runner-status <job-id>
just runner-logs <job-id>
just runner-wait <job-id> 30
just runner-cancel <job-id>
```

Snapshot obejmuje pliki śledzone i usunięcia. Nowe wejścia trzeba jawnie wskazać:

```text
python scripts/local_runner_cli.py --worktree <absolutny-worktree> submit --operation build --profile fem-cpu-release --source snapshot --include-untracked <plik-wzgledny>
```

Dłuższy jawny wybór można przekazać istniejącej recepcie jako manifest UTF-8 JSON:

```text
just runner-build snapshot fem-cpu-release "" <absolutny-manifest-json>
```

Manifest jest tablicą unikalnych, niepustych ścieżek względem checkoutu, np.
`["crates/fullmag-runtime-control/src/study_completion.rs", "packages/fullmag-py/src/fullmag/runtime/transport_identity.py"]`.
Klient czyta go raz (do 64 KiB i 1024 wpisów); dotychczasowy mechanizm capture
sprawdza ścieżki, politykę wyłączeń, zawartość i wyścigi. Manifest nie wybiera
obrazu, komendy ani mountów. Tryb commit odrzuca ten argument. Domyślne
wywołanie bez manifestu nadal obejmuje wyłącznie dotychczasowy wybór.

Wstrzymaj edycje wszystkich agentów na czas capture. Zmiana podczas kopiowania
odrzuca zgłoszenie. Po utworzeniu kapsuły można dalej edytować branch; build
otrzymuje kopię, a nie późniejszy stan ścieżki. SHA kapsuły i natywna tożsamość
`fullmag.source-snapshot.v2` są różnymi, powiązanymi dowodami.

Kopia wykonania musi otrzymać świeże mtime plików, a nie czasy z chwili capture.
`materialize_capsule` kopiuje bajty przez `copyfile`, odtwarza tryby z manifestu
i sprawdza size/SHA. Dzięki temu starsza oczekująca kapsuła nie dziedziczy
pozornej aktualności zależności z później zapisanej wspólnej pamięci Cargo/Make
przy stałej ścieżce `/workspace`. Kapsuła i cache pozostają niezmienione.
Regresja tej poprawki przeszła lokalnie; produkcyjne wdrożenie pozostaje
**NOT VERIFIED**, dopóki nowy obraz koordynatora nie dostarczy poprawionego
`/runner/build_entrypoint.py` i pełny build nie przejdzie. Zmiana skryptu
wyłącznie w kapsule nie aktualizuje trusted entrypoint. Nie kasować targetu
ani nie przerywać aktywnego joba jako obejścia tej usterki.

Nieśledzone wymagane wejście pominięte w kapsule jest błędem, nie cichym buildem
starszej wersji. Nie kopiuj całego `.env`. Jawne gitlinki zewnętrznych solverów są
odnotowane, ale niematerializowane; operacja potrzebująca tych źródeł wymaga
odrębnej obsługi. Po niejednoznacznym timeout API sprawdź listę jobów i request key
przed ponowieniem. Timeout `wait` nie anuluje builda.

`runner-container-stop` oznacza pauzę przyjmowania zadań i dokończenie aktywnego
builda, nie zabicie kontenera. `runner-container-resume` wznawia kolejkę.
Jeśli trwa jeszcze drain po `stop`, odpowiedź ma `resumed=false`: poczekaj na
zakończenie workera i ponów `resume`. Marker pauzy pozostaje wtedy aktywny;
nie uruchamiaj dodatkowego koordynatora.
`runner-container-replace sha256:<nowy-image-id>` wymaga potwierdzonej pauzy i braku
aktywnego joba; wymienia wyłącznie własny, dokładnie sprawdzony kontener, bez
usuwania storage. Samo `configure` nie podmienia istniejącej instalacji.
Zdrowie API i stan wykonawcy są oddzielne: sprawdzaj `accepting_jobs`,
`worker_alive`, błąd oraz stan kolejki, nie tylko Docker `running`.

### Zewnętrzna referencja BORIS CPU — profil źródłowy

`boris-cpu-v1` jest osobnym profilem buildu zewnętrznej referencji, a nie
backendem Fullmaga. Implementacja źródłowa nie aktywuje go w operatorowym
katalogu. Istniejące profile i ich receipt zachowują dotychczasowy kontrakt.

Zamrożone bundle zależności przygotowują offline toolchain przez:

```text
just runner-boris-toolchain-context <bundle-deb> <bundle-wheel> sha256:<base-image-id>
just runner-boris-toolchain-image <zwrócony-context> fullmag/boris-toolchain:<prywatny-tag>
```

Producent `scripts/local_runner/boris_toolchain.py` wybiera 17 bibliotekowych
pakietów APT z locka, sprawdza domknięcie zależności i bazowe inventory, odmawia
usunięć/upgrade i używa wyłącznie lokalnego cache archiwów. Dziesięć przypiętych
wheels jest rozpakowywanych bez pip do `/opt/fullmag-boris-python`;
NumPy 2.2.6 z `/usr/local/lib/python3.10/dist-packages` zachowuje wersję i hash.
Matplotlib 3.8.4 używa wheels upstream budowanych przeciw NumPy 2;
rzeczywisty import i Agg stanowią bramkę preflight. Dockerfile.boris-toolchain
używa lokalnego frontendu, sieci none i finalnego USER 65532:65532.
Helper sprawdza lokalny alias niezmiennej bazy przed i po buildzie oraz
prefiks RootFS layers; terminalny receipt wiąże source/context, lock i wheel
manifest. Konteksty i dowody pozostają w storage D.

Build przez `just` zakończył się 2026-10-11 obrazem
`sha256:dd3441d07c3aa19fe1e4a206c2926b42c89899a59bbc517eb890bd99657b079e`.
Receipt `windows-native/boris-image-8ea0710662644c49820179099d46fd90/terminal-receipt.json`
ma status SUCCEEDED_IMAGE_ONLY. Osobny
`reviews/boris-toolchain-final-image-v3/results/runtime-preflight.json`
potwierdza import dziesięciu prywatnych modułów, niezmieniony NumPy, ścieżki
FFTW3/X11/TBB, Python embedding flags i Agg PNG jako UID 65532, readonly,
bez sieci, z limitem 2 CPU/1 GiB/128 pids. Jest to
TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED. Nie aktywowano profilu operatora;
kolejka i istniejące profile pozostają zachowane. Kontrakt i granice dowodu:
[nota 0970](../physics/0970-spin-hall-drift-diffusion-transport.md#boris-offline-toolchain-provisioning).

Przypięty source-image wymaga rzeczywistego zachowanego preflight kontenera:

```text
just runner-boris-image-context <checkout-BORIS> sha256:<toolchain-image-id> <runtime-preflight.json> <toolchain-context> <pełny-container-id>
just runner-boris-image <zwrócony-source-context> fullmag/boris-cpu:<prywatny-tag>
```

Receptura przekazuje dodatkowo `--repo-root`; CLI `prepare-image-context`
wymaga wszystkich sześciu flag. JSON musi odpowiadać rzeczywistemu outputowi
bind mountu `/proof` terminalnego UID65532 readonly/network-none kontenera,
z dokładną komendą preflight i exit 0. Helper odtwarza frozen dependency/wheel
admission oraz wiąże context/lock/manifest, image i pełny container ID.
Sam image ID lub caller JSON nie dowodzi preflight.

`boris_cpu.py::prepare_context` wymaga czystego checkoutu
`048503d2ca6475e91b073eb1762ecf9d3634c3e1` pod storage D. Git clean-filter
identities dopuszczają deklarowaną politykę CRLF; manifest przypina dokładne
checkout bytes i SHA256 każdego pliku. Kontekst zachowuje źródła, helper,
Dockerfile i toolchain proof/inspect/context/container. Producent odmawia
drift, symlinków i nieoczekiwanych plików. Build jest offline, finalny
USER 65532:65532, z walidacją źródeł w obrazie; nie kompiluje BORIS.

Rzeczywisty build przez `just` ma exit 0 i image
`sha256:545279e00703d60dcaf33d455461ba90e0dea7ec5647e96392bbc9246c21b6a6`.
Receipt i osobny `root-source-readback.json` są pod
`windows-native/boris-source-image-b5ffb0df863d47f5b76ff5e2d4af4e2c/`.
Niezależny readback UID65532, readonly/network-none, bez bind mountów,
1 CPU/512 MiB/32 pids, exit 0, sprawdził `verify_source`: 1133 plików,
26427761 bajtów, source-tree SHA256
`0d0d924321c6b0d664f3e862a7a73d7c31a1c4c14d2a7f973b6238e2a58161a6`,
NumPy 2.2.6 i Matplotlib 3.8.4. SUCCEEDED_SOURCE_IMAGE_ONLY oraz
SOURCE_AND_TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED nie oznaczają solver build PASS.
Dziewiętnaście interpretowanych regresji producenta PASS obejmuje actual
Git CRLF clean-filter capture; kompilacja, ABI i solver nie zostały wykonane.

Po opisanym provisioningu/readback oraz odrębnym jawnym opt-in operatora
`just runner-boris-build commit <pełny-SHA-Fullmaga>` zgłasza build do tej samej
kolejki. Konfiguracja koordynatora wymaga `--enable-boris-cpu`; profil workera
musi wskazywać niezmienny obraz z przypiętymi źródłami. Aktualizacja operatora
wymaga zabezpieczenia kontenerowej blokady claim oraz potwierdzonego zatrzymania
dokładnie atestowanego koordynatora. Sama pauza i blokada hosta Windows nie
wykluczają równoczesnego claim po stronie Linux. Nie zmieniaj konfiguracji
ani obrazu w trakcie cudzego buildu; rzeczywista procedura przejścia pozostaje
**NOT VERIFIED**.

Worker stosuje stały overlay CPU, kompiluje źródła C++ i sprawdza zależności
ELF. Receipt wiąże obraz, kapsułę Fullmaga, oryginalne źródła, overlay i binarium.
Sukces kompilacji nie dowodzi precyzji wykonania ani poprawności adaptera.
Provisioning toolchaina i jego preflight mają powyższy ograniczony dowód PASS.
Terminalny build BORIS/witness ABI, admission rzeczywistego runtime
i nowe porównanie naukowe pozostają **NOT VERIFIED**.

Źródłowa ścieżka `just run-managed-boris-nf <job-id> coarse|medium|fine`
wymaga terminalnego udanego buildu tego samego worktree i aktora, czterech
trusted dokumentów, zgodnej kapsuły, przypiętych źródeł BORIS i dowodu ABI.
Uruchamia jeden stały scenariusz N/F w kontenerze CPU z wyłączoną siecią,
read-only wejściem, ograniczonym eksportem i obowiązkowym rzeczywistym exit 0.
`just observe-managed-boris-nf <runtime-id>` ponawia cały łańcuch i kontrolę
zachowanego kontenera oraz payloadów; nie uruchamia nowego solve.
Publiczny verifier v2 wymaga jawnego kontekstu repozytorium i kanonicznego
artefaktu. Pole `identity_complete` w przekazanym JSON samo nie daje admission.

Kontrole interpretowane ścieżki runtime po poprawce publikacji: 56 testów i 45 podprzypadków PASS;
parser oraz validator noty 0970 PASS. Są to dowody źródeł, bez uruchomienia
BORIS, producenta ABI lub nowego benchmarku. Rzeczywista kwalifikacja nadal
wymaga terminalnego buildu BORIS i wykonania porównań.

### BORIS: osobne narzędzia runtime V2

`just run-managed-boris-nf-v2 <job-id> coarse|medium|fine` jest oddzielnym,
synchronicznym konsumentem udanego buildu `boris-cpu-v1`. Nie kompiluje C++,
nie buduje obrazu, nie instaluje wheels i nie zmienia profili ani stanu kolejki.
Przed uruchomieniem operator musi ustanowić okno idle/paused bez aktywnych
jobów, retencji lub innych kontenerów obliczeniowych. Recepta sprawdza to
przed dispatch, podczas oczekiwania i przed terminalną publikacją; sama nie
wywołuje pause, resume ani zatrzymania obcych kontenerów.

`run_managed_boris_nf_v2.py::resolve_native_build` niezależnie wiąże managed
job, aktora/worktree, cztery trusted pliki, pełną niezmienną kapsułę oraz
`validate_build_receipt` (binarka, upstream, flagi, CPU ABI, obraz i native
source identity). Nie porównuje nowych narzędzi hosta ze starymi narzędziami
w kapsule. Nowy manifest `fullmag.boris.runtime-tools.v1` wiąże osobno pełny
zestaw importowanych narzędzi hosta, w tym publiczny consumer tożsamości;
`solver_capsule_attribution=false` jawnie rozdziela ich pochodzenie.
Nie ma fallbacku po odmowie starego guarda `source_hashes`.

Worker nadal jest niezmienionym `_worker` z kapsuły starego buildu pod
`/source/scripts/run_managed_boris_nf.py`; wejście/scenariusz i jego bramki
native/ABI/raw output pozostają obowiązkowe. Specyfikacja V2 udostępnia prywatne wheels przez `PYTHONPATH`:
`/source/scripts:/opt/fullmag-boris/source:/opt/fullmag-boris-python`.
Ostatni katalog udostępnia prywatne wheels z istniejącego obrazu; pominięcie
go w V1 zasłaniało zainstalowany Matplotlib. Nie dodaje się pakietów ani
nie zmienia bibliotek dynamicznych binarki.

Dodatkowa jawna zależność `fullmag.boris.embedded-wrapper-support.v1` wiąże
`EmbeddedPythonWrapper.py` z original_source dokładnego native buildu.
Plik pochodzi wyłącznie z jego `execution/boris-cpu-source`, ma przypięty
upstream/SHA/rozmiar i jest ponownie sprawdzany przed startem, po run oraz
przez observer. Producent native85 pominął go w paczce siedmiu OUTPUTS;
nie dopisuje się pliku do starej paczki ani nie zmienia jej receipt/binarki.
Spec montuje siedem istniejących OUTPUTS osobno RO i wrapper jako osobny
plik RO pod `/boris/EmbeddedPythonWrapper.py`, bez parent bind `/boris`.

Wrapper upstream nie ma `StdoutCatcher.flush()`, mimo `print(..., flush=True)`
w stałym scenariuszu. Adapter `fullmag.boris.stdout-flush-noop.v1` dodaje
wyłącznie pustą metodę flush, zachowując wszystkie pozostałe oryginalne bajty
CRLF. Dla przypiętej ścieżki GRAPHICS=0 write przechodzi synchronicznie przez
BPython do `std::cout << text << std::endl`, więc dodatkowego bufora do opróżnienia
nie ma. Receipt zachowuje osobno oryginalny i wynikowy SHA/rozmiar oraz SHA
wstawionych bajtów; wynik nie udaje exact original_source. Nie monkeypatchuje
się scenariusza ani sys.stdout. Worker/scenariusz i wszystkie native/fixed-M/
headless gates są niezmienione. Runtime identity wiąże runtime_support_sha256.
Attestation kontenera ma jawny `fullmag.boris.container-attestation.v1`: wszystkie
pola Id/Image/Config/HostConfig/Mounts/State pozostają związane, a lista Mounts
jest sortowana kanonicznie, ponieważ Docker zwraca ją w kolejności iteracji mapy.
Zmiana kolejności nie zmienia znaczenia; zmiana źródła, celu lub RW nadal zmienia
hash. Dawnych receiptów z hashem niesortowanej listy nie przepisuje się.
Historyczne failed receipty pozostają bez zmian; nowy tools manifest dotyczy
wyłącznie nowego run i nie jest fallbackiem po ich odmowie.

Receipt nowej trasy ma `fullmag.boris.managed_run.v2`, a publiczna tożsamość
`fullmag.boris.runtime.v3` (runtime.v2 jest już zajęte przez starą trasę).
Wszystkie stare receipty i stary guard pozostają niezmienne. Zmieniony host
nadal może być odrzucony przez V1; nie wolno przenosić takiego runtime do V2
przez zmianę JSON. Nowy run musi otrzymać nowe ID i własne tools/input/export.
Nowy observer rekonstruuje wyłącznie spec V2, ponawia native/tool/container
bindings, sprawdza surowe wyjścia i niezależnie przelicza summary.

`runtime_package_use` obejmuje cały run aż do terminalnej publikacji.
Przed dispatch nowy katalog jest rejestrowany przez istniejący mechanizm
reference roots. Receipt zawiera rozpoznawalne `runtime_job_id`; ponieważ
nowy schema nie jest jeszcze dopuszczony do automatycznej retencji, istniejący
planner odmawia usuwania przy takim nieznanym consumerze. Nie rozszerza się
allowlisty retencji i nie usuwa tej ochrony automatycznie po wieku lub błędzie.
Po błędzie zatrzymywany może być tylko dokładny własny ID ponownie atestowany
wobec spec. Błąd atestacji/stop pozostawia zasoby i wymaga przeglądu recovery.

`just observe-managed-boris-nf-v2 <runtime-id>` wyłącznie ponawia weryfikację
już opublikowanego terminalnego sukcesu; nie uruchamia solve i nie naprawia
nieukończonej publikacji. Przerwany/nieznany stan zachowuje dane do przeglądu.
Publiczny `validate_runtime_identity` jawnie kieruje runtime.v3 do nowego
verifiera; stare wersje zachowują dotychczasowe ścieżki i odmowy.

Kod i interpretowane regresje nie są dowodem rzeczywistego przebiegu N/F.
Wymagane pozostają rzeczywisty import z poprawionym środowiskiem, wykonanie
solwera, terminalny wynik, niezależne obserwowanie i porównanie naukowe.
Status kwalifikacji fizyki pozostaje `NOT VERIFIED`/diagnostic.

### Zatrzymanie atestowanego koordynatora pod blokadą Linux

`container-quiesce` obsługuje przejście dokładnie wskazanego koordynatora do
stanu `exited`, zachowując pauzę i kolejkę. Najpierw wymaga zakończonego drain:
API potwierdza pauzę, brak aktywnych zadań i zakończony worker; dodatkowo helper
sprawdza wszystkie kontenery oraz SQLite tylko do odczytu. Nie czeka na cudzy
build i nie zatrzymuje workerów. Aktywne lub niepewne zadanie powoduje odmowę.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-quiesce --expected-container-id <pełne-ID> --expected-image-id sha256:<pełne-ID-obrazu> --expected-public-sha256 <hash-publicznego-pliku> --expected-catalog-sha256 <hash-katalogu> --reviewed-source-sha256 <ścieżka=hash>
```

Powtórz ostatni argument dokładnie dla siedmiu przejrzanych źródeł starego
obrazu: `fullmag_storage.py`, `local_runner/build_executor.py`,
`local_runner/coordinator.py`, `local_runner/container_main.py`,
`local_runner/service.py`, `local_runner/queue.py` i
`local_runner/container_api.py`. Hashe dotyczą bajtów w starym obrazie;
bieżący checkout nie stanowi ich dowodu. Duplikaty, brak pliku, obcy hash,
niezgodna inkarnacja i zmiana konfiguracji są odrzucane przed stop.

Helper `scripts/local_runner/coordinator_lifecycle.py::quiesce_and_stop`
uzyskuje rzeczywistą blokadę Linux wewnątrz atestowanego kontenera i ponawia
kontrole pod tą blokadą. Atomowy publiczny receipt poprzedza ARM i żądanie
stop; zapisuje dokładną tożsamość, nonce/PID blokady i hashe bez tokenu ani
prywatnych bajtów konfiguracji. Dopiero potwierdzone `exited` oraz zniszczenie
procesu blokady pozwalają uznać zatrzymanie za wykonane. Helper nie zastępuje
obrazu i nie aktywuje profilu BORIS.

Niepewny ARM albo stop pozostawia stan wymagający jawnego recovery dokładnie
tego kontenera. Po ARM proces blokady nie zwalnia jej po EOF ani według wieku.
Nie zabijaj samego procesu blokady ani nie wznawiaj niepotwierdzonego
koordynatora. Ponownie sprawdź atestację oraz brak aktywnych zadań, doprowadź
do potwierdzonego wyjścia tego koordynatora i zachowaj pauzę. Zmiana konfiguracji
lub kolejki po wyjściu wymaga przeglądu przed restartem.

Dowody: 26 niezależnych interpretowanych regresji helpera PASS. Prywatna
rzeczywista próba na zamrożonym obrazie potwierdziła HELD, odmowę konkurencyjnego
Linux `flock` i zwolnienie przed ARM. Odrębny prywatny probe potwierdził
rzeczywiste ARM/disconnect: receipt
`root-armed-exec-probe-7bb51aaafca648b78e6f3f5a361ddeef/receipt.json`, SHA256
`d24aaf1fc5e6e7c9b571f24cd83f359ce036eab9b0a6bef6bc0b9a7811072b29`.
To dowód prywatnego fence; lifecycle zainstalowanego operatora nadal jest
**NOT VERIFIED**.

### Jawna wymiana zatrzymanego koordynatora

`container-replace` nadal wymaga działającego starego API. Po udanym quiesce
stosuj osobny `container-replace-exited`; helper wymaga receiptu quiesce v2
z prywatnym ograniczonym snapshotem trzech konfiguracji. Snapshot powstaje przed
ARM; publiczny receipt zawiera wyłącznie jego ścieżkę/hash. Token pozostaje prywatny.
Zmiany profilu między stop a wymianą mogą obejmować tylko zadeklarowane dodanie lub
usunięcie BORIS; pozostałe profile FEM, token, port i storage są porównywane z kopią.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-replace-exited --quiesce-receipt <receipt-v2> --quiesce-receipt-sha256 <SHA> --expected-container-id <old-full-ID> --expected-image-id sha256:<old-image-ID> --expected-container-sha256 <current-public-SHA> --expected-build-config-sha256 <current-catalog-SHA> --image-id sha256:<new-image-ID> --image-build-receipt <managed-image-receipt> --image-build-receipt-sha256 <SHA> --profile-delta unchanged
```

Dla `enable-boris-cpu` lub `disable-boris-cpu` podaj też
`--expected-boris-entry-sha256`. Zmianę profilu przygotowuje wcześniejsza konfiguracja
offline; sama wymiana zmienia wyłącznie image_id pliku publicznego. Sprawdza rzeczywisty
obraz, RootFS/Entrypoint i źródłowy readback readonly/network-none jako UID 65532.
Nowy frozen obraz musi zawierać guard runtime; starsze obrazy nie spełniają kontraktu.

Oddzielny prywatny `index/local-runner-exited-replacement/pending.json` poprzedza
rm/public-write/create/start. Pod istniejącym Linux coordinator.lock blokuje claim;
API odmawia resume (`resumed=false`, bez usunięcia pauzy) oraz przyjmowania zadań.
Strażnik blokuje też zwykłe hostowe start/configure/replace i transakcje profilu.
Uszkodzony pending również blokuje; startup ani upływ czasu go nie usuwają.
Diagnostyka pozostaje dostępna. Kolejka jest odczytywana, porównywana w całości i
pozostaje niezmieniona; helper nie zatrzymuje workerów ani nie odtwarza SQLite.

Fazy trwałe: PREPARED, REMOVE_REQUESTED, OLD_REMOVED, PUBLIC_UPDATE_REQUESTED,
PUBLIC_UPDATED, CREATE_REQUESTED, CREATED, START_REQUESTED, STARTED_PAUSED,
SUCCEEDED_PAUSED. Terminalny receipt powstaje przed usunięciem pending, które jest
ostatnim commit point. Sukces pozostawia nowego koordynatora w pauzie.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-recover-exited-replacement --transaction-id <ID>
```

Recovery kontynuuje wyłącznie do przodu. Utracony wynik create wymaga dodatkowego
`--expected-new-container-id <pełne-ID>` i pełnej atestacji; sama nazwa nie dowodzi
własności. Zmiana konfiguracji, pauzy, kolejki lub obcy kontener zatrzymuje recovery
z zachowaniem pending. Nie ma automatycznego resume, rollbacku DB ani restartu starego
obrazu. Powrót do starego obrazu wymaga osobnego kontrolowanego przejścia.
Regresje interpretowane nie kwalifikują aktualizacji operatora: rzeczywista wymiana,
nowy runtime guard i lifecycle zainstalowanego runnera pozostają **NOT VERIFIED**.

### Wyłączenie profilu BORIS i odzyskiwanie transakcji offline

`container-disable-boris-cpu` usuwa wyłącznie aktywację `boris-cpu-v1`
z pary konfiguracji publicznej/prywatnej oraz z katalogu obrazów. Wymaga
istniejącego, dokładnie atestowanego koordynatora w stanie `exited`, pełnego
odczytu kolejki bez aktywnych zadań i bez oczekujących zadań BORIS oraz braku
aktywnych workerów Fullmaga. Oczekujące zadania FEM pozostają w kolejce.
Polecenie nie zatrzymuje, nie zastępuje ani nie uruchamia kontenera.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-disable-boris-cpu --expected-container-sha256 <sha256-publicznego-pliku> --expected-build-config-sha256 <sha256-katalogu> --expected-boris-entry-sha256 <sha256-wpisu-BORIS>
```

Wszystkie trzy argumenty są pełnymi hashami SHA-256. Pierwszy oznacza hash
surowych bajtów `index/local-runner-container.json`, drugi hash surowych bajtów
`index/local-runner-build-config.json`, a trzeci hash kanonicznego wpisu
`profiles["boris-cpu-v1"]`, obliczany przez
`scripts/local_runner/boris_transition.py::entry_sha`. Hash wpisu używa JSON
z posortowanymi kluczami, separatorami `,` i `:` oraz bez NaN. Nazwa pierwszego
argumentu nie oznacza identyfikatora kontenera Docker. Nie przekazuj tokenu
ani pliku prywatnego w argumentach lub logach.

Przed zapisem powstaje prywatny journal
`index/local-runner-boris-transition/pending.json` z dokładnymi bajtami
przed/po i tożsamością transakcji oraz kontenera. Zawiera dane prywatnej
konfiguracji: na Windows katalog otrzymuje ACL bieżącego użytkownika i SYSTEM,
a na POSIX prawa 0700. Nie publikuj journala. Każdy zapis jest sprawdzany;
wyjątek powoduje próbę cofnięcia wyłącznie własnych zmian. Przerwana lub
niedająca się cofnąć transakcja pozostawia `pending.json`, który blokuje
konfigurację, start, zastąpienie kontenera oraz wybór profilu buildu.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-recover-boris-profile --transaction-id <dokładne-32-znakowe-ID> --direction before
python -B scripts/local_runner_cli.py --worktree <checkout> container-recover-boris-profile --transaction-id <dokładne-32-znakowe-ID> --direction after
```

Wybierz jeden kierunek: `before` odtwarza stan sprzed usunięcia, `after`
domyka usunięcie. Recovery wymaga tej samej zatrzymanej inkarnacji kontenera,
zgodnego operatora, ważnego journala i bieżących bajtów należących do tej
transakcji. Obca zmiana blokuje recovery i pozostaje nietknięta. Token,
obraz koordynatora, port, inne profile i kolejka zadań są zachowywane;
SQLite nie jest odtwarzane z kopii. Receipt powstaje przed usunięciem pending.
Synchronizacja plików nie stanowi dowodu odporności Windows na utratę zasilania.

Dowód źródłowy: 14 interpretowanych regresji transakcji i recovery PASS,
w tym przerwanie po każdym z trzech zapisów w obu kierunkach, obce zmiany,
niezgodna inkarnacja, aktywne zadania/workery i blokowanie konsumentów pending.
Rzeczywiste wyłączenie/odzyskanie konfiguracji operatora i przejście starego
koordynatora na nowy obraz pozostają **NOT VERIFIED**. Próba na prywatnym
pliku wykazała, że Windows `msvcrt.locking` oraz kontenerowe Linux `flock`
nie wykluczają się na tym hoście; nie używaj blokady Windows jako dowodu
zatrzymania kontenerowego claim. Te polecenia obsługują dopiero stan offline.

## Dane, zakończenie i retencja

### Sprzątanie prywatnych kopii wykonania

Koordynator udostępnia nieblokujące operacje: `POST /api/v1/retention/plans`
zwraca `plan_id` i `planning`; `GET /api/v1/retention/plans/<plan_id>` odczytuje
ten sam plan; `POST /api/v1/retention/plans/<plan_id>/apply` zwraca ACK
`accepted`. Po timeoutcie klient odczytuje istniejący identyfikator zamiast
ponawiać mutację. Raporty pozostają w `index/retention-plans` i
`index/retention-operations`. Restart z nieznanym wynikiem daje
`interrupted_unknown`, a błąd częściowy `partial`, bez deklaracji pełnego sukcesu.

Wykonawca obejmuje wyłącznie dokładne `runs/<worktree>/<job>/execution`.
Sprawdza ponownie queue/journal/receipt, digest źródeł, zachowane artefakty,
piny, blokady, znaczniki właścicieli, tożsamość drzewa i wszystkie bind mounty.
Wiążące blokady chronią zarządzanych użytkowników; procesy uruchamiane poza
zarządzanymi launcherami wymagają osobnej kontroli operatora przed cleanupem.
Link wewnątrz drzewa jest usuwany jako link, bez przechodzenia do celu.
Zakończony kontener własnego joba może zostać usunięty bez `force` i bez wolumenów
dopiero po zapisaniu wszystkich dostępnych logów w `worker-full.log` z hashem.
Niepoprawne UTF-8 zatrzymuje ten krok. Pełne archiwum wymaga osobnej, jawnie przekazanej trasy strumieniowej: limit małych odpowiedzi JSON Docker nie może ograniczać łącznego rozmiaru logów. Bounded chunks, incremental strict UTF-8 validation oraz hash/licznik dokładnych bajtów muszą poprzedzać fsync, publikację archiwum i receiptu, a dopiero potem exact rm. Przerwana ramka, błąd procesu/I/O, niepoprawny UTF-8 lub nieutrwalony receipt blokują usuwanie i zachowują wcześniejsze archiwum. Nie wolno wracać do buforowanego call(logs), readline ogromnej pojedynczej linii ani deklarować odtworzenia chronologii stdout/stderr. Format pozostaje pojedynczym worker-full.log: Unix zachowuje kolejność odebranych payload frames, Windows dotychczasowe stdout-then-stderr, po równoczesnym bounded opróżnieniu pipe do prywatnych spoolów. Żaden wariant nie deklaruje rekonstruowanej chronologii między kanałami. Po publikacji loga i receiptu POSIX wymaga sprawdzonego fsync dokładnego katalogu run_root przed rm. Windows nie ma kwalifikowanego portable directory barrier: receipt jawnie oznacza jego brak, a worker_full_log_directory_sync_unavailable blokuje rm oraz usunięcie execution, zachowując archiwum. Nie przedstawiamy file fsync jako NTFS power-loss proof. Źródła i hosted regresje Linux/Windows przeszły w GHA37985345068; rzeczywisty Docker/storage i power-loss pozostają NOT VERIFIED. Windows directory capability nadal blokuje cleanup.

Polityka `mode=automatic` włącza ten sam wykonawca pomiędzy buildami; domyślnie
pozostaje `preview`. Drain zatrzymuje przyjmowanie nowych operacji, a wymiana
koordynatora wymaga także zakończenia już przyjętej retencji. TTL źródeł,
logów i niezweryfikowanych stagingów nie jest wykonywany i jest nieaktywny w UI.
Rozmiar logiczny usuniętych drzew oraz zmiana wolnego miejsca są osobnymi polami;
zmiana miejsca może obejmować pracę innych programów i nie jest przypisywana
w całości retencji.

Stan wdrożenia i dowody:
[plan retencji](../superpowers/plans/2026-10-05-runner-storage-retention.md),
[ADR 0052](../adr/0052-runner-storage-retention.md). Obecność kodu nie dowodzi
aktualizacji uruchomionego koordynatora.

### Współdzielenie zawartości źródeł

Klient capture korzysta z `storage/cache/source-content-v1`. Klucz obiektu
obejmuje SHA-256 treści i tryb wykonywalny Git. Każda kapsuła nadal ma własny
manifest v1 i drzewo `source/tree`, lecz identyczne regularne pliki wskazują
na niezmienną zawartość przez hardlinki. Obiekt powstaje z prywatnego stagingu;
repozytorium i zapisywalne execution nigdy nie są hardlinkowane do magazynu.
Worker materializuje prywatne kopie i przywraca prawa do zapisu zgodnie z manifestem.

Publikacja i cleanup własnego stagingu używają blokady obiektu. Na Windows
atrybut readonly jest wspólny dla hardlinków; helper usuwający link stagingu
ponownie pieczętuje obiekt w `finally`. Korupcja, nieznana blokada, inny wolumen
lub niebezpieczna ścieżka kończą capture błędem. Zachowujemy dotychczasowe
manifesty i digesty; CAS nie jest objęty automatycznym prune cache. Migracja
historycznych kapsuł ma osobne zabezpieczenia i nie wynika z samego włączenia
współdzielenia nowych capture.

- `storage/runs/<worktree-id>/<capture-id>/source`: kapsuła readonly.
- `storage/runs/<worktree-id>/<job-id>/execution`: prywatna kopia robocza.
- `storage/runs/<worktree-id>/<job-id>/artifacts`: logi, receipt i wybrane wyniki.
- `storage/builds/<worktree-id>/runner-<profile>-<image-id>`: trwały target buildu.
- `storage/cache`: jawnie współdzielone zależności, chronione przed cleanupem.

Zapisywalne cache Cargo i pnpm runnera używają podkatalogu
`cache/windows/<backend>-<device>/runner-uid-65532/`, wspólnego dla jego worktree.
Nie przejmują starszych drzew tworzonych przez launchery jako root; ich danych
i uprawnień nie zmieniamy. Zainstalowany toolchain rustup pozostaje pod dotychczasową
ścieżką danego backendu; runner nie instaluje automatycznie toolchainów.

Build wykonuje natywny `make install-cli-dev`, instalację zależności frontendu
z lockfile i `make web-build-static`. Success wymaga exit 0, etapów zakończonych
poprawnie i hashy wymaganych binariów/core/web/markera. Nie publikuje automatycznie
nowego `current` ani nie zalicza testów fizyki.

Profil `fem-cpu-slepc-runtime-v1` jest osobną trasą dla produkcyjnej biblioteki
FEM CPU z PETSc/SLEPc. Trusted entrypoint uruchamia w nim wyłącznie etap
`make install-cli-dev`; nie dodaje instalacji frontendu, `CTest` ani celów
jednostkowych/kontraktowych. Receipt musi zawierać `libfullmag_fem.so`,
`source-identity.json`, marker `fem-cpu` oraz kontrakt
`fullmag.fem.cpu.slepc_runtime_contract.v1` z `FULLMAG_FEM_WITH_SLEPC=ON`,
urządzeniem CPU i precyzją double. Ten profil dostarcza artefakt runtime do
diagnostyki lub dalszego uruchomienia; `run_comsol_dispersion_benchmark.py`
akceptuje oba profile SLEPc, a źródło `fullmag-bin` i `libfullmag_fem` w trasie
runtime-only jest powiązane hashami. Sam receipt pozostaje `NOT VERIFIED` i nie
jest dowodem CTest ani kwalifikacji fizycznej.

Profil `fem-cpu-slepc-runtime-v2` oddziela ABI trasy CPU: obraz zawiera drugi
MFEM v4.10 zbudowany bez CUDA pod `/opt/fullmag-mfem-cpu`, a natywny klient FEM
jest kompilowany z `FULLMAG_ENABLE_CUDA=OFF`. Trusted receipt wymaga zarówno
`MFEM_DIR` z tego prefiksu w cache CMake, jak i rzeczywistego `libmfem.so`
rozwiązanego przez loader z tego samego prefiksu; zapisuje ścieżkę i hash
biblioteki w `cmake-attestation.json`. Profil v1 pozostaje dostępny dla
historycznych wyników. v2 nie stanowi dowodu naprawy ABI, dopóki nowy obraz,
managed build, pomiar pamięci i pilot nie przejdą weryfikacji.


Żądany profil runtime-v2 zapisuje się przez
`container-configure --image-id <immutable-coordinator-id> --enable-slepc-runtime-v2`.
Zachowuje istniejące profile, token oraz ustawienia operatora; ponowienie nie
powiela wpisu. Późniejsza konfiguracja current-contracts również zachowuje
profile wcześniej dodane przez operatora, ale nie zmienia listy już wczytanej
przez działający proces. `container-status` rozróżnia wtedy skonfigurowaną listę
od listy zgłoszonej przez health. Zastosowanie zmiany wymaga jawnej wymiany
koordynatora po graceful pause i opróżnieniu aktywnej kolejki; nie anuluje się
w tym celu cudzych jobów. Po wymianie klient sprawdza, czy nowy proces zgłasza
dokładnie żądaną listę.

Ponieważ CUDA-enabled `libfullmag_fem` może zachować transitive
`libcuda.so.1` także w CPU lane, trusted post-build probe dodaje wyłącznie
image-owned `/usr/local/cuda/compat` do `LD_LIBRARY_PATH`, gdy zawiera
loadable SONAME. Nie włącza to GPU ani nie zmienia resolved device; zapis
`cuda_driver_compatibility_paths` w `runtime-attestation.json` dokumentuje
ścieżkę loadera używaną tylko do tej attestacji. Usługa `fem-modal-cpu` ma
ten sam jawny compatibility path, lecz nie żąda urządzenia Docker GPU.

Przy mniej niż 8 GiB wolnego miejsca job pozostaje w kolejce. Nie jest to twarda
kwota dyskowa: pojedynczy etap może zużyć więcej miejsca. `runner-retention-plan`
jest **tylko podglądem**. Rozważa własne terminalne execution po 24 h dla sukcesu
i 7 dniach dla failure/cancel; pin, niespójna tożsamość i niebezpieczne ścieżki
chronią dane. Nie usuwa źródeł, cache, logów ani artefaktów.
Destrukcyjne apply zostało zatrzymane przez kontrolę uprawnień i nie jest wdrożone.
Nie stosuj globalnego prune jako obejścia.

Po konfiguracji kontenera stare `run-once/reconcile`, hostowe sondy zapisujące
SQLite i bezpośrednie ciężkie buildy tej wersji launchera są odrzucane. Starsze
worktree mogą mieć stare launchery: sprawdź procesy/kontenery przed ich użyciem.
Recovery zachowuje niejednoznaczny lease; nie przejmuje go na podstawie wieku.

## Historyczny etap diagnostyczny — nie używać do nowej konfiguracji

Status: **zaimplementowany wykonawca diagnostyczny `verify-source`**.
Nie jest to jeszcze wykonawca buildu Fullmaga ani kwalifikowany runner FEM.
Pełny zakres pozostaje w [zatwierdzonym projekcie](../superpowers/plans/2026-09-11-local-container-runner-design.md).

## Obecny kontrakt

Host Windows wybiera zarejestrowany worktree i storage przez istniejący resolver.
Klient tworzy kapsułę `tree/` + `manifest.json`; kolejka przechowuje jej digest,
nie obietnicę uruchomienia późniejszego stanu katalogu. Jeden aktywny job zajmuje
slot także po awarii obserwatora. Nie odbieramy lease na podstawie wieku.

Wykonawca korzysta wyłącznie z lokalnego endpointu Docker Desktop `desktop-linux`.
Operator osobno rejestruje niezmienny image ID; job nie wybiera obrazu, mountów,
polecenia powłoki ani endpointu. Kontener działa jako użytkownik nieuprzywilejowany,
bez sieci, socketu Dockera, dodatkowych capabilities i zapisu do źródeł/builda.
Zapisywalne są wyłącznie artefakty konkretnego joba i ograniczony `/tmp`.

To interfejs **zaufanego lokalnego użytkownika**, nie uwierzytelniony serwer dla
niezaufanych agentów/GitHuba. Osoba mogąca modyfikować pliki koordynatora, konfigurację
lub bazę jako ten sam użytkownik OS pozostaje wewnątrz granicy zaufania. Pole `owner`
nie zastępuje ACL, osobnego konta usługi ani uwierzytelnienia zewnętrznych żądań.

## Użycie diagnostyczne

Z wybranego worktree:

```sh
just runner-image
# Odczytaj pełne Id z docker image inspect fullmag/local-runner-source:development.
just runner-configure sha256:<pelny-image-id>
just runner-doctor
just runner-submit commit <pelny-commit-sha>
just runner-once
just runner-status <job-id>
just runner-logs <job-id>
just runner-wait <job-id> 30
```

`runner-submit snapshot` uwzględnia bieżące pliki śledzone i usunięcia. Nowe pliki
wymagają jawnego `--include-untracked` w kliencie Python. Przykładowy układ argumentów:
`python scripts/local_runner_cli.py --worktree <absolutny-worktree> submit --source snapshot --include-untracked <sciezka-wzgledna>`.
Na czas capture trzeba wstrzymać edycję źródeł; kontrola przed/po wykrywa wiele wyścigów,
ale nie ustanawia atomowej migawki dowolnego aktywnego edytora.

Polityka kapsuły wyklucza administracyjne metadane narzędzi, `.env` i rozpoznane pliki
poświadczeń; nie jest skanerem gwarantującym wykrycie sekretów wpisanych w zwykły kod.
Sześć jawnie wymienionych gitlinków `external_solvers` jest odnotowanych wraz z pinem,
bez materializacji zewnętrznych solverów. Taka kapsuła nie może kwalifikować operacji,
która potrzebuje tych źródeł. Pozostałe submoduły, LFS i nieobsługiwane dowiązania
muszą zostać odrzucone, nie pominięte bez informacji.

Powtórzenie `--request-key` z tym samym digestem zwraca ten sam job. Nowa kapsuła
kontrolna utworzona podczas retry pozostaje w storage; brak automatycznego prune.
Zmiana źródeł przy tym samym kluczu jest konfliktem, a nie cichą podmianą zadania.

## Anulowanie i awarie

`runner-cancel` anuluje oczekujący job albo zapisuje żądanie dla działającego.
Koordynator sprawdza pełny ID i etykiety przed zatrzymaniem własnego kontenera.
Timeout `runner-wait` nie anuluje joba. Oczekiwanie nie trzyma blokady worktree.

Po utracie obserwatora użyj `runner-reconcile <job-id>`. Reconciliacja potwierdza
persisted container ID, obraz i stan terminalny; może zrealizować już zapisane
anulowanie właściciela. Nie restartuje kontenera, nie usuwa go i nie przejmuje
lease wyłącznie na podstawie czasu. Brak zapisanego ID po niejednoznacznym create
wymaga osobnego ręcznego rozstrzygnięcia — nie wolno globalnie czyścić kolejki.

Dla udokumentowanego odrzucenia komendy **przed kontaktem z daemonem**, po
potwierdzeniu zakończenia procesu wysyłającego, operator może użyć klienta
`acknowledge-uncreated <job-id> --confirm-no-create-request-in-flight --reason <dowod>`.
Wymagane są brak persisted container ID oraz brak kontenera o dokładnej nazwie;
powód pozostaje w journalu. To jawne potwierdzenie operatora, nie automatyczny
mechanizm recovery dla niejednoznacznego timeoutu.

Kontenery zakończone, logi i kapsuły pozostają do audytowalnego cleanup. Nie używamy
`docker system prune` ani usuwania współdzielonych cache. Brak poprawnego receipt
oznacza failure nawet wtedy, gdy Docker zwrócił exit code 0.

## Jeszcze niekwalifikowane elementy

### Przeglądarka z gotowego pakietu CPU

`just run-managed-browser <pełny-job-id> <pełny-commit> 3104` uruchamia
backend API i statyczny Control Room z terminalnego, udanego pakietu
`fem-cpu-release`. Nie kompiluje, nie instaluje zależności i nie uruchamia
solvera. Wymaga zachowanej kapsuły źródeł, kompletnych artefaktów i lokalnego
obrazu o digestcie zgodnym z receiptem buildu.

Tryb `run-managed-browser` nadal wymaga clean commita i kapsuły `commit`.
Dla dokładnego WIP użyj osobnej recepty:
`just run-managed-browser-snapshot <pełny-job-id> <pełny-commit> <source-digest> <native-snapshot-sha256> 3104`.
Digest kapsuły oraz snapshotu natywnego są dwoma różnymi hashami SHA-256
(64 małe znaki hex, bez prefiksu); oba muszą zgadzać się z terminalnym
receiptem. Commit jest pełnym bazowym SHA-1 (40 znaków), nie tożsamością WIP.
Brak jednej z tożsamości, niezgodność, zły tryb kapsuły lub niezgodny
clean/dirty startup stamp powoduje odmowę. Artefakty i trusted documents
weryfikuje ten sam pełny validator, bez pomijania kontroli dla snapshotu.
Ta dodatkowa trasa nie kwalifikuje storage 9p i nie uruchamia solvera.

Launcher ponownie sprawdza kapsułę, trusted documents, wymagane artefakty,
startup stamp i rzeczywiste mounty/port kontenera. Źródła oraz pakiet pozostają
read-only. Świeży katalog stanu w storage zawiera również prywatny widok repo
z linkami do źródeł oraz zwykłym katalogiem `.fullmag`, który jest również
`FULLMAG_STATE_ROOT`. Sam katalog repozytorium sesji nie może być symlinkiem.
Launcher odrzuca typ filesystemu nieobsługiwany przez writer sesji. Bind
Windows widziany jako 9p nie kwalifikuje checkpointów; wymaga osobno
zatwierdzonego adaptera trwałego storage. Samo zdrowe API nie wystarcza.
Kontener korzysta z UID/GID 65532, limitów 4 CPU,
2 GiB RAM i 128 procesów, bez podwyższonych uprawnień.

UI i API są dostępne wyłącznie przez loopback, domyślnie
`http://localhost:3104/workspace`. Receipt wskazuje dokładny container ID,
katalog danych i plik Compose. Pozostają zachowane także po błędzie obserwacji;
nie uruchamiaj ponownie bez sprawdzenia poprzedniego kontenera. Zatrzymanie
właściwego kontenera nie wymaga usuwania danych. Osobny browser smoke musi
potwierdzić działanie UI; zdrowe `/healthz` nie jest kwalifikacją solvera,
fizyki ani wydania.

Tryb sesji tymczasowej: `just run-managed-browser-snapshot-ram <pełny-job-id> <pełny-commit> <source-digest> <native-snapshot-sha256> 3106` stosuje te same walidatory pakietu i źródeł, ale umieszcza `/state` w prywatnym tmpfs o limicie 1 GiB. Hostowy bind stanu nie jest wtedy montowany; źródła i pakiet pozostają tylko do odczytu. Launcher sprawdza obecność zadeklarowanego tmpfs i jego rzeczywisty typ. Domyślny tryb z bindem pozostaje bez zmian. Port 3197 jest odrzucany, ponieważ należy do instancji użytkownika.

Receipt oznacza ten wariant jako `session_storage: disposable_tmpfs` i `durable_session_storage_qualified: false`. Dokumenty uruchomienia pozostają w storage, ale dane sesji znikają po zatrzymaniu kontenera. Tryb służy sprawdzaniu własnego workspace/API; nie kwalifikuje trwałego zapisu ani cold-load po restarcie kontenera. Sam start nie potwierdza działania UI ani fizyki.

Sesja RAM nie spełnia istniejącego wyjątku koordynatora pozwalającego na build przy działającym managed browser z hostowym bindem stanu. Przed kolejnym buildem należy zakończyć wyłącznie tę własną sesję, sprawdzając container ID i projekt Compose z receipt; nie zmieniać współdzielonego koordynatora ani cudzych kontenerów. Weryfikacja startu tego wariantu z rzeczywistym pakietem pozostaje **NOT VERIFIED** do czasu zachowania udanego receipt uruchomienia.

### Bieżący frontend z przypiętym API RAM

`just verify-antenna-workspace-browser` uruchamia niezmienną kopię bieżącego frontendu na porcie 3274. Wymaga `FULLMAG_MANAGED_BROWSER_RECEIPT` wskazującego udany receipt własnego `run-managed-browser-snapshot-ram` oraz jawnego `FULLMAG_MANAGED_BROWSER_RECEIPT_SHA256`. Zależności frontendu podlegają istniejącej walidacji własności; dla przypiętego etapu instalacji trzeba przekazać również `FULLMAG_BROWSER_DEPENDENCY_BINDING` i `FULLMAG_BROWSER_DEPENDENCY_BINDING_SHA256`. Recepta niczego nie instaluje ani nie buduje solvera.

Guard ponownie sprawdza pakiet, kapsułę źródeł, obraz, dokładny kontener, projekt Compose, loopback, mounty, limity i tmpfs. Pierwsza sesja musi być pusta; smoke używa `replace_current: false`. HTTP i WebSocket kierowane są do tej API, a każde żądanie jest przypięte identyfikatorem jej procesu. Po przebiegu następuje ponowna atestacja. Bieżący frontend oraz pakiet API mają osobno zapisane tożsamości źródeł; pakietowany statyczny UI nie jest dowodem dla nowszych zmian frontendu.

Scenariusz korzysta z prawdziwego workspace, klienta API i Inspectora, bez podmieniania odpowiedzi: tworzy mikrostrip, zapisuje pełny obwód z oboma mostkami i źródłem napięcia, dodaje referencję do Study oraz osobno otwiera jej Inspector. Sprawdza również WebGL i zakres żądań. Nie wykonuje Prepare/Start ani solve; nie kwalifikuje V/J/H, fizyki lub trwałości danych. Runner kończy wyłącznie własny Next i przeglądarkę. Kontener API pozostaje zasobem jego właściciela, który po zachowaniu dowodów kończy dokładnie ten kontener przed następnym buildem.

### Eksport OpenAPI z dokładnego snapshotu

`just export-runner-openapi <job-id> <pełny-commit>` pozostaje trasą dla
czystej kapsuły `commit`. Nie dopuszcza dirty state ani kapsuły `snapshot`.
Dla jawnego WIP służy osobna recepta
`just export-runner-openapi-snapshot <job-id> <pełny-commit> <source-digest> <native-snapshot-sha256>`.
Oba digests są wymaganymi SHA-256 (64 małe znaki hex); commit bazowy nie
identyfikuje zawartości WIP. Niepełna para, niezgodność z queue/trusted
context/build receipt/kapsułą lub zły source mode powodują odmowę przed
alokacją dowodu i przed dostępem do Dockera. Pełne walidatory artefaktów,
trusted inputs, membership i hashy kapsuły pozostają obowiązkowe.

To diagnostyczny odczyt z terminalnego pakietu, bez buildu, solvera i sesji.
Kontener wypisuje `--print-openapi-v2`, ma readonly root/package, brak sieci
i portów. Eksport sprawdza dokładny clean/dirty stamp rzeczywistej natywnej
tożsamości przed normalizacją. Zachowuje `stdout.raw.json`, log, receipt
i proof w nowym `storage/runs/<worktree-id>/openapi-export/<id>`; proof nie
promuje WIP do clean ani nie kwalifikuje fizyki. Zabezpieczenia writer sesji
nie ulegają zmianie.

Dowód z 2026-10-06: 32 interpretowane regresje, 31 PASS / 1 Windows symlink
SKIP. Rzeczywisty eksport snapshotu producenta R1 seq 33 zakończył się
exit 0, input hashes PASS i cleanup confirmed. Zachował dirty provenance.
Ten pakiet nie zawiera nowego DTO R3. Odbiór eksportu nie zastępuje
regeneracji aktualnego OpenAPI/TS.

Generator `apps/control-room/scripts/generate-openapi-v2.mjs` ma osobną
trasę `--input <absolutny-stdout.raw.json> --expected-commit <40-hex>
--expected-snapshot <64-hex> --expected-source-digest <64-hex>
--managed-snapshot-receipt <absolutny-receipt.json>`. Wymaga inputu dokładnie
`receipt-parent/stdout.raw.json` i sąsiedniego `proof.json`; oba dowody muszą
być ograniczonymi regularnymi plikami. Sprawdza SHA surowych bajtów, ich
rozmiar, SHA receiptu w proof, komplet pinów source/native, rzeczywisty
clean/dirty stamp, succeeded/0, pełne input-hash evidence i cleanup.
Dopiero potem normalizuje zmienne dane buildu i atomowo publikuje JSON.
Odmowa zachowuje poprzedni kontrakt; brak inputu nie uruchamia Cargo.
Snapshot receipt i native receipt są wzajemnie wykluczające. Domyślna
trasa nadal wymaga clean identity; dotychczasowa native receipt zachowuje
swój odrębny kontrakt. Hashy i wzajemnej zgodności plików nie należy
przedstawiać jako uwierzytelnienia przeciw aktorowi mogącemu nadpisać
raw/receipt/proof jednocześnie. Trusted package/capsule gates pozostają
odpowiedzialnością managed eksportera.

Dowód importu: `just verify-control-room-openapi-import`, 22/22 PASS,
bez kompilacji native/unit-test bundles; `just check-control-room-api-hygiene`
PASS. Walidator odczytał również rzeczywisty seq 33 raw/receipt/proof:
PASS, raw niezmieniony, generated JSON/TS nie nadpisane. Pełna regeneracja
R3 nadal wymaga terminalnego odpowiedniego buildu i jego własnego eksportu.

### Niezależny czytnik artefaktów anteny — testy bez solvera

`just verify-antenna-field-reader` uruchamia wyłącznie interpretowane regresje
`tests.antenna.test_verify_field_convergence` oraz
`tests.antenna.test_matched_libm`. Przed i po wykonaniu fingerprint
obejmuje także importowane `tests/antenna/direct_quadrature_evidence.py`,
`tests/antenna/matched_libm.py` i jego regresje;
zmiana któregokolwiek przypiętego źródła powoduje odmowę receiptu.
Log i terminalny receipt trafiają przez resolver do profilu
`antenna-field-reader` w kanonicznym storage, nie do checkoutu.

Testy sprawdzają syntetyczne pliki readera, nie wykonują native, LLG ani Relax.
Receipt zachowuje `artifact_reader_only_not_native_or_physics`; nie zastępuje
trzech publikacji native ani producer/input provenance. Rzeczywisty verifier
wymaga direct-v3 evidence domyślnie; historyczne v1/v2 wolno wczytać wyłącznie
przez jawne `--allow-legacy-local-estimator`, bez globalnego certyfikatu.
Parametry analizy `--libm-path` i `--libm-sha256` występują razem:
absolute library path i jawny expected SHA-256 z przypiętego GNU/Linux
x86-64 runtime. Adapter wiąże `hypot@GLIBC_2.35`, sprawdza canonical
resolved path, hash przed/po i nearest-even; nie zmienia fenv ani nie
wraca do Python hypot po odmowie. Bez pary parametrów raport pozostaje
`python_hypot_diagnostic_only`, a jawny legacy ma
`not_applied_legacy_local_estimator`. Żaden profil nie nadaje sam z siebie
producer/input qualification. Hash i `dladdr` nie chronią mapped ELF przed
równoległą podmianą; wymagany jest przypięty runtime tylko do odczytu.
Regresja samego fingerprintu jest w
`scripts/test_verify_antenna_field_reader.py::test_imported_direct_decoder_changes_reader_fingerprint`.

### Mały test naukowy anteny z sesją w RAM

Po jawnej zgodzie użytkownika można użyć
`just run-managed-antenna-ram <job-id> <commit> <source-digest> <native-snapshot-sha256>`.
To osobna, ograniczona trasa FEM CPU/double dla przypiętego przykładu
`examples/fem_antenna_current_source_inspection.py`, nie alternatywny trwały
SessionStore i nie uruchomienie LLG. Wymaga terminalnego, udanego buildu
`fem-cpu-release` i pełnego validatora trusted documents, pakietu oraz kapsuły.
Nowy przykład jest osobnym, dokładnie zahashowanym wejściem naukowym;
nie wolno przypisywać go wcześniejszej kapsule buildu.

Launcher przyjmuje kapsułę `snapshot` albo czystą kapsułę `commit`; obie wymagają
pełnego SHA commita oraz obu jawnych digestów. `commit` wymaga dodatkowo
`source_snapshot_dirty=false`. Tryb źródeł nie pomija kontroli trusted documents,
hashy pakietu ani pełnego `verify_source`. Obserwator ponawia te same kontrole.
Regresja interpretowana: `scripts/test_antenna_ram_source_modes.py::AntennaRamSourceModesTests`;
nie jest wykonaniem solvera ani kwalifikacją naukową.

Sesja, cache siatki i oryginalny wynik znajdują się wyłącznie na ograniczonym
tmpfs `/ram` (768 MiB). Kontener ma 2 CPU, 2 GiB RAM, 128 procesów, UID/GID
65532, read-only rootfs, brak capabilities, podwyższonych uprawnień, sieci,
portów i named volumes. Kapsuła, pakiet i trzy pliki wejściowe są read-only;
jedyny zapis na bind hosta to eksport logu, exit marker i kopia wyniku pod
nowym katalogiem `storage/builds/<worktree-id>/managed-antenna-ram-cpu/runs/<id>`.
Nie zmienia to allowlisty filesystemów ani kwalifikacji checkpointów na 9p.

Tryb naukowy ustawia `FULLMAG_API_PORT=0`: headless nie wymaga serwera API,
a kontener nadal nie publikuje portów. `FULLMAG_STATE_DIR=/ram/user-state`
kieruje osobną historię workspace do RAM; nie należy utożsamiać tej zmiennej
z `FULLMAG_STATE_ROOT`, który określa root sesji. Oba zapisy są tymczasowe.

`just observe-managed-antenna-ram <absolutny-run-root>` ponawia kontrolę
pakietu, kapsuły i wejść oraz sprawdza rzeczywisty image, mounty, limity,
tmpfs, komendę, środowisko i właściciela Compose. Stan inny niż `exited`
pozostaje oczekujący. Exit 0, właściwy startup stamp i obecność eksportu
oznaczają wyłącznie `solver_succeeded_comparison_pending`. Oddzielna bramka
musi odczytać konkretny inspection stage record, zweryfikować jego canonical
bundle i porównać V/H z niezależnym wzorcem. Receipt zachowuje
`physics_qualified=false` i `durable_session_storage_qualified=false`.
Kontener i eksport są zachowane także po błędzie; observer nie startuje
nowego solve ani nie usuwa zasobów. Utrata RAM po zakończeniu kontenera jest
zamierzona; eksport nie dowodzi odporności sesji na utratę zasilania.

### Zamrożony obraz koordynatora

`just runner-coordinator-base` pobiera wyłącznie bazę przypiętą digestem w
`Dockerfile.coordinator`. Jest to jawna operacja sieciowa; zapisuje log i terminalny
receipt przez resolver. Fizyczny dysk danych Dockera musi być zgodny z polityką
storage hosta. Przygotowanie i build obrazu pozostają offline.

`just runner-coordinator-context <pełny-SHA-commita>` zamraża dokładne wejścia
COPY z jawnego commita. Wynik podaje prywatny kontekst oraz SHA256 `context.json`.
`just runner-coordinator-image-frozen <kontekst> <SHA256-context.json> <tag>`
wymaga taga `fullmag/build-runner:*`, sprawdza niezmienność kontekstu i lokalnej
bazy, buduje bez sieci i pull, a następnie odczytuje rzeczywiste pliki z obrazu.
Dodatkowy COPY manifestu istnieje tylko w wygenerowanym Dockerfile kontekstu.

Helper `scripts/local_runner/coordinator_image.py` używa bounded logs, blokady
kontekstu i terminalnego receiptu. Regresje interpretowane w
`scripts/test_coordinator_image.py` nie stanowią dowodu buildu obrazu.
Receptury nie uruchamiają Application, nie zmieniają operatora, profili ani kolejki
oraz nie kompilują solvera. `SUCCEEDED_IMAGE_ONLY` oznacza wyłącznie zweryfikowany
obraz; aktywacja i wycofanie wymagają odrębnych kontroli istniejącego runnera.
Historyczne `runner-coordinator-image` pozostaje receptą diagnostyczną.

Dowód z 11.10.2026: 24 regresje interpretowane PASS; rzeczywiste receptury
pobrania bazy, capture commita `96a648d828c6ea152d2dd294cf3407a193ad714f`
i offline build/readback zakończyły się exit 0. Obraz
`sha256:d60a214fba8d4b146d9ab09315d5c018e38c7c0a10d30a35369796a5361b723e`
przeszedł osobny import jako UID 65532, readonly, bez sieci i mountów:
Python 3.11.15, wszystkie siedem profili katalogu, BORIS domyślnie wyłączony.
Receipt importu ma SHA256
`26fa456a074670742a1edd9dc6aaa99f5a37251922879b11cb20151f88713089`.
To dowód producenta i importów dla wskazanego commita; nie obejmuje późniejszej
transakcji wycofania profilu ani wdrożenia tego obrazu w działającym runnerze.

### Pozostałe ograniczenia

- Build/uruchomienie Fullmaga z prywatnej kopii kapsuły i jawnego execution context.
- Wspólne leases obejmujące istniejące launchery i ich kontenery po crashu procesu hosta.
- Adapter trwałego storage Desktop, dowód ext4/backing, limity i restart.
- Rozdzielenie istniejącego managed recipe na host orchestration i worker stage.
- Rzeczywista kwalifikacja FEM CPU/GPU, receipt nauki i artefakty.
- Uwierzytelniony ingress GitHub, ephemeral listener i ograniczenia zaufania PR.

Nie nadawaj temu wykonawcy etykiety `fem-managed` ani nie używaj diagnostycznego
receipt do zaliczenia CI/kwalifikacji solvera.


### Toolchain CPU dla runtime-v2

Dla kompletnego runtime-v2 recepta
`just runner-build-image <verified-local-toolchain-tag> <new-tag> 1 default`
dodaje osobny CPU stos: MFEM v4.10 z commita
`d964264cdb9a13e94a201b6c236c7721e0c8765f` i HYPRE v3.1.0
z commita 9dc9e18aed6a945a95f966e57daacfb1c269f6ec,
bez CUDA i bez testów, przykładów oraz miniapps. Zachowuje stary prefix.
Dodaje też CPU libCEED v0.12.0 (`4018a20a98d451fac24765d3ddb936861647ce8d`),
PETSc v3.24.6 (`1467453aedb62826efc970ceafc4bd6dab8229ab`) i SLEPc v3.24.3
(`4c754d7d3ae067837670828a304512798334fb3a`). Dokładne commity sprawdzane są
po shallow fetch; źródła CPU i ich wygenerowane konfiguracje są osobne.
PETSc jest real/double z MPI, bez CUDA/HIP/SYCL/OpenCL, powiązany z tym samym
CPU HYPRE co MFEM. CPU MFEM korzysta z CPU libCEED. Inherited GPU PETSC_DIR /
SLEPC_DIR są zastąpione podczas configure. Przy CPU_MFEM_ONLY=0 bootstrap
CPU jest pomijany; historyczny/GPU prefix pozostaje zachowany.
Wariant CPU potrzebuje sieci dla jawnego pobrania źródeł i pakietów
rozwojowych BLAS/LAPACK/Fortran. Domyślne network=none pozostaje bez zmiany;
nie ma automatycznego przełączenia na online ani fallbacku GPU.
To jawna budowa obrazu operatorowego, nie build ani kwalifikacja Fullmaga.
Domyślne argumenty recepty pozostają bez dostępu sieci i bez tego kroku.
Obraz wymaga kontroli CPU prefix, a następnie konfiguracji immutable ID
profilu runtime-v2 i osobnego builda Fullmaga przez kolejkę.

Historyczny bootstrap MFEM 4.9 zweryfikowano: obraz f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc; MFEM/HYPRE bez CUDA, loader HYPRE z CPU prefixu. To obraz zależności; build Fullmaga i fizyka NOT VERIFIED.

Aktualizacja do MFEM 4.10 wymaga nowego tagu, immutable ID i kontroli wersji
nagłówków oraz załadowanej biblioteki; historyczny obraz nie stanowi jej dowodu.
Przed operatorską budową obrazu należy zakończyć aktywne wykonania i potwierdzić
zwolnienie lease oraz zdrowie koordynatora. Kolejka obsługuje build źródeł,
nie budowę obrazu. Zachowaj istniejące profile i obrazy wykorzystywane przez
wcześniejsze kapsuły. Oba prefixy CPU/GPU kwalifikuj oddzielnie.


### Obsługa źródeł i paczek runtime

Plan retencji jest związany z zakresem (`execution`, `sources`, `runtime`) oraz
opcjonalnym wyborem pełnych ID jobów. Klient CLI udostępnia
`retention-preview --scope sources`, `retention-get <plan-id>` i
`retention-apply <plan-id>`; recepty `just runner-retention-preview sources`,
`runner-retention-get` i `runner-retention-apply` korzystają z tego samego API.
Nie ponawiaj POST po timeout: odczytaj trwały wynik tego samego ID.

Kompakcja historycznych źródeł zachowuje manifest, digest i ścieżkę kapsuły.
Identyczna treść jest współdzielona w CAS; execution nadal otrzymuje prywatną
zapisywalną kopię. Operacja chroni aktywne zadania, piny, obce hardlinki,
reparse points i mounty. Liczniki logicznych bajtów nie są pomiarem odzysku
fizycznego miejsca.

Retencja runtime obejmuje wyłącznie dokładny lokalny katalog paczki terminalnego
udanego buildu. Zachowuje źródła, wyniki naukowe, logi, receipty i historię
kolejki. Zostawia co najmniej `min_artifacts_to_keep` najnowszych dostępnych
pakietów dla każdej pary worktree/profil (liczba całkowita 1–20) oraz wszystkie
paczki używane przez wyniki, UI, eksporty, piny i kontenery. Brak pełnego
inwentarza lub uszkodzone metadane chronią potencjalnie używane zasoby.
Automatyczne usuwanie paczek wymaga oddzielnego `runtime_retention_enabled=true`
oraz trybu `automatic`; domyślnie jest wyłączone.

Autorytatywny rejestr metadanych w `index/runtime-reference-roots.json` ma
schema `fullmag.runtime-reference-roots.v1`, tablicę `relative_roots` i jawne
`legacy_inventory_complete`. Nie ustawiaj kompletności na true bez sprawdzenia
historycznych lokalizacji wyników i zapisania dowodów audytu. Brak pliku albo
wartości true blokuje usuwanie wszystkich paczek runtime. COMSOL/DE rejestruje
nowy output pod bramką admission przed zwolnieniem ticketu; utworzenie rejestru
nie poświadcza historii. Nieobsługiwany output w namespace kontrolnym/payload
unieważnia kompletność. Katalogi rejestru są względem kanonicznego storage,
bez ścieżek absolutnych i przejść `..`.

Przed usuwaniem paczki powstaje `artifacts/runtime-package-retention.json`.
Pełne usunięcie pozostawia tombstone `removed` związany z SHA-256 oryginalnego
build receipt. Stan `partial_error`, `deleting` albo niezgodna tożsamość blokuje
ponowną próbę i wymaga ręcznego sprawdzenia danych. Nie deklaruj udanego
sprzątania na podstawie braku katalogu bez takiego dowodu.


Przy maintenance można jawnie użyć
`just runner-container-replace <verified-image-sha256> <readonly-preview-plan-id>`.
To wyłącznie porzucenie wskazanego execution preview w statusie planning,
przy policy preview i potwierdzonym Drain bez aktywnych jobów/workerów/błędów.
Klient sprawdza uwierzytelnione API, kanoniczny rekord i brak operation/admission,
a po stop ponownie atestuje kontener i metadane. Przerwany preview otrzymuje
blocked/applied=false; trzeba wygenerować świeży plan. Nie używaj tego wariantu
do apply, automatycznej retencji lub odzyskania nieznanego wyniku mutacji.
Domyślny wariant recepty zachowuje odmowę podczas retention_busy.


## Cooperative cancel tylko dla read-only execution preview

Przygotowywany przyrost rozszerza istniejącą usługę retention o
`POST /api/v1/retention/plans/<plan_id>/cancel` z pustym body i komendę
`retention-cancel <plan_id>` zatwierdzonego klienta. Obejmuje wyłącznie aktywny
read-only preview scope execution. Cancel apply oraz preview sources/runtime
pozostaje niedostępny; nie przerywa się usuwania danych w połowie operacji.

Klient CLI zwraca kod `124` dla ACK `cancel_requested`, `0` dla terminalnego
`cancelled`, a `1` dla pozostałych odpowiedzi (np. odmowy anulowania).
Kod `124` wymaga odczytu tego samego planu, a nie ponowienia preview.

ACK `cancel_requested` nie jest wynikiem terminalnym. Thread sprawdza event
między odczytami metadanych i etapami drzewa, po czym utrwala `cancelled` z
`applied=false`. Slot builda pozostaje zajęty do faktycznego zakończenia threadu.
Nie wolno wyczyścić lease, zrestartować procesu ani ponowić skanu na podstawie
samego ACK lub wieku operacji. Przy utracie handle wynik pozostaje
`interrupted_unknown`, nie success. Canceled preview nie może być użyty do apply.

Progress przedstawia rzeczywiście zbadane entries/files/logical bytes oraz
fazę enumeracji/inspekcji. Nie ma zgadywanego procentu, całkowitej liczby entries
ani ETA; kandydat i fingerprint są dostępne dopiero po pełnej inspekcji.
Finalne publish i przejście automatic-preview→apply są chronione tą samą blokadą
co cancel, aby zaakceptowany cancel nie został nadpisany gotowym planem.

Przygotowanie źródeł i regresji CI nie włącza tej trasy we wdrożonym koordynatorze.
Przed użyciem potrzebne są sprawdzone CI, zgodna aktualizacja jednego runnera,
attestacja obrazu, pusta aktywna ścieżka builda i preserved queue/profiles/data.
Dla starego koordynatora brak obsługi oznacza unavailable; nie udajemy anulowania.
Reguły autoryzacji i ochrony kandydatów przy rzeczywistym cleanup pozostają bez zmian.


## Stabilny odczyt aktywnej kolejki

Panel kolejki pobiera `GET /api/v1/jobs?status=queue&sort=oldest&limit=200`.
Dla kolejki SQLite odpowiedź zawiera `items`, `next_cursor`, `as_of_sequence`,
`limit`, `is_truncated` i `worktrees`. Kolejną stronę pobiera się z tym samym
zestawem filtrów oraz `cursor=<next_cursor>`; odczyt kończy wyłącznie jawne
`next_cursor: null`. Kursor jest związany z operatorem, filtrami, kolejnością
i limitem; zmiana któregokolwiek z nich wymaga rozpoczęcia nowego odczytu.

Pierwszy odczyt ustala maksymalny numer `sequence` w tej samej transakcji co
strona. Wszystkie kolejne strony zachowują ten `as_of_sequence`; nowe zgłoszenia
po tej granicy pojawiają się przy następnym odświeżeniu. Stan aktywności jest
sprawdzany na każdej stronie, więc zadanie zakończone przed swoim odczytem może
zniknąć. Zakończenie wcześniejszych zadań nie przesuwa dalszych aktywnych
rekordów poza kursor. Nie jest to snapshot wszystkich statusów z jednego momentu.
Historia zachowuje dotychczasowe `page/pages` i OFFSET.

Źródła Runner Console znajdują się w `apps/runner-console/src`; koordynator
serwuje pakiet `scripts/local_runner/ui_dist`. `node apps/runner-console/build.mjs`
kopiuje kanoniczne zasoby do obu katalogów dystrybucji. Zmiana panelu wymaga
zachowania zgodności źródeł i pakietu; nie wolno nadpisywać działających funkcji
nowszą albo starszą kopią bez sprawdzenia diffu. GHA wykonuje regresję SQLite,
testy Node oraz lokalną fixture przeglądarki serwującą `ui_dist`. Fixture nie
zgłasza prawdziwych buildów ani nie usuwa danych.

### Uzgodnienie desired z już działającą listą profili

`container-reconcile-desired-profiles` jest osobną operacją operatora, wymagającą
przeglądu przed wykonaniem. Nie aktywuje profilu w procesie i nie rozszerza jego
uprawnień: ustawia tylko `allowed_profiles` public/secret na dokładny zbiór z
uwierzytelnionego health atestowanej inkarnacji. Każda nazwa musi należeć do
`container_client.CATALOG_PROFILES`; obecne desired musi być podzbiorem observed.
Kolejność zapisu to `ALLOWED_PROFILES`, potem pozostałe nazwy sorted. Nie ma
wbudowanej listy sześciu profili ani flagi włączającej dodatkowe profile SLEPc.

Przed operacją wymagane są completed pause/drain, trwały marker pauzy, pusty
aktywny slot/lease, brak innych workerów i pending transakcji. Nie wykonuj jej
podczas buildu. Przygotuj do przeglądu pełne ID kontenera/obrazu, instance_id z
health, SHA256 surowych bajtów public config/katalogu oraz observed SHA256:
`sha256(json.dumps(sorted(observed), separators=(',', ':')).encode('utf-8'))`.
Odczyty muszą dotyczyć tej samej atestowanej instancji. Nigdy nie publikuj tokenu
ani zawartości secret; token nie jest argumentem CLI.

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-reconcile-desired-profiles --expected-container-id <full-ID> --expected-image-id sha256:<image-ID> --expected-public-sha256 <public-SHA> --expected-catalog-sha256 <catalog-SHA> --expected-observed-sha256 <observed-SHA> --expected-instance-id <health-instance-ID>
```

Operacja dwa razy sprawdza atestację, completed drain, znany zbiór observed,
instance_id i niezmienioną kolejkę/inwentarz oraz CAS wszystkich trzech plików.
Katalog pozostaje identyczny bajtowo; token, port, obraz i pozostałe pola są
zachowane. Pod istniejącymi lockami zapisuje prywatny journal
`fullmag.runner.desired-profile-reconcile.v1` w tym samym pending miejscu co
transakcje BORIS. Journal zawiera sekret i podlega istniejącej ochronie ACL;
nie publikuj go. Wynik zawiera tylko ID transakcji i hashe public/catalog.

Awaria między zapisami secret/public pozostawia pending, który blokuje zwykłe
load/start/configure i wykonawców. Przy zwykłym wyjątku operacja próbuje rollback;
gdy rollback też zawiedzie, pending pozostaje. Istniejący jawny recovery rozpoznaje
nowy schema i pozwala **wyłącznie `before`**, z exact ID transakcji/kontenera,
trwałą pauzą, brakiem aktywnych lub niepewnych lease i ochroną przed obcą zmianą plików:

```text
python -B scripts/local_runner_cli.py --worktree <checkout> container-recover-boris-profile --transaction-id <exact-ID> --direction before
```

Historyczna nazwa komendy recovery jest współdzielona; `after` dla reconciliation
jest odrzucane. Recovery starego schema nadal dopuszcza wyłącznie swoją deltę
usunięcia BORIS. Nie edytuj pending ani pary config ręcznie. Uzgodnienie desired
nie zastępuje quiesce/frozen-image upgrade, nie osłabia `replace_exited::_delta`
i nie jest dowodem kwalifikacji buildu ani fizyki.
