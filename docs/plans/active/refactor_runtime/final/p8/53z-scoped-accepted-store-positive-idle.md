# P8-53Z — izolacja danych i pozytywna bramka zimnego magazynu

## Zachowanie

Opcjonalny `FULLMAG_ACCEPTED_STORE_SCOPE` wybiera odrębny magazyn danych
workspace wewnątrz istniejącego storage. Wymaga kanonicznego niezerowego UUID.
Ścieżka zarządzana to `runs/<worktree>/workspaces/<UUID>/session-store`;
namespace źródeł, profil i pakiet kandydata pozostają bez zmian. Bez scope
pozostaje dotychczasowy magazyn. Błędny scope powoduje odmowę bez fallbacku.
Resolver zachowuje walidację rzeczywistego worktree i kanonicznego storage.

Ukryta zarządzana komenda inicjalizuje wyłącznie nowy scoped store. Publiczna
granica `repository_path::create_new_directory` sprawdza lokalny filesystem,
containment, wyłączne utworzenie katalogu i dostępne bariery publikacji rodzica.
Istniejący katalog oraz częściowo zakończona inicjalizacja nie są nadpisywane.
Windowsowa trwałość katalogów przy utracie zasilania pozostaje NOT VERIFIED.

Własne API weryfikatora otrzymuje prawdziwy resolver oraz osobny UUID danych.
Launcher przejmuje pusty workspace, zapisuje i ponownie odczytuje kapsułę,
potwierdza binding API do tego magazynu i uzyskuje rezerwację zimnego store.
Ten sam przebieg wykonuje następnie dla modelu. Fence jest zwalniany przez
jawną decyzję zakończenia własnej sondy; nie jest to zatwierdzenie restartu.
Magazyn sondy i jego receipt pozostają zachowane. Dane aktywnego UI nie są
używane, migrowane ani usuwane.

## Dowody

Zarządzany `just windows-workspace-build dev dev 3197 auto`: exit 0.
Pierwszy build wykrył niedostępną granicę `pub(crate)`; poprawiono ją przez
publiczną operację wyłącznego tworzenia katalogu i ponowiono build.
Review poprawionego zakresu nie znalazł actionable findings.

`just verify-windows-development-backend-api`: **121 kontroli**, exit 0;
**31 procesów** z potwierdzonym wait. Nie kompilowano testów jednostkowych.
Receipt względem `storage/builds/fullmag-0950f4dca4ffe38f`:
`development-backend-api-checks/checks/4154cba87a8e4160882465da00afec7a/receipt.json`.

- Digest backendu przed/po: `7cc3fc7e53c4b65224258f4fc77dd5e304d3de10ddddeda90d4f9ade9cb563b5`.
- Snapshot buildu: `1dbf5c5cf1ae3d691dbbe915b91249ae8347dff27c4c4e295e52ceeba17a0a14`.
- Scope sondy: `eba4eca3-aef5-46e7-b003-eb88f555f484`.
- Binding magazynu: `36a4ff5ce59aff4e1a58e2705980534565d574fc623e46e7f56b7a8f22456c0b`.

Kontrole obejmują zgodność bindingu z inicjalizacją, pozytywny cold idle po
stagingu i readbacku pustego workspace oraz modelu, zachowanie lokalizacji
bez scope, brak fallbacku dla błędnego scope, odmowę ponownej inicjalizacji
i wcześniejsze negatywne kontrole obcego przejęcia/magazynu. HTTP UI na 3197
odpowiadał 200 bez restartu; to kontrola zachowania istniejącej sesji,
a nie dowód odtworzenia nowego UI.

## Pozostałe bramki

Pozytywny połączony przebieg zimnego magazynu jest zweryfikowany. Odpowiednik
z działającym service, atomowy commit, graceful shutdown starego API,
potwierdzony exit, replacement, nowy pin i hydration szkiców w przeglądarce
pozostają otwarte. `restart_available` pozostaje `false`; procent całego planu
nie jest zwiększany na podstawie tego przyrostu.
