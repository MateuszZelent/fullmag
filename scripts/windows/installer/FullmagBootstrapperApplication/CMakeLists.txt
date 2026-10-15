cmake_minimum_required(VERSION 3.21)

project(FullmagBootstrapperApplication LANGUAGES CXX)

option(FULLMAG_ENABLE_BOOTSTRAPPER_APPLICATION
       "Build the production WiX 3 Burn bootstrapper application DLL" ON)

if(NOT WIN32)
  message(FATAL_ERROR "FullmagBootstrapperApplication is a native Windows target")
endif()

if(DEFINED CMAKE_SIZEOF_VOID_P AND NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "WiX 3 Burn BA must be built as x86/Win32")
endif()

set(WIX3_SDK_ROOT "" CACHE PATH
    "Root of the exact WiX 3 SDK used by candle/light and WixBalExtension")
set(WIX3_SDK_INCLUDE_DIR "" CACHE PATH
    "Directory containing IBootstrapperApplication.h and IBootstrapperEngine.h")

find_path(WIX3_BURN_INCLUDE_DIR
          NAMES IBootstrapperApplication.h IBootstrapperEngine.h
          HINTS
            "${WIX3_SDK_INCLUDE_DIR}"
            "${WIX3_SDK_ROOT}"
            "${WIX3_SDK_ROOT}/inc"
            "${WIX3_SDK_ROOT}/src/burn/inc"
          DOC "WiX 3 Burn SDK interface headers")

if(NOT WIX3_BURN_INCLUDE_DIR)
  message(FATAL_ERROR
    "WiX 3 Burn SDK headers are required; set WIX3_SDK_ROOT or WIX3_SDK_INCLUDE_DIR")
endif()
if(NOT EXISTS "${WIX3_BURN_INCLUDE_DIR}/IBootstrapperApplication.h" OR
   NOT EXISTS "${WIX3_BURN_INCLUDE_DIR}/IBootstrapperEngine.h")
  message(FATAL_ERROR
    "The configured directory must contain both WiX 3 Burn interface headers")
endif()

if(NOT FULLMAG_ENABLE_BOOTSTRAPPER_APPLICATION)
  return()
endif()

add_library(FullmagBootstrapperApplication SHARED
  FullmagBootstrapperApplication.cpp
  FullmagBootstrapperApplication.h
  FullmagInstallerUiBroker.cpp
  FullmagInstallerUiBroker.h
  FullmagBootstrapperApplication.def
  FullmagBootstrapperApplication.rc
)

target_include_directories(FullmagBootstrapperApplication PRIVATE
  "${WIX3_BURN_INCLUDE_DIR}"
)
target_compile_features(FullmagBootstrapperApplication PRIVATE cxx_std_17)
target_compile_definitions(FullmagBootstrapperApplication PRIVATE
  FULLMAG_WIX3_BA=1
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
target_link_libraries(FullmagBootstrapperApplication PRIVATE
  Advapi32
  Comctl32
  Crypt32
  Ole32
  Shell32
  User32
  Version
)

if(MSVC)
  target_compile_options(FullmagBootstrapperApplication PRIVATE /W4 /permissive-)
endif()

set_target_properties(FullmagBootstrapperApplication PROPERTIES
  OUTPUT_NAME "FullmagBootstrapperApplication"
  SUFFIX ".dll"
  WINDOWS_EXPORT_ALL_SYMBOLS OFF
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
