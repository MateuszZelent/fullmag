from scripts.collect_fem_regional_field_drive_rk_order import event_energy_sample


def test_event_energy_sample_uses_canonical_table_quantity_ids() -> None:
    samples = [
        {"t": 0.3, "my": 1.0e-3, "e_drive": 0.0},
        {"t": 1.0, "my": 3.0e-3, "e_drive": -2.0e-20},
        {"t": 1.6, "my": 5.0e-3, "e_drive": 0.0},
    ]

    sample = event_energy_sample(samples, until_s=2.0)

    assert sample == samples[1]
