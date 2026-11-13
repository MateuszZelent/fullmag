# P22: wznowienie zaakceptowanego runu po awarii ownera

Stan: implementacja i weryfikacja w toku. Nie wykonano wznowienia runtime.

## Cel i granica

Przywrócić własną grupę DEV i kontynuować istniejący, wcześniej zaakceptowany
zamiar bez anulowania zadań, ponowienia skryptu albo wysłania nowego Compute.
Przyjęty run ma zakończony A oraz B/C Accepted bez rozpoczętej próby. Kontrola
zgód odrzuciła alternatywę trwale anulującą B; ta operacja nie została wykonana.
Nowa ścieżka zachowuje stany i zamiar użytkownika, korzystając ze zwykłego
natywnego przejęcia kanonicznego Failed ownera. Nie jest obejściem przez
sfałszowany cancellation receipt, zmianę katalogu ani nowy request native v6.

## Istniejąca podstawa

RuntimeServiceOwner::acquire dopuszcza zastąpienie Failed ownera pod blokadami
startu i ownera. Scheduler pobiera wyłącznie nadal uprawnione Accepted/Queued;
Succeeded A nie jest kandydatem. Dotychczasowy start_release pozostaje bramką
niezmiennego zamiaru. Właścicielami tej semantyki pozostają fullmag-session
runtime_service.rs oraz accepted_scheduler_main.rs i runtime-control scheduler.
Host dodaje brakujący kontrakt zatrzymanej grupy, nie alternatywny scheduler.

## Wejście i dowody

Prywatne CLI `resume-failed-run-volume` wymaga jawnych pinów poprzedniego DEV,
Compose, source_root, portu, operacji stop-diagnostic, raw SHA jej terminal.json,
run_id i nowego UUID operacji recovery. Preview wyznacza plan; apply wymaga tego
samego żądania oraz niezmienionego SHA planu.

Rzeczywisty stop tej próby to 1656bd656a9841938a52bad946e16a69. Raw outer
terminal.json ma SHA46986e96ddfcdd7e1d6d14fc3b91d25d06baacc505af883a9f1cb221f59a01cb.
Outer diagnostic_stop_terminal_sha256 wiąże canonical typed body (19ea6700…),
a typed plik ma oddzielny raw SHA133544d7…. Raw process-tree po stopie ma
SHA80c381e2…. Tych różnych form nie wolno porównywać zamiennie. Typowany body
wskazuje poprzedni DEV a4ac20f260394af4ac1e5e1f575dcd3b, a nie UUID stopu.
Nie istnieje odpowiadający verification/stop-failed journal; nie wolno go fabrykować.

Plan musi wiązać i rewalidować:

- dokładny kontener backendu po potwierdzonym stopie, niezmieniony frontend,
  obraz, projekt, mounty/subpaths, sieć, storage, certyfikat i retained GPU intent;
- kanonicznego Failed ownera, zakończone dzieci, niezmieniony config/process/fence
  oraz brak zajętych rezerwacji hosta i aktywnych session leases;
- niezmienne bajty RunIntent, katalogu oraz istniejącego start_release;
- sukces poprzednich zadań, ich terminalny journal i worker exit0 oraz released lease;
- Accepted/Queued zadań do kontynuacji bez claim/attempt/epoch/resource,
  worker execution, admission lub cancellation. Same zakończone preparation
  receipts nie są dowodem rozpoczęcia compute;
- pozostały inventory runów, tak aby nie rozpocząć nieobjętej planem pracy.

Nieznana, zajęta, zmieniona lub niejednoznaczna tożsamość blokuje operację.
Host nie przepisuje RunIntent, katalogów, start_release, ownera ani wyników.
Nie interpretuje ponownie fizyki; native readiness nadal sprawdza dokładne
wejścia i proweniencję przed dopuszczeniem każdego następnego zadania.

## Handoff i lifecycle

Nowy typowany failed_run_resume_context przechodzi przez istniejące
recreate/_retained_operation/start. Ma własną authority diagnostic-stop;
nie podszywa się pod native failed-stop ani cancelled recovery. Domyślne
recreate i ich dotychczasowe odmowy pozostają aktywne.

Piny są sprawdzane w preflight, pod lease recreate przed usunięciem usług
oraz pod nowym development-start lease bezpośrednio przed Compose start.
Obraz/build, prywatne cache, frontend generation, source snapshot i receipty
pozostają w dotychczasowej zarządzanej ścieżce wybranej grupy. script=None,
fresh_state=False; brak cancellation i nowego RunIntent/Compute.

Powtórzenie ukończonego żądania zwraca jego istniejący dowód. Utrata obserwacji
lub unknown zachowuje guard i zasoby; nie upoważnia do ponownego startu.
Nie wolno zamieniać unknown w terminalny sukces na podstawie braku odpowiedzi.

## Odbiór

Testy Python z rzeczywistymi plikami tymczasowymi i mockowanym lifecycle mają
odtworzyć mixed A/B/C, odmowy driftu ownera, katalogu, gate, lease i scope oraz
rewalidację przed każdą mutacją. Muszą wykazać brak hostowych zapisów runu,
nowego Solve i cancellation, idempotencję ukończonego żądania i zachowanie unknown.

Rzeczywisty odbiór wymaga potwierdzonego Ready nowego backendu i dokończenia
tego samego run_id: A zachowuje swój attempt i artefakty; B/C otrzymują po jednej
własnej próbie. B.initial musi pochodzić z A.final, C.initial z B.final.
RunIntent i start_release pozostają identyczne. Dopiero potem wykonuje się
odbiór UI: Cell Physics, zmiany materiału/tekstury, Stage-only, mesh i Study,
historię, reload i WebGL2. Samo CI lub preview nie zamyka P22.

## Odczyt podczas zmiany obrazu

Observer korzysta z readonly bindów wybranej grupy. Certyfikat Linux jest
zadeklarowany jako bind `/run/fullmag/linux-native-host.json`; zmienna
`FULLMAG_HOST_CERTIFICATE` służy do interpolacji na hoście i nie jest wymagana
w środowisku kontenera. Observer odczytuje te same bajty przez
`/state/linux-native-host.json` i sprawdza deklarację oraz rzeczywisty mount.

Managed reuse może zmienić image/source i wyzerować restart_verified przed
Compose. Observer sprawdza trwałą tożsamość engine/owner/stanu i powiązany
store_id. Nie porównuje namespace nowego helpera z namespace starego backendu.
Pełny probe i admission nowego backendu pozostają obowiązkową częścią zwykłego
startu. Odczyt nie zapisuje certyfikatu, lease, katalogów ani wyników.

Idempotencja opiera się na wskaźniku konkretnej próby startu zapisanym pod jej
lease. Powtórzenie request_id weryfikuje jej immutable terminal nawet po zmianie
latest verified. Brak terminalnego dowodu sukcesu odmawia kolejnego dispatchu.
Sam historyczny sukces operacji nie oznacza bieżącej kondycji runtime ani
zakończenia obliczeń B/C; oba te fakty wymagają osobnego odbioru.
