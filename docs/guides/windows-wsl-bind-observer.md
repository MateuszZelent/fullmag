# Obserwator bind mountów Windows–WSL

Stan: **implementacja obserwacji i testy kontraktu; brak kwalifikacji do naprawy danych**.
Publiczne `prove_foreign_windows_bind_disjoint` oraz
`validate_foreign_windows_bind_disjoint_proof` odmawiają autoryzacji, dopóki nie
powstanie sprawdzony dowód aktywnego powiązania pliku VHD z VM. Zmienna środowiska
ani pole w dostarczonym JSON nie wyłącza tej blokady. Ta zmiana nie uruchamia
migracji, usług, obliczeń ani sprzątania.

## Cel

Kontroler uruchomiony w WSL nie może traktować `C:\...`, `/host_mnt/c/...` ani
`/run/desktop/mnt/host/c/...` jak lokalnej ścieżki POSIX. Inny działający worktree
może używać takiego bind mountu równocześnie z naprawą zatrzymanej grupy.
Odmowa nie upoważnia do zatrzymania tego worktree. Obserwator ma ustalić
rzeczywiste tożsamości zasobów bez zmiany jego stanu.

## Zaimplementowane obserwacje

- Natywny Windows otwiera każdy komponent ścieżki bez podążania za reparse points
  i utrzymuje uchwyty bez `FILE_SHARE_DELETE`. Zapisuje pełny FileId128,
  identyfikator wolumenu i rzeczywisty path oraz powtarza kontrolę stabilności.
- Czytnik VHDX czyta wyłącznie ograniczone nagłówki, tablice i metadane tożsamości.
  Sprawdza CRC32C, wymagane regiony i wpisy, odmawia dysków różnicowych oraz
  powtarza odczyt istotnych metadanych. Nie podłącza dysku, nie odtwarza logu
  i nie czyta danych sesji. LogGuid różny od zera jest jawnym ograniczeniem.
- Pomocnik Linux odczytuje metadane mountu z `/proc/<PID>/root` istniejącego
  procesu. Używa jego dokładnego niezerowego UID:GID, `--pid=host`,
  `--cap-drop ALL`, read-only filesystem, `no-new-privileges` i braku sieci.
  Nie wykonuje `exec` w aplikacji, `nsenter`, podnoszenia capabilities ani
  odczytu pamięci, środowiska lub zawartości wyników.
- Obserwacja przypina ID kontenera, obraz, StartedAt, PID/start ticks, cgroup,
  namespace, pełne Mounts i izolację. Porównuje istniejący mount ze świeżym
  bindem kandydata przez device/inode i mountinfo.
- Zagnieżdżone mounty muszą stanowić dokładnie zinwentaryzowane istniejące
  wolumeny lokalne. Sprawdzane są ich rzeczywiste katalogi i brak nakładania
  z chronionym control/ledger. Dowód jednego bindu nie pomija pozostałych
  pozycji Mounts w kontrolerze.
- Pełny 128-bitowy identyfikator MSFT VPD83 jest porównywany z VirtualDiskId.
  Nie ma odtwarzania GUID z obciętego NAA ani zgadywania numeru `/dev/sdX`.

## Nierozstrzygnięta granica aktywnego VHD

Rejestr Lxss i ustawienia Docker Desktop opisują skonfigurowane ścieżki.
Zgodność VirtualDiskId z VPD83 nie potwierdza sama w sobie, że VM korzysta
właśnie z otwartego pliku: kopia VHD może zachować identyczny GUID, a konfiguracja
mogła zmienić się przed rozpoczęciem obserwacji. Utrzymywanie uchwytów i dwa
odczyty zapobiegają zmianom podczas pomiaru, lecz nie uzupełniają brakującego
powiązania z aktualnym attachmentem.

Dlatego nawet kompletny, wewnętrznie spójny rekord pozostaje materiałem
obserwacyjnym. Prywatny walidator rekordu służy testom spójności, a publiczna
bramka odrzuca jego użycie do naprawy. Usunięcie tej blokady wymaga osobnej
implementacji systemowego dowodu: aktualna inkarnacja VM, urządzenie gościa,
pełna tożsamość aktywnego pliku hosta oraz stabilność tego powiązania w całym
oknie operacji. Niedostępność API, prawa dostępu lub nieobsługiwana topologia
muszą zachować odmowę. Sam `OpenVirtualDisk`/odczyt surowych metadanych nie jest
takim dowodem.

## Pozostałe ograniczenia i przyszła kwalifikacja

Zatrzymany obcy kontener nie ma PID nadającego się do tej obserwacji. Nie jest
pomijany w audycie recovery; wymaga osobnego kontraktu, który uwzględni możliwość
restartu. Ledger w obrazie loop/ext4 oraz nieznane urządzenia pozostają poza
obsługiwanym zakresem. Brak źródła nie upoważnia do utworzenia pustej sesji.

Po domknięciu aktywnego attachmentu kwalifikacja musi odbyć się na świeżych
obserwacjach działającego silnika. Historyczne PID i mountinfo nie są dowodem po
restarcie. Natywny interpreter wskazuje jawne
`FULLMAG_WINDOWS_IDENTITY_PYTHON`; adapter nie instaluje go i nie uruchamia
zatrzymanych dystrybucji. Wymagane są regresje dla kopii VHD o identycznym GUID,
zmiany konfiguracji, podmiany mountu, wolumenów zagnieżdżonych i odmowy dla
zatrzymanych konsumentów. Dopiero potem można kwalifikować readmisję i recovery
poszczególnych zatrzymanych grup. Migracja pozostaje częścią kolejnego świadomego
uruchomienia.

## Weryfikacja źródeł

Testy interpretowane: `test_windows_bind_identity.py`,
`test_windows_vhd_identity.py`, `test_docker_windows_bind_probe.py`,
`test_docker_windows_bind_identity.py` oraz regresje readmission/abrupt-stop.
Bootstrap CI uruchamia te same zestawy. Testy rekordów, odczyty natywnych
metadanych i pełne wykonanie adaptera mają oddzielny zakres dowodowy.

Podstawy kontraktów:
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[FileIdInfo](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info),
[nagłówki VHDX](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/39d641c2-093c-4d4a-8c9d-bd4b9fc2ff31),
[VirtualDiskId](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/a0a7450d-551b-46f6-9025-485121aa6aab),
[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
[HCS properties](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsgetcomputesystemproperties).
