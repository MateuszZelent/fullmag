# S10 — anizotropia jednoosiowa: Hessian, tożsamość i kanał pola

## Zakres i znalezione błędy

1. Natywny blok energii dotychczas odrzucał Ku. Dodany człon pochodnej
   pola ma znak ujemny i projekcje obu baz węzłowych; krzywizna używa
   całkowitego zaakceptowanego pola, również dla przypadku bez Zeemana.
2. Tożsamość materiału nie wiązała Ku/osi i odrzucała tę konfigurację.
   Wspólny builder producenta i odbiorcy wprowadza v2 dla Ku, zachowując
   dokładną strukturę i namespace v1 dla materiału bez Ku. Zmiana Ku/osi
   unieważnia źródło; z oraz -z albo przeskalowanie tej osi są równoważne.
   Normalizacja skaluje komponenty przed liczeniem normy, aby skończona
   bardzo duża lub mała oś nie przepełniła obliczeń.
3. Obserwator w eigen_equilibrium traktował pole anizotropii jak stałe
   per_node_field. To klasyfikowało je jako Zeemana, dawało błędną energię
   i nie odtwarzało pochodnej względem m. Zastąpiono je typowanymi
   interakcjami; h_ext pozostaje polem zewnętrznym, Ku trafia do anizotropii.
   Usunięto komentarz deklarujący nieistniejące dwa przebiegi relaksacji.
4. Rust posiada własne osie/coefficient/digest, sprawdza cardinality i maskę
   termów oraz transportuje dane do istniejącego ABI. Publiczne guardy nie
   zostały usunięte. Pierwszy składnik wymaga globalnej osi, stałego Ku,
   jednorodnego dodatniego Ms; K2/cubic/surface/spatial/DMI nadal wymagają
   dalszej pracy i osobnej kwalifikacji.

## Weryfikacja i granice dowodów

- Niezależne różnice skończone energii na sferze: 3 lekkie testy Python PASS.
  Obejmują znak Ku, osie oblique/transverse/easy, krzywiznę bez Zeemana
  oraz wykazanie podwojenia energii przez zamrożone pole zewnętrzne.
  Jest to dowód matematyczny, nie wykonanie natywnego operatora.
- Regresje natywne źródłowe: obie bazy węzłowe, signed Ha, opposite axis,
  invalid axis, nieadvertised views, spatial coefficient rejection.
  Regresja Rust: Ku i oś, brak wpływu na podpis pozostałych rodzin,
  ogromna skończona oś i odrzucenie NaN/Inf/zero/spatial Ms/K2.
  Nie kompilowano ani nie uruchamiano natywnych testów, zgodnie z AGENTS.md.
- Nota 0831 i jej źródła sprawdzane przez kontrakt dokumentacji.
- Job #187 c52c7fd053e745d9b113ffeb0268a472 zawiera wcześniejszy native Ku
  i transport, ale NIE obejmuje dopisanych teraz sygnatur i observera.
  Źródła kapsuły verify_source PASS (7491 plików); status running przy
  kontroli tego turnu. Nie przypisujemy temu jobowi aktualnej kompilacji.
- Najpierw review i source checks; po zakończeniu bieżącego joba potrzebny
  nowy snapshot tych zmian i właściwe managed build/runtime. Konieczne są
  zgodne pola/handoff/digest, K0 oraz +/-k, residuale i zbieżność.
- Cały cel S00–S12 pozostaje otwarty, w tym pełne interakcje, COMSOL A1,
  konwergencja, GPU, browser, review i integracja.

## Dodatkowe dowody etapu

Dokładnie staged nota, mapa i 48 plików dowodowych: validator PASS.
Sześć dokładnie staged plików Rust: parser rustfmt PASS (emit stdout,
bez zmian źródeł, bez kompilacji i bez wykonywania testów).
#187: worker 98cb548305f4e1f07e03bf2681988eff40e09999d6e1c74e00bd02db41e2dd70
uruchomił native-build make install-cli-dev, procesy cargo/rustc potwierdzone.
To dowodzi przejścia poprawionego preflightu, nie terminalnego sukcesu buildu.

## Niezależny review i pozostałe poprawki przed publicznym Ku

Review potwierdził zachowanie fail-closed; nie uznaje Ku za gotowe end-to-end.
Dopisano źródłowe regresje zgodności producer-relax/consumer-eigen oraz
zamrożonych bytes i digestu legacy v1. Nadal nie były wykonywane natywnie.
Pozostały trzy konkretne zależności:

1. CertifiedFemEquilibriumFields.v1 i validate_certified_equilibrium_fields
   sumują wyłącznie H_ex + H_demag + H_ext. Potrzebny wersjonowany certyfikat
   v2 z h_anisotropy, aktualizacja digestu, producenta, walidatora i konsumentów.
   Nie wolno ukrywać Ku w H_ext.
2. Material_snapshot_id i artefakty shared-domain nadal używają surowego
   MaterialIR. Kanoniczny Ku podpis trzeba połączyć z tymi konsumentami tak,
   aby równoważna skalowana/odwrócona oś nie powodowała sprzecznej akceptacji
   identity i późniejszego equilibrium_material_hash_mismatch. Zachować
   oddzielną provenance oryginalnego żądania.
3. Modal_operator_signature jest podpisem konfiguracji operatora, a materiał
   jest oddzielną częścią całej tożsamości. Sprawdzić wszystkie cache/konsumenty,
   aby żaden nie traktował go samodzielnie jako kompletnego podpisu fizyki.
   Poprawić legalny zero-h_eff przy certyfikowanej niezerowej krzywiźnie.

Po tych poprawkach dopiero ograniczone odblokowanie Ku w plannerze/runnerze,
nowy managed snapshot i K0/+k/-k z pełnymi polami, residualami i zbieżnością.
