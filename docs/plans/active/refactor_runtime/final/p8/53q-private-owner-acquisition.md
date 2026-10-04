# P8-53Q — prywatne przejęcie authoring przez właściciela API

Data: 04.10.2026. Status: **IMPLEMENTED / runtime acquisition PASS**;
pełny restart workspace nadal **NOT VERIFIED**. Kontynuacja ADR 0050 i P8-53.

## Zmiana produkcyjna

`development_owner_control.rs` jest podłączony do startu API. Bez
`FULLMAG_DEVELOPMENT_OWNER_TOKEN` kanał pozostaje nieaktywny. Token wymaga
poprawnej konfiguracji managed dev; błędna konfiguracja zatrzymuje start przed
listenerem HTTP. Kanał używa IPv4 loopback i losowego portu.

Po związaniu listenera HTTP API publikuje prywatny rekord
`runtimes/<worktree>/development-api-owner-<API UUID>.json`. Rekord wiąże PID,
port HTTP, API UUID, adres kontrolny i skompilowany commit/snapshot; zawiera
hash tokenu, bez jawnego tokenu. Publikacja korzysta z walidowanych ścieżek,
blokady WRITER i atomowego zapisu; nie zastępuje istniejącego rekordu.

Ramka `fullmag.development-api-control.v1` wiąże token, API UUID i świeży nonce.
Nieznane pola i błędne dane są odrzucane. `acquire` uruchamia istniejący guard:
zamyka admission, odczekuje dopuszczone operacje, przejmuje transition lock
i sprawdza stan authoring/runtime. Odpowiedź zawiera pusty workspace albo pełną
kanoniczną scenę, jej digest i tożsamość sesji/epoki. Guard jest utrzymywany
na tym samym połączeniu do `abort`, błędu, rozłączenia lub limitu czasu.

Pierwsza ramka ma limit 4096 bajtów i 2 sekund, acquisition 5 sekund,
odpowiedź 64 MiB. Całe połączenie ma limit 30 sekund, obejmujący dostarczenie
sceny i oczekiwanie na abort. Nie jest to odnawialny lease. Manager musi
uwzględnić wygaśnięcie; na tym etapie nie ma komendy commit ani shutdown.

## Dowody

- Zarządzany natywny `windows-workspace-build dev dev 3197 auto`: exit 0;
  API/CLI 150 s, desktop 41,91 s. Profil `backend-dev`, bez testów jednostkowych.
- `verify-windows-development-backend-api`: 69 sprawdzeń, exit 0; wszystkie
  16 własnych procesów fixture odczekane. Receipt
  `development-backend-api-checks/checks/02f509df30a1434fa9248d0610bcb85c/receipt.json`.
- Odrzucono błędny token, API UUID, nonce, dodatkowe pole i konfigurację
  ownera poza managed dev. Sprawdzono rzeczywiste przejęcie pustego workspace
  i sceny odtworzonej przed listenerem z epoką 1, zgodność sceny oraz SHA256.
- Admission pozostaje zamknięte ponad 2 sekundy; jawny abort i rozłączenie
  ponownie pozwalają tworzyć/edytować model. Scena jest porównywana przed
  freeze, ponieważ jej GET także podlega admission.
- Backend digest przed/po:
  `c8ee56d40cb650e4e3bb3256eb13dc0bb6fd9d0b9f5f05f2aaac1b1f11b1fe6e`.
  Snapshot buildu: `a7e5369caede14875e7fc1d82df0413b2d0f4f82148c2dfc813899f8f5b5f7d1`.
  Baza: `ecb0948fcf9ba903b35f3894339ea4e3dbbf2fea` + ten przyrost.
- Review źródłowy wskazał zbyt krótki czas oczekiwania na abort i odczyt
  sceny podczas freeze; oba poprawiono przed końcowym dowodem runtime.

## Otwarte bramki

Próba z POST zawierającym body ujawniła reset TCP przy wczesnym odrzuceniu
przez admission. Obecny fixture potwierdza 409 dla POST bez body oraz skuteczną
edycję po zwolnieniu guard. Obsługa body odrzuconego żądania wymaga osobnej
poprawki i dowodu; nie zaliczamy jej na podstawie tych 69 sprawdzeń.

Nie zweryfikowano jeszcze timeoutu całego połączenia, konkurencyjnego właściciela,
aktywnego solve, power-loss ani kontrolowanego zamknięcia API. Kanał nie zastępuje
global idle/drain service, trwałego ACK kapsuły, supervisora CLI, walidacji
kandydata ani ochrony szkiców/repin/hydration UI. Publiczny restart pozostaje
wyłączony. Aktywne UI 3197 nie zostało zatrzymane ani zastąpione.

Następny krok: obsłużyć HTTP body przy odmowie admission, następnie podłączyć
managera do przejęcia i trwałego zapisu kapsuły przed commit/shutdown API.
