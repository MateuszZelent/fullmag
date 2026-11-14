use fullmag_application::{ResolvedTaskInput, WorkerCommandEnvelope};
use sha2::{Digest, Sha256};

    #[test]
    fn retained_asset_v7_golden_bytes_remain_exact() {
        // Fixed v7 DTO bytes; baseline CI must independently confirm the historical serializer.
        let input = br#"{"schema_version":"resolved_task_input.v7","run_id":"run-legacy","task_id":"task-legacy","attempt_id":"attempt-legacy","ownership_epoch":1,"specification_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plan_fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requested_execution":{"backend":"fem","device":"cpu","precision":"double","mode":"strict"},"preparation":{"schema_version":"retained_asset_field_preparation_binding.v1","preparation_id":"prep-task-legacy","plan_fingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","receipt_sha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"inputs":{}}"#;
        let decoded: ResolvedTaskInput = serde_json::from_slice(input).unwrap(); decoded.validate().unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), input);
        assert_eq!(format!("{:x}", Sha256::digest(input)), "cf408e30d89c803e2210641918889a21d0b07e59d95b329943f2816bf23c23a0");
        let command = br#"{"schema_version":"worker_protocol.v7","message_id":"asset-prepare","sequence":1,"claim":{"run_id":"run-legacy","task_id":"task-legacy","attempt_id":"attempt-legacy","ownership_epoch":1,"lease_token":"lease-golden"},"command":{"kind":"prepare","resolved_input":{"schema_version":"resolved_task_input.v7","run_id":"run-legacy","task_id":"task-legacy","attempt_id":"attempt-legacy","ownership_epoch":1,"specification_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plan_fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requested_execution":{"backend":"fem","device":"cpu","precision":"double","mode":"strict"},"preparation":{"schema_version":"retained_asset_field_preparation_binding.v1","preparation_id":"prep-task-legacy","plan_fingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","receipt_sha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"inputs":{}}}}"#;
        let decoded: WorkerCommandEnvelope = serde_json::from_slice(command).unwrap();
        decoded.validate_for_claim(&decoded.claim).unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), command);
        assert_eq!(format!("{:x}", Sha256::digest(command)), "bc02e9aba41e852ee0955e359164d79d4d67d3f790ebf60886f7f1e97a877440");
    }

