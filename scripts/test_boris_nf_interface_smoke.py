from __future__ import annotations

from pathlib import Path

from boris_nf_interface_smoke import NfCaseConfig, render_boris_script, scenario_manifest


def test_nf_manifest_declares_reciprocal_interface() -> None:
    config = NfCaseConfig(output_dir=Path("/run"))
    manifest = scenario_manifest(config)

    assert manifest["workload"] == "N/F"
    assert manifest["parameters"]["SHA"] == manifest["parameters"]["iSHA"]
    assert manifest["parameters"]["Gi_Spm2"] > 0.0
    assert manifest["parameters"]["Gmix_Spm2"] == [1.5e15, 0.0]


def test_rendered_script_exports_both_meshes_and_all_fields() -> None:
    script = render_boris_script(NfCaseConfig(output_dir=Path("/run")))

    assert "ns.Conductor" in script and "ns.Ferromagnet" in script
    assert "conductor.param.iSHA" in script
    assert "ferromagnet.param.Gmix = [1500000000000000.0, 0.0]" in script
    for filename in (
        "n_V.ovf",
        "f_V.ovf",
        "n_S.ovf",
        "f_S.ovf",
        "f_Ts.ovf",
        "f_Tsi.ovf",
    ):
        assert filename in script
