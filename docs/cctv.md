> **Deferred feature:** CCTV integration is postponed for the current prototype. `ENABLE_CCTV` defaults to false; the panel is hidden and sources are not loaded at startup. Continue with photo/video uploads or device camera monitoring. To resume this guide later, set `ENABLE_CCTV=true` in `backend/.env`, configure sources, and restart. This flag does not establish recorder connectivity.

# CCTV cameras and background monitoring

ParkVision can read multiple configured **RTSP** feeds on the backend, sample
their frames, classify each camera's saved parking regions with the installed
EfficientNetB0, and publish accepted observations to Supabase. Monitoring continues
when an administrator leaves the workspace or closes the browser. The laptop/server
and its network connection must remain running.

Each parking space still belongs to one active camera region. Existing tables and
the current model are reused. No SQL reset or migration is required.

## Try the prepared demo away from the site

On this Mac, `output/cctv-demo/parking-demo.mp4` alternates the two supplied night
photos, four seconds each. It is a **recorded demonstration**, not live CCTV or a
new accuracy evaluation. CAM-04 has a local replay-source configuration, stopped
by default with publishing off. No hosted camera records/regions were changed to
prepare it.

1. Open the app and sign in as your administrator.
2. In **Camera workspace**, choose **CAM-04**.
3. In **CCTV monitoring**, leave publishing unchecked and click **Start CCTV monitoring**.
4. The panel should show **Demo replay**, a changing preview, and automatic
   classifications for that camera's current saved regions.
5. **Use CCTV frame for parking boxes** freezes a reference into the existing box
   editor. Keep calibration consistent with the final camera view. Stop publishing
   before editing real calibration; changes during analysis discard that result.
6. Optionally stop the demo, explicitly enable **Publish replay observations (demo)**,
   then start it again to test the complete write path. This writes demo observations
   with analysis-time timestamps into your real project. Keep publishing off when
   you only want to inspect the pipeline.
7. Use **Stop CCTV monitoring** when done. Leaving the workspace alone does not stop
   backend monitoring. Its observations become Unverified as they age past ten seconds.

The initial demo replay reuses your current CAM-04 boxes. If you changed those
boxes for another view, recalibrate before interpreting its results. Do not replace
real-site calibration merely to make a sample look better.

To regenerate the replay from your own example photo paths:

```bash
python3 scripts/prepare-cctv-demo.py \
  --occupied-photo /path/to/occupied.jpg \
  --mixed-photo /path/to/empty-left-occupied-right.jpg
```

## Connect real CCTV later

First identify the camera/recorder model and obtain its documented RTSP address
for each camera/channel. IP cameras can expose streams directly; a DVR/NVR may
expose a different stream per channel. Vendor cloud-app viewing alone does not
establish RTSP access. Cloud-only feeds, ONVIF discovery, HTTP snapshot inputs,
and proprietary vendor protocols are not implemented in this version.

The server must reach those addresses: run it on the CCTV network or provide a
VPN route to that network. The phone HTTPS tunnel only exposes ParkVision to a
browser; it does not create an inbound route to a recorder elsewhere. Keep recorder
ports off the public Internet.

FFmpeg is installed on this Mac. On another Mac run `brew install ffmpeg`, or
set `FFMPEG_PATH` in `backend/.env` to its executable.

Camera source configuration lives only in **`backend/cctv.local.json`**, ignored
by Git. The committed `backend/cctv.example.json` shows the shape. An administrator
can see each camera's UUID in the unconfigured CCTV panel; use that UUID rather
than its human-readable code.

```json
[
  {
    "cameraId": "40000000-0000-4000-8000-000000000001",
    "type": "rtsp",
    "source": "rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.1.100:554/VENDOR_STREAM_PATH",
    "autoStart": false,
    "publish": false
  },
  {
    "cameraId": "40000000-0000-4000-8000-000000000002",
    "type": "rtsp",
    "source": "rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.1.100:554/OTHER_CHANNEL_PATH",
    "autoStart": false,
    "publish": false
  }
]
```

Replace example IDs and paths with the actual camera records and vendor stream
addresses. URL-encode special characters in usernames/passwords. Stream URLs and
logins are not returned to the frontend. FFmpeg stderr is not forwarded because it
can include credentials; connection errors shown in the app use generic messages.

After changing sources, restart the backend (`npm run dev` or `npm start`). The
app supports at most 16 configured sources. That is a configuration cap, not a
tested hardware-capacity promise. Begin with one real camera, then measure more.

Set `autoStart: true` to connect that source whenever the backend starts. Set
`publish: true` together with auto-start only when you intend it to write accepted
results automatically. With manual start, the administrator's publication checkbox
chooses the mode for that run. Starting/stopping cameras requires an administrator;
approved personnel can view status, preview frames, and classifications.

## Runtime behavior and limits

- A persistent FFmpeg decoder per source keeps only its latest JPEG in memory.
  RTSP uses TCP and a ten-second socket timeout. Stalled sources reconnect with
  bounded backoff; a broken camera does not stop other configured cameras.
- The browser gets an authenticated, sampled-frame preview about every two
  seconds. **This is not a full-motion HLS/WebRTC player.** It is sufficient to
  preview the camera and define boxes; full-motion streaming is separate work.
- Every camera is eligible for classification about every two seconds. All share
  one loaded model through a bounded FIFO queue. Slow inference or networking can
  reduce the rate. Camera count and actual latency require site testing.
- Frames older than five seconds are not used for preview or publication. A
  decoded frame is timestamped when received by ParkVision; this is not a verified
  camera hardware timestamp or a measurement of upstream stream latency. File
  replay is explicitly marked demo and uses the same processing-time convention.
- Saved camera activity and geometry are checked again after inference. A result
  from changed/archived regions is dropped. Database constraints also enforce
  region/frame camera ownership. Avoid concurrent calibration during publication.
- Predictions below the existing review threshold are skipped. Disconnects and
  skipped predictions do not refresh old observation timestamps; the availability
  view's ten-second stale rule still applies.
- Uploaded media/device camera capture are disabled for a camera while its backend
  CCTV monitor is running, to avoid accidentally publishing different views under
  one camera ID. Stop CCTV monitoring to switch that camera's source.
- Source files are loaded at startup. Manual Start/publishing choices reset on a
  backend restart unless auto-start is explicitly configured. Stop commands do not
  rewrite the server source file; disable auto-start there to prevent a later restart.
- No CCTV images/video are uploaded to Supabase. Only the usual accepted
  observations/frame timestamps are stored. Validate the model on real CCTV day/night
  views; successful phone-photo checks do not establish accuracy on another camera.

## Verification

```bash
npm test
npm run build
python3 scripts/prepare-cctv-demo.py
node scripts/smoke-cctv.cjs
```

API tests cover camera permissions, credential redaction, stale frames, reconnects,
calibration changes, stopping in flight, per-camera ownership, and model queueing.
The smoke run uses real FFmpeg, the real installed model, two replay sources, and
an isolated in-memory database. It never writes into the hosted Supabase project.
Actual recorder compatibility and real RTSP feed performance remain to be tested
when the equipment/network are available.

Protocol reference: [FFmpeg RTSP documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/protocols.texi).
