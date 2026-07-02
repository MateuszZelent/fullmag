#[test]
fn native_fem_poisson_rhs_hot_path_reuses_workspace() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp"
    );
    let coeff_start = source
        .find("class MagnetizationCoefficient")
        .expect("MagnetizationCoefficient definition");
    let coeff_rest = &source[coeff_start..];
    let coeff_end = coeff_rest
        .find("\nstruct PoissonRhsWorkspace")
        .expect("MagnetizationCoefficient end marker");
    let coeff_body = &coeff_rest[..coeff_end];
    let start = source
        .find("bool assemble_demag_poisson_rhs(")
        .expect("assemble_demag_poisson_rhs definition");
    let rest = &source[start..];
    let end = rest
        .find("\n#endif")
        .expect("assemble_demag_poisson_rhs end marker");
    let body = &rest[..end];

    assert!(
        !body.contains("mfem::LinearForm b(fes)"),
        "assemble_poisson_rhs must reuse the context-owned LinearForm workspace"
    );
    assert!(
        !body.contains("AddDomainIntegrator("),
        "assemble_poisson_rhs must not allocate/add RHS integrators in the hot path"
    );
    let eval_start = coeff_body
        .find("void Eval(")
        .expect("MagnetizationCoefficient::Eval definition");
    let eval_rest = &coeff_body[eval_start..];
    let eval_end = eval_rest
        .find("\nprivate:")
        .expect("MagnetizationCoefficient::Eval end marker");
    let eval_body = &eval_rest[..eval_end];

    assert!(
        eval_body.contains("thread_local EvalScratch scratch"),
        "MagnetizationCoefficient::Eval must reuse thread-local element scratch"
    );
    assert!(
        !eval_body.contains("mfem::Array<int> dofs;"),
        "MagnetizationCoefficient::Eval must not allocate DOF scratch per coefficient evaluation"
    );
    assert!(
        !eval_body.contains("mfem::Vector shape(ndof)"),
        "MagnetizationCoefficient::Eval must not allocate shape scratch per coefficient evaluation"
    );
}

#[test]
fn native_fem_poisson_essential_zeroing_uses_context_tdof_list_directly() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp"
    );
    let start = source
        .find("void zero_poisson_essential_values(")
        .expect("zero_poisson_essential_values definition");
    let rest = &source[start..];
    let end = rest
        .find("\n\n\n} // namespace")
        .expect("zero_poisson_essential_values end marker");
    let body = &rest[..end];

    assert!(
        body.contains("for (const int tdof : ctx.poisson_demag.ess_tdof_list)"),
        "essential value zeroing must iterate the context-owned tdof list directly"
    );
    assert!(
        !source.contains("poisson_essential_tdofs("),
        "hot path must not construct a temporary mfem::Array wrapper for essential tdofs"
    );
}

#[test]
fn native_fem_demag_recovery_reuses_context_workspace() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp"
    );
    let start = source
        .find("bool recover_demag_poisson_field(")
        .expect("recover_demag_poisson_field definition");
    let rest = &source[start..];
    let end = rest
        .find("\n} // namespace")
        .expect("recover_demag_field end marker");
    let body = &rest[..end];

    assert!(
        body.contains("demag_recovery_workspace"),
        "recover_demag_field must use context-owned demag recovery workspace"
    );
    assert!(
        !body.contains("std::vector<std::vector<double>> field_partials("),
        "recover_demag_field must not allocate per-call full-size field partials"
    );
    assert!(
        !body.contains("std::vector<std::vector<double>> weight_partials("),
        "recover_demag_field must not allocate per-call full-size weight partials"
    );
    assert!(
        body.contains("serial_scratch"),
        "recover_demag_field must reuse context-owned serial element scratch"
    );
    assert!(
        body.contains("thread_scratch"),
        "recover_demag_field must reuse context-owned per-thread element scratch"
    );
    assert!(
        !body.contains("mfem::DenseMatrix dshape;"),
        "recover_demag_field must not allocate element DenseMatrix scratch per call/thread"
    );
    assert!(
        body.contains("robin_boundary_tmp"),
        "recover_demag_field must reuse context-owned Robin boundary scratch"
    );
    assert!(
        !body.contains("mfem::Vector Bu("),
        "recover_demag_field must not allocate Robin boundary scratch per recovery"
    );
}

#[test]
fn native_fem_hypre_solve_reuses_transfer_vectors() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp"
    );
    let start = source
        .find("bool solve_demag_poisson_hypre(")
        .expect("solve_demag_poisson_hypre definition");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n#endif\n\n} // namespace fullmag::fem")
        .expect("solve_poisson_hypre end marker");
    let body = &rest[..end];

    assert!(
        body.contains("poisson_hypre_workspace"),
        "solve_poisson_hypre must use context-owned Hypre transfer workspace"
    );
    assert!(
        !body.contains("mfem::HypreParVector b_par("),
        "solve_poisson_hypre must not allocate a fresh RHS HypreParVector per solve"
    );
    assert!(
        !body.contains("mfem::HypreParVector x_par("),
        "solve_poisson_hypre must not allocate a fresh solution HypreParVector per solve"
    );
}

#[test]
fn native_fem_hypre_solve_reuses_persistent_warm_start_vector() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp"
    );
    let start = source
        .find("bool solve_demag_poisson_hypre(")
        .expect("solve_demag_poisson_hypre definition");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n#endif\n\n} // namespace fullmag::fem")
        .expect("solve_poisson_hypre end marker");
    let body = &rest[..end];

    let guard = body
        .find("if (!poisson_hypre_workspace->x_par_contains_solution)")
        .expect("Hypre warm-start copy must be guarded by workspace validity");
    let solution_read = body
        .find("const double *sol_host = audited_host_read(warm_start_solution)")
        .expect("first Hypre solve still needs to seed x_par from solution");
    let solve_call = body
        .find("solver->Mult(b_par, x_par)")
        .expect("Hypre solver must use the persistent x_par vector");

    assert!(
        guard < solution_read && solution_read < solve_call,
        "solution-to-Hypre warm-start copy must happen only inside the guarded seed block"
    );
    assert!(
        body.contains("poisson_hypre_workspace->x_par_contains_solution = true"),
        "solve_poisson_hypre must mark the persistent Hypre solution vector valid after solve"
    );
}

#[test]
fn native_fem_non_pbc_demag_reuses_solution_workspace() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp"
    );
    let lifecycle = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp"
    );
    let start = source
        .find("bool context_compute_demag_poisson(")
        .expect("context_compute_demag_poisson definition");
    let rest = &source[start..];
    let end = rest
        .find("\n#endif")
        .expect("context_compute_demag_poisson end marker");
    let body = &rest[..end];

    assert!(
        lifecycle.contains("ctx.poisson_demag.solution_vec ="),
        "Poisson initialization must allocate a context-owned solution workspace"
    );
    assert!(
        lifecycle.contains("delete static_cast<mfem::Vector *>(ctx.poisson_demag.solution_vec)"),
        "Poisson destruction must release the context-owned solution workspace"
    );
    assert!(
        body.contains("ctx.poisson_demag.solution_vec"),
        "non-PBC demag solve must use the context-owned solution workspace"
    );
    assert!(
        !body.contains("mfem::Vector solution(fes->GetTrueVSize())"),
        "non-PBC demag solve must not allocate a fresh true-DOF solution vector per solve"
    );
    assert!(
        body.contains("if (!demag_poisson_hypre_has_warm_start(ctx))"),
        "non-PBC demag solve should skip GridFunction warm-start extraction when Hypre already has a persistent solution"
    );
}

#[test]
fn native_fem_hypre_solve_enables_iterative_mode_for_warm_start() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp"
    );
    let start = source
        .find("bool solve_demag_poisson_hypre(")
        .expect("solve_demag_poisson_hypre definition");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n#endif\n\n} // namespace fullmag::fem")
        .expect("solve_poisson_hypre end marker");
    let body = &rest[..end];

    assert!(
        body.contains("pcg->iterative_mode = true"),
        "HyprePCG must use the persistent x_par vector as a nonzero initial guess"
    );
    assert!(
        body.contains("gmres->iterative_mode = true"),
        "HypreGMRES must use the persistent x_par vector as a nonzero initial guess"
    );
}

#[test]
fn native_fem_hypre_solve_honors_configured_print_level() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp"
    );
    let start = source
        .find("bool solve_demag_poisson_hypre(")
        .expect("solve_demag_poisson_hypre definition");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n#endif\n\n} // namespace fullmag::fem")
        .expect("solve_poisson_hypre end marker");
    let body = &rest[..end];

    assert!(
        body.contains("ctx.demag.solver.print_level"),
        "native Hypre solver setup must use the configured demag print level"
    );
    assert!(
        body.contains("SetAbsTol(ctx.demag.solver.absolute_tolerance)"),
        "native Hypre solver setup must apply configured absolute tolerance"
    );
    assert!(
        !body.contains("SetPrintLevel(0)"),
        "native Hypre solver setup must not force print level to zero"
    );
}

#[test]
fn native_fem_periodic_demag_reduced_solve_reuses_workspace_and_warm_start() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp"
    );
    let start = source
        .find("bool solve_demag_periodic_poisson_reduced(")
        .expect("periodic demag solve block");
    let rest = &source[start..];
    let end = rest
        .find("\n#endif")
        .expect("periodic demag solve end marker");
    let body = &rest[..end];

    assert!(
        body.contains("periodic_workspace"),
        "periodic reduced demag solve must use a context-owned solver workspace"
    );
    assert!(
        !body.contains("*x_p = 0.0;"),
        "periodic reduced demag solve must retain x_p as the warm-start vector"
    );
    assert!(
        !body.contains("mfem::CGSolver solver;"),
        "periodic reduced demag solve must not allocate a fresh CGSolver per solve"
    );
    assert!(
        !body.contains("mfem::GSSmoother prec("),
        "periodic reduced demag solve must not allocate a fresh GSSmoother per solve"
    );
}

#[test]
fn native_fem_dmi_element_loops_reuse_context_workspace() {
    let sources = [
        (
            "compute_interfacial_dmi_field(",
            include_str!(
                "../../../../../native/backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp"
            ),
        ),
        (
            "compute_bulk_dmi_field(",
            include_str!("../../../../../native/backends/fem/cpu/mfem/interactions/dmi_bulk.cpp"),
        ),
    ];

    for (function_name, source) in sources {
        let start = source.find(function_name).expect("DMI function definition");
        let rest = &source[start..];
        let end = rest
            .find("\n} // namespace fullmag::fem")
            .expect("DMI function end marker");
        let body = &rest[..end];

        assert!(
            body.contains("dmi_element_workspace(ctx)"),
            "{function_name} must use context-owned DMI element workspace"
        );
        assert!(
            !body.contains("mfem::Vector mx_elem("),
            "{function_name} must not allocate mx_elem in the element loop"
        );
        assert!(
            !body.contains("mfem::Vector my_elem("),
            "{function_name} must not allocate my_elem in the element loop"
        );
        assert!(
            !body.contains("mfem::Vector mz_elem("),
            "{function_name} must not allocate mz_elem in the element loop"
        );
        assert!(
            !body.contains("mfem::DenseMatrix dshape("),
            "{function_name} must not allocate dshape in the quadrature loop"
        );
        assert!(
            !body.contains("mfem::Vector shape("),
            "{function_name} must not allocate shape in the quadrature loop"
        );
    }
}

#[test]
fn native_fem_fsal_cached_fields_move_without_copying() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp"
    );
    let start = source
        .find("if (final_stage_cache_valid) {")
        .expect("FSAL final-stage cache block");
    let rest = &source[start..];
    let end = rest
        .find("\n    } else {")
        .expect("FSAL final-stage cache block end");
    let body = &rest[..end];

    assert!(
        body.contains("std::swap(ctx.exchange.h_xyz, ws.h_ex_tmp)"),
        "FSAL accepted step should publish cached exchange field by swapping buffers"
    );
    assert!(
        body.contains("std::swap(ctx.demag.h_xyz, ws.h_demag_tmp)"),
        "FSAL accepted step should publish cached demag field by swapping buffers"
    );
    assert!(
        body.contains("std::swap(ctx.effective_field.h_xyz, ws.h_eff_tmp)"),
        "FSAL accepted step should publish cached effective field by swapping buffers"
    );
    assert!(
        !body.contains("ctx.exchange.h_xyz = ws.h_ex_tmp")
            && !body.contains("ctx.demag.h_xyz = ws.h_demag_tmp")
            && !body.contains("ctx.effective_field.h_xyz = ws.h_eff_tmp"),
        "FSAL accepted step must not copy full field buffers out of the stepper workspace"
    );
}

#[test]
fn native_fem_non_fsal_final_refresh_reuses_stepper_workspace() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp"
    );
    let start = source
        .find("if (final_stage_cache_valid) {")
        .expect("final field publish block");
    let rest = &source[start..];
    let end = rest
        .find("\n    ctx.state.current_time += dt;")
        .expect("final field publish block end");
    let body = &rest[..end];

    assert!(
        body.contains("ws.h_ex_tmp")
            && body.contains("ws.h_demag_tmp")
            && body.contains("ws.h_eff_tmp"),
        "non-FSAL final refresh should reuse stepper field workspace"
    );
    assert!(
        !body.contains("std::vector<double> h_ex_final")
            && !body.contains("std::vector<double> h_demag_final")
            && !body.contains("std::vector<double> h_eff_final"),
        "non-FSAL final refresh must not allocate local full-size field buffers"
    );

    let rhs_start = source
        .find("if (final_stage_cache_valid) {\n        max_rhs_final = max_norm_aos(ws.k[0]);")
        .expect("post-step RHS block");
    let rhs_rest = &source[rhs_start..];
    let rhs_end = rhs_rest
        .find("\n    stats.step = ctx.state.step_count;")
        .expect("post-step RHS block end");
    let rhs_body = &rhs_rest[..rhs_end];
    assert!(
        rhs_body.contains("ws.k[0], max_rhs_final"),
        "non-FSAL post-step RHS should reuse an existing stepper derivative buffer"
    );
    assert!(
        !rhs_body.contains("std::vector<double> rhs_final"),
        "non-FSAL post-step RHS must not allocate a local full-size RHS buffer"
    );
}

#[test]
fn native_fem_disabled_local_terms_are_not_zeroed_each_effective_field_eval() {
    let source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/effective_field.cpp"
    );
    let start = source
        .find("bool compute_effective_fields_for_magnetization(")
        .expect("effective field implementation");
    let rest = &source[start..];
    let end = rest
        .find("\n#endif")
        .expect("effective field implementation end");
    let body = &rest[..end];

    assert!(
        !body.contains("ctx.dmi.h_interfacial_xyz.assign(m_xyz.size(), 0.0)")
            && !body.contains("ctx.anisotropy.h_cubic_xyz.assign(m_xyz.size(), 0.0)")
            && !body.contains("ctx.dmi.h_bulk_xyz.assign(m_xyz.size(), 0.0)"),
        "disabled DMI/cubic/bulk-DMI buffers should not be cleared on every effective-field evaluation"
    );
    assert!(
        body.contains("if (ctx.exchange.enabled) {\n        h_ex_xyz.resize(m_xyz.size());")
            && body.contains("if (ctx.demag.enabled) {\n        h_demag_xyz.resize(m_xyz.size());")
            && body.contains("h_eff_xyz.resize(m_xyz.size());"),
        "active exchange/demag/H_eff buffers should avoid pre-zeroing before being overwritten"
    );
    assert!(
        !body.contains("h_eff_xyz.assign(m_xyz.size(), 0.0)"),
        "H_eff is fully overwritten later and must not be pre-zeroed every evaluation"
    );

    let context_source =
        include_str!("../../../../../native/backends/fem/core/fem_field_buffers.cpp");
    assert!(
        context_source
            .contains("fill_zero_vector_field(ctx.dmi.h_interfacial_xyz, ctx.mesh.n_nodes)")
            && context_source
                .contains("fill_zero_vector_field(ctx.anisotropy.h_cubic_xyz, ctx.mesh.n_nodes)")
            && context_source
                .contains("fill_zero_vector_field(ctx.dmi.h_bulk_xyz, ctx.mesh.n_nodes)"),
        "disabled local-term observable buffers must be initialized once in context_from_plan"
    );
}

#[test]
fn native_fem_demag_cache_copy_is_guarded_by_field_refresh_policy() {
    let source = include_str!("../../../../../native/backends/fem/cpu/mfem/interactions/demag.cpp");
    let cache_source = include_str!(
        "../../../../../native/backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp"
    );
    let start = source
        .find("bool compute_demag_field_for_magnetization(")
        .expect("demag field implementation");
    let rest = &source[start..];
    let end = rest
        .find("\n#endif")
        .expect("demag field implementation end");
    let body = &rest[..end];
    let cache_copy = body
        .find("demag_poisson_store_refreshed_field_cache(ctx, h_demag_xyz)")
        .expect("demag cache store");
    let policy_guard = body
        .find("if (decision.store_refreshed_field_cache) {")
        .expect("demag field-update decision guard");

    assert!(
        policy_guard < cache_copy,
        "fresh Poisson demag should call cache storage only when the field-update decision requests it"
    );
    assert!(
        cache_source.contains(
            "if (ctx.demag.field_refresh.has_demag_interval_s == 0) {\n        return;\n    }"
        ) && cache_source.contains("ctx.demag.cached_xyz = h_demag_xyz"),
        "cache storage must no-op when field_refresh is inactive before copying full demag fields"
    );
}

#[test]
fn native_fem_dmi_formula_smoke_has_directional_derivative_oracle() {
    let source = include_str!("../../../../../native/backends/fem/tests/dmi_weak_residual.cpp");

    assert!(
        source.contains("interfacial_energy_directional_derivative"),
        "native DMI formula smoke must compare interfacial dE/deps against field action"
    );
    assert!(
        source.contains("bulk_energy_directional_derivative"),
        "native DMI formula smoke must compare bulk dE/deps against field action"
    );
    assert!(
        source.contains("run_interfacial_directional_derivative_fixture"),
        "native DMI formula smoke must execute the interfacial directional-derivative fixture"
    );
    assert!(
        source.contains("run_bulk_directional_derivative_fixture"),
        "native DMI formula smoke must execute the bulk directional-derivative fixture"
    );
}

#[test]
fn native_fem_step_metrics_reuse_effective_field_local_energies() {
    let source =
        include_str!("../../../../../native/backends/fem/cpu/mfem/runtime/step_metrics.cpp");
    let start = source
        .find("void fill_common_step_metrics(")
        .expect("fill_common_step_metrics definition");
    let rest = &source[start..];
    let end = rest
        .find("\n} // namespace fullmag::fem")
        .expect("fill_common_step_metrics end marker");
    let body = &rest[..end];

    assert!(
        body.contains("ctx.anisotropy.energy_joules"),
        "step metrics must reuse the anisotropy energy from the final effective-field evaluation"
    );
    assert!(
        body.contains("ctx.dmi.energy_joules"),
        "step metrics must reuse the DMI energy from the final effective-field evaluation"
    );
    assert!(
        body.contains("ctx.magnetoelastic.energy_joules"),
        "step metrics must reuse the magnetoelastic energy from the final effective-field evaluation"
    );
    assert!(
        !body.contains("compute_uniaxial_anisotropy_field("),
        "step metrics must not recompute uniaxial anisotropy fields"
    );
    assert!(
        !body.contains("compute_cubic_anisotropy_field("),
        "step metrics must not recompute cubic anisotropy fields"
    );
    assert!(
        !body.contains("compute_interfacial_dmi_field("),
        "step metrics must not recompute interfacial DMI fields"
    );
    assert!(
        !body.contains("compute_bulk_dmi_field("),
        "step metrics must not recompute bulk DMI fields"
    );
    assert!(
        !body.contains("compute_magnetoelastic_field("),
        "step metrics must not recompute magnetoelastic fields"
    );
}
