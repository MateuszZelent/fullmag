# Terminalna sesja: odzyskanie po błędzie OCI przed PID1

## Cel i zakres

Próba c037af6df84448b1ba6576157b822914 zatrzymała się w hooku NVIDIA
przed nowym PID1. Zachowała terminal-session-preflight.json i backend-drain.json,
ale nie checkpoint saved-authoring. Bazowy development attempt
37062974a42f4ad4aec3976df9dfafe6 jest failed-confirmed; nie wolno przepisywać
jego historii. Autentyczny succeeded publication witness to iteration
94ca9bf8ff37455a939d416150c3b10a, wskazywany również przez iteration/verified.json.

Nowy wariant obejmuje terminalny current run, obecnie Failed
run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496,
i zachowanie dwóch accepted runów z ręcznym, niezwolnionym startem.
Nie obsługuje prepared current run, nie odtwarza authoring i nie uruchamia Solve.
Stary saved-authoring v1 pozostaje osobną ścieżką ze swoim prawdziwym checkpointem.

## Kontrakt i mapowanie źródeł

Nowy moduł scripts/docker_volume_terminal_prestart_recovery.py definiuje
zamknięty schemat fullmag.docker-terminal-prestart-reconciliation.v1.
Request zachowuje wspólne piny source/config/controller/trzech kontenerów
z docker_volume_reconcile.validate_request. Dodaje prestart_helper_sha256,
failure, prior_publication, history_baseline i observation.

failure wiąże raw SHA drain, preflight i pierwotnego development terminal receipt,
kanoniczne SHA stanów backend/frontend oraz raw SHA dokładnego błędu NVIDIA.
prior_publication wiąże attempt i raw SHA immutable successful iteration terminal;
musi on być bajtowo równy iteration/verified.json i odnosić się do dokładnego
base/config/source/image/kontenerów/StartedAt oraz sealed package receipt.
Nie przyjmuje dowolnej starszej udanej próby resume.

history_baseline ma kontrolną ścieżkę JSON, raw SHA i ID zapisanego runu.
Rzeczywisty operator baseline jest w
verification/master-runtime-62f222-20261027/state-before.json:
43 katalogi, 1391 plików zapisanego runu i 2 pliki odzyskanej solution.
To dowód operatorski tych konkretnych plików, nie natywne poświadczenie
wszystkich historycznych journals. Publiczne run.revision jest wersją stanu API,
nie rewizją run_catalog. Świeży recovery_store_sha256 ustanawia osobny baseline.

## Bramki wykonania

validate_failure wymaga unchanged StartedAt/fingerprint z kontrolera,
backend exited/Pid0/exit128 z dokładnym hookiem NVIDIA, frontend exit0,
braku nowego backend_started_at, publikacji builda/provenance operacji
i checkpointu authoring. Istniejący _read_terminal_process_receipt uwierzytelnia
drain wobec persisted ownera. service_owner i terminal_service_owner muszą
wskazywać tego samego ownera i dzieci.

build_observation używa krótkiej usługi diagnostycznej we własnej grupie Compose.
Aktualny sealed package, control/runtime-control i wybrany source są readonly.
Nie ma candidate overlay, publikacji provenance, /build, /user-data, GPU,
sieci ani socketu Dockera. State i ledger mają zapis dla istniejących natywnych writer guards;
nowy namespace probe używa ponadto własnego tymczasowego katalogu testów
filesystemu w state i usuwa go po sprawdzeniu. Oryginalne admission nie są zmieniane. Zachowuje się dokładne
mounty i podkatalogi wolumenów. Ponieważ probe pomija normalny entrypoint,
wywołuje wyłącznie image-owned _configure_device_access w trybie CPU,
zachowując istniejącą trasę biblioteki /usr/local/cuda/compat bez hardware
preflight, stubów lub host driver bind. Obecność tej trasy nie dowodzi,
że prawdziwy native proof już zadziałał. Reuse _released_snapshot jawnie odmawia,
gdy state/ledger mają nieobsługiwany volume-subpath.

Istniejące runtime service-inspect-terminal-run jest jedynym źródłem natywnego
terminal digest, retry i preparation/resource evidence. Python nie dekoduje
wyników naukowych. Sprawdza raw hashes, rzeczywiste specification.parameters
run_intent, accepted_run_start_policy.v1/manual i brak start_release.json.
Zbiór held IDs musi dokładnie odpowiadać kolejce z przypiętego preflight.
_released_snapshot zachowuje shared-lock host-before-store i durable release proofs.

Sealed receipt/provenance muszą zgadzać się w schema/state, raw receipt SHA,
obrazie, commit/source/native snapshot, toolchain i pełnym binary inventory.
Przed i po inspector pliki naukowe są identyczne. Rootowy WRITER.owner.json
jest zmiennym advisory, ale wymaga pełnego rozpoznanego schematu, canonical
UUID, PID/host/timestamp i released=true. Inventory ma limit 32768 plików/1 GiB
i hashuje strumieniowo.

## Reconcile, retry i completion

Nowy reconcile jest wyłącznie failure-only: nie publikuje iteration/verified.json.
Preview sprawdza dowody bez przejęcia pierwotnej blokady. Apply ponawia je
pod istniejącym observer protocol. continuation zwraca jawny terminal_history;
nie tworzy zmyślonego authoring checkpointu. Pod resume lease ponownie
sprawdzane są stare package/config/provenance oraz cała observation.

Po zarządzanym starcie może legalnie powstać nowy pakiet aktualnych źródeł.
Istniejący _finish kwalifikuje receipt/source/image/storage/process/readiness.
Osobny terminal_completion_gate otrzymuje ponownie przypięte raw SHA jego
bieżącej publikacji, native config i StartedAt. Nowe runtime piny muszą
dokładnie odpowiadać tej kwalifikacji; obcy lub niekwalifikowany pakiet
jest odrzucany. Native terminal digest, history, held intents i released
resource snapshot muszą pozostać identyczne. Dopiero potem kończy się lease.
Udany restart nie oznacza automatycznego przywrócenia sceny do bieżącej sesji.

## Weryfikacja i granice dowodu

Dedykowane testy scripts/test_docker_terminal_prestart_recovery.py sprawdzają
schematy, mounty, rzeczywistą Python PROBE na małym store z atrapą native CLI,
manual admission, zmiany podczas odczytu, malformed writer/provenance,
publication/continuation CAS oraz kwalifikowaną nową generację.
Stare testy v1 uruchamia się osobno tą samą receptą offline.

Przed korektą adaptera nie uzyskano poprawnego prawdziwego native proof.
Wynik kolejnej rzeczywistej diagnostyki opisano poniżej. Nie wykonano jeszcze
reconcile, restartu ani Solve; preview i kwalifikacja wznowienia wymagają
osobnego wyniku zarządzanej recepty. Testy Rust nie są
kompilowane. Recepta just docker-dev-offline-check używa zatrzymanej własnej
grupy, sourceRO/controlRW, bez danych użytkownika i GPU.


## Korekta diagnostyki po pierwszej rzeczywistej odmowie

Pierwszy helper diagnostyczny zakończył się odmową
„host-bound solver lease has no exact released host row”. Nie uruchomiono
reconcile, restartu aplikacji ani Solve. Samo skopiowanie env nie wystarcza:
linux_native_store_identity wymaga prawdziwego probe aktualnego namespace.
Po tej odmowie osobny odczyt root potwierdził niezmienność 43 katalogów,
1391 plików runu i 2 plików solution; raport:
verification/terminal-prestart-recovery-20261027/post-first-native-science-preservation.json.

Nowy adapter kopiuje wyłącznie sześć dokładnych wartości retained Config.Env:
FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1, FULLMAG_DOCKER_HOST_ID,
FULLMAG_RUNTIME_IMAGE_ID zgodny z obrazem, FULLMAG_TOOLCHAIN_IMAGE_ID,
FULLMAG_BACKEND_CARGO_PROFILE=backend-dev i FULLMAG_COMPOSE_PROJECT zgodny z grupą.
Brak, duplikat lub obca wartość oznaczają odmowę; brak fallbacku do domysłów.

Każdy proof ma nowy katalog control/probes/UUID, plik evidence początkowo UID65532/mode600 (publisher probe ustawia później 0644),
RW mount /evidence i RO file-subpath overlay /state/.linux-native-probe.json
tego samego inode. Zachowuje volume.nocopy=true i dokładne istniejące subpath.
RO alias /retained-state pokazuje pierwotny probe, owner i oba sentinele;
oryginalny host certificate jest readonly. Prawdziwy linux_native_probe.run(True,
evidence_path=...) z przypiętego sourceRO tworzy evidence swojego namespace,
bez attest/reuse_certificate/complete_preflight, candidate ani publikacji provenance.
Oryginalne admission są porównane przed i po, włącznie z raw SHA i tożsamością
plików. Źródło probe jest ponownie porównane po native CLI.

namespace-observation.json w prywatnym control dir zapisuje pojedynczy dowód.
Mount namespace i raw private probe SHA nie są invariantem między helperami.
Observation porównuje tylko storage_binding_sha256 obejmujący stabilny profile,
retained env, owner/engine/root binding i przypięte źródło. Pierwotny probe może
legalnie obrócić się podczas późniejszego zarządzanego restartu; istniejący
_finish kwalifikuje nowe admission. Dowody historii/native terminal/held pozostają
dokładne i niezależne od tej rotacji.

Helper nie ma API: jawne healthcheck.disable=true wyłącza odziedziczony HEALTHCHECK.
CPU wynosi 1, poniżej budżetu własnego backendu 4; timeout obserwacji wynosi 600 s.
Pełne dwukrotne hashowanie pakietu i historii pozostaje zachowane.
Timeout klienta zapisuje outcome-unknown-resources-retained z nazwą dokładnego
helpera i nie oznacza naukowego Failed/Succeeded ani zakończenia procesu.
Przed kolejnym prawdziwym prepare wymagane są niezależny review i interpretowane
regresje; same testy adaptera nie kwalifikują rzeczywistego namespace/store ID.


## Precyzja natywnego czasu writer na Python 3.10

Drugi rzeczywisty helper przeszedł native CLI, ponowne hashowanie pakietu
i kontrolę niezmienności admission, a odmówił przy timestampie
2026-10-27T21:18:59.543852683+00:00. Python 3.10 fromisoformat nie obsługuje
tego natywnego formatu 9 cyfr. Nie jest to błąd obliczeń ani dowód aktywnego
writer; nie zmieniono statusu runu lub zasobów.

Embedded writer_timestamp_ns stosuje istniejący wzorzec repo
docker_volume_capture_failure_reconcile._timestamp_ns: całkowite sekundy
kalendarza i osobna frakcja 1..9 cyfr, dopełniana zerami do nanosekund.
Obsługuje Z i jawny offset ±HH:MM z walidacją daty/czasu oraz zakresu offsetu.
Nie akceptuje dat bez strefy, malformed wartości ani leap second.
Porównanie heartbeat >= acquired używa całkowitych nanosekund, bez float
i bez obcinania frakcji do mikrosekund. Regresja odwróconej kolejności o 1 ns
wewnątrz tej samej mikrosekundy musi odmówić. Pozostałe bramki writer,
native evidence, pakietu i historii pozostają bez zmian.


## Wynik poprawionej diagnostyki natywnej

Finalny moduł SHA256
`50d72091be223afde66447cf8fb6e916db90028ca9058984d545c870058329a6`
i test `15fddad60f111181bb2392f1e8ba12a15853b65d96543e5fcc2ae12a0c6055c8`
przeszły 32/32 regresje w zarządzanym helperze własnej grupy oraz niezależny
review bez Blocker/Required. Receipt `offline-writer-time-32-final.json`
SHA256 `a62e49f24a2edf9cf6f07dcc931da981a8c8082349caa77d2b5b19259e369f0e`.

Trzeci rzeczywisty prepare zakończył się succeeded po 45,108 s. Natywny CLI,
private namespace, zachowanie oryginalnego admission, sealed package, historii
i obu manual held intents przeszły pełną walidację. Raport:
`verification/terminal-prestart-recovery-20261027/native-prepare-third-status.json`.
Request `request-third.json` w tym samym katalogu ma SHA256
`34dd8aaf384a77e35edc3ab0e18102d4d080a0da7c3fe26da5da3441b9df9967`.
To diagnostyka przygotowania, nie jeszcze kanoniczny preview/apply ani
kwalifikacja wznowienia. Nie wykonano nowego Solve.
