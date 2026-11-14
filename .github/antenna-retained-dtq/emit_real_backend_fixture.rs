
    #[test]
    fn retained_dtq_emit_real_backend_fixture_for_old_parser() {
        let compiled = compile_retained_preparation(retained_dtq_config()).unwrap();
        let lowered = fullmag_plan::lower_study_plan_with_catalog(&compiled.study, &compiled.catalog).unwrap();
        assert!(!lowered.steps.is_empty());
        let backend = &lowered.steps[0].execution_plan.as_ref().unwrap().backend_plan;
        assert!(matches!(backend, fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(_)));
        let bytes = serde_json::to_vec(backend).unwrap();
        let path = std::path::PathBuf::from(std::env::var("FULLMAG_CI_DTQ_FIXTURE_PATH").unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        use sha2::Digest as _;
        println!("DTQ_REAL_BACKEND_FIXTURE_SHA256={:x}", sha2::Sha256::digest(&bytes));
    }
