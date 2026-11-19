// Spike (M2b): which cameras are there, and which picture formats can each one deliver?
//
// Read-only: lists every video capture device and its native formats (codec, size, frame rate).
// It never starts a stream, so no picture is captured or stored (privacy).
//
// Usage: CamProbe

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <cstdio>
#include <map>
#include <set>
#include <string>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

template <typename T> static void release (T*& p)
{
    if (p != nullptr)
        p->Release();
    p = nullptr;
}

static std::string subtypeName (const GUID& g)
{
    if (g == MFVideoFormat_MJPG) return "MJPG";
    if (g == MFVideoFormat_NV12) return "NV12";
    if (g == MFVideoFormat_YUY2) return "YUY2";
    if (g == MFVideoFormat_H264) return "H264";
    if (g == MFVideoFormat_RGB24) return "RGB24";
    if (g == MFVideoFormat_RGB32) return "RGB32";
    if (g == MFVideoFormat_I420) return "I420";
    char s[16];
    std::snprintf (s, sizeof (s), "%08lX", g.Data1); // FOURCC-style id for anything else
    return s;
}

int main()
{
    CoInitializeEx (nullptr, COINIT_MULTITHREADED);
    MFStartup (MF_VERSION);

    IMFAttributes* attr = nullptr;
    MFCreateAttributes (&attr, 1);
    attr->SetGUID (MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    IMFActivate** devices = nullptr;
    UINT32 count = 0;
    if (FAILED (MFEnumDeviceSources (attr, &devices, &count)))
        return std::printf ("could not list cameras\n"), 1;
    std::printf ("%u camera(s)\n", count);

    for (UINT32 i = 0; i < count; ++i)
    {
        WCHAR* name = nullptr;
        UINT32 len = 0;
        devices[i]->GetAllocatedString (MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
        std::printf ("\n== %ls\n", name != nullptr ? name : L"(no name)");
        CoTaskMemFree (name);

        IMFMediaSource* source = nullptr;
        IMFPresentationDescriptor* pd = nullptr;
        if (FAILED (devices[i]->ActivateObject (IID_PPV_ARGS (&source))) || FAILED (source->CreatePresentationDescriptor (&pd)))
        {
            std::printf ("   could not open (in use by another app?)\n");
            release (source);
            continue;
        }
        // subtype -> size -> set of frame rates (deduplicated, highest first)
        std::map<std::string, std::map<std::pair<UINT32, UINT32>, std::set<double, std::greater<double>>>> formats;
        DWORD streams = 0;
        pd->GetStreamDescriptorCount (&streams);
        for (DWORD s = 0; s < streams; ++s)
        {
            BOOL selected = FALSE;
            IMFStreamDescriptor* sd = nullptr;
            IMFMediaTypeHandler* handler = nullptr;
            pd->GetStreamDescriptorByIndex (s, &selected, &sd);
            if (sd == nullptr || FAILED (sd->GetMediaTypeHandler (&handler)))
            {
                release (sd);
                continue;
            }
            DWORD types = 0;
            handler->GetMediaTypeCount (&types);
            for (DWORD t = 0; t < types; ++t)
            {
                IMFMediaType* mt = nullptr;
                if (FAILED (handler->GetMediaTypeByIndex (t, &mt)))
                    continue;
                GUID sub {};
                UINT32 w = 0, h = 0, num = 0, den = 1;
                mt->GetGUID (MF_MT_SUBTYPE, &sub);
                MFGetAttributeSize (mt, MF_MT_FRAME_SIZE, &w, &h);
                MFGetAttributeRatio (mt, MF_MT_FRAME_RATE, &num, &den);
                formats[subtypeName (sub)][{ w, h }].insert (den != 0 ? (double) num / den : 0.0);
                release (mt);
            }
            release (handler);
            release (sd);
        }
        for (auto& [sub, sizes] : formats)
        {
            std::printf ("   %s:\n", sub.c_str());
            for (auto it = sizes.rbegin(); it != sizes.rend(); ++it)
            {
                std::printf ("      %4ux%-4u  fps:", it->first.first, it->first.second);
                for (double f : it->second)
                    std::printf (" %.4g", f);
                std::printf ("\n");
            }
        }
        source->Shutdown();
        release (pd);
        release (source);
        devices[i]->ShutdownObject();
    }
    for (UINT32 i = 0; i < count; ++i)
        devices[i]->Release();
    CoTaskMemFree (devices);
    release (attr);
    MFShutdown();
    CoUninitialize();
    return 0;
}
