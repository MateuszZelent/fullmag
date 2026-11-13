# Odzyskanie potwierdzenia nowego ext4 SP4

Cel: zakończyć provisioning istniejącego nowego filesystemu po błędzie odczytu
UUID przez findmnt. Nie powtarzać mkfs, mount, remount, Create ani Attach.
Zachować niezmienione poprzednie receipty, błędny journal i oryginalne dane.

1. Odczytywać UUID superbloku przez deskryptor katalogu, gdy findmnt jawnie
   zwraca null; nadal weryfikować urządzenie, ścieżkę, inode i pozostałe warunki.
   Obserwacje obcych pseudo-filesystemów zachowują dotychczasową semantykę.
2. Wydzielić w formatterze samo sprawdzenie istniejącego mountu i publikację
   markera. Poprawić konsumentów copy/bind/admission i obserwatora konfliktów.
3. Dodać zamknięty, przypięty SHA etap recovery w istniejącym izolowanym
   bootstrapie root i bridge WSL. Wymaga on failed-confirmed poprzednika,
   nowego journala recovery, niezmienionego Create/Attach, boot/namespace,
   urządzenia, UUID, pustego nowego ext4 i braku wcześniejszego wyniku/markera.
   Uprawnienia ograniczają się do markera i nowych dowodów provisioningu.
4. Sprawdzić regresje odmów, review i rzeczywisty odczyt UUID. Uruchomić recovery
   tylko raz pod blokadą wybranej grupy, zachować wynik i checkpoint.

Odbiór: linux-provision-result i sukces ext4-mounted wskazują rzeczywisty nowy
mount oraz rozróżniają oryginalny formatter od kodu kończącego recovery. Brak
ponownego formatowania/montowania, migracji danych, drain lub nowego Solve.
Kopia, kwalifikacja Zarr i przełączenie danych pozostają kolejnymi etapami
wcześniej zatwierdzonego planu magazynu.
