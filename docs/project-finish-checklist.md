# Finish the ParkVision prototype

CCTV integration is deferred. The core demonstration can use an uploaded recording or the existing device-camera workflow. A photo is a point-in-time check, not continuous monitoring.

## Completed locally

- Three-class EfficientNetB0 is installed: `ParkVision_EfficientNetB0_ThreeClass`, checksum prefix `833041baa7fe`. The app reports vacant, vehicle-occupied, and non-vehicle-blocked results from the existing saved boxes.
- Matching model/metadata validation, real-photo/object sanity checks, and backend/worker checks passed. These do not establish independent site accuracy.
- Workspace cleanup distinguishes source type, monitoring, preview and publication. Model diagnostics are expandable; the main table focuses on the decision and class score.
- New reference frames invalidate old previews. Pausing/stopping a replay suppresses pending automatic publications, and a stopped run cannot interfere with a replacement run.
- New publications require a frame less than ten seconds old and an active camera. Retries return an existing saved publication without refreshing its timestamp. The public screen expires stale/invalid observations on its own clock, even when polling fails.
- Cameras with saved boxes are preferred on initial load. Space selection preserves the current preview. Routine auth token refresh preserves the active workspace while rechecking the profile; sign-out/account changes still close it.

The checks below remain to be recorded with actual outcomes.

## Complete the app demonstration now

- Verify clear/vehicle/cone/box inputs through analyze → publish → Availability → Alerts. A blocked space must never be available. Confirm acknowledgement, resolution after a new accepted nonblocked observation, and a new event when blocking recurs. SQL checks for this lifecycle are in `supabase/tests/schema_checks.sql` and roll back fixture data.
- Use a video with changing states to check repeated analysis and dashboard updates; label it a replay demo. Keep Camera workspace open and use the provided link to open availability in another tab. Stop analysis and verify that observations become unverified after ten seconds. Test sign-out, unapproved accounts and administrator-only region editing. Preview alone must not write observations.
- Run at least a one-hour continuous replay/device-camera session. Record crashes, stopped playback, missed updates, server errors, and recovery after network interruption. Measure processing-to-dashboard and processing-to-alert latency; the requirements target five seconds. A two-second polling interval alone is not a measured latency result.
- Check the presentation wording against capability: model scores are not measured accuracy; review results remain unpublished; no automatic parking-space discovery or physical-clearance guarantee; CCTV is a future feature.

## At the actual location later

- Fix camera position/zoom/orientation and define the real 12–15 usable positions. Save only visible regions on each camera. If a single view cannot see all positions, additional fixed views are needed; unseen positions stay unknown.
- Collect labeled fixed-box crops in independent day/night sessions with clear, vehicle, cone and box cases. Include difficult lighting and objects outside the parking footprint. Keep sessions separate between training, validation and final testing.
- Evaluate new weights using a new independent site holdout. Report overall and each class's precision/recall/F1/support, confusion matrix and review coverage. The requirements' ≥90% classification target must be measured; public-data scores or two successful photos do not establish it.
- Test update continuity (no missing update exceeding ten seconds), one-hour reliability, ≥95% availability over the test period, and user tasks with the intended personnel/customer roles (target ≥80% successful completion). Preserve actual observations and test procedures for the report.

## Future feature: CCTV

Keep `ENABLE_CCTV` unset or `false` in `backend/.env` for this phase. This hides the CCTV panel and prevents configured CCTV sources from loading at server startup. Existing CCTV code remains available for later work. When revisiting it, follow [cctv.md](cctv.md), enable the flag, and verify local recorder reachability and credentials before streaming.

Payments, reservations, plate recognition and facial recognition are outside the stated project scope.

Source: local `ParkVision_Requirements_Gathering.pdf`; these are completion checks, not claims that acceptance targets have passed.
