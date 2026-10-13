"""Synthetic renderer fixtures; no frequencies here are FEM evidence."""
import json
from copy import deepcopy
from unittest.mock import patch
import pytest
import plot_de_bv_thickness_comparison as plot


def comparison():
    rows=[]
    for geometry in ("damon_eshbach","backward_volume"):
        for layers in (3,6,9):
            rows.append({"geometry":geometry,"thickness_layers":layers,"run_path":"synthetic",
                         "job":{"id":"synthetic"},"model_source":{},"mesh_level":"L2",
                         "air_padding_each_side_m":2e-6,"k_rad_per_m":25e6,"magnetic_xy_sha256":"same",
                         "parameters":{"geometry":geometry,"film_thickness_m":10e-9},
                         "frequency_hz":10e9+layers*1e6,"analytic_frequency_hz":11e9,
                         "difference_percent":-9.0,"full_residual":1e-10})
    return {"schema":"fullmag.de-bv.thickness-comparison.v1","qualification":"NOT VERIFIED","records":rows}


def test_modified_record_is_rejected_before_plotting():
    data=comparison();actual=deepcopy(data["records"])
    data["records"][0]["analytic_frequency_hz"]*=1.01
    with patch.object(plot,"collect_record",side_effect=actual):
        with pytest.raises(ValueError,match="certified artifacts"):plot.validate_comparison(data)


def test_fixed_k_plot_uses_real_record_values_and_labels():
    data=comparison()
    fig=plot.build_figure(data["records"])
    assert len(fig.axes)==4
    assert list(fig.axes[0].lines[0].get_xdata())==[3,6,9]
    assert list(fig.axes[0].lines[0].get_ydata())==pytest.approx([10.003,10.006,10.009])
    assert "NOT VERIFIED" in fig._suptitle.get_text()
    assert all(ax.get_xlabel()!="k" for ax in fig.axes)
    import matplotlib.pyplot as plt
    plt.close(fig)


def test_renderer_writes_hashed_png_pdf_and_receipt(tmp_path):
    data=comparison();source=tmp_path/"comparison.json";source.write_text(json.dumps(data))
    output=tmp_path/"plot"
    with patch.object(plot,"collect_record",side_effect=deepcopy(data["records"])):
        assert plot.main([str(source),str(output)])==0
    receipt=json.loads((output/"plot-receipt.json").read_text())
    assert receipt["qualification"]=="NOT VERIFIED"
    assert receipt["comparison_sha256"]==plot.digest(source)
    for name,hash_value in receipt["output_sha256"].items():
        assert hash_value==plot.digest(output/name)
        assert (output/name).stat().st_size>1000
    with patch.object(plot,"collect_record",side_effect=deepcopy(data["records"])):
        with pytest.raises(FileExistsError):plot.main([str(source),str(output)])
