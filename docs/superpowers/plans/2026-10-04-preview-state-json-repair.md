# Import FMS — naprawa deserializacji PreviewState

Data: 2026-10-04. Zakres: `fullmag-api`, zapisane pole `preview` w `project/current_live_snapshot.json`. To checkpoint źródeł; nie kończy kwalifikacji GUI ani solvera dyspersji.

## Problem i wynik poprawki

Internally tagged reader Serde nie zachowywał JSON-adaptacji kluczy liczbowych `per_domain_quality` w wariancie spatial. Wcześniejsza próba obejścia przez `serde_json::Value` umożliwiała odczyt kluczy, ale przed walidacją usuwała powtórzenia znanych pól i `kind`. Surowy FMS mógł przez to przyjąć ostatnią sprzeczną wartość zamiast zgłosić malformed snapshot.

Reader zachowuje teraz JSON jako `Box<RawValue>`. Oddzielny typed reader odczytuje string `kind`, a właściwy wariant jest odczytywany bezpośrednio przez `serde_json::from_str`. Derived readers ponownie odrzucają powtórzony discriminator, znane pola wariantu i znane pola zagnieżdżonej siatki. Numeryczne klucze domen są obsługiwane przez właściwy JSON deserializer. Dotychczasowe ignorowanie nieznanych pól i semantyka dynamicznych map nie zostały zaostrzone. Serialize, nazwy wariantów i poprawny format FMS pozostają bez zmian.

API jawnie deklaruje feature `raw_value`; feature był już wymagany przez normalną zależność runner, więc nie wprowadzono nowej wersji ani formatu publicznego.

## Dowody i granice

| Bramka | Stan |
| --- | --- |
| Niezależne review dwóch plików i źródeł Serde 1.0.228 / serde_json 1.0.150 | PASS źródłowo; P2 powtórzonych pól poprawiony |
| `rustfmt --check --edition 2021` dla types.rs | PASS; parser i format, bez kompilacji |
| Scoped Git whitespace check | PASS |
| Regresje: numeric-domain roundtrip, scalar dispatch, błędne kind/type, raw duplicate kind/value/mesh_name, raw numeric keys i ignorowanie unknown fields | Przygotowane; NIE wykonane ani kompilowane z powodu zakazu użytkownika |
| Kompilacja nowego readera, import oryginalnego FMS i browser/WebGL | NOT VERIFIED |

Źródła po review: types.rs SHA256 `ae5906c8d3c67aa38d6a08e6e5797c10f6451d57996c264da445c74c3f78df81`; Cargo.toml SHA256 `27cfa48ae6770aa64260b357d1466d651b74e826ea089c254fbe9b706dc8f270`. Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\preview-state-checkpoint\source-review-fixed.md` oraz poprzedni raport/reproducers w tym samym katalogu.

## Następny krok

Nowy managed build produkcyjnego API musi obejmować ten reader; build #226 zawiera poprzednią wersję Value i nie dowodzi tej poprawki. Należy wczytać zachowany oryginalny FMS, sprawdzić siatkę, pola, etap/mody oraz session/epoch/run, następnie widoczny canvas, niezagubiony kontekst i niezerowy drawing buffer. Jawna historyczna kopia `preview:null` nie zastępuje tego dowodu. Testy jednostkowe pozostają wyłączone do odwołania zakazu.

Przy odczycie 2026-10-04T03:15UTC Docker i koordynator działały, a ten sam pilot Γ #226 liczył refinement32/50. Brak nowego końcowego zaakceptowanego punktu. Wolne storage około 4,2GiB było poniżej progu 8GiB dla nowego ciężkiego buildu. Nie restartowano solvera ani nie zmieniono jego progów naukowych.
