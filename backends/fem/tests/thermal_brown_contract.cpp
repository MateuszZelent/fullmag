/*
 * thermal_brown_contract.cpp - native FEM Brown thermal-field contract tests.
 *
 * The Brown field is a stochastic effective-field contribution in A/m. The
 * module owns the per-node sigma formula, buffer lifecycle, refresh cache, and
 * additive H_eff semantics. It must not apply gamma, damping, or torque factors
 * beyond the Brown sigma expression itself.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;
constexpr double kBTest = 1.380649e-23;

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void thermal_brown_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown.hpp");
    const std::string sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string sigma_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.hpp");
    const std::string sampler =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.cpp");
    const std::string sampler_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_field.hpp");

    const char *sigma_symbol = "double thermal_brown_sigma(";
    const char *refresh_symbol = "void refresh_thermal_brown_field(";
    const char *add_symbol = "void add_thermal_brown_field(";
    const char *plan_symbol = "void initialize_thermal_brown_plan_fields(";

    check(
        aggregate.find(sigma_symbol) == std::string::npos,
        "Brown sigma formula must not be defined in thermal_brown.cpp");
    check(
        aggregate.find(refresh_symbol) == std::string::npos,
        "Brown refresh/sampling must not be defined in thermal_brown.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "Brown H_eff addition must not be defined in thermal_brown.cpp");
    check(
        context.find("ctx.thermal_brown.temperature = plan.temperature") == std::string::npos,
        "Context must not own Brown temperature plan import");
    check(
        context.find("ctx.thermal_brown.seed = plan.thermal_seed") == std::string::npos,
        "Context must not own Brown thermal seed plan import");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "Brown plan import must be defined in thermal_brown.cpp");
    check(
        sigma.find(sigma_symbol) != std::string::npos,
        "Brown sigma formula must be defined in thermal_brown_sigma.cpp");
    check(
        sampler.find(refresh_symbol) != std::string::npos,
        "Brown refresh/sampling must be defined in thermal_brown_sampler.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "Brown H_eff addition must be defined in thermal_brown_field.cpp");
    check(
        sigma_header.find("Compute the Brown thermal-field standard deviation") !=
            std::string::npos,
        "Brown sigma header must document its physical contract");
    check(
        sigma_header.find("does not sample RNG state or add H_therm to H_eff") !=
            std::string::npos,
        "Brown sigma header must document its non-owning sampling/add boundary");
    check(
        sampler_header.find("Refresh the Brown thermal field") != std::string::npos,
        "Brown sampler header must document its physical contract");
    check(
        sampler_header.find("does not define the sigma formula or add H_therm to H_eff") !=
            std::string::npos,
        "Brown sampler header must document its non-owning sigma/add boundary");
    check(
        field_header.find("Add the current Brown thermal field") != std::string::npos,
        "Brown field header must document its physical contract");
    check(
        field_header.find("does not sample RNG state or compute Brown sigma") !=
            std::string::npos,
        "Brown field header must document its non-owning sampling/sigma boundary");
    check(
        aggregate_header.find("Initialize Brown thermal plan fields") != std::string::npos,
        "Brown aggregate header must document plan-field initialization ownership");
    check(
        aggregate_header.find("does not define") != std::string::npos,
        "Brown aggregate header must document its non-owning boundary");
    check(
        aggregate_header.find("Brown sigma") != std::string::npos,
        "Brown aggregate header must mention sigma ownership");
    check(
        aggregate_header.find("refresh sampling") != std::string::npos,
        "Brown aggregate header must document that sampling is not owned by the aggregate");
    check(
        aggregate_header.find("H_eff") != std::string::npos,
        "Brown aggregate header must mention H_eff ownership");
    check(
        aggregate_header.find("addition") != std::string::npos,
        "Brown aggregate header must document that field addition is not owned by the aggregate");
    check(
        aggregate_header.find("thermal_brown_sigma.*") != std::string::npos,
        "Brown aggregate header must name the sigma owner");
    check(
        aggregate_header.find("thermal_brown_sampler.*") != std::string::npos,
        "Brown aggregate header must name the sampler owner");
    check(
        aggregate_header.find("thermal_brown_field.*") != std::string::npos,
        "Brown aggregate header must name the field-add owner");
}

void thermal_brown_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown.cpp");
    const std::string sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string sampler =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.cpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_field.cpp");

    check(
        aggregate.find("Brown thermal aggregate source contract") != std::string::npos,
        "Brown aggregate source file must document its source contract");
    check(
        aggregate.find("does not define sigma, sampling/cache, or H_eff addition") !=
            std::string::npos,
        "Brown aggregate source file must document its non-owning boundary");
    check(
        sigma.find("Brown thermal sigma source contract") != std::string::npos,
        "Brown sigma source file must document its source contract");
    check(
        sigma.find("does not sample RNG state or add H_therm to H_eff") !=
            std::string::npos,
        "Brown sigma source file must document its non-owning sampling/add boundary");
    check(
        sampler.find("Brown thermal sampler source contract") != std::string::npos,
        "Brown sampler source file must document its source contract");
    check(
        sampler.find("does not define the sigma formula or add H_therm to H_eff") !=
            std::string::npos,
        "Brown sampler source file must document its non-owning sigma/add boundary");
    check(
        field.find("Brown thermal field-add source contract") != std::string::npos,
        "Brown field-add source file must document its source contract");
    check(
        field.find("does not sample RNG state or compute Brown sigma") != std::string::npos,
        "Brown field-add source file must document its non-owning sampling/sigma boundary");
}

void thermal_brown_gamma_convention_is_documented() {
    const std::filesystem::path root = fem_source_root();
    const std::string sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string sigma_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.hpp");
    const std::string physics =
        read_text_file(root.parent_path().parent_path().parent_path() /
                       "docs" / "physics" / "fem_thermal_brown.md");

    for (const std::string *text : {&sigma, &sigma_header, &physics}) {
        check(
            text->find("bare gamma_mu0") != std::string::npos,
            "Brown thermal sigma docs must say gyromagnetic_ratio is bare gamma_mu0");
        check(
            text->find("not gamma_bar") != std::string::npos,
            "Brown thermal sigma docs must reject passing the damped gamma_bar convention");
    }
}

void thermal_brown_runtime_state_is_owned_by_sampler_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string sampler_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.hpp");

    check(
        sampler_header.find("struct ThermalBrownRuntimeState") != std::string::npos,
        "Brown thermal runtime state must be declared by thermal_brown_sampler.hpp");
    check(
        sampler_header.find("double temperature") != std::string::npos,
        "Brown thermal runtime state must own the temperature plan field");
    check(
        sampler_header.find("uint64_t seed") != std::string::npos,
        "Brown thermal runtime state must own the RNG seed plan field");
    check(
        sampler_header.find("double sigma") != std::string::npos,
        "Brown thermal runtime state must own the sigma diagnostic");
    check(
        sampler_header.find("double last_refresh_time") != std::string::npos,
        "Brown thermal runtime state must own the refresh-time cache");
    check(
        sampler_header.find("double last_refresh_dt") != std::string::npos,
        "Brown thermal runtime state must own the refresh-dt cache");
    check(
        sampler_header.find("std::vector<double> h_xyz") != std::string::npos,
        "Brown thermal runtime state must own the sampled H field buffer");
    check(
        context_header.find("ThermalBrownRuntimeState thermal_brown") != std::string::npos,
        "Context must store Brown thermal runtime state through the sampler owner");
    check(
        context_header.find("double thermal_sigma") == std::string::npos,
        "Context must not own flat Brown thermal sigma state");
    check(
        context_header.find("last_thermal_refresh_time") == std::string::npos,
        "Context must not own flat Brown thermal refresh-time cache");
    check(
        context_header.find("last_thermal_refresh_dt") == std::string::npos,
        "Context must not own flat Brown thermal refresh-dt cache");
    check(
        context_header.find("h_therm_xyz") == std::string::npos,
        "Context must not own flat Brown thermal field buffer");
    check(
        context_header.find("double temperature") == std::string::npos,
        "Context must not own a flat Brown temperature plan field");
    check(
        context_header.find("uint64_t thermal_seed") == std::string::npos,
        "Context must not own a flat Brown RNG seed plan field");
}

void check_near(double actual, double expected, double tol, const char *msg) {
    if (std::fabs(actual - expected) > tol) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g\n",
            msg,
            expected,
            actual);
        std::exit(1);
    }
}

void sigma_formula_matches_brown_field_contract() {
    const double temperature = 300.0;
    const double alpha = 0.1;
    const double gamma_red = 2.211e5;
    const double ms = 800e3;
    const double volume = 2.0e-27;
    const double dt = 5.0e-13;

    const double expected = std::sqrt(
        2.0 * alpha * kBTest * temperature /
        (gamma_red * (1.0 + alpha * alpha) * kMu0Test * ms * volume * dt));
    check_near(
        fullmag::fem::thermal_brown_sigma(
            temperature,
            alpha,
            gamma_red,
            ms,
            volume,
            dt),
        expected,
        expected * 1e-12,
        "Brown sigma formula");

    check_near(
        fullmag::fem::thermal_brown_sigma(0.0, alpha, gamma_red, ms, volume, dt),
        0.0,
        0.0,
        "zero temperature sigma");
    check_near(
        fullmag::fem::thermal_brown_sigma(temperature, 0.0, gamma_red, ms, volume, dt),
        0.0,
        0.0,
        "zero damping sigma");
    check_near(
        fullmag::fem::thermal_brown_sigma(temperature, alpha, gamma_red, ms, volume, 0.0),
        0.0,
        0.0,
        "zero dt sigma");
}

fullmag::fem::Context make_thermal_context() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.thermal_brown.temperature = 300.0;
    ctx.adaptive_dt.current_dt = 2.0e-12;
    ctx.state.current_time = 5.0e-9;
    ctx.thermal_brown.seed = 1234;
    ctx.material_fields.material.damping = 0.1;
    ctx.material_fields.material.gyromagnetic_ratio = 2.211e5;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.mesh.node_volumes = {1.0e-27, 4.0e-27};
    ctx.material_fields.alpha_field = {0.1, 0.2};
    ctx.material_fields.Ms_field = {800e3, 400e3};
    ctx.mesh.magnetic_node_mask = {1u, 0u};
    return ctx;
}

void refresh_uses_per_node_sigma_mask_and_cache() {
    auto ctx = make_thermal_context();

    fullmag::fem::initialize_thermal_brown_field(ctx);
    check(ctx.thermal_brown.h_xyz.size() == 6u, "thermal field buffer size");

    fullmag::fem::refresh_thermal_brown_field(ctx);

    const double expected_sigma = fullmag::fem::thermal_brown_sigma(
        ctx.thermal_brown.temperature,
        ctx.material_fields.alpha_field[0],
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.Ms_field[0],
        ctx.mesh.node_volumes[0],
        ctx.adaptive_dt.current_dt);
    check_near(
        ctx.thermal_brown.sigma,
        expected_sigma,
        expected_sigma * 1e-12,
        "thermal sigma diagnostic stores max active-node sigma");
    check_near(ctx.thermal_brown.last_refresh_time, ctx.state.current_time, 0.0, "thermal time cache");
    check_near(ctx.thermal_brown.last_refresh_dt, ctx.adaptive_dt.current_dt, 0.0, "thermal dt cache");

    check_near(ctx.thermal_brown.h_xyz[3], 0.0, 0.0, "nonmagnetic thermal Hx");
    check_near(ctx.thermal_brown.h_xyz[4], 0.0, 0.0, "nonmagnetic thermal Hy");
    check_near(ctx.thermal_brown.h_xyz[5], 0.0, 0.0, "nonmagnetic thermal Hz");

    const auto first_refresh = ctx.thermal_brown.h_xyz;
    fullmag::fem::refresh_thermal_brown_field(ctx);
    check(ctx.thermal_brown.h_xyz == first_refresh, "same time/dt thermal refresh is cached");
}

void seeded_replay_is_deterministic_for_same_time_and_dt() {
    auto first = make_thermal_context();
    auto replay = make_thermal_context();

    fullmag::fem::refresh_thermal_brown_field(first);
    fullmag::fem::refresh_thermal_brown_field(replay);

    check(
        replay.thermal_brown.h_xyz == first.thermal_brown.h_xyz,
        "fixed Brown seed and accepted time/dt must replay the same thermal field");
    check_near(
        replay.thermal_brown.sigma,
        first.thermal_brown.sigma,
        0.0,
        "fixed Brown seed replay keeps the same sigma diagnostic");
}

void changed_accepted_dt_resamples_thermal_field() {
    auto ctx = make_thermal_context();

    fullmag::fem::refresh_thermal_brown_field(ctx);
    const auto first_refresh = ctx.thermal_brown.h_xyz;
    const double first_sigma = ctx.thermal_brown.sigma;

    ctx.adaptive_dt.current_dt *= 2.0;
    fullmag::fem::refresh_thermal_brown_field(ctx);

    check(
        ctx.thermal_brown.h_xyz != first_refresh,
        "changed accepted dt must resample the Brown thermal field");
    check(
        ctx.thermal_brown.sigma != first_sigma,
        "changed accepted dt must update the Brown sigma diagnostic");
    check_near(
        ctx.thermal_brown.last_refresh_dt,
        ctx.adaptive_dt.current_dt,
        0.0,
        "changed accepted dt cache key");
}

std::vector<double> collect_thermal_samples(double dt, int sample_count) {
    auto ctx = make_thermal_context();
    ctx.mesh.n_nodes = 1;
    ctx.mesh.node_volumes = {1.0e-27};
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.material_fields.alpha_field = {0.1};
    ctx.material_fields.Ms_field = {800e3};
    ctx.adaptive_dt.current_dt = dt;
    ctx.thermal_brown.seed = 987654321ull;
    fullmag::fem::initialize_thermal_brown_field(ctx);

    std::vector<double> samples;
    samples.reserve(static_cast<size_t>(sample_count) * 3u);
    for (int sample = 0; sample < sample_count; ++sample) {
        ctx.state.current_time = static_cast<double>(sample + 1) * dt;
        fullmag::fem::refresh_thermal_brown_field(ctx);
        samples.push_back(ctx.thermal_brown.h_xyz[0]);
        samples.push_back(ctx.thermal_brown.h_xyz[1]);
        samples.push_back(ctx.thermal_brown.h_xyz[2]);
    }
    return samples;
}

double sample_variance(const std::vector<double> &samples) {
    check(samples.size() > 1u, "thermal variance requires at least two samples");
    double mean = 0.0;
    for (double sample : samples) {
        mean += sample;
    }
    mean /= static_cast<double>(samples.size());

    double sum_squared_deviation = 0.0;
    for (double sample : samples) {
        const double deviation = sample - mean;
        sum_squared_deviation += deviation * deviation;
    }
    return sum_squared_deviation / static_cast<double>(samples.size() - 1u);
}

void check_relative(double actual, double expected, double tolerance, const char *msg) {
    const double relative_error = std::fabs(actual - expected) / std::fabs(expected);
    if (relative_error > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g (relative error %.6g > %.6g)\n",
            msg,
            expected,
            actual,
            relative_error,
            tolerance);
        std::exit(1);
    }
}

void sampled_variance_scales_with_accepted_dt() {
    const double dt_short = 1.0e-12;
    const double dt_long = 4.0e-12;
    const int sample_count = 4096;

    const double sigma_short = fullmag::fem::thermal_brown_sigma(
        300.0,
        0.1,
        2.211e5,
        800e3,
        1.0e-27,
        dt_short);
    const double sigma_long = fullmag::fem::thermal_brown_sigma(
        300.0,
        0.1,
        2.211e5,
        800e3,
        1.0e-27,
        dt_long);

    const double variance_short = sample_variance(collect_thermal_samples(dt_short, sample_count));
    const double variance_long = sample_variance(collect_thermal_samples(dt_long, sample_count));

    check_relative(variance_short, sigma_short * sigma_short, 0.08, "short-dt Brown variance");
    check_relative(variance_long, sigma_long * sigma_long, 0.08, "long-dt Brown variance");
    check_relative(
        variance_short / variance_long,
        dt_long / dt_short,
        0.10,
        "Brown variance inverse-dt scaling");
}

void disabled_or_invalid_state_clears_thermal_field() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.thermal_brown.temperature = 0.0;
    ctx.adaptive_dt.current_dt = 1.0e-12;
    ctx.thermal_brown.h_xyz = {1.0, 2.0, 3.0};

    fullmag::fem::refresh_thermal_brown_field(ctx);

    check_near(ctx.thermal_brown.sigma, 0.0, 0.0, "disabled thermal sigma");
    check_near(ctx.thermal_brown.h_xyz[0], 0.0, 0.0, "disabled thermal Hx");
    check_near(ctx.thermal_brown.h_xyz[1], 0.0, 0.0, "disabled thermal Hy");
    check_near(ctx.thermal_brown.h_xyz[2], 0.0, 0.0, "disabled thermal Hz");
}

void thermal_field_adds_to_effective_field() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.thermal_brown.temperature = 300.0;
    ctx.thermal_brown.h_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_thermal_brown_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "thermal Hx added");
    check_near(h_eff[1], 22.0, 0.0, "thermal Hy added");
    check_near(h_eff[2], 33.0, 0.0, "thermal Hz added");

    ctx.thermal_brown.temperature = 0.0;
    fullmag::fem::add_thermal_brown_field(ctx, h_eff);
    check_near(h_eff[0], 11.0, 0.0, "disabled thermal add skipped");
}

void thermal_plan_import_sets_temperature_seed_and_initializes_buffer() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    fullmag_fem_plan_desc plan{};
    plan.temperature = 300.0;
    plan.thermal_seed = 987654321ull;

    fullmag::fem::initialize_thermal_brown_plan_fields(ctx, plan);

    check_near(ctx.thermal_brown.temperature, 300.0, 0.0, "Brown temperature copied from plan");
    check(ctx.thermal_brown.seed == 987654321ull, "Brown thermal seed copied from plan");
    check(ctx.thermal_brown.h_xyz == std::vector<double>({0.0, 0.0, 0.0, 0.0, 0.0, 0.0}),
          "Brown plan import initializes thermal field buffer");
}

} // namespace

int main() {
    thermal_brown_responsibilities_are_owned_by_separate_modules();
    thermal_brown_source_files_document_module_boundaries();
    thermal_brown_gamma_convention_is_documented();
    thermal_brown_runtime_state_is_owned_by_sampler_module();
    sigma_formula_matches_brown_field_contract();
    refresh_uses_per_node_sigma_mask_and_cache();
    seeded_replay_is_deterministic_for_same_time_and_dt();
    changed_accepted_dt_resamples_thermal_field();
    sampled_variance_scales_with_accepted_dt();
    disabled_or_invalid_state_clears_thermal_field();
    thermal_field_adds_to_effective_field();
    thermal_plan_import_sets_temperature_seed_and_initializes_buffer();
    return 0;
}
