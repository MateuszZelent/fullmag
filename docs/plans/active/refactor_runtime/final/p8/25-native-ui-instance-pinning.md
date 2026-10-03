# P8-25 — przypięcie UI do procesu API

CLI i desktop otwierają bezpośrednio workspace z UUID API, także przy braku
konfiguracji niezależnej usługi. Brak konfiguracji nie tworzy zasobów ani usługi;
wymagana jest zgodność źródła/build identity API. Return binding rozdziela
opcjonalnego ownera usługi i wymagany identyfikator API.

Jeden ControlRoomApi przechwytuje UUID raz. Wspólny transport generated client
i binary wysyła nagłówek oraz sprawdza odpowiedź. Mismatch/brak nie jest retry:
klient trwale odmawia dalszego HTTP i wymaga nowego otwarcia z launchera.
Realtime zachowuje ten sam pin w towarzyszącym subprotocol podczas reconnect;
API odrzuca mismatch/duplikaty przed upgrade. Podstawowy protokół, envelopes,
resource schemas i generated artifacts nie zmieniły się. Pin jest zewnętrzną
tożsamością procesu należącą do instancji transportu, nie stanem sesji w React,
persisted UI ani autoryzacją. Guard reuse API nadal obowiązuje.

Przed przypiętym connect/reconnect wykonuje się health przez tę samą facade,
z timeoutem 3 s. Mismatch zamyka klienta i zatrzymuje reconnect; przejściowa
awaria sieci zachowuje politykę retry. Generation guard zapobiega otwarciu
socketu po close/unmount w trakcie preflight. Guard HTTP działa także po
asynchronicznym odczycie diagnostyki i po zdekodowaniu generated JSON result.
Analogiczny guard działa po binary transport/decode, w zapisanej topologii
i support oraz po złożeniu chunków topologii. Stary payload nie jest publikowany
po zaobserwowanej zmianie instancji podczas tych operacji asynchronicznych.

## Weryfikacja

- Production-source typecheck bez testów: PASS, receipt
  `d1130778fe5d4a5eba286015e488bc64` (po poprawkach review, WS i binary).
- API hygiene: PASS, receipt `4ac50ec77b29435284ad90400574e949`.
- Regresje Rust/TS zapisane dla pin, odmowy replacement, duplikatów i reconnect:
  NOT RUN / NOT COMPILED z powodu aktualnego zakazu kompilacji testów.
- Parser Rust i scoped diff checks: PASS.
- Pełny lint: FAIL, receipt `01390d76ea6045e08a619843b72406f3`,
  19 errors i 4 warnings w niezmienionych plikach FieldMapModule,
  FdmCuboidLayer, ObjectMeshPolicyPanel, InspectorEditSession.dom.test
  i smoke-pinned-materialized-dataset. Brak findings w plikach tego fragmentu;
  nie jest to zaliczona bramka całego frontendu.
- Statyczny lint siedmiu zmienionych plików frontendowych bez cache/emisji:
  PASS, exit 0 po finalnych poprawkach; nie zastępuje pełnej bramki lint.
- React Doctor zainstalowany w repo, scope changed względem
  `34a283eb8e16282eb6e35012e5f3a8d68f48e0da`: PASS, siedem plików,
  brak nowych issues, receipt `9e80d85ca70e4112be7fb5c3600dca6a`.
  Hook commita zgłosił uwagi skanu z rootu bez rozpoznanego frameworka;
  właściwy skan aplikacji Control Room nie potwierdził regresji fragmentu.
  Wynik jest statyczną diagnostyką; nie dowodzi poprawnego browser/runtime.
- Niezależne source review native/API i frontend: PASS, bez otwartych P0/P1.
  Dwa wykryte wyścigi (diagnostyczny await i binary decode) poprawiono oraz
  ponownie przejrzano; regresje pozostają NOT RUN, nie są dowodem wykonania.
- Aktualny managed build, native Windows, browser replacement scenariusz:
  NOT VERIFIED. Sesja 3104 nie jest dowodem tych nowych źródeł i pozostaje
  zachowana do decyzji użytkownika. Nie uruchomiono drugiego ciężkiego buildu
  ani nie usuwano współdzielonych danych.

Odczyt runnera 2026-10-03 00:14 UTC: worker running/accepting_jobs,
bez aktywnych jobs, `waiting_for_disk`, 6 696 624 128 B wolnego miejsca.
To nie spełnia progu admission 8 GiB ani nie jest zgodą na hostowy fallback.

Pełny cel P0–P8 pozostaje otwarty. Kolejne bramki obejmują domyślne zasoby
produktu, pełny accepted execution cutover, managed runtime, browser i wydanie.

Kod P8-25 opublikowano na master w commicie
`c4376d93be011a5bf184bf7d98ec3989464da580`. Obce unstaged zmiany zachowano.
