# ADR 0064 — host Linux/WSL dla Docker DEV

Status: decyzja użytkownika przyjęta; kwalifikacja runtime w toku.
Data: 2026-10-19.

## Kontekst

Konfigurator i builder DEV odrzucały WSL mimo dostępnego silnika Docker Linux.
Usunięcie samej kontroli platformy pozostawiałoby windowsowy certyfikat sesji,
sztywne ścieżki i niewłaściwy bootstrap accepted store. Docker Desktop może
zwracać klientowi ścieżkę WSL, której nie widzi przestrzeń mountów demona.

## Decyzja

Rozszerzamy trasę volume DEV z ADR 0061 na natywny Linux oraz WSL. Windows
zachowuje context `desktop-linux` i profil storage `windows-folder-v1`.
Linux/WSL respektuje skonfigurowany endpoint Docker i używa osobnego profilu
`linux-native-v1` na lokalnym ext4/xfs/btrfs. Nie udaje dowodu NTFS/ReFS.

Projekt pozostaje `fullmag-master` albo `fullmag-worktree-<worktree-id>`.
BuildKit przygotowuje zależności i helpery, a ten sam stały `backend` kompiluje
aplikację i uruchamia runtime. Druga stała usługa to `frontend`. Cache, staging,
pakiety, logi i receipty builda pozostają w Docker volumes/BuildKit. Dane
użytkownika pozostają w skonfigurowanym storage hosta.

Certyfikat Linux wiąże katalog, owner token, Docker engine i obraz. Probe
potwierdza fsync, rename, blokadę między procesami, no-follow, SQLite i readback.
Rust dodatkowo wiąże admission z aktualnym mountem/namespace i zweryfikowanym
pakietem DEV. Tożsamość accepted store używa engine, ownera i ścieżki względnej,
zachowując stabilność przy restarcie i odtworzeniu kontenera. Format danych
delegacji `fullmag.windows-folder-development-build.v1` pozostaje współdzielony
z istniejącym walidatorem provenance; nie zmienia schematu certyfikatu Linux.

Host nadaje przez ACL dostęp operatorowi i UID 65532 wyłącznie w katalogach
runtime. Nie zmienia właścicieli checkoutu ani nie tworzy world-writable storage.
Istniejących obcych katalogów nie przejmuje. Nieznany wynik zachowuje zasoby
i wymaga recovery. Restart/resume/recreate sprawdzają uprzednio przypięte
źródła mountów demona, profil i ownership.

Przed utrzymaniem host ledger resolver potwierdza, że jego ścieżka demona
wskazuje ten sam marker storage co readonly bind klienta. Nie zgaduje ścieżek
dystrybucji WSL i nie usuwa starszych obrazów/cache.

Linux/WSL podłącza istniejący ledger ext4 przez projektowy wolumen sterownika
`local`, z urządzeniem `/dev/disk/by-uuid/<zweryfikowany-UUID>`.
Świeży receipt utrzymania wiąże UUID, obraz backing i aktualny loop device.
Nie wykorzystujemy numeru loop jako trwałej nazwy urządzenia. Przed startem
aplikacji nieuprzywilejowany konsument tylko do odczytu sprawdza marker,
uprawnienia i tożsamość urządzenia. Descriptor oraz receipt są przypięte w
Compose i kontrolowane ponownie przy wznowieniu oraz recovery. Brak zgodnego
urządzenia zatrzymuje start. Wolumen wskazuje ten sam istniejący filesystem,
nie tworzy nowego ledgeru. Mechanizm sterownika jest opisany w
[dokumentacji Docker](https://docs.docker.com/engine/storage/volumes/#how-mounting-block-devices-works).

Frontend Linux/WSL obserwuje źródła natywnie (`watch_mode: native`), gdy mount
`/opt/fullmag/source` leży na ext4, xfs albo btrfs: zdarzenia inotify docierają
z bind mountu do kontenera, więc Watchpack nie odpytuje drzewa. Windows
zachowuje polling, bo bind 9p nie dostarcza zdarzeń. Checkout DEV na ext4 w WSL
usuwa też koszt 9p z capture i synchronizacji źródeł backendu.

## Jawna readmisja po renumeracji urządzenia i nagłym zatrzymaniu

Rozszerzenie z 27.10.2026: `st_dev` może zmienić się po restarcie WSL.
Zwykły start nadal wymaga zgodnego certyfikatu; nie ignoruje tej różnicy.
Legacy certyfikat v1 nie zapisuje UUID filesystemu, więc sama zgodność inode
nie potwierdza jego historycznej tożsamości. Operator może jawnie ponownie
przyjąć konkretny istniejący magazyn: przypina źródła i grupę, dawny attempt,
Compose, kontenery i obraz oraz surowe SHA dokumentów właściciela. Nowy UUID
jest obserwacją bieżącego filesystemu, a nie dowodem brakującego starego UUID.

Readmisja dopuszcza zmianę wyłącznie `host_device`. Zachowuje root, inode,
engine, owner token i provenance. Pod blokadami grupy, OWNER i writera store
ponownie sprawdza zatrzymanie konsumentów i wszystkie piny. Przed publikacją
zachowuje dokładne bajty certyfikatu, markera, probe i readback w control volume.
Częściową publikację można kontynuować tylko z przypiętym manifestem i jedną
z dokładnych par starych/nowych bajtów; trzecia wartość blokuje operację.
Nieznana aktywna operacja kontrolera nadal wymaga osobnego recovery.

Zmiana certyfikatu unieważnia dawny probe. Readmisja nie produkuje nowego
probe, nie zmienia zapisanego `restart_verified` ani natywnego OWNER i nie
zwalnia rezerwacji. Przed admission API musi wykonać się normalny świeży
storage probe w zarządzanej grupie. Stabilna tożsamość accepted store nadal
używa engine, owner token i względnej ścieżki; dane sesji nie są migrowane.

Nagły stop kontenera z historycznym `Ready` nie jest dowodem drain. Hostowy
proof `fullmag.docker-abrupt-stop-proof.v1` zachowuje oryginalne bajty procesu,
OWNER, LAUNCH i konfiguracji oraz przypina rzeczywiste obserwacje stopped
namespace. Osobny schemat autoryzacji operatora v2 konsumuje ten proof bez
wymyślania stop-journalu i bez przepisywania historii na `shutdown_unknown`.
Brak starej bridge wymaga potwierdzonej nieobecności dokładnej sieci i pełnej
izolacji pozostałych zasobów; awaria odczytu Dockera nie oznacza nieobecności.
Natywne recovery nadal sprawdza blokady, store, leases i host reservations.
Tylko ono może opublikować rzeczywiste przejście właściciela.

Dla niepustego store request v3 przypina pełną listę terminalnych runów oraz
SHA ich intent, katalogów i opcjonalnego artifact catalog. Wyniki pozostają
niezmienione. Aktywny lub nieznany wynik obliczenia blokuje recovery; nie jest
automatycznie ponawiany ani oznaczany jako anulowany. Dotychczasowe requesty
v1 dla pustego store i v2 dla cancelled runs zachowują własne ścisłe reguły.

Stan wdrożenia: walidator i kontroler readmisji, hostowy abrupt-stop recovery
oraz bridge v3 zaimplementowane z regresjami Python. Bridge v3 wymaga
read-only introspekcji faktycznego binarium i zgodności SHA/provenance przed
natywną mutacją. Nowy helper nie aktualizuje kodu Rust wybranego checkoutu.
Kwalifikacja operacyjna pozostaje `NOT VERIFIED` do czasu rzeczywistej próby.
Wycofanie nie usuwa archiwów ani wyników i nie przywraca starych bajtów, jeśli
istnieją aktywni konsumenci lub zdążyło nastąpić kolejne admission.

## Obowiązki i weryfikacja

Adapter klienta i host paths: `docker_dev_host.py`; build kontrolny:
`docker_build_control.py`; sesje Linux: `linux_native_host.py` oraz
`linux_native_probe.py`; orkiestracja: `docker_volume_dev.py`; mapowanie demona:
`docker_wsl_bind.py`. Bootstrap oraz stabilną tożsamość accepted store sprawdza
`docker_desktop_storage.rs` i `host_resource_ledger.rs`.

Wymagamy testów źródłowych i operacyjnych host/guest, rzeczywistego toolchaina
przez `just docker-dev-toolchain`, startu obu usług przez `just docker-dev`,
gotowego API, potwierdzonych mountów oraz restartu z zachowaniem cache i danych.
Testy źródłowe nie dowodzą kompilacji ani działania solvera. Zakaz kompilacji
testów jednostkowych pozostaje w mocy; kompilacja aplikacji odbywa się w backend.
Model fizyczny, cztery realizacje FDM/FEM CPU/GPU i requested/resolved execution
pozostają zgodne z dotychczasowym kontraktem. Nie nadajemy nowej kwalifikacji
naukowej przez samą zmianę hosta.

## Wycofanie

Windowsowy adapter pozostaje osobną trasą. Wycofanie obsługi Linux/WSL nie
usuwa jego sesji, wyników, receiptu ani cache. Nie przenosi automatycznie
storage między systemami i nie resetuje ownera.
