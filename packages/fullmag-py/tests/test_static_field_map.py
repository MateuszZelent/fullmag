import pytest

import fullmag as fm


def test_static_field_map_serializes_cellwise_tesla_values():
    field = fm.StaticFieldMap(
        id="frozen_transport_equivalent",
        field_B_T=((0.0, 1.0e-3, 0.0), (-2.0e-3, 0.0, 3.0e-3)),
    )

    assert field.to_ir() == {
        "kind": "static_field_map",
        "id": "frozen_transport_equivalent",
        "field_B_T": [[0.0, 1.0e-3, 0.0], [-2.0e-3, 0.0, 3.0e-3]],
    }


@pytest.mark.parametrize(
    "kwargs",
    [
        {"id": "", "field_B_T": ((0.0, 0.0, 0.0),)},
        {"id": "map", "field_B_T": ()},
        {"id": "map", "field_B_T": ((float("nan"), 0.0, 0.0),)},
        {"id": "map", "field_B_T": ((0.0, 0.0),)},
    ],
)
def test_static_field_map_rejects_invalid_input(kwargs):
    with pytest.raises((TypeError, ValueError)):
        fm.StaticFieldMap(**kwargs)
