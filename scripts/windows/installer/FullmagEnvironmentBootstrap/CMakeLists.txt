cmake_minimum_required(VERSION 3.21)

project(FullmagEnvironmentBootstrap LANGUAGES CXX RC)

if(NOT WIN32)
  message(FATAL_ERROR "FullmagEnvironmentBootstrap is a native Windows target")
endif()

if(DEFINED CMAKE_SIZEOF_VOID_P AND NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "FullmagEnvironmentBootstrap must be built as x86/Win32 for WiX 3 Burn")
endif()

add_executable(FullmagEnvironmentBootstrap
  FullmagEnvironmentBootstrap.cpp
  FullmagEnvironmentBootstrap.rc
  resource.h
  ../../run_installer_environment.ps1
)

target_compile_features(FullmagEnvironmentBootstrap PRIVATE cxx_std_17)
target_compile_definitions(FullmagEnvironmentBootstrap PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
target_link_libraries(FullmagEnvironmentBootstrap PRIVATE
  Advapi32
)

if(MSVC)
  target_compile_options(FullmagEnvironmentBootstrap PRIVATE /W4 /permissive- /EHsc)
  # The Win32 bootstrap owns its manifest in the RC resource above.  Visual
  # Studio otherwise enables its generated manifest target by default, which
  # adds a second RT_MANIFEST resource (CVTRES1100/LNK1123).  Keep the linker
  # from manufacturing another manifest while retaining the asInvoker resource.
  set_property(TARGET FullmagEnvironmentBootstrap PROPERTY VS_GLOBAL_GenerateManifest "false")
  target_link_options(FullmagEnvironmentBootstrap PRIVATE /MANIFEST:NO)
endif()

set_target_properties(FullmagEnvironmentBootstrap PROPERTIES
  OUTPUT_NAME "fullmag-installer-environment"
  SUFFIX ".exe"
  WIN32_EXECUTABLE FALSE
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
