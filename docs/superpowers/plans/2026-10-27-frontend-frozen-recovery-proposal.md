# Odzyskanie generacji frontendu po odrzuceniu zamrożonych wejść

## Stan i zakres

Kandydat przygotowano wyłącznie w wolumenie kontrolnym; nie został zastosowany.
Backend kompiluje commit c1d0abd675060a3dc5835708f9e85449cc54f40b.
Nie uruchomiono testów ani rekonsyliacji. Kwalifikacja runtime: NOT VERIFIED.

Frontend odrzucił różnicę między trwałym manifestem wolumenu z commita
540677ddb19452c5ffbdbb63db93c006da950c2f a bieżącym manifestem.
Zmieniono package.json, next.config.ts, next.config.test.ts i dev-server.mjs.
Nie należy nadpisywać frozen inputs, podszywać OOM ani tworzyć pustej sesji.

## Zamknięty kontrakt

Osobny schema fullmag.docker-resume-frontend-frozen-reconciliation.v1 dotyczy
wyłącznie unknown fazy resume z błędem gotowości zatrzymanego frontendu.
Wymaga dokładnego CAS oryginalnego request/receipt, kodu kontrolera i helpera,
trzech inkarnacji kontenerów, pierwotnego development/config oraz publikacji
bieżącego pakietu. Obserwacja wiąże jawny exit1 bez OOM, pełny bounded log,
frozen manifest i aktualny manifest. Backend pozostaje żywy i zdrowy.

Nowy wariant używa istniejących claim_script/commit_script z phase=resume
i publish_verified=False. Zachowuje owner/active/flock/journal/atomic rename
oraz release wyłącznie przez oryginalnego właściciela. Nie publikuje Succeeded.
Każdy błąd po BEGIN zachowuje unknown i dowody.

Przed zwolnieniem blokady ponownie wykonuje istniejący natywny terminal
completion: exact terminal evidence, held manual intents bez start_release,
shared-lock released snapshot, pełne hashe historii i obu plików rozwiązania.
Bieżący pakiet, provenance, source capture, konfiguracja i StartedAt muszą być
kwalifikowane. Transakcyjna zajętość writer/resource odmawia; nie pomijamy guardów.

## Generacja frontendu

Istniejący docker-dev-refresh-frontend przyjmuje opcjonalnie sparowane piny
frozen_resume/frozen_resume_sha256. Bez nich zachowanie nie zmienia się.
Jawny wariant ponownie wiąże failed-confirmed resume i jego proof, następnie
powtarza walidację pod własną dzierżawą przed seed/recreate.

Backend/config/StartedAt oraz API instance, procesy, identyfikatory sesji,
run i scene revision pozostają identyczne. Przy aktywnej sesji wymagany jest
terminalny run; przy pustej sesji jawny opt-in nie odpytuje nieistniejącego
session status. Powstaje nowy wolumen frontendu. Stary cache i frozen bytes
pozostają. Po zdrowym frontendzie powtarzane są native/history completion
oraz wszystkie dotychczasowe package/source/storage fences.

## Weryfikacja i ograniczenia

Przygotowano focused regresje shape/CAS, failure-only atomic targets,
non-OOM exit1, obcych stanów/logów, regular-file archive, terminal/empty
session i braku automatycznego dispatchu. Testów nie uruchomiono.
Przed zastosowaniem wymagany niezależny review, parser/source checks,
dozwolone interpretowane testy i rzeczywisty preview po zakończeniu buildu.

Nie zmieniono fizyki, danych obliczeń, natywnego writera, manual Compute,
oryginalnego v1, iteration success, ścieżki OOM ani plików aktywnego checkoutu.

## Poprawka po review R1: oddzielny sealed app i helper HEAD

Pierwszy patch ca7a pozostaje niezmienionym dowodem niezaakceptowanego review.
Nie można go stosować: zmieniony launcher checkout przestałby odpowiadać
source capture pakietu c1. Wariant v2 nie osłabia _source_matches i nie zmienia
provenance pakietu. Rozszerza istniejący docker_helper_source o osobny schema
fullmag.docker-same-root-helper-transition.v1.

Autentyczny raw bazowy /build/.fullmag-live-source/manifest.json musi mieć SHA
z sealed receipt.source.manifest_sha256, zgodny live digest i pełną tożsamość
app source. Odczyt korzysta z istniejącego backend_dev._validate_live_manifest.
Świeży capture pochodzi z istniejącego codegen._probe_source. Cała mapa plików,
tryby, blob IDs, index równy committed helper HEAD, clean status, tree oraz
deleted/included/excluded/sparse metadata muszą odpowiadać zamkniętemu proof.

Zewnętrzny reviewed manifest zawiera literalne base/candidate SHA i tryby
dokładnych zmienionych plików. Jego raw SHA jest jawnie przypięty requestem,
powtarzany pod dzierżawą i na końcu. Dozwolony zbiór obejmuje siedem plików
pierwszego patcha, docker_helper_source.py, test_docker_helper_source_transition.py,
rootowy test_docker_volume_reconcile.py i checkpoint oraz just_storage_shell.sh
i test_just_development_recovery_shell.py. Żadne crates, backends, native,
packages/fullmag-py ani apps/control-room nie mogą różnić się od sealed app.

Wszystkie sześć rzeczywistych Gitlinków external_solvers jest obecnie pustych,
nieinicjalizowanych, bez .git. To jawny operator baseline przed zastosowaniem,
a nie domniemany historyczny proof zawartości submodułów z capture. Wariant
wymaga identycznych Gitlink IDs base/helper i tej samej pustej fizycznej
postaci na każdym sprawdzeniu. Inicjalizacja lub dodanie pliku odmawia.

Clean committed helper HEAD H jest wiązany przez niezmieniony helper binding v1;
załadowane moduły muszą pochodzić z tego root. Receipt jawnie zapisuje
app_source=c1 i helper_source=H, bez twierdzenia że pakiet zbudowano z H.
Finalny zewnętrzny manifest musi zostać zamrożony po review/commit helpera,
uwzględniając rootowe CI fixture/checkpoint. Przed tym etapem nie ma runtime
autoryzacji do zastosowania.

## Poprawka po review R2: rzeczywisty shell dispatch

Nowe opcje refresh przechodzą przez istniejący just_storage_shell.sh wyłącznie
jako sparowane UUID/SHA. Powstaje strukturalna tablica argv; niczego nie
wykonuje eval. Regresja sprawdza stary refresh, jawny wariant, brak połowy pina,
nadmiarowe argumenty oraz próby łączenia komend i command substitution.
Testy pozostają przygotowane, NIEURUCHOMIONE; wymagany niezależny review.

Istniejący niezmieniony native proof 50d na zdrowym API przeszedł po stronie
operatora/root. Nie kwalifikuje to jeszcze nieuruchomionego patcha v2.

## Finalne bramki wejścia

Capture hashuje canonical JSON z końcowym LF, zgodnie z istniejącym
backend_source._live_canonical; binding helper v1 zachowuje własny serializer.
Nowa regresja korzysta bezpośrednio z produkcyjnego serializatora backend_source,
a fixture tree ma rzeczywisty format ls-tree -z.

Obcy examples/fem_antenna_closed_loop_nonmagnetic.20261022.fms pozostaje poza
indeksem. Jawny pre-apply operator baseline wiąże SHA
d1ce5e22d273213da0119492a95a24a46428b75a199a24dbd93dd0c216bf24de,
9291 B, mode100644 i exactstatus??. Nie ma go literalnie na liście excluded
sealed capture; nie przypisujemy mu historycznej atestacji zawartości.
Każda zmiana tych bajtów albo inny untracked plik odmawia. Capture excluded
nadal musi być identyczne. Niczego nie stage/delete/move/ignorewrite.

Zbiór closed paths zawiera też dokładnie .github/workflows/bootstrap.yml:
trzy polecenia testów (dwa nowe moduły oraz istniejący focused shelltest),
bez zmiany pozostałej polityki CI. Finalny zbiór obejmuje 14 ścieżek.

Hostowy pathlib bez keyword follow_symlinks wymaga równoważnego lstat().
Zmieniono wyłącznie ten odczyt metadanych w istniejącym v1 oraz nowym FMS guard;
sprawdzenia regular/no-link/mode/SHA pozostały. Nowy guard loaded module używa
relative_to/ValueError zamiast nowszego is_relative_to.
