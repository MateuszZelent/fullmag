// Private CI harness for the existing surface operator; no production changes.
#include "native_surface_inputs.hpp"
#include <boost/multiprecision/cpp_int.hpp>
#include <cmath>
#include <vector>
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


namespace {
using Affine = fullmag::fem::transport::AffineRt0Element;
using Exact = boost::multiprecision::cpp_rational;
using ExactPoint = std::array<Exact,3>;
void require(bool ok, const char *message)
{
    if (!ok) throw std::runtime_error(message);
}
Exact signed_determinant(const Affine::FrozenInput &input)
{
    std::array<ExactPoint,3> e;
    for (int i=0;i<3;++i) for (int c=0;c<3;++c)
        e[i][c]=Exact(input.vertices_m[i+1][c])-Exact(input.vertices_m[0][c]);
    return e[0][0]*(e[1][1]*e[2][2]-e[1][2]*e[2][1])+
        e[0][1]*(e[1][2]*e[2][0]-e[1][0]*e[2][2])+
        e[0][2]*(e[1][0]*e[2][1]-e[1][1]*e[2][0]);
}
std::string exact_text(const Exact &value)
{
    std::ostringstream out; out.imbue(std::locale::classic()); out << value; return out.str();
}
template<std::size_t N>
void binary(std::ostream &out,const std::array<double,N> &value)
{
    out << '[';
    for (std::size_t i=0;i<N;++i) {
        if(i) out << ',';
        std::ostringstream text; text.imbue(std::locale::classic());
        text << std::hexfloat << value[i]; quoted(out,text.str());
    }
    out << ']';
}

std::array<std::vector<Affine::FrozenInput>,3> prepare_sources()
{
    std::array<std::vector<Affine::FrozenInput>,3> prepared;
    for(std::size_t k=0;k<3;++k) {
        const auto &c=native_surface_inputs::cases[k];
        prepared[k].assign(c.sources.begin(),c.sources.end());
        Exact volume=0;
        std::cout << "NATIVE_INVARIANT_INPUT={\"case_index\":" << k;
        field(std::cout,"case_id",c.id);
        field(std::cout,"source_authentication","synthetic caller binding; NOT accepted-source authentication");
        field(std::cout,"synthetic_caller_digest_hex",c.digest_hex);
        std::cout << ",\"inspection_only\":true,\"qualification\":\"NOT VERIFIED\",\"error_certificate_available\":false,\"source_count\":6,\"target_count\":1,\"permutation\":";
        array(std::cout,c.permutation);
        std::cout << ",\"sources\":[";
        for(std::size_t e=0;e<6;++e) {
            const auto &input=prepared[k][e];
            if(e) std::cout << ',';
            const Exact signed_det=signed_determinant(input);
            Exact det=signed_det; if(det<0) det=-det;
            require(det!=0,"degenerate synthetic Tet4");
            require(det==Exact(c.scale)*Exact(c.scale)*Exact(c.scale),"unexpected determinant magnitude");
            volume+=det/6;
            Exact b=0; ExactPoint a{{0,0,0}};
            for(int i=0;i<4;++i) {
                require(std::isfinite(input.signed_coefficients_a[i]),"nonfinite coefficient");
                b+=Exact(input.signed_coefficients_a[i]);
                for(int axis=0;axis<3;++axis) {
                    require(std::isfinite(input.vertices_m[i][axis]),"nonfinite vertex");
                    a[axis]-=Exact(input.signed_coefficients_a[i])*Exact(input.vertices_m[i][axis]);
                }
            }
            b/=det; for(auto &v:a) v/=det;
            require(b==Exact(c.b) && b!=0,"affine slope mismatch");
            for(int axis=0;axis<3;++axis) require(a[axis]==Exact(c.a[axis]),"affine intercept mismatch");
            std::cout << "{\"element\":" << e << ",\"vertices_m\":[";
            for(int i=0;i<4;++i) {if(i) std::cout << ',';array(std::cout,input.vertices_m[i]);}
            std::cout << "],\"vertices_m_hex\":[";
            for(int i=0;i<4;++i) {if(i) std::cout << ',';binary(std::cout,input.vertices_m[i]);}
            std::cout << "],\"signed_coefficients_a\":";array(std::cout,input.signed_coefficients_a);
            std::cout << ",\"signed_coefficients_a_hex\":";binary(std::cout,input.signed_coefficients_a);
            field(std::cout,"signed_determinant_m3_exact",exact_text(signed_det));
            field(std::cout,"volume_m3_exact",exact_text(det/6));
            std::cout << ",\"affine_a_apm2_exact\":[";
            for(int axis=0;axis<3;++axis) {if(axis) std::cout << ',';quoted(std::cout,exact_text(a[axis]));}
            std::cout << ']';field(std::cout,"affine_b_apm3_exact",exact_text(b));std::cout << '}';
        }
        require(volume==Exact(c.scale)*Exact(c.scale)*Exact(c.scale),"whole scaled cube volume mismatch");
        for(double v:c.target) require(std::isfinite(v),"nonfinite target");
        std::cout << "],\"target_m\":";array(std::cout,c.target);
        std::cout << ",\"target_m_hex\":";binary(std::cout,c.target);
        field(std::cout,"volume_m3_exact",exact_text(volume));
        std::cout << '}' << std::endl;
    }
    return prepared;
}
} // namespace

int main()
{
    std::cout.imbue(std::locale::classic());
    std::cout << std::boolalpha << std::setprecision(std::numeric_limits<double>::max_digits10);
    std::array<std::vector<Affine::FrozenInput>,3> sources;
    try { sources=prepare_sources(); }
    catch(const std::exception &error) {
        std::cout << "NATIVE_INVARIANT_SETUP_REFUSED={\"reason\":";quoted(std::cout,error.what());
        std::cout << '}' << std::endl; return 1;
    }
    SurfaceRt0WorkCounts accumulated{};
    const auto campaign_started=Clock::now();
    std::size_t attempted=0,returned=0;
    bool ok=true;
    for(std::size_t k=0;k<3 && ok;++k) {
        SurfaceRt0WorkReport report{}; SurfaceRt0PhaseReport phases{}; SurfaceRt0Result result{};
        const auto &c=native_surface_inputs::cases[k];
        const auto started=Clock::now();
        std::string refusal;
        const auto guarded_peak=[&]() {
            require(std::chrono::duration<double>(Clock::now()-campaign_started).count()<=native_surface_inputs::limits.maximum_total_seconds,"campaign wall budget");
            for(std::size_t i=0;i<accumulated.size();++i)
                require(accumulated[i]<=native_surface_inputs::limits.total[i] && report.total[i]<=native_surface_inputs::limits.total[i]-accumulated[i],"campaign work budget");
            const auto rss=peak_rss();
            require(rss<=native_surface_inputs::limits.maximum_lifetime_peak_rss_bytes,"campaign RSS budget");
            return rss;
        };
        try {
            guarded_peak();
            ++attempted;
            result=evaluate_surface_rt0(sources[k],c.digest,{c.target},native_surface_inputs::limits,
                native_surface_inputs::tolerances,guarded_peak,report,&phases);
            ++returned;
            require(result.targets.size()==1,"missing target");
            require(result.caller_source_digest==c.digest,"caller digest echo mismatch");
            guarded_peak();
            require(std::chrono::duration<double>(Clock::now()-started).count()<=native_surface_inputs::limits.maximum_target_seconds,"call target wall budget");
        } catch(const std::exception &error) { refusal=error.what(); ok=false; }
        std::cout << "NATIVE_INVARIANT_CALL={\"case_index\":" << k << ",\"attempted_calls\":" << attempted;
        field(std::cout,"case_id",c.id);field(std::cout,"operator_version",surface_rt0_operator_version);
        field(std::cout,"synthetic_caller_digest_hex",c.digest_hex);
        field(std::cout,"status",refusal.empty()?"RETURNED":"REFUSED");field(std::cout,"refusal_reason",refusal);
        std::cout << ",\"external_elapsed_seconds\":" << std::chrono::duration<double>(Clock::now()-started).count()
            << ",\"lifetime_peak_rss_bytes\":" << peak_rss() << ",\"work_report\":";work(std::cout,report);
        std::cout << ",\"phase_report\":";phase(std::cout,phases);std::cout << ",\"targets\":[";
        for(std::size_t i=0;i<result.targets.size();++i) {if(i) std::cout << ',';target(std::cout,result.targets[i]);}
        std::cout << "]}" << std::endl;
        for(std::size_t i=0;i<accumulated.size();++i) accumulated[i]+=report.total[i];
    }
    std::cout << "NATIVE_INVARIANT_CAMPAIGN={\"attempted_calls\":" << attempted << ",\"returned_calls\":" << returned
        << ",\"complete\":" << (ok && attempted==3 && returned==3) << ",\"total_work\":";array(std::cout,accumulated);
    std::cout << ",\"external_elapsed_seconds\":" << std::chrono::duration<double>(Clock::now()-campaign_started).count()
        << ",\"lifetime_peak_rss_bytes\":" << peak_rss() << '}' << std::endl;
    return ok && attempted==3 && returned==3 ? 0:1;
}
