// Private CI harness for the existing surface operator; no production changes.
#include "native_surface_inputs.hpp"
#include <chrono>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>

using namespace fullmag::fem::oersted;
namespace {
using Clock = std::chrono::steady_clock;

std::uint64_t peak_rss()
{
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0 || usage.ru_maxrss <= 0 ||
        static_cast<std::uint64_t>(usage.ru_maxrss) > std::numeric_limits<std::uint64_t>::max()/1024)
        throw std::runtime_error("real lifetime peak RSS unavailable");
    return static_cast<std::uint64_t>(usage.ru_maxrss)*1024;
}
void quoted(std::ostream &out, const std::string &value)
{
    static constexpr char hex[] = "0123456789abcdef";
    out << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 0x20) out << "\\u00" << hex[c >> 4] << hex[c & 15];
        else out << c;
    }
    out << '"';
}
template<class T, std::size_t N>
void array(std::ostream &out, const std::array<T,N> &value)
{
    out << '[';
    for (std::size_t i=0; i<N; ++i) { if (i) out << ','; out << value[i]; }
    out << ']';
}
void strings(std::ostream &out, const std::array<std::string,3> &value)
{
    out << '[';
    for (std::size_t i=0; i<3; ++i) { if (i) out << ','; quoted(out,value[i]); }
    out << ']';
}
void field(std::ostream &out, const char *name, const std::string &value)
{
    out << ','; quoted(out,name); out << ':'; quoted(out,value);
}
void work(std::ostream &out, const SurfaceRt0WorkReport &r)
{
    out << "{\"total\":"; array(out,r.total);
    out << ",\"current_target\":"; array(out,r.current_target);
    out << ",\"by_precision\":[";
    for (std::size_t i=0; i<3; ++i) { if(i) out << ','; array(out,r.by_precision[i]); }
    out << ']';
#define REPORT(x) out << ",\"" #x "\":" << r.x
    REPORT(current_target_index); REPORT(maximum_raw_integer_bits);
    REPORT(maximum_reduced_fraction_bits); REPORT(last_sampled_lifetime_peak_rss_bytes);
    REPORT(elapsed_seconds);
#undef REPORT
    out << '}';
}
void phase(std::ostream &out, const SurfaceRt0PhaseReport &r)
{
    out << "{\"wall_time_ns\":"; array(out,r.wall_time_ns);
    out << ",\"total_wall_time_ns\":" << r.total_wall_time_ns
        << ",\"started\":" << r.started << ",\"accounting_issue\":" << r.accounting_issue << '}';
}
void target(std::ostream &out, const SurfaceRt0TargetResult &r)
{
    out << "{\"h_xyz_apm\":"; array(out,r.h_xyz_apm);
    std::array<std::string,3> bits;
    for(std::size_t i=0; i<3; ++i) {
        std::ostringstream text; text.imbue(std::locale::classic());
        text << std::hexfloat << r.h_xyz_apm[i]; bits[i]=text.str();
    }
    out << ",\"h_xyz_apm_hex\":"; strings(out,bits);
    out << ",\"precisions\":[";
    for(std::size_t i=0; i<3; ++i) {
        if(i) out << ','; const auto &p=r.precisions[i];
        out << "{\"evaluated\":" << p.evaluated;
        field(out,"refusal_reason",p.refusal_reason);
        out << ",\"h_xyz_apm\":"; strings(out,p.h_xyz_apm);
        out << ",\"whole_h_xyz_apm\":"; strings(out,p.whole_h_xyz_apm);
        field(out,"sum_local_norm_apm",p.sum_local_norm_apm);
        field(out,"cancellation",p.cancellation);
        field(out,"maximum_face_cancellation",p.maximum_face_cancellation);
        out << '}';
    }
    out << "],\"work\":"; array(out,r.work);
    out << ",\"binary64_requires_highprecision\":" << r.binary64_requires_highprecision;
    field(out,"precision_budget_apm",r.precision_budget_apm);
    field(out,"local_precision_delta_apm",r.local_precision_delta_apm);
    field(out,"local_formula_delta_apm",r.local_formula_delta_apm);
    field(out,"local_formula_delta_80_apm",r.local_formula_delta_80_apm);
    field(out,"binary64_roundoff_indicator_apm",r.binary64_roundoff_indicator_apm);
    out << '}';
}
} // namespace

int main()
{
    std::cout.imbue(std::locale::classic());
    std::cout << std::boolalpha << std::setprecision(std::numeric_limits<double>::max_digits10);
    const auto campaign_started=Clock::now();
    SurfaceRt0WorkCounts total{};
    std::array<SurfaceRt0WorkCounts,3> by_precision{};
    std::array<std::uint64_t,surface_rt0_phase_count> phase_totals{};
    std::uint64_t phase_ns=0;
    std::size_t attempted=0, returned=0;
    double call_seconds=0;
    for (const auto &input : native_surface_inputs::cases) {
        SurfaceRt0WorkReport report{};
        SurfaceRt0PhaseReport phases{};
        SurfaceRt0Result result{};
        std::string refusal;
        const auto started=Clock::now();
        ++attempted;
        try {
            result=evaluate_surface_rt0({input.source},input.digest,{input.target},
                native_surface_inputs::limits,native_surface_inputs::tolerances,peak_rss,report,&phases);
            ++returned;
        } catch (const std::exception &error) {
            refusal=error.what();
        }
        const double elapsed=std::chrono::duration<double>(Clock::now()-started).count();
        call_seconds+=elapsed;
        for(std::size_t i=0; i<total.size(); ++i) {
            total[i]+=report.total[i];
            for(std::size_t p=0; p<3; ++p) by_precision[p][i]+=report.by_precision[p][i];
        }
        for(std::size_t i=0; i<phase_totals.size(); ++i) phase_totals[i]+=phases.wall_time_ns[i];
        phase_ns+=phases.total_wall_time_ns;
        std::cout << "NATIVE_SURFACE_CALL={\"id\":"; quoted(std::cout,input.id);
        field(std::cout,"operator_version",surface_rt0_operator_version);
        field(std::cout,"status",refusal.empty() ? "RETURNED" : "REFUSED");
        field(std::cout,"refusal_reason",refusal);
        std::cout << ",\"external_elapsed_seconds\":" << elapsed
            << ",\"lifetime_peak_rss_bytes\":" << peak_rss() << ",\"work_report\":";
        work(std::cout,report);
        std::cout << ",\"phase_report\":"; phase(std::cout,phases);
        std::cout << ",\"targets\":[";
        for(std::size_t i=0; i<result.targets.size(); ++i) {
            if(i) std::cout << ','; target(std::cout,result.targets[i]);
        }
        std::cout << "]}" << std::endl;
    }
    std::cout << "NATIVE_SURFACE_CAMPAIGN={\"attempted_calls\":" << attempted
        << ",\"returned_calls\":" << returned
        << ",\"sum_call_seconds\":" << call_seconds
        << ",\"elapsed_seconds\":" << std::chrono::duration<double>(Clock::now()-campaign_started).count()
        << ",\"lifetime_peak_rss_bytes\":" << peak_rss() << ",\"total_work\":";
    array(std::cout,total);
    std::cout << ",\"by_precision\":[";
    for(std::size_t i=0; i<3; ++i) { if(i) std::cout << ','; array(std::cout,by_precision[i]); }
    std::cout << "],\"phase_wall_time_ns\":"; array(std::cout,phase_totals);
    std::cout << ",\"sum_phase_total_wall_time_ns\":" << phase_ns
        << ",\"budget_scope\":\"four independent unmodified kernel invocations; summed diagnostics only\"}"
        << std::endl;
    return attempted==4 && returned==4 ? 0 : 1;
}
