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
