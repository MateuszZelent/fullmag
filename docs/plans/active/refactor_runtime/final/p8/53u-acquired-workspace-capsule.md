# P8-53U — kapsuła przejętego workspace, również bez sesji

## Zachowanie

Prywatny helper `development_acquisition_handoff.stage_acquired_workspace`
łączy zaufaną tożsamość ownera, kanoniczne przejęcie API, zweryfikowany pakiet
kandydata oraz osobny payload frontendu. Przed zapisem wymaga zgodności UUID
API, session_id i epoki UI z przejęciem; brak lub inna tożsamość blokują zapis.
Binding celu pochodzi z manifestu kandydata, nie z danych UI.

Helper sprawdza pełną ramkę przejęcia, hash sceny oraz dokładny kształt identity.
Do kontroli hasha zachowuje zapis liczbowych tokenów producenta Rust: drukarka
float Pythona może inaczej zapisać wykładnik. Kapsuła zachowuje semantyczny JSON.
Po atomowym staging odczytuje kapsułę, sprawdza hash/receipt `staged`, porównuje
oryginalną scenę (`source_scene`) i dane editor/workspace/project_document.
Błąd readback nie jest sukcesem; kompletna kapsuła zostaje do rozpoznania awarii.

Pusty workspace ma odrębny schema `fullmag.development-empty-workspace-handoff.v1`:
`session_id=null`, `scene=null`, bez assetów. Zachowuje dokument projektu,
edytor i stan workspace. Nie tworzy fikcyjnej sceny ani sesji. Warianty v1/v2
nadal wymagają niepustego session_id i obiektu sceny. Przygotowanie replacement
dla pustej kapsuły zwraca brak envelope sceny; przyszły manager musi sprawdzić
puste nowe API, jego świeże UUID i odtworzyć payload UI przed `restored`.

## Granice

To produkcyjna warstwa przygotowania zapisu i readback, bez komendy użytkownika.
Nie otrzymuje tokenu ownera, nie potwierdza aktualnego freeze, nie zatrzymuje
procesów i nie publikuje `restored`. CLI manager musi po staging wykonać
`confirm_held`, a commit połączyć atomowo z aktualnym guardem oraz global idle.
Transport danych frontendu po Apply/Save/Cancel, consumer CLI, shutdown,
replacement i hydration nadal pozostają do podłączenia. Nie przedstawiamy
zachowania szkiców w fixture jako dowodu rzeczywistego przebiegu UI.

## Weryfikacja

`just verify-windows-development-handoff`: **96/96**, zero skip, exit 0.
Receipt: `development-handoff-checks/checks/f37b3b2f51824b749f678f7efb8a6a3b/receipt.json`.
Digest źródeł przed/po:
`1fd4a6d6cb058f1d0ee485d83e6d4441beb249ec6d6e24685d2a634ab8096c20`.
Obejmuje scenę i brak sesji, scope frontendu, legacy null rejection,
corruption, guarded terminal states i readback failure z zachowaniem kapsuły.

Produkcyjny Windows dev build: exit 0. Sonda rzeczywistej ramki przejęcia API
przekazanej do walidatora staging oraz istniejące runtime gates: **98 sprawdzeń,
18 własnych procesów z potwierdzonym wait**, exit 0.
Receipt: `development-backend-api-checks/checks/3dee58c961e64e2eaef5ac69c8a03978/receipt.json`.
Backend digest przed/po: `371c9e74b05f67d83a191165e8d9cc1745a2da2473457430b45ddf83eb4a58af`.
Snapshot: `01a1f8974f9124e88621ad65c5fff30c2f0d9d802d4acc7934c4986d182c1c70`.
Sprawdzenie `private-acquisition-production-stager-validates-rust-wire-and-digest`
używa ramki produkcyjnego API, odrębnie od interpretowanego wzorca liczbowego.
UI 3197 zachowano i odczytano HTTP 200. Nie jest to proof restartu/hydration.
Pierwsza próba (`23bdf6ac56ba4590adde4a751f2dee0a`, failed, 22 sprawdzenia)
przekazała socketowy bufor `bytearray` zamiast wymaganego `bytes`; poprawiono
konwersję w sondzie bez zmiany danych i produkcyjnego helpera. Receipt zachowano.
Nie kompilowano testów jednostkowych.
