# ADR 0058 — generacja treści artefaktów frequency domain

Status: accepted jako kontrakt korekty C03; implementacja w toku, runtime NOT VERIFIED. Data: 2026-10-13.

## Problem i decyzja

`artifact_set_id` wyprowadzony ze ścieżki identyfikuje miejsce, nie wspólną publikację widma i CSV. Dodajemy `frequency_domain/generation.v1.json`, schema `frequency_domain_artifact_generation.v1`. Koperta zawiera jawnego producer albo null oraz uporządkowaną mapę canonical relative paths → byte_length/SHA256. `generation_id` to SHA256 serde_json zwartej serializacji body, z kolejnością BTreeMap. Commit nie jest swoim członkiem. Ścieżki absolutne, traversal, symlinki i Windows reparse points są odrzucane.

Producent bierze listę z bieżącego wywołania write_artifacts, nie ze skanu katalogu. Uwzględnia metadata.json i faktycznie zapisane periodic_pairs/node_geometry. Writer uzyskuje wyłączny lease przed końcowymi zapisami; istniejący lease daje błąd, bez automatycznej kradzieży ani recovery. Marker zapisuje atomowo jako ostatni. Unikalny plik tymczasowy zapobiega kolizji zapisów tego samego procesu. FEM eigen otrzymuje execution run/stage identity przed wykonaniem; jawna pełna tożsamość jest zachowana. Nie wyprowadzamy ownera z folderu, aktywnego widza ani nazwy sesji.

## Odczyt, kompatybilność i granice

Czytelnik pobiera marker, weryfikuje canonical serialization i ID, sprawdza dokładne bajty zużytego członka oraz ponawia fence markera. Kontrolowane JSON/CSV mają limit bajtów sprawdzany przed alokacją. Osobny digest pojedynczego pliku i location artifact_set_id pozostają osobnymi pojęciami. Weryfikacja jednego pliku nie kwalifikuje wszystkich członków publikacji.

Bez markera historyczny solo read pozostaje dostępny jako legacy_unverified. Producer null to unbound, nigdy bieżący request owner. Joins potrzebują zgodnej generacji i prawdziwego owner/member binding. SHA256 nie uwierzytelnia producenta i nie stanowi dowodu fizyki.

Zachowujemy pliki w ich dotychczasowych lokalizacjach, bez podwajania wielkich pól. Po przerwaniu zapisu stary marker może istnieć, ale zmienione pod nim dane muszą dać stale/conflict; nie obiecujemy zachowania czytelności poprzedniego snapshotu. To celowy odpowiednik fail-closed, a nie immutable history. Recovery lease po awarii wymaga odrębnego sprawdzenia aktywnego właściciela; ten patch nie usuwa danych ani lease automatycznie.

## Bramki i rollback

GHA: zmiana CSV tej samej długości, podmiana markera, byte budget, traversal/symlink, obcy run/stage, concurrent lease i legacy/unbound. API/OpenAPI/UI wymagają kolejnego spójnego etapu. Managed publication, browser i science pozostają NOT VERIFIED aż do osobnego dowodu. Rollback usuwa producenta addytywnej koperty i świadomie przywraca legacy_unverified, nie uznaje location hash za verified join.


## Rozszerzenie G3 — niezmienne generacje v2

Decyzja: accepted jako cel korekty G3, implementacja etapowa; poniższy kontrakt
nie oznacza jeszcze przełączenia produkcyjnego writera ani kwalifikacji runtime.

Nowy marker `frequency_domain/generation.v2.json` o schema
`frequency_domain_artifact_generation.v2` wskazuje dokładne member bytes w
`frequency_domain/generations/<generation_id bez prefiksu sha256:>/`.
Logiczne ścieżki oraz body-content SHA pozostają jawne; marker nie jest memberem.
Writer zapisuje exact invocation membership do prywatnego stagingu obok
katalogu docelowego, synchronizuje pliki, publikuje katalog create-only przez
wspólny `fullmag_session::publish_directory`, a na końcu atomowo zastępuje
current marker. Nie ma wyboru generacji przez listing lub mtime, automatycznego
GC, ani nadpisywania poprzednich folderów. Tożsamość producer pochodzi z tej
samej granicy wykonania co v1; SHA nie uwierzytelnia ownera.

Obecny v2 ma pierwszeństwo nad v1. Uszkodzony v2, brak członka, traversal,
symlink/reparse point lub różnica hash/length kończą odczyt błędem; nie ma
fallbacku do v1 lub root legacy. Capture rozwiązuje wyłącznie zadeklarowane
logical members pod własnym immutable prefixem i ponawia current fence.
Poprzedni folder pozostaje przechowany, lecz capture API dla current może po
nowej publikacji zwrócić stale; dostęp do historii wymaga osobnej jawnej trasy.

Kompatybilność: v1 zachowuje istniejące member-byte verification i statusy
czytnika, ale jawne `is_immutable()` jest false. Nie awansujemy v1 do immutable
history i nie migrujemy istniejących danych. Brak jakiegokolwiek markera to nadal
legacy_unverified. Pierwszy etap dodaje v2 publisher/capture; wspólny finalny
writer pozostaje v1 do ukończenia odczytów API i regression checks. Bezpośrednie
standalone writers bez commitu pozostają legacy-only. CAS accepted-study outputs
mają odrębnego ownera i nie dostają drugiego konkurencyjnego publishera.

Wynik rename po błędzie bariery może być niepewny; zachowujemy typowaną przyczynę,
folder oraz dotychczasowy selector i wymagamy jawnego reconciliation. Awaria po
rename przed markerem pozostawia orphan, którego reader nie wybiera. Windows
nie ma tu dowodu directory sync; power-loss durability pozostaje NOT VERIFIED.

Obowiązki integracyjne: `artifact_generation.rs`, wspólny `artifacts.rs`,
reader owner/root resolver `analysis/results.rs`, `analysis/frequency_domain.rs`
i `data/fields.rs`, a także testy Linux/Windows dla no-replace, crash points,
v1/v2 priority, malformed-v2/no-fallback oraz A/B joins. Obecne DTO nie zmieniają
się w etapie addytywnym; przed przełączeniem routingu konieczny jest dowód, że
logical path nie otwiera root legacy membera zamiast captured immutable membera.
Runtime, browser i scientific qualification pozostają osobnymi bramkami.


### Etap G3 — wspólny czytnik Python

`scripts/frequency_domain_generation.py` dodaje stdlib capture/read/verify dla
v1/v2 z tym samym body SHA i canonical marker. Nie wyprowadza ownera ani nie
skanuje members. `read_member` oddaje dokładne hash-verified bytes; verify jest
streaming, a bounded JSON odrzuca duplicate keys. Błędny obecny v2 nie daje
fallbacku. Poprzedni capture jest fenced po zmianie current selector.
Golden UTF-8 jest niezależnie sprawdzany przez rzeczywisty serializer Rust i
czytnik Python w hosted CI. Testy Linux/Windows nie dowodzą ochrony przed
złośliwą równoległą podmianą całego drzewa ani power-loss durability.
Sam moduł nie przełącza producenta ani istniejących konsumentów: ich migracja
oraz jeden wspólny publication lease pozostają obowiązkowym kolejnym etapem.

### Etap G3 — wspólny read-only core Rust i terminal attestation

Kanoniczny parser koperty, typy i bounded member reader należą do
`fullmag-session::frequency_domain_artifact_generation`, ponieważ tego samego
formatu potrzebują producent runnera i terminalny inspector. Runner zachowuje
publisher, staging i lease oraz re-eksportuje dotychczasowe API odczytu. Nie
wprowadzamy zależności inspectora od silnika/runnera ani drugiego parsera.
Inspector otrzymuje bezpośrednią zależność od session; nie powstaje cykl.

Terminalne attestation zachowuje dotychczasową schema i logiczną referencję
`artifacts/metadata.json`. Przy markerze odczytuje `metadata.json` z capture
względem artifacts root, wylicza hash z tych samych zwróconych bajtów i sprawdza
producer run_id względem terminalnego manifestu. V2 wymaga pełnego producenta;
obecny błędny marker/member/owner nie dopuszcza fallbacku do rootowego aliasu.
Końcowy fence obowiązuje przed terminalną publikacją oraz w ścieżce retry.
Brak markera zachowuje dotychczasowy bounded legacy read i nie nadaje mu
statusu immutable. Nie backfillujemy attestation istniejących terminalnych runów.

Read-only core i terminalne attestation zostały zweryfikowane w GitHub Actions
38458450446 na commicie 1c5a22454464fcf7b0e280272ac6ca2bd24a71f5:
shared reader 4 testy na każdym systemie, inspector 49 na Ubuntu / 48 na Windows
oraz Python reader 19 na każdym systemie. Obejmuje to kontrakty v1/v2, zgodność
bajtów, owner mismatch, brak/uszkodzenie członka i zmianę selektora.
Projekcja pól analysis/results dopisuje expected_artifact_generation_id z
captured generation, bez mutacji hash-verified payloadu i polityki null-owner.
API38465944333 na f47299d562da7468cadfa4b848e80af76c762bd5 potwierdza publiczny
catalog->items->binary odczyt exact values/header oraz stale-link409. UI38462801139
potwierdza typed query i odmowę niezgodnego response generation.

Bieżący source checkpoint przełącza FemEigen z eigen auxiliary outputs na v2;
producer tests i pełna runner suite muszą potwierdzić tę zmianę w GitHub Actions.
Metadata, material files i mode/manifest closure trafiają do generation; legacy
root aliases pozostają nienaruszone. Owned payloads są przenoszone do publishera
bez dodatkowego pełnego clone. Legacy pozostałych realizacji pozostaje v1 i
odrzuca próbę zasłonięcia istniejącego v2. Source activation nie jest dowodem
wykonania konkretnego managed joba. Runtime, browser i nauka NOT VERIFIED.
