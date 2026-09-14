"""Physical applicability regressions for the slab comparison oracle."""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_fem_frequency_domain_eigen_artifacts import require_kalinikos_slab_n0_material_and_bias


def check(plan=None, material=None):
    require_kalinikos_slab_n0_material_and_bias(
        {"external_field": [79577.47, 0., 0.], **(plan or {})},
        {"saturation_magnetisation": 8e5, "exchange_stiffness": 13e-12, **(material or {})},
        (1., 0., 0.),
    )


def test_accepts_uniform_c1_and_uniform_nodal_fields():
    check(material={"ms_field": [8e5, 8e5], "a_field": [13e-12, 13e-12]})


@pytest.mark.parametrize("bias", [[-79577.47, 0., 0.], [0., 79577.47, 0.], [0., 0., 79577.47]])
def test_rejects_wrong_bias_direction(bias):
    with pytest.raises(SystemExit, match="aligned"):
        check(plan={"external_field": bias})


@pytest.mark.parametrize("field", ["interfacial_dmi", "bulk_dmi"])
def test_rejects_omitted_dmi(field):
    with pytest.raises(SystemExit, match=field):
        check(plan={field: 1e-3})


@pytest.mark.parametrize("material", [
    {"uniaxial_anisotropy": 1.}, {"cubic_anisotropy_kc1": 1.},
    {"ku_field": [0., 1.]}, {"ms_field": [8e5, 7e5]},
    {"a_field": [13e-12, 14e-12]},
])
def test_rejects_omitted_anisotropy_or_heterogeneity(material):
    with pytest.raises(SystemExit):
        check(material=material)
