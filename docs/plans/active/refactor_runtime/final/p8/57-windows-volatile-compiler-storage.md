# P8-57 — ulotne dane kompilatora na RAM-disku Windows

## Decyzja i zakres

Na żądanie użytkownika z 05.10.2026 lokalne `.env` głównego checkoutu
ustawia `FULLMAG_WINDOWS_VOLATILE_ROOT=R:/fullmag/volatile`. Trwały
`FULLMAG_PROJECT_STORAGE_ROOT` pozostaje bez zmian. Backup lokalnego `.env`
zapisano poza repozytorium, w `storage/tmp/host-config-backups/`.

| Dane | Lokalizacja |
|---|---|
| Odtwarzalna kopia źródeł kompilatora | Na tym hoście trwały profil; R: dopuszczony tylko przy obsłudze normalizacji ścieżek |
| TEMP/TMP/TMPDIR podczas Cargo, w tym procesy potomne | R:, `tmp` tego samego profilu |
| Utrwalone snapshoty, hashe i wersjonowanie | Trwały storage |
| Target Cargo i cache przyrostowy | Trwały storage |
| Python, frontend, gotowe EXE i pakiety | Trwały storage |
| Manifesty, logi, receipts, sesje i wyniki | Trwały storage |

Recepty pozostają takie same: `just windows-ui dev` oraz
`just windows-backend-dev 3197`. Nie przeniesiono istniejących cache ani
danych sesji i nie zmieniono systemowego TEMP. TEMP procesu launchera jest
przywracany w `finally`, także po błędzie. Po utracie całego RAM-diska jego
zawartość może powstać ponownie ze zweryfikowanego snapshotu. Niekompletna
istniejąca kopia nadal podlega ochronie integralności; nie jest automatycznie
naprawiana. Brak skonfigurowanego dysku blokuje nowy build bez fallbacku.

Helper odrzuca nakładanie się katalogów, przekierowania ścieżek, obce
oznaczenia i nieoznaczone niepuste katalogi. Weryfikuje projekt, zarejestrowany
checkout, profil i kanoniczny trwały build root. Wybrana kopia źródeł jest
sprawdzana przed i po kompilacji względem trwałego snapshotu.
Uruchamianie istniejącego pakietu nie przygotowuje ulotnego katalogu.

## Weryfikacja

- R: dostępny jako lokalny dysk NTFS, około 80 GiB.
- Interpretowane testy compiler-input: 14/14 PASS; dodatkowe sprawdzenie CLI
  materialize ze wskazanym working root: PASS.
- Kontrole helpera storage i bloku Cargo, w tym nieobsługiwana normalizacja
  ścieżek i odrzucenie innych błędów Win32: 8/8 PASS.
- Wykonywalna kontrola rzeczywistego bloku Cargo z wymuszonym błędem:
  routing TEMP/TMP/TMPDIR i przywrócenie wartości: PASS.
- Parser PowerShell i składnia Pythona: PASS.
- Rzeczywisty managed build `just windows-backend-dev 3197`: kompilator
  otrzymał kod z R: oraz rzeczywisty plik argumentów `tmp/cargo-argfile.*`
  na R:. Log `native-build-919ae053c6124ffeaebbe8bf08ac823e.log`
  pozostaje w trwałym profilu `windows-native-fdm-cpu-dev`.
  Pierwsza próba zakończyła się błędem desktopu opisanym poniżej.

Pierwsza próba zbudowała backend/API, lecz powłoka desktopowa zgłosiła
`os error 1`. Bezpośrednia kontrola Windows `GetFinalPathNameByHandleW`
potwierdziła błąd 1 na R: i poprawny wynik na C:. Finalny preflight wykrywa
ograniczenie i pozostawia jedną trwałą kopię źródeł dla całego workspace,
a pliki tymczasowe kompilatora nadal zapisuje na R:. Nie zmieniono bibliotek
Tauri ani sterownika RAM-diska. Próba przejściowa z dwoma lustrami ma log
`native-build-996524eb4df240878a5fb0e92218a447.log`; nie jest dowodem
finalnej polityki jednej kopii.

Finalny `just windows-backend-dev 3197`: **PASS, exit 0**. Log:
`native-build-96ec107ab19a4100a377ce54ff90296a.log`. Status zarządzanego profilu:
`completed`, exit 0; manifest SHA-256:
`dfb3678fbd6f4937ce7fd45d13ed70596ee79a64b60aa05b8281c527fe4a69a9`.
Utrwalony snapshot: `e1ae2b98929cef4001032fc26327d2ff150965989d3b82ec232da79150a53a2c`.
Wersja: `0.1.0-dev.20261005.g7214071e8630.dirty.s65f2ca8bd048+9774`.
Manifest potwierdza TEMP na R:, `compiler_inputs_enabled=false`, kopię
źródeł i target Cargo na C:. Wszystkie trzy pliki EXE istnieją na C:.
Kompilacja backendu/API: 4m39s; desktopu: 51,29s. Czasy obejmują ten
konkretny snapshot i stan cache; nie są porównaniem wydajności RAM-diska.

Zakres nie obejmuje kontenerowego FEM ani Linuxa. Brak pomiaru przyspieszenia;
zapis na RAM-disku sam w sobie nie dowodzi krótszego pełnego buildu.
