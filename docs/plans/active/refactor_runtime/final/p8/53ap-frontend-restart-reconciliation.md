# P8-53AP — rekoncyliacja restartu po stronie frontendu

## Zakres przyrostu

Centralna fasada API otrzymuje typowane Submit oraz odczyt statusu restartu.
Submit pozostaje przypięty do starego API i nie ponawia mutacji. Odczyt statusu
używa osobnego tokenu Bearer; zgodnie z kontraktem backendu pomija stary pin
wyłącznie dla tej trasy. Zwykłe zasoby nadal odrzucają obcą tożsamość API.

`DevelopmentRestartController` zachowuje jeden intent i token przed wysłaniem.
Po utracie odpowiedzi nie wysyła kolejnego Submitu: rekoncyliacja odczytuje ten
sam request. Capture wymaga ochrony niezależnych ownerów i ponownego
`assertCurrent` przed publikacją. Przy niepewnym wyniku nie zwalnia tej ochrony.

Ready musi mieć dokładny request ID, schemat, świeży UUID API oraz wszystkie
trzy zgodne payloady. Pusty workspace zachowuje brak sesji i epokę 0;
odtworzony model otrzymuje nowy identyfikator sesji i epokę 1.
Dopiero wtedy koordynator przekazuje dane do odtwarzania świeżych ownerów.
Awaria odtwarzania zachowuje ochronę i nie uruchamia automatycznej powtórki.
Awaria cleanup lub subskrybenta nie zmienia potwierdzonego odtworzenia w wynik
niepewny, który pozwalałby powtórzyć hydration.

## Dowody i ograniczenia

Zarządzana recepta `just verify-control-room-development-restart` wykonuje
produkcyjny kod po natywnym usunięciu adnotacji typów, bez bundla testowego,
emitowanego JavaScript ani kompilacji testów jednostkowych. 35 grup PASS:
lost ACK, retained guards, odrębne payloady, obcy request, stale/invalid pin,
niepoprawna epoka, świeża sesja modelu, błędy capture/read/hydration/cleanup
oraz subskrybenta, łączna awaria capture/cleanup i granice ścieżki token-bound GET.
Review znalazł błędne
wymaganie zachowania starego session ID oraz nieobsłużoną awarię cleanup
capture; oba przypadki poprawiono i włączono do sprawdzeń.

Receipt: `windows-control-room-source-check/development-restart-check/09ee0bf0beae4050a613fee558168ab7/receipt.json`.
Dowód ten obejmuje koordynator z wstrzykniętymi transportem i ownerami;
nie dowodzi działania transportu HTTP ani rzeczywistego odtworzenia paneli.

Production TypeScript (z wykluczonymi testami): **PASS**, receipt
`windows-control-room-source-check/production-source/ae83280303874044bc93c162a52e40fe/receipt.json`.
API hygiene: **PASS**, receipt
`windows-control-room-source-check/api-hygiene/704185f545624c25b338b1030c2e1331/receipt.json`.
Lint: **PASS**, receipt
`windows-control-room-source-check/lint/f5606f37db5e4b1f964b366718d96ab9/receipt.json`.
Końcowy review źródeł kontrolera i wąskiego wyjątku API pin: bez otwartych
Required findings. To review kodu, odrębne od runtime/browser proof.

Podłączenie konkretnych ownerów editor/workspace/project_document, przejęcie
nowego kernela i cache, kontrolka użytkownika, fault injection oraz pełny
browser/native restart pozostają **NOT VERIFIED**. Nie włączamy
`restart_available`; procenty etapów całego planu pozostają bez awansu.

## Następna integracja

`KernelProvider` obecnie tworzy jeden kernel przez `useMemo([])`, a handler
`session:status-changed` czyści `pendingForms` przy rozłączeniu. Sam guard
`PendingFormRegistry` nie blokuje `clear()`. Przed włączeniem restartu trzeba
więc kontrolowanie zatrzymać stare connectory i oddzielić rozłączenie podczas
przekazania od normalnej utraty sesji; nie wystarczy zmienić query w URL.

Nowy kernel wymaga świeżego klienta, nowego `resourceCacheScope` i statusu
nowej sesji przed aktywacją resource hooks. Dokument projektu należy odtworzyć
w świeżym `ProjectDocumentController` istniejącą metodą
`restoreDevelopmentHandoff`, a layout i lokalne szkice przez ich właścicieli.
Odtwarzanie i publikacja nowego pinu są obowiązkami callbacku `hydrate`;
obecny przyrost nie dostarcza jeszcze jego produkcyjnego adaptera.

## Checkpoint i integracja

Lokalny commit źródeł: `424926e3c5b0a2ea5421a92dfa3b1b269a780f6c`,
branch `master`. Hook React Doctor zwrócił dwa ostrzeżenia `await` w pętlach
odczytu zakresów topologii; oba miejsca istnieją identycznie w rodzicu commita
i nie były zmieniane przez ten przyrost. Review nie uznał ich za nową regresję.

Próba aktualizacji istniejącego rejestru `p6-fmr-artifact-routes` przez
`just worktree-finish ... wip` została odrzucona:
`Existing real path requires inventoried migration, never automatic removal: C:\git\fullmag\fullmag\target`.
Potwierdzono zwykły katalog `target`, bez linku. Nie usuwano ani nie migrowano
go; aktualizacja rejestru pozostaje zablokowana do sprawdzenia jego własności
i aktywnych użytkowników. Cel całego planu pozostaje otwarty.

Push/integracja remote nadal podlega wcześniejszej odmowie automatycznej
kontroli publikacji do publicznego repozytorium; nie ponawiano ani nie obchodzono
tej odmowy. Zachowano niezwiązane lokalne zmiany `fullmag-session` i submodułu.
