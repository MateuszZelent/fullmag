#include "frequency_domain/canonical_digest.hpp"

#include <array>
#include <cstring>

namespace fullmag::fem::frequency_domain {
namespace {
void append_u64(std::string *out, std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) out->push_back(static_cast<char>(value >> shift));
}
std::uint64_t normalized_bits(double value) {
    if (value == 0.0) return 0;
    if (value != value) return UINT64_C(0x7ff8000000000000);
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}
constexpr std::array<std::uint32_t, 64> k = {0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
constexpr std::uint32_t rotr(std::uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
std::string sha256(const std::string &input) {
    std::string message = input; const std::uint64_t bits = static_cast<std::uint64_t>(message.size()) * 8;
    message.push_back(static_cast<char>(0x80)); while ((message.size() % 64) != 56) message.push_back(0); append_u64(&message, bits);
    std::array<std::uint32_t,8> h = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    for (std::size_t offset=0; offset<message.size(); offset+=64) { std::array<std::uint32_t,64> w{}; for(int i=0;i<16;++i) { const auto *p=reinterpret_cast<const unsigned char*>(message.data()+offset+4*i); w[i]=(std::uint32_t(p[0])<<24)|(std::uint32_t(p[1])<<16)|(std::uint32_t(p[2])<<8)|p[3]; } for(int i=16;i<64;++i) { const auto s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>3); const auto s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>10); w[i]=w[i-16]+s0+w[i-7]+s1; } auto a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],q=h[7]; for(int i=0;i<64;++i) { const auto s1=rotr(e,6)^rotr(e,11)^rotr(e,25); const auto ch=(e&f)^((~e)&g); const auto t1=q+s1+ch+k[i]+w[i]; const auto s0=rotr(a,2)^rotr(a,13)^rotr(a,22); const auto maj=(a&b)^(a&c)^(b&c); const auto t2=s0+maj; q=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; } h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=q; }
    static constexpr char hex[]="0123456789abcdef"; std::string result; result.reserve(64); for(const auto word:h) for(int shift=28;shift>=0;shift-=4) result.push_back(hex[(word>>shift)&15]); return result;
}
} // namespace
CanonicalDigestBuilder::CanonicalDigestBuilder(std::string_view schema) { add_string("schema", schema); }
void CanonicalDigestBuilder::add_field(std::string_view name, std::uint8_t type, const std::uint8_t *value, std::uint64_t size) { append_u64(&payload_, name.size()); payload_.append(name); payload_.push_back(static_cast<char>(type)); append_u64(&payload_, size); if(size != 0) payload_.append(reinterpret_cast<const char*>(value), size); }
void CanonicalDigestBuilder::add_string(std::string_view name, std::string_view value) { add_field(name, 1, reinterpret_cast<const std::uint8_t*>(value.data()), value.size()); }
void CanonicalDigestBuilder::add_u64(std::string_view name, std::uint64_t value) { std::array<std::uint8_t,8> bytes{}; for(int i=0;i<8;++i) bytes[i]=static_cast<std::uint8_t>(value>>(56-8*i)); add_field(name,2,bytes.data(),bytes.size()); }
void CanonicalDigestBuilder::add_double(std::string_view name, double value) { std::array<std::uint8_t,8> bytes{}; const std::uint64_t bits=normalized_bits(value); for(int i=0;i<8;++i) bytes[i]=static_cast<std::uint8_t>(bits>>(56-8*i)); add_field(name,4,bytes.data(),bytes.size()); }
void CanonicalDigestBuilder::add_bytes(std::string_view name, const std::uint8_t *value, std::uint64_t size) { add_field(name,3,value,size); }
std::string CanonicalDigestBuilder::sha256_hex() const { return sha256(payload_); }
} // namespace fullmag::fem::frequency_domain
