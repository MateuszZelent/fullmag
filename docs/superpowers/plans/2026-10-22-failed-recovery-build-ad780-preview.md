# Przegląd odzyskania własnego nieudanego recovery-build ad780

Stan: przygotowany kod i rzeczywisty podgląd; **APPLY nie wykonano**.
Dokument dotyczy operacji budowania, nie terminalizacji zadania naukowego.

## Dokładny podgląd do decyzji operatora

- Grupa: fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
- Wolumen: fullmag-build-control-fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1-298fce24f73bea22.
- Operacja: ad78022c285049968f0a5ea81a9d4612.
- Backend: dcaeed261a58b4e42f87aa3727ddb212eb16c653ae892503d70f2a601097787e.
- Obraz: sha256:ec2384b94c02f8376599b1bd3ffbaab9c404f54e623a3cbde1481790ca8dc008.
- Request w wolumenie: verification/failed-build-recovery/ad78022c285049968f0a5ea81a9d4612/3b8b60e9239c451cb82f82918c7689dd/request.json.
- SHA256 pełnych bajtów requestu: 5507b974eb97c119e4e8cdb1051840f696d054a8cd702141fe2daeb4c9113c7a.
- Obok zachowano review.json. Wcześniejszy podgląd 44eb0736... jest nieaktualny
  po poprawce wspólnej blokady operacji; pozostaje dowodem historycznym.

Podgląd wykonano receptą just docker-dev-recover-failed-build bez apply.
Odczytał konfigurację i dowody, zapisał wyłącznie request/przegląd w wolumenie.
Nie wysłał sygnału i nie przejął żadnego natywnego guarda.

## Dowód zakończenia Make

Dawny kontroler po błędzie kompilacji zatrzymał się w retained_unknown mimo
trwałego dowodu zakończenia Make. Dwa procesy Python utrzymują natywne guardy.
Zmiana źródeł nie zmienia kodu już działających procesów.

Kandydat /opt/fullmag/package/.development/candidates/.backend-package-candidate-qc31opdm
zawiera wyłącznie marker building, SHA256:
ad0a6625795b8cf9771c73b54c41663bf7e98e7580b743fe27df2b513d4f6c2c.

W /build/failed-candidate-diagnostics/.backend-package-candidate-qc31opdm:
- attempt.json: d24fbc668df013a4c0a9df8c5690e1957a7dd5637256c8d1ae2e5283c2e606f1,
  stan failed, rzeczywisty kod Make 2;
- direct-backend-build.log: 125655 bajtów,
  9917739c429a8c90a529962b1ba4356c2b2173f41b9aa3b60a2f41f6a1c0ca80.

Istniejący walidator backendu sprawdził metadane, tożsamość kandydata oraz
hash/rozmiar logu. Błąd E0599 osobno poprawiono; adapter nie buduje pakietu.
Receipt starting: 946843c3978b8804f3cfabcd79543cb78cc2ca03ff9c40214f7cd6ccae0a3c96.
Końcowy build.log zostanie przypięty dopiero po naturalnym zakończeniu
starego managera i potwierdzeniu LOGGED przez oryginalnego helpera.

## Granica ewentualnie zatwierdzanego APPLY

1. Ponowna walidacja requestu, wygenerowanego kodu, źródeł, grupy, obrazu,
   instancji backendu, readonly source/cache i oryginalnego helpera.
   Żadnej nowej operacji BuildControl.
2. Jedna stała blokada recovery-build/attempts/ad78022c285049968f0a5ea81a9d4612/legacy-handoff.lock
   serializuje wszystkie requesty tej operacji. Wymagane nofollow, pojedynczy
   link i ten sam inode po uzyskaniu flock. UUID przeglądu nie tworzy osobnej
   domeny autoryzacji.
3. Jednorazowy zamiar native-handoff.json, bez automatycznego replay częściowego
   zamiaru. Dokładne pidfd obu kontrolerów; argv SHA, start token, PPID,
   namespace, boot ID i brak dodatkowych potomków.
4. Wyłącznie SIGINT do własnego rodzica PID 7793, start 8219635, i czekanie
   na exit pidfd. Następnie tożsamość dziecka PID 7799, start 8219724, po
   dokładnie oczekiwanym przejściu PPID 7793 do 1; ponowne sprawdzenie
   namespace init i deskryptorów czterech locków; dopiero wtedy SIGINT do
   dziecka i czekanie pidfd. Wyjście przez istniejące finally, bez SIGKILL
   i bez usuwania plików lock.
5. Uzyskanie istniejących locków w kolejności STARTUP-GATE, LAUNCH, OWNER,
   backend build. Inody muszą pozostać zgodne z podglądem.
6. Ponowna kontrola pakietu/runtime/failed Make; atomowe
   renameat2(RENAME_NOREPLACE) marker-only kandydata do
   /opt/fullmag/package/.development/quarantine/.backend-package-candidate-qc31opdm.
   Fsync katalogów i kontrola markera. Diagnostyka Make pozostaje na miejscu.
7. Stary WSL manager PID 106318, start 8218154, jest wyłącznie obserwowany
   przez pidfd, bez sygnału. Wymagane jego naturalne zakończenie oraz
   jego naturalny receipt outcome-unknown-resources-retained i LOGGED.
   Zachowujemy oryginalny receipt i pełne bajty unknown receiptu.
8. Świeża kontrola chronionych rekordów i obecnego pakietu przed terminalnym
   failed-confirmed; filesystem_after i hash finalnego logu. Standardowe
   receipt.json, terminal.json, current.json tylko tej operacji.
   Wyłącznie oryginalny helper
   fadec10643a0c5e356253e42fce04cb4a198a47510040816060d6858f3512721
   usuwa swój active i kończy lease istniejącym protokołem.

Pełne argv SHA obu kontrolerów:
fa448d63c3ae0de740400c74d1e17bdf28a33f492e3638722422ecb4ba525f1c.
Kod historycznego kontrolera:
2e1b6f1b5455ab74965852819f497196c4d62fb121558b4f0b8a4bc212900e32.

## Zachowanie danych i granice zgodności

Nie zmieniamy starego pakietu, OWNER, konfiguracji runtime, provenance,
ledgerów, scientific claim, output Zarr, inboxu ani historii symulacji.
Zwolnienie flocków budowania **nie zwalnia compute lease**.
W podglądzie obecny package receipt:
4b65c4ab2aac83c10978168180dbf4c983a6715ac08b434e80c764a61a6ac7f2,
OWNER a66af53a0969ef42d45aac57f2552da14c5c3bcdb254ead8491dbb0b53bd5d41,
process receipt 562bb159c1e50065886ad4cc9b689298de674bb49f64f5b3c05482376aa5b2d2,
host ledger ec6a357f17fc078619660078911ecedd640a51c4e66a8edda93918e6f7c3cbab.
Pełne pozostałe hashe i inody zapisano w request/review.

ACK przyszłych buildów dotyczy wyłącznie BackendBuildError z trwałym failed
MakeAttempt, niezerowym kodem, marker-only kandydatem i niezmienionym
pakietem/runtime. Guard niezależnie weryfikuje dowód, archiwizuje kandydata
i zapisuje wynik przed ACK FAILED_CONFIRMED. Parent potwierdza exit guarda
i kończy kodem 43; zwykła finalizacja BuildControl zamyka własną operację.
Sukces i unknown zachowują dotychczasowy kontrakt. Nie obejmuje to dowolnego
exit1, częściowej publikacji lub dowolnego porzuconego procesu.

Rozbieżność dowodów odmawia przejęcia/finalizacji. Przerwanie po zamiarze,
timeout pidfd, błąd archiwizacji lub publikacji wymaga osobnego przeglądu
zachowanych dowodów; brak automatycznego replay/retry i ręcznego czyszczenia.
Nie deklarujemy pełnej odporności replay ani actual recovery przed APPLY.

## Weryfikacja i mapowanie źródeł

27/27 interpretowanych testów Python przeszło w istniejącym backendzie,
bez kompilowania Rust/native unitów: pełne produkcyjne inside/fork guard/
BackendBuildError/ACK/exit43, rzeczywiste fixture flock/pidfd SIGINT/
reparent/unwind, kolizja atomowego archiwum, odmowa zmiany tożsamości,
pinów i ścieżek, wspólny lock dwóch preview, dokładny wrapper i odmowa
nieprzypiętego apply. To kontrolowane fixtures, nie wykonanie actual recovery.
bash -n i just --dry-run przeszły; rzeczywisty preview przeszedł.

- scripts/docker_dev_recovery_build.py: failed_make_result,
  archive_failed_make, guard, inside, run.
- scripts/docker_dev_failed_build_recovery.py: observe,
  interrupt_owned_controllers, finalize_native, finalize_native_locked,
  manager_pin, validate_request, run.
- scripts/test_docker_dev_recovery_build.py;
  scripts/test_docker_dev_failed_build_recovery.py.
- justfile: docker-dev-recover-failed-build.
- scripts/just_storage_shell.sh: dokładna gałąź nowej recepty.

Źródła zamrożone requestem:
- adapter: 8e9034fb24d7ade98beb8244361fd3fc76a4f1ea274a4486a3a2f09b0c515e8c;
- repair: 06887dc94f4303af154a5066712e2522307454d383212ac2b3411d35b22af817;
- wygenerowany apply: 1c03a6182fbe26d9b61b4b5a5780fccacc45148eef3ee374cbefdfb1d33a3996.

Aktywacja pozostaje do osobnej decyzji o opisanych dwóch kontrolowanych
SIGINT i finalizacji tej operacji. Podana przez użytkownika instrukcja AGENTS.md
wymaga pytania, gdy zmiana dotyka elementu load-bearing, wersjonowanego lub
podlegającego migracji. Tu nowy protokół przejmuje istniejącą blokadę operacji;
podgląd i testy nie stanowią zgody na jego aktywację.

Niezależna kontrola końcowa root: 27/27 PASS w4.22s. Pełny log i receipt
root-reviewed-regressions.log/json zapisano obok końcowego requestu.
SHA256 logu: b551bbbd110f5aa1d077b823e19646359447e9dbdf5ca30cbbe61a7c2dfe6bac.

## Wykonanie po zgodzie użytkownika

Użytkownik zatwierdził procedurę dla requestu5507b974.... Pierwsze uruchomienie
zatrzymało się przed native call: hostowy Python3.12.10 nie ma os.pidfd_open,
podobnie systemowy Python3.8.10. Testy kontenerowe nie wykrywały tej różnicy.
Nie wysłano wtedy sygnałów. Sprawdzono lokalny nagłówek unistd_64.h:
__NR_pidfd_open434, Linuxx86_64; libc nie ma wrappera, ma syscall.
Zamiast instalować kolejny interpreter albo zmieniać natywny protokół,
dodano zgodną obserwację pidfd przez syscall434/flags0 wyłącznie na Linuxx86_64.
Nieznana architektura odmawia; errno zachowane. Podgląd sprawdza teraz także
rzeczywisty hostowy pidfd przed decyzją. Dokumentacja:
[Linux pidfd_open](https://man7.org/linux/man-pages/man2/pidfd_open.2.html),
[Python os](https://docs.python.org/3/library/os.html#os.pidfd_open).
Dwa rzeczywiste testy obserwacji własnego child exit w WSL PASS,29/29
regresji interpretowanych w backendzie PASS. Nie kompilowano native unitów.

Nowy podgląd: verification/failed-build-recovery/ad78022c285049968f0a5ea81a9d4612/5637b800f3c6491f95671ed5943d1f12/request.json,
rawSHA256f975dc21c7c8b0c37aa60f858a13da9f551fee4690997d9a403d1c3bc7ab2b3f.
AdapterSHA9fa192f3722cf5f3d065ac329254793ec885d7f9385b4d975feb26750996e14f.
Porównanie host-compatibility-diff.json potwierdza: tylko adapter hostowego
obserwatora i ścieżka nowego dowodu; kod native apply1c03a618... i repair06887dc9...
identyczne, identyczne oba procesy, manager, blokady i wszystkie chronione rekordy.
Nie rozszerzono zatwierdzonego zakresu działania.

Recepta apply zakończyła się exit0 i failed-confirmed. Dokładne PID7793/7799
zakończone, przejście PPID7793→1 potwierdzone; oryginalny manager zakończył
się naturalnie. Kandydat qc31opdm zachowany w quarantine. Oryginalny helper
zakończył własny lease; active nie istnieje, candidates pusty, wszystkie cztery
istniejące locki dają się uzyskać bez wymiany inode. Chronione rekordy bez zmian.
Terminal: recovery-build/attempts/ad78022c285049968f0a5ea81a9d4612/terminal.json.
Pełny finalny log128513B SHA256
30e969a3c4fec1c1d422e2d9f63e1e046a04125ce8e06b9431e3d576ea70a602.
Scientific claim pozostaje nietknięty; nie wykonano ponownego Solve ani startu API.
