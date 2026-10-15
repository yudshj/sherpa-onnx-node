cmake_minimum_required(VERSION 3.21)
cmake_policy(SET CMP0091 NEW)
project(dsh_sherpa_arm64 LANGUAGES CXX)

if(NOT MSVC OR NOT CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  message(FATAL_ERROR "Use Visual Studio 2022 with -A ARM64")
endif()

foreach(path_var SOURCE_ROOT API_ROOT HEADERS_ROOT GYP_ROOT NODE_LIB LIBRARY_ROOT)
  file(TO_CMAKE_PATH "${${path_var}}" ${path_var})
endforeach()

# The Node addon directory links to these shared sources; extract real files on Windows.
file(GLOB addon_sources CONFIGURE_DEPENDS "${SOURCE_ROOT}/harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/*.cc")
list(FILTER addon_sources EXCLUDE REGEX "/utils\\.cc$")
add_library(sherpa-onnx SHARED ${addon_sources} "${GYP_ROOT}/src/win_delay_load_hook.cc")
set_target_properties(sherpa-onnx PROPERTIES PREFIX "" SUFFIX ".node" CXX_STANDARD 17
  MSVC_RUNTIME_LIBRARY "MultiThreaded")
target_include_directories(sherpa-onnx PRIVATE "${SOURCE_ROOT}" "${API_ROOT}" "${HEADERS_ROOT}/include/node")
# Node-API stays ABI-stable; the delay hook resolves exports from Electron's executable.
target_compile_definitions(sherpa-onnx PRIVATE NAPI_VERSION=8 HOST_BINARY="node.exe")
target_compile_options(sherpa-onnx PRIVATE /utf-8)
target_link_libraries(sherpa-onnx PRIVATE "${NODE_LIB}" "${LIBRARY_ROOT}/lib/sherpa-onnx-c-api.lib"
  "${LIBRARY_ROOT}/lib/onnxruntime.lib" delayimp)
target_link_options(sherpa-onnx PRIVATE /DELAYLOAD:node.exe)

# Keep local PDB paths out of release binaries.
target_link_options(sherpa-onnx PRIVATE /DEBUG:NONE /PDBALTPATH:sherpa-onnx.pdb /INCREMENTAL:NO)
