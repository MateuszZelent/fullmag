# P8-53AC — utrata ACK i odtworzenie sceny w kandydacie

Data: 04.10.2026. Zakres: natywny Windows FDM CPU dev, zimny magazyn,
prywatny owner-control. P8-53 pozostaje w realizacji.

## Zmiana

Klient ma wspólną ścieżkę jednorazowego zatwierdzenia. Zarządzana sonda może
zamknąć połączenie bez odczytu ACK. Po potwierdzonym zakończeniu dokładnie
własnego API uzgadnia trwały rekord ze stagingiem, pełnym fence, nonce,
API UUID, hashem kapsuły, kandydatem i rzeczywistym magazynem.
Nie ponawia zatwierdzenia. Nieznany wynik zachowuje fence i nie powoduje
wymuszonego zakończenia procesu. PID jest flushowany przed długimi operacjami.

Prywatny helper przygotowuje prelisten restore po sprawdzeniu przypiętego
rekordu, fizycznego bindingu magazynu, dokładnego fence, braku metadanych
resident service, semantycznej kapsuły i manifestu kandydata. Nie zmienia
receipt ani admission i sam nie dowodzi exit procesu. Binding Windows
korzysta z kernelowej ścieżki GetFinalPathNameByHandleW i reprezentacji
UTF-16LE zgodnej z Rust.

Verifier uruchamia osobny API z przypiętych produkcyjnych EXE. Sprawdza
scenę przy pierwszym poprawnym HTTP, nowy UUID API, własność procesu,
binding OpenAPI oraz prywatne przejęcie sceny z nowym session ID i epoch 1.
Generacja watchera pozostaje wspólna dla jego lifetime. Commit, fence
i staged receipt muszą pozostać niezmienione.

## Dowody

- `just verify-windows-development-handoff`: 123 interpretowane regresje,
  0 pominięć, exit 0. Receipt:
  `development-handoff-checks/checks/683a673c46e04d1bbc6c9f2dcfe8c5cb/receipt.json`.
  Digest: `5574735c21993062d9d3d8790e4545b7ff89af6603f33f48d0ab7a2415712bd1`.
  Obejmuje obcy magazyn, skopiowany commit/fence, zmienione piny,
  service metadata, uszkodzonego kandydata i bezmutacyjne przygotowanie.
- Produkcyjny `just windows-workspace-build dev dev 3197 auto`: exit 0.
  Log: `windows-native-fdm-cpu-dev/windows-runtime/lost-ack-replacement-route-build.log`.
  Nie kompilowano testów jednostkowych. Pierwszy build wykrył E0507;
  helper oczekiwania przyjmuje teraz guard przez wartość.
- `just verify-windows-development-backend-api`: 186 sprawdzeń, exit 0,
  60 procesów w inventory, wszystkie `waited=true`. Receipt:
  `development-backend-api-checks/checks/4bee1fb49acf4495b667033f0bc28391/receipt.json`.
  Backend source: `e9590700ab13a73eff8e39bbc5a445557aba911815ae999e36e83ac7af527987`.
- Zwykły ACK: stary API `1380c5d5-9f0e-40f7-b826-59facc8c57f2`, nowy
  `4035a13f-7ca5-406c-bc41-b3a375035612`; kapsuła
  `42ae0dc0-972a-401e-83fe-f02362097538`.
- Utracony ACK: stary API `605fd1c7-5bd9-4385-afbf-8c2aacaf6347`, nowy
  `12d14921-97c2-4946-954b-8ce91477c264`; kapsuła
  `c7ecc7c9-1af9-42a1-8e15-223e50f88fa7`.
- Nieudana sonda zachowana:
  `development-backend-api-checks/checks/d366978958814a5f993a1a0d50bf7c20/receipt.json`.
  Powód: zła ścieżka OpenAPI; poprawiono na `/v2/platform/openapi.json`.
  Kolejna próba użyła nowych magazynów, bez ponowienia istniejącego commit.
- Review źródłowe bez kolejnych actionable findings po poprawieniu kontroli
  bindingu i kontraktu statusu. UI użytkownika na 3197 pozostało uruchomione;
  końcowy HTTP 200.

Ścieżki receipt/log są względem `storage/builds/fullmag-0950f4dca4ffe38f`.

## Granica i następny krok

Odtworzenie potwierdzono w osobnych procesach sondy z małą sceną authoring.
Nie dowodzi to odtworzenia geometrii, regionów i materiałów w przeglądarce.
Nowe API sondy zakończono tylko w jej cleanup, bez Compute; odnotowany exit 1
oznacza to zakończenie, a nie graceful shutdown użytkownika. Stare API kończą
się graceful. Fence pozostaje zamknięty.

Pozostają: produkcyjny koordynator replacement, atomowe zakończenie lifecycle
z otwarciem admission i archiwizacją jednorazowego commit, ponowny restart
tego samego magazynu, warm service drain, ochrona szkiców, hydration UI
i browser z niepustą geometrią/regionami/materiałami. Nie ustawiono
`restart_available=true`. Natywne Windows FEM i kwalifikacja wydania
pozostają odrębnymi, niepotwierdzonymi bramkami pełnego planu.
