# Lokalny runner kontenerowy

## Obecna architektura i ograniczenia

Jeden stały `Fullmag_build_runner` posiada kolejkę SQLite, API i dostęp do Docker
Engine. Windows jest klientem: rozwiązuje worktree/storage, przygotowuje niezmienną
kapsułę kodu i zgłasza job. Koordynator uruchamia osobny kontener builda z katalogu
profili. Tylko jeden ciężki job może zajmować slot; praca edytorów na innych
worktree nie wymaga zatrzymywania bieżącej kompilacji.

Socket Docker jest szerokim uprawnieniem zaufanego operatora. API wymaga bearer
tokena i jest publikowane tylko na `127.0.0.1:8765`; nie wystawiaj go do LAN.
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

Obraz workera powstaje z istniejącego, świadomie wybranego obrazu toolchaina:
`just runner-build-image <lokalny-tag-toolchaina>`; sprawdź jego immutable ID,
a następnie `just runner-configure-build fem-cpu-release sha256:<image-id-workera>`.
Sama obecność profilu w katalogu nie oznacza konfiguracji obrazu ani walidacji.
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

Wstrzymaj edycje wszystkich agentów na czas capture. Zmiana podczas kopiowania
odrzuca zgłoszenie. Po utworzeniu kapsuły można dalej edytować branch; build
otrzymuje kopię, a nie późniejszy stan ścieżki. SHA kapsuły i natywna tożsamość
`fullmag.source-snapshot.v2` są różnymi, powiązanymi dowodami.

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

## Dane, zakończenie i retencja

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

- Build/uruchomienie Fullmaga z prywatnej kopii kapsuły i jawnego execution context.
- Wspólne leases obejmujące istniejące launchery i ich kontenery po crashu procesu hosta.
- Adapter trwałego storage Desktop, dowód ext4/backing, limity i restart.
- Rozdzielenie istniejącego managed recipe na host orchestration i worker stage.
- Rzeczywista kwalifikacja FEM CPU/GPU, receipt nauki i artefakty.
- Uwierzytelniony ingress GitHub, ephemeral listener i ograniczenia zaufania PR.

Nie nadawaj temu wykonawcy etykiety `fem-managed` ani nie używaj diagnostycznego
receipt do zaliczenia CI/kwalifikacji solvera.
