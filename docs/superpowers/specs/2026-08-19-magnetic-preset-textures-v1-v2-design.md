# Design: wersjonowany kontrakt tekstur magnetycznych v1/v2

**Status:** accepted for implementation in the active goal  
**Date:** 2026-08-19  
**Scope:** Rust planner/IR, Python DSL/runtime, Control Room/legacy catalogues,
scientific documentation and qualification tests.

## Problem

Audyt `pasted-text-1.txt` wykazał jednocześnie błędy matematyczne, ciche
fallbacki, dwa rozjeżdżające się evaluatory oraz brak wersji w executable IR.
Zmiana wzorów bez granicy kompatybilności zmieniałaby wynik starych scen przy
ponownym uruchomieniu.

## Decyzja

Wprowadzamy jawny `preset_version` w `InitialMagnetizationIR::PresetTexture`,
authoringu sceny i publicznym Python DSL. Brak pola w danych historycznych
normalizuje się do `1`. Wariant `v1` zachowuje wynik kontraktu istniejącego w
momencie migracji; poprawione wzory i odrzucanie niepoprawnych parametrów są
wariantem `v2`. Nowe komendy Control Room zapisują `v2`, natomiast odczyt
istniejącego assetu zachowuje jego wersję.

## Warstwa fizyczna

W `v2` evaluator nie używa arbitralnego kierunku jako fallbacku. Wspólne
operacje zwracają typowany błąd dla wartości niefinitych, zerowych lub
niezgodnych z domeną parametru. Frame płaszczyzny jest prawoskrętny:
`e_n = e_u × e_v`; mapowanie przestrzenne i osadzenie wektora spinowego są
wyznaczane z jednego frame, a transformacja rigid obraca zarówno argument
przestrzenny odwrotną rotacją, jak i wynikowy wektor rotacją do świata.

Wzory `v2`:

- vortex/antivortex używają regularnego profilu rdzenia, a winding wynika z
  `vorticity`, nie ze znaku circulation;
- skyrmion ma profil z dokładnym limitem `m_perp(0)=0`, a nazwa
  `core_polarity` oznacza znak rdzenia;
- domain wall używa `-tanh(ξ) a + sech(ξ) b` z jawnie zwalidowanym kierunkiem
  środka ściany;
- two-domain ma jawny profil o skończonej szerokości albo jawny tryb ostrej
  granicy;
- helical i conical używają fizycznego `q` w `m^-1`, bez normalizacji jego
  długości, oraz wymagają ortonormalnej bazy;
- random używa deterministycznego całkowitoliczbowego hash/spherical sampler,
  a `InitialMagnetizationIR::RandomSeeded` nie degeneruje dla `seed=0`.

## Granica implementacji

Rust pozostaje kanonicznym evaluatorem planera i materializacji FDM/FEM.
Python runtime korzysta z eksportu PyO3 tego evaluatora, więc nie wybiera
drugiego modelu wzorów. Czysty Python pozostaje wyłącznie fallbackiem dla
instalacji bez opcjonalnego rozszerzenia; jest kontrolowany przez ten sam
fixture parity i nie stanowi kwalifikowanej ścieżki produkcyjnej managed
runtime.

## Propagacja

Zmiana obejmuje `fullmag-ir`, `fullmag-authoring`, lowering API, planner mesh/FDM,
Python `to_ir`, SceneDocument, script builder, Control Room command/catalogue,
legacy metadata oraz notę fizyczną. Nie powstaje nowy endpoint ani transport
UI; istniejąca resource-first ścieżka pozostaje właścicielem synchronizacji.
Zastane zmiany bimeronu są zachowane i integrowane jako osobny preset w tym
samym kontrakcie frame.

## Kryteria akceptacji

1. Historyczny JSON bez `preset_version` deserializuje się jako `1`.
2. Wersja jest widoczna w każdym lowering/round-trip i nie znika w plannerze.
3. Każdy poprawny wynik ma skończone komponenty i normę `1` z tolerancją
   testową; niepoprawne parametry dają błąd zamiast kierunku zastępczego.
4. Testy wykrywają winding vortex/antivortex, centrum rdzenia, profil ściany,
   okres `q`, invariant stożka, frame `xz`, transformację rigid, random seed 0
   oraz parity Python–Rust.
5. Control Room i legacy zapisują poprawną wersję i nie tworzą alternatywnego
   transportu.
6. Nota fizyczna i source map przechodzą walidator dokumentacji; brak dowodu
   runtime/GPU jest jawnie oznaczony jako niezakwalifikowany.

## Poza zakresem

Nie zmieniamy dynamiki LLG, energii ani kwalifikacji GPU. Nie usuwamy starych
assetów ani istniejących zmian użytkownika. Migracja v1 do v2 jest jawna i
odwracalna przez zmianę wersji assetu.

