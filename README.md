# ParkVision

Parking occupancy monitoring for Luzano Compound using administrator-defined
virtual spaces and the trained S2 EfficientNetB0 model.

The local software now connects React, Supabase Auth/database, Express, and a
persistent Python inference worker. There is no random parking-data fallback.

## First setup

Your existing Supabase schema and 12–15-space layout can be kept. Fill the three
Supabase values in **`backend/.env`**, then create your first administrator in
Supabase Auth and assign its profile the `parking_administrator` role.

See **[Run the connected app](docs/run-connected-app.md)** for the exact steps,
administrator SQL, and the complete first image-to-dashboard walkthrough.

## Run locally

Requires Node.js 22.12+ and Python 3.11 with the ML dependencies. The existing
Python environment on this Mac is `~/.venvs/parkvision-ml`.

```bash
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Open **http://localhost:5173**. The backend runs on port 4000 and starts the model
worker automatically. The Connection setup page reports missing configuration
and model errors instead of displaying fabricated results.

The model is read from `ml/models/parkvision_efficientnetb0.keras`, or the
`MODEL_PATH` environment variable. Model binaries, `.env` files, generated builds,
and installed dependencies are ignored by Git. Keep your model export backed up.

## What works

- Public parking availability read from Supabase, refreshed every two seconds.
- Missing/stale observations marked Unverified and excluded from available counts.
- Email/password Supabase sign-in; profile-based personnel and administrator access.
- Camera selection/creation and a reference-image or video-frame workspace.
- Draw, redraw, save, and archive normalized parking regions in Supabase.
- Actual batched EfficientNet inference on the selected crops, with RGB 224×224
  preprocessing matching S2 and model loading only once per backend process.
- Per-space model scores, low-score review handling, and explicit publication to
  `camera_frames` / `space_observations`.
- Recorded-video replay with optional automatic publication of accepted results.
- Device-camera capture and monitoring, with explicit browser permission and
  optional publication. A phone needs the app served over HTTPS.
- Existing obstruction-event acknowledgements and administrator region history.

Images/video files stay local to the workspace and are not stored in Supabase by
this version. Reupload a reference after a page reload; saved geometry persists.
Camera framing must remain fixed for that geometry.

## Remaining project work

- Add your real Supabase credentials and administrator account to verify the hosted
  connection. No credentials are committed to the repository.
- Calibrate the real 12–15 positions from the mounted-phone view and validate on
  representative daytime/nighttime data. The seed's two rectangles are samples.
- Address the real-photo empty-space misclassification through site evaluation and
  potentially fine-tuning; the review threshold is not a measured accuracy guarantee.
- Add non-vehicle obstruction recognition. The current S2 winner is binary and
  cannot fulfill the original three-class requirement by itself.
- Set up HTTPS hosting/access for the mounted phone and test its live capture.
  Uploaded media and browser camera capture use the same inference pipeline.

## Verification and production build

```bash
npm test
npm run build
npm start
```

The built app is served at http://localhost:4000. API tests run with isolated
database/auth fixtures; an additional test uses the actual model and supplied night
photo when available. Tests never write into the hosted Supabase project.

## Project layout

```text
frontend/              React + Vite interface and Supabase client
backend/               Express auth, API, publication, and worker bridge
ml/worker.py           TensorFlow/Keras inference process
ml/models/             Local trained model (binary ignored by Git)
supabase/migrations/   Original normalized schema and access controls
supabase/seed.sql      Rerunnable 12–15-space Luzano layout
supabase/tests/        Transactional SQL checks
docs/                  Setup, ERD, and ML integration documentation
```

Database design: [Normalized ERD and access rules](docs/database.md).
Experiment/export background: [ML integration](docs/ml-integration.md).
Train the replacement binary classifier: [EfficientNetB0 Colab notebook and steps](notebooks/README.md).
