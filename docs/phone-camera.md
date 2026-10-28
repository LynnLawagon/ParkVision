# Use the mounted phone as the camera

The phone opens ParkVision in its browser, captures frames, and sends them to the
Python model on the laptop. Supabase receives accepted observations. The laptop
and phone both need internet; a temporary HTTPS tunnel connects them.

## Start the phone link on this Mac

Cloudflared is installed. From the project folder:

```bash
npm run build
```

Keep the existing `npm run dev` backend running. Alternatively, start `npm start`
in a separate terminal after building. Use one backend on port 4000. Then run:

```bash
npm run phone
```

This checks that the built app, model, and database configuration are ready,
then prints a `https://....trycloudflare.com` link. Both the built frontend and
API use that same address. It does not expose the Vite development server.
After frontend edits, run `npm run build` again to update the phone version.

Keep the backend, tunnel terminal, and laptop running. Stop the tunnel with
**Ctrl+C** in its terminal. A restart produces a new link. This is temporary test
access, not permanent hosting. Anyone with the link can open the public dashboard;
inference and configuration still require your Supabase personnel/admin sign-in.

On a new Mac, install the tunnel tool first with `brew install cloudflared`.
If your backend uses another port, use `PHONE_PORT=4001 npm run phone`.

## On the phone

1. Open the printed HTTPS link directly in Safari or Chrome.
2. Choose **Personnel sign-in** and use your existing ParkVision email/password.
   The phone needs its own sign-in; the laptop session is not copied to it.
3. Open **Camera workspace**, select the camera, then tap **Use device camera**.
4. Allow camera permission. You should see the phone's camera view.
5. Keep the phone fixed. Use **Grab camera frame** for calibration. Create/save
   parking boxes against this view; old laptop-photo boxes will not match a new
   phone view. Use your administrator account to edit boxes.
6. Enable **Publish accepted camera observations to the dashboard** before
   starting, then tap **Start camera monitoring**. Analysis repeats after each
   request plus a two-second wait. Accepted predictions update Supabase.
7. Leave this workspace visible and keep the phone awake. On the laptop, open
   Availability in a different tab and watch updates. Leaving the workspace,
   signing out, closing the browser, or losing the connection stops monitoring.

You can test the link and camera permission away from the parking area. A room
view confirms connectivity; it cannot validate parking occupancy. Recalibrate
against the final mounted view when you get to the site. Each visible position
needs its own fixed region, with enough room for the vehicle and minimal unrelated
background. Keep the same box when the vehicle leaves.

## If it does not work

- **Link stopped opening:** keep the laptop awake, confirm the backend is running,
  restart `npm run phone`, and open its new link.
- **Sign-in error:** use the app's Supabase Auth user, not your Supabase dashboard
  login. Your profile needs a personnel/admin role.
- **Camera denied:** allow this site's camera access in the browser settings and
  reload the page. Open the link directly in the browser instead of an embedded
  messenger preview.
- **Camera opens but monitoring is disabled:** wait for the reference frame and
  save at least one region; finish or cancel any draft rectangle.
- **Results need review:** publication uses the existing 80% class-score filter.
  A review prediction is skipped; it does not become a verified vacant space.
- **Dashboard becomes Unverified:** check that publishing is enabled and that the
  phone workspace remains open. Observations become stale after ten seconds.

Cloudflare's [Quick Tunnel guide](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
documents temporary link behavior. Browser camera access requires a secure context
and permission: [MDN camera access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security).
