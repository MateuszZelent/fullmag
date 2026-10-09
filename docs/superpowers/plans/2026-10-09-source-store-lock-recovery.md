# Plan naprawy 4207002965: odzyskiwanie blokady publikacji CAS

Status: niezależne pełne SOURCE review PASS; hosted wykonanie pozostaje niekwalifikowane.

## Przyczyna

Publication lock powstaje przez O_CREAT|O_EXCL i zawiera tylko PID. Awaria
przed finally pozostawia go na zawsze; blokada poprzedza także weryfikację
już opublikowanego obiektu. Ten sam protocol chroni Windows unlink/reseal
hardlinków. Dotyczy klienta Windows i koordynatora Linux na wspólnym storage.

## Decyzja

Primary cross-OS coordination pozostaje atomową, wyłączną obecnością canonical
locka. Nowy v2 rekord token/OS-kernel-boot-PID-namespace/generation jest kompletny
w prywatnym fsynced temp, zanim exclusive publication uczyni go canonical.
Normalne zwolnienie wiąże dokładny token i inode. Nie używamy TTL lub PID-alone.

Recovery tylko dla confirmed-dead ownera w dokładnie tej samej przestrzeni
OS/kernel/boot/PID. Lokalne procesy odzyskujące ten namespace serializuje jeden
persistent recovery-only kernel gate na root CAS. Nigdy nie usuwamy ani nie
zastępujemy jego pliku. Nie zakładamy współdziałania flock/msvcrt między OS:
foreign namespace nie jest uprawniony do automatycznego reclaim.

Pod gate ponownie czytamy namespace, token, inode i liveness/generation.
Dopiero wtedy wykonujemy pojedynczy unlink tej potwierdzonej martwej blokady.
Kolejny reclaimer musi odczytać nowy rekord, nie korzystać ze starego snapshotu.
Nie stosujemy blind rename i późniejszej próby odtworzenia aktywnego locka.

Gate ma regular-file, no-follow, pinned-identity preflight/open, nie gołe
Path.open(a+b). Owner verifier zwraca alive/dead/unknown. AccessDenied, błędy
API, nieudany namespace/generation probe lub niejednoznaczny PID pozostają
unknown. Nie używamy process_alive=False z obecnego ogólnego adaptera Windows
jako dowodu śmierci. Windows generation i liveness mają pochodzić z jednego
handle; Linux ze stabilnego proc snapshot. Bez wiarygodnego owner namespace
nie obiecujemy automatycznego odzyskiwania.

## Zgodność i granice

Legacy PID-only, pusty/uszkodzony rekord, obcy namespace i poprzedni boot są
zachowane i blocked. Dokładna operator reconciliation wymaga osobnej kontroli
aktywnych capture/retencji/processów/mountów; ta implementacja nie wykonuje
żadnego lokalnego cleanup. Nie zmienia CAS bytes ani readonly status przy
samym lock recovery. Obiekt nadal musi przejść istniejący hash/mode/size gate.
Nie kwalifikujemy SMB ani rzeczywistego Windows-host/Linux-container bind.

## Własność i kroki

Worker: source_store.py, nowy prywatny source_store_lock.py oraz
scripts/test_local_runner_source_store.py i focused lock tests, bez stagingu.
Root: plan/ADR/governance, code review i Linux/Windows GitHub Actions hooks.
Retencja i UI są własnością innych zakresów; ich dirty changes są zachowane.

## Odbiór

Regresje GHA: multiprocess publication, crash przed/po publikacji, kill owner,
równoległe reclaimers, PID reuse, query failures, live owner starszy od timeout,
foreign publisher po reclaim, legacy/corrupt owner oraz Windows hardlink/reseal.
Każda niepewna ścieżka blokuje, nie usuwa aktywnej blokady. Procesy testowe i
ich fixture'y są izolowane; lokalne testy/build/importy są zakazane.

## Dodatkowe wymagania po niezależnym review

1. Rozgrzany, bezczynny store po fork odświeża PID/generation i dziedziczone lokalne mutexy przed ich użyciem. Fork podczas aktywnej publikacji/recovery blokuje operacje dziecka; dziecko nie może unlinkować lease ani odblokować współdzielonego deskryptora rodzica. CLOEXEC nie jest zabezpieczeniem fork. Regresja wymaga żywego dziecka trzymającego lock po zakończeniu rodzica oraz odmowy child release aktywnego lease.
2. Procesy fixture przygotowują canonical parent obiektu przed prywatnym publication lock. Timeout przy brakującym katalogu nie jest dowodem crash recovery.
3. Równoległe reclaimers raportują terminalny sukces dopiero po sprawdzonym release; exception daje niezerowy exit. Test musi wykrywać overlap rzeczywistych sekcji krytycznych i błędy teardown, nie jedynie odebrać dwa komunikaty acquired.

Wszystkie trzy Required zostały domknięte i sprawdzone w ponownym pełnym SOURCE review trzech plików. AST i diff-check PASS. Istniejący bootstrap scope=retention ma dodany krok test_local_runner_source_store.py na Linux/Windows. Wykonanie hosted, cross-OS/SMB i odporność na utratę zasilania pozostają niekwalifikowane.
