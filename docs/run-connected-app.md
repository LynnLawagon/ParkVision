# Run the connected ParkVision app

The app uses the actual S2 EfficientNetB0 export through a persistent Python
worker. Supabase is the single source of saved parking status. There is no demo
login or random status fallback.

## 1. Database credentials (one-time setup)

The schema and 15-space seed are already installed in your Supabase project.
Keep that project. **Do not rerun the initial migration or reset the database.**

Open `backend/.env` (created with placeholders) and fill in:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

Copy the project URL and keys from your Supabase project's Connect/API settings.
Use the public publishable/anon key for `SUPABASE_PUBLISHABLE_KEY`, never the
service-role key. Only the backend receives the service key. `.env` is ignored by
Git; do not put the service key into a frontend/VITE variable or paste it in chat.

The browser receives the URL and public key from `/api/config`; no separate
frontend env file is required. `npm run dev` restarts the backend when `.env`
changes; production `npm start` needs a manual restart.

## 2. Create the first administrator

In Supabase **Authentication → Users**, add an email/password user. Confirm its
email, then run this in SQL Editor using the same email:

```sql
update public.profiles
set role_code = 'parking_administrator',
    display_name = 'Parking Administrator'
where id = (select id from auth.users where email = 'you@example.com');

select id, display_name, role_code from public.profiles;
```

The trigger creates profiles automatically. New accounts start with no personnel
role. Security/parking personnel use `security_personnel` or `parking_personnel`;
they may monitor and analyze saved regions, but cannot edit calibration. Existing
prototype credentials such as `j.cruz` / `change-me` no longer apply.

## 3. Install and start

Use Node.js 22.12+ (Node 24 is installed on this Mac), and Python 3.11 for ML.

```bash
cd /Users/cyrawzzz/Documents/GitHub/ParkVision
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Open **http://localhost:5173**. The root command starts the frontend and backend.
The backend automatically starts Python and warms up the model. Open Connection
setup (the sliders icon) to check model readiness and test the database.

The trained export has been copied locally to
`ml/models/parkvision_efficientnetb0.keras` and is ignored by Git. Its backup remains
in Downloads. The Python interpreter defaults to
`~/.venvs/parkvision-ml/bin/python`, the environment already created on this Mac.
On another machine:

```bash
python3.11 -m venv ~/.venvs/parkvision-ml
source ~/.venvs/parkvision-ml/bin/activate
python -m pip install -r ml/requirements.txt
```

Set `ML_PYTHON` or `MODEL_PATH` in `.env` to use a different location.

For a production build served by the backend:

```bash
npm run build
npm start
```

Then open http://localhost:4000. Use HTTPS and an appropriate deployment setup
before exposing it outside the local development environment.

## 4. First image-to-dashboard run

1. Open **Personnel sign-in** and use your Supabase account.
2. In **Camera workspace**, select CAM-04 or add a camera for the mounted phone.
3. Upload a JPEG/PNG/WebP image. A video can also supply a reference frame.
4. Select a named space (for example A1), click **Draw parking box**, and drag
   across the entire intended parking position. Click **Save region**. The seed's
   A1/A2 boxes are examples; redraw them. Repeat for the visible spaces only.
5. Click **Analyze this frame**. This sends the image and regions to the real
   Python model. View the overlay and per-space scores.
6. Click **Publish accepted results** to write observations to Supabase. Switch
   to Availability or open the public view; its two-second polling shows updates.

An administrator can preview unsaved boxes, but publishing requires the same
geometry to be saved in Supabase. Saved regions can be redrawn or archived.
Archiving retains detection history. Regions are assigned to one camera per space;
archive the old camera's region before assigning the space to another camera.

Unconfigured/unobserved spaces remain unknown. The public screen labels missing
or older-than-10-second observations **Unverified** and excludes them from
available spaces. A single uploaded image is not a live camera feed; repeated
frames are needed to keep current counts.

Images are processed in memory. This version stores classifications/frame
timestamps, not image/video files; the reference image must be reuploaded after
reloading the workspace. Geometry is saved and reloads from Supabase. Keep camera
position, orientation, zoom, and framing fixed; recalibrate if they change.

## 5. Review threshold and the real-photo error

S2 uses threshold 0.5 to choose occupied/vacant. The app additionally defaults to
`MINIMUM_CONFIDENCE=0.80`: the predicted class score must reach 0.80 before it can
be published. Lower-scoring predictions are marked **Needs review** and skipped.
An earlier valid observation for that space remains only until it goes stale.
Scores are not independently verified accuracy, and 0.80 is a prototype review
threshold, not a measured guarantee. Do not tune it to a handful of test images.

The supplied empty night-photo crop scored approximately 0.618 occupied. The app
flags that known error for review instead of publishing it as occupied. Site
validation and potentially fine-tuning are still necessary; the threshold does
not solve transfer from PKLot to this camera.

The binary winner predicts empty/occupied only. No binary result is labeled as a
non-vehicle obstruction. The Alerts panel reads actual obstruction events already
stored in the schema; adding an obstruction-capable model is separate work.

## 6. Recorded video and device camera

Upload a supported MP4/MOV/WebM file; browser support varies by codec. Use the video
controls to select a reference frame. Define/save its regions. Click **Analyze
video replay** to analyze the playing video about every two seconds. Turn on
**Publish accepted replay observations** explicitly to update the dashboard.
Stop replay to edit camera/regions. Use H.264 MP4 if your browser cannot decode
the phone's MOV/HEVC file.

Replay observations are timestamped when analyzed and are explicitly a demo replay,
not original historical capture-time telemetry. Pausing/stopping does not keep
refreshing timestamps.

For a live source, click **Use device camera**, allow browser camera permission,
and keep the device fixed. Draw/save regions against that view, then click
**Start camera monitoring**. Turn on **Publish accepted camera observations** to
update the dashboard. **Stop monitoring** pauses analysis; **Close device camera**
also stops the media tracks. Signing out/leaving the workspace closes the camera.
No microphone is requested.

On your laptop, localhost can access its camera. For the mounted phone, the app
must be accessible at an **HTTPS address** and the Python/backend server must be
reachable through that deployment. Opening the laptop's plain HTTP LAN address
on a phone is not sufficient for camera permissions. HTTPS hosting/network setup
and validation on the actual mounted phone are still pending. See the browser
[camera-access requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Tests and boundaries

```bash
npm test
npm run build
```

API tests cover role checks, geometry validation, ownership, publication
idempotency, skipped review predictions, and invalidation after calibration
changes. A local integration test runs the saved model against the supplied night
image when both files/environment exist, and verifies the known error is flagged
for review. Tests use isolated fixtures; they do not write into the hosted project.

Database rules are documented in [database.md](database.md); transactional SQL
checks are in `supabase/tests/schema_checks.sql`. Live Supabase verification needs
your actual `.env` credentials and administrator account. Original experiment
details and export instructions remain in [ml-integration.md](ml-integration.md).
