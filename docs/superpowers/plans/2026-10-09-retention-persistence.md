# Plan naprawy 4206911501: trwałe duże plany retencji

Status: SOURCE PASS i hosted regresje Linux/Windows PASS. Realstorage oraz odrębne bramki API/UI pozostają niekwalifikowane.

## Przyczyna i zakres

RetentionService._save zapisuje pełny JSON bez limitu, ale własny reader
odrzuca >4 MiB. Execution, runtime i source-compaction executory samodzielnie
zapisują rosnące operation receipts. Automatic apply może rozpocząć mutację
z pamięci mimo nieczytelnego trwałego planu. Uwaga obejmuje wszystkich tych
producentów i recovery, nie sam limit preview.

## Kontrakt

Rozszerzenie ADR0052-runner-storage-retention określa mały manifest, komplet
niezmiennych części z hashami i atomową publikację po częściach. Zachowujemy
wszystkie fingerprints, candidates, retained i partial outcomes; niczego nie
ucinamy. Legacy inline <=4 MiB pozostaje zgodne; oversized legacy pozostaje
zachowane i odmówione. Nie uruchamiamy sprzątania rzeczywistych danych w ramach
implementacji ani nie wprowadzamy nowych publicznych endpointów.

## Kroki i własność

1. Prywatny retention_persistence.py: ten sam writer/reader, dokładny UTF-8
   budget, integralność/kolejność/identity manifestu i części, bounded total.
2. RetentionService preview/accepted/apply/recovery: durable validation przed
   executorem, mały trwały failure przy nieopublikowanym oversized/corrupt planie.
3. Wszystkie trzy executory: ten sam zapis/odczyt operation evidence oraz
   budget preflight przed pierwszą mutacją; czytelny partial failure bez retry.
4. Regresje persistence i istniejące suites: >4 MiB roundtrip/restart, granice,
   tamper/missing/reorder/link, przedmutacyjna odmowa i partial receipts.
5. Root: niezależne review, statyczne parser/diff, autoryzowany commit/push,
   dedykowane GitHub Actions i weryfikacja artefaktów; lokalne testy zakazane.

Worker owns retention helper/service/executors/tests; root owns ADR, plan,
CI hook i audyt. Zmiany solvera i obce dirty Runner Console są zachowane.

## Warunki odbioru

Nie wystarczy zwiększyć limitu readera ani przejść fixture z małym planem.
Duży plan musi odtworzyć cały zakres po restartcie, a dowolne naruszenie
integralności musi dać zero wywołań mutacji. Przed delete mamy zdolność
utrwalenia outcomes; failure po częściowej mutacji pozostaje odczytywalny.
Paginacja UI/API i realstorage qualification są oddzielnymi otwartymi bramkami;
nie przedstawiamy prywatnego persistence jako ich zamknięcia.


## Ukończony fragment źródłowy i bramki

Wspólny helper, RetentionService i trzy executory korzystają z jednego writer/reader.
Po review domknięto: katalog/budżet przed IO, pełny runtime recovery envelope,
no-clobber części, pinned/no-follow uchwyt (Windows OPEN_REPARSE_POINT), stabilne
primary code/type oraz nieblokujący POSIX open przeciw podmianie na FIFO.
Regresje obejmują rzeczywistą podmianę FIFO w procesie z watchdogiem, konflikty
publikacji bez zmiany starego manifestu i before-mutation capacity refusal.
AST i diff-check PASS. Wymagane wykonanie: istniejący runner-retention-contracts
w bootstrap scope=retention, matrix Linux/Windows. Nowy plik testów obejmuje
istniejący discovery test_local_runner_retention*.py. Nie uruchomiono lokalnych
testów ani operacji sprzątania; SOURCE PASS nie zamyka bramek API/UI i realstorage.

## Wynik hosted weryfikacji

Commit `3460021275da3059343903f09e69069abe221f83`, workflow [37973792165](https://github.com/MateuszZelent/fullmag/actions/runs/37973792165): SUCCESS. Jobs Linux `113966818249` i Windows `113966818226`: retention discovery po 77 testów, PASS z jednym platformowym skipem. Linux wykonał rzeczywistą podmianę FIFO; Windows potwierdził opener/reparse contracts. Oba wykonały capacity-before-mutation, konflikt części zachowujący manifest, duży plan, częściowy receipt i dual-error envelope. Dodatkowe runtime quarantine, runtime references i source compaction kroki PASS. To dowód warstwy persistence, nie pełnej ścieżki UI ani sprzątania produkcyjnego storage.
