# Magnetization Texture Closure - 2026-05-12

## Status

Zakres implementacyjny zostal domkniety dla produkcyjnej sciezki v2:

- region i obiekt korzystaja z tego samego modelu przypisania `magnetization_ref`;
- region override nie brudzi mesha, bo nie zmienia geometrii;
- ribbon tworzy lub aktualizuje asset presetowy i przypisuje go do aktualnego targetu;
- explorer wystawia osobny target tekstury dla regionu;
- inspector zapisuje asset tekstury, preset params, mapping i transformacje 3D, a nastepnie przypisuje ten sam ref do obiektu albo regionu;
- backend ma endpointy `GET/PATCH /v2/sessions/current/model/magnetization-assets/{asset_id}`;
- viewport odswieza kolor podgladu po zapisie assetu i obsluguje object texture oraz region override preview dla primitive i mesh part.

## Verification

Uruchomione bramki:

- `npm run lint` w `apps/control-room`;
- `npm run typecheck` w `apps/control-room`;
- `npm run test` w `apps/control-room` - 81 plikow, 350 testow;
- `npm run check:api-hygiene` w `apps/control-room`;
- `git diff --check`;
- `cargo fmt`;
- `cargo test -p fullmag-api` - 241 testow.

## Notes

Inspektor zapisuje zmiany po kliknieciu `Save Texture`. Podglad viewportu aktualizuje sie po invalidacji zasobow sceny, regionow i visualization state. Biezacy renderer pokazuje teksture przez kolor preview presetow; to nie jest jeszcze fizyczne probkowanie pola tekstury w shaderze.
