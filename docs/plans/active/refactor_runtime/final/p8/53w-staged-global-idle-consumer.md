# P8-53W — bramka globalnego idle dla przejętej kapsuły

## Zachowanie

CLI wymaga kapsuły zapisanej przez to samo przejęcie API. Prywatne nonce i UUID
nie pochodzą z edytowalnego payloadu UI. Przed drain potwierdza aktualny guard.
Wspólny klient sprawdza rzeczywisty dokument v2 API: jego źródła, UUID i binding
magazynu zaakceptowanych runów muszą pasować do wybranego service. Brak bindingu
nie jest dowodem pustej kolejki. Kontrola następuje przed mutującą komendą drain.

Następnie istniejący protokół ownera sprawdza globalny stan magazynu, zakłada
trwały admission fence i potwierdza terminalne dzieci compute/preparation.
Klient sprawdza pełny owner/config i zapisany fence, ponownie weryfikuje API,
a CLI potwierdza ten sam guard przejęcia. Każdy błąd unieważnia prywatny stream.
Nie uruchamiamy service, nie ponawiamy drain ani nie zwalniamy fence po błędzie.
Po niepewnym wyniku fence pozostaje do jawnego rozpoznania i recovery.

To przygotowanie do commit, nie atomowa zgoda na shutdown: commit musi jeszcze
sprawdzić aktualny guard, kapsułę, pakiet kandydata i dokładny trwały marker.
Nie ma konsumenta restartu w UI ani zastąpienia procesu API.

## Weryfikacja

Dwa zarządzane natywne buildy dev zakończyły się exit 0. Końcowa sonda wymaga
dokładnej przyczyny odmowy bindingu i staged nonce; przypadkowy błąd HTTP nie
zalicza tych bramek. Review produkcyjnego delta nie znalazł nowych błędów.

`just verify-windows-development-backend-api`: **105 sprawdzeń**, exit 0,
**21 procesów** z potwierdzonym wait. Receipt:
`development-backend-api-checks/checks/593971162f01415790fe317e5c7ed37e/receipt.json`.
Digest backendu przed/po:
`78bb690f495990c6c1d701f5706cde53bd8999746ba3c3af0735f32e9f0793a9`.
Snapshot buildu:
`a113d2640f7428b765d095e04997c6ae2ed684c99cce9a3900dd45fe5eaa314a`.
Poprzednią zieloną sondę `1c3f223a533e43b28b14e56e3c1c0079` zachowano.
Ponowienie objęło poprawkę samego verifiera: po wysłaniu idle drain utrata
wyniku klienta nie wywołuje drugiej komendy lifecycle. Verifier czeka na swój
service i zachowuje niepewny stan; nie zatrzymuje go jako automatycznego cleanup.
Końcowy PASS nie dowodzi wstrzykniętego fault gate utraty ACK.

Sonda potwierdza, że niepowiązane API i kapsuła z wcześniejszego przejęcia są
odrzucane. Service pozostaje Ready bez fence po odmowie. Odrębny rzeczywisty
klient Rust wykonuje idle drain własnego service testowego, z konkurencyjnym
WRITER, sprawdza oba terminalne dzieci oraz dokładny trwały fence. Verifier
porównuje hashe ownera i markeru z zapisem na dysku; nie używa już surowej ramki
Pythona jako pozytywnego dowodu klienta Rust. Nadal obejmuje historyczne taski,
lease poza bieżącą pulą i nieznany marker blokujące globalne idle.

Nie kompilowano testów jednostkowych. Kod kapsuł i jego 101 interpretowanych
sprawdzeń z P8-53V pozostają bez zmian; dowód nie wymagał ponownego wykonania.
UI 3197 po sondzie odpowiada HTTP 200 i nie był restartowany.

## Otwarte bramki

Pozytywny przebieg przejęcie + staging + API z pasującym bindingiem + globalny
drain jako jedna transakcja pozostaje **NOT VERIFIED**. Dowody odmowy i drain
są odrębne. Potrzebna jest również trasa dla zimnego magazynu bez resident
service, chroniona przed równoległym startupem; samo NotConfigured nie wystarczy.
Atomowy commit, graceful shutdown API, replacement, nowy pin i rzeczywiste
hydration UI pozostają otwarte. Procenty całego planu bez awansu.
