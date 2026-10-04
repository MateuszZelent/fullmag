# P8-30 — domyślne budżety zasobów natywnej usługi

## Implementacja

`local_resources::application_service_config` tworzy konfigurację
`runtime_service_config.v1` z rzeczywistego snapshotu `LocalCpuCapacity`.
Budżet hosta wynosi co najmniej 25% każdego zasobu, z zaokrągleniem w górę.
Pozostała pojemność jest dzielona na dwa równe, zaokrąglone w dół sloty:
compute oraz preparation. Suma ofert nie przekracza zmierzonego CPU,
dostępnej RAM ani dostępnej pojemności dysku. Reszta po zaokrągleniu pozostaje
poza ofertami. Obie pule i zasoby mają odrębne identyfikatory.

Konfiguracja jest odrzucana, jeżeli choć jeden slot miałby zerowy CPU, RAM
lub storage. Arytmetyka nie mnoży wartości wejściowych, więc przy `u64::MAX`
nie przepełnia się. Wynik przechodzi istniejącą walidację konfiguracji.
Root musi być absolutny; integracja użyje canonical accepted SessionStore
przez `RuntimeServiceConfig::for_application`, zamiast alternatywnego rootu.

To budżety admission, nie limity procesów narzucane przez system operacyjny.
Na jednym logicznym CPU każdy slot otrzymuje 375 cpu_millis. Zadanie o większym
żądaniu nie pasuje do takiego slotu; nie zaokrąglamy obu ofert do pełnego CPU.
Izolacja wątków i limity rzeczywistego zużycia wymagają osobnej implementacji
oraz weryfikacji. Nie deklarujemy gwarancji zużycia pamięci przez solver.

Domyślna oferta dotyczy wyłącznie CPU i ma zerową pamięć GPU. Nie oznacza to
kwalifikacji żadnego solver lane ani przełączenia jawnego GPU na CPU.
Jawna konfiguracja GPU pozostaje osobną drogą. Timeout pracy wynosi rok,
startup 60 sekund, heartbeat sekundę, a drain 30 minut; startup UI nie jest
limitem czasu obliczeń naukowych.

## Dowody

- `rustfmt --check` i scoped `git diff --check`: PASS.
- Trzy regresje Rust zapisane: rozłączność i suma ofert wraz z rezerwą hosta
  dla granicznych wartości, podział jednego CPU, odmowa każdego brakującego
  zasobu. NOT RUN / NOT COMPILED zgodnie z aktualnym zakazem unit builds.
- Niezależny source review: brak P0/P1; nie zastępuje kompilacji lub runtime.
- Windows production build, pomiary OS na gotowym pakiecie, rzeczywiste
  admission/wykonanie i clean install: NOT VERIFIED.

## Następny krok i granice ukończenia

Builder jest częścią P8-C, a nie ukończeniem natywnego produktu Windows.
Nie zmienia jeszcze startu aplikacji. Należy podłączyć persisted konfigurację
po handshake API/store, z rozpoznaniem pakietu Windows i pierwszeństwem
jawnej konfiguracji. Przy braku gotowej usługi pusty workspace musi pozostać
dostępny z jawnym statusem wykonania. Obecne wywołanie ensure w launcherach
propaguje błąd i może zakończyć start UI; automatycznego ensure nie wolno
podłączyć bez rozwiązania tego zachowania. Nie stosujemy takeover, restartu
po nieznanym wyniku ani fikcyjnych ofert zasobów.

Plan P0–P8 pozostaje otwarty. Stara sesja na 3104 pozostaje zachowana do
decyzji użytkownika. Nie dodano Docker volume ani zależności produktu od Linuxa.
