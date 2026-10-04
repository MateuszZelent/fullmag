# P8-33 — zasób API natywnej usługi

Źródła routera i OpenAPI rejestrują `GET /v2/platform/runtime-service`.
Handler wykonuje observer na blocking pool, bez otwierania writera, tworzenia
store, startu procesu, retry ani takeover. Explicit konfiguracja ma pierwszeństwo;
brak metadata dla poprawnego nowego store oznacza not_configured bez mkdir.
Orphan owner/launch lub niepewny odczyt wybiera jawną obserwację błędu.

DTO rozróżnia dziesięć stanów i szesnaście kodów powodu. Publiczny komunikat
jest stałą mapą kodu: surowe native diagnostics mogą zawierać host paths,
więc nie są kopiowane do odpowiedzi. Strong ETag zależy od publicznego body;
warunkowy odczyt używa wspólnej implementacji 304/no-cache.

## Dowody i pozostała integracja

Parser/format dwóch nowych modułów i scoped diff check: PASS.
Niezależny review źródeł po poprawce publicznego message: PASS, brak P0/P1.
Regresje DTO, wyboru konfiguracji i ETag zapisane, NOT RUN / NOT COMPILED
zgodnie z bieżącym zakazem kompilacji unit tests. Kompilacja produkcyjna,
HTTP 200/304, live Ready oraz Windows runtime pozostają NOT VERIFIED.
Generated JSON/types/client nie były ręcznie zmieniane. Frontend resource hook,
widoczny status i autorun z zachowaniem edycji/zapisu nadal pozostają otwarte.

Produkcyjny fullmag-api obsługuje już --print-openapi-v2 przed inicjalizacją
serwera. Po terminalnym managed buildzie nowych źródeł ten tryb umożliwia
kanoniczny eksport z gotowego binarium, bez osobnego hostowego Cargo codegen.
Należy zweryfikować receipt, hash i tożsamość źródeł binarium oraz stosować
istniejącą normalizację build identity przed generacją types/client.

Runner sprawdzony 03.10.2026 02:36 UTC: worker healthy, accepting_jobs,
17 604 841 472 B wolne; aktywny job 212 dotyczy starszego commita
75ab6fe297d116657bcf67f1f321f4fd47e66fd0, a nie tego etapu.
Nie usunięto cache ani nie zatrzymano sesji na 3104. Wcześniejszy brak miejsca
nie jest już aktualną blokadą; najnowszy kontrakt wymaga nowego buildu.

Plan P0–P8 pozostaje otwarty; etap źródłowy nie zalicza bramek runtime ani wydania.
