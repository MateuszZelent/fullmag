# P8-53AJ — natywne uruchomienie replacement API

Data: 04.10.2026. Zakres: koordynator natywnego Windows dev po zaakceptowanym
cold commit. P8-53 i cały plan pozostają otwarte.

## Implementacja

Supervisor przygotowuje kapsułę dopiero po odebraniu rzeczywistego Child starego
API z exit 0 i uzgodnieniu trwałego commit. Zarządzany helper sprawdza kapsułę,
magazyn oraz zapieczętowany pakiet. Launcher uruchamia dokładny EXE kandydata,
podaje odtworzoną scenę przez zamknięty stdin przed nasłuchiwaniem HTTP i
potwierdza świeżego ownera, UUID API oraz nową sesję.

ControlRoomGuard przejmuje nowy Child przed jednorazowym completion. Nieznany
wynik zachowuje custody i odmawia shutdown; nie wywołuje retry ani zwolnienia
fence. Sukces wymaga zgodności rzeczywistej sceny z semantycznie odczytaną
kapsułą, zgodnego completion ACK i ponownego dopuszczenia mutacji.

Review wykrył utratę custody przy completion przed przejęciem nowego procesu.
Kolejność poprawiono przed końcową próbą. Próba runtime wykryła również zmianę
zapisu ścieżki Windows z `C:\...` na `\\?\C:\...`: ten sam fizyczny katalog
dawał inne ścieżki assetów w scenie. Owner zachowuje oryginalny zapis rootu,
sprawdzając ponownie jego fizyczną tożsamość i brak reparse points. Semantyczna
kontrola sceny pozostaje obowiązkowa.

## Dowody

- `just windows-workspace-build dev dev 3197 auto`: exit 0 po poprawce ścieżek.
- `just verify-windows-development-backend-api 809ee2d2d6ae48ee8fb20b0fb760b5dc`:
  **398 kontroli, exit 0; wszystkie 142 procesy odebrane**.
- Receipt względem storage resolvera:
  `builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/4f4951a863e941189f32cb9e7620d992/receipt.json`.
- Log: `windows-native-fdm-cpu-dev/windows-runtime/owned-api-replacement-path-runtime.log`.
- Snapshot buildu: `e45a6519105a93d6b91ee12daa0aea9c061d3b0f7a989be069756b354a8ee16f`.
- Build commit: `421442b1f4d123fe927176af7ee87d1a3ee361d7` z zapisanymi zmianami WIP.
- Backend source przed/po:
  `f93f87200efd605d78cd63417343c76c05056d484a863e442de787b3a6b96009`.

Diagnostic korzysta z tego samego supervisora i Guard co launcher. Obejmuje
odtworzenie sceny z assetem, świeżą sesję, completion i zapis HTTP, także dla
innego buildu po utracie ACK starego API. Fixture jawnie zamyka swój replacement
po próbie bez Compute i zapisuje rzeczywisty wait; nie jest to graceful exit
produkcyjnego workspace. Nie kompilowano testów jednostkowych. Diff check i
scoped rustfmt przeszły; poprawki custody i ścieżek przeszły review.

## Zachowana nieudana próba

Receipt `a03bd1275a7d4d74ab8108536a877b65` pozostaje failed. Replacement PID
249132, start `2026-10-04T10:21:03.142434+02:00`, bundle
`3ce0f1a6852543eabc545bbc08da369b`, port 34126 i API
`202f1946-efa0-4b85-9be1-015a88ba8375` nie zostały automatycznie zatrzymane.
Odczyt diagnostyczny potwierdził zachowane commit i fence, brak pending
completion i historii autoryzacji. Magazyn scope
`5ee908bf-04bf-4fb8-9c4f-24a1f049aa1a` pozostaje zamknięty. Zielona ponowna
próba używa osobnych danych i nie stanowi recovery tego procesu.

## Pozostałe bramki

Przycisk i transport restartu z UI, dokument projektu, niezapisane formularze,
hydration, drugi pełny restart, Compute, warm service i fault injection
nieznanego completion pozostają **NOT VERIFIED**. SceneDocument nie odtwarza
automatycznie ProjectDocumentResource; przeniesienie projektu wymaga jawnej
kontroli archiwum, revision oraz dirty/persisted state. `restart_available=false`.
Procenty całego planu pozostają bez awansu. UI użytkownika jest zamknięte.
Publikację na publicznym remote nadal blokuje automatyczna kontrola zgody.
