from fullmag.init.magnetization import RandomMagnetization


def test_random_magnetization_accepts_zero_seed() -> None:
    assert RandomMagnetization(0).to_ir() == {"kind": "random", "seed": 0}
