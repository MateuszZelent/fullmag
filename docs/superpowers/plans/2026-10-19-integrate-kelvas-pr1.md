# Integracja Kelvas888/fullmag PR #1 — plan i checkpoint

Data: 2026-10-19. Zadanie: pełna obsługa DEV Linux/WSL w bieżącej architekturze
Compose, zgodnie z jawną decyzją użytkownika. Zmiana znosi wcześniejsze
ograniczenie startu DEV do natywnego Windows. Nie zmienia granicy danych:
build/cache/staging/provenance/logi i receipty buildu pozostają w Docker
named volumes / BuildKit; sesje, wyniki, projekty i ustawienia w wybranym
trwałym storage hosta.

## Aktualny stan odbioru źródeł

Źródła PR zostały przeniesione do aktualnej ścieżki wolumenowej i połączone
z masterem `377f3ced6d314ecfc46bc63211563dca4483765f`. Testy interpretowane
i niezależne review zakończyły się bez otwartych ustaleń. Build Rust,
pełny runtime Linux/WSL, restart/HMR/WebGL, SessionStore i GPU pozostają
**NOT VERIFIED**. Integracja do zdalnego mastera i cleanup nie są ukończone.
Konfiguracja Docker Desktop dla Ubuntu2 jest włączona, lecz bieżące połączenie
WSL jest niesprawne. Oczekiwane są także ścieżki native checkout/storage od
operatora. Nie wykonano restartu ani modyfikacji konfiguracji WSL.

## Tożsamość

- Baza naszego mastera: `6d3fcc08285e075cab0019cb235f21c7a2a9841f`.
- PR źródłowy: https://github.com/Kelvas888/fullmag/pull/1.
- HEAD źródłowy: `09df0dd429ffecb49b7a4b2852ebc888bd9ed5bd`.
- Branch integracji: `codex/integrate-kelvas-pr1-20261019`.
- Worktree: `C:/git/fullmag/worktrees/integrate-kelvas-pr1-20261019`.
- Owner: `codex-current-chat`.
- Rejestr: `storage/index/integrate-kelvas-pr1-20261019-3c3f086c71561a43.json`.
- Główny checkout ma niezależne dirty zmiany, w tym pliki objęte PR.
  Nie są częścią integracji, nie wolno ich resetować ani stashować.

## Etapy i właściciele zmian

1. Worker `resolve_pr1`: selektywne rozwiązanie sześciu konfliktów, admission
   Linux/Windows, Compose, guest bootstrap/runtime, setup, Linux path/readback,
   Rust fixed-layout store, host ledger i odpowiadające testy interpretowane.
2. Worker `linux_volume_dev`: aktualny launcher `docker_dev.py`, kontrolery
   `docker_volume_dev.py` i `docker_build_control.py`, bootstrap toolchaina,
   backend/frontend named-volume cache i testy. Żaden etap nie przywraca
   dawnego runnera, źródłowego ZIP/TAR ani hostowego stagingu.
3. Root: spójność wspólnych kontraktów, dokumentacja/ADR/instrukcje, review
   diffu, weryfikacja oraz Git/PR/merge i retencja zasobów.

## Wspólny kontrakt

- Windows: Docker Desktop `desktop-linux`, `windows-folder-v1`, NTFS/ReFS,
  istniejąca atestacja i runtime UID/GID 65532.
- Linux/WSL: aktywny lokalny kontekst Docker Linux, `linux-native-v1`,
  checkout i storage ext4/XFS/Btrfs bez symlinków, DrvFS, CIFS ani NFS.
- Linux runtime UID/GID są jawnie mintowane z nie-rootowego użytkownika hosta
  i zgodne w Compose, cache/markerach, receipcie i `docker inspect`.
- Brak broad chmod0777, rekursywnego chown i przejęcia obcego cache.
- Dwie stałe usługi aplikacji: backend buduje i uruchamia API/native runtime,
  frontend obserwuje ten sam readonly checkout przez HMR.
- Restart/resume/recovery zachowują piny właściciela, attempt, config hash,
  image i źródła; timeout nie oznacza braku skutków po stronie demona.

## Kryteria odbioru i dowody

- Brak konfliktów i `git diff --check`, poprawne linki i unikalny numer ADR.
- Testy interpretowane: wybór hosta/kontekstu, odmowy filesystemów i root UID,
  atomowe readback/storage, Compose/identity/cache i regresje Windows.
- Zakaz kompilowania testów jednostkowych pozostaje w mocy.
- Build wyłącznie przez grupę Compose worktree: `just docker-dev-toolchain`,
  `just docker-dev <source> <port>`. Żadnego hostowego Cargo/CMake.
- Osobne dowody: build Rust, zdrowe API, cold start, restart bez zmian, HMR,
  widoczny WebGL/drawing buffer, zapis/restart SessionStore oraz GPU runtime.
  Wynik źródeł lub React Doctor nie zastępuje tych dowodów.
- Po wymaganych kontrolach: scoped commit/push, PR do naszego mastera,
  wymagane review/CI, merge, lokalny fast-forward i sprawdzenie integracji.
- Cleanup tylko worktree tego zadania po potwierdzeniu czystości, scalenia
  i braku aktywnych konsumentów. Dirty master jest możliwą blokadą ff.

## Checkpoint początkowy

- Rejestr zadania zapisany; merge rozpoczęty w izolacji, master bez zmian.
- PR źródłowy jest draftem; sześć konfliktów z bieżącym masterem.
- Fork CI: React Doctor, contract-guard, dispersion-artifact-consumers
  i bootstrap zakończone sukcesem; frontend-3d-managed-fem anulowane.
- Kontrola czterech linkowanych dokumentów: PASS przed rozszerzeniem zakresu.
- Windows `setup_docker.py --check`: PASS; nie jest dowodem buildu/runtime.
- Docker Desktop działa, istniejące grupy nie zostały zrestartowane.
- Wstępna kontrola innej dystrybucji Ubuntu: ext4, UID/GID 1000, brak `just`.
  Brak skonfigurowanego checkoutu Fullmag i storage Linux. Nie zmieniono
  dystrybucji, nie wybrano arbitralnie nowego rootu storage.
- Build, runtime Linux/WSL, HMR/WebGL, trwałość sesji i GPU: NOT VERIFIED.
- Integracja i cleanup: w toku; brak deklaracji ukończenia.

## Uzupełnienie diagnostyki WSL

Ponowna kontrola na żądanie użytkownika: Docker Desktop ma
`EnableIntegrationWithDefaultWslDistro=true`, `IntegratedWslDistros=[Ubuntu2]`
i `WslEngineEnabled=true`. Ubuntu2 ma Python i just, UID/GID 1000.
`/usr/bin/docker` wskazuje brakujący `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker`.
Socket `/var/run/docker.sock` istnieje, lecz ping kończy się timeoutem.
Guest-services socket jest nieobecny. Log backendu Desktop zgłasza brak
`/mnt/wsl/docker-desktop/shared-sockets/host-services/backend.sock`.
Jest to awaria bieżących mountów/proxy mimo włączonej konfiguracji integracji.
Silnik Windows nadal odpowiada (29.8.1). Nie wykonywano restartu Desktop/WSL,
zmiany konfiguracji dystrybucji ani ustawiania arbitralnego storage Linux.

## Dowody cząstkowe przed finalnymi testami

- Realny helper Linux w Ubuntu2: PASS dla UID/GID 1000, admission ext4,
  odmowy źródeł 9p z /mnt/c, publikacji JSON 0600, atomowego replacementu,
  readback i odmowy symlinków. Małe pliki testowe były w TemporaryDirectory
  i zostały usunięte. To test helpera, nie Docker DEV/runtime.
- Linki dwunastu zmienionych dokumentów oraz metadane skilla Docker: PASS.
- Profil mastera ma około 13 GiB danych builda i 5.1 GiB pakietu. Wolne
  miejsce wewnątrz Docker około 648 GiB, na backing volume Windows około
  44.5 GB. Przed własnym buildem wymagany ponowny preflight i ocena
  równoległych zapisów; te wartości nie są gwarancją szczytu nowego buildu.
- Ubuntu2 zawiera inne aktywne sesje Codex oraz usługi PostgreSQL/Redis.
  Restart dystrybucji lub Desktop nie został wykonany jako rutynowy krok.
- Własne ciężkie buildy/runy: jeszcze nie uruchomiono. Nie ma kwalifikowanych
  danych ciężkiego etapu tego zadania do usunięcia. Cudze cache i grupy
  pozostają zachowane; brak globalnego prune.

## Decyzja o cross-root ledger

Nie rozszerzamy zadania do przebudowy allocatora host-global. Nowa trasa
Linux ma fail-closed preflight aktywnych backendów Fullmag na przypiętym
daemonie: inny backing/mount/project ledgeru blokuje start, ten sam
kanoniczny ledger grup worktree pozostaje dozwolony. Testy źródeł mają
pokryć oba przypadki. Nie zatrzymujemy ani nie rekonfigurujemy peerów.

## Checkpoint po ponownej diagnostyce i testach Ubuntu2

- Ponowna diagnostyka na żądanie użytkownika potwierdziła ustawienia integracji
  Ubuntu2, brak celu symlinka klienta Docker oraz timeout bezpośredniego `/_ping`
  na `/var/run/docker.sock`. Docker Desktop z Windows odpowiada poprawnie.
- `test_linux_docker_guest.py`: 12/12 PASS na Ubuntu2 po naprawie pierwszej
  publikacji receiptu i uzupełnieniu regresji restartu/certyfikatu.
- `test_docker_backend_dev.py`: 61/61 PASS na Ubuntu2. Kontrole obejmują
  również oczekiwane odmowy i wstrzyknięte awarie; końcowy exit code 0.
- To testy interpretowane, bez kompilacji testów jednostkowych i bez startu
  aplikacji. Bramka runtime Linux/WSL pozostaje NOT VERIFIED.
## Odbiór źródeł launchera i review

- Bootstrap: 40 testów, 2 oczekiwane skipy; poprawiono odwołanie do
  niezdefiniowanego `local_volume` w osobnej ścieżce Windows enrollment.
- Ubuntu2: cache maintenance 18 PASS, 1 skip CAP_CHOWN; platforma Docker
  8 PASS (lokalny AF_UNIX, wybór/piny kontekstu, odrzucanie URI i override).
- Windows: runtime-state 8 PASS, backend cache 17 PASS, frontend cache 13 PASS.
- AST 12 plików i whitespace sprawdzone przez właściciela launchera.
- Niezależne review wykryło brak pakowanego helpera w runtime Linux.
  Usunięto zależność guest runtime od hostowego modułu; izolowana regresja
  2 PASS obejmuje brak helpera oraz UID/GID/root/range.
- Wąskie ponowne review potwierdziło usunięcie obu ustaleń; nie jest to
  kwalifikacja zbudowanego obrazu ani runtime.
- Równoległa integracja przesunęła lokalny i zdalny master na
  `377f3ced6d314ecfc46bc63211563dca4483765f` (PR #199). Po zapisaniu
  spójnego etapu konieczne jest włączenie tej wersji i kontrola przecięć.

## Gotowość etapu źródłowego do zapisu

- Ubuntu2: frontend 42/42 PASS, runtime recovery 8/8 PASS, container runtime
  recovery 5/5 PASS. Po poprawieniu fixture: full runtime 108 testów, 4 skipy,
  wynik OK; runtime control volume 9/9 PASS; isolated guest identity 2/2 PASS.
- Usunięty test nieistniejącego historycznego `publish_container_metadata`
  nie ma już publicznego ani bieżącego produkcyjnego konsumenta. Test seed
  zachowuje realny zapis do temp state, izolując Windows Git pointer i admission
  źródeł; oddzielne testy sprawdzają odmowę 9p i symlinków.
- Wszystkie sześć konfliktów jest rozstrzygnięte w treści, brak markerów;
  indeks merge pozostaje niezmieniony do stagingu właściciela integracji.
- Etap jest zweryfikowany źródłowo; build i runtime nadal NOT VERIFIED.

## Zapis etapu i integracja bieżącego mastera

- Commit źródłowego etapu: `fe0a772db4ee4bfba8e05d934dd38ff4e5ef39d0`.
  Obejmuje port PR #1, regresje, dokumentację i oba zamknięte ustalenia review.
  Dowody źródłowe powyżej; runtime/build nie są przez ten commit kwalifikowane.
- Następny merge włączył master `377f3ced6d314ecfc46bc63211563dca4483765f`.
  Jedyny konflikt tekstowy: `scripts/docker_volume_dev.py`. Właściciel launchera
  łączy Linux identity/certificate/daemon/ledger z nowymi dowodami anulowania,
  graceful drain i consumed recovery authority. Guest runtime/frontend łączą
  się automatycznie i podlegają osobnej kontroli przecięć.
- README otrzymuje odsyłacz do Linux/WSL zamiast nieaktualnego zakazu startu.

## Kontrola przecięć z PR #199

- Konflikt launchera rozstrzygnięty bez utraty gate Linux ani nowych warunków
  anulowania/drain/recovery. Dziewięć odpowiednich zestawów interpretowanych
  w Ubuntu2 zakończyło się OK; jeden test maintenance wymaga CAP_CHOWN i ma skip.
- Auto-merge guest: frontend 44/44, successor recovery 4/4, Linux identity 2/2,
  runtime recovery 8/8 i container runtime recovery 5/5 PASS. Bez edycji guest.
- Dodatkowa kontrola konsumentów ujawniła stały Windows Docker context/user
  w helperze terminalnego drain oraz blokadę Linux w live activate i Windows
  certificate-only w container recovery. Pełny DEV wymaga portu tych aktywnych
  operacji, bez usuwania dowodów ownership/capability/lock/drain. Zmiany są
  odrębnym zakresem source review; runtime pozostaje NOT VERIFIED.

## Uzupełnienie dostępu WSL i wspólnego admission

- Read-only test Windows `docker.exe --context desktop-linux version` z Ubuntu2
  również nie działa: `Exec format error`. Binfmt jest enabled, lecz wpis
  `/proc/sys/fs/binfmt_misc/WSLInterop` nie istnieje; zmienna `WSL_INTEROP` istnieje.
  `/etc/wsl.conf` ma tylko `appendWindowsPath=false` w sekcji interop, nie jawne
  `enabled=false`. Nie zmieniano binfmt, usług, mountów ani konfiguracji WSL.
- Wspólny `linux_docker_host.local_volume` odrzuca teraz nietrwałe rooty również
  przy obsługiwanym filesystemie. Kreator współdzieli `TRANSIENT_ROOTS`.
  Regresja 2 testów najpierw wykazała 5 brakujących odmów, po poprawce PASS;
  24 testy kreatora także PASS. Root o podobnym prefiksie `/tmp-data` pozostaje
  dozwolony; nie jest odrzucany błędnym porównaniem tekstowego prefiksu.
- Kontrola lokalnych linków 13 zmienionych dokumentów/README: PASS.

## Końcowy odbiór po połączeniu mastera

- Ubuntu2: stop-unadmitted 26/26 PASS, runtime state 10/10 PASS, activate
  24/24 PASS, container recovery 10/10 PASS. Windows starsze grupy bez
  jawnych UID/GID pozostają obsługiwane wyłącznie dla profilu Windows i
  zaobserwowanego `65532:65532`; duplikaty i sprzeczne wartości są odmową.
- Ponowione po zmianie guest runtime przez merge: full runtime 108 testów,
  OK z 4 skipami; guest Linux 12/12 PASS; backend DEV 61/61 PASS.
- Początkowa diagnoza brakującej identity w receipcie została doprecyzowana:
  pole istniało, lecz było zapisywane późno. Tożsamość jest teraz przypięta
  w inputs i top-level przed setupem; regresja obejmuje utworzenie i retained
  odczyt oraz odmowę brakującego pola.
- Nowe helper captures używają przypiętego prefiksu Docker i oczyszczonego
  środowiska. Terminalny probe ma zgodną identity host/control/Config.User/Env.
- Activation i recovery Linux sprawdzają prywatny certyfikat, raw/canonical
  digest, owner, daemon oraz UID/GID przed mutacjami i ponownie przed removal.
  Probe potwierdza euid/egid oraz niezmieniony daemon po zakończeniu.
- Niezależne review zmian merge, obu poprawek zgodności i activate/recovery:
  bez otwartych ustaleń. To dowód źródeł, nie rzeczywistego wykonania Dockera.
- Lokalnie nie wykonano buildu aplikacji ani kompilacji testów jednostkowych.
  Nie uruchomiono grupy Compose tego worktree. Brak ciężkich danych tego
  etapu do kwalifikowanego usunięcia; cudze grupy i cache zachowano.
## PR i automatyczne CI

- Draft: https://github.com/MateuszZelent/fullmag/pull/201. Źródłowy merge
  `a45b7f0cb78b9611e19564bb9114edd1cc20b50a`; GitHub potwierdził brak konfliktów
  z bazą master `377f3ced6d314ecfc46bc63211563dca4483765f`.
- Otwarcie PR automatycznie uruchomiło bootstrap i dispersion-artifact-consumers,
  zawierające kompilację testów jednostkowych. Trigger powinien był zostać
  sprawdzony przed publikacją. Oba runy anulowano po wykryciu konfliktu z zakazem:
  `39301560727` i `39301560778`, końcowy stan `cancelled`.
- Przed anulowaniem job `native-modal-cabi-contract` zakończył się sukcesem,
  w tym kroki kompilacji i wykonania kontraktów C++/native ABI. Rust unit step
  był w toku przy anulowaniu. Nie przedstawiamy tego jako kwalifikacji DEV,
  runtime Linux ani pełnego CI; nie usuwano logów/artefaktów tego incydentu.
- CI źródeł ujawniło dwa fixture Windows dziedziczące UID/GID runnera Linux.
  Poprawki pozostają w testach: jawny Windows owner dla starego namespace cache
  i scoped Windows-verifier ledger oraz osobna regresja Linux cache key/labels.
  Metadane komendy w trzech source-only fixture są mockowane, bez zależności
  od rzeczywistego Docker CLI. Produkcyjna walidacja ownership nie została osłabiona.
- Po poprawkach Ubuntu2: `test_docker_volume_receipts.py` 17/17 PASS,
  `test_verify_docker_all_runtime.py` 13/13 PASS.
- `contract-guard` dla a45b7f0 zakończył się sukcesem. Następny commit używa
  `[skip ci]`, żeby nie ponowić zabronionej kompilacji przez automatyczny trigger.
  Pominięcie workflow nie jest zaliczeniem wymaganej bramki; pełne CI pozostaje
  blokadą integracji do rozstrzygnięcia zakresu czasowego zakazu.
- Główny checkout przy HEAD 377f3ced6 ma cudze staged/dirty i nierozstrzygnięte
  ścieżki docker_startup.rs, docker_volume_dev.py oraz docker_volume_stop_failed.py.
  Nie próbowano lokalnego ff ani ich rozwiązywania. Worktree zadania pozostaje
  zachowane do kwalifikacji, merge i bezpiecznego zamknięcia cyklu.