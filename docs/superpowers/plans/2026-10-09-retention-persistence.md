# Plan naprawy 4206911501: trwałe duże plany retencji

Status: implementacja w toku; SOURCE i hosted runtime niekwalifikowane.

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
