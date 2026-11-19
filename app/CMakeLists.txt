cmake_minimum_required(VERSION 3.24)
project(WorshipStudio VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)

# JUCE 9 (AGPLv3 or commercial). See docs/LICENSES.md.
set(JUCE_WEBVIEW2_PACKAGE_LOCATION ${THIRD_PARTY}/webview2 CACHE PATH "WebView2 NuGet package folder")
add_subdirectory(${THIRD_PARTY}/JUCE ${CMAKE_BINARY_DIR}/JUCE)

# Signalsmith Stretch + Linear (MIT), header-only.
add_library(signalsmith INTERFACE)
target_include_directories(signalsmith SYSTEM INTERFACE ${THIRD_PARTY}/signalsmith-stretch/include ${THIRD_PARTY}/signalsmith-stretch ${THIRD_PARTY}/signalsmith-linear/include ${THIRD_PARTY}/signalsmith-linear)

juce_add_gui_app(WorshipStudio
    PRODUCT_NAME "Worship Studio"
    COMPANY_NAME "Worship Studio"
    BUNDLE_ID "app.worshipstudio.desktop"
    NEEDS_WEBVIEW2 TRUE)

target_sources(WorshipStudio PRIVATE
    src/Main.cpp
    src/MainComponent.cpp
    src/Engine.cpp
    src/Library.cpp
    src/Jobs.cpp
    src/Exporter.cpp
    src/BrowserCapture.cpp
    src/InputRecorder.cpp
    src/RecordSession.cpp
    src/MonitorTap.h
    src/NativeWindows.cpp
    src/Limiter.h)

target_compile_definitions(WorshipStudio PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_USE_CURL=0
    JUCE_USE_MP3AUDIOFORMAT=1
    JUCE_USE_WINDOWS_MEDIA_FORMAT=1
    JUCE_ASIO=0
    JUCE_WASAPI=1
    JUCE_DIRECTSOUND=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:WorshipStudio,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:WorshipStudio,JUCE_VERSION>"
    WSA_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/..")

target_link_libraries(WorshipStudio PRIVATE
    juce::juce_gui_extra
    juce::juce_audio_utils
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_dsp
    signalsmith
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

if(MSVC)
    target_compile_options(WorshipStudio PRIVATE /utf-8 /bigobj $<$<CONFIG:Release>:/Zi>)
    # Symbols for every Release build (crash logs need them); /OPT keeps the same optimised code.
    target_link_options(WorshipStudio PRIVATE $<$<CONFIG:Release>:/DEBUG> $<$<CONFIG:Release>:/OPT:REF> $<$<CONFIG:Release>:/OPT:ICF>)
endif()

# Spike (M2b): two USB inputs at once + clock drift. Not part of the app.
juce_add_console_app(DualInputSpike PRODUCT_NAME "DualInputSpike")
target_sources(DualInputSpike PRIVATE ../spikes/dualinput/DualInputSpike.cpp)
target_compile_definitions(DualInputSpike PRIVATE JUCE_WASAPI=1 JUCE_ASIO=0 JUCE_DIRECTSOUND=0 JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(DualInputSpike PRIVATE juce::juce_audio_devices juce::juce_recommended_config_flags)

# Spike (M2b): list cameras and their formats (read-only, no stream). Not part of the app.
add_executable(CamProbe ../spikes/camprobe/CamProbe.cpp)

# Test for the input recorder (M2b): dry run on two inputs + drift/offset correction on synthetic audio.
juce_add_console_app(RecorderTest PRODUCT_NAME "RecorderTest")
target_sources(RecorderTest PRIVATE ../spikes/recorder/RecorderTest.cpp src/InputRecorder.cpp)
target_compile_definitions(RecorderTest PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(RecorderTest PRIVATE juce::juce_audio_formats juce::juce_recommended_config_flags)

# Checks for the output stage (Limiter.h): ceiling, click floor, music dip, pause fade.
juce_add_console_app(LimiterTest PRODUCT_NAME "LimiterTest")
target_sources(LimiterTest PRIVATE ../spikes/limiter/LimiterTest.cpp)
target_link_libraries(LimiterTest PRIVATE juce::juce_audio_basics juce::juce_recommended_config_flags)

# Renders the ambient pad sounds offline (levels + WAVs to listen to).
juce_add_console_app(PadRender PRODUCT_NAME "PadRender")
target_sources(PadRender PRIVATE ../spikes/pad/PadRender.cpp)
target_compile_definitions(PadRender PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(PadRender PRIVATE juce::juce_audio_formats juce::juce_recommended_config_flags)
