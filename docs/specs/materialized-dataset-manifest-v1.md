# Trwały manifest datasetu zapisanego pola — v1

Status: kontrakt wdrażany w P6; bramki runtime, FMS round-trip i RAM pozostają
osobne. Decyzja: [ADR 0029](../adr/0029-analysis-result-dataset-and-slice-selection.md).

## Właściciel i niezmienność

`fullmag.materialized_dataset.v1` jest strict, bounded manifestem CAS,
przenoszonym jako rozpoznany artefakt `Other` w istniejącym SolutionSet.
`Other` nie oznacza tutaj opaque leaf. Nie tworzy się drugiego Results store,
oddzielnego katalogu ani CURRENT datasetów. Wyszukiwanie datasetów ma być
projekcją istniejącego katalogu wyników.

Manifest zawiera `DatasetDefinition`, `MaterializedDataset` oraz jedno
`MaterializedDatasetFieldSource`. Definicja jest osadzona w tych samych
immutable bytes. Dokładny root CAS jest hashem całego dokumentu; manifest
nie zawiera własnego hasha ani hasha całego SolutionSet.

Źródło wskazuje run, RunSpec, SolutionSet i dodatnią przypiętą rewizję,
member, artifact oraz hash rootu tensora. Rewizja datasetu pozostaje
oddzielna od rewizji SolutionSet. Obie są dodatnie. Dataset ID jest identity
z bindingu tensora i nie staje się surową nazwą pliku.

Artifact ID ma kanoniczną postać `materialized-dataset-{object_ref}`.
Para dataset ID / rewizja jest unikalna w całym SolutionSet, także między
memberami. Publication, recovery i oba grafy FMS sprawdzają tę samą regułę;
import odrzuca konflikt przed zapisem. Stan deduplikacji dotyczy wyłącznie
aktualnego bounded dokumentu SolutionSet, nie całej historii.

Pierwsza publikacja waliduje exact owner względem publikowanej rewizji
w pamięci, a nie CURRENT. Późniejsze rewizje zachowują manifest bez zmian
i rozwiązuje się jego dokładną historyczną rewizję. W v1 owner należy do
tego samego runu i SolutionSet, a tensor pozostaje niezmiennym artefaktem
tego samego membera. Odwołanie manifestu do samego siebie jako tensora
jest nielegalne, ponieważ źródło wymaga schema `fullmag.tensor.v1`.

## Definicja i payload

Pierwsza realizacja obejmuje jeden sample, jeden item i jedno rzeczywiste
pole Values. Nie wykonuje solve, normalizacji, projekcji ani transformacji.
Definicja używa selection identity aktywnego supportu opisu pola,
`ExactOnly`, `Fail` i precyzji zgodnej z rzeczywistym F32/F64 payloadem.
Pole jest little endian, a root tensora pozostaje właścicielem chunk refs.

Field source zapisuje exact tensor artifact, plane, producer/group,
accepted state i coverage: liczbę elementów, komponentów, dtype/endian,
liczbę bajtów i chunków. Descriptor datasetu, binding rootu tensora i
coverage muszą się dokładnie zgadzać. Resource key oznacza niezmienny
artifact ID tensora, nie endpoint ani lokalną ścieżkę pliku.

Limit manifestu z definicją wynosi 4 MiB. Typed tensor root ma swój istniejący
limit 4 MiB oraz 16384 chunków. Nie kopiuje się payloadów do manifestu.
Sprawdzenie rootu obejmuje dokładny hash i długość; publication weryfikuje
każdy chunk oraz pełne ciągłe pokrycie tensoru.
Traversal nie zachowuje parsed descriptorów wszystkich rootów i rewizji
w nieograniczonym cache; waliduje je kolejno.

`Ready` oznacza dostępne zweryfikowane dane. Dataset może być Ready przy
przypiętym właścicielu Running/Unassessed; nie zmienia to statusu wykonania
ani oceny naukowej. Consumer musi odróżniać przypięty status źródła od
późniejszego stanu runu. Sam reader integralności CAS nie zastępuje
weryfikacji dokładnego właściciela i nie jest kwalifikacją fizyki.

## Publikacja, odtwarzanie i transport

Writer tworzy manifest przed pierwszą publikacją SolutionSet. Ta sama
bramka writer lease publikuje owner, manifest i rooty tensorów. Pins pozostają
do trwałej publikacji i są zwalniane dopiero po weryfikacji całego grafu.
Retry musi zachować te same immutable bytes; konflikt kończy się błędem.
Awaria po immutable revision, ale przed pointerem current, jest obsługiwana
przez istniejącą rekoncyliację po pełnej walidacji typed grafu.

Publication, catalogue replay/recovery, durable-object discovery i GC
rozpoznają manifest. Export/import FMS walidują źródło względem dokładnej
rewizji archiwum i dołączają RunIntent oraz cały graf root → chunks.
Brakujący owner, root, chunk lub konflikt metadata blokuje operację.
W archiwum nie rozwiązuje się ownera przez lokalny CURRENT.

Istniejące wyniki bez nowego manifestu zachowują swoje immutable artefakty.
Replay nie dopisuje datasetów do wcześniejszych memberów lub rewizji,
także do otwartej rewizji sprzed cutover. Migracja tych wyników wymaga
oddzielnej jawnej operacji copy-on-write, nie heurystycznej naprawy.
Rollback wyłącza producenta, zachowując reader i typed traversal.

## Dalsze bramki

Publiczny endpoint datasetu, generated client, resource hooks i consumer UI
nie są częścią samego kontraktu magazynu. Dalszy zakres P6 obejmuje także
wiele próbek, axes/branches, real/imag, signed difference, pozostałe quantities,
snapshot/Zarr, streaming wejścia oraz pomiar peak RAM. Pełne wykonanie
producent → publikacja → przypięty odczyt i FMS round-trip wymaga własnych
dowodów; source check nie zamyka żadnej z tych bramek.
