# Praimana desktop — start here

Run the Praimana desktop app from source. Works on macOS, Linux and Windows — the same source
runs everywhere; the native parts are compiled on your machine the first time you start it.

## What you need first

- **Node.js 22 or newer** — https://nodejs.org (the installer includes everything else needed).
- About 5 minutes for the first run (it downloads and compiles dependencies). Later runs are quick.

You do **not** need to install anything else — not pnpm, not a build toolchain. The start script
handles it.

## Steps

1. **Download and extract** the desktop source zip. You now have a folder with `start.sh`,
   `start.bat` and this file in it.

2. **Download `connect.json`** from your portal and **place it inside this folder**, right next to
   `start.sh`. This file tells the app which experience to connect to. (It contains no password or
   token — only your portal address, API address and public Cognito ids.)

3. **Open a terminal / command prompt, go to this folder, and run the start script:**

   - **macOS / Linux:**
     ```bash
     cd /path/to/this/folder
     ./start.sh
     ```
     If you get a "permission denied", run `chmod +x start.sh` once, then `./start.sh` again.

   - **Windows:**
     ```bat
     cd C:\path\to\this\folder
     start.bat
     ```

The first run installs dependencies and builds the app, then launches it. When it opens, it shows
a **Connect** screen pre-filled from your `connect.json` — review the portal/API address, click
**Connect**, then sign in with your invited email.

## If you did not get a connect.json

You can still run `./start.sh` (or `start.bat`) — the app opens normally. Then use **"Sign in to
another experience"** inside the app and paste the connect link your facilitator gave you.

## `connect.json` format

All four values come from your portal; none is secret.

```json
{
  "portalUrl":  "https://<your-portal-host>",
  "apiBaseUrl": "https://<your-api-host>",
  "poolId":     "<cognito-user-pool-id>",
  "clientId":   "<cognito-app-client-id>"
}
```

## Troubleshooting

- **"Node 22 or newer is required"** — install the latest Node LTS from https://nodejs.org and
  re-run.
- **The first run is slow or seems stuck** — it is compiling native modules; give it a few minutes.
- **"connect.json is not valid JSON"** — re-download it from the portal; make sure it was not opened
  and re-saved by a text editor that changed the quotes.
- **It opened but says it cannot reach the server** — check the portal/API addresses on the Connect
  screen match what your facilitator gave you.
