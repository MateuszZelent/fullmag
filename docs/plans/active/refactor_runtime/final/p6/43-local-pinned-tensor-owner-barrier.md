# Przyrost 43 — lokalna bramka właściciela typed tensorów

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i kontrakt: `9a497126393f859a92e801b4bfd19f1a562812e1`, opublikowany na remote master.

## Wynik

Zamknięto źródłowy brak lokalnej publikacji wskazany w review przyrostu 42.
`SessionStore::publish_solution_set` wymaga zgodnego run intentu po uzyskaniu
writer lease, przed czytaniem tensorów CAS i zapisem rewizji. Katalog stosuje
tę samą regułę przed idempotentnym replayem, promocją orphan revision
i odkrywaniem durable objects. StoreWalker sprawdza ownera przed oznaczaniem
grafu CAS, więc brak właściciela blokuje GC także przez `open_existing`.

Wspólny reader ogranicza intent do 16 MiB, waliduje path/run ID,
`FmsRunIntent` oraz payload digest względem provenance SolutionSet.
Nie zmienia execution status ani scientific assessment i nie naprawia danych
przez wybór innego właściciela. Opaque schemas zachowują istniejącą zgodność.

## Dowody

| Bramka | Wynik |
|---|---|
| Produkcyjne źródła API/session/quantities | PASS, exit 0, `source_changed_during_run=false` |
| Niezależny bounded source review | PASS, bez blokera P0/P1 |
| Scoped staged diff, UTF-8 isolation, parser/format nowych fragmentów | PASS |
| Missing owner, wrong digest/envelope, replay i orphan promotion | Regresje źródłowe dodane; NOT COMPILED / NOT RUN |
| Missing owner blokuje GC/writer reopen, nie usuwa metadanych | Regresja źródłowa dodana; NOT COMPILED / NOT RUN |
| Runtime/import/recovery/RAM/science/release | NOT VERIFIED |

Receipt:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/2232cb59041d4189a93272ddd5695735/receipt.json`.
Finalny fingerprint pliku katalogu porównano z bieżącym źródłem.

Fixtures błędnych chunków otrzymały zgodnych właścicieli, aby nadal badały
payload barrier. FMS missing-owner fixture najpierw publikuje poprawne dane,
a dopiero potem usuwa plik ownera w katalogu testowym. Zakaz kompilacji
testów jednostkowych pozostaje respektowany.

## Granice i dalsza praca

Review wskazał P2 utrzymaniowy: FMS/ArchiveWalker nadal mają własną walidację
owner bytes, równoważną wspólnemu readerowi plikowemu. Nie kwalifikuje się
tego jako wykonanej bramki runtime. Historyczne niepełne typed dane mogą
być odczytywane jako metadane bez reconciliation; nowe publikacje i GC
odmawiają działania. Nie usuwa się historycznych rekordów jako naprawy.

Następny etap pozostaje pełnym P6-B/C/D: trwały dataset owner/materializer,
rzeczywiste semantyczne powiązanie quantity/units/space z zapisanym polem,
publication outputu signed-difference, API/client i istniejący consumer UI.
Sam `TensorDescriptor` nie zawiera tych semantyk i nie jest podstawą
do ich wymyślania. Równolegle pozostają blokady managed runnera opisane
w przyroście 42; nie zlecano nowych buildów ani nie obchodzono allow-list.

Kontrakt: [Przypięty tensor SolutionSet](../../../../../specs/pinned-solution-tensor-v1.md).
