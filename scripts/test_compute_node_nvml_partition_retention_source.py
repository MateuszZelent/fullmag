"""Source regressions for an absent NVML partition observation.

A timed-out NVML probe must not change the published inventory identity of a
GPU that the previous sample of the same boot proved to be a full device, and
it must not open GPU admission either. These checks read the Rust sources and
never compile or execute them.
"""

from __future__ import annotations

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "crates/fullmag-runtime-control/src/compute_node_probe.rs"
NVML = ROOT / "crates/fullmag-runtime-control/src/nvml_gpu_partition.rs"
SNAPSHOT = ROOT / "crates/fullmag-session/src/compute_node_snapshot.rs"
LEDGER = ROOT / "crates/fullmag-session/src/host_resource_ledger.rs"
SERVICE = ROOT / "crates/fullmag-api/src/runtime_service_main.rs"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _function(source: str, name: str) -> str:
    """Return one `fn` body, free or associated, by brace matching."""
    match = re.search(r"\n[ \t]*(?:pub(?:\(crate\))? )?(?:const )?fn " + name + r"\b", source)
    assert match, f"missing fn {name}"
    start = source.index("{", match.end())
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[match.start() : index + 1]
    raise AssertionError(f"unterminated fn {name}")


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


class NvmlPartitionRetentionSourceTests(unittest.TestCase):
    def test_only_an_absent_observation_without_mig_evidence_is_retained(self) -> None:
        discover = _compact(_function(_text(PROBE), "discover_nvidia_gpus"))
        self.assertIn(
            "ifreason.is_retryable()&&!mig_enabled.contains(&device.uuid){"
            "retain_unconfirmed_full_device_partition(device,previous_devices);}",
            discover,
        )
        # The retention call lives only in the inconclusive arm.
        self.assertEqual(discover.count("retain_unconfirmed_full_device_partition("), 1)
        not_full = discover.split("FullDeviceProbeOutcome::NotFullDevice=>", 1)[1]
        self.assertTrue(not_full.startswith("{}"), "a positive non-full result must stay unknown")

        retryable = _compact(_function(_text(NVML), "is_retryable"))
        for reason in ("DeadlineExpired", "Unavailable", "InvalidRecord", "IncompleteEvidence"):
            self.assertIn(f"Self::{reason}", retryable)
        for reason in ("InvalidUuid", "UnsupportedPlatform"):
            self.assertNotIn(f"Self::{reason}", retryable)

    def test_retained_partition_is_last_known_never_a_current_full_device(self) -> None:
        retain = _compact(_function(_text(PROBE), "retain_unconfirmed_full_device_partition"))
        self.assertIn(
            "device.partition=Reported::Unavailable{reason:UnavailableReason::ProbeFailed,"
            "last_known:Some(GpuPartition::FullDevice),};",
            retain,
        )
        self.assertNotIn("Reported::Available", retain)
        for binding in (
            "previous.uuid==device.uuid",
            "previous.pci_id.known_value().is_some()",
            "previous.pci_id.known_value()==device.pci_id.known_value()",
            "previous.partition.known_value()==Some(&GpuPartition::FullDevice)",
        ):
            self.assertIn(binding, retain)

    def test_previous_inventory_is_bound_to_the_same_node_and_boot(self) -> None:
        sample = _compact(_function(_text(PROBE), "sample_compute_node_inner"))
        self.assertIn("snapshot.node_id==node_id", sample)
        self.assertIn("current_host_boot_id(Utc::now()).is_ok_and(|boot_id|boot_id==snapshot.boot_id)", sample)
        self.assertIn("discover_nvidia_gpus(previous_gpus)", sample)
        # Native readiness proves the partition anew and never inherits it.
        readiness = _compact(_text(PROBE))
        self.assertIn("letdevices=discover_nvidia_gpus(None)?;", readiness)

    def test_inventory_digest_keeps_last_known_partition_identity(self) -> None:
        digest = _compact(_function(_text(SNAPSHOT), "computed_inventory_sha256"))
        self.assertIn("partition:gpu.partition.known_value()", digest)

    def test_gpu_admission_still_requires_a_current_full_device(self) -> None:
        ledger = _compact(_text(LEDGER))
        self.assertIn(
            "if!matches!(&device.partition,Reported::Available{value:GpuPartition::FullDevice})"
            "{bail!(\"GPUhostadmissionrequiresaconfirmedfull-devicepartition\");}",
            ledger,
        )

    def test_publication_is_not_deferred_for_an_unresolved_partition(self) -> None:
        # Deferring publication also delayed a real MIG change; an unknown
        # partition now reaches publication and fails it closed at once.
        service = _text(SERVICE)
        self.assertNotIn("TransientGpuPartitionSample", service)
        self.assertNotIn("MAX_CONSECUTIVE_TRANSIENT_GPU_PARTITION_SAMPLES", service)


if __name__ == "__main__":
    unittest.main()
