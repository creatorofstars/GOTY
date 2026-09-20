# 🚀 Deploying the game (Render)

The game runs on any Node.js host. This repo ships with `render.yaml`, so Render
can set everything up automatically — build command, start command, region and
Node version are all preconfigured.

## One-time setup (about 5 minutes)

1. Go to <https://dashboard.render.com> and sign in with **GitHub**.
2. If this is your first time, GitHub will ask to install the **Render** app —
   grant it access to the `GOTY` repository (or to all repositories).
   *Can't see the repo in the list? You don't have admin on it — fork it to your
   own account first (Fork button on the repo page), then grant Render access to
   your fork and deploy that instead.*
3. Click **New + → Blueprint**.
4. Select the `GOTY` repository. Render reads `render.yaml` and fills in
   everything: build `npm install`, start `node server.js`, region Singapore
   (closest to our players), Node 22.
5. Click **Apply**. Wait for the first build to finish (~2 minutes).
6. Your game is live at a URL like `https://goty-the-last-star.onrender.com`.
   Share that link — everyone plays in the browser, nothing to install.

## Good to know

- **Auto-deploy is on**: every push/merge to `main` on GitHub goes live
  automatically in a couple of minutes. No manual sync steps, ever.
- **Free tier sleep**: after 15 minutes with no players, the server sleeps.
  The first person to open the link waits ~50 seconds while it wakes up.
  After that it's normal speed until it sleeps again.
- **Region**: `render.yaml` picks Singapore (lowest delay for our area).
  You can change it in the Render dashboard → Settings → Region.
- To point teammates at the new server, just share the URL — the old Replit
  link keeps working independently if Student A keeps it running.

## Local test before deploying

```bash
npm install
node server.js
# open http://localhost:5000
```
