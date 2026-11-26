import pytest

from fullmag.model.energy import (
    BulkDMI,
    Demag,
    Exchange,
    InterfacialDMI,
    RotatedInterfacialDMI,
)
from fullmag.model.problem import _validate_authored_mixed_p1_scope
from fullmag.model.structure import Material


def _validate_mixed_p1(
    *,
    device: str,
    material: Material,
    energy_terms: list[object],
    transition_policy: str = "pyramid_to_tetrahedra",
    through_thickness_elements: int = 1,
) -> None:
    _validate_authored_mixed_p1_scope(
        runtime_selection={
            "backend": "fem",
            "device": device,
            "execution_mode": "strict",
        },
        mesh_workflow={
            "per_geometry": [
                {
                    "mesh_strategy": "swept_prism",
                    "transition_policy": transition_policy,
                    "through_thickness_elements": through_thickness_elements,
                    "order": 1,
                }
            ]
        },
        materials=[material],
        energy_terms=energy_terms,
    )


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_mixed_p1_preflight_accepts_nodal_and_cubic_anisotropy_on_cpu_and_gpu(
    device: str,
) -> None:
    material = Material(
        name="Py",
        Ms=8.0e5,
        A=1.3e-11,
        alpha=0.02,
        Ku1=1.0e5,
        Ku2=2.0e4,
        anisU=(0.0, 0.0, 1.0),
        Kc1=3.0e4,
        Kc2=4.0e3,
        Kc3=5.0e2,
        anisC1=(1.0, 0.0, 0.0),
        anisC2=(0.0, 1.0, 0.0),
        Ku_field=[1.0e5, 1.1e5],
        Ku2_field=[2.0e4, 2.1e4],
        Kc1_field=[3.0e4, 3.1e4],
        Kc2_field=[4.0e3, 4.1e3],
        Kc3_field=[5.0e2, 5.1e2],
    )

    _validate_mixed_p1(
        device=device,
        material=material,
        energy_terms=[Exchange(), Demag(realization="auto")],
    )


def test_mixed_p1_preflight_accepts_cpu_dmi_terms_and_nodal_d_fields() -> None:
    material = Material(
        name="Py",
        Ms=8.0e5,
        A=1.3e-11,
        alpha=0.02,
        Dind=2.0e-3,
        Dbulk=3.0e-3,
        Dind_field=[2.0e-3, 2.1e-3],
        Dbulk_field=[3.0e-3, 3.1e-3],
    )

    _validate_mixed_p1(
        device="cpu",
        material=material,
        energy_terms=[
            Exchange(),
            Demag(realization="auto"),
            InterfacialDMI(2.0e-3),
            BulkDMI(3.0e-3),
        ],
    )


@pytest.mark.parametrize("device", ["cpu", "cuda", "gpu"])
@pytest.mark.parametrize("transition_policy", ["pyramid_to_tetrahedra", "pure_prism"])
def test_mixed_p1_preflight_accepts_gpu_dmi_terms_and_nodal_d_fields(
    device: str,
    transition_policy: str,
) -> None:
    material = Material(
        name="Py",
        Ms=8.0e5,
        A=1.3e-11,
        alpha=0.02,
        Dind=2.0e-3,
        Dbulk=3.0e-3,
        Dind_field=[2.0e-3, 2.1e-3],
        Dbulk_field=[3.0e-3, 3.1e-3],
    )

    _validate_mixed_p1(
        device=device,
        material=material,
        energy_terms=[
            Exchange(),
            Demag(realization="auto"),
            InterfacialDMI(2.0e-3),
            BulkDMI(3.0e-3),
        ],
        transition_policy=transition_policy,
        through_thickness_elements=4 if transition_policy == "pure_prism" else 1,
    )


@pytest.mark.parametrize("device", ["cpu", "cuda", "gpu"])
@pytest.mark.parametrize("transition_policy", ["pyramid_to_tetrahedra", "pure_prism"])
def test_mixed_p1_preflight_accepts_rotated_dmi_on_cpu_and_gpu(
    device: str,
    transition_policy: str,
) -> None:
    material = Material(name="Py", Ms=8.0e5, A=1.3e-11, alpha=0.02)

    _validate_mixed_p1(
        device=device,
        material=material,
        energy_terms=[
            Exchange(),
            Demag(realization="poisson_robin"),
            RotatedInterfacialDMI(3.0e-3),
        ],
        transition_policy=transition_policy,
    )


def test_pure_prism_preflight_rejects_fem_bem_and_auto_device_fail_closed() -> None:
    material = Material(name="Py", Ms=8.0e5, A=1.3e-11, alpha=0.02)

    with pytest.raises(ValueError, match="missing_qualified_demag") as error:
        _validate_mixed_p1(
            device="gpu",
            material=material,
            energy_terms=[Exchange(), Demag(realization="fredkin_koehler")],
            transition_policy="pure_prism",
            through_thickness_elements=4,
        )
    assert "fallback=none" in str(error.value)

    with pytest.raises(ValueError, match="device_not_explicit_cpu_or_gpu") as error:
        _validate_mixed_p1(
            device="auto",
            material=material,
            energy_terms=[Exchange(), Demag(realization="poisson_robin")],
            transition_policy="pure_prism",
            through_thickness_elements=4,
        )
    assert "fallback=none" in str(error.value)


def test_mixed_p1_preflight_ignores_zero_rotated_dmi_on_gpu() -> None:
    material = Material(name="Py", Ms=8.0e5, A=1.3e-11, alpha=0.02)

    _validate_mixed_p1(
        device="cuda",
        material=material,
        energy_terms=[
            Exchange(),
            Demag(realization="auto"),
            RotatedInterfacialDMI(0.0),
        ],
    )


@pytest.mark.parametrize("transition_policy", ["pyramid_to_tetrahedra", "pure_prism"])
def test_mixed_p1_preflight_keeps_ms_field_rejected(transition_policy: str) -> None:
    material = Material(
        name="Py",
        Ms=8.0e5,
        A=1.3e-11,
        alpha=0.02,
        Ms_field=[8.0e5, 8.1e5],
    )

    with pytest.raises(ValueError, match="unsupported_material_field_or_dmi"):
        _validate_mixed_p1(
            device="cpu",
            material=material,
            energy_terms=[Exchange(), Demag(realization="auto")],
            transition_policy=transition_policy,
        )
