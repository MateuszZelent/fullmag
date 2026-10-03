# P8-46 — odtwarzalny audyt execution bez usuwania danych

Data: 03.10.2026. Status: **źródła, review i świeży skan PASS; sprzątanie niewykonane**.

Narzędzie `scripts/windows/audit_runner_execution_links.py` odtwarza kontrolę
z P8-44. Używa natywnych API Windows; nie uruchamia Dockera ani WSL i nie ma
operacji kasowania. Raport powstaje wyłącznie w nowym pliku poza execution
i kapsułami. Pełne mapy pozostają w kanonicznym storage; repozytorium zawiera
metadane i hashe dowodów.

## Zakończone poprawki po review

| Granica | Zachowanie |
|---|---|
| Reparse points | Odczyt tagów junction, Windows symlink i wersji 2 LX; nieznany tag lub niepoprawny payload powoduje odmowę. |
| Pośrednie komponenty | Każdy cel jest kontrolowany przed dołączeniem dalszej części ścieżki. Wyjście poza execution nie może zostać zamaskowane późniejszym `..`. |
| Niejasne ścieżki | Pusty target, NUL, drive-relative i nieobsługiwane device/Volume GUID są odrzucane. |
| Źródłowa kapsuła | Osobne `source/tree` jest porównywane z manifestem; kapsuła nie może nakładać się na execution. Pusty lub niepoprawny manifest jest odrzucany. |
| Dodatkowe wpisy | Skan obejmuje zagnieżdżone wpisy. Nieznane dodatki obniżają wynik; znane katalogi generowane mają jawną allowlistę i są raportowane. |
| Odczyt pliku | Bezpośrednio przed hashowaniem sprawdzane są przodki, leaf reparse i zwykły typ pliku. Odmowa następuje przed `open()`. |
| Dowód wyjściowy | Brak trybu nadpisania; istniejący lub dangling reparse output jest odrzucany. |

Allowlista katalogów generowanych jest częścią źródła audytora. Nie jest
automatycznym dowodem, że każdy plik w takim katalogu jest zbędny; przed
sprzątaniem pozostaje kontrola zachowanych artefaktów i zakresu operatora.

## Weryfikacja źródeł

`python -B scripts/test_runner_execution_links.py`: **18 testów PASS**, exit 0.
Testy są interpretowane; nie kompilowano testów Rust ani źródeł produkcyjnych.
Niezależny review końcowej poprawki oraz wcześniej poprawionych granic:
**PASS, bez pozostałych P0/P1 w tym zakresie**.

SHA-256 audytora:
`11ed2039837bb85ff4f9b0122ae0ed63131c39197166df02c756b277f04f7b4f`.
SHA-256 regresji:
`0d5902f2b34f17650dc44772b4f517cb46f7f17ed7b1193c5f1e0e98e42d206d`.

Nowy test potwierdza odmowę przed otwarciem pliku dla przodka reparse i leaf
reparse. Osobna regresja obejmuje konkretny przypadek z review:
`alias -> ..\outside`, `consumer -> alias\..\audit\secret`.

## Granice odbioru

Świeży pełny skan po ostatniej zmianie potwierdził 18 662 bezpiecznie
rozwiązane wpisy reparse siedmiu execution oraz integralność pięciu kapsuł.
Nie wykrył nieznanych zagnieżdżonych dodatków. Dziesięć znanych różnic plików
pozostaje jawnych: wynik źródeł i łączny `all_safe` są false.
Raport (61 843 324 B) znajduje się w
`C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\audit-execution-full-d6dfba736d684181af2d2d0deba7033c.json`.
Jego SHA-256:
`a54f00d328e311431ceef7c6c16cb25fe7a34675c16f777b0be38d9e855827d5`.
Metadane są przypięte do P8-44. Skan i zapis zakończyły się kodem 0;
hash źródła audytora nie zmienił się podczas wykonania.
Sam wynik `all_safe` opisuje wyłącznie wykonane kontrole narzędzia;
przy braku argumentów kapsuł nie dowodzi zgodności źródeł.

Narzędzie nie ustala aktualnego właściciela procesu, stanu kontenerów,
kompletności release artifacts ani zgody na usuwanie. Automatyczna retencja
nadal odmawia dla `unsafe_execution_tree`. [P8-47](47-five-execution-cleanup-scope.md)
pozostaje osobną niezatwierdzoną propozycją, a [P8-48](48-execution-source-preservation.md)
zachowuje dziesięć znanych różnic bez zmiany `source_match=false`.
Nie jest to kwalifikacja buildu, produktu Windows ani fizyki.
