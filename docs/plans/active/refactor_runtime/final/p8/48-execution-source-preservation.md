# P8-48 — zachowanie zmienionych plików przed ewentualnym sprzątaniem

Data: 03.10.2026. Status: **kopie zachowane; sprzątanie niewykonane**.

Porównanie pięciu katalogów z potwierdzonymi zatrzymanymi workerami z
[audytu P8-44](44-execution-cleanup-proposal.md)
wykazało po dwa pliki różniące się od manifestów źródłowych kapsuł.
Odczyt oryginalnych bajtów i porównanie tekstów po normalizacji CRLF wykazały
w każdym z pięciu jobów ten sam zestaw zmian:

| Plik | Różnica w execution wobec kapsuły |
|---|---|
| `apps/control-room/next-env.d.ts` | Import `.next/dev/types/routes.d.ts` zastąpiono `.next/types/routes.d.ts`; zachowano CRLF. |
| `pnpm-lock.yaml` | Dodano importer `apps/runner-console: {}` i pustą linię; 12 027 końców CRLF zastąpiono LF. |

To opis faktycznej różnicy, a nie dowód jej autora ani zgoda na usunięcie.
Nie zmieniono manifestów, źródeł ani wyniku `source_match=false`.
Hash SHA-256 ujednoliconego diffu wynosi odpowiednio
`ed921fa00464257925df0a8c20596b99b46a0274fdc16a8f2af1641fde922fdc`
i `e9eee123102273e21efac8900b7c827d033c6619503376556d2804a4fc7d173f`.

## Zachowane kopie

Resolver głównego checkoutu wyznaczył kanoniczny storage. W nowym katalogu
`runs/fullmag-0950f4dca4ffe38f/execution-source-preservation-e748d66bf7e54e3da22f644fd3d33bad/`
zachowano dokładne bajty wszystkich dziesięciu plików, osobno według JobId.
Łączny rozmiar kopii: **2 308 980 B**.

Przed odczytem sprawdzono containment i brak reparse point w przodkach każdego
pliku oraz katalogu dowodowego. Hash każdego oryginału sprawdzono przed kopią
i po niej; hash kopii był zgodny. Operacja PowerShell zakończyła się kodem 0.

Dowód znajduje się w
`C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\execution-source-preservation-e748d66bf7e54e3da22f644fd3d33bad\proof.json`.
SHA-256 tego pliku:
`8318d1315a1d17ebba660f4e6fbda52c32255a53b513d8bdc6eb7684c1056c25`.
Dokument zawiera dokładne ścieżki, rozmiary i hashe dziesięciu kopii oraz
`deletion_performed=false`.

## Pozostałe warunki

Kopie rozliczają te dziesięć znanych różnic. Nie dowodzą kompletności innych
plików dodanych podczas buildu, poprawności zachowanych kapsuł i artefaktów
ani braku aktywnych użytkowników. Te warunki wymagają osobnych kontroli.
Odbiór audytu opisuje osobny [raport P8-46](46-read-only-execution-verifier.md).
Niniejszy dowód kopii nie zastępuje tego audytu.
Automatyczna retencja pozostaje zamknięta dla `unsafe_execution_tree`.
Usunięcie dokładnych celów wymaga osobnej zgody zgodnie z AGENTS.md.
Build i natywne uruchomienie Windows pozostają **NOT VERIFIED**.
