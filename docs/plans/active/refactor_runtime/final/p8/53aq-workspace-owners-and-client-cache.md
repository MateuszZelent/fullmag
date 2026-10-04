# P8-53AQ — właściciele workspace i izolacja cache klienta

## Zakres

Zarządzany zasób `development-backend` udostępnia dokładną tożsamość
API/session/globalnego epoch. Capture odczytuje ją świeżo przez centralną
fasadę; nie zgaduje licznika na podstawie obecności modelu ani domenowego
epoch wyników. ETag uwzględnia zmianę tożsamości. Nie dodajemy endpointu.

`ProjectDocumentController.beginDevelopmentHandoff` chroni dokument przed
create/open/save/authoring/close/restore, wymaga jawnego carry dirty danych
i wykrywa zmianę metadanych w miejscu. Zwolnienie jest idempotentne;
nieudane powiadomienie przy wydawaniu guarda wycofuje go.

`DevelopmentKernelOwners` łączy rzeczywistych właścicieli dokumentu,
PendingForms i layoutu. Waliduje dostępne moduły, jawny brak osobnego edytora,
nowego przypiętego klienta oraz świeże kontrolery przed odtworzeniem.
Publikacja wymaga callbacku potwierdzającego przejęcie nowego kernela.

Review wykrył zmianę sesji przez innego klienta między capture a Submit.
Dokładny `ControlRoomApiError` 409 z kodem
`development_restart_workspace_changed` oznacza odrzucenie przed publikacją:
kontroler kończy intent jako failed i zwalnia ownerów. Inne błędy, w tym
`development_restart_publication_unconfirmed`, zachowują unknown custody.
Nie dodano ponowienia mutacji. Review tej poprawki: bez otwartych Required.

Cache zasobów jest odrębny dla każdej instancji klienta. Hooki i selektory,
scope komend, wydawcy odpowiedzi authoring oraz synchronizacja wizualizacji
korzystają z tej samej przestrzeni. Transport, invalidation i diagnostyka
nadal używają kanonicznych kluczy. Spóźniona odpowiedź starego klienta nie
publikuje danych pod kluczem nowego klienta.

## Natywny build i kontrakt

Zarządzany `just windows-workspace-build dev dev 3197 auto`: exit 0,
profil Cargo `backend-dev`, produkcyjne EXE, bez kompilacji testów.
Commit wejścia: `6d658d58cca4e4885caa1a2dc69cd95889c656df`, dirty snapshot
`056e4bd39ae367e9aa99361741cc5f0559334054cc0977770e69d9485b32c915`.
Fingerprint backendu:
`fabb928eac6e2ed6195e23a08eb78759a734ca60c7c51f5ed4c92593185c97a6`.
Pierwszy build stracił aktualność po równoległej integracji zmiany
`apps/desktop/src-tauri/src/recent_index.rs` do wspólnego mastera.
Nie poluzowano kontroli tożsamości; ponowiono zarządzany build.

`just verify-windows-development-restart-transport`: **24 kontrole PASS**,
receipt `development-backend-api-checks/checks/3fe1ca2745ee4de0a6e0321163df8380/receipt.json`.
Dowód obejmuje rzeczywiste natywne API, pustą sesję, kolejne globalne epoch
1 i 2, ścisły kontrakt OpenAPI, pin/token/replay i blokadę mutacji przez
pending restart. Dwa własne procesy mają potwierdzony terminalny wynik.
Nie jest to dowód wymiany procesu, pełnej hydration UI ani działania solvera.

Próby kontrolne wcześniej ujawniły zerwane połączenie oraz prawidłowe
odrzucenie tworzenia sesji po pending restart i zastąpienia sesji bez jawnego
`replace_current`. Fixture skorygowano: przejścia wykonywane są na osobnym
własnym API przed pending intentem, z jawną wymianą sesji fixture.
Produkcja zachowała blokady; nie dodano automatycznego replay mutacji.

Kontrakt wyeksportowano przez ten sam API, importując z weryfikacją receipt,
hasha i obu tożsamości źródeł. `just generate-control-room-client`: **PASS**,
receipt `windows-control-room-source-check/generate-client/c878fc6411514f55830d72a36f1bd8c6/receipt.json`.

## Dowody frontendu

Production TypeScript, z wykluczonymi testami: **PASS**, receipt
`windows-control-room-source-check/production-source/d1b72627c93949a1a2785ed6120aac95/receipt.json`.
Interpretowany produkcyjny koordynator: **39 grup PASS**, receipt
`windows-control-room-source-check/development-restart-check/3e158b19963e4de28907aa4cbff236a1/receipt.json`.
Interpretowane rzeczywiste store/helper/scope komend i wydawca sceny: **9 grup PASS**, receipt
`windows-control-room-source-check/resource-client-cache-check/f0d7b619b022473ebc90fa1133b64482/receipt.json`.
API hygiene: **PASS**, receipt
`windows-control-room-source-check/api-hygiene/7f194768dbdc49308ce8f20357f962ff/receipt.json`.
Lint: **PASS**, receipt
`windows-control-room-source-check/lint/093e4c9f33804e0f8ec1b1953d9be985/receipt.json`.
React Doctor zmienionych plików: exit 0, receipt
`windows-control-room-source-check/react-doctor/c1bb4e476ec04a8d81498b56171f39c2/receipt.json`.
Jedno ostrzeżenie o istniejącym imporcie `isOptionalObjectInteractionKind`
z barrel `apiTypes` w `geometryLifecycleResources.ts`; import jest identyczny
w rodzicu. Nie zmieniano niezwiązanego API tylko dla wyniku skanera.
Interpretacja usuwa natywnie adnotacje typów; nie emituje bundla ani kodu
testowego. Kontrola call-site źródeł jest odrębna od wykonania store.

Końcowy review wykrył retencję pełnej sceny pod nieobserwowanym aliasem
klienta. Wydawcy sceny i visualization aktualizują teraz wyłącznie istniejące,
obserwowane wpisy klienta przez `updateObservedData`; nie tworzą aliasów
ani nie odtwarzają cache starego właściciela po unsubscribe. Standardowe
invalidation i późniejszy odczyt pozostają kanoniczne. Wykonywany sprawdzian
rzeczywistego wydawcy i store obejmuje 20 kolejnych klientów, natychmiastową
aktualizację odbiorcy oraz późną publikację z session scope i bez niego.
Ponowny review tych czterech plików nie wykazał dalszych uwag Required.

`just verify-project-document-handoff-browser`: **31/31 PASS** w Chrome,
receipt `windows-control-room-browser-fixture/project-document-handoff-browser/969f0018ceef403abd1e1beb8290fecf/receipt.json`.
Przeglądarka wykonuje faktyczne kontrolery dokumentu, forms, layoutu, modułów,
adapter właścicieli i centralną fasadę, z odpowiedziami fixture.
Obejmuje fresh pin/session/epoch, odrębne kontrolery, blokady podczas capture,
odrzucenie obcego klienta/layoutu/edytora/shared forms, zachowanie metadanych
oraz znane odrzucenie HTTP bez ponowienia POST. Brak page/console errors;
własny serwer ma potwierdzony exit i zamknięty port. Obejrzano screenshot.
Dowód nie obejmuje produkcyjnego pause/publish ani natywnego restartu z UI.

`just verify-pinned-dataset-browser`: **PASS**, receipt
`windows-control-room-browser-fixture/pinned-dataset-browser/8b375428b652430db48403e68405b1c5/receipt.json`.
W rzeczywistym workspace działają resource hooks, saved/live source selection,
izolacja kamery i negatywne kontrole obcej sesji oraz manifestu. Widoczny
canvas: WebGL `context_lost=false`, drawing buffer **617 × 593**, bootstrap
**2614** zarejestrowanych wywołań draw; zapisane F64/F32 również renderują.
Obejrzano screenshot powrotu do current. Własny serwer zakończony;
źródła nie zmieniły się podczas próby. Dane są fixture, bez solvera.
Próba wykonana po poprawce retencji cache. Współdzielony master w międzyczasie
otrzymał PR #123 (`1010f5d94cb13a9aae2e5644992c0fc26c93f33e`): dwa testy
layoutu i test provenance w desktopie. Nie zmienia to produkcyjnych źródeł
natywnego buildu przypiętego wyżej; nie przedstawiamy jego receipt jako
buildu nowszego SHA.

Poprawiono pomiar w istniejącym smoke: klikanie już aktywnej zakładki nie
wymaga nowego renderowania. Baseline pochodzi teraz sprzed przełączenia
source albo od zera nowego dokumentu, którego init script zeruje audit.
Zamiast stałego opóźnienia próba czeka na faktyczny draw. Zachowano kontrole
niezerowego bufora, kontekstu i kamery; dodatkowy gest użyty podczas diagnozy
usunięto, ponieważ sam zmieniał kamerę porównywaną w następnych etapach.

Ten browser proof nie przełącza hooków pomiędzy dwoma kernelami podczas
natywnego restartu. Separacja klientów jest wykonana na produkcyjnym store
w kontroli interpretowanej; pełny React/fresh-kernel flow nadal pozostaje otwarty.

## Granice ukończenia

Port 3197 był zamknięty przed buildem. Nie zatrzymywano procesu API na innym
porcie o niepotwierdzonym właścicielu. Nie usuwano cache ani danych sesji.

Adapter nadal wymaga produkcyjnego pause/publish w `KernelProvider`.
Pełne odtworzenie natywnego workspace w UI, fault injection, warm-service
restart, power-loss i kwalifikacja wydania pozostają **NOT VERIFIED**.
`restart_available=false`. Procenty całego planu nie awansują na podstawie
samego adaptera ani kontrolnego transportu.
