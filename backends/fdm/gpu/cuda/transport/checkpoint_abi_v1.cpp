#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>
#include <stdexcept>
#include <vector>

namespace {
constexpr std::array<uint32_t, 64> kSha256K = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};

uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

std::array<uint8_t, 32> sha256(const uint8_t *data, size_t size) {
    std::array<uint32_t, 8> h = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                                  0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    const uint64_t bits = static_cast<uint64_t>(size) * 8;
    const size_t padded = ((size + 9 + 63) / 64) * 64;
    std::vector<uint8_t> bytes(padded, 0);
    if (size != 0) std::memcpy(bytes.data(), data, size);
    bytes[size] = 0x80;
    for (size_t i = 0; i < 8; ++i) bytes[padded - 1 - i] = static_cast<uint8_t>(bits >> (8 * i));
    for (size_t block = 0; block < padded; block += 64) {
        uint32_t w[64]{};
        for (size_t i = 0; i < 16; ++i) {
            const size_t p = block + 4 * i;
            w[i] = (uint32_t(bytes[p]) << 24) | (uint32_t(bytes[p+1]) << 16) |
                   (uint32_t(bytes[p+2]) << 8) | uint32_t(bytes[p+3]);
        }
        for (size_t i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >> 3);
            const uint32_t s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],z=h[7];
        for (size_t i = 0; i < 64; ++i) {
            const uint32_t s1=rotr(e,6)^rotr(e,11)^rotr(e,25);
            const uint32_t ch=(e&f)^((~e)&g);
            const uint32_t t1=z+s1+ch+kSha256K[i]+w[i];
            const uint32_t s0=rotr(a,2)^rotr(a,13)^rotr(a,22);
            const uint32_t maj=(a&b)^(a&c)^(b&c);
            const uint32_t t2=s0+maj;
            z=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=z;
    }
    std::array<uint8_t, 32> out{};
    for (size_t i=0;i<8;++i) for(size_t j=0;j<4;++j) out[4*i+j]=uint8_t(h[i]>>(24-8*j));
    return out;
}

uint16_t u16(const uint8_t *p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }
uint32_t u32(const uint8_t *p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
    (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
uint64_t u64(const uint8_t *p) { uint64_t v=0; for(size_t i=0;i<8;++i) v|=uint64_t(p[i])<<(8*i); return v; }
uint64_t align64(uint64_t v) { return (v + 63) & ~UINT64_C(63); }
bool zero(const uint8_t *p, size_t n) { for(size_t i=0;i<n;++i) if(p[i]) return false; return true; }
bool equal(const std::array<uint8_t,32> &a, const uint8_t *b) { return std::memcmp(a.data(),b,32)==0; }
uint64_t align8(uint64_t v) { return (v + 7) & ~UINT64_C(7); }

struct SubrecordInfo {
    std::array<uint64_t, 27> counts{};
    std::array<const uint8_t *, 27> data{};
    std::array<uint64_t, 27> bytes{};
    size_t field_count = 0;
};

bool valid_utf8(const uint8_t *p, uint64_t length) {
    for (uint64_t i = 0; i < length;) {
        const uint8_t first = p[i++];
        if (first < 0x80) continue;
        uint32_t value = 0;
        uint32_t minimum = 0;
        size_t continuation = 0;
        if ((first & 0xe0) == 0xc0) {
            value = first & 0x1f; minimum = 0x80; continuation = 1;
        } else if ((first & 0xf0) == 0xe0) {
            value = first & 0x0f; minimum = 0x800; continuation = 2;
        } else if ((first & 0xf8) == 0xf0) {
            value = first & 0x07; minimum = 0x10000; continuation = 3;
        } else {
            return false;
        }
        if (continuation > length - i) return false;
        for (size_t j = 0; j < continuation; ++j) {
            const uint8_t next = p[i++];
            if ((next & 0xc0) != 0x80) return false;
            value = (value << 6) | (next & 0x3f);
        }
        if (value < minimum || value > 0x10ffff ||
            (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}

bool validate_utf8_list(const uint8_t *p, uint64_t length, uint64_t count) {
    uint64_t position = 0;
    for (uint64_t i = 0; i < count; ++i) {
        if (length - position < 4) return false;
        const uint32_t string_length = u32(p + position);
        position += 4;
        if (string_length > length - position ||
            std::memchr(p + position, 0, string_length) != nullptr ||
            !valid_utf8(p + position, string_length)) return false;
        position += string_length;
    }
    return position == length;
}

bool scalar(const SubrecordInfo &info, size_t field) {
    return info.counts[field - 1] == 1;
}

bool same_count(const SubrecordInfo &info, size_t first, size_t last) {
    for (size_t i = first; i < last; ++i) {
        if (info.counts[i] != info.counts[first - 1]) return false;
    }
    return true;
}

bool u8_values_at_most(const uint8_t *data, uint64_t count, uint8_t maximum) {
    for(uint64_t i=0;i<count;++i) if(data[i]>maximum) return false;
    return true;
}

bool u32_values_at_most(const uint8_t *data, uint64_t count, uint32_t maximum) {
    for(uint64_t i=0;i<count;++i) if(u32(data+4*i)>maximum) return false;
    return true;
}

bool i32_values_are_sides(const uint8_t *data, uint64_t count) {
    for(uint64_t i=0;i<count;++i) {
        const uint32_t value=u32(data+4*i);
        if(value!=1&&value!=UINT32_MAX) return false;
    }
    return true;
}

bool validate_subrecord(const uint8_t *section, uint64_t length,
                        uint32_t section_id, SubrecordInfo *info) {
    static constexpr uint16_t s1[] = {2,2,2,8,7,8,8,8,8,3,5,3,3,3,3,2,5,2,3,3};
    static constexpr uint16_t s6[] = {1,1,1,2,3};
    static constexpr uint16_t s7[] = {3,2,4,5,5,9};
    static constexpr uint16_t s8[] = {9,3,4,5,5,5,5};
    static constexpr uint16_t s9[] = {9,5,5,5};
    static constexpr uint16_t s10[] = {8,8,8,8,8,8,8,8,8,3,3,3,2,3,3,5,5,5,5,7};
    static constexpr uint16_t s15[] = {5,5,5,5,5,5,5,5,5};
    static constexpr uint16_t s16[] = {3,3,2,3,3,3,3,3,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5};
    static constexpr uint16_t s17[] = {5,5,5,5,5,5,5,5,5,5};
    static constexpr uint16_t s18[] = {8,3,3,3,5,5,1};
    static constexpr uint16_t s20[] = {3,3,3,3,3,3,7};
    const uint16_t *types=nullptr; size_t expected=0;
    switch(section_id) {
    case 1: types=s1; expected=20; break; case 6: types=s6; expected=5; break;
    case 7: types=s7; expected=6; break; case 8: types=s8; expected=7; break;
    case 9: types=s9; expected=4; break; case 10: types=s10; expected=20; break;
    case 15: types=s15; expected=9; break; case 16: types=s16; expected=27; break;
    case 17: types=s17; expected=10; break; case 18: case 19: types=s18; expected=7; break;
    case 20: types=s20; expected=7; break; default: return true;
    }
    if(length<16) return false;
    const uint32_t field_count=u32(section+4);
    if(u16(section)!=1 || u16(section+2)!=0 || field_count<expected ||
       u64(section+8)!=length || field_count>(length-16)/32) return false;
    uint64_t next=align8(16+32*field_count);
    uint16_t previous_field=0;
    for(size_t i=0;i<field_count;++i) {
        const uint8_t *f=section+16+32*i;
        const uint16_t field_id=u16(f), type=u16(f+2);
        const uint64_t count=u64(f+8), offset=u64(f+16), bytes=u64(f+24);
        const bool known=i<expected;
        if(field_id<=previous_field || (known && (field_id!=i+1 || type!=types[i] || u32(f+4)!=1)) ||
           (!known && u32(f+4)!=0) || type==0 || type>9 || offset!=next ||
           offset>length || bytes>length-offset)
            return false;
        previous_field=field_id;
        uint64_t width=0;
        if(type==1) width=1; else if(type==2||type==4) width=4; else if(type==3||type==5) width=8;
        else if(type==6) width=16; else if(type==7) width=32;
        if(width && (count>UINT64_MAX/width || count*width!=bytes)) return false;
        if(type==8 && (count!=1 || std::memchr(section+offset,0,size_t(bytes))!=nullptr ||
                       !valid_utf8(section+offset,bytes))) return false;
        if(type==9 && !validate_utf8_list(section+offset,bytes,count)) return false;
        if(known) { info->counts[i]=count; info->data[i]=section+offset; info->bytes[i]=bytes; }
        const uint64_t end=offset+bytes; next=align8(end);
        if(next>length || !zero(section+end,size_t(next-end))) return false;
    }
    if(next!=length) return false;
    info->field_count=field_count;
    switch(section_id) {
    case 1:
        if(info->counts[0]!=2 || !scalar(*info,2) || !scalar(*info,3) ||
           !scalar(*info,4) || !scalar(*info,5) || !scalar(*info,6) ||
           !scalar(*info,7) || !scalar(*info,8) || !scalar(*info,9) ||
           info->counts[9]!=3 || info->counts[10]!=3 ||
           !scalar(*info,12) || !scalar(*info,13) || !scalar(*info,14) ||
           !scalar(*info,15) || info->counts[15]!=info->counts[16] ||
           !scalar(*info,18) || !scalar(*info,19) || !scalar(*info,20) ||
           u32(info->data[17])>FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CANCELLED)
            return false;
        break;
    case 6:
        if(!same_count(*info,1,4) || !scalar(*info,5) ||
           !u8_values_at_most(info->data[0],info->counts[0],1) ||
           !u8_values_at_most(info->data[1],info->counts[1],1) ||
           !u8_values_at_most(info->data[2],info->counts[2],1)) return false;
        break;
    case 7:
        if(!same_count(*info,1,expected) ||
           !u32_values_at_most(info->data[1],info->counts[1],2) ||
           !i32_values_are_sides(info->data[2],info->counts[2])) return false;
        break;
    case 8:
        if(!same_count(*info,1,expected) ||
           !i32_values_are_sides(info->data[2],info->counts[2])) return false;
        break;
    case 9: case 15: case 17:
        if(!same_count(*info,1,expected)) return false;
        break;
    case 16:
        if(!same_count(*info,1,expected) ||
           !u32_values_at_most(info->data[2],info->counts[2],2) ||
           !i32_values_are_sides(info->data[8],info->counts[8])) return false;
        break;
    case 10:
        for(size_t field=1;field<=expected;++field) if(!scalar(*info,field)) return false;
        if(u32(info->data[12])>FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CANCELLED) return false;
        break;
    case 18: case 19:
        if(!scalar(*info,1) || !scalar(*info,2) || !scalar(*info,3) || !scalar(*info,4))
            return false;
        if(info->counts[4]!=0 && u64(info->data[3])>UINT64_MAX/info->counts[4]) return false;
        if(u64(info->data[3])*info->counts[4]!=info->counts[5]) return false;
        break;
    case 20:
        for(size_t field=1;field<=expected;++field) if(!scalar(*info,field)) return false;
        break;
    }
    return true;
}
}

extern "C" void fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
    const void *payload, uint64_t payload_size, uint8_t digest[32]) {
    if (digest == nullptr || (payload == nullptr && payload_size != 0) ||
        payload_size > static_cast<uint64_t>(SIZE_MAX)) {
        return;
    }
    const auto value = sha256(static_cast<const uint8_t *>(payload),
                              static_cast<size_t>(payload_size));
    std::memcpy(digest, value.data(), value.size());
}

uint32_t checkpoint_validate_impl(
    const void *payload, uint64_t payload_size, uint32_t *validation_kind) {
    if (payload == nullptr || validation_kind == nullptr ||
        payload_size > static_cast<uint64_t>(SIZE_MAX)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    *validation_kind = 0;
    const auto *p = static_cast<const uint8_t *>(payload);
    if (payload_size < 320 || std::memcmp(p,"FMGPUTR1",8)!=0 || u16(p+8)!=1 ||
        u16(p+10)!=0 || u32(p+12)!=320 || u32(p+16)!=0x01020304 ||
        u32(p+20)!=96 || u32(p+28)!=0 || u64(p+32)!=payload_size ||
        u64(p+40)!=320 || u64(p+56)!=0 ||
        (u64(p+64) & ~FULLMAG_FDM_GPU_TRANSPORT_KNOWN_GLOBAL_FEATURES_V1) != 0 ||
        u64(p+72)==UINT64_MAX || !zero(p+304,16)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    const uint32_t count=u32(p+24);
    if (count==0 || count > (payload_size-320)/96) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    const uint64_t table_bytes=uint64_t(count)*96;
    uint64_t next=align64(320+table_bytes);
    if (u64(p+48)!=next || next>payload_size || !zero(p+320+table_bytes,size_t(next-320-table_bytes)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    if (!equal(sha256(p+320,size_t(table_bytes)),p+208)) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    std::vector<uint8_t> ordered;
    uint32_t previous=0;
    std::array<bool,21> present{};
    std::array<SubrecordInfo,21> subrecords{};
    std::array<const uint8_t *,21> section_data{};
    std::array<uint64_t,21> section_lengths{};
    uint32_t known_count=0;
    for(uint32_t i=0;i<count;++i) {
        const uint8_t *d=p+320+96*i;
        const uint32_t id=u32(d), type=u32(d+8), width=u32(d+12);
        const uint64_t elements=u64(d+16), offset=u64(d+24), length=u64(d+32);
        const bool known=id>=1&&id<=20;
        const bool array_section=(id>=2&&id<=5)||(id>=11&&id<=14);
        if(id<=previous || u16(d+4)!=1 || (known ? u16(d+6)!=1 : u16(d+6)!=0) ||
           type==0 || type>6 ||
           (type<5 && width!=(UINT32_C(1)<<(type-1))) || (type==5 && width!=8) ||
           (type==6 && width!=1) || (known && (array_section ? type!=5 : type!=6)) ||
           (elements!=0 && width>UINT64_MAX/elements) ||
           elements*width!=length || u64(d+40)!=length || offset!=next ||
           length>payload_size-offset || !zero(d+80,16) ||
           !equal(sha256(p+offset,size_t(length)),d+48))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        if (known && type==6 && !validate_subrecord(p+offset,length,id,&subrecords[id]))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        if(known) {
            present[id]=true; section_data[id]=p+offset; section_lengths[id]=length;
            ++known_count;
        }
        previous=id;
        ordered.insert(ordered.end(),p+offset,p+offset+length);
        const uint64_t end=offset+length;
        next=align64(end);
        if(next>payload_size || !zero(p+end,size_t(next-end))) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    if(next!=payload_size || !equal(sha256(ordered.data(),ordered.size()),p+240))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    std::vector<uint8_t> zeroed(p,p+payload_size);
    std::memset(zeroed.data()+272,0,32);
    if(!equal(sha256(zeroed.data(),zeroed.size()),p+272)) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;

    const bool codec_only=known_count==2&&present[1]&&present[2];
    const bool charge_complete=present[1]&&present[2]&&present[3]&&present[4]&&present[5]&&
        present[6]&&present[7]&&present[8]&&present[9]&&present[18]&&present[20];
    bool any_spin=false, spin_complete=true;
    for(uint32_t id=10;id<=17;++id) { any_spin=any_spin||present[id]; spin_complete=spin_complete&&present[id]; }
    any_spin=any_spin||present[19]; spin_complete=spin_complete&&present[19];
    const uint32_t expected_count=charge_complete ? uint32_t(11+(spin_complete?9:0)) : 0;
    if((!codec_only && (!charge_complete || known_count!=expected_count)) ||
       (any_spin && !spin_complete))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    if (spin_complete && u64(p + 64) != UINT64_C(0x3f))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;

    const uint64_t nx=u64(subrecords[1].data[9]), ny=u64(subrecords[1].data[9]+8),
        nz=u64(subrecords[1].data[9]+16);
    if(nx==0||ny==0||nz==0||nx>UINT64_MAX/ny||nx*ny>UINT64_MAX/nz)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    const uint64_t cells=nx*ny*nz;
    const auto section_elements=[&](uint32_t id)->uint64_t {
        for(uint32_t i=0;i<count;++i) {
            const uint8_t *d=p+320+96*i;
            if(u32(d)==id) return u64(d+16);
        }
        return 0;
    };
    const auto face_count=[](uint64_t primary, uint64_t secondary,
                             uint64_t tertiary, uint64_t *result)->bool {
        if(primary==UINT64_MAX || primary+1>UINT64_MAX/secondary ||
           (primary+1)*secondary>UINT64_MAX/tertiary) return false;
        *result=(primary+1)*secondary*tertiary;
        return true;
    };
    uint64_t x_faces=0,y_faces=0,z_faces=0;
    if(!face_count(nx,ny,nz,&x_faces) || !face_count(ny,nx,nz,&y_faces) ||
       !face_count(nz,nx,ny,&z_faces))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    if(section_elements(2)!=cells ||
       (charge_complete && (section_elements(3)!=x_faces ||
        section_elements(4)!=y_faces || section_elements(5)!=z_faces ||
        subrecords[6].counts[0]!=cells)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;

    if (spin_complete) {
        const auto times_three = [](uint64_t value, uint64_t *out) {
            if (value > UINT64_MAX / 3) return false;
            *out = value * 3;
            return true;
        };
        uint64_t spin_cells = 0, spin_x_faces = 0, spin_y_faces = 0,
                 spin_z_faces = 0;
        if (!times_three(cells, &spin_cells) ||
            !times_three(x_faces, &spin_x_faces) ||
            !times_three(y_faces, &spin_y_faces) ||
            !times_three(z_faces, &spin_z_faces) ||
            section_elements(11) != spin_cells ||
            section_elements(12) != spin_x_faces ||
            section_elements(13) != spin_y_faces ||
            section_elements(14) != spin_z_faces ||
            subrecords[15].counts[0] != cells ||
            subrecords[17].counts[0] != cells) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        }
        const uint64_t interface_count = subrecords[16].counts[0];
        if (interface_count > x_faces + y_faces + z_faces) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        }
        for (uint64_t i = 0; i < interface_count; ++i) {
            const uint32_t axis = u32(subrecords[16].data[2] + 4 * i);
            const uint64_t face_linear = u64(subrecords[16].data[3] + 8 * i);
            const uint64_t face_limit = axis == 0 ? x_faces : axis == 1 ? y_faces : z_faces;
            if (face_linear >= face_limit ||
                u64(subrecords[16].data[4] + 8 * i) >= cells ||
                u64(subrecords[16].data[5] + 8 * i) >= cells ||
                u64(subrecords[16].data[6] + 8 * i) >= cells ||
                u64(subrecords[16].data[7] + 8 * i) >= cells) {
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
            }
        }
        if (u64(subrecords[10].data[9]) != u64(subrecords[1].data[12]) ||
            u64(subrecords[10].data[10]) == 0 ||
            u64(subrecords[10].data[11]) == 0 ||
            subrecords[19].bytes[0] != subrecords[10].bytes[5] ||
            std::memcmp(subrecords[19].data[0], subrecords[10].data[5],
                        size_t(subrecords[10].bytes[5])) != 0 ||
            u64(subrecords[19].data[1]) != u64(subrecords[10].data[11]) ||
            u64(subrecords[20].data[4]) != u64(subrecords[1].data[19]) ||
            u64(subrecords[20].data[5]) != u64(subrecords[10].data[14])) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        }
    }

    if(charge_complete) {
        std::vector<uint8_t> snapshot_bytes;
        const uint32_t snapshot_last = spin_complete ? 17 : 9;
        for(uint32_t id=1;id<=snapshot_last;++id)
            snapshot_bytes.insert(snapshot_bytes.end(),section_data[id],section_data[id]+section_lengths[id]);
        bool content_derived_domain=true;
        for(size_t i=0;i<32;++i)
            content_derived_domain=content_derived_domain&&subrecords[1].data[4][i]==0x45;
        bool legacy_domain=true;
        for(size_t i=0;i<32;++i)
            legacy_domain=legacy_domain&&subrecords[1].data[4][i]==0x44;
        if(!content_derived_domain&&!legacy_domain)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
        std::array<uint8_t,32> expected_snapshot{};
        if(!content_derived_domain) {
            expected_snapshot=sha256(snapshot_bytes.data(),snapshot_bytes.size());
        }
        {
            std::vector<uint8_t> canonical;
            const auto append=[&](const void *source,size_t bytes){
                const auto *begin=static_cast<const uint8_t *>(source);
                canonical.insert(canonical.end(),begin,begin+bytes);
            };
            const auto segment=[&](uint32_t tag,const void *source,uint64_t bytes){
                append(&tag,sizeof(tag));append(&bytes,sizeof(bytes));append(source,size_t(bytes));
            };
            segment(1,p+144,32); segment(2,p+80,16); segment(3,p+72,8);
            segment(4,subrecords[1].data[9],24); segment(5,subrecords[1].data[10],24);
            segment(6,subrecords[1].data[11],8); segment(7,subrecords[1].data[12],8);
            segment(8,subrecords[6].data[0],subrecords[6].bytes[0]);
            segment(9,section_data[2],section_lengths[2]);
            segment(10,section_data[3],section_lengths[3]);
            segment(11,section_data[4],section_lengths[4]);
            segment(12,section_data[5],section_lengths[5]);
            const uint64_t exact_count=subrecords[7].counts[0];
            segment(13,&exact_count,sizeof(exact_count));
            uint64_t source_offset=0;
            for(uint64_t i=0;i<exact_count;++i){
                append(subrecords[7].data[0]+8*i,8); append(subrecords[7].data[1]+4*i,4);
                append(subrecords[7].data[2]+4*i,4); append(subrecords[7].data[3]+8*i,8);
                append(subrecords[7].data[4]+8*i,8);
                const uint32_t source_length=u32(subrecords[7].data[5]+source_offset);
                const uint8_t *source=subrecords[7].data[5]+source_offset+4;
                uint64_t source_id=0;
                if(source_length==0) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                for(uint32_t digit=0;digit<source_length;++digit){
                    if(source[digit]<'0'||source[digit]>'9'||
                       source_id>(UINT64_MAX-uint64_t(source[digit]-'0'))/10)
                        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                    source_id=source_id*10+uint64_t(source[digit]-'0');
                }
                append(&source_id,sizeof(source_id));
                source_offset+=4+source_length;
            }
            const uint64_t interface_count=subrecords[8].counts[0];
            segment(14,&interface_count,sizeof(interface_count));
            std::vector<double> interface_from_trace,interface_to_trace,
                interface_delta_trace,interface_current_density;
            std::vector<std::array<uint64_t,2>> interface_identities;
            interface_from_trace.reserve(interface_count); interface_to_trace.reserve(interface_count);
            interface_delta_trace.reserve(interface_count); interface_current_density.reserve(interface_count);
            uint64_t identity_offset=0;
            for(uint64_t i=0;i<interface_count;++i){
                if(identity_offset+4>subrecords[8].bytes[0])
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                const uint32_t identity_length=u32(subrecords[8].data[0]+identity_offset);
                if(identity_offset+4+identity_length>subrecords[8].bytes[0])
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                const uint8_t *identity=subrecords[8].data[0]+identity_offset+4;
                std::array<uint64_t,8> values{};
                int32_t orientation=0;
                size_t cursor=0;
                const auto literal=[&](const char *value)->bool {
                    for(size_t j=0;value[j]!='\0';++j)
                        if(cursor>=identity_length||identity[cursor++]!=uint8_t(value[j])) return false;
                    return true;
                };
                const auto decimal=[&](uint64_t *value)->bool {
                    if(cursor>=identity_length||identity[cursor]<'0'||identity[cursor]>'9') return false;
                    uint64_t parsed=0;
                    while(cursor<identity_length&&identity[cursor]>='0'&&identity[cursor]<='9') {
                        const uint64_t digit=uint64_t(identity[cursor++]-'0');
                        if(parsed>(UINT64_MAX-digit)/10) return false;
                        parsed=parsed*10+digit;
                    }
                    *value=parsed; return true;
                };
                if(!literal("v2:")) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                for(size_t field=0;field<8;++field) {
                    if(!decimal(&values[field])||cursor>=identity_length||identity[cursor++]!=':')
                        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                }
                bool negative=false;
                if(cursor<identity_length&&identity[cursor]=='-') { negative=true; ++cursor; }
                uint64_t orientation_magnitude=0;
                if(!decimal(&orientation_magnitude)||cursor!=identity_length||orientation_magnitude!=1)
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                orientation=negative?-1:1;
                const uint64_t source_id=values[0], topology_id=values[1], axis=values[2];
                const uint64_t face=values[3], negative_cell=values[4], positive_cell=values[5];
                const uint64_t from_cell=values[6], to_cell=values[7];
                const uint64_t face_limit=axis==0?x_faces:axis==1?y_faces:z_faces;
                const uint64_t nxny=nx*ny;
                const uint64_t negative_x=negative_cell%nx;
                const uint64_t negative_y=(negative_cell/nx)%ny;
                const uint64_t negative_z=negative_cell/nxny;
                const uint64_t expected_positive=axis==0?negative_cell+1:
                    axis==1?negative_cell+nx:negative_cell+nxny;
                const bool negative_has_neighbor=axis==0?negative_x+1<nx:
                    axis==1?negative_y+1<ny:negative_z+1<nz;
                const uint64_t expected_face=axis==0?
                    negative_x+1+(nx+1)*(negative_y+ny*negative_z):axis==1?
                    negative_x+nx*(negative_y+1+(ny+1)*negative_z):
                    negative_x+nx*(negative_y+ny*(negative_z+1));
                const int32_t expected_orientation=from_cell==negative_cell?1:-1;
                bool duplicate_identity=false;
                for(const auto &prior:interface_identities)
                    duplicate_identity=duplicate_identity||
                        (prior[0]==source_id&&prior[1]==topology_id);
                if(source_id==0||topology_id==0||axis>2||face>=face_limit||
                   face!=u64(subrecords[8].data[1]+8*i)||
                   uint32_t(orientation)!=u32(subrecords[8].data[2]+4*i)||
                   negative_cell>=cells||positive_cell>=cells||from_cell>=cells||to_cell>=cells||
                   !negative_has_neighbor||positive_cell!=expected_positive||face!=expected_face||
                   !((from_cell==negative_cell&&to_cell==positive_cell)||
                     (from_cell==positive_cell&&to_cell==negative_cell))||
                   orientation!=expected_orientation||duplicate_identity)
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                double vn=0.0,vf=0.0,jn=0.0,jf=0.0;
                std::memcpy(&vn,subrecords[8].data[3]+8*i,8);
                std::memcpy(&vf,subrecords[8].data[4]+8*i,8);
                std::memcpy(&jn,subrecords[8].data[5]+8*i,8);
                std::memcpy(&jf,subrecords[8].data[6]+8*i,8);
                if(!std::isfinite(vn)||!std::isfinite(vf)||!std::isfinite(jn)||
                   !std::isfinite(jf)||jn!=jf)
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
                interface_identities.push_back({source_id,topology_id});
                const bool from_is_negative=from_cell==negative_cell;
                const double from_trace=from_is_negative?vn:vf;
                const double to_trace=from_is_negative?vf:vn;
                const double delta_trace=from_trace-to_trace;
                const double current_density=double(orientation)*jn;
                interface_from_trace.push_back(from_trace);
                interface_to_trace.push_back(to_trace);
                interface_delta_trace.push_back(delta_trace);
                interface_current_density.push_back(current_density);
                identity_offset+=4+identity_length;
            }
            if(identity_offset!=subrecords[8].bytes[0])
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
            segment(15,interface_from_trace.data(),interface_count*sizeof(double));
            segment(16,interface_to_trace.data(),interface_count*sizeof(double));
            segment(17,interface_delta_trace.data(),interface_count*sizeof(double));
            segment(18,interface_current_density.data(),interface_count*sizeof(double));
            if(content_derived_domain)
                expected_snapshot=sha256(canonical.data(),canonical.size());
        }
        if(!equal(expected_snapshot,p+176) || u64(subrecords[20].data[0])!=u64(p+72))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;

        std::vector<uint8_t> continuation;
        continuation.insert(continuation.end(),p+176,p+208);
        continuation.insert(continuation.end(),section_data[18],section_data[18]+section_lengths[18]);
        if (spin_complete) {
            continuation.insert(continuation.end(),section_data[19],
                                section_data[19]+section_lengths[19]);
        }
        std::vector<uint8_t> continuation_meta(section_data[20],section_data[20]+section_lengths[20]);
        const size_t digest_offset=size_t(subrecords[20].data[6]-section_data[20]);
        std::memset(continuation_meta.data()+digest_offset,0,32);
        continuation.insert(continuation.end(),continuation_meta.begin(),continuation_meta.end());
        if(!equal(sha256(continuation.data(),continuation.size()),subrecords[20].data[6]))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    const bool restore = charge_complete;
    *validation_kind = restore
        ? (spin_complete ? FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN
                         : FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE)
        : FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_validate_v1(
    const void *payload, uint64_t payload_size, uint32_t *validation_kind) {
    try {
        return checkpoint_validate_impl(payload, payload_size, validation_kind);
    } catch (const std::bad_alloc &) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    } catch (const std::length_error &) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    } catch (...) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
}
