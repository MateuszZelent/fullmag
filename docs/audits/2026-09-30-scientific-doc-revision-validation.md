# S01 — walidacja strony i źródeł na tej samej rewizji

validate_changed_scientific_docs czytał source-map z --head, ale dla zwykłej
strony publikacyjnej validate_page odczytywał Markdown i deklaracje źródeł
z roboczego checkoutu. Dirty worktree mógł zarówno zepsuć poprawny commit,
jak i ukryć błędną stronę lub brak symbolu w commicie. To błąd dowodów,
nie dowód niewłaściwych jednostek w samej stronie.

validate_page ma teraz opcjonalny czytnik zawartości. Zwykła kontrola lokalnej
strony pozostaje filesystem-based; changed-page checker podaje czytnik Git
na --head dla strony i jej source anchors. Nie pomija kontroli równań,
symboli, jednostek, czterech realizacji, publicznych parametrów ani mapowania.
Nie zmienia publicznych instrukcji skilla, parametrów solvera ani tolerancji.

Regresje RED: trzy przypadki mieszania rewizji zawiodły. GREEN: pełne 35
lekkich testów narzędzia PASS, w tym kompletna strona i odrzucanie brakujących
jednostek, realizacji, symboli, parametrów oraz niepoprawnego mapowania.
Kontrola rzeczywistej zmienionej noty 0831 dla zakresu
692e57707706b9d69ced8c39928c49be089a1d54..b5a77f982d4f6ac4bbca81514f18181861bde1e6:
exit0 mimo zachowanego WIP strony i źródeł. git diff --check: exit0.
To dowód struktury dokumentacji na rewizji, nie runtime ani nauki.
Wyjątki scaffold i oddzielny kontrakt numerical-methods nie były zmieniane.

## Storage — aktualizacja oczekującej decyzji

#179 nadal queued, potwierdzone klientem; wolne miejsce 5647167488 B.
Stare sześć execution (~2.49 GiB) już nie wystarczy. Zweryfikowano dodatkowe
#164 24694a78889945628e811132ccb5b999 (447423992 B) i
#159 320a1f270cf54c5da4340cf12ec9fe09 (447370965 B), bez przechodzenia linków.
Wszystkie osiem jobów ma succeeded/exit0 i tożsamość tego worktree.
Nowa prośba o osiem execution (~3.32 GiB) zastąpiła starą niezaakceptowaną.
Brak odpowiedzi; NICZEGO nie usunięto. Przed ewentualnym usunięciem nadal
wymagane są aktualne kontrole aktywnych użytkowników, mountów i celów ścieżek.
