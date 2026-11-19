# Przegląd usunięcia nieaktywnych kontenerów starej instancji Windows

Status: zatwierdzone przez użytkownika i wykonane 28.10.2026. Zakres nie obejmuje grupy instancji WSL
3203, jej backendu, frontendu ani działającego `Fullmag_build_runner`.

## Przyczyna

Pełne recovery v5 odmawia restartu przy nierozstrzygniętej tożsamości obcych
mountów Windows. Sprawdzenie aliasu `.../host/d/git/storage` wykazało obecnie
`tmpfs`, podczas gdy niezależny widok `/mnt/d/git/storage` ma typ `9p`.
Nie wolno uznać ich za tożsame przez samo przepisanie nazwy.

## Dokładny zakres

| Kontener | Pełny ID | Stan zaobserwowany |
|---|---|---|
| fullmag-ledger-verify-c7eded6f5bb84fce938b43d5179e8ec3 | 42c9bc49c63f2c31b3e3a95b926218f3d83302e0d64ef6bff6551685220194a7 | exited, PID 0 |
| fullmag-worktree-antenna-transport-e2e-20261011-5e7f0d529ca256ef-frontend-1 | bd63ee7f3a4772211a1185382c760ce347e3ec2ed21c71b5f2cb354ead910e2d | exited, PID 0 |
| fullmag-worktree-antenna-transport-e2e-20261011-5e7f0d529ca256ef-backend-1 | f69d1ffc167dbe80a38cae370705c13e4d16bba7cb9dead682e74abfdf5e59c5 | exited, PID 0 |
| fullmag-actions-pr186 | a990cba50e2a953ad69a0e2e529621856e6cd19c6dbc4a05d532dc35d86ab284 | exited, PID 0 |
| fullmag-actions-pr186-preflight | 1758dafee116c856bed67d92002ec95500cd9c5f381a29d298313311442cd150 | exited, PID 0 |
| fullmag-actions-pr186-bootstrap | e050b6951bfc138a71dc02baa108fb4eb6fb9926ff7978abc9401896048c4e80 | exited, PID 0 |

## Zachowane dane i ograniczenie

Pełne metadane kontenerów oraz do 5000 ostatnich linii logów każdego kontenera
zachowano w wolumenie kontrolnym bieżącej grupy, pod
`verification/recovery-v5-20261028/`. Przegląd JSON wskazuje skróty SHA256
metadanych i logów. Dane w bind mountach, named volumes oraz obrazy pozostaną.

**Warstwy zapisu kontenerów nie zostały zarchiwizowane. Usunięcie kontenera
usunie jego warstwę zapisu.** Próba `docker diff` pierwszego kontenera
przekroczyła limit 30 s; nie twierdzimy, że warstwy są puste ani że zawierają
wyłącznie dane techniczne. Zgoda musi obejmować tę utratę.

## Zatwierdzona procedura

1. Ponownie odczytać wszystkie sześć pełnych ID i porównać nazwę, obraz,
   konfigurację, mounty i stan z zachowanymi metadanymi. Każdy aktywny lub
   zmieniony kontener przerywa procedurę; niczego nie zatrzymywać.
2. Usunąć wyłącznie wskazane kontenery zwykłym `docker rm`, bez `--force`,
   bez `--volumes`, bez prune i bez usuwania obrazów.
3. Zweryfikować brak tych ID oraz zachowanie wolumenów i kontenerów 3203.
4. Powtórzyć pełny preflight recovery v5. Usunięcie tych kontenerów nie jest
   gwarancją przejścia pozostałych bramek storage i walidacji natywnej.
5. Dopiero po poprawnych bramkach wrócić do zarządzanego buildu i recovery;
   sama zgoda na usunięcie nie uruchamia Solve.

Alternatywa: pozostawić kontenery oraz przygotować osobno zatwierdzony,
wersjonowany sposób obsługi ich nieaktualnych aliasów. Nie wolno pomijać ich
w kontroli tylko dlatego, że są zatrzymane.

Wymóg zgody pochodzi z AGENTS.md, „Ochrona pracy i uprawnienia”:
„Pozostałe usuwanie danych, force-push i wiadomości zewnętrzne wymagają
odrębnej autoryzacji.”


## Wykonanie

Użytkownik zatwierdził: „Zezwalam na usunięcie tych sześciu kontenerów i ich
warstw zapisu”. Ponowna kontrola potwierdziła identyczne nazwy, obrazy,
konfiguracje, stany i zbiory mountów. Docker zmieniał tylko kolejność mountów
w odpowiedzi inspect; porównano pełne rekordy po uporządkowaniu.

`docker rm` zakończył się kodem 0 dla dokładnie sześciu przypiętych ID, bez
`--force` i bez `--volumes`. Kontrola po operacji potwierdziła brak tych ID,
zachowanie wszystkich wcześniejszych wolumenów oraz brak zmian własnego
backendu/frontendu WSL i działającego Fullmag_build_runner.

Dowody w wolumenie kontrolnym, `verification/recovery-v5-20261028/`:
- `six-container-removal-preflight.json`;
- `six-container-removal-result.json`;
- `six-container-removal-verified.json`.

Ponowny pełny preflight odmówił po 31,864 s na kolejnym dowodzie izolacji:
`foreign Windows bind has unresolved storage identity: Read-only Windows bind identity command failed`.
Dowód: `full-preflight-after-approved-removal.json`. Pozostałego działającego
runnera nie zatrzymano i nie usunięto. Operacja nie uruchomiła buildu ani Solve.
