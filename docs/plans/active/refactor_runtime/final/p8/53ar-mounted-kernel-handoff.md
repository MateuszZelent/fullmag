# P8-53AR — pauza i wymiana zamontowanego kernela

## Zakres i własność

`DevelopmentKernelHost` jest właścicielem kolejnych generacji zamontowanego
kernela. `KernelApi` zawiera jego niezmienną referencję jako usługę;
React context nie przejmuje sceny, sesji, formularzy ani danych viewportu.
Snapshot hosta zawiera kernel/generation/paused i błąd publikacji, bez kopii
modelu czy szkiców. Model nadal pochodzi z zasobów API; dokument, formularze
i layout pozostają przy swoich właścicielach z P8-53AQ.

Pauza zachowuje zamontowane dzieci, lokalne formularze i stan kamery. Przed
przejęciem odrzuca aktywne polecenia, operacje API obejmujące parsing/decode,
zapis lub niesynchronizowane zmiany kamery/wizualizacji. Nie przerywa wysłanej
mutacji i nie interpretuje anulowania klienta jako niepublikacji serwera.
Resource store zatrzymuje odczyty dokładnie klienta starego kernela; po
wycofaniu lub zwolnieniu pauzy owner invaliduje swoje zasoby, aby przerwany
odczyt nie pozostał zawieszony bez nowej obserwacji.

Transport ma zliczane lease i osobne trwałe retirement. Przy pauzie dopuszcza
wyłącznie dokładny GET statusu development-backend, bearer-bound POST intentu
i token-bound GET tego intentu. Po retirement dopuszcza tylko token-bound
status. Sprawdzenie obejmuje admission przed requestem i przed kolejną próbą
GET. Zwykłe wywołania fasady pozostają liczone przez całe parsowanie body
i dekodowanie binarne; generated transport również trzyma licznik podczas
parsowania OpenAPI. Bezpośrednie, nieobsługiwane wywołanie prywatnego helpera
zwracającego raw Response nie obejmuje dowolnej późniejszej pracy caller’a.

## Granica React i publikacja

Pauza blokuje registry poleceń oraz synchronizatory. Realtime connector nie
emituje `idle` przy zamykaniu na potrzeby pauzy ani ze starej generacji po
wymianie. To nie jest zmiana sesji: nie czyści PendingForms/historii.
Kamera zatrzymuje timer/listenery bez tymczasowego `setSessionScopeKey(null)`.
Główny panel używa `inert`; registry i transport są dodatkową granicą także
dla portali poza nim.

Nowy kernel powstaje z jawnym pinem nowego API i odrębnymi controllerami,
registry oraz cache namespace. Hydration dokumentu/layoutu poprzedza jego
publikację. Przed publikacją nowy registry jest chroniony; na czas mountu
chronione są też jego transport i zasoby. Provider odmontowuje starą generację
przez klucz, a passive effect potwierdza zakończenie starych cleanupów i nowy
mount. Dopiero wtedy aktualizuje URL, trwale retire’uje stary klient,
zwalnia blokady nowego i potwierdza publikację.

Aktualizacja URL wymaga dokładnego starego albo już zatwierdzonego nowego
UUID; obcy lub brakujący pin i duplikaty są odrzucane. Zachowuje pozostałe
query i fragment. Błąd commit navigation odrzuca publikację raz, pozostawia
blokady oraz wyświetla komunikat w bannerze. Nie udaje gotowej hydration.

Review wykrył początkowy brak blokady registry nowego kernela: zachowany
stan palety poleceń mógł otworzyć portal poza `inert`. Naprawa obejmuje
rzeczywisty nowy registry, transport i jego scope zasobów; stan błędu
navigation nie zwalnia tych lease.

Review wykrył także pominięcie wersji kontraktu przy token-bound odczycie
statusu restartu. Wyjątek obejmuje wyłącznie pin starego procesu API;
brak nagłówka wersji kontraktu nadal odrzuca odpowiedź. Interpretowana
regresja sprawdza odrzucenie brakującej wersji oraz przyjęcie poprawnej
wersji z nowego procesu.

Pierwsza próba przeglądarkowa `e0ad7a92e87e4c58af94bf632bf4b83b` była
FAILED. Fixture zapisywała pusty marker jako tekst `none`, mimo że jej
czytnik i asercja oczekiwały `null`. Ponadto oczekiwała zachowania starego
cache po odmontowaniu, wbrew usunięciu wpisu po ostatnim unsubscribe.
Poprawiony sprawdzian wymaga starego markera przed capture, usunięcia
starego cache po cleanup, pustych hooków/cache nowego klienta przed jego
odpowiedzią oraz nowego markera po odpowiedzi. Zapisuje również stan
i żądania przy błędzie. Nie zmieniono tego kontraktu w kodzie produkcyjnym.

Druga próba `113a8af5a4b14897bdc6fbc8b86a2ac9` potwierdziła 12/13 kontroli,
w tym brak przeniesienia starego cache, blokady nowej generacji przed ACK
i trwałe retirement starego API. Porównanie layoutu pozostało FAILED:
sprawdzian porównywał kolejność kluczy `JSON.stringify`, podczas gdy
`LayoutController.replace` konstruuje pola w innej kolejności. Weryfikacja
wszystkich wartości layoutu wymaga porównania semantycznego, bez pominięcia
paneli, focusu lub ostatniego viewportu.

## Weryfikacja

Wyniki zarządzanych recept dla HEAD
`01e1b113f5a1f17aef0e506e3c9dbf965401e300` z lokalnym diffem,
po integracji równoległych zmian:

| Kontrola | Wynik | Receipt ID |
|---|---|---|
| Host/store/registry/navigation | PASS, 6 grup | `4e799a00fb8b4682b19b7e0d6d2c4a71` |
| Transport i wersja kontraktu | PASS, 13 grup | `7f200f7333344767b2ec11a33323bdf7` |
| Produkcyjny TypeScript | PASS | `c92365f3a7d340be81251c367e346a95` |
| API hygiene | PASS | `2cd62105afa04011a61f33675d2469e2` |
| Lint | PASS | `f5cdf065b96948af97803211cbe90ccd` |
| Zamontowany KernelProvider w Chrome | PASS, 13/13 | `b0df59e373ad453a958da189e94a203b` |
| Zwykły workspace/WebGL | PASS | `baee40fc538142d0a7fca053c0e1fa30` |

Browser receipt potwierdza exit 0, terminalny stan własnego serwera oraz
niezmienione źródła: digest
`cc1a3f4ef142c552de5cbf7821f47990fd55f69c6fe9bf023e7b9b0dd8561fd3`.
Raport zawiera zgodne wartości captured/actual layout, pusty dokument,
stary cache usunięty i nowy cache z nową odpowiedzią. UI fixture zachowuje
lokalny szkic podczas pauzy; po wymianie nie twierdzi, że niezarejestrowany
lokalny stan React został odtworzony.
Zwykły workspace ma widoczny canvas, `context_lost=false`, drawing buffer
617×593 oraz 2802 draw calls w końcowej fazie live. Oba własne serwery
zakończyły się terminalnie; źródła nie zmieniły się podczas finalnych prób.

Receipts źródłowe należą do profilu `windows-control-room-source-check`,
browser do `windows-control-room-browser-fixture`, oba w resolver-managed
`storage/builds/<worktree-id>/<profile-id>`. Recepty:

- `just verify-control-room-development-kernel-host` — interpretowane
  rzeczywiste host/store/registry oraz pure navigation helper. Adapter owners
  jest stubem protokołu; rzeczywisty adapter ma osobny dowód P8-53AQ.
- `just verify-control-room-development-transport-pause` — rzeczywista fasada,
  generated transport, body/decode/retry lifetime i dozwolone trasy.
- `just verify-development-kernel-host-browser` — produkcyjny KernelProvider,
  real controllers i input boundary w przeglądarce z odpowiedziami fixture.
- Produkcyjne typowanie, API hygiene oraz lint; bez kompilowania testów
  jednostkowych.

Review hosta/transportu po naprawie wersji kontraktu nie wskazuje otwartych
Required findings w tym zakresie. Review nie uruchamiał sprawdzianów; wyniki wykonania wymagają
odrębnych receipts. Interpretowany host obejmuje 6 grup, transport po
poprawce obejmuje 13 grup. Przegląd nie stanowi dowodu pełnej obsługi
błędów zwalniania lease ani awarii procesu lub zasilania.

Lint `85047f9c14114f97ace6a8c4191f2720` wykrył 5 błędów w sprawdzianach:
zastrzeżoną nazwę zmiennej `module` oraz zapis ref/diagnostyki w renderze
fixture. Naprawa przenosi te zapisy do efektów i zmienia nazwę zmiennej,
bez wyłączania reguł React. Zmiana efektów wymaga ponownego dowodu browser.

Próba zwykłego workspace `139d0b7ab2644fb6afa909c0469da59d` wyrenderowała
viewport i jej wewnętrzne kontrole browser przeszły, ale managed receipt
pozostał FAILED: `source_changed_during_run=true`. W trakcie próby wspólny
master zmienił HEAD z `688f1f23c96d21fd965be951e349d1daca25f182` na
`01e1b113f5a1f17aef0e506e3c9dbf965401e300` (integracje PR #125/#126).
Ten wynik nie jest finalnym dowodem bieżących źródeł. Wymagana jest
ponowna kontrola integracji, bez cofania tych zmian.

Ponowna kontrola integracji wykryła Required P2 w nowym recorderze wyniku
runu: jego opóźnienie 400 ms nie jest zliczane jako operacja dokumentu.
Wywołanie `recordRunOutcome` po zdobyciu guard może dopisać wynik do
`pendingOutcomes` starego właściciela, poza snapshotem handoff. Ta kolejka
nie przechodzi do świeżego właściciela. Przed udostępnieniem restartu dla
niepustego workspace wymagane jest objęcie scheduled/queued/flushing
outcomes ochroną oraz wykonywalna regresja. Empty fixture tego nie dowodzi.

## Pozostałe bramki

Nie uruchamia to restartu po samym buildzie ani nie podnosi
`restart_available=false`. Komenda/buton, pełny natywny Windows/browser
roundtrip z geometrią/regionami/materiałami, warm-service, fault injection,
power-loss i release qualification nadal wymagają odrębnych dowodów.
Browser fixture nie jest wykonaniem solvera ani natywnym restartem API.
Procentów całego planu nie podnosimy na podstawie źródłowego hosta.
