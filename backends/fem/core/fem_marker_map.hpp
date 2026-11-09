#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace fullmag::fem {

inline constexpr uint32_t kFemCompactMarkerMapRevision = 1u;

// Canonical labels are not MFEM array indices. Own one map per imported mesh.
class CompactMarkerMap {
public:
    template <typename Iterator, typename MarkerOf>
    bool assign(Iterator first, Iterator last, MarkerOf marker_of, std::string &error)
    {
        error.clear();
        CompactMarkerMap candidate;
        for (auto it = first; it != last; ++it) {
            candidate.forward_.emplace(marker_of(*it), 0);
        }
        if (candidate.forward_.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            error = "distinct canonical marker count exceeds positive MFEM attribute range";
            return false;
        }
        candidate.reverse_.reserve(candidate.forward_.size());
        for (const auto &entry : candidate.forward_) {
            candidate.reverse_.push_back(entry.first);
        }
        std::sort(candidate.reverse_.begin(), candidate.reverse_.end());
        if (!candidate.reverse_.empty() && candidate.reverse_.front() == 0u) {
            std::rotate(candidate.reverse_.begin(), candidate.reverse_.begin() + 1,
                        candidate.reverse_.end());
        }
        for (size_t index = 0; index < candidate.reverse_.size(); ++index) {
            candidate.forward_.at(candidate.reverse_[index]) = static_cast<int>(index + 1u);
        }
        *this = std::move(candidate);
        return true;
    }

    bool assign(const std::vector<uint32_t> &markers, std::string &error)
    {
        return assign(markers.begin(), markers.end(), [](uint32_t marker) { return marker; }, error);
    }

    // Zero is exclusively the absent-attribute sentinel; canonical zero is valid.
    int attribute(uint32_t marker) const
    {
        const auto found = forward_.find(marker);
        return found == forward_.end() ? 0 : found->second;
    }

    bool canonical(int attribute, uint32_t &marker) const
    {
        if (attribute <= 0 || static_cast<size_t>(attribute) > reverse_.size()) {
            return false;
        }
        marker = reverse_[static_cast<size_t>(attribute) - 1u];
        return true;
    }

    size_t size() const { return reverse_.size(); }

private:
    std::unordered_map<uint32_t, int> forward_;
    std::vector<uint32_t> reverse_;
};

struct FemMarkerMaps {
    CompactMarkerMap domain;
    CompactMarkerMap boundary;
};

} // namespace fullmag::fem
