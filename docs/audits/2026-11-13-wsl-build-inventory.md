# Inwentarz buildów i cache WSL — 2026-11-13

To wynik odczytu, bez usuwania danych. Katalog projektu:
`/home/kkingstoun/git/fullmag`; worktree zadania:
`/home/kkingstoun/git/fullmag/worktrees/interactive-study-t8-20261108`.

## Wynik

Nie znaleziono dużych zakończonych buildów WSL zakwalifikowanych do usunięcia.
Kanoniczne `storage/builds` zajmuje około 1,22 MiB, a lokalne katalogi
kompilatora znalezione w zarejestrowanych worktree są puste. Usunięcie samych
metadanych buildów nie zapewni miejsca na pełny eksport/import S46.

Pomiar statvfs z 2026-11-13T00:09:56.560455+00:00:

- dostępne zwykłemu użytkownikowi: 542527488 B (517.4 MiB);
- wszystkie wolne bloki: 19349782528 B;
- różnica niedostępna zwykłemu użytkownikowi: 18807255040 B (około 17.52 GiB).

Różnica dostępności bloków nie jest wynikiem sprzątania ani odzyskiem miejsca
na C:. Odczyt `tune2fs -l` wymaga uprawnień administratora, których `sudo -n`
nie udostępniało; nie zmieniano rezerwy ani innych ustawień ext4.

## Zmierzone pozycje

Ścieżki względne poniżej odnoszą się do katalogu projektu. Rozmiary `du -sx`
opisują inwentarz; nie dowodzą liczby bajtów możliwych do odzyskania.

| Pozycja | Bajty `du` | Decyzja |
|---|---:|---|
| `storage/builds` | 1,282,048 | Zachować: około 1,22 MiB metadanych; brak istotnego odzysku. |
| `storage/cache` | 8,192 | Zachować: pusty szkielet, 8 KiB. |
| `fullmag/target` | 4,096 | Zachować: pusty katalog, 4 KiB. |
| `fullmag-worktrees/relaxation-qualification-clean-20260820/target` | 4,096 | Zachować: pusty katalog, 4 KiB. |
| `/home/kkingstoun/.cache/go-build` | 353,447,936 | Nie zakwalifikowano: współdzielony cache, właściciel i konsumenci wymagają osobnej kontroli. |
| `/home/kkingstoun/.npm/_cacache` | 141,811,712 | Nie zakwalifikowano: współdzielony cache npm. |
| `/home/kkingstoun/.cache/node` | 67,981,312 | Zachować: nie ustalono, czy zawiera używany runtime narzędzi. |
| `/tmp/node-compile-cache` | 31,723,520 | Nie zakwalifikowano: współdzielony cache. |
| `/home/kkingstoun/.npm/_npx` | 328,130,560 | Zachować: zawiera React Doctor używany przez hook Git. |

Przejrzano listę 129 worktree Git. Trzeci znaleziony `target` leży na
`/zfn2`, poza badanym filesystemem WSL; nie liczono go do odzysku na `/`.
Historyczne cache `/tmp/mumax-hook-go-cache`, `/tmp/mumax-abc-go-cache`,
`/tmp/fullmag-ctx7-npm-cache`, `/tmp/fullmag-mcp-context7-cache` oraz
`/tmp/p22-ctx7-20261109` obecnie nie istnieją. Nie usunięto ich w tej próbie.

## Granica dalszego działania

Dotychczasowa zgoda użytkownika dotyczyła inwentarza. Żaden współdzielony
cache nie został uznany za zbędny wyłącznie na podstawie wieku lub nazwy.
Przed ewentualnym usuwaniem wymagane są kwalifikacja właściciela, procesów,
mountów, odwołań i potrzeb narzędzi oraz ponowny pomiar. Sesje, wyniki,
projekty, control/ledger, provenance i runtime pozostają zachowane. Pełny
S46 nadal wymaga co najmniej 1 GiB wolnego na tym samym filesystemie.
