# P6-A — trwałe referencje manifestu modalnego i field-sweep

Data: 30.09.2026

Status: **SOURCE IMPLEMENTED / REVIEW PASS / MANAGED BUILD PASS / TESTS NOT RUN / RUNTIME NOT VERIFIED**.

## Zmiana i konsumenci

Writer `write_frequency_domain_eigen_manifest`, który wymaga dokładnej
tożsamości, zapisuje teraz pusty indeks transportu: opcjonalne klucze są null,
listy są puste. Zachowuje właściciela i względne ścieżki wszystkich artefaktów.
Usunięto wyłącznie nieużywany helper generujący mutable mode-field routes.

Własny typed artifact `eigen/field_sweep.v1` zachowuje `mode_field_id`,
`mode_artifact_path`, source revision i status pola, lecz nie zapisuje HTTP
`mode_field_resource_key`. Dostępność payloadu nie zależy od mutable URL.

Walidacja odczytu field-sweep w API dopuszcza ten wariant. Nadal odrzuca
pusty ID, pusty transport key, key bez ID oraz niespójny artifact path/status.
Stare artefakty z kompletną parą ID/key pozostają czytelne. Spectrum v3
zachowuje dotychczasowy kontrakt; jego writer nie jest częścią tego przyrostu.

Publiczne DTO/OpenAPI już deklarują transport key jako opcjonalny/nullable;
nie zmieniono pól ani typu, nie regenerowano klienta. Navigator wymaga ID i
transport key. Dlatego model widoku Navigatora wylicza brakujący key przez
istniejący helper API `fieldVectorResourceKey`, wymagając ID i ścieżki artefaktu.
Pozostają jego duplicate/source-revision/status guards. Nie mutuje typed payloadu,
zapisanych bajtów ani digestu źródła. Odpowiedź typed API również zachowuje payload
bez wzbogacania: hash field-sweep obejmuje pełny JSON po wyzerowaniu hash fields.
Results Index wylicza brakujący transport key w odrębnej projekcji item.field_ref,
wymagając niepustego ID, ścieżki artefaktu, ready i tożsamości siatki. Koduje ID
jako pojedynczy segment i używa kanonicznej trasy samples/vector z view/phase.
Dataset Browser otrzymuje dzięki temu pole również przez katalog wyników.
Przyszły historyczny reader wymaga osobnej projekcji transportu opartej na
przypiętym właścicielu. Nie wykonano browser/runtime smoke
i nie zaliczono
obsługi historycznych runów: projekcja transportu oraz pinned API pozostają
oddzielnym zakresem P6.

## Dowody i dalszy zakres

- Parser siedmiu plików Rust bez zapisu i scoped diff check: PASS.
- Lokalny parser TypeScript jest niedostępny w checkoutcie (brak zależności
  typescript w node_modules). Nie instalowano zależności ani nie uruchamiano
  hostowego builda. Typecheck i browser proof pozostają NOT VERIFIED.
- Regresja writera sprawdza brak mutable routes w manifeście i field-sweep,
  zachowanie ID oraz względnej ścieżki payloadu.
- Regresja API sprawdza wariant durable, stary wariant transportowy,
  spectrum-only oraz odrzucenie orphan/empty key. Regresja Navigatora sprawdza
  derived transport bez zmiany oryginalnego JSON payloadu.
- Review wykrył i poprawiono trzy niespójności: Results Index wymagający starego
  transport key, odwrócony test API ID-only oraz test orchestratora indeksujący
  usuniętą listę routes. Dodatkowa regresja Results Index sprawdza slash/Unicode
  i białe znaki w ID oraz zachowanie niezmienionego source payloadu. Ponowne review: brak blockerów P1/P2. Dodatkowo zachowano białe znaki
  exact ID podczas kodowania URL w Results Index; niepusty ID jest sprawdzany
  przez trim, lecz przekazany dalej w oryginalnej postaci.
- Walidator pakietów FEM dopuszcza brak transport key w manifeście i typed
  field-sweep, nadal kontrolując obecny legacy key, trwałe ID, ścieżki,
  zgodność metadanych i self-digest. Dodano pozytywną regresję durable oraz
  odrzucenie błędnego legacy key; AST obu plików Python: PASS.
- Testy są authored, **NOT RUN**. Rust/C++ nie kompilowano zgodnie z AGENTS.md.
  Późniejszą próbę lekkiego pytest przez managed wrapper odrzucono przed
  uruchomieniem: kolejka runnera jest obowiązkowa dla tego profilu; nie obchodzono
  guardu. Bliższy checkpoint tej próby znajduje się w przyroście 29.
- Nowa zmiana nie jest objęta wcześniejszym snapshotem natywnego FMR
  `7953ba4088a142c889c5ed9c12be7332`; wymaga osobnego managed buildu.
- Ostatni odczyt koordynatora: worker_alive=true, worker_state=stopping,
  stop_requested=true, accepting_jobs=false, worker_error=null. Aktywny jest
  job `1b7399298fe9453eba0c432eef1a2f62`; snapshot FMR pozostaje queued.
  Nie zmieniano pauzy operatora, nie zlecano nowego snapshotu podczas pauzy
  i nie przerywano aktywnej pracy. Przyrost 28 jest zapisany lokalnie jako WIP.

Writers path/mode/branch nadal publikują transport legacy. Ich migracja musi
objąć wszystkie metadane, CSV, schema validators oraz konsumentów; usunięcie
indeksu manifestu nie zamyka tej pracy. Nie nazywać całego modal bundle wolnym
od mutable routes. P6 pozostaje **52%**.

## Aktualizacja dowodów — 30.09.2026

Wpisy o pauzie i queued powyżej są historyczne. Runner wznowiono przez
operatora; build FMR zakończył się succeeded. Zmiany produkcyjne przyrostów
28–29 objęto wspólnym snapshotem `ffb5dd9294b24b6ab869266b99d95b49`,
profil `fem-cpu-release`, digest
`2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604`.
Bieżący odczyt potwierdził **running**, worker_alive=true, worker_error=null.
Końcowy wynik i receipt nadal są wymagane. W adapterze Navigatora
poprawiono nazwę query na `phase_rad`; ta poprawka jest objęta snapshotem.
Przyrost 29 obejmuje także wcześniej otwarte writers spectrum/mode/branches/CSV.
Nie zmienia to statusu historycznego pinned API ani dowodów browser/runtime.

## Terminalny wynik buildu — 30.09.2026

Job `ffb5dd9294b24b6ab869266b99d95b49`: **succeeded, exit 0**.
Receipt `fullmag.local-runner.build-receipt.v1` potwierdza profil
`fem-cpu-release`, digest
`2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604`
i trzy etapy exit 0: native-build, frontend-dependencies, frontend-build.
Inwentarz: 112 artefaktów z prawidłowym formatem SHA256 i nieujemnymi
rozmiarami; workspace/index.html jest niepusty. Osiem plików produkcyjnych
Rust/TypeScript zachowuje zgodność bajtową z kapsułą. Nie pobierano ponownie
i nie hashowano niezależnie wszystkich plików wyjściowych.

**Managed build: PASS.** Qualification w receipt pozostaje NOT VERIFIED.
Późniejsze poprawki walidatora Python mają AST/review PASS, lecz nie są
objęte tym receipt; zostały ujęte w kolejnym snapshotcie COW. Testy NOT RUN,
browser, rzeczywisty modal runtime i scientific qualification NOT VERIFIED.
