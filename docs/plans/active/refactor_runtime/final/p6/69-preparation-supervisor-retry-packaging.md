# P6-69 — kompletność pakowania supervision i retry przygotowania

## Potwierdzona luka

Po P6-68 kontrola wymaganych artefaktów obejmowała siedem binariów accepted
flow. Konsumenci `package_fullmag_portable.sh`, `validate_portable_bundle.sh`
i Windows MSI wymagają również:

- `fullmag-api-accepted-fem-preparation-supervisor`
- `fullmag-api-preparation-retry`

Oba programy są produkcyjnymi targetami `crates/fullmag-api/Cargo.toml`.
Linuxowy `make install-cli-dev` buduje pakiet API, ale nie instalował tych dwóch
programów do `.fullmag/local/bin`, co uniemożliwiało skompletowanie portable
bundle z takiej instalacji. Nie jest to powód do obniżenia wymagań konsumentów.

## Zmiana

- Uzupełniono istniejący loop instalacyjny `Makefile`: kopia `.new`, potem
  finalna nazwa, z propagowaniem błędu kopiowania i przeniesienia.
- Uzupełniono ten sam zestaw w loopie `patchelf`, z istniejącym
  `$ORIGIN/../lib` i propagowaniem błędu.
- Oba programy włączono do `REQUIRED_OUTPUTS` trusted build entrypointu:
  łącznie dziewięć obowiązkowych binariów accepted flow. Brak lub pusty plik
  blokuje publikację sukcesu.
- Test release contract wyprowadza wymagany zestaw z `require_file` pakietu
  portable i porównuje go z rzeczywistymi kopiami oraz loopami instalacji i
  runpath. Nowy konsument bez programu w instalacji powoduje błąd kontroli.

Nie zmieniano fizyki, wyboru lane, scheduler semantics, skryptu MSI,
konfiguracji runnera ani jego obrazów.

## Dowody

| Kontrola | Wynik |
|---|---|
| Baseline braków required outputs | FAIL dla dokładnie dwóch pominiętych programów |
| Baseline zgodności portable → instalacja | FAIL, oba programy wskazane jako nieinstalowane |
| `test_local_runner_build_entrypoint` i `test_release_workflow_contract` po poprawce | 31 testów Python PASS, 02.10.2026 |
| Natywna kompilacja testów / build solvera | NIE WYKONANO |
| Niezależny review | Poprawiono wskazany P1: test używa wersjonowanej nazwy `Makefile`, zgodnej z case-sensitive Linux; poza tym brak blokujących uwag |

Polecenie lekkiej bramki: `python -B -m unittest
scripts.test_local_runner_build_entrypoint scripts.test_release_workflow_contract`,
z `PYTHONDONTWRITEBYTECODE=1` oraz `PYTHONPATH=scripts`.

## Granice

Regresja braków binariów wykonuje source validator dla FEM CPU. Testy źródeł
nie dowodzą wykonania wszystkich lane, działania supervision/retry ani
poprawności loadera bibliotek. Kontrola listy jest wspólna dla release profiles,
ale każda realizacja pozostaje oddzielnym odbiorem runtime.

P6-68 i ten przyrost nie wdrażają automatycznie nowego trusted entrypointu
operatorowego runnera. Managed receipt musi potwierdzić tożsamość użytego kodu
oraz niepuste binaria i ich hashe. Nadal wymagane są nowy managed build,
portable/Windows clean-install smoke oraz natywne bramki accepted FEM.
Te odbiory pozostają **NOT VERIFIED**; brak miejsca i oczekująca zgoda na
dokładny manifest cache z P6-67 nie zostały obejściem usunięte.

Źródła konsumentów: `scripts/package_fullmag_portable.sh`,
`scripts/validate_portable_bundle.sh`, `scripts/windows/build_windows_msi.ps1`.
