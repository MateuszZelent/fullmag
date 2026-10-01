# P6-53 — ograniczony odczyt wartości zapisanych pól w Inspectorze

Data: 01.10.2026. Baza: `1b585fcca38d06fe105df072a9ca6392f30ed94b`.
Commit implementacji: `98cf7026cc29ead64f89fbca730334805a8d31fe`.
Commit korekt UI: `fe26b2aac20b5abf609a39b5d15e93165456e34b`.
Status: zaimplementowany przyrost; produkcyjne źródła i browser fixture
sprawdzane oddzielnie od runtime i kwalifikacji naukowej.
P6 pozostaje **IN PROGRESS, około 52%**, cały plan około **49%**.

## Zachowanie

Readonly Inspector przypiętego MaterializedDataset korzysta z centralnej
fasady i nowego resource hooka binarnego slice. Wartości są własnością
istniejącego ResourceRuntimeStore; nie trafiają do React state, Zustand ani
nowego cache. Lokalny stan zawiera wyłącznie offset strony i wybrany komponent.

Klucz zasobu zawiera projekt, run, SolutionSet, containing revision,
member/artifact, manifest root i długość, pinned source, dataset revision,
sample/item/field, descriptor, coverage oraz zakres i budżet. Dzięki temu
cache hit nie pomija sprawdzenia innego expected descriptor. Codec P6-52
ponownie kontroluje scope, zakres, shape, precision i checksum.

Strona zawiera maksymalnie 32 elementy i 64 KiB surowych wartości; dla dużej
liczby komponentów liczba elementów maleje do budżetu. FMDS metadata pozostaje
ograniczona oddzielnie do 1 MiB plus 12 B header. Jednocześnie renderowany
jest jeden jawnie wybrany komponent. Indeksy elementów i offsety zachowują
BigInt/u64. Tabela podaje quantity, zapisaną jednostkę oraz indeksy zgodne
z layoutem, bez przypisywania indeksowi współrzędnych przestrzennych.

Poprzednia/następna strona i Reload są odczytami. Nie uruchamiają solvera,
materializacji ani mutacji projektu. Nieudany checksum lub refresh daje
jawny błąd i ukrywa tabelę; unavailable nie staje się zerem. Resource hook
nie planuje automatycznych retry; istniejąca ograniczona polityka transportu
GET pozostaje bez zmian. Odejście ostatniego odbiorcy anuluje request, usuwa
wpis runtime i unieważnia późną odpowiedź. Zmiana przypiętej selekcji resetuje
lokalną nawigację poprzez remount; wybranie innego runu w navigatorze nadal
nie zmienia istniejącego pina.

## Dowody i granice

Pierwszy przebieg produkcyjnego TypeScript przeszedł:
`windows-control-room-source-check/production-source/3b07631b1bdd46c189d09bff76f2d3d8/receipt.json`.
Pierwszy przebieg browser fixture przeszedł:
`windows-control-room-browser-fixture/pinned-dataset-browser/b4c7ef3944af42ebae4a71592e4693d2/receipt.json`.
Oba paths są względne wobec `storage/builds/fullmag-0950f4dca4ffe38f`.
Przebieg przeglądarkowy potwierdził strony 32/32/6 dla 70 elementów,
wybór komponentu, odrzucenie uszkodzonego payloadu, jawne przeładowanie,
readonly Apply/Focus oraz istniejące bariery projektu i sesji. Odpowiedzi
pochodzą z page.route fixture, a nie rzeczywistego backendu HTTP.

Review źródeł nie wykazał P0/P1. Wskazał jawne ograniczenie dtype do F32/F64
oraz kontrolowane odrzucenie uszkodzonych liczników przed renderowaniem.
Oba zabezpieczenia dodano: parser przyjmuje wyłącznie dodatnie kanoniczne
u64 oraz F32/F64, a niespełnienie kontraktu daje unavailable przed
montowaniem readera. Finalne przebiegi po korektach zapisano poniżej.

Drugi browser receipt
`windows-control-room-browser-fixture/pinned-dataset-browser/3469f4eb4236478da9813a5254627678/receipt.json`
potwierdził dodatkowo abort opóźnionego slice po schowaniu Inspectora i
nowy odczyt strony 0 po otwarciu. Screenshot `browser/pinned-materialized-dataset-values.png`
został obejrzany: widoczna tabela, indeksy elementów i komponentu oraz
jednostka, bez canvas/podstawiania aktualnej geometrii. Ten przebieg
poprzedzał ekstrakcję kontrolowanego parsera liczników; finalny przebieg
po zmianie jest odrębnym dowodem.

Dodano źródła regresji dla liczników ponad 2^53, uszkodzonych/niekanonicznych
liczników, integer dtype, zmniejszenia strony przy wielu komponentach i
odmowy elementu większego niż budżet. **Nie kompilowano ani nie uruchamiano**
tych testów jednostkowych.

| Bramka | Dowód | Wynik |
|---|---|---|
| Produkcyjny TypeScript po parserze liczników | `windows-control-room-source-check/production-source/52316bc8d5e34a549e7356c6bd7ffa5e/receipt.json` | PASS; bez testów jednostkowych |
| API hygiene | `windows-control-room-source-check/api-hygiene/60044b06f9d74af7a1186946ae286725/receipt.json` | PASS |
| Browser po parserze, przed korektami React Doctor | `windows-control-room-browser-fixture/pinned-dataset-browser/9f07a06c5d634a4fa344538fe4691c4b/receipt.json` | PASS, exit 0, źródła niezmienione |
| Browser z poprawionym opisem dowodu | `windows-control-room-browser-fixture/pinned-dataset-browser/daa68f0747e84930ba9158ecb4a3a52b/receipt.json` | PASS; numeric table, checksum, abort i fresh reopen |
| Architecture hygiene / repo consistency | istniejące checkery | PASS |
| Scoped staged diff | sześć własnych plików; diff/check | PASS; zachowano 107 obcych dirty paths |

Rootowy hook React Doctor pierwszego commita zgłosił dwa nowe ostrzeżenia.
Mimo istniejącego integer/bounds guard, `Number("")` przy pustym komponencie
akceptowało zero. Zmieniono odczyt na `valueAsNumber` z finite/integer/bounds
guard. Klucz wiersza używa teraz absolutnego indeksu elementu, zamiast
pozycji na stronie. Nie dodano suppressions ani zmian konfiguracji skanera.
Końcowy produkcyjny TypeScript po korektach:
`windows-control-room-source-check/production-source/7cf7bc823acd453e83bc2e9e29d97795/receipt.json`
— PASS, exit 0, źródła niezmienione.
Końcowy browser po korektach:
`windows-control-room-browser-fixture/pinned-dataset-browser/e122bce4d0ae4cd58460e3aac024c759/receipt.json`
— PASS, exit 0, źródła niezmienione, owned_server_terminal=true. Raport
potwierdza wszystkie powyższe zachowania, failure=null, slice checksum/abort/
fresh reopen=true i poprawny opis numeric table przy niewykonanym rendererze
przestrzennym. Hook React Doctor commita korekt przeszedł bez ostrzeżeń.

Finalny review helpera, konsumenta i fixture nie wykazał P0/P1. Sugestia P2
blokowania Reload także dla `stale` nie została zastosowana w tej postaci:
`useResource.visibleResourceState` reprezentuje jako stale również zakończony
refresh error z zachowanym payloadem. Taka blokada uniemożliwiłaby jawną
naprawę odczytu, potwierdzoną przez fixture. Ponowienie podczas refresh może
anulować wcześniejszy request; sequence/AbortSignal nadal chronią dane.
Osobny jawny facet in-flight pozwoli później blokować tylko trwający refresh.

Wszystkie powyższe browser receipts potwierdzają zakończenie własnego
serwera i brak zmiany wejść w trakcie pracy. Raport zachowuje wcześniej
obserwowane ostrzeżenie montowania powłoki; nie przedstawia go jako
naprawionego przez ten przyrost. Nie zaobserwowano innych browser errors,
solver/model mutations ani niedozwolonych current-session requests.

**NOT VERIFIED:** rzeczywiste HTTP API dla slice, testy jednostkowe,
kwalifikacja RAM/performance, zapisany renderer przestrzenny i WebGL,
kompleksowe pola, funkcje/wspólne osie datasetu, DerivedDataset/PlotDefinition,
nauka, GPU i release. Zakaz kompilacji testów jednostkowych pozostaje w mocy.
Podgląd przestrzenny wymaga pinned topology/support/function-space i nie
korzysta z geometrii aktywnej sesji. Limit odpowiedzi nie gwarantuje limitu
odczytu ani hashowania całego dotkniętego chunku CAS.

## Następny krok

Przypięty odczyt topologii i supportu oraz integracja z jednym viewportem,
z dowodem widocznego canvas, contextLost=false i niezerowego drawing buffer.
Następnie rozszerzenie manifestu/readerów na pełne pola zespolone oraz
storage-neutralne dataset functions i wykresy. Niniejszy przyrost nie
zamyka P6 ani nie podnosi procentu kwalifikacji produkcyjnej.

Odczyt źródeł przed kolejnym etapem: `TensorFieldBinding` w
`crates/fullmag-session/src/solution_tensor_field.rs` celowo nie zawiera
referencji CAS; jego descriptor identyfikuje topologię i support, ale nie
publikuje przenośnego payloadu siatki. Kolejny przyrost musi znaleźć lub
opublikować typed immutable root dla wymaganej topologii, objąć go grafem
publication/recovery/GC/FMS i zweryfikować zgodność layoutu przed renderem.
Nie można wnioskować o takim korzeniu z samego stringa `topology_id`.
