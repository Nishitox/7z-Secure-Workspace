#include <bit7z/bit7zlibrary.hpp>
#include <bit7z/bitarchivereader.hpp>
#include <bit7z/bitarchiveeditor.hpp>
#include <bit7z/bitarchivewriter.hpp>
#include <bit7z/bitpropvariant.hpp>
#include <bit7z/bitfileextractor.hpp>
#include <bit7z/bitformat.hpp>
#include <bit7z/bittypes.hpp>
#include <bit7z/bitexception.hpp>

#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kProtocolVersion = 1;

enum class Op : std::uint32_t {
    List   = 1,
    Read   = 2,
    Write  = 3,
    Delete = 4,
    Rename = 5,
    Test   = 6,
    Mkdir   = 8,
    Replace = 9,
    HeaderStatus = 10,
    SetHeaderEncryption = 12,
    ItemUpdateMode = 14,
    ReadReblockItem = 15,
    WriteReblockItem = 16
};

constexpr std::uint32_t kFlagRecursive = 1u << 0;
constexpr std::uint32_t kFlagDataEncrypted = 1u << 1;
constexpr std::uint32_t kFlagHeaderEncrypted = 1u << 2;

constexpr std::uint32_t kItemDirectory = 1u << 0;
constexpr std::uint32_t kItemEncrypted = 1u << 1;

// Private payload used only while a solid-follower Data Encryption toggle is
// detached from its shared block.  The JS side treats this blob as opaque and
// only passes it between short-lived helper processes.
constexpr std::uint32_t kReblockStateVersion = 1;
constexpr std::uint32_t kReblockHasAttributes = 1u << 0;
constexpr std::uint32_t kReblockHasModifiedTime = 1u << 1;
constexpr std::uint32_t kReblockKnownFlags =
    kReblockHasAttributes |
    kReblockHasModifiedTime;

struct Request {
    Op op{};
    std::uint32_t flags{};
    std::wstring libraryPath;
    std::wstring archivePath;
    std::wstring password;
    std::wstring path1;
    std::wstring path2;
    bit7z::buffer_t data;
};

struct ListItem {
    std::string pathUtf8;
    std::uint32_t flags{};
    std::uint64_t size{};
};

struct Response {
    std::int32_t status{};
    std::string message;
    std::vector<ListItem> items;
    std::vector<std::uint8_t> data;
};

class RandomEmptyDirectory {
public:
    RandomEmptyDirectory() {
        std::array<wchar_t, MAX_PATH + 1> tempPath{};
        const DWORD length = ::GetTempPathW(
            static_cast<DWORD>(tempPath.size()),
            tempPath.data()
        );
        if (length == 0 || length >= tempPath.size()) {
            throw std::runtime_error("Could not resolve Windows TEMP path");
        }

        for (unsigned attempt = 0; attempt < 32; ++attempt) {
            std::array<unsigned char, 16> randomBytes{};
            const NTSTATUS rngStatus = ::BCryptGenRandom(
                nullptr,
                randomBytes.data(),
                static_cast<ULONG>(randomBytes.size()),
                BCRYPT_USE_SYSTEM_PREFERRED_RNG
            );
            if (rngStatus < 0) {
                throw std::runtime_error(
                    "BCryptGenRandom failed while creating an empty directory item"
                );
            }

            static constexpr wchar_t kHex[] = L"0123456789abcdef";
            std::wstring name = L"e7z-empty-";
            name.reserve(name.size() + randomBytes.size() * 2);
            for (const auto byte : randomBytes) {
                name.push_back(kHex[(byte >> 4) & 0x0f]);
                name.push_back(kHex[byte & 0x0f]);
            }

            m_path = tempPath.data();
            if (
                !m_path.empty() &&
                m_path.back() != L'\\' &&
                m_path.back() != L'/'
            ) {
                m_path.push_back(L'\\');
            }
            m_path += name;

            if (::CreateDirectoryW(m_path.c_str(), nullptr)) {
                return;
            }

            const DWORD error = ::GetLastError();
            if (error != ERROR_ALREADY_EXISTS) {
                throw std::runtime_error(
                    "Could not create temporary empty directory"
                );
            }
        }

        throw std::runtime_error(
            "Could not allocate a unique temporary empty directory"
        );
    }

    RandomEmptyDirectory(const RandomEmptyDirectory&) = delete;
    RandomEmptyDirectory& operator=(const RandomEmptyDirectory&) = delete;

    ~RandomEmptyDirectory() {
        if (!m_path.empty()) {
            ::RemoveDirectoryW(m_path.c_str());
        }
    }

    const std::wstring& path() const noexcept {
        return m_path;
    }

private:
    std::wstring m_path;
};

void secureZero(void* ptr, std::size_t len) noexcept {
    if (ptr == nullptr || len == 0) return;
    ::SecureZeroMemory(ptr, len);
}

template <class T>
void secureZeroVector(std::vector<T>& v) noexcept {
    if (!v.empty()) {
        secureZero(v.data(), v.size() * sizeof(T));
    }
}

void secureZeroWString(std::wstring& value) noexcept {
    if (!value.empty()) {
        secureZero(value.data(), value.size() * sizeof(wchar_t));
    }
}

std::uint32_t readU32(const std::vector<std::uint8_t>& in, std::size_t& pos) {
    if (pos + 4 > in.size()) throw std::runtime_error("Truncated uint32");
    const auto v =
        static_cast<std::uint32_t>(in[pos]) |
        (static_cast<std::uint32_t>(in[pos + 1]) << 8) |
        (static_cast<std::uint32_t>(in[pos + 2]) << 16) |
        (static_cast<std::uint32_t>(in[pos + 3]) << 24);
    pos += 4;
    return v;
}

std::uint64_t readU64(const std::vector<std::uint8_t>& in, std::size_t& pos) {
    if (pos + 8 > in.size()) throw std::runtime_error("Truncated uint64");
    std::uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i) {
        v |= static_cast<std::uint64_t>(in[pos + i]) << (i * 8);
    }
    pos += 8;
    return v;
}

void appendU32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) {
        out.push_back(static_cast<std::uint8_t>((value >> (i * 8)) & 0xffu));
    }
}

void appendI32(std::vector<std::uint8_t>& out, std::int32_t value) {
    appendU32(out, static_cast<std::uint32_t>(value));
}

void appendU64(std::vector<std::uint8_t>& out, std::uint64_t value) {
    for (unsigned i = 0; i < 8; ++i) {
        out.push_back(static_cast<std::uint8_t>((value >> (i * 8)) & 0xffu));
    }
}

std::uint64_t fileTimeToU64(FILETIME value) noexcept {
    return static_cast<std::uint64_t>(value.dwLowDateTime) |
        (static_cast<std::uint64_t>(value.dwHighDateTime) << 32u);
}

FILETIME u64ToFileTime(std::uint64_t value) noexcept {
    FILETIME result{};
    result.dwLowDateTime = static_cast<DWORD>(value & 0xffffffffu);
    result.dwHighDateTime = static_cast<DWORD>(value >> 32u);
    return result;
}

struct PreservedItemMetadata {
    bool hasAttributes{};
    std::uint32_t attributes{};
    bool hasModifiedTime{};
    FILETIME modifiedTime{};
};

struct ReblockItemState {
    PreservedItemMetadata metadata;
    bit7z::buffer_t data;
};

std::string readBytesAsString(
    const std::vector<std::uint8_t>& in,
    std::size_t& pos,
    std::uint32_t len
) {
    if (len > in.size() - pos) throw std::runtime_error("Truncated string field");
    std::string result(
        reinterpret_cast<const char*>(in.data() + pos),
        static_cast<std::size_t>(len)
    );
    pos += len;
    return result;
}

std::wstring utf8ToWide(const std::string& input) {
    if (input.empty()) return {};
    const int required = ::MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS,
        input.data(), static_cast<int>(input.size()),
        nullptr, 0
    );
    if (required <= 0) throw std::runtime_error("Invalid UTF-8 input");

    std::wstring output(static_cast<std::size_t>(required), L'\0');
    const int written = ::MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS,
        input.data(), static_cast<int>(input.size()),
        output.data(), required
    );
    if (written != required) throw std::runtime_error("UTF-8 conversion failed");
    return output;
}

std::string wideToUtf8(const std::wstring& input) {
    if (input.empty()) return {};
    const int required = ::WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS,
        input.data(), static_cast<int>(input.size()),
        nullptr, 0, nullptr, nullptr
    );
    if (required <= 0) throw std::runtime_error("UTF-16 conversion failed");

    std::string output(static_cast<std::size_t>(required), '\0');
    const int written = ::WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS,
        input.data(), static_cast<int>(input.size()),
        output.data(), required, nullptr, nullptr
    );
    if (written != required) throw std::runtime_error("UTF-16 conversion failed");
    return output;
}

std::wstring normalizeMember(std::wstring value) {
    std::replace(value.begin(), value.end(), L'\\', L'/');
    while (!value.empty() && value.back() == L'/') value.pop_back();
    return value;
}

void validateMemberPath(const std::wstring& original) {
    if (original.empty()) {
        throw std::runtime_error("Archive member path is empty");
    }

    const auto p = normalizeMember(original);
    if (p.empty()) {
        throw std::runtime_error("Archive member path is empty");
    }

    if (p.front() == L'/') {
        throw std::runtime_error(
            "Absolute/UNC archive member path rejected"
        );
    }

    if (
        p.size() >= 2 &&
        ((p[0] >= L'A' && p[0] <= L'Z') ||
         (p[0] >= L'a' && p[0] <= L'z')) &&
        p[1] == L':'
    ) {
        throw std::runtime_error("Drive archive member path rejected");
    }

    std::size_t start = 0;
    while (start <= p.size()) {
        const auto slash = p.find(L'/', start);
        const auto end = slash == std::wstring::npos
            ? p.size()
            : slash;
        const auto part = p.substr(start, end - start);

        if (part.empty() || part == L"." || part == L"..") {
            throw std::runtime_error(
                "Unsafe archive member path rejected"
            );
        }
        if (part.find(L'\0') != std::wstring::npos) {
            throw std::runtime_error(
                "NUL in archive member path rejected"
            );
        }

        if (slash == std::wstring::npos) break;
        start = slash + 1;
    }
}

std::string formatWin32Error(const char* operation, DWORD error) {
    wchar_t* messageBuffer = nullptr;
    const DWORD length = ::FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER |
        FORMAT_MESSAGE_FROM_SYSTEM |
        FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        error,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&messageBuffer),
        0,
        nullptr
    );

    std::wstring message;
    if (length != 0 && messageBuffer != nullptr) {
        message.assign(messageBuffer, messageBuffer + length);
        ::LocalFree(messageBuffer);

        while (!message.empty() &&
               (message.back() == L'\r' ||
                message.back() == L'\n')) {
            message.pop_back();
        }
    }

    return std::string(operation) +
        " failed with Win32 error " +
        std::to_string(error) +
        (message.empty() ? "" : (": " + wideToUtf8(message)));
}

Request parseRequest(std::vector<std::uint8_t>& raw) {
    if (raw.size() < 44) throw std::runtime_error("Request too short");
    if (std::memcmp(raw.data(), "E7Q1", 4) != 0) {
        throw std::runtime_error("Invalid request magic");
    }

    std::size_t pos = 4;
    const auto version = readU32(raw, pos);
    if (version != kProtocolVersion) throw std::runtime_error("Unsupported protocol version");

    Request req;
    req.op = static_cast<Op>(readU32(raw, pos));
    req.flags = readU32(raw, pos);
    const auto libraryLen = readU32(raw, pos);
    const auto archiveLen = readU32(raw, pos);
    const auto passwordLen = readU32(raw, pos);
    const auto path1Len = readU32(raw, pos);
    const auto path2Len = readU32(raw, pos);
    const auto dataLen = readU64(raw, pos);

    if (dataLen > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        throw std::runtime_error("Request data too large");
    }

    auto libraryUtf8 = readBytesAsString(raw, pos, libraryLen);
    auto archiveUtf8 = readBytesAsString(raw, pos, archiveLen);
    auto passwordUtf8 = readBytesAsString(raw, pos, passwordLen);
    auto path1Utf8 = readBytesAsString(raw, pos, path1Len);
    auto path2Utf8 = readBytesAsString(raw, pos, path2Len);

    if (static_cast<std::uint64_t>(raw.size() - pos) != dataLen) {
        throw std::runtime_error("Request data length mismatch");
    }

    req.libraryPath = utf8ToWide(libraryUtf8);
    req.archivePath = utf8ToWide(archiveUtf8);
    req.password = utf8ToWide(passwordUtf8);

    auto path1Wide = utf8ToWide(path1Utf8);
    auto path2Wide = utf8ToWide(path2Utf8);

    if (req.op == Op::Replace) {
        req.path1 = std::move(path1Wide);
        req.path2 = std::move(path2Wide);
    } else {
        req.path1 = normalizeMember(std::move(path1Wide));
        req.path2 = normalizeMember(std::move(path2Wide));
    }

    req.data.assign(raw.begin() + static_cast<std::ptrdiff_t>(pos), raw.end());

    secureZero(passwordUtf8.data(), passwordUtf8.size());
    return req;
}

std::vector<std::uint8_t> serializeResponse(const Response& response) {
    std::vector<std::uint8_t> out;
    std::size_t estimate = 28 + response.message.size() + response.data.size();
    for (const auto& item : response.items) estimate += 16 + item.pathUtf8.size();
    out.reserve(estimate);

    out.insert(out.end(), {'E', '7', 'R', '1'});
    appendU32(out, kProtocolVersion);
    appendI32(out, response.status);
    appendU32(out, static_cast<std::uint32_t>(response.message.size()));
    appendU32(out, static_cast<std::uint32_t>(response.items.size()));
    appendU64(out, static_cast<std::uint64_t>(response.data.size()));
    out.insert(out.end(), response.message.begin(), response.message.end());

    for (const auto& item : response.items) {
        appendU32(out, static_cast<std::uint32_t>(item.pathUtf8.size()));
        appendU32(out, item.flags);
        appendU64(out, item.size);
        out.insert(out.end(), item.pathUtf8.begin(), item.pathUtf8.end());
    }

    out.insert(out.end(), response.data.begin(), response.data.end());
    return out;
}

std::vector<bit7z::BitArchiveItemInfo> readItems(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password
) {
    bit7z::BitArchiveReader reader{
        lib, archive, bit7z::BitFormat::SevenZip, password
    };
    return reader.items();
}

bool findItem(
    const std::vector<bit7z::BitArchiveItemInfo>& items,
    const std::wstring& member,
    std::uint32_t& index,
    bool* isDirectory = nullptr
) {
    const auto wanted = normalizeMember(member);
    for (const auto& item : items) {
        if (normalizeMember(item.path()) == wanted) {
            index = item.index();
            if (isDirectory != nullptr) {
                *isDirectory = item.isDir();
            }
            return true;
        }
    }
    return false;
}

const bit7z::BitArchiveItemInfo& requireFileItem(
    const std::vector<bit7z::BitArchiveItemInfo>& items,
    const std::wstring& member
) {
    const auto wanted = normalizeMember(member);
    for (const auto& item : items) {
        if (normalizeMember(item.path()) != wanted) continue;
        if (item.isDir()) {
            throw std::runtime_error("Archive item is a directory");
        }
        return item;
    }
    throw std::runtime_error("Archive item not found");
}

PreservedItemMetadata readPreservedMetadata(
    const bit7z::BitArchiveItemInfo& item
) {
    PreservedItemMetadata metadata;

    const auto attributes = item.itemProperty(bit7z::BitProperty::Attrib);
    if (!attributes.isEmpty()) {
        if (!attributes.isUInt32()) {
            throw std::runtime_error("Archive item attributes have an unexpected type");
        }
        metadata.hasAttributes = true;
        metadata.attributes = attributes.getUInt32();
    }

    const auto modifiedTime = item.itemProperty(bit7z::BitProperty::MTime);
    if (!modifiedTime.isEmpty()) {
        if (!modifiedTime.isFileTime()) {
            throw std::runtime_error("Archive item modified time has an unexpected type");
        }
        metadata.hasModifiedTime = true;
        metadata.modifiedTime = modifiedTime.getFileTime();
    }

    return metadata;
}

std::vector<std::uint8_t> serializeReblockItemState(
    const std::wstring& member,
    const PreservedItemMetadata& metadata,
    const bit7z::buffer_t& data
) {
    auto memberUtf8 = wideToUtf8(normalizeMember(member));
    if (memberUtf8.size() > std::numeric_limits<std::uint32_t>::max()) {
        throw std::runtime_error("Archive member path is too large");
    }

    std::uint32_t flags = 0;
    if (metadata.hasAttributes) flags |= kReblockHasAttributes;
    if (metadata.hasModifiedTime) flags |= kReblockHasModifiedTime;

    std::vector<std::uint8_t> out;
    out.reserve(36 + memberUtf8.size() + data.size());
    out.insert(out.end(), {'E', '7', 'S', '1'});
    appendU32(out, kReblockStateVersion);
    appendU32(out, flags);
    appendU32(out, static_cast<std::uint32_t>(memberUtf8.size()));
    appendU32(out, metadata.attributes);
    appendU64(out, fileTimeToU64(metadata.modifiedTime));
    appendU64(out, static_cast<std::uint64_t>(data.size()));
    out.insert(out.end(), memberUtf8.begin(), memberUtf8.end());
    secureZero(memberUtf8.data(), memberUtf8.size());
    out.insert(out.end(), data.begin(), data.end());
    return out;
}

ReblockItemState parseReblockItemState(
    const std::vector<std::uint8_t>& raw,
    const std::wstring& expectedMember
) {
    constexpr std::size_t kFixedSize = 36;
    if (raw.size() < kFixedSize || std::memcmp(raw.data(), "E7S1", 4) != 0) {
        throw std::runtime_error("Invalid reblock item state");
    }

    std::size_t pos = 4;
    if (readU32(raw, pos) != kReblockStateVersion) {
        throw std::runtime_error("Unsupported reblock item state version");
    }

    const auto flags = readU32(raw, pos);
    if ((flags & ~kReblockKnownFlags) != 0) {
        throw std::runtime_error("Unknown reblock item state flags");
    }

    const auto memberLen = readU32(raw, pos);
    const auto attributes = readU32(raw, pos);
    const auto modifiedTime = readU64(raw, pos);
    const auto dataLen = readU64(raw, pos);

    if (memberLen > raw.size() - pos) {
        throw std::runtime_error("Truncated reblock item state path");
    }
    auto memberUtf8 = readBytesAsString(raw, pos, memberLen);
    auto member = normalizeMember(utf8ToWide(memberUtf8));
    secureZero(memberUtf8.data(), memberUtf8.size());
    if (member != normalizeMember(expectedMember)) {
        throw std::runtime_error("Reblock item state path mismatch");
    }

    if (dataLen != static_cast<std::uint64_t>(raw.size() - pos)) {
        throw std::runtime_error("Reblock item state data length mismatch");
    }

    ReblockItemState state;
    state.metadata.hasAttributes = (flags & kReblockHasAttributes) != 0;
    state.metadata.attributes = attributes;
    state.metadata.hasModifiedTime = (flags & kReblockHasModifiedTime) != 0;
    state.metadata.modifiedTime = u64ToFileTime(modifiedTime);
    state.data.assign(raw.begin() + static_cast<std::ptrdiff_t>(pos), raw.end());
    return state;
}

class MetadataPreservingArchiveWriter final : public bit7z::BitArchiveWriter {
public:
    MetadataPreservingArchiveWriter(
        const bit7z::Bit7zLibrary& lib,
        const std::wstring& archive,
        const std::wstring& password,
        PreservedItemMetadata metadata
    ) : bit7z::BitArchiveWriter(
            lib,
            archive,
            bit7z::BitFormat::SevenZip,
            password
        ),
        m_metadata(metadata) {}

protected:
    auto itemProperty(
        bit7z::InputIndex index,
        bit7z::BitProperty property
    ) const -> bit7z::BitPropVariant override {
        const auto rawIndex = static_cast<std::uint32_t>(index);
        if (rawIndex >= inputArchiveItemsCount()) {
            switch (property) {
                case bit7z::BitProperty::Attrib:
                    return m_metadata.hasAttributes
                        ? bit7z::BitPropVariant{m_metadata.attributes}
                        : bit7z::BitPropVariant{};
                case bit7z::BitProperty::MTime:
                    return m_metadata.hasModifiedTime
                        ? bit7z::BitPropVariant{m_metadata.modifiedTime}
                        : bit7z::BitPropVariant{};
                default:
                    break;
            }
        }
        return bit7z::BitOutputArchive::itemProperty(index, property);
    }

private:
    PreservedItemMetadata m_metadata;
};

bool headerIsEncrypted(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive
) {
    try {
        bit7z::BitArchiveReader reader{
            lib, archive, bit7z::BitFormat::SevenZip
        };
        (void)reader.items();
        return false;
    } catch (...) {
        return true;
    }
}

bool archiveIsSolid(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password
) {
    bit7z::BitArchiveReader reader{
        lib,
        archive,
        bit7z::BitFormat::SevenZip,
        password
    };
    return reader.isSolid();
}

void applyHeaderPolicy(
    bit7z::BitArchiveEditor& editor,
    const std::wstring& password,
    bool headerEncrypted
) {
    editor.setPassword(
        password,
        headerEncrypted
            ? bit7z::EncryptionScope::DataAndHeaders
            : bit7z::EncryptionScope::DataOnly
    );

    if (!headerEncrypted) {
        editor.setFormatProperty(L"he", false);
    }
}

void preserveCurrentArchivePolicy(
    bit7z::BitArchiveEditor& editor,
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password
) {
    // Delete/rename/mkdir are structural edits. They must preserve both the
    // archive's existing solid mode and its current header-encryption policy.
    // Keep this policy setup centralized so a future structural operation
    // cannot accidentally rewrite those archive-wide properties.
    editor.setSolidMode(
        archiveIsSolid(lib, archive, password)
    );
    applyHeaderPolicy(
        editor,
        password,
        headerIsEncrypted(lib, archive)
    );
}

std::wstring randomTemporaryMember(
    const std::vector<bit7z::BitArchiveItemInfo>& items
) {
    for (unsigned attempt = 0; attempt < 32; ++attempt) {
        std::array<unsigned char, 16> randomBytes{};
        const NTSTATUS status = ::BCryptGenRandom(
            nullptr,
            randomBytes.data(),
            static_cast<ULONG>(randomBytes.size()),
            BCRYPT_USE_SYSTEM_PREFERRED_RNG
        );
        if (status < 0) {
            throw std::runtime_error(
                "BCryptGenRandom failed while creating temporary archive name"
            );
        }

        static constexpr wchar_t kHex[] = L"0123456789abcdef";
        std::wstring candidate = L".__e7z_header_tmp_";
        for (const auto byte : randomBytes) {
            candidate.push_back(kHex[(byte >> 4) & 0x0f]);
            candidate.push_back(kHex[byte & 0x0f]);
        }

        bool collision = false;
        for (const auto& item : items) {
            if (normalizeMember(item.path()) == candidate) {
                collision = true;
                break;
            }
        }
        if (!collision) return candidate;
    }

    throw std::runtime_error(
        "Could not allocate a temporary archive member name"
    );
}

void setHeaderEncryptionInternal(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password,
    bool desiredEncrypted
) {
    if (headerIsEncrypted(lib, archive) == desiredEncrypted) {
        return;
    }

    const auto items = readItems(lib, archive, password);

    const bit7z::BitArchiveItemInfo* anchor = nullptr;
    for (const auto& item : items) {
        if (!item.isDir()) {
            anchor = &item;
            break;
        }
    }

    if (anchor == nullptr) {
        throw std::runtime_error(
            "Header encryption toggle requires at least one file item"
        );
    }

    const auto originalPath = normalizeMember(anchor->path());
    const auto temporaryPath = randomTemporaryMember(items);
    const bool solid = archiveIsSolid(lib, archive, password);

    {
        // bit7z only persists an archive-level header-policy change as part of
        // a real archive update. Rename an existing member to a collision-safe
        // temporary name, then rename it back below, so only metadata changes
        // while file contents remain untouched.
        bit7z::BitArchiveEditor editor{
            lib, archive, bit7z::BitFormat::SevenZip, password
        };
        editor.setSolidMode(solid);
        applyHeaderPolicy(editor, password, desiredEncrypted);
        editor.renameItem(originalPath, temporaryPath);
        editor.applyChanges();
    }

    {
        bit7z::BitArchiveEditor editor{
            lib, archive, bit7z::BitFormat::SevenZip, password
        };
        editor.setSolidMode(solid);
        applyHeaderPolicy(editor, password, desiredEncrypted);
        editor.renameItem(temporaryPath, originalPath);
        editor.applyChanges();
    }
}

void writeFileWithEncryptionPolicy(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password,
    const std::wstring& member,
    const bit7z::buffer_t& data,
    bool dataEncrypted
) {
    auto items = readItems(lib, archive, password);
    std::uint32_t existingIndex = 0;
    bool existingIsDirectory = false;
    const bool exists = findItem(
        items,
        member,
        existingIndex,
        &existingIsDirectory
    );

    if (exists && existingIsDirectory) {
        throw std::runtime_error(
            "Cannot overwrite a directory with file data"
        );
    }

    const bool originalHeaderEncrypted =
        headerIsEncrypted(lib, archive);
    const bool originalSolid =
        archiveIsSolid(lib, archive, password);

    if (!dataEncrypted && originalHeaderEncrypted) {
        setHeaderEncryptionInternal(
            lib, archive, password, false
        );

        items = readItems(lib, archive, password);
        if (exists) {
            if (!findItem(
                    items,
                    member,
                    existingIndex,
                    &existingIsDirectory
                )) {
                throw std::runtime_error(
                    "Archive item disappeared during plaintext update"
                );
            }
        }
    }

    {
        bit7z::BitArchiveEditor editor{
            lib, archive, bit7z::BitFormat::SevenZip, password
        };

        // Preserve the archive's solid/non-solid mode across every rewrite.
        //
        // For plaintext output, clear only the DATA password. Header encryption
        // is a separate archive-wide policy and may have been temporarily
        // disabled above. Keep these concepts separate: a plaintext-data item
        // may still live in an archive whose filenames are encrypted.
        editor.setSolidMode(originalSolid);

        if (dataEncrypted) {
            applyHeaderPolicy(
                editor,
                password,
                originalHeaderEncrypted
            );
        } else {
            editor.clearPassword();
        }

        if (exists) {
            // Use the in-archive path rather than a cached numeric index.
            // Metadata rewrites can reorder archive items, making a previously
            // observed index unsafe to reuse.
            editor.updateItem(member, data);
        } else {
            editor.addFile(data, member);
        }

        editor.applyChanges();
    }

    if (!dataEncrypted && originalHeaderEncrypted) {
        setHeaderEncryptionInternal(
            lib, archive, password, true
        );
    }
}

std::vector<std::uint8_t> readReblockItemState(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password,
    const std::wstring& member
) {
    const auto items = readItems(lib, archive, password);
    const auto& item = requireFileItem(items, member);

    bit7z::BitFileExtractor extractor{ lib, bit7z::BitFormat::SevenZip };
    extractor.setPassword(password);

    bit7z::buffer_t data;
    extractor.extract(archive, data, item.index());

    try {
        auto state = serializeReblockItemState(
            member,
            readPreservedMetadata(item),
            data
        );
        secureZeroVector(data);
        return state;
    } catch (...) {
        secureZeroVector(data);
        throw;
    }
}

void writeReblockItemState(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password,
    const std::wstring& member,
    const std::vector<std::uint8_t>& rawState,
    bool dataEncrypted
) {
    auto state = parseReblockItemState(rawState, member);
    try {
        const auto items = readItems(lib, archive, password);
        std::uint32_t existingIndex = 0;
        bool existingIsDirectory = false;
        if (findItem(items, member, existingIndex, &existingIsDirectory)) {
            throw std::runtime_error(
                "Reblock target still exists before metadata-preserving add"
            );
        }

        const bool currentHeaderEncrypted = headerIsEncrypted(lib, archive);
        if (!dataEncrypted && currentHeaderEncrypted) {
            throw std::runtime_error(
                "Plaintext reblock add requires header encryption to be disabled in a prior phase"
            );
        }

        MetadataPreservingArchiveWriter writer{
            lib,
            archive,
            password,
            state.metadata
        };
        writer.setSolidMode(
            archiveIsSolid(lib, archive, password)
        );
        if (dataEncrypted) {
            writer.setPassword(
                password,
                currentHeaderEncrypted
                    ? bit7z::EncryptionScope::DataAndHeaders
                    : bit7z::EncryptionScope::DataOnly
            );
            if (!currentHeaderEncrypted) {
                writer.setFormatProperty(L"he", false);
            }
        } else {
            writer.clearPassword();
        }

        writer.addFile(state.data, member);
        writer.compressTo(archive);
    } catch (...) {
        secureZeroVector(state.data);
        throw;
    }
    secureZeroVector(state.data);
}

std::string itemUpdateMode(
    const bit7z::Bit7zLibrary& lib,
    const std::wstring& archive,
    const std::wstring& password,
    const std::wstring& member
) {
    bit7z::BitArchiveReader reader{
        lib,
        archive,
        bit7z::BitFormat::SevenZip,
        password
    };

    const auto items = reader.items();
    std::uint32_t index = 0;
    bool isDirectory = false;
    if (!findItem(items, member, index, &isDirectory)) {
        throw std::runtime_error(
            "Archive item not found while determining update mode"
        );
    }
    if (isDirectory) {
        throw std::runtime_error(
            "Data encryption update mode is only valid for files"
        );
    }

    const bit7z::BitArchiveItemInfo* selected = nullptr;
    for (const auto& item : items) {
        if (item.index() == index) {
            selected = &item;
            break;
        }
    }
    if (selected == nullptr) {
        throw std::runtime_error(
            "Archive item index not found while determining update mode"
        );
    }

    // In 7z solid archives, PackSize is stored only on the first file of a
    // solid block. A non-empty later item reports packSize == 0 and shares the
    // compressed stream with its block leader. Updating that follower in-place
    // can return UnsupportedOperation when its encryption coder changes.
    //
    // Reblock mode removes the target from the old shared block and adds it
    // back as new data, which lets 7-Zip create a new block for that item.
    if (
        reader.isSolid() &&
        selected->size() > 0 &&
        selected->packSize() == 0
    ) {
        return "reblock";
    }

    return "direct";
}

// Security boundary: one native request is handled by one helper process.
// The JS side launches a fresh process for each operation so 7-Zip handles and
// password-bearing native state do not survive into the next phase.
Response execute(Request& req) {
    Response response;

    if (req.op == Op::Replace) {
        if (req.archivePath.empty() || req.path1.empty()) {
            throw std::runtime_error(
                "ReplaceFileW path is empty"
            );
        }

        const wchar_t* backupPath = req.path2.empty()
            ? nullptr
            : req.path2.c_str();

        if (!::ReplaceFileW(
                req.archivePath.c_str(),
                req.path1.c_str(),
                backupPath,
                0,
                nullptr,
                nullptr
            )) {
            const DWORD error = ::GetLastError();
            throw std::runtime_error(
                formatWin32Error("ReplaceFileW", error)
            );
        }

        return response;
    }

    if (req.libraryPath.empty()) {
        throw std::runtime_error("7z.dll path is empty");
    }
    if (req.archivePath.empty()) {
        throw std::runtime_error("Archive path is empty");
    }

    bit7z::Bit7zLibrary lib{ req.libraryPath };

    switch (req.op) {

        case Op::List: {
            const auto items = readItems(lib, req.archivePath, req.password);
            response.items.reserve(items.size());

            for (const auto& item : items) {
                auto normalized = normalizeMember(item.path());
                ListItem outItem;
                outItem.pathUtf8 = wideToUtf8(normalized);
                outItem.flags =
                    (item.isDir() ? kItemDirectory : 0u) |
                    (item.isEncrypted() ? kItemEncrypted : 0u);
                outItem.size = item.size();
                response.items.push_back(std::move(outItem));
            }
            return response;
        }

        case Op::Read: {
            validateMemberPath(req.path1);
            const auto items = readItems(lib, req.archivePath, req.password);
            std::uint32_t index = 0;
            bool isDirectory = false;
            if (!findItem(items, req.path1, index, &isDirectory)) {
                throw std::runtime_error("Archive item not found");
            }
            if (isDirectory) {
                throw std::runtime_error("Cannot read a directory");
            }

            bit7z::BitFileExtractor extractor{ lib, bit7z::BitFormat::SevenZip };
            extractor.setPassword(req.password);

            bit7z::buffer_t out;
            extractor.extract(req.archivePath, out, index);
            response.data.assign(out.begin(), out.end());
            secureZeroVector(out);
            return response;
        }

        case Op::Write: {
            validateMemberPath(req.path1);

            writeFileWithEncryptionPolicy(
                lib,
                req.archivePath,
                req.password,
                req.path1,
                req.data,
                (req.flags & kFlagDataEncrypted) != 0
            );
            return response;
        }

        case Op::Delete: {
            validateMemberPath(req.path1);

            bit7z::BitArchiveEditor editor{
                lib, req.archivePath, bit7z::BitFormat::SevenZip, req.password
            };
            preserveCurrentArchivePolicy(
                editor,
                lib,
                req.archivePath,
                req.password
            );
            editor.deleteItem(
                req.path1,
                (req.flags & kFlagRecursive)
                    ? bit7z::DeletePolicy::RecurseDirs
                    : bit7z::DeletePolicy::ItemOnly
            );
            editor.applyChanges();
            return response;
        }

        case Op::Rename: {
            validateMemberPath(req.path1);
            validateMemberPath(req.path2);

            bit7z::BitArchiveEditor editor{
                lib, req.archivePath, bit7z::BitFormat::SevenZip, req.password
            };
            preserveCurrentArchivePolicy(
                editor,
                lib,
                req.archivePath,
                req.password
            );
            editor.renameItem(req.path1, req.path2);
            editor.applyChanges();
            return response;
        }

        case Op::Mkdir: {
            validateMemberPath(req.path1);

            const auto items = readItems(lib, req.archivePath, req.password);
            std::uint32_t existingIndex = 0;
            bool existingIsDirectory = false;
            const bool exists = findItem(
                items,
                req.path1,
                existingIndex,
                &existingIsDirectory
            );

            if (exists) {
                if (!existingIsDirectory) {
                    throw std::runtime_error(
                        "Cannot create a directory over an existing file"
                    );
                }
                // Idempotent directory creation.
                return response;
            }

            RandomEmptyDirectory emptyDirectory;

            bit7z::BitArchiveEditor editor{
                lib, req.archivePath, bit7z::BitFormat::SevenZip, req.password
            };
            preserveCurrentArchivePolicy(
                editor,
                lib,
                req.archivePath,
                req.password
            );

            // addItems supports filesystem-path -> in-archive-path aliases.
            // The filesystem path is a random, empty directory; the sensitive
            // archive directory name exists only in memory and inside the
            // encrypted archive metadata.
            std::map<std::wstring, std::wstring> aliasedItems;
            aliasedItems.emplace(emptyDirectory.path(), req.path1);
            editor.addItems(aliasedItems);
            editor.applyChanges();
            return response;
        }

        case Op::HeaderStatus: {
            (void)readItems(
                lib, req.archivePath, req.password
            );
            response.message =
                headerIsEncrypted(lib, req.archivePath)
                    ? "1"
                    : "0";
            return response;
        }

        case Op::SetHeaderEncryption: {
            const bool desiredEncrypted =
                (req.flags & kFlagHeaderEncrypted) != 0;

            (void)readItems(
                lib, req.archivePath, req.password
            );

            setHeaderEncryptionInternal(
                lib,
                req.archivePath,
                req.password,
                desiredEncrypted
            );
            return response;
        }

        case Op::ReadReblockItem: {
            validateMemberPath(req.path1);
            response.data = readReblockItemState(
                lib,
                req.archivePath,
                req.password,
                req.path1
            );
            return response;
        }

        case Op::WriteReblockItem: {
            validateMemberPath(req.path1);
            writeReblockItemState(
                lib,
                req.archivePath,
                req.password,
                req.path1,
                req.data,
                (req.flags & kFlagDataEncrypted) != 0
            );
            return response;
        }

        case Op::ItemUpdateMode: {
            validateMemberPath(req.path1);
            response.message = itemUpdateMode(
                lib,
                req.archivePath,
                req.password,
                req.path1
            );
            return response;
        }

        case Op::Test: {
            bit7z::BitFileExtractor extractor{ lib, bit7z::BitFormat::SevenZip };
            extractor.setPassword(req.password);
            extractor.test(req.archivePath);
            return response;
        }

        default:
            throw std::runtime_error("Unsupported operation");
    }
}

} // namespace

int main() {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    std::vector<std::uint8_t> raw{
        std::istreambuf_iterator<char>(std::cin),
        std::istreambuf_iterator<char>()
    };

    Request req;
    Response response;

    try {
        req = parseRequest(raw);
        response = execute(req);
    } catch (const bit7z::BitException& ex) {
        response.status = 1;
        response.message = ex.what();
    } catch (const std::exception& ex) {
        response.status = 2;
        response.message = ex.what();
    } catch (...) {
        response.status = 3;
        response.message = "Unknown native bridge error";
    }

    // Best-effort cleanup of secrets before returning the response.
    secureZeroWString(req.password);
    secureZeroVector(req.data);
    secureZeroVector(raw);

    auto serialized = serializeResponse(response);
    if (!serialized.empty()) {
        std::cout.write(
            reinterpret_cast<const char*>(serialized.data()),
            static_cast<std::streamsize>(serialized.size())
        );
        std::cout.flush();
    }

    secureZeroVector(response.data);
    secureZeroVector(serialized);
    return 0;
}
