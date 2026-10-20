# Decyzja licencyjna Fullmag

**Status:** `Apache-2.0` wdrożone dla kodu własnego Fullmag; inwentarz
komponentów redystrybucyjnych pozostaje `NOT VERIFIED`.

**Data inwentaryzacji:** 2026-10-13.

**Zakres:** kod własny Fullmag, skrypty budowania i przyszły artefakt instalatora.

Ten dokument rozdziela licencję kodu Fullmag od licencji bibliotek, solverów,
sterowników, obrazów i danych używanych jako zależności albo referencje. Nie
udziela opinii prawnej i nie zastępuje potwierdzenia łańcucha praw autorskich.

## Ustalenia z repozytorium

- Root `LICENSE` zawiera dokładny kanoniczny tekst Apache-2.0 z ASF, bez
  dodatkowych postanowień. Root `NOTICE` zachowuje istniejącą atrybucję
  projektu i neutralne oznaczenie `Copyright 2026 Fullmag contributors`.
- Manifesty własnych pakietów otrzymały `Apache-2.0`: Cargo dziedziczy wartość
  z `[workspace.package]`, a Python i Node deklarują ją lokalnie. Nie dodano
  tej wartości do submodułów ani do zależności zewnętrznych.
- `wiki/LICENSE` i licencja w przykładowym `wiki/api-reference/openapi.json`
  należą do szablonu Mintlify wiki. Nie są licencją kodu Fullmag i nie mogą być
  kopiowane do root `LICENSE`.
- `readme.md` podaje autorów cytowania: M. Zelent, M. Gołebiewski i P. Pirro.
  Cytowanie nie jest samo w sobie dowodem kompletnego wykazu właścicieli
  praw. Linia `Copyright 2026 Fullmag contributors` w `NOTICE` jest neutralnym
  oznaczeniem zakresu repozytorium i nie dopisuje personalnych właścicieli praw.
- Skrypt `scripts/package_fullmag_portable.sh` wprost informuje, że agregacja
  licencji zewnętrznych nie jest jeszcze dołączana. Istniejący
  `scripts/windows/build_windows_msi.ps1` kopiuje wybrane teksty licencji
  Node/Python, ale sam opisuje inwentarz jako niepełny i nie generuje pełnego
  rejestru zależności.
- Źródłowy producer Windows używa
  `scripts/windows/installer/generate_third_party_notices.py` do generowania
  `THIRD_PARTY_NOTICES` i `THIRD_PARTY_NOTICES.json` z dokładnych,
  hash-bound archiwów przywróconego supersetu zależności i runtime packów
  (plus źródłowego archiwum WiX) oraz pliku root `NOTICE`. Pole
  `inventory_scope=restored_dependency_superset+runtime_packs` opisuje zakres
  wejścia i nie twierdzi, że jest to dokładny graf bibliotek faktycznie
  załadowanych przez każdy payload. Helper nie
  interpretuje samego pola SPDX/license expression i zatrzymuje staging, gdy
  archiwum nie niesie rzeczywistego tekstu licencji, chyba że wpis w
  `third_party_license_fallbacks.json` wiąże dokładny package/version z
  hash-bound tekstem upstream, pełnym repository commit, source URL, plikiem
  źródłowym i deklarowanym SPDX expression zweryfikowanym względem `.nuspec`.
  Staging zatrzymuje się także, gdy hash wejścia albo którekolwiek z tych
  mapowań się zmieni.

Przed tą zmianą repozytorium nie miało root kontraktu licencyjnego. Obecna
decyzja ustanawia go dla kodu własnego; nie zmienia praw ani warunków
komponentów zewnętrznych. Bez licencji open source domyślne prawa autorskie
ograniczają kopiowanie, dystrybucję i tworzenie utworów zależnych, jak opisuje
[GitHub: Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

## Decyzja dla kodu Fullmag

Zastosowano standardową licencję **Apache License 2.0**, identyfikator SPDX
`Apache-2.0`, dla kodu własnego Fullmag. To istniejący standard, bez nowej
licencji projektu. Apache-2.0 zawiera osobny grant patentowy,
warunki zachowania informacji o zmianach i NOTICE oraz standardowy sposób
oznaczania plików ([tekst Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0),
[wpis SPDX `Apache-2.0`](https://spdx.org/licenses/Apache-2.0.html)).

MIT pozostaje rozsądną alternatywą, ale została odrzucona na
rzecz jednego jawnego kontraktu patentowego dla kodu C++, Rust i Python.
Porównanie tekstów MIT i Apache jest podstawą tej preferencji, a nie
twierdzeniem o skutkach prawnych w konkretnej jurysdykcji
([MIT w OSI](https://opensource.org/license/mit),
[lista SPDX](https://spdx.org/licenses/)). Nie proponuję licencji GPL/AGPL dla
rdzenia tylko dlatego, że część solverów referencyjnych jej używa.

### Root `LICENSE` i `NOTICE`

Root `LICENSE` jest pełnym, kanonicznym tekstem Apache-2.0 z ASF; nie zawiera
niestandardowych klauzul ani wymyślonych ograniczeń. `NOTICE` obejmuje wyłącznie
kod własny i istniejącą atrybucję projektu:

```text
Fullmag
Copyright 2026 Fullmag contributors.

The Fullmag-owned source in this repository is licensed under the Apache
License, Version 2.0. See LICENSE.

Existing project attribution:

M. Zelent, M. Gołebiewski, and P. Pirro, FullMag: a computational framework
for reproducible finite-difference and finite-element micromagnetics, research
software, 2026.

The external solvers, vendored files, runtimes, containers, data, and other
third-party components in a distribution retain their own terms. See the
repository's third-party license inventory before redistribution.
```

Nie należy wpisywać tu autorów zależności ani deklarować, że wszystkie elementy
dystrybucji są na Apache-2.0. Rejestr `THIRD_PARTY_NOTICES`/`share/licenses`
powinien być generowany z konkretnych wersji artefaktów i ich plików licencji,
a nie z samej nazwy pakietu.

## Zależności i granice licencji

### Natywny stos FEM

Manifest [`windows_build_requirements.json`](../../windows_build_requirements.json)
i `scripts/windows/native_fem_dependencies.ps1` przypinają:

| Komponent | Pochodzenie/pin w repozytorium | Stan rozpoznania licencji |
| --- | --- | --- |
| MFEM | `v4.9`, `d9d6526cc1749980a2ba1da16e2c1ca1e07d82ec` | lokalny root `LICENSE` w kanonicznym źródle providera, SHA-256 `7b3a81994bff07fe11ed4e759cac3e9ed727e930e456815d91eb4019a73bf2b`; upstream `BSD-3-Clause`, zob. [MFEM](https://github.com/mfem/mfem) |
| hypre | `v3.1.0`, `9dc9e18aed6a945a95f966e57daacfb1c269f6ec` | lokalny `COPYRIGHT` `bae8261fa601697fb4d7aa6916a3a7568fcd830e8182ae6b8fd7af2fa502d883`, `LICENSE-MIT` `2a4009a16399be111e053f45c341658e31fda8e1ac087de082d4e6d1049e13c2`, `LICENSE-APACHE` `3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5`; upstream `(Apache-2.0 OR MIT)`, zob. [hypre](https://github.com/hypre-space/hypre) |
| libCEED | `v0.12.0`, `4018a20a98d451fac24765d3ddb936861647ce8d` | lokalny root `LICENSE`, SHA-256 `1d4a04b288273524f2eb5db0d3261e3bdbad79144dd772de07570406f48019a7`; upstream `BSD-2-Clause`, zob. [LICENSE libCEED](https://github.com/CEED/libCEED/blob/main/LICENSE) |
| Microsoft MPI | SDK/runtime `10.1.1` | warunki Microsoft wymagają osobnego tekstu i inwentarza; nie jest własnością Fullmag |
| CUDA | narzędzie systemowe, obecnie minimum `13.3.0` | NVIDIA EULA i komponenty CUDA wymagają osobnych warunków; nie są objęte root licencją |
| PETSc/SLEPc | wykrywane przez `native/cmake/FindFullmagWindowsModal.cmake` dla modalnego providera | bieżący manifest setupu nie jest pełnym rejestrem tych artefaktów; status `NOT VERIFIED` |

Trzy pierwsze wiersze mają lokalny dowód tekstu licencji/copyright z kanonicznego
źródła providera oraz zapisany hash. Nie oznacza to kompletnego inwentarza:
transitive dependencies, zmiany lokalne, sposób łączenia, zawartość MSI/Burn,
obrazu kontenera i instalacji runtime nadal wymagają osobnej kwalifikacji.
Przed wydaniem trzeba zachować wszystkie teksty dla dokładnych pinów i ustalić,
co faktycznie trafia do każdej dystrybucji.

### `external_solvers` i źródła referencyjne

`.gitmodules` zawiera sześć osobnych gitlinków:

| Ścieżka | Pin w głównym repozytorium | Obserwacja upstream / granica |
| --- | --- | --- |
| `external_solvers/3` | `f284051153d1513523043fe42654e283c6e21464` | MuMax3 GPL-3-or-later z dodatkową zgodą dotyczącą CUDA oraz własnymi atrybucjami; [LICENSE](https://github.com/mumax/3/blob/master/LICENSE) |
| `external_solvers/plus` | `14fa37691b247ec4f7eb7f3a0a2fa87810a3b5ea` | upstream oznacza repozytorium jako GPL-3.0; [mumax+](https://github.com/mumax/plus) |
| `external_solvers/amumax` | `03c9bf19a5266e64db5658d6d118db10a6a4c78f` | fork MuMax3; dokładny plik licencji dla tego pina nie został lokalnie potwierdzony; [repozytorium](https://github.com/MathieuMoalic/amumax) |
| `external_solvers/tetmag` | `ab7f266c0d78fff0ed425cc013382e7ab24fa39` | upstream ma `LICENSE.md`; dokładny tekst dla pina wymaga checkoutu; [repozytorium](https://github.com/R-Hertel/tetmag) |
| `external_solvers/oommf` | `8880fff5446eeab030a18881b474814f1ea60687` | upstream odsyła do własnej licencji oraz odrębnych licencji rozszerzeń; [repozytorium](https://github.com/fangohr/oommf) |
| `external_solvers/neuralmag` | `9c6d0a4e6ac257562ab75ce70a0aa995102e4b38` | upstream deklaruje MIT; dokładny plik dla pina wymaga checkoutu; [repozytorium](https://gitlab.com/neuralmag/neuralmag) |

Te gitlinki są źródłami zewnętrznymi albo referencjami, a nie automatycznie
częścią licencji kodu Fullmag. Fakt, że kod Fullmag używa nazwy, równania,
fixture albo procesu zewnętrznego solvera, nie przenosi jego licencji na własną
implementację. Z drugiej strony dołączenie źródła, biblioteki, binarium lub
zmodyfikowanego submodułu do jednego wydania może uruchomić jego własne warunki;
nie deklarujemy tu kompatybilności prawnej bez analizy konkretnego sposobu
łączenia i dystrybucji. Kanoniczne teksty GNU dla porównania warunków copyleft
to [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) i
[AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html); dokładny tekst licencji
każdego pina nadal musi pochodzić z jego checkoutu.

Manifest BORIS w
`docs/physics/multilayer_convolution/boris-reference-manifest.v1.json` jest
historycznym manifestem hashy z podpowiedzią GPLv3. `external_solvers/BORIS`
nie jest bieżącym gitlinkiem w `.gitmodules`, więc wpis nie dowodzi, że BORIS
jest obecnie dołączony do pakietu. Dokumenty Tetmag i BORIS opisują referencję
lub fixture; nie są zgodą na kopiowanie kodu.

### Kod i obrazy innych dostawców

`docker/fem-gpu/nvidia-entrypoint/` zawiera skrypty z zachowanym nagłówkiem i
warunkami NVIDIA. Nie wolno obejmować ich propozycją Apache-2.0. Node, Python,
Rust, pnpm, WiX, WebView2, Microsoft MPI, CUDA, sterownik GPU oraz zależności
Cargo/npm/PyPI mają własne warunki; ich wersja instalowana i tekst licencji
muszą zostać zapisane w receipcie wydania. Obecny MSI i pakiet portable nie
spełniają jeszcze tego wymagania.

## Wymagane bramki przed publikacją

1. Każdy plik zewnętrzny jest sklasyfikowany jako kod własny, vendored code,
   gitlink, osobny proces, binary/runtime, fixture albo dokumentacja; źródła
   i modyfikacje zachowują upstreamowe nagłówki.
2. Dla dokładnych pinów checkoutów i lockfile producer generuje hash-bound
   `THIRD_PARTY_NOTICES`/`THIRD_PARTY_NOTICES.json` dla zakresu
   `restored_dependency_superset+runtime_packs`. Jest to jawny superset
   przywróconych zależności i runtime packów, a nie deklaracja exact bundled
   graph. Brak tekstu licencji lub nieznany właściciel zatrzymuje
   redystrybucję.
3. Build MSI/Burn i GUI `fullmag.exe` pokazują zatwierdzoną licencję produktu
   oraz dostęp do licencji komponentów. Ekran instalatora nie może sam ustanawiać
   ani zmieniać warunków licencji.
4. Natywny build, przejście parsera, gotowy MSI ani działający solver nie są
   dowodem kompletności inwentarza licencyjnego.

## Status dowodów

Wykonano statyczną inwentaryzację plików i manifestów oraz sprawdzono oficjalne
strony upstreamów. Root `LICENSE`, `NOTICE`, README i metadane własnych pakietów
są wdrożone; trzy lokalne teksty MFEM/hypre/libCEED mają potwierdzone hashe w
kanonicznym storage. Nie uruchamiano kompilacji, instalacji systemowej ani testów
jednostkowych. Pełne licencje transitive dependencies, PETSc/SLEPc,
Microsoft/NVIDIA i artefaktów MSI/Burn pozostają `NOT VERIFIED`; dokument nie
jest dowodem gotowej redystrybucji.
