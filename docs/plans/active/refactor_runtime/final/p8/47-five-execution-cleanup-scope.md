# P8-47 — dokładny zakres ewentualnego sprzątania przed buildem 218

Data: 03.10.2026. Status: **propozycja, wykonanie niezatwierdzone i niewykonane**.
Audyt [P8-46](46-read-only-execution-verifier.md) przeszedł review i świeży skan.
Procedura wykonawcza, aktualna kontrola aktywnych użytkowników i osobna zgoda
pozostają otwarte; pozytywny audyt nie stanowi uprawnienia do zastosowania.

Znane różnice źródeł zachowano w [kopii P8-48](48-execution-source-preservation.md):
dziesięć plików z pięciu katalogów, dokładne bajty i hashe. To nie zamyka
kontroli dodatkowych plików, zachowanych artefaktów ani świeżości stanu procesów.
Nie zmieniono `source_match=false` na wynik pozytywny.

## Zakres decyzji operatora

Proponowane usunięcie obejmuje wyłącznie pięć poniższych katalogów
`execution` zakończonych buildów. Każdy miał potwierdzony zatrzymany worker
z pełnym identyfikatorem kontenera. Dwa pozostałe katalogi z P8-44,
dla których obiekt Docker już nie istnieje, nie są częścią tej propozycji.

| Job | Dokładny katalog do ewentualnego usunięcia |
|---|---|
| `04112e6cb0fd42058b952f5e284d6fb6` | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\04112e6cb0fd42058b952f5e284d6fb6\execution` |
| `ffb5dd9294b24b6ab869266b99d95b49` | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\ffb5dd9294b24b6ab869266b99d95b49\execution` |
| `bdd65936cfcc45b58a07879dd2e7ae3a` | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\bdd65936cfcc45b58a07879dd2e7ae3a\execution` |
| `9eb85e72e82048f2b7e0558b86d66014` | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\9eb85e72e82048f2b7e0558b86d66014\execution` |
| `7953ba4088a142c889c5ed9c12be7332` | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\7953ba4088a142c889c5ed9c12be7332\execution` |

Suma rozmiarów logicznych plików tych pięciu katalogów wynosi
**12 969 765 569 B ≈ 12,079 GiB**. Faktyczne odzyskanie miejsca trzeba zmierzyć
po operacji; twarde linki, alokacja i współdzielenie plików mogą zmienić wynik.

Katalogi źródłowych kapsuł, `artifacts`, `trusted`, receipty, `coordinator.json`,
logi, współdzielone build/cache, katalogi sesji i pozostałe runy zostają poza
zakresem. Build 218 oraz jego kapsuła nie należą do powyższych pięciu jobów.

## Przygotowanie i warunki wykonania

1. Przypiąć zaakceptowaną wersję odtwarzalnego verifiera P8-46; wykonać fresh
   audit wszystkich pośrednich komponentów i pełnych łańcuchów linków.
   Potwierdzić brak unknown tags, missing targets, cykli, external targets,
   odwołań do współdzielonego cache oraz traversal w katalogach nadrzędnych.
2. Potwierdzić zgodność źródłowych plików z zachowanymi kapsułami. Nie usuwać
   niewyjaśnionych lokalnych zmian, ręcznych dopisków ani unikalnego wyniku
   spoza zachowanego kompletu artefaktów.
   Znane dwa pliki per job mogą być rozliczone wyłącznie przez dowód P8-48:
   świeży hash oryginału musi być identyczny z zachowaną kopią i jej wpisem
   w proof. Wymagać dokładnie tych dziesięciu różnic, bez dodatkowego wpisu,
   brakującego pliku czy innego hasha. `source_match` pozostaje wtedy false;
   osobny wynik zachowania różnic nie zastępuje kontroli kapsuł i extras.
3. Uzyskać osobną zgodę użytkownika na powyższe dokładne cele. Ogólna zgoda na
   kontynuację refaktoru ani poprzednie usunięcie cache nie obejmują tych danych.
4. Przed zastosowaniem ponowić identyfikację właściciela, stan jobów i
   receipts, źródła, kontenery, mounty i procesy. Dla tego przyrostu stosować
   własną kontrolowaną pauzę kolejki tylko po sprawdzeniu braku aktywnego joba.
   Nie przerywać cudzej pracy. Jeśli stan się zmienił, przerwać apply.
5. Usuń wyłącznie wpisy linków z aktualnej sprawdzonej listy, pojedynczym
   `Remove-Item -LiteralPath`, bez `-Recurse`, zgodnie z fixture P8-45.
   Weryfikować dokładny path, jego przodków i niezmienność tożsamości przed
   każdym usunięciem. Nie wywoływać rekursywnego usuwania drzewa z reparse.
6. Po odłączeniu wszystkich linków ponownie udowodnić brak reparse points
   oraz dokładny containment. Dopiero wtedy usuwać zwykły katalog execution
   w PowerShell przez `-LiteralPath`. Zachować dowody poza tym katalogiem.
7. Zweryfikować zachowane kapsuły, receipty i artefakty, zmierzyć wolne miejsce,
   zapisać faktyczny wynik oraz wznowić wyłącznie własną pauzę. Obserwować
   istniejący job 218; nie zgłaszać zastępczego buildu z powodu oczekiwania.

Ta propozycja nie zmienia automatycznej retencji: jej odmowa
`unsafe_execution_tree` pozostaje. Jest zakresem przyszłej osobno
autoryzowanej operacji operatora, z dodatkowymi dowodami i odmową przy zmianie
warunków. Nie stanowi uprawnienia do kasowania ani kwalifikacji buildu.
