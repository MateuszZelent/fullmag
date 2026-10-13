# Anteny — niezależna kontrola strumieni wychodzących RT0

## Zakres przyrostu

`scripts/antenna_rt0_fixture_check.py::compare_rt0_fixture` sprawdza teraz także
zapisane strumienie wychodzące z obu stron ściany względem geometrii przypiętego
fixture. Dotychczas weryfikował moment kanoniczny i bilans elementów, ale pomijał
`face_first_outward_a` oraz `face_second_outward_a`.

Kolejność stron wynika z leksykograficznych kluczy elementów, nie indeksów
`first_element`/`second_element`. Potwierdzony producent:
`backends/fem/cpu/mfem/transport/conservative_current_view.cpp::integrate_physical_certificate`;
serializacja:
`backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp::AcceptedExternalLeadCurrentSource::Finalize`.
Nie zmieniono native solvera, modelu, geometrii, prądu ani tolerancji.

## Dowody

- RED: przekłamane pierwsze i drugie strumienie, mimo ponownego obliczenia
  hashy nested records, przechodziły checker: 2 FAIL, 18 PASS.
- GREEN: interpretowane regresje `scripts/test_antenna_rt0_fixture_check.py`
  i zależnego `scripts/test_antenna_bundle_observables.py`: **81/81 PASS**.
  Sprawdzono także odwrócenie obu znaków przy zachowanym zerowym bilansie
  oraz niezależność od kolejności native adjacency.
- Python 3.14.7, pytest 9.1.1; bez cache pytest, bytecode i kompilacji testów.
- Odczyt zachowanego eksportu historycznego RAM
  `8031eeff9ebf4ce28cca1fe5e8613329`: 108 ścian, 36 elementów, PASS;
  największy błąd momentu/strumienia `2.220446049250313e-16 A`,
  bilans elementów 0 A.
  SHA-256 bundle: `78633e7d1d285f911cbc9247c28178ce5661481bd2bd4a1ac6fdbc8cfd501f16`.
  To ponowna kontrola zachowanych bajtów, nie nowy solve ani ponowna
  kwalifikacja provenance; wejście odtworzono bieżącym DSL i sprawdzono
  względem istniejącego dokładnego pinu fixture.

## Ograniczenia i kolejny krok

Wagi DOF nadal pochodzą z native; niezależna normalizacja bazy MFEM pozostaje
niecertyfikowana. Checker nie zastępuje pełnego canonical decoder ani
native input-pin validation. `physics_qualified=false`; reusable basis,
LLG/Relax/FFT, trwały SessionStore i pełny T00–T18 nadal otwarte.

Build nr 38 `ff4035657e4a40ad84e15ca2a07764a0` kompiluje wcześniejszą kapsułę
commita `86810f37e21e95b3f8e24d967fdb2bad9511eff1` i pozostaje w toku.
Nowy checker jest zewnętrzną kontrolą jego przyszłego eksportu; nie przypisywać
go starszej kapsule. Po terminalnym odbiorze buildu wykonać zatwierdzony
fixed RAM V/RT0/H bez LLG/Relax, z niezmienionymi progami.
