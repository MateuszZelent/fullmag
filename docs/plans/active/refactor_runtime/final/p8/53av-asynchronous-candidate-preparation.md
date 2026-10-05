# P8-53AV — asynchroniczne przygotowanie kandydata restartu

Data: 05.10.2026. Stan: pozytywny cykl native pompy zaliczony;
pełny restart UI, fault/cancel/stale-scope NOT VERIFIED.
Kontrakt: [ADR 0050](../../../../../adr/0050-development-backend-restart.md).
Rozwinięcie [P8-53AU](53au-private-consumer-readiness.md).

## Problem i dowody

Zarządzana próba pompy `3c7f86cd3a3d4adea54909c868f3d747` zakończyła się
timeoutem pomocniczego acquisition po uruchomieniu własnego API A, przed
zaliczeniem kontroli. PID wcześniejszego helpera zakończył się poprawnie;
nie był to wynik selektora B. Selektor może czterokrotnie sprawdzać ten sam
snapshot w jednym wywołaniu. Diagnostyczna pełna kontrola snapshotu B
`f1085c07e58d30c48bb5b660f8dc9ae36be498dd4dbe050e33200bb4e50b48e1`
zakończyła się exit 0 w 15,254 s. Dwie niezbędne kontrole przekraczają
20-sekundowy limit, nawet po usunięciu powtórnych skanów.

## Implementacja

- Oddzielne, własne zadanie przygotowania: maksymalnie jedno dla tuple
  API/worktree/generacja/build/source, limit 120 s i odpytywanie bez blokowania pompy.
- Pending nie zamyka próby. Gotowy zweryfikowany pakiet trafia do cache przed
  renewal ACK; terminalna porażka nie rozpoczyna pętli kolejnych kopii.
- Zmiana scope lub kandydata anuluje i odbiera własne zadanie. Niepotwierdzony
  cleanup pozostaje błędem i nie jest dowodem zwolnienia zasobów.
- Pełna kontrola snapshotu przed i po przygotowaniu; manifest i binaria
  zachowują wszystkie dotychczasowe kontrole. Reuse weryfikacji jest lokalne
  dla jednego wywołania i identycznych bajtów rekordu; finalna kontrola jest wymuszona.
- Owner validation i pozostałe acquisition zachowują 20 s; publiczne API bez zmian.
- Probe raportuje PID przygotowania przed ukończeniem kroku i mierzy jego czas.
  Pierwszy krok musi trwać poniżej 1000 ms przy wciąż działającym helperze.

## Weryfikacja i granice ukończenia

Interpretowane kontrole progresu: 3 PASS, 8 subtests PASS. Weryfikują brak
terminalnego wyniku, zachowanie wczesnego PID, odmowę duplikatów i obcego
scope. Nie dowodzą poprawności Rust ani lifecycle procesu.

Kontrola `rustfmt --check` pięciu plików CLI oraz `git diff --check` przeszła.
Review własności helpera potwierdziło obsługę rozłączonego transportu,
odebranie obu uchwytów, limity wejścia/wyjścia i ograniczony czas destruktora.
Awaria tworzenia transportu zachowuje child w zadaniu i przechodzi w
odpytywaną ścieżkę zakończenia. Niepotwierdzony cleanup zachowuje job i
blokuje rozpoczęcie kolejnego zakresu; sam log nie jest dowodem zakończenia.

Reuse snapshotu zapisano w lokalnym commicie
`f33e2fa53b3c5e4e5da46af399666aa84d3dc7a8`. Nowy zestaw 7/7 PASS,
dodatkowa regresja sidecar identity 1 PASS, istniejący snapshot 12/12 PASS
oraz fokusowany test rzeczywistego selektora/statusu 1 PASS. Review bez
wymaganych poprawek. Cache jest ograniczone do jednego zakresu i wątku;
normalne odczyty pozostają pełne, a końcowy odczyt jest wymuszony. Te dowody
nie zaliczają jeszcze limitów czasowych ani asynchronicznej pompy.

Przed uznaniem przyrostu za gotowy wymagane są: kontrola cache i mutacji
snapshotu, produkcyjny build Windows, zarządzany cykl pompy z dwoma różnymi
zweryfikowanymi pakietami, kontrola pending/nonblocking, utrzymanie i
wygaśnięcie readiness, reuse jednej kopii, odebranie wszystkich własnych
procesów, stale scope oraz błędy przygotowania/cleanup. Testy jednostkowe
Rust nie są kompilowane podczas obowiązywania zakazu. Samo zaliczenie tego
przyrostu nie dowodzi pełnego restartu UI z niepustym modelem ani kwalifikacji
FEM, fizyki, warm service czy wydania. Publiczny restart pozostaje niedostępny.

## Zamknięcie sesji przed weryfikacją

Użytkownik zatwierdził restart sesji na 3197. Przed zamknięciem zasób
`development-backend` wskazywał `session_id=null`, `session_epoch=0` oraz API
`dd582f13-cad8-43f8-8d6b-2ec957551fc0`. Zamknięto okno desktop PID 87500,
po potwierdzeniu rodzica CLI 80744 i ścieżki EXE. Zapis właściciela generacji
`e6906311dbb04c469a4a9e08972d1abe` zakończył się `completed`, exit 0,
`launcher_waited=true`, `watcher_waited=true`, `watcher_exit_code=0`
o 11:47:45 UTC. Porty 3197 i 8081 oraz wskazane procesy były zamknięte.
Nie była potrzebna wymuszona terminacja ani odzyskiwanie owner record.

## Build i zarządzana pompa

Build `native-build-e0efcb12fdc34c75b79c53106a335ce0.log` zakończył
kompilację CLI/API w 4 min i desktopu w 1 min 54 s. Manifest B:
`e44aeb25a22534ba3ea901adb7099cee0d79831ab3f22b90a034230207842674`,
snapshot `a3eccdb06abc72a1cbc8b908cf3c8954d97e598f5a1038e76bd02366dd84f5d2`,
backend source `c51d871b9d8ed6bef36475aae75c8b1af669a14ea3594efb204943514986884e`.
Pakiet został uruchomiony na 3197; nowe API
`b0407349-d370-456f-b2a5-ca43a771faeb`, nadal bez aktywnej sesji.
Przeglądarka potwierdziła ekran startowy i przycisk Build backend.

Pierwsza próba `643a11bbbe9541e4b2c15a3fbffc7359` odmówiła preflightu
bez uruchomienia procesów: starszy verifier wymagał zgodności z edytowanym
checkoutem. Wyłącznie dla pompy przypięto zweryfikowany frozen package;
przed i po próbie pełna kontrola snapshotu, manifestu i binariów pozostaje
wymagana. Checkout jest zapisany osobno; zmiana verifiera/helperów nadal
unieważnia wynik. Inne tryby weryfikacji zachowują dotychczasową kontrolę.

Próba `c10afae06a774ddcb1307842bbf87aab`: **completed, exit 0, 13 kontroli**.
Pierwszy krok trwał **17 ms**, z żywym helperem i brakiem gotowości.
API A pochodziło z osobno zweryfikowanego pakietu
`3b1de31747fb4fe7b5275b8cfdec42cd`; kandydat B:
`cc147dac2d704f66afa35411b09e06a0`. Potwierdzono odnowienie lease poza
początkowym TTL, wygaśnięcie bez kroków, odnowienie po przerwie, wycofanie
readiness, reuse jednej kopii i brak requestu lub podmiany procesu.
Initializer PID 90912, CLI B 87052 oraz helpery 86964/91780/45028 zostały
odebrane z exit 0. Własne API A PID 63052 zostało odebrane z exit 1 po
jawnym zakończeniu próby; jest to dowód terminalnego zakończenia, nie
graceful exit 0. Receipt zachowuje dokładny wynik procesu.
Kanoniczny OpenAPI potwierdził tożsamość zbudowanego kodu.

Po próbie UI nadal używało tego samego API i watchera. Kliknięcie Build
backend przyjęło jawny request `1a86350e-94dd-4194-b07d-7365d7ed11c1`.
Request zakończył się **completed, exit 0**, 12:17:48–12:26:59 UTC
(9 min 11 s łącznie; CLI/API 3 min 23 s, desktop 1 min 02 s).
Manifest: `5a39579927002b073b821ae140f52f0bc72b39a4c8b6aef86a393303b161f251`,
snapshot: `d474838d1d4433aee937c029799755ef94af3102b27e7942064368f8258881c3`.
API nadal miało tożsamość `b0407349-d370-456f-b2a5-ca43a771faeb` i
dotychczasowy source SHA; resource oraz przeglądarka potwierdziły Ready.
Commit checkoutu podczas buildu nie odrzucił wyniku snapshotu.
Nie było automatycznego restartu workspace ani kolejnego buildu.
Publiczny restart pozostaje niedostępny (`restart_integration_pending`).
Te dowody nie zastępują fault injection, anulowania, stale scope ani
odtworzenia modelu. Przyrost pompy zapisano w lokalnym commicie
`3a157b229eb2a1111440f641b1cca7fef566bb36`; nie stanowi to dowodu publikacji
na remote ani ukończenia całego P8-53.
