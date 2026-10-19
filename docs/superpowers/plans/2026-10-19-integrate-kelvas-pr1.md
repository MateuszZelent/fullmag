# Integracja Kelvas888/fullmag PR #1 — plan i checkpoint

Data: 2026-10-19. Zadanie: pełna obsługa DEV Linux/WSL w bieżącej architekturze
Compose, zgodnie z jawną decyzją użytkownika. Zmiana znosi wcześniejsze
ograniczenie startu DEV do natywnego Windows. Nie zmienia granicy danych:
build/cache/staging/provenance/logi i receipty buildu pozostają w Docker
named volumes / BuildKit; sesje, wyniki, projekty i ustawienia w wybranym
trwałym storage hosta.

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

## Bieżący checkpoint

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
