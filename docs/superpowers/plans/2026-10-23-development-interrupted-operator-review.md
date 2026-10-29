# Przerwanie developmentu po zatrzymaniu WSL — przegląd operacji

Data: 23.10.2026. Stan: użytkownik zatwierdził patch; natywny preview i apply przez `just` zakończyły się poprawnie. Wznowienie aplikacji jeszcze przed nami.

## Co jest gotowe i co blokuje uruchomienie

Toolchain CPU/CUDA oraz obrazy aplikacji zakończyły się sukcesem. Pierwszy etap Cargo zakończył się po 17 min 36 s; przerwanie nastąpiło podczas osobnego budowania `fullmag-py-core`. WSL Ubuntu i Docker Desktop zatrzymały się około 20:54:57 UTC i wróciły później bez polecenia restartu ze strony tego zadania. Przyczyna zatrzymania pozostaje niepotwierdzona.

Operacja `843b86c40a9d44b087775662771bf85a` pozostała w stanie `starting`, bez terminala. Pierwotny helper nie istnieje, oba kontenery aplikacji są zakończone kodem 255. Nie jest to kod zakończenia Make. Brak handoff pakietu w zachowanym pełnym logu backendu. API i wizualizacja nie są obecnie zakwalifikowane. Nie wydano żadnego Universe Solve.

## Konkretny pakiet do zatwierdzenia

Patch SHA256: `ccce5fb695a53ca9f4703b4f7a8d5fd2b6f90c610b3f63a136e7678470158a34`.
Kontroler SHA256: `64cdfeafd944e8cc4395fa6c44bea3d9c407867dfbf1b09e7d9f1d62bf3410b9`.
Request SHA256: `ccea1ffb30c211d30b2c53b7cf85b4ae8a2b0b8d28b23badc0ac886da900a079`.
Bazowy HEAD: `36de9849d3de0f2fd0163d42e0b537164aa69a56`.

| Plik | Zmiana |
|---|---|
| `scripts/docker_volume_development_interrupted.py` | Dedykowane potwierdzenie przerwanego developmentu; domyślnie preview |
| `scripts/test_docker_volume_development_interrupted.py` | Odrzucanie obcych, aktywnych i opublikowanych operacji; deterministyczny wynik i przypięcie kontenerów |
| `scripts/test_just_development_recovery_shell.py` | Ścisłe argumenty, rozróżnienie preview/apply, odrzucanie złożonych poleceń |
| `justfile` | Recepta `docker-dev-reconcile-development`; jawne `apply=true` wymagane do zapisu |
| `scripts/just_storage_shell.sh` | Dokładna trasa nowej recepty, bez `eval` i bez obejścia storage |

Cały patch i proponowane treści są w istniejącym wolumenie kontrolnym:
`fullmag-build-control-fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1-298fce24f73bea22`
w katalogu `verification/universe-volume-policy-20261023/development-interrupted-proposal/v1/` (`proposal.patch`, `files/`, `request.json`). Nie zapisano danych buildu w hostowym storage.

## Zakres operacji

1. Po zgodzie zastosować dokładnie przypięty patch do worktree i wykonać natywny preview przez nową receptę `just`.
2. Potwierdzić brak pierwotnego helpera, zgodność źródeł i silnika, surowych receipt/active/Compose, cache, ledgera i certyfikatu storage. Oba kontenery muszą nadal być dokładnie tymi samymi, zatrzymanymi inkarnacjami. Aktywni producenci i konsumenci zachowanych wolumenów powodują odmowę.
3. Dedykowany helper przejmuje nieblokującą blokadę `operation.lock`, ponownie sprawdza piny i trwałe archiwum pierwotnego receiptu. Publikuje wyłącznie `failed-confirmed`, bez domyślonego kodu Make i bez aktualizacji `verified`. Kanoniczny config SHA identyfikuje zachowany Compose, a nie kwalifikację pakietu. Po trwałym terminalu i sprawdzeniu CAS zwalnia tylko przypięty marker tej próby. Powtórzenie identycznej transakcji dokańcza wyłącznie jej częściowy zapis; historyczne potwierdzenie nie oznacza bieżącej gotowości.
4. Wykonać jedno wznowienie istniejącą receptą:

```text
just docker-dev-resume 843b86c40a9d44b087775662771bf85a d18a1b876ef0cf8e401802d1957c851434fe5ecb7bbd66369d3b343914f98602 <ten-worktree> 3203 true
```

Ta trasa zachowuje oba kontenery, obrazy i wolumeny oraz korzysta z cache. Nie zmienia OWNER, rezerwacji ani natywnych autoryzacji. Jeśli admission odmówi, wyniki i dowody pozostają zachowane; nie będzie ręcznego resetu.

Dokładne kontenery:
- backend: `d7e6c6502be4501fbab13f1946f076e9270fee419e1257d2fc6c38c5167f8e4f`;
- frontend: `32ea8abcd0949329abc50d71a6ab37d45b998d28112b79e29e7efbb3e83fe043`.

Istniejący natywny mechanizm wznowienia może posprzątać wyłącznie rozpoznany własny niedokończony kandydat pakietu, zachowując jego zewnętrzny log. Nie oznacza to usuwania cache ani wyników użytkownika.

## Weryfikacja i ograniczenia

- 8 testów interpretowanych poprawionego pakietu: PASS.
- 6 rzeczywistych prób Bash/flock/CAS na izolowanych danych w wolumenie: preview, zapis, zły active CAS, częściowy receipt, zajęta blokada, brak archiwum: PASS.
- Parser `just` i składnia Bash: PASS. `git apply --check`: PASS.
- Końcowy diagnostyczny preview z rzeczywistą blokadą: `validated-only`; oryginalny receipt pozostał bez zmian, terminal nadal nie istnieje.
- Niezależny przegląd finalnego pakietu: brak pozostałych blockerów w przejrzanym zakresie. Naprawiono przypięcie ID kontenerów i wymaganie archiwum przed zapisem.
- Natywny preview/apply nowej recepty: PASS. Wznowiona publikacja pakietu, HTTP i WebGL: jeszcze niewykonane. Nie kompilowano testów Rust.
- Po zatrzymaniu WSL potwierdzono zgodność 70 plików wcześniejszych wyników, 5 historycznych katalogów runów i archiwum Universe; obie generacje cache istnieją.
- Brak nowego wyniku Universe. Kwalifikacja naukowa pozostaje NOT VERIFIED. Jedna wcześniej zatwierdzona próba Universe ma nastąpić dopiero po działającym runtime i weryfikacji publicznego stanu.

Dowody: `final-tests.json`, `preview.json`, `patch-check.json` pod wskazanym katalogiem propozycji. Trwały checkpoint zadania: `verification/universe-volume-policy-20261023/checkpoint.json`.

## Dlaczego potrzebna jest nowa decyzja

Poprzednia zgoda dotyczyła innego, konkretnego patcha i przerwanej operacji toolchain `185b…`; została wykonana. Ta propozycja dodaje osobną wersjonowaną bramkę przerwanego developmentu. Przekazane przez użytkownika AGENTS.md, §8, wymaga pytania przed zmianą, która „touches something you've been told is load-bearing, versioned, or has a migration path”. Dlatego zastosowanie nowej bramki i jedno wznowienie wymagają decyzji operatora.

## Wykonanie po zgodzie użytkownika

Natywny preview: `validated-only`; apply: `failed-confirmed`, oba z exit 0. Terminal SHA256: `a6b428a51e15f6cc84152b05c67eb72f3ce850d97a1cc8b4fe97c4951db94971`. Pierwotny receipt jest zarchiwizowany, marker active zwolniony, verified bez zmian. Ponownie potwierdzono zgodność 70 plików wyników, 5 katalogów runów i archiwum Universe. Źródłowa kwalifikacja API, wynik Universe i WebGL pozostają otwarte; następny krok to jedno zarządzane resume z cache.
