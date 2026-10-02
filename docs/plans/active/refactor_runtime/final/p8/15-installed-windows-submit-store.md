# P8-15 — trwały Submit w zainstalowanym Windows

Data: 02.10.2026. Zakres: P8-C i docelowy desktop z P7-C.

Usunięty brak źródłowy: wybór store dla przyjmowanych runów wymagał konfiguracji
developerskiego checkoutu także po instalacji produktu. Natywne API Windows
bez tych zmiennych wybiera teraz zamrożony katalog danych użytkownika
`runs/session-store`. To osobna trasa produktu zgodna z
[ADR 0048](../../../../../adr/0048-installed-windows-run-storage.md).

Niepełne środowisko managed nadal odrzuca admission. Tożsamość pakietu
pochodzi z executable API. Walidacja odrzuca zapis w instalacji, ścieżki
względne, traversal oraz istniejące linki/reparse points; nie tworzy danych
podczas samego wyboru. Zachowane są bramki filesystemu i writera SessionStore.

Kontrole: rustfmt check adaptera PASS, parser `main.rs` z zachowaniem obcego
formatowania PASS, odnośniki nowych dokumentów PASS. Niezależne review
adaptera, callsite i konsumentów store root: brak P0/P1. Dodane
regresje Rust nie są skompilowane ani uruchomione zgodnie z aktualną regułą
operatora. Native Windows, Submit/restart i trwałość pozostają NOT VERIFIED.
Build 212 powstał ze wcześniejszego commita i nie obejmuje tego etapu.
Nie zmieniamy procentów planu ani nie zastępujemy runtime dowodem parsera.

Instancja testowa na 3104 jest zachowana z dotychczasową sesją; ta zmiana
nie aktualizuje jej obrazu ani nie migruje danych do nowego katalogu.
