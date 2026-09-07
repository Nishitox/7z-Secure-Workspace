cmake_minimum_required(VERSION 3.24)

project(e7z_bridge VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32)
    message(FATAL_ERROR "The native bridge currently targets Windows only.")
endif()

include(FetchContent)

# Keep bit7z narrowly configured for this 7z-only bridge.
set(BIT7Z_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BIT7Z_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(BIT7Z_AUTO_FORMAT OFF CACHE BOOL "" FORCE)
set(BIT7Z_REGEX_MATCHING OFF CACHE BOOL "" FORCE)
set(BIT7Z_USE_PCH OFF CACHE BOOL "" FORCE)
set(BIT7Z_PATH_SANITIZATION ON CACHE BOOL "" FORCE)
set(BIT7Z_USE_STD_BYTE OFF CACHE BOOL "" FORCE)
set(BIT7Z_USE_NATIVE_STRING ON CACHE BOOL "" FORCE)
set(BIT7Z_AUTO_PREFIX_LONG_PATHS ON CACHE BOOL "" FORCE)
set(BIT7Z_7ZIP_VERSION "26.03" CACHE STRING "" FORCE)

# Pin bit7z to the exact signed v4.1.0 release commit rather than a mutable tag URL.
# The build still uses upstream bit7z without local source modifications.
FetchContent_Declare(
    bit7z
    GIT_REPOSITORY https://github.com/rikyoz/bit7z.git
    GIT_TAG c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742
    GIT_PROGRESS TRUE
)
FetchContent_MakeAvailable(bit7z)

add_executable(e7z_bridge src/main.cpp)
target_link_libraries(e7z_bridge PRIVATE bit7z bcrypt)

target_compile_definitions(
    e7z_bridge PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)

if(MSVC)
    target_compile_options(e7z_bridge PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(e7z_bridge PRIVATE -Wall -Wextra -Wpedantic)
endif()
