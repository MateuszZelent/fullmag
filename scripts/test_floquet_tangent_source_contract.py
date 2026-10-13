from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_floquet_tangent_source_is_element_local_and_not_column_global():
    source = (
        REPO_ROOT
        / "backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp"
    ).read_text(encoding="utf-8")
    body = source.split(
        "FrequencyDomainStatus assemble_floquet_bloch_scalar_tangent_source(",
        1,
    )[1]
    assert "for (int element = 0; element < element_count; ++element)" in body
    assert "CalcPhysDShape" in body
    assert "real->Add(" in body
    assert "imaginary->Add(" in body
    assert "mfem::LinearForm" not in body
    assert "for (int column = 0; column < output_width; ++column)" not in body


def test_floquet_airbox_bridge_consumes_hermitian_residual_fail_closed():
    header = (
        REPO_ROOT
        / "backends/fem/cpu/frequency_domain/floquet_airbox_operator.hpp"
    ).read_text(encoding="utf-8")
    source = (
        REPO_ROOT
        / "backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp"
    ).read_text(encoding="utf-8")
    assert "kFloquetAirboxHermitianRelativeTolerance = 1.0e-8" in header
    body = source.split(
        "FrequencyDomainStatus assemble_floquet_airbox_dynamic_demag_k(",
        1,
    )[1]
    assert "max_abs_hermitian_residual" in body
    assert "hermitian_relative_residual" in body
    assert "Schur block is not Hermitian within the relative tolerance" in body
    assert "FrequencyDomainStatus::operator_error" in body
