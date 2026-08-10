from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs/physics/0980-dynamic-current-and-oersted-coupling.md"
SOURCE_MAP = ROOT / "docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json"


EQUATION_SYMBOLS = {
    "fdm-oersted-face-to-cell-current": {
        "J_c_cell",
        "J_c_face",
        "chi_c",
        "i",
        "a",
        "e_a",
        "xyz_axes",
    },
    "fdm-oersted-cell-integrated-kernel": {
        "k_a",
        "x_i",
        "x_j",
        "x_prime",
        "C_j",
        "pi",
        "euclidean_norm",
        "dV_prime",
        "source_sum",
        "a",
        "K",
        "positive_zero_tensor",
        "r",
        "H_oe",
        "i",
        "j",
        "J_c_cell",
    },
    "fdm-oersted-fft-convolution": {
        "H_oe_hat",
        "k_hat",
        "J_c_hat",
        "xyz_axes",
    },
    "fdm-oersted-post-reconstruction-differential-operators": {
        "diagnostic_field",
        "delta0_a",
        "i",
        "e_a",
        "h_a",
        "a",
        "xyz_axes",
        "D_h",
        "C_h",
        "J_c_cell",
        "H_oe",
    },
    "fdm-oersted-post-reconstruction-residuals": {
        "diagnostic_field",
        "I_2",
        "V_h",
        "rms_norm",
        "diagnostic_sum",
        "euclidean_norm",
        "S_J",
        "S_A",
        "h_min",
        "rho_divJ",
        "rho_divH",
        "rho_A",
        "D_h",
        "C_h",
        "J_c_cell",
        "H_oe",
        "i",
        "h_a",
        "xyz_axes",
        "max_operator",
        "min_operator",
    },
    "fdm-oersted-post-reconstruction-refinement": {
        "rho_divJ",
        "rho_divH",
        "rho_A",
        "p",
        "p_min",
        "h_refinement",
        "epsilon_fp64",
        "rho_generic",
        "max_operator",
        "log2_operator",
    },
    "fdm-oersted-direct-oracle-mixed-bound": {
        "k_prod",
        "k_ref",
        "a",
        "B_a",
        "a_K",
        "r_K",
        "h_max",
        "h_a",
        "xyz_axes",
        "max_operator",
        "absolute_value",
    },
    "fdm-oersted-direct-oracle-surface-reduction": {
        "k_ref",
        "a",
        "pi",
        "F_a_plus",
        "F_a_minus",
        "x_i",
        "x_prime",
        "euclidean_norm",
        "dS_prime",
    },
    "fdm-oersted-direct-oracle-spot-check": {
        "A_spot",
        "A_previous",
        "E_spot",
        "B_spot",
        "k_ref",
        "a",
        "a_S",
        "r_S",
        "h_max",
        "absolute_value",
    },
    "fdm-oersted-direct-oracle-exact-zero": {
        "k_prod",
        "k_hat_prod",
        "a",
        "r",
        "q",
        "Z_real",
        "Z_spec",
        "positive_zero_scalar",
        "K",
        "positive_zero_tensor",
    },
}


SYMBOL_CONTRACT = {
    "H_oe": (r"H_{\mathrm{oe}}", r"\mathrm{A\,m^{-1}}"),
    "r": ("r", r"\mathrm{m}"),
    "o": ("o", r"\mathrm{m}"),
    "J_c_cell": (r"J_c^{\mathrm{cell}}", r"\mathrm{A\,m^{-2}}"),
    "J_c_face": (r"J_c^{\mathrm{face}}", r"\mathrm{A\,m^{-2}}"),
    "chi_c": (r"\chi_c", "1"),
    "chi_m": (r"\chi_m", "1"),
    "i": ("i", "1"),
    "j": ("j", "1"),
    "a": ("a", "1"),
    "e_a": ("e_a", "1"),
    "xyz_axes": (r"\{x,y,z\}", "1"),
    "k_a": ("k_a", r"\mathrm{m}"),
    "x_i": ("x_i", r"\mathrm{m}"),
    "x_j": ("x_j", r"\mathrm{m}"),
    "x_prime": ("x'", r"\mathrm{m}"),
    "C_j": ("C_j", r"\mathrm{m^3}"),
    "pi": (r"\pi", "1"),
    "euclidean_norm": (r"\lVert\cdot\rVert_2", "1"),
    "dV_prime": ("dV'", r"\mathrm{m^3}"),
    "source_sum": (r"\sum_j", "1"),
    "K": ("K", r"\mathrm{m}"),
    "positive_zero_tensor": (r"+0_{3\times3}", r"\mathrm{m}"),
    "H_oe_hat": (r"\widehat{H}_{\mathrm{oe},a}", r"\mathrm{A\,m^{-1}}"),
    "k_hat": (r"\widehat{k}_a", r"\mathrm{m}"),
    "J_c_hat": (r"\widehat{J}_{c,a}", r"\mathrm{A\,m^{-2}}"),
    "N_a": ("N_a", "1"),
    "P_a": ("P_a", "1"),
    "q_a": ("q_a", "1"),
    "d_a": ("d_a", "1"),
    "diagnostic_field": ("f", "A/m^2 or A/m"),
    "delta0_a": (r"\delta_a^0", r"\mathrm{m^{-1}}"),
    "h_a": ("h_a", r"\mathrm{m}"),
    "D_h": ("D_h", r"\mathrm{m^{-1}}"),
    "C_h": ("C_h", r"\mathrm{m^{-1}}"),
    "I_2": (r"\mathcal I_2", "1"),
    "b_open": (r"b_{\mathrm{open}}", "1"),
    "V_h": ("V_h", r"\mathrm{m^3}"),
    "rms_norm": (r"\lVert\cdot\rVert_{2,h,\mathcal I_2}", "1"),
    "diagnostic_sum": (r"\sum_{i\in\mathcal I_2}", "1"),
    "S_J": ("S_J", r"\mathrm{A\,m^{-2}}"),
    "S_A": ("S_A", r"\mathrm{A\,m^{-2}}"),
    "h_min": (r"h_{\min}", r"\mathrm{m}"),
    "h_max": (r"h_{\max}", r"\mathrm{m}"),
    "rho_divJ": (r"\rho_{\mathrm{div}J}", "1"),
    "rho_divH": (r"\rho_{\mathrm{div}H}", "1"),
    "rho_A": (r"\rho_{\mathrm A}", "1"),
    "p": ("p", "1"),
    "p_min": (r"p_{\min}", "1"),
    "h_refinement": ("h", r"\mathrm{m}"),
    "epsilon_fp64": (r"\epsilon_{\mathrm{FP64}}", "1"),
    "rho_generic": (r"\rho", "1"),
    "k_prod": (r"k_a^{\mathrm{prod}}", r"\mathrm{m}"),
    "k_hat_prod": (r"\widehat{k}_a^{\mathrm{prod}}", r"\mathrm{m}"),
    "k_ref": (r"k_a^{\mathrm{ref}}", r"\mathrm{m}"),
    "B_a": ("B_a", r"\mathrm{m}"),
    "a_K": ("a_K", "1"),
    "r_K": ("r_K", "1"),
    "F_a_plus": (r"F_a^+", r"\mathrm{m^2}"),
    "F_a_minus": (r"F_a^-", r"\mathrm{m^2}"),
    "dS_prime": (r"dS'", r"\mathrm{m^2}"),
    "A_spot": (r"A_a^{(L)}", r"\mathrm{m}"),
    "A_previous": (r"A_a^{(L-1)}", r"\mathrm{m}"),
    "E_spot": (r"E_a^{\mathrm{spot}}", r"\mathrm{m}"),
    "B_spot": (r"B_a^{\mathrm{spot}}", r"\mathrm{m}"),
    "a_S": (r"a_S", "1"),
    "r_S": (r"r_S", "1"),
    "q": ("q", "1"),
    "Z_real": (r"\mathcal Z_{\mathrm{real}}", "1"),
    "Z_spec": (r"\mathcal Z_{\mathrm{spec}}", "1"),
    "positive_zero_scalar": ("+0", r"\mathrm{m}"),
    "S_H_i": (r"S_{H,i}", r"\mathrm{A\,m^{-1}}"),
    "log2_operator": (r"\log_2", "1"),
    "max_operator": (r"\max", "1"),
    "min_operator": (r"\min", "1"),
    "absolute_value": (r"|\cdot|", "1"),
}


EXACT_REVIEW_MUTATIONS = {
    "prose J cross r sign": (
        "H_x=J_y k_z-J_z k_y",
        "H_x=J_y k_z+J_z k_y",
    ),
    "prose self K zero": (
        r"gives $K(0)=+0_{3\times3}$ **exactly**",
        r"gives $K(0)=I_{3\times3}$ **exactly**",
    ),
    "inverse normalization factor": (
        "exactly once by $1/(P_xP_yP_z)$",
        "exactly once by $2/(P_xP_yP_z)$",
    ),
    "source-mask erasure": (
        "must not erase conductor cells before convolution",
        "may erase conductor cells before convolution",
    ),
    "PBC reuses open operator": (
        "PBC is not silently converted to open boundaries",
        "PBC may reuse the open operator for periodic boundaries",
    ),
}


ADDITIONAL_MUTATIONS = {
    "face mean": (
        r"=\frac{\chi_{c,i}}{2}\left[",
        r"=\chi_{c,i}\left[",
    ),
    "real-space J cross r sign": (
        r"0&k_z&-k_y\\",
        r"0&-k_z&k_y\\",
    ),
    "odd parity": (r"K(-r)&=-K(r)", r"K(-r)&=K(r)"),
    "self term": (r"K(0)=+0_{3\times3}", r"K(0)=I_{3\times3}"),
    "independent masks": (
        "magnetic target mask $\\chi_m$ are independent",
        "magnetic target mask $\\chi_m$ are identical",
    ),
    "low-corner pack": (
        "Physical current is packed into $0\\le q_a<N_a$",
        "Physical current is packed into $N_a\\le q_a<P_a$",
    ),
    "low-box crop": (
        "crops exactly the low-index box $0\\le q_a<N_a$",
        "crops exactly the high-index box $N_a\\le q_a<P_a$",
    ),
    "R2C layout": (
        "`[P_z][P_y][P_x/2+1]`",
        "`[P_x][P_y][P_z/2+1]`",
    ),
    "normalisation": (
        "exactly once by $1/(P_xP_yP_z)$",
        "exactly twice by $1/(P_xP_yP_z)$",
    ),
    "singleton padding": (
        "also when $N_a=1$",
        "except when $N_a=1$",
    ),
    "DC": ("The DC bin is exactly zero", "The DC bin is retained"),
    "Nyquist planes": (
        "No complete Nyquist plane is zeroed",
        "Every complete Nyquist plane is zeroed",
    ),
    "PBC fail-close": (
        "must fail closed before allocation or FFT planning",
        "may fall back before allocation or FFT planning",
    ),
    "spectral J cross r sign": (
        r"0&\widehat{k}_z&-\widehat{k}_y\\",
        r"0&-\widehat{k}_z&\widehat{k}_y\\",
    ),
    "merge real and spectral exact-zero classes": (
        r"(q,a)\in\mathcal Z_{\mathrm{spec}}",
        r"(r,a)\in\mathcal Z_{\mathrm{real}}",
    ),
    "surface oracle sign": (
        r"\int_{F_a^-}\frac{dS'}{\lVert x_i-x'\rVert_2}",
        r"+\int_{F_a^-}\frac{dS'}{\lVert x_i-x'\rVert_2}",
    ),
    "adaptive spot bound": (
        r"E_a^{\mathrm{spot}}\le B_a^{\mathrm{spot}}",
        r"E_a^{\mathrm{spot}}\ge B_a^{\mathrm{spot}}",
    ),
}


def _normalise(value: str) -> str:
    return " ".join(value.split())


def _math_block(page: str, label: str) -> str:
    match = re.search(
        rf"```{{math}}\s*:label:\s*{re.escape(label)}\s*(.*?)```",
        page,
        flags=re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"missing labelled equation {label}")
    return _normalise(match.group(1))


def _assert_page_contract(page: str) -> None:
    normalised = _normalise(page)
    face = _math_block(page, "fdm-oersted-face-to-cell-current")
    kernel = _math_block(page, "fdm-oersted-cell-integrated-kernel")
    fft = _math_block(page, "fdm-oersted-fft-convolution")
    differential = _math_block(
        page, "fdm-oersted-post-reconstruction-differential-operators"
    )
    residuals = _math_block(page, "fdm-oersted-post-reconstruction-residuals")
    refinement = _math_block(page, "fdm-oersted-post-reconstruction-refinement")
    mixed_bound = _math_block(page, "fdm-oersted-direct-oracle-mixed-bound")
    surface_oracle = _math_block(
        page, "fdm-oersted-direct-oracle-surface-reduction"
    )
    spot_check = _math_block(page, "fdm-oersted-direct-oracle-spot-check")
    exact_zero = _math_block(page, "fdm-oersted-direct-oracle-exact-zero")

    for required in (
        r"=\frac{\chi_{c,i}}{2}\left[",
        r"(J_c^{\mathrm{face}})_{i-\frac12 e_a,a} +(J_c^{\mathrm{face}})_{i+\frac12 e_a,a}",
    ):
        if required not in face:
            raise AssertionError(f"face reconstruction lost {required}")

    for required in (
        r"0&k_z&-k_y\\ -k_z&0&k_x\\ k_y&-k_x&0",
        r"K(-r)&=-K(r)",
        r"K(0)=+0_{3\times3}",
    ):
        if required not in kernel:
            raise AssertionError(f"kernel contract lost {required}")

    for required in (
        r"0&\widehat{k}_z&-\widehat{k}_y\\ -\widehat{k}_z&0&\widehat{k}_x\\ \widehat{k}_y&-\widehat{k}_x&0",
        r"\widehat{H}_{\mathrm{oe},x}",
        r"\widehat{J}_{c,x}",
    ):
        if required not in fft:
            raise AssertionError(f"spectral sign contract lost {required}")

    for required in (
        r"(\delta_a^0 f)_i=\frac{f_{i+e_a}-f_{i-e_a}}{2h_a}",
        r"D_hJ_c^{\mathrm{cell}}",
        r"C_hH_{\mathrm{oe}}",
    ):
        if required not in differential:
            raise AssertionError(f"differential diagnostic lost {required}")

    for required in (
        r"\lVert f\rVert_{2,h,\mathcal I_2}",
        r"\rho_{\mathrm{div}J}",
        r"\rho_{\mathrm{div}H}",
        r"\rho_{\mathrm A}",
        r"C_hH_{\mathrm{oe}}-J_c^{\mathrm{cell}}",
    ):
        if required not in residuals:
            raise AssertionError(f"residual diagnostic lost {required}")

    for required in (
        r"\rho_{\mathrm{div}J}(h/4)\le2\times10^{-2}",
        r"\rho_{\mathrm{div}H}(h/4)\le2\times10^{-2}",
        r"\rho_{\mathrm A}(h/4)\le5\times10^{-2}",
        r"p=\log_2\!\frac{\rho(h/2)}{\rho(h/4)}\ge p_{\min}=1.5",
        r"64\epsilon_{\mathrm{FP64}}",
    ):
        if required not in refinement:
            raise AssertionError(f"refinement contract lost {required}")

    for required in (
        r"B_a=a_Kh_{\max}+r_K|k_a^{\mathrm{ref}}|",
        r"|k_a^{\mathrm{prod}}-k_a^{\mathrm{ref}}|\le B_a",
        r"a_K=2\times10^{-13}",
        r"r_K=2\times10^{-11}",
    ):
        if required not in mixed_bound:
            raise AssertionError(f"mixed oracle bound lost {required}")

    for required in (
        r"k_a^{\mathrm{ref}}",
        r"\int_{F_a^+}\frac{dS'}{\lVert x_i-x'\rVert_2}",
        r"-\int_{F_a^-}\frac{dS'}{\lVert x_i-x'\rVert_2}",
    ):
        if required not in surface_oracle:
            raise AssertionError(f"surface oracle contract lost {required}")

    for required in (
        r"E_a^{\mathrm{spot}}=|A_a^{(L)}-A_a^{(L-1)}|",
        r"B_a^{\mathrm{spot}}=a_Sh_{\max}+r_S|A_a^{(L)}|",
        r"E_a^{\mathrm{spot}}\le B_a^{\mathrm{spot}}",
        r"|k_a^{\mathrm{ref}}-A_a^{(L)}|\le4B_a^{\mathrm{spot}}",
        r"a_S=2\times10^{-14}",
        r"r_S=2\times10^{-13}",
    ):
        if required not in spot_check:
            raise AssertionError(f"oracle spot-check contract lost {required}")

    for required in (
        r"(r,a)\in\mathcal Z_{\mathrm{real}}",
        r"k_a^{\mathrm{prod}}(r)=+0",
        r"(q,a)\in\mathcal Z_{\mathrm{spec}}",
        r"\widehat{k}_a^{\mathrm{prod}}(q)=+0",
        r"K(-r)=-K(r)",
        r"K(0)=+0_{3\times3}",
    ):
        if required not in exact_zero:
            raise AssertionError(f"exact-zero oracle contract lost {required}")

    for required in (
        "The conductor mask $\\chi_c$ and magnetic target mask $\\chi_m$ are independent",
        "must not erase conductor cells before convolution",
        "does not assert or require a commuting identity",
        "b_{\\mathrm{open}}=2",
        "\\mathcal I_2",
        "\\rho_{\\mathrm{div}J}",
        "\\rho_{\\mathrm{div}H}",
        "\\rho_{\\mathrm A}",
        "p_{\\min}=1.5",
        "\\rho_{\\mathrm{div}J}(h/4)\\le2\\times10^{-2}",
        "\\rho_{\\mathrm{div}H}(h/4)\\le2\\times10^{-2}",
        "\\rho_{\\mathrm A}(h/4)\\le5\\times10^{-2}",
        "closed_face_loop_exact.v1",
        "complete physical low-index union-grid field produced by the inverse FFT **before** applying $\\chi_m$",
        "exactly one typed `source_cut` record for every driven connected conductor component",
        "impressed_potential_jump.v1",
        "trusted_snapshot_revision",
        "zero-allocation trusted fast path",
        "Candidate and failure results are separate from the last accepted payload",
        "literal oriented Ampere contour",
        "tensor-product Gauss--Legendre order 16",
        "levels $1,2,4,8,16,32,64$",
        "Physical current is packed into $0\\le q_a<N_a$",
        "crops exactly the low-index box $0\\le q_a<N_a$",
        "`[P_z][P_y][P_x/2+1]`",
        "exactly once by $1/(P_xP_yP_z)$",
        "also when $N_a=1$",
        "The DC bin is exactly zero",
        "No complete Nyquist plane is zeroed",
        "must fail closed before allocation or FFT planning",
        "PBC is not silently converted to open boundaries",
        "H_x=J_y k_z-J_z k_y",
        "gives $K(0)=+0_{3\\times3}$ **exactly**",
        "|k_a^{\\mathrm{prod}}-k_a^{\\mathrm{ref}}|\\le B_a",
        "a_K=2\\times10^{-13}",
        "r_K=2\\times10^{-11}",
        "exact_zero_by_symmetry.v1",
        "oersted_direct_surface_potential_long_double.v1",
        "oersted_surface_adaptive_spot_check.v1",
        "E_a^{\\mathrm{spot}}\\le B_a^{\\mathrm{spot}}",
        "normal-magnitude positive fixture",
        "cancellation-dominated positive fixture",
        "over-bound negative fixture",
    ):
        if _normalise(required) not in normalised:
            raise AssertionError(f"page contract lost {required}")


class DynamicCurrentOerstedContractDocsTests(unittest.TestCase):
    def test_fdm_cpu_public_binding_scope_includes_positive_closed_geometry(self) -> None:
        page = _normalise(PAGE.read_text(encoding="utf-8"))
        source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))
        for required in (
            "fullmag_fdm_cpu_oersted_solve_v1",
            "fullmag_fdm_cpu_oersted_request_v1",
            "fullmag_fdm_cpu_oersted_result_v1",
            "global_closed_current_certificate.v1",
            "accepted raw face-current",
            "fdm_oersted_cell_integrated_open.v1",
            "oersted_fdm_fft_open.v1",
            "fdm_oersted_fft_open_v1",
            "StructuredCurrentClosure",
            "structured_current_closure.v1",
            "fv_charge_harmonic_source_cut_v1",
            "publiczny test E2E",
            "niezerowe `H_oe`",
            "`certified_import` pozostają odrzucone",
            "nie wprowadza globalnego sztywnego budżetu 512 MiB",
            "semantic_only",
        ):
            self.assertIn(_normalise(required), page)
        sources = {source["id"]: source for source in source_map["sources"]}
        expected_paths = {
            "fdm-oersted-public-c-abi": "native/include/fullmag_fdm.h",
            "fdm-oersted-public-native-adapter": "backends/fdm/api/cpu_oersted_fft_v1.cpp",
            "fdm-oersted-public-abi-contract-test": "backends/fdm/tests/cpu_oersted_fft_public_abi_contract.cpp",
            "fdm-oersted-public-rust-ffi": "crates/fullmag-fdm-sys/src/lib.rs",
            "fdm-oersted-public-runner-binding": "crates/fullmag-runner/src/fdm/cpu/native_transport.rs",
            "fdm-oersted-public-positive-e2e": "crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs",
            "planner-structured-current-closure": "crates/fullmag-plan/src/spin_transport.rs",
            "control-room-structured-current-closure": "apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts",
            "openapi-structured-current-closure": "crates/fullmag-api/src/openapi_v2.rs",
        }
        self.assertEqual(
            expected_paths,
            {source_id: sources[source_id]["path"] for source_id in expected_paths},
        )

    def test_fdm_oersted_open_v1_is_fully_frozen_and_semantic_only(self) -> None:
        page = _normalise(PAGE.read_text(encoding="utf-8"))
        source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))

        _assert_page_contract(page)

        lanes = {
            (lane["solver"], lane["device"]): lane["status"]
            for lane in source_map["backend_matrix"]
        }
        self.assertEqual("semantic_only", lanes[("FDM", "CPU")])
        self.assertEqual("semantic_only", lanes[("FDM", "GPU")])

        equations = {equation["id"]: equation for equation in source_map["equations"]}
        for equation_id, expected_symbols in EQUATION_SYMBOLS.items():
            self.assertIn(equation_id, equations)
            self.assertEqual(expected_symbols, set(equations[equation_id]["symbols"]))

        symbols = {symbol["id"]: symbol for symbol in source_map["symbols"]}
        for symbol_id, (latex, si_unit) in SYMBOL_CONTRACT.items():
            self.assertIn(symbol_id, symbols)
            self.assertEqual(latex, symbols[symbol_id]["latex"])
            self.assertEqual(si_unit, symbols[symbol_id]["si_unit"])

        sources = {source["id"]: source for source in source_map["sources"]}
        contract_source = sources["fdm-oersted-open-v1-doc-contract-test"]
        self.assertEqual(
            "scripts/test_dynamic_current_oersted_contract_docs.py",
            contract_source["path"],
        )
        self.assertEqual(
            "test_fdm_oersted_open_v1_is_fully_frozen_and_semantic_only",
            contract_source["symbol"],
        )

    def test_exact_five_review_mutations_are_all_rejected(self) -> None:
        page = _normalise(PAGE.read_text(encoding="utf-8"))
        self.assertEqual(5, len(EXACT_REVIEW_MUTATIONS))
        accepted: dict[str, bool] = {}
        for name, (old, new) in EXACT_REVIEW_MUTATIONS.items():
            with self.subTest(name=name):
                self.assertIn(old, page, f"mutation precondition missing for {name}")
                mutated = page.replace(old, new, 1)
                try:
                    _assert_page_contract(mutated)
                except AssertionError:
                    accepted[name] = False
                else:
                    accepted[name] = True
        self.assertEqual(
            {name: False for name in EXACT_REVIEW_MUTATIONS},
            accepted,
        )
        self.assertTrue(all(not result for result in accepted.values()))

    def test_additional_structural_mutations_are_rejected(self) -> None:
        page = _normalise(PAGE.read_text(encoding="utf-8"))
        self.assertEqual(17, len(ADDITIONAL_MUTATIONS))
        for name, (old, new) in ADDITIONAL_MUTATIONS.items():
            with self.subTest(name=name):
                self.assertIn(old, page, f"mutation precondition missing for {name}")
                mutated = page.replace(old, new, 1)
                with self.assertRaises(AssertionError):
                    _assert_page_contract(mutated)


if __name__ == "__main__":
    unittest.main()
