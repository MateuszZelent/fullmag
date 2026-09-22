# Eigensolve dyspersji — checkpoint implementacji

## Odbiór wygenerowanego API i diagnostyki UI — 2026-09-22

Pakiet transportu residuali zapisano i wysłano jako
602dd629394fcefbc7351d563d91bfb2920af417. Diagnostykę timeoutu Inspectora
(requestCounts, przekroczenie budżetu, ostatnie 20 odpowiedzi sceny)
zapisano i wysłano jako 3ba4125787cacbb4c27ff648b5b06b6ee1b5b1ce.
Nie zwiększano limitów fixture'a. node --check i diff przeszły.
Lokalny React Doctor --scope changed --base 602dd629394fcefbc7351d563d91bfb2920af417
zakończył się bez zgłoszeń; browser smoke pozostaje otwarty.

Job CI 106639461082 w runie 35694883187, dla dokładnie commita 3ba412578,
wykonał generator API i ujawnił wyłącznie oczekiwany diff nullable/optional
residual_relative_l2 w widmie v3. Zaimportowano dokładny diff z logu
generatora, po git apply --check; nie przepisywano schematu ręcznie.
Zweryfikowano zgodność wygenerowanych blobów Git z nagłówkami diffu CI:
openapi-v2-types.ts = 2d1e3b8828adcd4d79d0afe73b71a5df972f614f,
openapi-v2.json = 0f6dae86508ee201ba2e3affc93da70ba253a6b2.
Parser JSON potwierdził opcjonalność oraz number|null. Generator klienta
nie wygenerował różnic. Kolejny gate deterministyczności pozostaje do odbioru.

Managed build 6b2de4a74bf64669ae0e92610b1bb078 nadal running; nie ma jeszcze
nowego punktu DE. Kontrola źródeł potwierdziła, że sparse parser rozdziela
fizyczne q/phi od legacy pełnego certyfikatu, więc sam reduced-only status
nie blokuje eksportu. Pełna mapa redukcji potrzebna do niezależnej kontroli
pola nadal wymaga sprawdzenia w artefaktach; hash mapy nie zastępuje jej treści.

## Residuale — zakończony pakiet źródłowy transportu, 2026-09-22

SingleKModeResult otrzymał osobne Option<f64> dla residualu względnego.
Parser natywnej ścieżki przenosi tę wartość bez aliasowania residual_norm.
Manifesty, mode bundle, widma v2/v3, field sweep i podsumowanie Kittela
korzystają z właściwej wielkości. Kittel raportuje null, jeśli choć jeden
wybrany punkt nie ma tej diagnostyki; CSV pozostawia wtedy puste pole.
Fingerprint wyników uwzględnia teraz także residual względny.

Przegląd objął producenta natywnego, parser, konsumentów oraz wszystkie
konstruktory SingleKModeResult. Dodane regresje obejmują różne wartości
residualu absolutnego/względnego i brak wartości. Kontrole formatowania
zmienionych plików runnera oraz diff przeszły. Regresje Rust są przygotowane,
lecz NIEURUCHOMIONE ze względu na zakaz kompilowania testów. Nie jest to
odbiór runtime ani zakończenie S07: generacja OpenAPI/klienta, kompilacja
aktualnego źródła i dowody numeryczne nadal pozostają otwarte.

Odczyt procesów aktywnego kontenera joba 6b2de4a74bf64669ae0e92610b1bb078
potwierdził cargo i rustc, a log wskazał kompilację fullmag-runner. Job
nadal running. Nie zastępowano go nowym buildem ani nie zmieniano kapsuły.

## Residuale — kontrakt API v3, 2026-09-22

W bieżącym worktree payload widma v3 przechowuje residual względny jako
Option<f64>. Walidator dopuszcza brak dowodu, odrzuca natomiast ujemne
oraz nieskończone/NaN wartości obecne. Indeks wyników zachowuje None;
brak residualu nie staje się zerem. Dodano dwie regresje Rust obejmujące
brak pola, null, zachowanie liczby i odrzucanie niepoprawnych wartości.
Nie kompilowano ani nie uruchamiano testów Rust z powodu obowiązującego
zakazu. rustfmt --check dla frequency_domain.rs i git diff --check przeszły.
Kontrola formatowania results.rs wykazała rozległe istniejące różnice;
nie wykonano niezwiązanego formatowania całego pliku.

Zmiana pozostaje WIP razem z transportem residualu z natywnego solvera.
Regeneracja OpenAPI i typów klienta oraz weryfikacja kompilacji są nadal
otwarte; nie edytowano plików generowanych ręcznie. Job
6b2de4a74bf64669ae0e92610b1bb078 przy ostatnim odczycie nadal miał stan
running i exit_code=null. Nie obejmuje niniejszych zmian API/Rust.
Nie przybył zaakceptowany punkt nonzero-k ani dowód kwalifikacji fizycznej.

## Korekta semantyki residualu — 2026-09-22

Śledzenie producenta wykazało, że `eigen_native_artifacts.rs` zapisuje
`residual_norm` jako residual bezwzględny, osobno od `residual_relative_l2`.
Dlatego kontrola CSV DE-SMOKE nie może stosować do residual_norm progu
względnego 1e-8. Usunięto ten błędny warunek; wymagana jest nadal wartość
skończona i nieujemna. Raport nazywa maksimum jawnie
`max_absolute_residual_norm`. Odbiór względnego residualu oryginalnego
pencila pozostaje wymagany osobno. 29 testów i cztery podtesty przeszły.

Wykryto także wcześniejszy błąd eksportu ścieżki k: `eigen_path.rs` nie
przekazuje osobnego residual_relative_l2 do SingleKModeResult, a
`modal_manifest::summarize_mode` i producent mode_bundle przypisują do
pola względnego wartość bezwzględną. Naprawa Rust jest w toku; obecny build
nie będzie jej zawierał. Wyników tych pól nie wolno uznać za kwalifikację
bez kontroli oryginalnych natywnych diagnostyk. Ten wpis koryguje wcześniejszą
deklarację progu na kolumnę CSV, nie zmienia naukowego progu T3/T5.

## DE-SMOKE — wersjonowany model jako wejście runtime, 2026-09-22

Klient pilota przyjmuje opcjonalne `--model-ref <pełny SHA>` wyłącznie dla
samodzielnego DE-SMOKE. Model odczytuje przez Git z tego commita, zapisuje
osobno w nowym runie, montuje tylko do odczytu i sprawdza hash przed oraz po
wykonaniu. Zmiana wejścia daje failed także po exit 0. Domyślnie nadal
obowiązuje model zawarty w kapsule. Nie zmodyfikowano kapsuł ani ich manifestów.

To rozdzielenie wejścia problemu od skompilowanego runtime: cały istniejący
odbiór joba, binarium, obrazu, source digest i biblioteki Python pozostaje
obowiązkowy. PYTHONPATH nadal wskazuje pakiet z kapsuły, nie bieżący checkout.
Receipt zachowuje osobne `source`/`runtime` oraz `model_source` (commit,
ścieżka, SHA-256). Nie wolno przedstawiać tego jako buildu nowego commita
modelu. Stary pilot 100 nm importujący konfigurację repo nie dopuszcza tego
wariantu. Zmiana nie dodaje nowej realizacji fizyki ani kontraktu DSL/IR.

Recepta: `just run-de-smoke <job-id> two <pełny-SHA-modelu>`; `five` wybiera
pięć próbek. Aktualny runtime-only build może po sukcesie obsłużyć nowy
samodzielny model, bez powtórnego builda tylko dla skryptu. Samo zestawienie
wejścia i runtime nie dowodzi poprawności wyników — obowiązują T4–T7.

Dziewiętnaście testów Pythona i cztery podtesty klienta/wejścia przeszły.
Sprawdzono przypięcie do commita, odrzucenie ruchomych refów, niezmienność
mountów runtime/DSL, zakaz nadpisania wejścia i wykrycie mutacji po solve.

Dry-run z rzeczywistym wcześniejszym ukończonym jobem
`0c899a2c5dde45cdbc8e9605f2c57aa1` przeszedł weryfikację receiptu i hashy.
Model pobrano z `b8cf20b76711887414d3084291b054da131ba124`, SHA-256
`ea840ae7471d6234209791f58c39dc9ffc6824213184c518b776155b5fc139e8`.
Nie uruchomiono solvera ani nie uznano starego joba za dowód aktualnego
runtime. Bieżący job `6b2de4a74bf64669ae0e92610b1bb078` nadal kompiluje.

## DE-SMOKE — kontrola wierszy wynikowych, 2026-09-22

Dodano `validate_de_smoke_rows.validate_rows` i włączono ją do wykonania
obu wariantów DE-SMOKE. Wymaga pełnych dwóch/pięciu próbek, zgodności
sample_index z wektorem k, nieujemnych całkowitych ID, unikalnych modów
oraz gałęzi w próbce, skończonych częstości w zamrożonym oknie 8.5–12 GHz
i residual_norm w zakresie 0–1e-8. Brak danych nie jest zamieniany na zero.
Nawet exit 0 procesu nie daje completed_unqualified, gdy kontrola zawiedzie.

Łącznie 28 testów Python i cztery podtesty klienta/kontroli wierszy przeszły.
Wynik tej warstwy jest wyłącznie preflight: zawsze zachowuje qualification
NOT VERIFIED i wylicza brakujące wymagania. Nie zastępuje residualu
oryginalnego pencila, natywnego pochodzenia, pól/fazy, identyfikacji n0,
porównania analitycznego ani zbieżności. Pełna bramka T6 nadal otwarta;
nie zmieniono kryteriów C1.

Log joba `6b2de4a74bf64669ae0e92610b1bb078` potwierdził przejście do
native-build i kompilowanie zależności Rust. Poprzednia obserwacja samego
Pythona opisuje wcześniejszy etap. Nie ma jeszcze terminalnego wyniku.

## T4 — wzorzec demagu i stan workera, 2026-09-22

Niezależny wzorzec potencjału 1D oraz jego wyprowadzenie zapisano w commicie
`833dc2e635571b2eb1f5faeb45b89ad13d1b2a19`. Wzorzec rozwiązuje słabą
postać Poissona dla pełnego czynnika exp(-iky), z dokładnymi interfejsami
filmu i zerowym potencjałem na końcach airboxu. Nie oblicza częstości modów.

Dodatkowy przegląd wykrył zbyt dużą domyślną tolerancję bezwzględną asercji
energii; przy energii rzędu 1e-14 J/m² mogła maskować niezgodność.
Test wymaga teraz względnej zgodności 1e-9 z abs=0. Dodano kontrolę
skalowania amplitudy/energii, hermitowskości i dodatniości uśrednionej
macierzy oraz zbieżności drugiej składowej do granicy otwartego filmu.
Łącznie dziewięć testów Python przeszło. Natywne porównanie T4 pozostaje
niewykonane; nie należy utożsamiać wzorca z wynikiem produkcyjnego FEM.

Job `6b2de4a74bf64669ae0e92610b1bb078` nadal działa. Odczyt dokładnego
kontenera pokazał python3, około 63 MiB RAM i 12% CPU, bez procesu
kompilatora. W chwili próbki wchan procesu wskazywał p9_client_rpc.
To dowód oczekiwania na udostępniony system plików, nie dowód konkretnego
procentu materializacji ani zakleszczenia. API logów nadal zwracało pusty
tekst; zadania nie anulowano ani nie zastąpiono duplikatem.

## DE-SMOKE — ścieżka uruchomienia, 2026-09-22

Model zapisano i wysłano w `50f62bd4d039b1e6a5dac1e9be04ef23a593a5bf`.
Dodano receptę `just run-de-smoke <job-id> two` (lub `five`) korzystającą
z istniejącego klienta pilota. Wybór modelu ma zamkniętą listę, jawny eksport
ustawienia próbek, oddzielny katalog i wersjonowany receipt DE-SMOKE.
Sprawdzanie manifestu i hasha modelu w niemodyfikowanej kapsule pozostaje
obowiązkowe; brak modelu odrzuca uruchomienie. Nie osłabiono bramki C1.

Dwanaście testów Python oraz cztery podtesty przeszły, w tym odrzucenie
podmienionego modelu, niedozwolonego wyboru i zapis statusu niezakwalifikowanego.
`just --show run-de-smoke` i kontrola diff przeszły. To dowody klienta,
nie wykonania modelu. Aktualny build nie zawiera jeszcze nowego pliku.

API nadal raportuje job `6b2de4a74bf64669ae0e92610b1bb078` jako running;
niezależny odczyt jego dokładnego kontenera potwierdził Running=true,
OOMKilled=false. Lista procesów pokazała python3 oraz docker-init, bez
procesu kompilatora w chwili odczytu. Pusty log nie pozwala określić
postępu kompilacji. Nie uruchomiono duplikatu ani nie przerwano zadania.

## DE-SMOKE — konfiguracja 10 nm i kontrola DSL, 2026-09-22

Dodano `examples/fem_de_smoke_numeric.py`: komórka 40×40×10 nm,
2 µm powietrza z każdej strony, pełny demag Floquet, CPU/double,
Ms=800 kA/m, A=13 pJ/m, B=0.1 T w x, k w y. Domyślnie dwa
punkty (Γ, 2e6 rad/m); `FULLMAG_DE_SMOKE_SAMPLING=five` wybiera
0/1/2/3/5e6 rad/m. Okno 8.5–12 GHz, cztery mody, eksport pól we
wszystkich próbkach. Wymagane trzy warstwy są intencją siatkowania;
osiągnięta siatka nadal wymaga osobnego sprawdzenia runtime.

Trzy lekkie testy publicznego DSL→IR przeszły: oba zestawy próbek oraz
odrzucenie błędnego wyboru. Sprawdzają rzeczywistą geometrię, materiał,
oddziaływania, periodyczność, fazę, demag, okno i wyjścia. Nie kompilowano
testów natywnych. Konfiguracja nie dziedziczy ustawień pilota 100 nm ani A1.

Job `6b2de4a74bf64669ae0e92610b1bb078` nadal ma status `running`.
Nowy plik nie znajduje się w jego wcześniejszej kapsule źródeł: przed
wykonaniem trzeba zapewnić zgodną, weryfikowaną ścieżkę modelu i runtime.
Nie podmieniono plików kapsuły. T4–T7 i punkty numeryczne pozostają
NOT VERIFIED; dodanie konfiguracji nie jest wykonaniem dyspersji.

## Zabezpieczenie wykonania pilota DE — 2026-09-22

Job `6b2de4a74bf64669ae0e92610b1bb078` został potwierdzony przez API jako
`running`. Nie ma jeszcze terminalnego receiptu ani nowego wyniku fizycznego.

W `run_de_100nm_pilot.py` dodano hostowy watchdog zgodny z limitem kontenera
oraz wspólny, kontrolujący tożsamość kontenera cleanup po błędzie, timeout
lub przerwaniu. Receipt zachowuje końcowy błąd i wynik cleanupu. Naprawiono
fixture identyfikacji kontenera; sześć testów Pythona przeszło, w tym timeout
i KeyboardInterrupt. To testy lifecycle, bez wykonania FEM/Dockera.

Istniejący pilot 100 nm / dziewięć punktów nie jest zamrożonym DE-SMOKE
10 nm / pięć punktów z planu 2026-09-16. Nadal trzeba przygotować i wykonać
właściwy mały przypadek oraz kwalifikację T4–T7; wyników nie wolno mieszać.


## Odblokowanie profilu runtime-only — 2026-09-22

Runner odrzucał zgłoszenie HTTP 400, ponieważ konfiguracja operatora nie
zawierała `fem-cpu-slepc-runtime-v1`. Health błędnie raportował wszystkie
profile katalogu zamiast aktywnej listy operatora. Naprawiono ten odczyt
w `container_main.py`; 22 testy Pythona przeszły. Poprawka źródłowa health
nie jest jeszcze wdrożona w obrazie koordynatora.

Oficjalny klient włączył profil; koordynator został odtworzony na tym samym
obrazie po kontrolowanej pauzie pustej kolejki, następnie wznowiony.
API przyjęło job `6b2de4a74bf64669ae0e92610b1bb078`, profil runtime-only,
commit `0669d76c2306a31dfe162c2f3ae5af4cb458b552`, source digest
`80d37a70ea788833a1813471f0c4dca0bea9f07b34e23b3c7d1b47dadf19cd41`.
Zgłoszenie nie kompiluje testów jednostkowych. Przyjęcie joba nie dowodzi
sukcesu buildu ani fizyki; kolejnym krokiem jest receipt i diagnostyka DE.

Starszy job `0c899a2c5dde45cdbc8e9605f2c57aa1` przeszedł aktualny dry-run
walidatora receiptu i hashy. Jego 61 plików natywnego frequency-domain
jest zgodnych z bieżącymi źródłami po normalizacji końców linii, ale pięć
plików runnera FEM się różni; nie jest dowodem wykonania aktualnego brancha.


## Aktualny stan po naprawach audytu — 2026-09-21

Zweryfikowany bieżący snapshot to HEAD `deb993e27877b0428a7b2a4ea920d716af7e54d8`
na branchu `codex/eigensolve-dispersion-plan-20260912`; worktree jest czysty,
a branch jest wypchnięty do origin. Snapshot zawiera merge z
`origin/master` (`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`) oraz późniejsze
poprawki kontraktów i testów.

Pięć problemów z audytu ma następujący status źródłowy:

| Problem | Stan źródła | Dowód lub ograniczenie |
|---|---|---|
| Analityka zastępowała FEM | naprawione | `dispersion_validation` odrzuca syntetyczny solver; `execute_fem_eigen_path` wykonuje native solve, a wartości KS/DE/BV są dopisywane po solve do CSV. |
| Niestabilne `P00` przy $k\to0$ | naprawione | Python i Rust używają wspólnego rozwinięcia Taylor/expm1; regresje sprawdzają ciągłość częstości, nie tylko współczynnika. |
| Sztywne limity `3e6` i `5 GHz` | naprawione | Są wyłącznie wartościami presetu; planner waliduje skończone parametry przekazane w `runtime_metadata`, a fixture C1 podaje własny zakres. |
| Brak wykonywalnej bramki naukowej | naprawione źródłowo | Benchmark wywołuje fail-closed validator wymagający 61 próbek, 8 pasm, Kittel/KS, finite rows i trzech kampanii zbieżności; bez bundle porównawczego wynik pozostaje `NOT VERIFIED`. |
| Niespójna dokumentacja/checkpoint i telemetryka | naprawione w bieżącym opisie | Dokument rozdziela implementację źródłową, wykonanie managed i kwalifikację fizyczną; początkowy progress nie publikuje stałego `300`, a limit trafia z callbacku EPS. |

Kontrole źródłowe CI dla tego snapshotu: Rust, Python, API, generated API,
FDM i Control Room zakończyły się sukcesem. Browser smoke przeszedł bazowy
fixture i negative control, ale test mutacji Inspectora zatrzymał się na braku
`model:object:film`; jest to osobny regres UI. Managed FEM pozostaje w kolejce,
więc bieżący snapshot nadal nie ma nowego runtime receipt ani zaakceptowanej
dyspersji `k≠0`.

## Synchronizacja źródeł — 2026-09-21

Worktree `C:\\git\\fullmag\\worktrees\\eigensolve-dispersion-plan-20260912`
został zsynchronizowany z najnowszym `origin/master` przez merge commit
`60302922e`; drugim rodzicem jest
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`. Przywrócono lokalne poprawki
audytu z zachowanego stasha bez konfliktów. Włączone są aktualizacje mastera
dotyczące persystencji projektu, runtime verification, obserwowalności runnera
i UI oraz wersjonowanego AST parametrów; zachowano jednocześnie kontrakty
SLEPc/Floquet, fail-closed telemetrykę, stabilne P00, rozdzielenie solve od
analityki oraz bramkę naukową dyspersji.

Na snapshotcie przed ostatnim commitem mastera przeszły: parsowanie 23
zmienionych skryptów Python,
6 kontroli kontraktów Floquet/SLEPc oraz 15 testów orkiestratora benchmarku;
pełna bateria walidatora naukowego dała 49/49. To są dowody źródłowe, nie
dowód wykonania natywnego FEM. `cargo fmt --check` dla całego checkoutu nie
jest zielony z powodu formatowania odziedziczonego z aktualizacji mastera;
nie zmieniono go automatycznie, aby nie rozszerzać zakresu synchronizacji.

Stan fizyczny pozostaje `NOT VERIFIED`: nie ma nowego managed runtime receipt
dla tego HEAD, pełnej ścieżki C1/A1 (61 próbek, 8 gałęzi), zbieżności siatki/
airboxu/liczby modów ani browser proof. Nie uruchamiano ciężkiego buildu przy
ograniczonej przestrzeni runnera.

### Kontynuacja po synchronizacji — 2026-09-21

Po tym checkpointcie poprawiono dwa regresy ujawnione przez CI: synchronizacja
żądań obserwacyjnych nie zwiększa już rewizji widoku drugi raz w ramach jednej
mutacji (`ae6c690ec`), a test checkpointu korzysta z identyfikatora wygenerowanego
przez endpoint zamiast z nieaktualnego identyfikatora stałego (`613ca6a0b`).
Oczekiwanie testu inspekcji archiwum uwzględnia konserwatywne ostrzeżenie dla
`project/current_live_snapshot.json` bez typowanych referencji, wprowadzone w
najnowszym `masterze`. Bieżący HEAD po naprawach testowych to `deb993e27`;
source/contract CI potwierdziło ten snapshot. Nie zmienia to granicy naukowej:
brakuje świeżego managed receipt FEM, niepustego solve dla `k≠0` i kwalifikacji
pełnej relacji dyspersji.

## Audyt i korekta stanu — 2026-09-19

Bieżące ustalenia: [audyt implementacji i frontendu](../../audits/2026-09-19-dispersion-implementation-audit.md).
Dwa kontenery C1 z 2026-09-18 pozostały aktywne mimo limitów czasu klienta
(3600/21600 s). Po potwierdzeniu pełnych ID i mountów zatrzymano wyłącznie
te dwa procesy. Oddzielne pliki `audit-recovery-20260919.json` zachowują dowód
interwencji; historyczne wyniki nie zostały przepisane.

Heartbeat oraz przyrost `idle` nie dowodzą konwergencji, zakończenia punktu k
ani wejścia w konkretny podetap solvera. Poprzednie komentarze sugerujące
postęp na tej podstawie należy skorygować. Nie ma zatwierdzonych artefaktów
C1 z tych przebiegów. C0 bez demagu nie potwierdza C1 Gamma z demagiem.

Potwierdzono także utratę callbacku postępu i Stop/Pause przy przejściu przez
orchestrator ścieżki k. Trwa naprawa propagacji callbacku i kontroli czasu
życia kontenera oraz równoległy audyt fizyki, walidacji i frontendu.
Ponowienie pełnych 61 punktów wymaga najpierw rozpoznania pojedynczego solve.
Profil weryfikacyjny ewentualnego buildu: `fem-cpu-slepc-runtime-v1`, bez
kompilacji testów jednostkowych. Źródła, build, runtime i fizyka mają oddzielne
statusy; cały nonzero-k pozostaje `NOT VERIFIED` do uzyskania dowodów.


## Najnowszy checkpoint solvera — 2026-09-18

Managed job `f60da21a0f444e62bdd4ddee12577bd9` zbudował runtime i zaliczył
kontrakt SLEPc 8/8. Po normalizacji operatora pierwszy kanoniczny C0 wykonał
się poprawnie: powstał jeden punkt `k=0`, częstotliwość
`2.800264212915114 GHz`, względny residual `3.01e-27`, a błąd względem
Kittela wyniósł `1.36e-15`. C0 nie jest jeszcze kwalifikacją naukową, bo
brakuje kampanii zbieżności siatki/liczby modów; jego status bramki to
`NOT VERIFIED`. Wygenerowany wykres znajduje się w artefaktach runu jako
`c0/eigen/plots/dispersion-c0.png`.

W bieżącym worktree poprawiono solver w
`backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`: obie strony
realnej rotacji są teraz skalowane wspólnym czynnikiem wyprowadzonym z normy
operatora i targetu, a shift `MAT_SHIFT_NONZERO` pozostaje względny po tej
normalizacji. W wyniku zapisuje się `operator_normalization_scale`; dla
każdego podokna telemetria zapisuje też przyczynę odrzucenia, liczby
kandydatów dodatnich/w-oknie, zakres częstotliwości i maksymalny residual
kandydata. Nie zmienia to wartości własnych uogólnionego problemu.

Próba C1 na tym runtime wygenerowała poprawną siatkę (615242 tetraedry,
108749 węzłów), ale zatrzymała się przed modalnym solve na ochronie certyfikatu:
`canonical_preimage_length_overflow` przy starym limicie 16 MiB. Limit został
podniesiony do 256 MiB z zachowaniem skończonego fail-closed boundu w
`backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`. Nowy
managed job `bd32ae0aa45e437580393aebba4d20a1`, profil
`fem-cpu-slepc-modal-v1`, source digest
`7fa23ebf9cdbf2e850201b2a4571c4c7909c19a304ce4587d63e70b635e5abce`, jest
terminalnie `succeeded`; kontrakt ma 8/8 testów, CPU/double/SLEPc i
`fallback_used=false`. C1 należy teraz ponowić na tym dokładnie attested
runtime, sprawdzić pełne artefakty Floqueta/demagu i dopiero uruchomić A1; do
czasu tych dowodów runtime non-zero-k, pełna fizyka dyspersji i bramka naukowa
pozostają `NOT VERIFIED`.

Ponowienie C1 na `bd32ae0aa45e437580393aebba4d20a1` uruchomiono z `--cases c1`
i limitem 3600 s. Certyfikat siatki przeszedł (615322 tetraedrów, 108788
węzłów), relaksacja zakończyła się po 3 krokach, a natywny proces modalny
pracował do wygaśnięcia limitu. Run zakończył się `status=failed`,
`timed_out=true`, bez `dispersion.csv`, widma, tabeli gałęzi i bez uruchomienia
bramki naukowej. Jest to blokada wydajnościowa pełnego C1, nie dowód błędu
fizycznego ani sukcesu runtime; diagnostyczny log zachowano w artefakcie
`comsol-dispersion/00db21eae1644871b14c71db18f23f3d/c1/runtime.log`.

Na żądanie operatora przeprowadzono ograniczone sprzątanie storage. Z katalogu
terminalnie nieudanego joba `9da3622cca884500a49f1295081e4d6a` usunięto tylko
podkatalog `execution` (0,276 GiB, bez aktywnego procesu, kontenera, mountu
ani dowiązania). Artefakty, receipt, manifest, logi i dowód błędu pozostały w
tym runie; aktywny job `bd32…` i jego dane nie były modyfikowane.

## Bieżący stan weryfikacyjny — 2026-09-18

Ten wpis jest aktualnym punktem odniesienia; dalsze sekcje dokumentu zachowują
historię wcześniejszych checkoutów, commitów i jobów. Bieżący worktree to
`C:\\git\\fullmag\\worktrees\\eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`a7723cf0b3dd179f32da5294dbda8dcd685b6e14`, z niezacommitowanymi zmianami
źródłowymi kilku etapów pracy. Nie należy interpretować historycznych wpisów
o czystym worktree ani dawnych jobach jako dowodu obecnego stanu.

| Wymaganie | Źródło | Wykonanie | Walidacja fizyczna |
|---|---|---|---|
| Analityka po rzeczywistym solve | Guard wykonania odrzuca syntetyczny K0 przy `dispersion_validation`; KS jest postsolve | C0 z f60 ma rzeczywisty solve i Kittel: `2.800264212915114 GHz`, rel. błąd `1.36e-15` | C0 punktowo potwierdzony; pełna bramka `NOT VERIFIED` |
| Stabilne P00 i ciągłość częstości | Rust/Python: Taylor + `expm1`; ciągłość częstotliwości w walidatorze | Kontrole Pythonowe przechodzą | Native FEM `NOT VERIFIED` |
| Zakres C1 | Planner nie ma sztywnych limitów `3e6`/`5 GHz`; C1 ma 61 próbek i zakres do X | Certyfikat i relaksacja przeszły na `bd32…`, ale pełny modal solve przekroczył limit 3600 s i nie zapisał artefaktów | Artefakty C1 `NOT VERIFIED`; potrzebny dłuższy przebieg lub odrębny, jawnie diagnostyczny punktowy probe |
| Bramka naukowa | Orchestrator wywołuje fail-closed gate; gate wymaga 61 próbek, 8 gałęzi, Kittel/KS i zbieżności | C0 ma poprawny artefakt, lecz tylko 1 próbkę; C1/A1 i zbieżność są otwarte | `NOT VERIFIED` |
| Polityka solvera i telemetria | Jawny PETSc/SLEPc policy; dodatni amount shiftu faktoryzacji jest względny względem norm operatorów, a KSP zgłasza niepowodzenie | Managed job `f60da21a0f444e62bdd4ddee12577bd9` zakończył się `succeeded` na PETSc 3.24.6/SLEPc 3.24.3; build i kontrakt `slepc-modal` mają exit 0, a CTest raportuje 8/8 testów | Runtime modalny C1/A1 i fizyka pełnej dyspersji `NOT VERIFIED` |

Wybrany zestaw lekkich kontroli źródłowych daje **128 passed, 54 subtests
passed**. `rustfmt --check` dla zmienionych plików Rust i `git diff --check`
przechodzą. Poprzedni poprawiony przebieg C0 (`0a7ebc1c59a8415b9072447ae99e9202`)
doszedł do produkcyjnego solvera, lecz zakończył się zerowym pivotem PETSc i
został zatrzymany po wzroście pamięci; nie powstał ważny punkt częstotliwości.
Wprowadzono teraz względny dodatni shift tylko dla faktoryzacji LU, jawne
`KSPSetErrorIfNotConverged` oraz telemetrię polityki shiftu. Job
`9da3622cca884500a49f1295081e4d6a` zakończył kompilację błędem, ponieważ
PETSc 3.24.6 nie definiuje `MAT_SHIFT_POSITIVE`; poprawiono to na
`MAT_SHIFT_NONZERO` z jawnym dodatnim amountem względem norm operatora. Job
`134a6139c0354eeab81132a0bc193fd9` również nie utworzył kontenera workera;
zamknięto go jako `blocked`, zachowując dowód braku `coordinator.json` i logów.
Managed job `f60da21a0f444e62bdd4ddee12577bd9` użył profilu
`fem-cpu-slepc-modal-v1`, snapshotu `0737933f537f48e28568d97e5bb34197` i
źródłowego digestu `4a8ea1cd8e32f8b9cdd13642695624fdfca4e7ff278a2c78eeca04cf7fe23077`.
Receipt koordynatora jest terminalnie `succeeded`, obraz ma digest
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`, a
kontrakt zawiera osiem zaliczonych testów Floquet/modalnych. C0 ma już wynik
solvera i wykres, ale nie zamyka C1/A1 ani zbieżności. Stare logi
`CTest/Temporary` i poprzednie przebiegi nie są dowodem dla tego joba.

Kontrola dokumentacji z 2026-09-17 usunęła sprzeczne deklaracje „nie
zaimplementowano” z kontraktów `0600`, `0700`, `0710`, `0828` i `0831`.
Dokumenty rozróżniają teraz source-visible CPU Floquet/airbox bridge od
managed-runtime i physics qualification; capability error pozostaje wymagany
dla bieżącego niezweryfikowanego snapshotu. Walidatory map źródłowych, walidator
podziału produktów oraz 32 testy kontraktu dokumentacji przechodzą; poprawiono
też dwie stare asercje fixture'ów runtime, a wybrany zestaw kontraktów daje
**79 passed**. Nowego snapshotu nie wysyłano, ponieważ storage runnera ma
około **0,74 GB** wolnego miejsca.

W tej samej kontroli zamknięto M6 na granicy fizycznego bridge'a: niehermitowski
Schur dynamicznego demagu z względnym residualem powyżej `1e-8` jest odrzucany
przed przekazaniem do modalnego operatora. Niski oracle algebraiczny pozostaje
dopuszczający fixture'y manufakturowane. Źródłowy test kontraktowy tej
osłony przechodzi (`2 passed`); nie jest to jeszcze dowód managed runtime.


## Aktualizacja stanu źródeł i runtime — 2026-09-16

Bieżący checkout to worktree `eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`; aktualny HEAD należy zweryfikować
przez `git rev-parse HEAD`. Worktree jest czysty przed tym checkpointem.
Commit źródłowy `5f53ee304` naprawia serializację JSON diagnostyki modalnego
okna CPU (`ksp_rtol`), która przerwała
poprzedni przebieg C0 przed walidacją artefaktów.
Poniższa tabela opisuje aktualny snapshot, a dalsze sekcje zachowują historię.

| Zakres | Stan źródła | Aktualny dowód / ograniczenie |
|---|---|---|
| Analityka kontra FEM | DE/BV jest postsolve oracle; ścieżka `dispersion_validation` przechodzi przez numeryczny solve. Jawny syntetyczny solver pozostaje wyłącznie ograniczonym K0-3 oracle. | Kod rozdziela `reference_oracle` od produkcyjnej `FemEigenExecutionResolutionIR`; brak jeszcze dowodu fizycznego z pełnego runtime. |
| P00 i ciągłość przy Γ | Stabilny Taylor + `expm1` istnieje w Pythonie i Rust; bramka porównuje także ciągłość częstotliwości. | Dowód źródłowy; wynik native nadal oczekuje na benchmark. |
| Zakres C1 | Planner nie narzuca `3e6 rad/m` ani `5 GHz`; limity są parametrami walidacji i presetów. | Kanoniczny C1 obejmuje 61 próbek do X; pozostaje sprawdzenie na artefaktach native. |
| Bramka naukowa | Runner wywołuje scientific gate po sprawdzeniu artefaktów; gate wymaga 61 próbek, 8 gałęzi, Kittel/KS, finite rows, residualu, fazy oraz zbieżności. | Status nadal `NOT VERIFIED`, bo nie ma jeszcze zakończonego C0/C1/A1. |
| Operator Floquet | Sprzężenie shared-domain stosuje `A_qphi=-mu0*A_phiq^H`; wynik przechowuje właścicieli MFEM form/coefficientów. | Wymaga kompilacji i wykonania managed MFEM/SLEPc; źródło nie jest dowodem runtime. |
| Telemetria/polityka | Początkowe `max_iterations=None`; callback publikuje rzeczywisty limit. Jawna polityka PETSc pozostaje single-process CPU. | Pomiar skalowania i runtime są otwarte. |
| Ostatni C0 | Przebieg na wcześniejszym buildzie doszedł do natywnego solvera, ale zakończył się błędem parsera JSON w diagnostyce modalnego CPU (`123"ksp_rtol`). | Błąd serializacji naprawiono w `5f53ee304`; poprzedni wynik nie kwalifikuje fizyki. Po poprawionym buildzie trzeba ponowić C0. |
| Bieżący managed build | Job `a39c46d3dd484cc385c64924d1e0ec8b`, profil `fem-cpu-slepc-runtime-v1`, commit `5f53ee304`, stan `running`; runner potwierdza zdrowie i przyjęcie joba. | Log kompilacji jest jeszcze pusty w początkowej fazie przygotowania. Po zakończeniu trzeba uruchomić C0, następnie C1/A1. Kwalifikacja pozostaje `NOT VERIFIED`. |

Kwalifikacja naukowa, wykres dyspersji z rzeczywistego operatora oraz release
pozostają otwarte. Syntetyczne wartości analityczne i testy kontraktowe nie są
dowodem wykonania natywnego FEM.


## Aktualizacja po uruchomieniu natywnego C0 i osłonach skalowania — 2026-09-15

Aktualny checkout to worktree `eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`82e726b13`. Branch jest wypchnięty na `origin`. Wcześniejsze SHA, joby i wyniki
pozostają historią; poniższy wpis opisuje aktualny kod i najnowsze dowody
wykonania.

| Zakres audytu | Stan źródła | Dowód wykonania / ograniczenie |
|---|---|---|
| Analityka kontra FEM | `dispersion_validation` jest porównaniem postsolve; `eigen_path.rs` wykonuje numeryczny single-k solve, a kolumny analityczne są dopisywane do CSV po wyniku. Produkcyjna rozdzielczość odrzuca referencyjny/syntetyczny solver. | Nie jest to jeszcze dowód natywnego wyniku; każdy przypadek musi zakończyć się poprawnym receipt'em i artefaktami. |
| Stabilność `P00` przy `k→0` | Python i Rust używają wspólnego schematu Taylor + `expm1`; bramka sprawdza ciągłość częstości, nie tylko współczynnika. | Dowód źródłowy/testy kontraktowe; brak zakończonej kampanii FEM. |
| Zakres C1 | Planner nie narzuca już stałych `3e6 rad/m` ani `5 GHz`; zakres wynika z metadanych i sprawdzanej stosowalności modelu. | C1 nadal wymaga rzeczywistych próbek i zgodności z analityką w dozwolonym zakresie. |
| Bramka naukowa | Runner wywołuje walidator scientific gate; wymaga pełnych przypadków C0/C1/A1, ścieżki 61 próbek, ośmiu gałęzi, pól, Kittel/KS i zbieżności. | Status pozostaje `NOT VERIFIED`, dopóki nie ma kompletnych wyników. |
| Polityka solvera/telemetria | Adapter publikuje rzeczywiste limity z callbacku; początkowe `max_iterations` pozostaje `None`, zamiast stałej `300`. Polityka PETSc jest jawnie opisana. | Weryfikacja managed runtime z bieżącym HEAD i pomiar skalowania pozostają otwarte. |
| Transport operatora | Runner zachowuje macierze do rekonstrukcji modalnej, ale przekazuje także jawny CSR; duża diagnostyka gęsta jest pomijana i raportuje `skipped_large_operator`. | Commity `c69c16b7` i `82e726b1`; wymagany jest nowy managed build i wynik runtime. |
| Ostatni managed build | Job `56a8e337581144899a91d90274d43ee5` zakończył się `succeeded` dla profilu `fem-cpu-slepc-runtime-v1`, lecz źródło receiptu to wcześniejszy commit `20d6ae76`; wynik kwalifikuje tylko build, nie fizykę. | Nie jest dowodem dla HEAD `82e726b13`. |
| Bieżący managed C0 | Run `03066685758b414b820531c15dd8f807`, przypadek C0, używa runtime z joba `56a8e337...`; kontener jest żywy i natywny SLEPc raportował postęp do kroku 30. | Brak terminalnego receiptu i artefaktów widma; należy dokończyć ten przebieg albo, po jego terminalnym stanie, uruchomić nowy build z bieżącego HEAD. |

Pierwszy aktualny przebieg potwierdza wejście do natywnego solvera, ale nie
zamknął jeszcze etapu zapisu artefaktów. C0 jest tylko kontrolą w punkcie Γ;
C1/A1, pełna ścieżka 61 próbek i wykres dyspersji nadal pozostają otwarte.


## Bieżący checkpoint po poprawce ciągłości częstotliwości — 2026-09-14

Aktualny worktree `eigensolve-dispersion-plan-20260912` na branchu
`codex/eigensolve-dispersion-plan-20260912` zawiera implementację ciągłości z
`3b8065466` oraz ten checkpoint; bieżący commit potwierdza
`git rev-parse HEAD`.
Worktree jest czysty. Ten checkpoint rozdziela dowody źródłowe od wykonania
managed runtime i od kwalifikacji fizycznej.

| Zakres | Stan bieżący | Dowód lub następny krok |
|---|---|---|
| P1 — numeryczny solve i analityczne porównanie | Zaimplementowane w źródłach | `eigen_path.rs` wykonuje numeric single-k solve; analityka pozostaje referencją postsolve |
| P00 przy `k→0` | Zaimplementowane w źródłach | Rust/Python używają Taylor + `expm1`; nowa kontrola sprawdza ciągłość częstotliwości |
| Zakres C1 | Zaimplementowane w plannerze/walidatorze | Brak sztywnych limitów `3e6 rad/m` i `5 GHz`; pozostaje walidacja stosowalności modelu |
| Bramka naukowa C0/C1/A1 | Kod bramki gotowy, wynik naukowy otwarty | Wymagane rzeczywiste 61 próbek, 8 gałęzi, Kittel/KS i zbieżność mesh/airbox/mode-count |
| Polityka PETSc/telemetria | Zaimplementowane w źródłach | Sequential PETSc, LU dla Poissona, GMRES/Jacobi dla układu przesuniętego, odczyt rzeczywistych limitów |
| Managed runtime | W TRAKCIE | Job `669d35c722c54745aed4965d6de191ed` (commit `fbbc87a4`) kompiluje się na obrazie koordynatora `sha256:42596c689843141ec68cf782d50ae9bcf90bc1d219c553b665186ecce3b1af36`; po zakończeniu potrzebny jest nowy job dla bieżącego HEAD tego worktree |
| Kwalifikacja fizyki i release | NOT VERIFIED | Nie ma jeszcze receiptu z poprawnym runtime ani wyników benchmarku C0/C1/A1; B4–B6 pozostają otwarte |

Weryfikacja po zmianie: `test_validate_comsol_dispersion_scientific_gate.py`
**43/43**, `test_verify_fem_frequency_domain_eigen_artifacts.py` **203 passed**.
Te testy nie są wykonaniem natywnego operatora FEM. Kontrola ciągłości w bramce
raportuje pary próbek KS, a walidator artefaktów odrzuca skok częstotliwości
między sąsiednimi próbkami scenariuszy DE/BV.

## Audyt GPT PRO 6 — korekta priorytetów 2026-09-14

Obowiązuje [integracja 20 ustaleń i zaktualizowana kolejność napraw](2026-09-14-non-k0-pro6-audit-integration.md).
Audyt bazuje na master `33aa26f`; aktualność sprawdzono na worktree HEAD
`3833c93eb2d52f575e2b8c67d7723225bc3cd61c` oraz roboczych plikach bramki.
Najpierw osłony starego adaptera, fizyczny operator i certyfikat odzyskanego modu;
potem kwalifikacja istniejącej sparse ścieżki CPU z demag. NK-17/18 są poprawione
w źródłach; nie oznacza to native qualification. B4–B6 nadal otwarte, teraz także
z kontrolą pola/fazy/n=0 i kampanią co najmniej 3 siatek oraz 3 airboxów.
Poniższe checkpointy zachowują historię; starsze SHA, wyniki testów i statusy jobów
nie opisują automatycznie stanu bieżącego. Aktualizacja planu nie stanowi naprawy NK-01–20.

### Managed runtime — wynik joba 51 i korekta loadera CUDA — 2026-09-14

Job `d6f1e5c18ab640c79761f8320feff2ba` zbudował natywny runtime dla commita
`ffbbf8650c62b848d7c86b03f081a3b336cd9380` w obrazie FEM
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`.
Etap `make install-cli-dev` zakończył się kodem 0, a poprawiony trusted runner
znalazł zagnieżdżony `release/build/fullmag-fem-sys/<hash>/out/native-build/CMakeCache.txt`;
job zakończył się jednak `NOT VERIFIED` z powodu probe:
`fullmag-bin` nie ładował `libcuda.so.1`, ponieważ worker nie dodawał obrazu
`/usr/local/cuda/compat` do `LD_LIBRARY_PATH`. Nie jest to błąd solvera FEM ani
dowód kwalifikacji fizycznej.

W źródłach dodano fail-closed wykrywanie image-owned compatibility SONAME,
wiązanie ścieżki w `runtime-attestation.json` oraz regresje entrypointu. Ostatnia
weryfikacja lokalna: `test_local_runner_build_entrypoint.py` **26 OK** i
`test_local_runner_build_executor.py` **14 OK**. Po commicie trzeba ponownie
zbudować obraz koordynatora, uruchomić nowy managed runtime build, a dopiero po
receipcie uruchomić benchmark C0/C1/A1; B4–B6 pozostają otwarte.

### Wdrożenie trzech poziomów zbieżności — 2026-09-14

Robocza bramka v2 wymaga coarse/medium/fine dla mesh i airbox (C0 bez demag:
not_applicable). Sprawdza kierunek zmiany hmax/odległości, fizykę wspólną dla
przebiegów, oba sąsiednie przyrosty częstości i brak rosnącego trendu ponad
margines 1e-8. Nie wyznacza z tego automatycznie błędu continuum.
Test regresyjny wykazał wcześniej fałszywe qualified dla dwóch poziomów
(mesh i airbox); po poprawce zestaw bramka/agregacja/benchmark:
**36 passed, 15 subtests passed**. Są to interpretowane testy z syntetycznymi
artefaktami, nie wynik kampanii FEM. Dodatkowo naprawiono pomylenie bezwymiarowego
airbox.factor (401) z paddingiem w metrach (2e-6): tożsamość airboxu pochodzi teraz
z DomainFrameIR. Test red→green potwierdził błąd. Kontrola rzeczywistych pól/fazy
jest w toku; review wykrywa też ryzyko porównania różnych siatek przez surowe
tablice równowagi w sygnaturze, które wymaga dalszej korekty przed kwalifikacją.

Odczyt managed runnera przy tej aktualizacji: worker_alive=true,
accepting_jobs=true, job 44 `635451d7648a446a83e8d88e21c0279b` nadal running,
źródło `28f552b959455957bbf6dada8a522a241425552c`. Nie restartowano runnera;
nowy obraz koordynatora pozostaje niewdrożony. Ten job nie kwalifikuje HEAD3833.

### Certyfikat pól i korekty review bramki — 2026-09-14

Bramka v2 jest połączona z niezależnym odczytem vector.bin dla gałęzi i punktów
kontrolnych. Odrzuca brak pola, błędną fazę mimo nowego hasha i podmianę pola
Gamma za próbkę nonzero-k. Sprawdza pełną kolejność węzłów, pary i translacje.
Residuum Blocha normalizuje całym niezerowym polem; zerowy ślad na brzegu
spełnia warunek i nie jest mylony z zerowym modem w całej domenie.

Dalsze poprawki: target i siatka są stałe w mode-count comparison, fe_order
jest stały przy h-refinement, a magnetyczne bounds i hmax przy zmianie airboxu.
Stałe nodalne pola nie różnią się podpisem przez samą liczbę powtórzeń.
Wersje spectrum/branches/manifest są kontrolowane w primary i comparison runs.
Agregator odrzuca qualified z niepustymi lub nieprawidłowymi reasons.

Weryfikacja: **68 passed, 25 subtests passed** — certyfikat, scientific gate,
agregacja, benchmark runner i testy dokumentacji. Brak kompilacji native.
Wcześniejszy błąd tuple/Path w trakcie integracji certyfikatu został usunięty;
wynik powyżej pochodzi z ponownego wykonania całego wymienionego zestawu.

**Nadal otwarte:** profil KS n=0 z pól kontrolnych, przestrzenna zgodność
niejednorodnej równowagi między siatkami (surowe tablice nie są poprawnym
transferem), rzeczywista kampania C0/C1/A1 oraz kwalifikacja operatora i widma.
Syntetyczne fixtures nie dowodzą tych punktów. B4–B6 i cel pozostają W TRAKCIE.

## Aktualizacja po review — 2026-09-14

Stan: **W TRAKCIE**, fizyka non-k0 **NOT VERIFIED**. Sprawdzony HEAD:
`55aadf7f2cbfd2fced91b3cf896e8e17cbb7ce61`, plus niezacommitowane poprawki
bramki naukowej i profilu produkcyjnego SLEPc bez kompilacji unit testów; branch i worktree pozostają
te same. Checkpoint z 13 września poniżej stanowi historię, również w zakresie
runnera, jobów, tokena i wolnego miejsca; nie jest aktualnym health-checkiem.

| Problem review | Implementacja | Dowód / pozostała praca |
|---|---|---|
| Walidacja przełącza FEM na analitykę | Naprawiona w źródłach | Usunięte obejścia planera/runnera; kontrakt manifestu i 8 testów DE/BV passed; native niekompilowany |
| P00 przy k do zera | Wspólne stabilne kernele Python i Rust | 27 testów Python, w tym 80-cyfrowa referencja Decimal i ciągłość częstości; brak kompilacji Rust |
| Sztywne 3e6 rad/m i 5 GHz | Usunięte z walidatorów Python/plannera; defaulty zachowane | 2 testy Python API passed, w tym zakres C1 i NaN/Inf; planner niekompilowany |
| Bramka naukowa C0/C1/A1 | Implementacja w toku | B4–B6 otwarte do rzeczywistych wyników i zbieżności |
| Dokumentacja | Noty 0600/0828 i spec artefaktów zaktualizowane | 10 testów dokumentacji, 32 testy jej narzędzi, source-map 0828 pass; checkpoint aktualizowany wraz z pracą |
| Polityka solvera / telemetria | Naprawiona w źródłach | Jawny single-process CPU, KSPGetTolerances dla obu układów, usunięte zgadywane 300; native niekompilowany |


### Ostatnia kontrola roboczego snapshotu

[Review bieżącego stanu](2026-09-14-non-k0-current-review.md) zawiera zakres,
ustalenia i ograniczenia. Kontrole P00/KS/agregacji: **51 passed**. Kontrole
bramki naukowej i runnera benchmarku: **11 passed, 2 failed**; pozytywny fixture
nie odpowiada jeszcze aktualnemu formatowi natywnych artefaktów. Są to wyniki
roboczej wersji w trakcie poprawek, a nie dowody dla przyszłego commita.

Profil `fem-cpu-slepc-runtime-v1` oraz jego obsługa w benchmarku są zapisane
w commicie `a020f46f0829362d942b7eeebbdd923afcc6f0f2`. Wspólny zestaw
kontroli entrypoint/executor/client/benchmark: **80 passed, 4 subtests passed**.
Hash biblioteki wiąże konfigurację CMake z runtime, a startup stamp musi mieć
snapshot zgodny z receipt. To dowód kontraktu źródłowego, nie wykonania FEM.

Recepta `just runner-coordinator-image` zakończyła się exit 0 i przygotowała
obraz `sha256:4e52622ba0da64d8f4de76539ec4bff6f1511c7c6fd74370c3a7827de9ffcd0e`.
Obraz nie został wdrożony. Odczyt runnera po buildzie wykazał aktywne zadanie
`635451d7648a446a83e8d88e21c0279b` (44), stan running, profil
`fem-cpu-slepc-modal-v1`, źródło `28f552b959455957bbf6dada8a522a241425552c`.
Nie zatrzymano ani nie podmieniono aktywnego koordynatora. Jego allow-list nie
obejmuje jeszcze nowego profilu. Zbudowanie obrazu nie stanowi kwalifikacji
managed runtime ani B4–B6.

Testy Python uruchomiono z `-B` i wyłączonym cache pytest. Pierwsze zebranie
testów API nie znalazło pakietu `fullmag`; ponowienie z repozytoryjnym
`PYTHONPATH=packages/fullmag-py/src` zakończyło się powodzeniem.
Obowiązuje zakaz kompilacji testów jednostkowych. Żaden z powyższych wyników
nie jest dowodem wykonania natywnego MFEM/SLEPc ani poprawności pełnego widma.

Wcześniejszy odczyt `just runner-container-status` (2026-09-14; nie ponowiony przy tej aktualizacji):
`worker_alive=true`, `accepting_jobs=true`, około 48.0 GB wolnego miejsca.
Job 43 `9ce502f938a64abd85d74d4e391b5d3a` jest `running`, dla czystego
commita `95763e6a7f3d6a7c19657bd214d5d805082b926b`; nie obejmuje zmian review.
Nie uruchomiono nowego buildu ani nie zmieniono koordynatora.
Kontrole: 7 testów istniejącego walidatora DE/BV passed, 10 testów dokumentacji
passed, walidacja source-map noty 0828 exit 0. Są to dowody źródłowe,
a nie wynik obliczenia dyspersji. Dodano regresję planera C1 i ujemnego k;
pozostaje niekompilowana zgodnie z ograniczeniem użytkownika.

Dodatkowa kontrola stosowalności KS: odrzucenie pola przeciwnego/poprzecznego,
niezerowego DMI/anizotropii i niejednorodnych pól Ms/A. Wynik: **18 passed**
(11 regresji stosowalności oraz 7 istniejących testów DE/BV).
Review nowej bramki naukowej wykazało, że same deklaracje częstości w evidence
nie wystarczają; wymagane jest powiązanie obserwacji z rzeczywistymi artefaktami
kontrolnymi i zagęszczonymi. Ten punkt pozostaje w naprawie.

Przyrost `da9a0ecf54767823dcc8eb1f4a62807ced0e61cb`:
niezależne referencje Decimal (80 cyfr) dla P00 i częstości BV/DE oraz
przenośne asercje ścieżek Windows/Linux. Generator: **27 passed**.
Pełny walidator: **199 passed, 3 failed** wyłącznie na separatorach ścieżek;
po poprawie trzech asercji ich ponowienie: **3 passed**, 199 deselected.
Nie jest to ponowne wykonanie wszystkich 202 testów po poprawce.
Staged lista dwóch plików i diff/check zostały sprawdzone przed commitem.
Równoległy commit `cfab8109d7e44a7693b8c6d405cb2450611d1ead` zawierał
wcześniejsze zmiany całego worktree; jego obecność nie stanowi kwalifikacji.

Przyrost `052bf7d0f9626b8d6e0d9600a06d57d28e3250fb` domyka kontrakt
numerycznego porównania: usunięty stary wariant solvera referencyjnego,
manifest wskazuje KS jako niezależny model, walidator akceptuje tę postać
i odrzuca analityczne źródło dynamicznego demagu dla wyniku numerycznego.
Osiem testów DE/BV (w tym nowa regresja manifestu) passed. Rust: sprawdzony
źródłowo i przez rustfmt przez agenta routingu; brak kompilacji. Recepta
samodzielnego generatora CSV pozostaje jawnym wejściem do analityki.

Dokumentacja polityki i mapy źródeł została zapisana w
`be01c536032f3dbff9752bd1abc341b93be760ba`. Przeszło 10 testów dokumentacji,
32 testy narzędzi scientific-documentation-contract oraz walidator mapy 0828.
Odczyt profili wykazał brak istniejącej trasy SLEPc runtime-only:
`fem-cpu-release` ustawia SLEPc OFF, a `fem-cpu-slepc-modal-v1` wymaga
kompilacji kontraktów. Trwa przygotowanie odrębnego profilu produkcyjnego bez
kompilacji testów; nie wdrożono go do aktywnego koordynatora.
Wcześniejszy test bramki/runnera: 12 passed, 1 failed (asercja treści komunikatu);
ponadto review wskazało niezgodności z rzeczywistym schematem manifestu oraz
brakujące kontrole zgodności danych. Nie wolno oznaczać bramki jako ukończonej
na podstawie samego usunięcia tej asercji.

Przyrost `55aadf7f2cbfd2fced91b3cf896e8e17cbb7ce61`: przykład low-k po
usunięciu analitycznego obejścia otrzymał po 2 mikrometry powietrza, zamiast
10 nm. Odczyt publicznego DSL i eksport ProblemIR potwierdził domenę
80 x 80 x 4020 nm, film 20 nm oraz zachowaną walidację DE/BV. Test regresji
przeszedł (1 passed). Jednowymiarowe oszacowanie częstości Gamma dla
Dirichleta daje błąd względem otwartej warstwy 0.194%, wcześniej 21.9%.
To oszacowanie brzegowe i test wejścia, nie wykonanie FEM ani zbieżność siatki.

## Historyczny checkpoint — 2026-09-13

Data: 2026-09-13. Status zadania: **W TRAKCIE**. Kwalifikacja solvera non-k0: **NOT VERIFIED**.

## Aktualne kryterium ukończenia — 2026-09-13

Użytkownik zlecił dokończenie implementacji tak, aby Fullmag rzeczywiście
policzył ten sam model co przepis COMSOL. Żaden skrót modelu nie zamyka zadania.
Bazowy checkpoint HEAD: `15577c802c5065305f0522650e7956fc2d0e316a`;
obecny worktree zawiera również sprawdzone, niezapisane jeszcze przyrosty.

| Bramka | Wymagany wynik | Stan |
|---|---|---|
| B0 — model | C0/C1/A1, geometria i parametry z przepisu, skrypt publicznego DSL | W TRAKCIE |
| B1 — brzegi | Fizyczny Dirichlet potencjału ztop/zbottom oraz Floquet x/y na magnetyku i powietrzu | W TRAKCIE; wcześniejsze odrzucenie chroniło przed błędnym Neumannem |
| B2 — skalowanie | Native MFEM/SLEPc sparse lub matrix-free, bez dense512 i bez gęstego K/M w Rust | W TRAKCIE |
| B3 — równowaga | Rzeczywista relaksacja i zaakceptowany, identyczny handoff dla wszystkich k | DO WYKONANIA runtime |
| B4 — kontrola | C0 oraz C1 w Γ, zgodność jednostek/gamma/demag i mały nonzero-k | DO WYKONANIA runtime |
| B5 — pełna dyspersja | A1 L1, 61 punktów Γ–X–M–Γ, 8 fizycznych gałęzi, zespolone mody/potencjały, wykres | DO WYKONANIA runtime |
| B6 — weryfikacja i integracja | Kontrole siatki/airbox/liczby modów, residuale, review/build/PR/merge | DO WYKONANIA |

Zapisany przyrost `19fac315c6e66f2ce5c7b8c96518c2c3e2e2a249`:
wcześniejsza selekcja ciężkich artefaktów wzdłuż ścieżki k, bez usuwania
wektorów potrzebnych do śledzenia gałęzi. Test `eigen_path`: **8 passed**,
log `sparse-modal-path-selection-tests.log`; staged diff/check zweryfikowane.
Ten commit nie zamyka natywnego solvera ani całego zadania.

Przyrost wykresu `8e460ea3dfd8a8714c01cc912bbb3939a1caa13a`: oddzielne
gałęzie według `branch_id`, przerwy przy brakujących próbkach, brak łączenia
modów bez trackingu i usunięcie fałszywego podpisu „no demag”. **7 testów passed**,
w tym render PNG; obejrzany obraz pochodzi z fixture, nie z benchmarku A1.

Bieżący test diagnostyczny `cargo test -p fullmag-runner --lib eigen --offline`:
**259 passed, 0 failed** (log `physical-native-residual-scope-tests.log` w build root
profilu `windows-native`). Obejmuje usunięcie gęstej macierzy z normalizacji,
przekazanie shared-domain Floquet bez gęstego K/M w Rust i test rekonstrukcji
pełnego potencjału. Nie kompiluje natywnego MFEM/SLEPc ani nie dowodzi
wykonania modelu. Pełny eksport potencjału i pola elementowego jest podłączony
w kodzie; natywny operator nadal wymaga kompilacji i wykonania. Testy kontraktu
publicznego benchmarku oraz dokumentacji: **18 passed**, z wyłączonym cache pytest.
Rzeczywista materializacja A1 na Windows zakończyła się błędem access violation
w NumPy podczas ścisłej walidacji siatki; nie powstał zaakceptowany ProblemIR.
Trwa sprawdzenie identycznego modelu w kontrolowanym środowisku Linux.

Profil `fem-cpu-slepc-modal-v1` jest aktywowany (8 CPU, 24 GiB, istniejący
obraz PETSc/SLEPc `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`).
Zachowano sześć profili allow-list i istniejące konfiguracje workerów. Po
zakończeniu joba 41 koordynator został zastąpiony obrazem
`sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`,
kontener `20601ed2d46245996ba5768f5aa408af50e25266c6562fc447bebc311becf90b`.
Graceful drain wykonano po świeżym dowodzie pustej kolejki; aktualny health
potwierdza `worker_alive=true`, `accepting_jobs=true` i brak aktywnych jobów.

Job 41 zbudował pierwszy target modalny, ale zakończył się `exit_code=2` na
linkowaniu kolejnego kontraktu przez brak symboli CUDA w `libceed.so`. Źródło
naprawy zapisano w `377230523`; retry wymaga osobnej zgody automatycznego
przeglądu. Wolne miejsce wynosi około **50.9 GB**, nie usuwano danych.
Ostatnia weryfikacja GitHub wykazała nieważny token; integracja pozostaje otwarta.

Native sparse source jest zamrożony do pierwszego buildu, wraz z regresją
q_complex_dof_count=514, niezerowym sprzężeniem potencjału i analityczną
częstotliwością. Ten test nie został jeszcze wykonany w MFEM/SLEPc.

Poniższe sekcje i dawna tabela S00–S12 są historią etapów. Ich datowane
HEAD-y, liczby wolnego miejsca i opisy brakujących funkcji nie zastępują
powyższego kryterium ani bieżącego kodu. Nie ma jeszcze kwalifikacji non-k0.

## Cel i źródła

Realizacja [planu S00–S12](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md), po osobnym zleceniu implementacji. Zakres obejmuje CPU z pełnym dynamicznym demag-k, falowód 2.5D, interakcje, GPU, artefakty, API i Control Room. Etap źródłowy lub pojedynczy test nie zamyka tego celu.

- Baza `master`: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Ostatni zapisany kodowy przyrost: `beca34bb0` (`fix(eigensolve): reject conflicting Floquet wavevectors`), nad rozdzieleniem assemblacji K0 `2e8362463`, handoffem phase/window `bed355f41`, walidacją payloadu `de72a5b1f`, właścicielem solvera `80736831e`, routingiem dynamicznego demag-k `e3fa509db`, zmianą nodalnego `Ms` `c511cb413`, testem wymuszonego GPU `71ce348b0`, routingiem Γ `1114e1aa0` i podłączeniem providera `f2acf7b9b425733899bdfde63cb0566d16d74a59`.
- Właściciel: `codex:01a0941c-eb15-7261-a7ee-7cf099385525`.
- Rejestr: `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`; reaktywowany do implementacji.
- Fizyczne źródła COMSOL: oba lokalne podręczniki modułu mikromagnetycznego wymienione w planie; szczególnie s. PDF 21–28 i 40–43. Przykład RF jest wzorem sprzężenia pól, a nie gotowym dowodem modalnym.

## Stan etapów

| Etap | Stan | Pozostały warunek |
|---|---|---|
| S00 — baza K0 i dowody | W TRAKCIE | Bieżący managed runtime, Kittel, pełny zaakceptowany handoff |
| S01 — nauka, ADR, kontrakty | W TRAKCIE | Noty, mapy źródeł, walidatory i review |
| S02 — Python/IR | W TRAKCIE | Walidacja k i selektorów, round-trip, testy konsumentów |
| S03 — natywny operator magnetyczny Blocha | W TRAKCIE | Prolongacja fazowa i właściciel sparse są zapisane; pozostają MFEM sparse/matrix-free, pełne assembly i managed runtime |
| S04 — dynamiczny demag-k CPU | W TRAKCIE | Bounded dense Schur provider i producent czterech bloków MFEM są zapisane; planner otwiera wyłącznie strict/double/CPU/Full2x2/FloquetAirbox/nonzero-k z Poisson airbox. Pozostają matrix-free/sparse owner, gauge, zbieżność brzegu i managed runtime |
| S05 — natywny solver spektralny | W TRAKCIE | Dodano właściciela Floquet SLEPc dla dense i sparse oraz routing obu ścieżek; pozostają managed SLEPc, residuale oryginalnego układu, kompletność i resume |
| S06 — śledzenie gałęzi | W TRAKCIE | Hungarian/gaps i metryka masy FE są gotowe; pozostają fizyczne podprzestrzenie zdegenerowane |
| S07 — artefakty i API | W TRAKCIE | Stabilne ID, faza/obwiednia, selektory, binarne pola |
| S08 — Control Room | DO WYKONANIA | Authoring, dyspersja, wybór modu i przestrzenna faza; browser/WebGL |
| S09 — falowód 2.5D | W TRAKCIE | Bounded provider i deterministyczny P1 assembler przekroju są zapisane; pozostają typed realization/routing, managed/MFEM owner, open-boundary convergence i porównania TetraX/3D |
| S10 — interakcje | DO WYKONANIA | Anizotropia, DMI seams, Gilbert i legalność |
| S11 — GPU | DO WYKONANIA | Jawna trasa double bez fallbacku, residency i parytet |
| S12 — kwalifikacja i integracja | W TRAKCIE | Managed benchmarki, review, commity, PR, merge, weryfikacja mastera |

## Zweryfikowane warunki wykonania

Repozytorium bazowe ma ModalEigenRequest ABI **19**. Historyczne numery ABI w dokumentach nie zastępują bieżącego nagłówka. Kanoniczny układ styczny to `q[2*node+component]`, zgodnie z `tangent_frame.cpp` i natywnym assembly `A_qq`.

Odczyt runnera: kontener `Fullmag_build_runner` działa w kontekście `desktop-linux`. Job `908c9b8a781a4af4b77c104a07f925ec` innego worktree, dla tego samego commita bazowego, ma stan `blocked`, bez exit code. Nie jest to wynik testu tego zadania. Odczyt storage wskazał 3 343 511 552 bajty wolnego miejsca; dokumentowany próg runnera wynosi 8 GiB. Nie usuwano cudzych buildów, cache ani wyników.

Próba lekkiej kompilacji nowego testu C++ przez `fullmag_storage.py run` została odrzucona przed kompilacją: `Container runner owns heavy builds on this host; submit a snapshot through just runner-build`. Nie obchodzono tej bramki. Nie uzyskano czerwonego ani zielonego wyniku testu C++.

### S00 — zgłoszony build bazy

Po zmianie stanu środowiska ponowny odczyt o 06:40 UTC wykazał 45 222 551 552 bajty wolnego miejsca, `health.accepting_jobs=true` i pusty aktywny slot. Wcześniejszy brak miejsca nie jest aktualną blokadą.

Zgłoszono własny build dokładnego bazowego commita przez `local_runner_cli.py submit --operation build --profile fem-cpu-release --source commit --ref 5084a94ed14b151fc865e8def5a5c28401e98b44` (klient exit 0):

- Job: `1d31af520bb547848e23be8888fde8d8`, sequence 13; ostatni odczyt przy zgłoszeniu: `queued`.
- Source digest kapsuły: `d8cd645e71228de87ec7a8b9252f8317fd5c402a409e25ba5685aca836ce991a`.
- Native source snapshot SHA256: `bd5d415203e5a59041b580bfd1befbd9a70ed38ebd4b6ac16810274b9418c634`, dirty=false.
- Kapsuła: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/16a8789ca9a746c19369f95b9a94ce86/source`.
- Skonfigurowany obraz CPU: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`, 2 CPU, 8 GiB RAM.

Kolejny odczyt: job przeszedł do `running` (updated_at 1789195476.7236419). Profil ma `FULLMAG_FEM_WITH_SLEPC=OFF`, więc może potwierdzić bazowy build CPU, lecz nie kwalifikuje solvera modalnego SLEPc ani bramki fizycznej K0.

Ten build dotyczy bazy, a nie bieżących niezacommitowanych zmian. Wynik i receipt wymagają osobnego odczytu; S00 obejmuje następnie uruchomienie i walidację fizyczną K0.

## Zasady zaliczania przyrostów

Każdy przyrost otrzymuje pełny hash commita, zakres, wykonane polecenie i exit code po weryfikacji. Źródła, build, managed runtime, nauka, browser/WebGL i kwalifikacja wydania są odrębnymi dowodami. Przyrost dokumentacyjny zapisano w commicie `9c5be5d2212995f1437823178e7f7af83ee883e0`: plan i checkpoint (dwa pliki). Kontrole UTF-8, bloków Markdown, etapów S00–S12, linków, whitespace oraz zgodności staged bytes ze sprawdzonymi plikami przeszły (exit 0); plan miał też niezależne review z domkniętymi uwagami. Commit kodu `f2acf7b9b425733899bdfde63cb0566d16d74a59` istnieje i przechodzi kontrolę Rust; nie ma jeszcze managed receipt ani wyniku runtime. Odrzucenia nieobsługiwanych kombinacji non-k0/demag/GPU pozostają aktywne poza dostarczonym wariantem CPU.


### S03 — fundament redukcji Blocha

W źródłach dodano `FloquetTangentProlongation`, wewnętrzny opis klas i `FloquetReducedMagneticOperator` oraz target `fem_floquet_magnetic_operator_contract`. To prolongacja fazy i bazy oraz działanie `C†AC` nad zwykłym operatorem MFEM; nie ma jeszcze połączenia z ABI solvera, pełnego magnetycznego assembly ani dynamicznego demag-k.

Niezależne review potwierdziło algebrę `C` i operatora sprzężonego. Po uwagach dodano jawny wewnętrzny budżet pamięci (domyślnie 256 MiB, regulowany przez przyszłego właściciela solvera), kontrolę wymiarów/budżetu przed alokacją oraz testy ogromnego requestu, małego budżetu, niewłaściwego kształtu i rzeczywistej mapy dla obrotu spinowego. Zawężono komentarz dotyczący alokacji: własne bufory są przygotowane, lecz zachowanie dostarczonego operatora MFEM wymaga instrumentacji. Kompilacja i wykonanie nowego testu pozostają NOT VERIFIED.

### Przyrost adaptera dynamicznego demag-k

Do natywnego `ModalEigenRequest` dodano jawny, opcjonalny payload gęstej
macierzy realifikowanej `C(k)` dla dynamicznego demag-k. Dostawca musi przekazać
macierz w tych samych zredukowanych współrzędnych i jednostkach co magnetyczny
Hessian; faza Blocha oraz eliminacja potencjału skalarnego muszą być wykonane
przed granicą ABI. Natywny adapter sprawdza niezerowe `k`, tryb Floquet,
`include_demag`, zgodność rozmiaru `n*n`, finite values, trasę gęstą i brak
konfliktu ze ścieżką CSR, a następnie dodaje macierz do efektywnego Hessianu
przed solverem okna, shift-invert i contour. Digest liniowego pencil obejmuje
ten sam przyrost, a diagnostyka zachowuje jego rodzaj i liczbę wartości.

Był to początkowo kontrakt i fail-closed bridge dla już złożonego operatora.
Commit `f2acf7b9b425733899bdfde63cb0566d16d74a59` podłącza bounded właściciela
assemblacji do shared-domain dla jednego wariantu CPU; skalowalny owner
`A_{q\phi}(k)`, `P(k)`, `A_{\phi q}(k)` nadal pozostaje do wykonania. Kompilacja
managed, wykonanie testów C++ oraz walidacja fizyczna tego operatora pozostają
**NOT VERIFIED**.


### Przyrost po kolejnym review (12 września)

Poprzedni obrót celu klasyfikuję jako **postęp**: zapisano commit planu, kod i wyniki kontroli. Bieżąca kontynuacja również zmienia źródła; pełny cel S00–S12 pozostaje aktywny.

- S02: Python odrzuca niecałkowite/ujemne/przepełnione ID, niepoprawne wektory i kontrolne punkty ścieżki. Fokus API/IR dla eigensolve: 35 passed; pełny `test_problem_ir.py`: 26 passed. Rust zachowuje `branches`, `sample_selector`, `include_branch_table`; planner pozwala na unię żądań dla różnych selektorów próbek, a testy IR/plannera/runnera zostały wykonane diagnostycznie.
- S06: implementacja Hungarian i luk zachowuje surowe ID; `overlap_prev` jest rzeczywistym znormalizowanym overlapem, a `tracking_confidence` wynikiem 0.85 overlap + 0.15 frequency. Próg filtruje rzeczywisty overlap. Brak wektora ma jawny fallback częstotliwościowy i `overlap_prev=None`. Usunięto klonowanie bieżących dużych wektorów. Gdy oba artefakty mają zgodne dodatnie wagi FE, overlap używa metryki masy na aktywny węzeł; starsze lub niezgodne wektory zachowują fallback euklidesowy. Fizyczne podprzestrzenie pozostają do wykonania.
- S07: helper selekcji poprawiono po review. ID obecne jednocześnie w modzie i tabeli gałęzi są legalne; tabela waliduje swoje punkty. Etykieta Γ wybiera wszystkie pasujące próbki w ścieżce Γ–X–Γ. Diagnostyka może wymagać trackingu bez eksportu widma.
- S07: writer FEM używa tożsamości `(sample_index, raw_mode_index)`, rozwiązuje wybór gałęzi po trackingu, zachowuje pełne widmo dla `SaveDispersion` i ogranicza osobno pola. Wyłączenie tabeli gałęzi wyłącza jej pliki i linki w manifeście, ale nie tracking. Niewybrane pola zachowują stabilne ID, dostają `mode_field_available=false` i nie mają aktywnego linku. Wybrane pola wymagają metadanych i binarnego payloadu. Dodano i wykonano regresje, poprawiono zachowanie grupy próbki Zarr; bezpośredni writer orchestratora, API i UI pozostają do integracji.
- `rustfmt --check` dla trzech zmienionych writerów oraz selektora i trackingu: exit 0. Nie jest to dowód kompilacji. `git diff --check`: exit 0.
- S01: oba walidatory source-map i końcowy test dokumentacji matematycznej przeszły. Usunięto pięć zdublowanych wierszy indeksu 0831 oraz poprawiono odwołania 0830 do aktualnych właścicieli symboli.

Odczyt runnera 07:23 UTC: własny job `1d31af520bb547848e23be8888fde8d8` pozostaje `running`, żywy worker i aktywny job są potwierdzone API. Log `native-build` zawiera kompilację Cargo. Wolne miejsce wynosiło 68 298 076 160 bajtów; historyczny błąd braku miejsca nie jest aktualną blokadą. Nadal brak terminalnego receipt. Profil nie wykonuje ukierunkowanych testów Rust/native i ma SLEPc OFF; istniejące osobne przepisy managed runtime wymagają dalszego ustalenia prawidłowej trasy w tym hoście.

Kod C++/Rust i nowe testy są zapisane w osobnych, spójnych commitach, lecz nadal są
**NOT VERIFIED przez managed kompilację lub runtime**. Żaden z poniższych wyników
hostowych nie kwalifikuje relacji dyspersji ani dynamicznego demag-k.

### Zapisane przyrosty implementacji

- `964e9f87f` — kontrakt Python → IR → planner, walidacja żądań dyspersji oraz selektory `branches`/`sample_selector`/`include_branch_table`; testy pozwalają również na samodzielne `dispersion_curve` i `eigen_diagnostics`.
- `509db79c2` — śledzenie gałęzi z Hungarian/gaps i fallbackiem częstotliwościowym oraz publikacja selekcjonowanych artefaktów dyspersji z trwałą tożsamością próbki i surowego modu.
- `4c83ea4b2` — fundament redukcji Floqueta i fail-closed adapter dense real-split dla dostarczonego dynamicznego demag-k w natywnym solverze CPU; digest pencila obejmuje efektywną macierz.
- `1300b8035` — dokumentacja dwóch reprezentacji non-k0, źródeł COMSOL/TetraX oraz granicy między adapterem a przyszłym providerem assemblacji.
- `b360f7490` — overlap śledzenia gałęzi z dodatnią metryką masy FE na aktywny węzeł, z fallbackiem dla niezgodnych starszych artefaktów i regresjami.
- `11183f7e8` — bounded dense provider Schura dynamicznego demag-k: zespolone `A_{qφ}(k)`, `P(k)`, `A_{φq}(k)`, kontrola niezerowego `k`, pivotu, gauge, budżetu i realifikacji ABI; test kontraktu CMake.
- bieżący przyrost S05 — ścieżka `execute_native_cpu_modal_window_from_bloch_floquet_complex` przekazuje callbacki anulowania/postępu, zachowuje `artifact_sample_index` i attestation planera oraz publikuje `eigen/partial.v1.json` po przerwaniu; ukierunkowana kompilacja Rust i test parsera postępu przechodzą.
- `55a9c28be` — writer ścieżki rozróżnia jawny sweep `bias_field_samples` od próbek `k-path`/pojedynczego `k`; Gamma na ścieżce nie otrzymuje już przez przypadek identyfikatora `bias-field-sample-*`. Regresja sprawdza oba namespace'y w `spectrum.v2` i `spectrum.v3`.
- `6ce1ced8e` — jednokowy writer `write_eigen_v2_bundle` publikuje `sample_id` w `spectrum.v2` i `spectrum.v3`, wybierając namespace z planu zamiast oznaczać każdy wynik jako sweep pola; regresja provenance sprawdza `k-sample-0000`.
- `72645805b` — checkpoint doprecyzowuje rozdział namespace'ów artefaktów dla sweepu pola, ścieżki k i pojedynczego k.
- `43fbba45d` — dokumentacja fizyki i spec artefaktów zawierają indeksy obu bounded providerów demag-k oraz kontrakt nieprzezroczystych `sample_id`; walidator map źródeł został uruchomiony na bazie mastera.
- `41e80e534` — bounded MFEM bridge `floquet_airbox_operator`, test redukcji `CᴴP_fullC`/`CᴴAφq`, osobna recepta managed oraz regresja pinowania pojedynczego DOF w providerze Schura; źródła są zapisane, lecz kompilacja z MFEM pozostaje niezweryfikowana.
- `4336d8166` — fail-closed guard w `solve_modal_eigen_contract` blokuje wejście non-k0 Floquet do shared-domain i starszego Poisson-airbox K0; dwie regresje native sprawdzają oba wejścia.
- `d1f2ac9b3` — rozdzielenie reprezentacji `shifted_envelope`/`full_field_phase_constrained` w skalarnej assemblacji Floqueta oraz maskowanie powietrza i redukcja magnetycznych DOF w źródle; testy MFEM zapisane, wykonanie managed nadal oczekuje na poprawny runtime.
- `1894f09a8` — phase-aware Schur bridge redukuje także magnetyczne DOF przez `C_\phi^H A_{\phi q,full} C_q`, zachowując zgodność ze starszym wejściem już zredukowanym.
- `e2a7890c7` — producent shared-domain buduje na jednej siatce MFEM pełnopolowy operator skalarny, `C_\phi(k)`, źródło `A_{\phi q,full}` z maską magnetyczną i nodalnym `M_s` oraz `C_q(k)`; waliduje graf translacji, fazę `-k\cdot R`, kompletność klas i odrzuca niezerowe `k` bez par. To jest seam właściciela natywnego, bez podłączenia do runnera.

- `f2acf7b9b425733899bdfde63cb0566d16d74a59` — runner przekazuje accepted
  shared-domain handoff wraz z fazowym pencilem do produkcyjnego CPU, a
  `modal_eigen_solver` konsumuje go przez k-aware importer i dodaje bounded
  Schur `D(k)` w real-split do magnetycznego Hessianu. Integracja pozostaje
  ograniczona do `Full2x2 + Floquet + include_demag + nonzero-k + native CPU`;
  GPU, SLEPc/managed runtime i większy matrix-free owner są nadal zamknięte.

Adapter dynamicznego demag-k przyjmuje wyłącznie kompletną macierz dostarczoną
przez właściciela `A_{q\phi}(k)`/`P(k)`/`A_{\phi q}(k)`; aktualny bounded
provider buduje tę macierz z zaakceptowanego shared-domain payloadu tylko na
trasie native CPU. S04/S05 pozostają otwarte w zakresie skalowania i
kwalifikacji, a S08–S12 nadal wymagają realizacji.

Provider `floquet_dynamic_demag_k` domyka algebraiczny etap Schura dla małych
problemów walidacyjnych i zwraca `[[Re D,-Im D],[Im D,Re D]]`, gdzie
`D(k)=-A_{qφ}(k)P(k)^{-1}A_{φq}(k)`. Przyjmuje wyłącznie niezerowe,
finite `k`, nie maskuje osobliwości `P(k)`, a `pin_first_dof` jest jawny. Nie
ma jeszcze skalowalnego assemblera bloków na siatce MFEM ani dowodu pełnego
shared-domain modal runtime; poza podłączonym wariantem native CPU runner
pozostaje fail-closed dla non-k0 z demag-k.

W commicie `41e80e534` dodano bounded MFEM bridge
`assemble_floquet_airbox_dynamic_demag_k`. Bridge odczytuje zespolone bloki
`P_full(k)`, `C(k)` i `A_{φq,full}`, materializuje
`P(k)=CᴴP_fullC`, `A_{φq}(k)=CᴴA_{φq,full}` oraz jawne sprzężenie
`A_{qφ}=A_{φq}ᴴ`, a następnie deleguje eliminację do providera Schura. Ma
limit 512 DOF na blok i jeden budżet obejmujący macierze pośrednie, wynik oraz
LU/RHS providera; odrzuca nie-Hermitowskie lub niepełne bloki i nie publikuje
częściowego wyniku. Regresja z fazą `exp(-iπ/2)` sprawdza redukcję seamów i
realifikację wyniku. To nadal bounded oracle: nie jest assemblerem siatkowym,
nie zmienia capability planera i nie otwiera runnerowej ścieżki dynamicznego
demag-k.

Dodano również fail-closed guard na granicy `solve_modal_eigen_contract`: żądanie
Floquet z niezerowym `k` nie może wejść ani przez shared-domain importer, ani
przez starszy syntetyczny blok Poisson-airbox do rzeczywistej ścieżki K0. Guard
zwraca jawny status `unavailable`, wymagany przyszły operator
`bloch_floquet_airbox_shared_domain_operator` i stabilny powód
`nonzero_k_floquet_k0_poisson_path`. Dwie regresje C++ wywołują bezpośredni
native contract, aby sprawdzić oba wejścia. Nie otwiera to jeszcze produkcyjnej
assemblacji non-k0; usuwa tylko możliwość cichego policzenia non-k0 jako K0.

W commicie `d1f2ac9b3` rozdzielono dwie reprezentacje skalarnego problemu Blocha
we właścicielu MFEM. `shifted_envelope` zachowuje człony `k²` i sprzężone
konwekcje w operatorze obwiedni, natomiast
`full_field_phase_constrained` składa wyłącznie zwykłe pochodne; zależność od
`k` w tej drugiej reprezentacji może pochodzić tylko z osobnej macierzy fazowej
`C(k)`. Źródło `M_s δm → φ` przyjmuje teraz maskę elementów magnetycznych i
kompletną mapę klas magnetycznych DOF, redukując kolumny przed późniejszym
sprzężeniem fazowym. Dodano regresje dla braku przesuniętego bloku urojonego,
maskowania powietrza i redukcji klas. To usuwa mieszanie reprezentacji w
przyszłym assemblerze, ale nie podłącza jeszcze producenta `P(k)`,
`A_{qφ}(k)`, `A_{φq}(k)` do shared-domain ani nie otwiera ścieżki runnera.

W S09 dodano analogiczny, jawnie oddzielony provider 2.5D
`floquet_waveguide_demag_k`. Buduje on `P(k)=K⊥+k²M`, przyjmuje osobne
poprzeczne i osiowe sprzężenia `A_qphi`/`A_phiq`, zachowuje znak źródła `−ik
δM_z` w danych wejściowych i zwraca ten sam real-split Schur w przestrzeni
`[Re(q), Im(q)]`. Test kontraktu obejmuje wartość `k²`, granicę `k=0`, pinowanie
gauge oraz błędne kształty/budżet. Jest to bounded oracle dla algebry
falowodu, nie assembler siatki przekroju ani dowód otwartej granicy; kompilacja
i wykonanie testu pozostają **NOT VERIFIED** przez managed runner.

Dodano recepty managed dla tych kontraktów źródłowych:
`verify-fem-modal-floquet-magnetic-contract` uruchamia test operatora Blocha,
a `verify-fem-modal-floquet-airbox-cpu` uruchamia bridge oraz oba ograniczone providery
demag-k. Recepty korzystają z `ensure-managed-fem-runtime` i nie zmieniają
statusu fizycznej assemblacji ani kwalifikacji runtime. Na bieżącym hoście
runner nadal zwraca 503/profile mismatch przed utworzeniem joba, więc te
bramki pozostają **NOT VERIFIED**.

### Walidacja po domknięciu przyrostu

- `cmake -S native -B C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`: konfiguracja CMake zakończyła się exit 0 i wygenerowała nowy target bridge.
- Bezpośrednia kompilacja MSVC (`FULLMAG_HAS_MFEM_STACK=0`) dla `floquet_airbox_operator.cpp`, jego testu oraz providera `floquet_dynamic_demag_k` zakończyła się exit 0. Zlinkowany test `floquet_dynamic_demag_k_contract` zakończył się exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_tests::runner_rejects_floquet_dynamic_demag_gate --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox-cargo-target -- --nocapture`: 1 passed, exit 0; runner nadal odrzuca warianty bez podłączonego, certyfikowanego providera.
- Próba kompilacji bridge z `FULLMAG_HAS_MFEM_STACK=1` zatrzymała się na braku `mfem.hpp`; managed test `fem_floquet_airbox_operator_contract` nie został wykonany, więc implementacja MFEM pozostaje **NOT VERIFIED**.
- `cargo +nightly check --locked -p fullmag-ir -p fullmag-plan -p fullmag-runner --lib --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0; ostrzeżenia są istniejące lub dotyczą nieużytych elementów oczekujących na integrację.
- `cargo +nightly check --locked -p fullmag-cli --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target` oraz `cargo +nightly check --locked -p fullmag-runner --tests --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0.
- `cargo +nightly test --locked -p fullmag-ir --lib`: 101 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-ir --tests`: 101 unit + 229 integration tests passed, exit 0; `cargo +nightly test --locked -p fullmag-plan --lib`: 461 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib output_publication_tests`: 5 passed; `--lib tracking`: 13 passed, exit 0.
- Po dodaniu metryki masy FE `cargo +nightly test --locked -p fullmag-runner --lib tracking --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: 15 passed, exit 0.
- Po zmianie S05 `rustfmt +nightly --check crates/fullmag-runner/src/fem/eigen_native_window.rs crates/fullmag-runner/src/fem/eigen_execution.rs`: exit 0; `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_progress --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed, exit 0. Jest to dowód kompilacji i kontraktu callbacku, nie managed C++ ani physics qualification.
- Po poprawce namespace'ów `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib eigen::artifacts --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 41 passed, a `cargo +nightly test --locked -p fullmag-runner --lib eigen::orchestrator --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 3 passed. Ostrzeżenia pozostają istniejące lub dotyczą oczekujących integracji.
- Po poprawce jednokowego writer’a `cargo +nightly test --locked -p fullmag-runner --lib native_eigen_v2_mode_metadata_preserves_operator_provenance --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed. Kompilacja testu zakończyła się exit 0.
- Po dodaniu wierszy providerów do indeksów źródłowych `python .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base 5084a94ed14b151fc865e8def5a5c28401e98b44`: exit 0; `python -m pytest scripts/test_frequency_domain_math_contract_docs.py -q -p no:cacheprovider`: 9 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib eigen`: 226 passed, 1 failed. Jedyna porażka to istniejące `eigen::response_block_real::tests::field_driven_sweep_builds_artifact_ready_response_payload`, równość `1.0000000000000002` vs `1.0`; plik testu nie należy do tego przyrostu.
- Python: pełny `test_problem_ir.py` 26 passed; fokus API/IR dla eigensolve 35 passed; pełny `test_api.py` wykonał 277 passed i 19 failures środowiskowych (brak `h5py`/`zarr`, odmowa zapisu w lokalnym cache/worktree oraz `run_output`), bez błędu w fokusie eigensolve.
- Test kontraktu dokumentacji matematycznej: 9 passed. Walidatory source-map i `git diff --check`: exit 0.
- Próba nowego managed snapshotu nie utworzyła dodatkowego joba: runner zgłosił aktywny lock/storage dla rejestru `eigensolve-dispersion-plan-20260-c5dfad6d7f548079` i nakazał użyć istniejącego joba lub zaczekać. Najnowszy własny snapshot to job `b5200ded44964953a03491183dffaae1`, sequence 19, source digest `b59eadab5a1dd98e7b394403bd722bce864c81ea4d7659e24acd790f70853757`; ostatni odczyt pozostaje `queued` bez exit code. Nie uzyskano kompilacji C++ ani runtime dla bieżącego snapshotu.
- Bezpośrednia kompilacja MSVC testu kontraktu po dodaniu regresji routingu zakończyła się exit 0 z `FULLMAG_HAS_MFEM_STACK=0` i `/D_USE_MATH_DEFINES`. Kompilacja całego `modal_eigen_solver.cpp` w tym trybie nadal zatrzymuje się na istniejących typach shared-domain dostępnych wyłącznie z MFEM (`PoissonAirboxSharedDomainAssemblyResult`); nie jest to ścieżka kwalifikacyjna FEM. Pełny test z MFEM pozostaje **NOT VERIFIED**.
- Dla `d1f2ac9b3` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp` i `floquet_bloch_scalar_test.cpp`; zlinkowany test no-MFEM zakończył się exit 0. CMake skonfigurował target, lecz pełna biblioteka zatrzymała się na wcześniejszych błędach bazowych MSVC (`std::snprintf`, `__atomic_*`, brak pól Poisson w trybie bez MFEM), więc nie jest to dowód wykonania ciała MFEM. Managed test `verify-fem-frequency-domain-floquet-bloch-scalar` pozostaje **NOT VERIFIED**.
- Dla `e2a7890c7` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp`, `floquet_airbox_operator.cpp` i `floquet_airbox_operator_test.cpp`. Test MFEM zawiera ścieżkę sukcesu producenta, niespójnej fazy i braku par, ale na tym hoście ciało MFEM nie zostało wykonane. Pełny target CMake nadal zatrzymuje się na wcześniejszych błędach bazowych bez MFEM; managed test `fem_floquet_airbox_operator_contract` pozostaje **NOT VERIFIED**.
- Dla `f2acf7b9b425733899bdfde63cb0566d16d74a59` `rustfmt +nightly --edition 2021 --check` dla trzech zmienionych plików Rust zakończył się exit 0, `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/git/fullmag-eigensolve-cargo-target` zakończył się exit 0, a test `native_fem::frequency_domain::tests::production_shared_domain_request_accepts_only_the_certified_payload` zakończył się `1 passed`, exit 0.
- Próba `cargo +nightly check --locked -p fullmag-runner --lib --features fem-native --target-dir D:/git/fullmag-eigensolve-fem-native-target` zakończyła się exit 101 podczas budowania zależności native C++. Konfiguracja wygenerowała `FULLMAG_USE_MFEM_STACK=OFF`; log zatrzymuje się na istniejących błędach MSVC (`std::snprintf`, `__atomic_*`, `M_PI`, pola `Context::poisson_demag`) oraz na znanym ukryciu typów shared-domain bez MFEM. Źródła nowych `floquet_bloch_scalar.cpp` i `floquet_airbox_operator.cpp` zostały wykryte w przebiegu, lecz nie uzyskano managed receipt.
- Ponowiony target CMake `fem_floquet_airbox_operator_contract` w konfiguracji bez MFEM zakończył się exit 1 na tej samej bazowej serii błędów; dodatkowe błędy `modal_eigen_solver.cpp` wynikają z wyłączenia `FULLMAG_HAS_MFEM_STACK`, nie z kompilacji nowej gałęzi provider'a. Nie wykonano testu z MFEM.

Próba `just worktree-finish ... state=review` z aktualnym HEAD została
zatrzymana przez ten sam preflight (`Container runner owns heavy builds on this
host`). Rejestr pozostaje więc `active` z historycznym HEAD-em bazowym; nie
wykonywano ręcznej mutacji pliku ani obchodzenia blokady. Następny krok to
zwolnienie/rozliczenie dokładnego lease runnera, a potem ponowienie
`worktree-finish`.

Kontrolny odczyt `python scripts/local_runner_cli.py container-status` oraz
`status b5200ded44964953a03491183dffaae1` po ostatnim commicie zakończył się
exit 1 z komunikatem `Container profile allow-list mismatch`; nie utworzono
nowego joba i nie uzyskano dodatkowego receipt. Managed kompilacja C++/runtime
bieżącego worktree pozostaje zatem **NOT VERIFIED**.

Stan integracji pozostaje **W TRAKCIE**. Bounded provider `A_{q\phi}(k)`/
`P(k)`/`A_{\phi q}(k)` jest podłączony do natywnego właściciela CPU; otwarte
pozostają managed C++/SLEPc, skalowalny matrix-free owner, walidacja fizyczna,
PR oraz ścieżki Control Room/GPU.

### Aktualny przyrost integracyjny non-k0

W worktree domknięto granicę właścicieli dla pierwszego wariantu CPU. Runner
rozpoznaje plan `Full2x2 + Floquet + include_demag + nonzero-k` tylko przy
produkcyjnym native CPU, buduje zaakceptowany
`NativeModalEigenSharedDomainProblem` z handoffu równowagi i przekazuje go
razem z fazowymi macierzami magnetycznymi. Natywny solver C++ używa wtedy
rozszerzonego importera shared-domain: z tej samej siatki i markerów domeny
składa pełnopolowy `P(k)`, `C_\phi(k)`, `A_{\phi q,full}(k)` oraz `C_q(k)`,
wylicza przez Schura `D(k)=-A_{q\phi}(k)P(k)^{-1}A_{\phi q}(k)` i dodaje
realifikację do magnetycznego Hessianu. Flaga `k=0` nie może wejść do tej
gałęzi, a GPU i inne kombinacje pozostają fail-closed.

Ten przyrost ma test kontraktu Rust i kompilację źródeł/targetów bez MFEM.
Pełny build `fem-native` został uruchomiony, ale zakończył się na znanych
problemach konfiguracji hosta (`FULLMAG_USE_MFEM_STACK=OFF`, brak działającego
managed MFEM/SLEPc oraz wcześniejsze błędy MSVC w CUDA/Context); nie jest to
receipt wykonania operatora. Managed runtime, wynik fizyczny `f(k)`, artefakty,
API/UI i GPU nadal mają status **NOT VERIFIED**.

### Przyrost S09 — assembler przekroju 2.5D

Dodano `floquet_waveguide_cross_section`: bounded element-level P1 assembler
dla trójkątnego przekroju 2D. Assembler składa `K_perp`, `M`, jawny warunek
Robin, sprzężenia `A_phiq_perp`/`A_phiq_axial` z maską domeny magnetycznej i
lokalnym `M_s`, a następnie wyprowadza blok sprzężony przez hermitowskie
sprzężenie zwrotne. Wszystkie macierze są skalowane przez odwrotność jawnego
`normalization_length_m`, więc wynik ma normę na jednostkę długości. Jest to
referencyjny właściciel elementowy, nie deklaracja managed MFEM assemblacji ani
dowód zbieżności otwartej granicy.

Izolowany projekt MSVC z assemblerem, providerem Schura i testem kontraktu
skonfigurował się (exit 0), zbudował (exit 0), a wykonanie zakończyło się
`floquet waveguide cross-section contract tests passed` (exit 0). Test
sprawdza macierze masy/stiffness, długość brzegu Robin, znak źródła `-i k M_z`,
sprzężenie hermitowskie, odrzucenie wadliwej mapy oraz przejście przez
real-split Schur. Pełny target `fullmag_fem` nadal zatrzymuje się na
wcześniejszych błędach bez MFEM; nowy plik został w tym przebiegu
przetworzony przez MSBuild bez własnych błędów.

### Przyrost routingu planera dla non-k0

Commit `8d266d778` otwiera w plannerze wąską, jawnie opisaną kombinację
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson`.
Warunki wykonania są strict, double precision i CPU; ścieżki z GPU, innym
warunkiem magnetostatycznym albo inną reprezentacją operatora pozostają
fail-closed. Ścieżka może zawierać Γ: orchestrator materializuje próbkę Γ jako
`Periodic` z istniejącym K0 shared-domain, a punkty niezerowe pozostają w
Floquet Schur. Dla `auto` dispatch przypina tę kombinację do CPU, aby
dostępność GPU w rejestrze nie wybrała nieobsługiwanej realizacji. Planner
publikuje notę provenance o bounded CPU Poisson-airbox Schur providerze.

Weryfikacja tego przyrostu:

- test planera `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path` — `1 passed`, exit 0;
- pełny `fullmag-plan --lib` — `461 passed`, exit 0;
- testy runnera ścieżki non-k0 — `4 passed`, exit 0;
- `runner_rejects_floquet_dynamic_demag_gate` — `1 passed`, exit 0;
- `fem_eigen_path_rejects_floquet_dynamic_demag_before_sample_solves` — `1 passed`, exit 0;
- `git diff --check` i ukierunkowany `rustfmt --check` — exit 0.

### Przyrost zgodności materiałowej shared-domain

Commit `c511cb413` otwiera nodalne `Ms` w bounded CPU providerze. Natywny
descriptor już przenosi pełny wektor `saturation_magnetisation_a_per_m`, więc
runner nie odrzuca go przed assemblacją; digest wejścia operatora obejmuje teraz
zarówno wektor nodalny, jak i wartość uniform fallback. Certyfikat okresowości
pozostaje obowiązkowy: wartości `Ms` na sparowanych seamach muszą być zgodne.

Regresje `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path`
(`fullmag-plan`) oraz `shared_domain_builder_rejects_missing_accepted_linearization_state`
i `native_cpu_modal_window_accepts_nonzero_floquet_airbox_demag_path`
(`fullmag-runner`) przeszły; szerokie przebiegi dały odpowiednio `461/461` i
`142/142` testów, exit 0. Nodalne `Aex`, anizotropia, DMI i damping nadal są
jawnie poza tym bounded wariantem.

To jest bramka planowania i routingu, a nie kwalifikacja fizyczna. Nadal brak
managed MFEM/SLEPc receipt, wykonania operatora na siatce, residuali
oryginalnego układu, zbieżności paddingu oraz porównania COMSOL/TetraX. Damping
i GPU pozostają poza otwartym wariantem. Worktree pozostaje
niezintegrowany z `master`; push/PR/merge są zablokowane przez brak poprawnego
uwierzytelnienia GitHub i wcześniejszą odmowę automatycznego review.

### Przyrost dokładnej rozdzielczości wykonania non-k0 — `e3fa509db`

Wprowadzono osobny token `floquet_airbox_cpu_schur_slepc` w `FemEigenEngineIR`.
Planner nadaje go wyłącznie ścisłemu, podwójnej precyzji wariantowi
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson` i
publikuje rozróżnienie żądania urządzenia, urządzenia rozwiązanego, fallbacku
oraz przyczyny wyboru. Jawne GPU, GPU z runtime override i nieznany fallback są
odrzucane; `auto` może zapisać tylko udokumentowany fallback GPU→CPU dla tej
samej fizyki. Runner sprawdza zgodność silnika z zakresem planu i nie pozwala
użyć dynamicznego tokenu dla zwykłego K0. Punkt Γ na ścieżce może zachować
top-level Floquet resolution, ale wykonuje się przez certyfikowany alias K0.

W natywnym solverze C++ naprawiono granicę właścicieli: wynik bounded
shared-domain providera `D(k)` jest przekazywany do `effective_request`, a ten
sam envelope trafia do adaptera dense SLEPc, digestu pencila i diagnostyki.
Kompletny dostarczony dynamiczny payload również otrzymuje osobny engine ID,
więc nie może zostać opisany jako ogólny `production_cpu_modal_eigen_unavailable`.
Regresja C++ została rozszerzona o tę asercję; nie wykonano jej na tym hoście,
ponieważ repozytoryjna recepta zatrzymuje się w preflight z
`Container profile allow-list mismatch`.

Dowody źródłowe tego przyrostu:

- `cargo +nightly check --locked -p fullmag-plan -p fullmag-runner -p fullmag-ir` — exit 0;
- `cargo +nightly test --locked -p fullmag-ir --lib` — `102 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-plan --lib` — `461 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-runner fem::eigen_tests --lib` — `142 passed`, exit 0;
- ukierunkowane testy dynamicznego engine/attestation — `3 passed`, exit 0;
- ukierunkowany `rustfmt --check` i `git diff --check` — exit 0.

Brama `just verify-fem-modal-floquet-airbox-cpu` nie doszła do kompilacji C++:
`ensure-managed-fem-runtime` wymaga ścieżki zarządzanego build runnera, a
`python scripts/local_runner_cli.py container-status` zwraca
`local-runner: Container profile allow-list mismatch`. Brak receiptu oznacza,
że managed MFEM/SLEPc, wykonanie na rzeczywistej siatce, residuale, zbieżność
paddingu/warunku otwartego oraz porównanie liczbowe z COMSOL/TetraX nadal mają
status **NOT VERIFIED**. Nie wykonano push/PR/merge ani usunięcia worktree.

### Przyrost właściciela solvera Floquet dense/sparse — `80736831e`

Dodano jawny moduł `cpu/frequency_domain/modal/floquet_modal_solver.*` jako
granicę między fazowo zredukowanym operatorem Blocha a adapterem SLEPc. Moduł
sprawdza finite, niezerowy trójwymiarowy wektor `k`, warunek Floquet, komplet
par periodycznych, marker zaakceptowanego operatora oraz obecność
realifikowanego pencila. Wymuszona ścieżka GPU jest odrzucana bez fallbacku.
Dense CPU z dynamicznym demag-k wymaga payloadu real-split, a sparse CSR bez
demag-k ma osobną funkcję admission i routing; sparse z demag-k jest odrzucany
ze stabilnym powodem i kierowany do właściciela dense Schura. Obie ścieżki są
wywoływane z produkcyjnego adaptera zamiast ogólnego wejścia K0.

Dodano target `fem_floquet_modal_solver_contract` oraz regresje dla poprawnego
non-k0 CPU, braku payloadu demag-k, wymuszonego GPU, zerowego `k`, braku seamów,
poprawnego sparse CSR i odrzucenia sparse+demag. Bezpośrednia kompilacja MSVC
z `FULLMAG_HAS_MFEM_STACK=0` dla nowego modułu, testu, adaptera produkcyjnego,
adaptera SLEPc i kinematyki zakończyła się exit 0; zlinkowany i uruchomiony
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód źródłowy i
izolowany test kontraktu, nie managed MFEM/SLEPc ani dowód fizycznego `f(k)`.

Pełny `cargo +nightly check --features build-native` ponownie zatrzymał się na
znanych błędach bazowych konfiguracji bez MFEM (`Context::poisson_demag`,
`mkdir`, typy shared-domain); nowe pliki nie zgłosiły własnych błędów w tym
przebiegu. Brama `just verify-fem-modal-floquet-airbox-cpu` nadal zatrzymuje
się przed kompilacją przez `Container profile allow-list mismatch`. Managed
receipt, residual po rekonstrukcji potencjału, zbieżność, porównania COMSOL/
TetraX, UI, GPU oraz PR pozostają **NOT VERIFIED**.

### Walidacja payloadu właściciela Floquet — `de72a5b1f`

Właściciel dense sprawdza teraz rozmiar `n×n` i skończoność real-split
dynamicznego demag-k względem wymiaru pencila; sparse CSR ma analogiczną
walidację kształtu, offsetów, indeksów i wartości. Diagnostyka produkcyjna
rozróżnia model Floquet sparse od ogólnego sparse SLEPc. Regresje obejmują
niepełny i nie-skończony payload dense oraz przyjęcie poprawnego sparse bez
demag-k.

Ponowiona kompilacja MSVC i uruchomienie izolowanego testu kontraktu zakończyły
się exit 0; zmodyfikowany adapter produkcyjny także skompilował się exit 0.
Przyrost nie zmienia granicy kwalifikacji: managed MFEM/SLEPc, fizyczny
residual, zbieżność, porównania COMSOL/TetraX, UI i GPU są nadal **NOT VERIFIED**.

### Konwencja fazy i okno częstotliwości w handoffie SLEPc — `bed355f41`

Produkcja przekazuje teraz `ModalEigenRequest.phase_convention` do wszystkich
czterech konstrukcji żądania SLEPc: dense nearest, dense window, sparse nearest
i sparse window. Wewnętrzny request CSR ma ten sam jawny token i propaguje go do
wspólnego adaptera, więc `exp(+iωt)` oraz `exp(-iωt)` nie są przypadkiem
zamieniane przez wartość domyślną. Właściciel Floqueta odrzuca także ujemne,
nieskończone i odwrócone okna; `(0,0)` pozostaje jawnie rozpoznanym trybem bez
okna, a dodatnie `max > min` jest oznaczane jako wybrane okno.

Regresje obejmują odwrócone i ujemne okno oraz poprawne okno finite; bezpośrednia
kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` dla właściciela, testu, adaptera
SLEPc i adaptera produkcyjnego zakończyła się exit 0, a zlinkowany
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód kontraktu
źródłowego; managed SLEPc, residual, fizyczne `f(k)`, porównania COMSOL/TetraX,
UI, GPU i integracja PR pozostają **NOT VERIFIED**.

### Rozdzielenie assemblacji dynamicznego Floqueta od K0 — `2e8362463`

Importer `assemble_poisson_airbox_shared_domain_payload` rozpoznaje teraz
dynamiczny wariant wyłącznie wtedy, gdy jednocześnie dostaje wektor `k` oraz
osobny wynik `FloquetAirboxDynamicDemagKResult`. Niepełny handoff, niefinite lub
zerowy `k` oraz brak par periodycznych kończą się stabilnym błędem walidacji.
W wariancie non-k0 importer pomija assemblację legacy K0 i buduje tylko cztery
bloki fazowe oraz ograniczony Schur `D(k)`; wynik oznacza się jako
`floquet_dynamic_demag_k`, aby pustych macierzy K0 nie można było odczytać jako
udanej assemblacji. Wywołanie bez argumentów Floqueta zachowuje dotychczasową
ścieżkę K0.

Zmiana jest zapisana w `2e8362463` i przechodzi `git diff --check`; pełny test
ciała MFEM nie został wykonany, ponieważ managed runner nadal odrzuca profil
(`Container profile allow-list mismatch`), a host nie ma nagłówków MFEM. Wobec
tego managed wykonanie, residual, zbieżność fizyczna, porównania COMSOL/TetraX,
UI, GPU i kwalifikacja wydania pozostają **NOT VERIFIED**.

### Spójność dwóch źródeł wektora Floqueta — `beca34bb0`

Właściciel modalny odrzuca teraz request, w którym legacy
`operator_request.k_vector_rad_m` i append-only `floquet_k_vector_rad_per_m`
opisują różne wartości albo niepełny wymiar. Gdy obecne jest tylko jedno źródło,
pozostaje ono legalnym nośnikiem trójwymiarowego `k`; oba źródła są wymagane do
zgodności, gdy zostały dostarczone jednocześnie. Stabilny powód
`floquet_modal_k_vector_payload_mismatch` chroni przed zmianą fazy bez zmiany
identyfikatora próbki.

Regresja konfliktu przechodzi w izolowanym `floquet_modal_solver_test.exe`
(MSVC, `FULLMAG_HAS_MFEM_STACK=0`), a kompilacja właściciela, adapterów i testu
kończy się exit 0. Managed MFEM/SLEPc, residual, fizyczne `f(k)` i pozostałe
bramki S04–S12 są nadal **NOT VERIFIED**.


### R01 — naprawa LU po audycie

Wykonano permutacje RHS przed podstawianiem z finalnym L. Nowa regresja
3×3 wymusza dwa pivoty i testuje zespolone multiple RHS oraz niezależny
Schur oracle. Natywny MSVC: RED exit 1 przed zmianą, GREEN exit 0 po zmianie
wraz ze wszystkimi wcześniejszymi testami pliku. Managed bramka nadal
kończy się przed kompilacją przez politykę kolejki runnera. R01 jest
naprawione źródłowo; managed potwierdzenie oraz R02 pozostają otwarte.

### R02 — certyfikacja bloku potencjału, częściowo

Provider odrzuca residual powyżej 1e-8 i sprawdza oryginalny wiersz pinowania.
Test obejmuje niezgodny RHS, niezerowy residual oraz brak publikacji outputu;
cały izolowany test C++ providera zakończył się exit 0. Zmieniono importer,
aby zachować certyfikat w diagnostics/result JSON, jawnie bez certyfikowania
pełnego modu. Ta część MFEM pozostaje nieskompilowana przez zablokowaną
managed trasę. Source-map validator noty 0828 i diff check: exit 0.
R02 nie jest zamknięte: S05.R02/full descriptor V9 i managed evidence otwarte.

### S05.R02 — fundament rekonstrukcji potencjału

Dodano owned FloquetPotentialReconstruction w wyniku bridge i natywny
reconstruct_floquet_potential. Zachowuje P/A_phiq/A_qphi i odtwarza
kompleksowy potencjał z oryginalnym residualem obejmującym pinned row.
Cały izolowany test MSVC exit 0: manufactured complex q, dwa pivoty,
zgodny gauge, odrzucenie niezgodnego źródła i brak starego pola po błędzie.
Nie podłączono jeszcze do wektorów SLEPc ani publikacji pól; magnetyczny
residual oraz Bloch BC nie są certyfikowane. S05.R02/V9 nadal OTWARTE.


### Aktualizacja S05.R02 — integracja dense SLEPc

Podłączono rekonstrukcję do nearest/window i każdego zwróconego modu.
Kontrola używa oryginalnego stiffness, sprzężeń i masy, a nie wyłącznie
macierzy Schura. Natywny JSON przenosi podwojony zespolony potencjał oraz
osobne residuale magnetyczny/potencjału. Błędny descriptor odrzuca solve.
Contour z kontekstem rekonstrukcji jest fail-closed. Izolowane testy providera
przechodzą (exit 0), adapter production_cpu_modal_eigen.cpp kompiluje się
MSVC bez MFEM (exit 0). To nie jest wykonanie SLEPc ani końcowa kwalifikacja.
Nadal do wykonania: geometryczne BC/pełna siatka, binary publikacja potencjału
przez runner, contour i managed/physics V9. R02 pozostaje częściowe.

### R03/R05 — naprawa pokrycia recepty i wznowienie rejestru

Na bazie 71a98514c410ebac82a610ccc2a17ff172533a23 rozszerzono managed recipe
do siedmiu kontraktów Floquet, ustawiono CPU realization i oddzielny CMake
build directory, poprawiono czas życia LD_LIBRARY_PATH dla wszystkich testów.
`just --show`, Bash syntax i porównanie targetów z CMake: PASS (7/7).
Nie uruchomiono jeszcze kompilacji w kolejce; receipt i fizyka pozostają otwarte.
Oficjalny resolver register: exit 0, poprawny pełny SHA i aktywny właściciel.

### R03 — commit oraz S08.R06 — wybór punktu dyspersji

Naprawę recepty i stan rejestru zapisano w
`92f272681ece6479d2e3ea51e531c533c086e2d7` (just/Bash/target coverage PASS).
Następnie naprawiono utratę k/ID/rewizji w parserze i dwóch ścieżkach
selekcji UI. Regresje RED→GREEN; trzy pliki Vitest: 115 passed.
Instalację 771 zależności wykonano offline w resolverowym frontend storage
z dokładnych manifestów i lockfile; instalator przez junction worktree
wcześniej kończył się ENOTDIR. Nie kopiowano zależności innego worktree.
Runtime, browser/FMS i pełne zamknięcie S08 nadal otwarte.

Dodatkowe kontrole R06: typecheck, API hygiene i architecture hygiene exit 0.
Lokalny react-doctor 0.9.12: cztery zmienione pliki, brak ustaleń, exit 0.
Logi i manifest kontroli są w resolverowym frontend storage zadania.

### S04.R07 — zachowanie tolerancji faktoryzacji

R06 UI zapisano jako `5331dc5c866266b8c67c96097d0b6afb4d9d3d43`.
Następnie poprawiono niespójny pivot tolerance Schur→rekonstrukcja.
Małoskalowy oracle P=1e-15: MSVC RED→GREEN, wszystkie testy pliku providera
exit 0. Dodatkowy bridge test wymaga MFEM i pozostaje niewykonany.
Source-map validator 0828 exit 0; pierwsze wywołanie omyłkowej ścieżki
scripts/validate_scientific_docs.py nie uruchomiło walidatora.
Diagnostyka C++ zapisana w resolverowym windows-native/floquet-potential-contract.

### R06b — brak danych CSV nie oznacza zera

Dodatkowa regresja wykryła konwersję pustych komórek CSV do zera oraz
obcinanie niecałkowitego indeksu modu. Parser dyspersji odróżnia teraz brak
k/residualu/linewidth od liczby zero i odrzuca wiersze z brakującymi lub
niepoprawnymi indeksami/częstotliwością/ścieżką. RED: cztery wiersze zamiast
jednego; GREEN: 116 testów w trzech plikach Vitest. Nie zmieniono
fizycznych tolerancji ani nie uzupełniano danych arbitralnymi wartościami.


### Referencja COMSOL — przepis dla operatora, 2026-09-13

Użytkownik nie ma dotychczas wyników COMSOL/TetraX i zadeklarował wykonanie
nowej symulacji. Zapisano kompletny przepis
[comsol-nonzero-k-dispersion-benchmark](../../guides/comsol-nonzero-k-dispersion-benchmark.md),
parametry SI oraz 61 punktów Γ–X–M–Γ. Model A1: film Permalloy
200×200×10 nm, otwór kołowy r=50 nm, μ0H=0.1 T w +x,
alpha eigen=0, skończony airbox z Dirichlet w z i periodycznością x/y.
Dynamiczny demag opisano przez periodyczną obwiednię potencjału; fazor
magnetyzacji zachowuje Floquet exp(-ik·r). Dwa testy kontrolne filmu
i eksport zespolonych pól poprzedzają pełny benchmark.
Sprawdzono stałe, jednostki, 61 punktów i znaki transformacji;
wykonanie COMSOL i wyniki porównania pozostają NOT VERIFIED.
Brak danych jest teraz zadaniem oczekującym na pomiar operatora,
a nie podstawą do deklarowania ukończonej walidacji naukowej.


### Aktualizacja 2026-09-13 — najnowszy obraz UI i wynik joba 41

Aktywny wcześniej job `cdc83e275b9948628fd968b8e9b783cf` zakończył się
terminalnie z `exit_code=2`. CMake i target
`fem_poisson_airbox_modal_eigen_slepc_contract` zbudowały się, lecz drugi
target (`fem_floquet_magnetic_operator_contract`) nie zlinkował się, ponieważ
`/opt/fullmag-deps/lib/libceed.so` wymagał symboli sterownika CUDA (`cu*`).
Receipt `artifacts/contracts/slepc-modal/result.json` ma `status=fail`,
`ctest_completed=false`, a więc nie jest dowodem wykonania żadnego kontraktu.

Źródłową przyczynę poprawiono w commicie `377230523`:
`add_fem_source_facade_contract` dołącza bibliotekę CUDA compatibility do
każdego targetu korzystającego z `fullmag_fem`, a nie tylko do targetu modalnego.
Poprawka nie ma jeszcze świeżego managed builda, więc pozostaje
**NOT VERIFIED**.

Koordynator został po zakończeniu joba kontrolowanie podmieniony na najnowszy
obraz `sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`;
kontener `20601ed2d46245996ba5768f5aa408af50e25266c6562fc447bebc311becf90b`
działa na porcie 8765. Health z autoryzowanym odczytem potwierdza
`worker_alive=true`, `accepting_jobs=true`, pustą kolejkę i obecność profilu
`fem-cpu-slepc-modal-v1`. Publiczny `/ui/` zwraca HTTP 200 z tytułem
„Fullmag Build Runner — Panel Operacyjny”; publiczny
`/api/v1/auth/session` zwraca `authenticated=false`; chronione `/health`,
`/api/v1/auth/session` i `/api/v1/overview` działają z tokenem, a bez tokenu
`/health` nadal prawidłowo odrzuca żądanie HTTP 401. Problem `unauthorized`
był skutkiem starego obrazu bez UI i został usunięty bez wyłączenia ochrony API.

Obecne granice dowodu są niezmienione: nie wykonano jeszcze C0/C1/A1,
61 punktów Γ–X–M–Γ ani porównania z COMSOL/TetraX. Ponowne zgłoszenie
managed joba z commitem `377230523` wymaga osobnej zgody z powodu aktywnej
reguły automatycznego przeglądu dotyczącej budowania testów.

### Aktualizacja 2026-09-15 — pierwszy natywny przebieg C0 i korekta kroku

Managed runtime `fem-cpu-slepc-runtime-v1` z commitem
`be546257895a89733f6ce81162fc1f4073a5fb6a` zakończył się poprawnie (`exit_code=0`),
a receipt i attestation potwierdziły dostępność natywnego FEM CPU/SLEPc w double
precision. Pierwszy przebieg C0 przeszedł do materializacji siatki, ale został
odrzucony przez bramkę stabilności: dla siatki 614333 tetraedrów limit wymiany
wyniósł `9.363104e-15 s`, podczas gdy kontrakt żądał `dt_s=1.0e-14 s`.
Nie powstał więc artefakt częstotliwości.

`RELAX_DT_S` zmieniono na `5.0e-15 s`, z zachowaniem jawnego `rk23` i ścisłego
trybu CPU. Następny krok to nowy managed build z tą zmianą i ponowne C0;
częstotliwość, wykres oraz kwalifikacja naukowa pozostają **NOT VERIFIED** do
czasu odczytu niepustych artefaktów solvera.


### Aktualizacja 2026-09-15 — jawna polityka solvera modalnego

Dodano `FemEigenSolverPolicyIR` oraz mapowanie `runtime_metadata.modal_solver_policy`
do natywnego adaptera PETSc/SLEPc. Brak polityki zachowuje natywne domyślne
wartości; runner nie nakłada już ukrytych limitów `300/1000`. Żądane limity,
tolerancja i rozwiązane przez EPS/KSP limity są rozdzielone w diagnostyce.
Walidacja odrzuca wartości zerowe i przekraczające natywny zakres `i32`.

Zmiana jest w bieżącym worktree i wymaga osobnego managed builda; aktywny job
`56a8e337581144899a91d90274d43ee5` buduje wcześniejszy czysty commit
`20d6ae76f8bac504a835a791d205e0e2494a3bea`, więc nie stanowi jeszcze dowodu
dla tej poprawki. Dopóki ten build się nie zakończy, nie ma nowego binarium
do uruchomienia C0. Po jego zakończeniu pozostają: ponowny C0 po korekcie
`RELAX_DT_S=5e-15`, następnie C1 i A1, niepuste artefakty solvera, bramka
61 próbek/8 gałęzi, zgodność Kittel/KS oraz zbieżność siatki, airboxa i liczby
modów.

### Aktualizacja 2026-09-16 — rozdzielenie C0, C1-Γ i pełnej dyspersji

Ten wpis zastępuje wcześniejsze statusy odnoszące się do starszych SHA i
starszych jobów. Bieżący checkout to worktree
`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912`, gałąź
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`a7723cf0b3dd179f32da5294dbda8dcd685b6e14`. Worktree zawiera również
niezależne, niezatwierdzone zmiany innych etapów; nie są one dowodem ani
przedmiotem tego checkpointu.

| Warstwa | Stan bieżący | Dowód i ograniczenie |
|---|---|---|
| Rozdzielenie analityki od solve | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | `eigen_path.rs` uruchamia natywny solve dla `dispersion_validation`; analityczna częstość jest dopisywana po solve. Jawny syntetyczny K0 jest odrzucony, gdy żądany jest benchmark dyspersji. |
| P00 i ciągłość $k\to0$ | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | Python i Rust używają stabilnego rozwinięcia dla małego $|k|t$ oraz `expm1`; istnieją testy ciągłości referencji. |
| Zakres C1 | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | Planner nie narzuca już `3e6` ani `5e9`; zakres benchmarku C1 może jawnie użyć `pi/(200e-9)` i `15e9`. |
| Analityka po dowolnym kącie | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | CSV przechowuje `analytic_frequency_hz`, `relative_error` i `validation_geometry` dla BV, DE oraz odcinków ukośnych; bramka przelicza je z eksportowanego wektora `k`. |
| Bramka naukowa | **ZAIMPLEMENTOWANE ŹRÓDŁOWO; NIEZWERYFIKOWANA RUNTIME** | Gate wymaga 61 próbek, 8 gałęzi, Kittel/KS, pól, residuali i zbieżności; porównanie fundamentalnej gałęzi C1 obejmuje wszystkie próbki. Fixture testowy został dostosowany do ścieżki kątowej. |
| C0 bez demagu | **WYKONANE DIAGNOSTYCZNIE** | Natywny wynik `2.8002642129151187 GHz` zgadza się z kontrolą Kittela bez demagu do około `3e-15` względnie. To nie jest dowód operatora dynamicznego demagu. |
| C1, Γ z demagiem | **WYKONANE DIAGNOSTYCZNIE; NIEZAKWALIFIKOWANE** | Preview z 391 węzłami, jedną warstwą po grubości i około `1 µm` airboxa dał `8.9065823815 GHz`, residual `1.05e-15`; analityka otwartego filmu daje `9.3098137114 GHz`. Różnica `−4.331%` jest obciążona skończonym airboxem i coarse siatką. |
| C1, $k\ne0$ | **BLOKADA W STARYM BINARIUM** | Próba X zakończyła się jawnym `production_cpu_modal_nonzero_k_floquet_operator_missing`; trzeba zbudować świeży managed obraz z aktualnych źródeł. |
| Kwalifikacja fizyczna / release | **NOT VERIFIED** | Nie ma jeszcze świeżego, pełnego C0/C1/A1 z aktualnym binarium, zbieżnością i pustą listą powodów bramki. |

#### Interpretacja obecnego wykresu

Wykres z preview miesza trzy różne modele. `2.800264 GHz` należy do C0 bez
dynamicznego demagu. `9.309814 GHz` to otwarty-filmowy limit analityczny C1 w
$\Gamma$. `8.906582 GHz` to natywny C1 z periodycznym, skończonym airboxem na
siatce diagnostycznej. Zgodność C0 sprawdza jednostki, znak i skalę operatora
bez demagu; nie sprawdza jeszcze jądra dynamicznej demagnetyzacji, wpływu
airboxa, rozdzielczości po grubości ani operatora Floqueta dla $k\ne0$.
Obecny obraz należy traktować jako diagnostyczny, a nie jako wykres
„analityka kontra numeryka” dla jednego i tego samego problemu.

Odwrócenie liczby `8.906582 GHz` przez skalarne równanie Kittela daje
$N_z\approx0.906821$. W modelu kontrolnym
$N_z=1-t/(t+2d)$ odpowiada to $d\approx48.7\,\mathrm{nm}$, a $d=50\,\mathrm{nm}$
daje $8.916623\,\mathrm{GHz}$. Kanoniczne C1 ma $d=2\,\mu\mathrm{m}$,
$N_z\approx0.997506$ i przewidywane $9.299250\,\mathrm{GHz}$ dla skończonego
airboxa. Stary preview należy zatem traktować jako artefakt o nieustalonej
geometrii normalnej lub zbyt grubej dyskretyzacji, mimo małego residualu.
Pierwszy krok diagnostyki C1 to porównanie rzeczywistych `DomainFrameIR`
`mesh_bounds` z deklarowanym paddingiem; dopiero potem rozdzielamy błąd
airboxa od błędu liczby warstw i assemblacji demagu.

#### Następne kroki

1. Zbudować świeży managed runtime z bieżącego checkoutu i ponowić C0 jako
   kontrolę regresji.
2. Uruchomić C1 w $\Gamma$ na co najmniej trzech siatkach, trzech airboxach
   i z kontrolą liczby warstw po grubości; dopiero ich granica może być
   porównana z otwartym-filmowym KS.
3. Uruchomić kilka punktów $k\ne0$ na aktualnym operatorze Floqueta i zapisać
   pełne CSV z rozróżnieniem BV/DE/oblique.
4. Dopiero po uzyskaniu niepustych artefaktów i przejściu gate oznaczyć B4–B6
   jako zweryfikowane fizycznie.

#### Kontynuacja po kontroli runnera — 2026-09-17

Ponowne sprawdzenie nie uruchomiło nowego buildu: `runner-container-status` i
`runner-doctor` nie uzyskały odpowiedzi od koordynatora Docker Desktop, a
`C:\git\fullmag\storage` znajduje się na dysku z zerową ilością wolnego
miejsca. Job `0524d64f5e07432387b09a356da5ba89` pozostaje `queued` i nie jest
dowodem dla bieżącego snapshotu. Nie wykonano prune ani usuwania artefaktów.

Pakiet lekkich kontroli kontraktowych dla adaptera SLEPc, bridge'a Floquet i
orchestratora przeszedł **15 testów**. Pełny test fixture'a bramki naukowej
nie mógł zapisać dużych danych C1/A1 i zakończył się błędem systemowym
`[Errno 28] No space left on device`; nie jest to wynik fizyki ani regresja
walidatora. T4–T7, natywny solve, punkty DE i wykres pozostają `NOT VERIFIED`.
