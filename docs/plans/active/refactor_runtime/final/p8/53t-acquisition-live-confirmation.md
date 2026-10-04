# P8-53T — aktualne potwierdzenie przejęcia authoring

Przyrost P8-53 po podłączeniu ownera CLI. Pełny restart nadal w realizacji.

## Kontrakt

Prywatny kanał ownera przyjmuje `confirm` na tym samym połączeniu co `acquire`.
Schema, token, UUID API oraz nonce muszą odpowiadać bieżącemu przejęciu.
Odpowiedź `fullmag.development-api-confirm.v1` potwierdza, że API nadal utrzymuje
guard authoring w chwili odpowiedzi. Nie zwalnia admission ani transition lock.
`abort` nadal zwalnia guard przed swoim ACK.

Potwierdzenia nie przedłużają bezwzględnego limitu 30 sekund. Nieprawidłowa ramka,
disconnect lub upływ limitu kończą przejęcie. Klient CLI po błędzie potwierdzenia
zamyka kanał i nie dopuszcza dalszego użycia tego przejęcia.

To potrzebna granica dla zapisu kapsuły: posiadanie snapshotu w pamięci nie
dowodzi utrzymania blokady podczas kopiowania plików. Potwierdzenie pozostaje
obserwacją, a nie zezwoleniem na późniejsze zabicie procesu. Przyszły commit
musi atomowo zweryfikować nadal aktualny guard, trwały ACK kapsuły oraz osobny
globalny idle/drain przed kontrolowanym shutdownem.

## Weryfikacja

Produkcyjna sonda CLI sprawdza kolejne potwierdzenia, blokadę HTTP po ACK,
rzeczywiste wygaśnięcie mimo kolejnych potwierdzeń, odrzucenie użycia wygasłego
kanału oraz ponowne otwarcie admission. Sonda API sprawdza również obcy nonce.
Nie zmienia timeoutu serwera i nie uruchamia kompilacji testów jednostkowych.

Managed Windows dev build: exit 0. `just verify-windows-development-backend-api`:
exit 0, **97 sprawdzeń**, **18 własnych procesów z potwierdzonym wait**.
Receipt: `development-backend-api-checks/checks/2917debc930f4007877b0d5cf1ef9e97/receipt.json`.
Backend digest przed/po: `721f3eb47ab2e2e3287eed1c68b53f12d99fc9848b5907b14c3e37783c100a31`.
Snapshot: `700cfd25db2073860d9243a7c4da9e5fd9769bd55c81e493fc47fea5c90713b9`.
UI użytkownika na 3197 zachowano, HTTP 200; nie jest to dowód świeżego startu
pełnego workspace po tej zmianie. Nie kompilowano testów jednostkowych.

Pierwsza sonda (`6f2743b7fb5e47c99abea46da603d3e1`, failed, 63 sprawdzenia)
użyła starej rewizji sceny po wcześniejszym udanym PUT. API prawidłowo zwiększa
rewizję przy zapisie. Poprawiono sondę przez readback bieżącej sceny przed
sprawdzeniem ponownego otwarcia admission; dopiero ponowny build/runtime daje
powyższy PASS. Nieudany receipt zachowano.

Otwarte: zapis kapsuły z payloadem frontendu, atomowy commit przejęcia,
globalny drain, graceful shutdown, replacement API, szkice i hydration nowego
pinu. Publiczny restart pozostaje wyłączony; procenty całego planu bez awansu.

## Następna integracja

Manager użyje `development_scene_handoff.create_scene_handoff` i następnie
`load_scene_handoff` z tym samym zaufanym bindingiem. Porównuje snapshot hash,
`source_scene` (scena `scene` loadera ma celowo przebazowane ścieżki assetów),
editor, workspace i project_document oraz stan receipt `staged`. Dopiero po
readback i aktualnym potwierdzeniu przejęcia może próbować atomowego commit.
`restored` wymaga dowodu nowego API po instalacji modelu i otwarciu listenera.

Binding pochodzi od ownera: stare API/session/epoch, generacja, wersja bieżącego
API i digest jego backendu; target to manifest SHA256 zweryfikowanego kandydata.
Payload frontendu musi pochodzić z rozstrzygniętego Apply/Save/Cancel. Obecny
acquire nie zawiera dokumentu projektu ani pełnego stanu UI. `no_session` nie
ma sceny/session_id: obecny format kapsuły nie obsługuje tego przypadku i nie
wolno go obejść przez wymyślenie tożsamości. Potrzebna jest jawna gałąź pustego
workspace zachowująca osobne dane projektu/UI.
