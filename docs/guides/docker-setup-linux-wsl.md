# Konfiguracja hosta Docker z Linux/WSL

Konfigurator działa z Pythonem Windows oraz z Pythonem Linux/WSL. W WSL włącz
integrację Docker Desktop dla używanej dystrybucji i uruchom w checkoutcie:

```bash
python3 -B scripts/setup_docker.py
```

Kreator pyta o bezwzględną ścieżkę storage, zarejestrowany checkout źródeł
i port. Dla Linux/WSL checkout i storage muszą znajdować się na lokalnym
ext4, xfs albo btrfs. Można używać checkoutu w katalogu domowym WSL; nie trzeba
przenosić go do Windows. Katalogi tymczasowe i sieciowe nie są storage tej
trasy. Nie podawaj ścieżek Windows ani mountów dysków Windows typu `/mnt/c`;
walidacja tej konfiguracji obejmuje lokalne systemy plików Linux.

Zapis następuje po potwierdzeniu planu. Kreator zachowuje istniejące hasła
i pozostałe wpisy `.env` głównego checkoutu. Ustawienia źródeł i portu zapisuje
w `index/docker-host-settings.json` wybranego storage. Nie przejmuje niepustego
storage bez markera ani storage innego projektu. Worktree korzystają ze
wspólnego `.env`; nie kopiuj go.

Kontrola bez zapisu i pytań:

```bash
python3 -B scripts/setup_docker.py --check
# Opcjonalnie sprawdź konkretny zarejestrowany checkout:
python3 -B scripts/setup_docker.py --check --source-root /absolute/checkout
```

Kod `0` potwierdza konfigurację hosta i dostępność wymaganych narzędzi.
Kreator nie buduje obrazów, nie uruchamia kontenerów i nie kwalifikuje GPU.
Widoczność `nvidia-smi` nie dowodzi wykonania solvera w kontenerze.

Builder i launcher obsługują natywny Linux oraz WSL z dostępem do silnika Docker
Linux. Na Windows wybierają context `desktop-linux`; w Linux/WSL respektują
bieżący context i `DOCKER_HOST`. Oba polecenia wykonaj z katalogu tych samych
wybranych źródeł, aby należały do jednego projektu Compose:

```bash
just docker-dev-toolchain
just docker-dev "$PWD" 3197
```

Toolchain buduje zależności przez Compose/BuildKit. Stały `backend` buduje
aplikację i uruchamia API, a `frontend` obsługuje HMR. Dane budowania, logi
i receipty pozostają w named volumes/BuildKit. Sesje i ustawienia pozostają
w wybranym storage Linux hosta. Launcher nadaje operatorowi i UID 65532 dostęp
do nowych katalogów runtime przez ACL; nie zmienia praw checkoutu ani nie
nadaje zapisu wszystkim użytkownikom.

Postęp toolchaina jest w terminalu i w Docker Desktop → **Builds → Active
builds**. Kontener `fullmag-control-…` utrzymuje blokadę i zapis logu; jego
komunikat `READY` oznacza gotowość helpera. `docker ps` pokazuje kontenery,
natomiast aktywne buildy można sprawdzić przez `docker buildx history ls`.
`docker buildx history inspect <build-id>` podaje stan i odnośnik do Docker
Desktop. Długi etap CUDA może nie wypisywać nowej linii aż do zakończenia
kompilacji danego pliku. Backend i frontend pojawią się po przygotowaniu
zależności i uruchomieniu `just docker-dev`.

Storage `linux-native-v1` ma osobny certyfikat owner/engine/image i kontrole
fsync, publikacji atomowej, blokady procesu, SQLite oraz readback. Windows
zachowuje `windows-folder-v1` i własną walidację NTFS/ReFS. Mapowanie WSL do
przestrzeni mountów Dockera jest obserwowane i sprawdzane przed utrzymaniem
ledgera hosta. Brak integracji WSL, niedostępne ACL lub niezgodny filesystem
kończą się błędem; launcher nie przenosi sesji do tymczasowego storage.

Recepta uwzględnia `FULLMAG_CUDA_*`, `FULLMAG_HYPRE_GPU_ARCHITECTURES` oraz
`FULLMAG_PETSC_CUDA_ARCHITECTURES` z `.env`. Dobierz je do GPU i wersji CUDA.
`FULLMAG_MFEM_BUILD_JOBS` domyślnie wynosi `1`, ponieważ kompilacja szablonów
CUDA może zużywać dużo pamięci na jeden proces. CPython budowany w obrazie
pomija moduły testowe i helper `_testembed`.

`FULLMAG_MFEM_CUDA_FAST_COMPILE` wybiera poziom `0`, `min`, `mid` albo `max`
dla kompilacji GPU biblioteki MFEM. Domyślne `0` zachowuje pełne optymalizacje.
Poziom `mid` wyłącza kosztowne optymalizacje, skracając kompilację kosztem
możliwej wydajności runtime; wymaga NVCC obsługującego `--Ofast-compile`
(CUDA 12.9+). Szczegóły: [dokumentacja NVIDIA](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-compiler-driver-nvcc/index.html#ofast-compile-level-ofc).
Wybór jest częścią tożsamości obrazu i manifestu zależności. Zmiana wymaga
ponowienia odpowiednich etapów toolchaina; zachowaj cache wcześniejszych prób.

Wznowienie, restart i odtworzenie korzystają z przypiętej próby oraz hashu
konfiguracji: [procedura volume DEV](docker-volume-development.md). Nie
przekazuj ścieżek Linux do natywnego launchera Windows. Sam sukces konfiguracji
lub testów źródłowych nie kwalifikuje API, HMR ani solvera GPU; wymagany jest
receipt konkretnego wykonania i osobne dowody runtime.
