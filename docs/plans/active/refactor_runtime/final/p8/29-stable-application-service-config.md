# P8-29 — stabilna konfiguracja usługi aplikacji

## Wymaganie i implementacja

Domyślny start usługi nie może ponownie generować budżetów z chwilowo wolnej
pamięci przy każdym otwarciu UI. Istniejący handshake porównuje dokładną
konfigurację; zmienny snapshot powodowałby odmowę dołączenia do poprawnej
usługi albo presję na niebezpieczne jej zastąpienie.

`RuntimeServiceConfig::for_application` odczytuje albo inicjalizuje raz
`runtime-services/APPLICATION.json` we wskazanym canonical SessionStore:

- launch guard, następnie wspólna writer lease, serializują inicjalizację
  względem startów przez service-ensure i publikacji innych writerów;
  zajęty guard oznacza odmowę operacji, bez takeover/restart;
- istniejący plik przechodzi bounded reader, walidację schematu, zasobów,
  timeoutów oraz dokładnego store root i target ID;
- factory jest wywoływane tylko przy pierwszej inicjalizacji; istniejące
  budżety nie zależą od kolejnego pomiaru;
- błędny plik lub wynik obserwacji nie pozwalają na regenerację;
- OWNER.lock, OWNER.json lub LAUNCH.json bez konfiguracji wymagają jawnej
  konfiguracji lub recovery, również po przerwanym przejęciu ownera;
- kandydat innego store/targetu odrzucany jest przed publikacją;
- guarded path i istniejący atomic writer metadata publikują konfigurację
  w operacyjnym namespace, oddzielnym od danych naukowych i traversal CAS.

Nie zmienia to schematu runtime_service_config.v1, istniejącego explicit
service-ensure ani polityki requested/resolved CPU/GPU. Nie ma nowego rootu
danych, Docker volume ani alternatywnego modelu accepted state.

## Weryfikacja

- Parser/format `rustfmt --check` i scoped diff check: PASS.
- Manifesty i istniejące zależności: bez zmiany względem zielonej kontroli
  locked/offline z P8-28; nie jest to dowód kompilacji nowej metody.
- Pięć regresji Rust zapisanych: odmowa przy aktywnym launch guard,
  reuse bez resampling/wrong target,
  zachowanie uszkodzonego pliku, orphaned OWNER.lock/OWNER.json/LAUNCH.json,
  kandydat innego store.
  NOT RUN / NOT COMPILED zgodnie z zakazem kompilacji unit tests.
- Niezależny bounded source review i re-review: PASS, bez otwartych P0/P1.
  Wykryty lock-only orphan poprawiono; regresja obejmuje teraz OWNER.lock.
- Runtime konkurencji, awarii publikacji i Windows durability: NOT VERIFIED.
  Atomic writer pozostaje dotychczasową granicą; nie deklarujemy power-loss proof.
- Odczyt centralnego runnera 03.10.2026 01:30 UTC: worker running,
  accepting_jobs, brak aktywnych jobs, waiting_for_disk, 6 359 195 648 B wolne.
  Próg 8 GiB nie jest spełniony; brak profilu Windows. Nie uruchomiono
  zastępczego builda ani nie usuwano współdzielonych danych.

## Pozostały zakres

Ta metoda jest trwałą granicą konfiguracji, jeszcze nie podłączeniem startu
usługi do czystej instalacji. Kolejne kroki: generator budżetów z P8-28,
canonical store i handshake API przed inicjalizacją, wybór persisted config
w packaged startup, współdzielenie budżetu compute/preparation bez podwójnej
rezerwacji oraz rzeczywiste clean install/reopen/runtime smoke.

Cały plan P0–P8 pozostaje otwarty. Sesja 3104, cudze zmiany i aktywne zasoby
są zachowane. Zakres nie stanowi kwalifikacji natywnego produktu Windows.
