# Public hosting: Render

This folder is ready to deploy as a Node.js web service.

## What gets hosted

- `multiplayer-server.js` serves the game and the multiplayer API.
- `index.html` is the actual game.
- `/mp/state`, `/mp/presence`, `/mp/event`, and `/mp/leave` are used by Squads.
- `/healthz` is used by the hosting health check.

## Deploy steps

1. Create a GitHub repository for this `flower23` folder.
2. Push the folder to GitHub.
3. Open Render and create a new Web Service from that repository.
4. Use these settings if Render does not read `render.yaml` automatically:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
5. After deploy finishes, Render gives you a public URL like:
   `https://flower23.onrender.com`
6. Give that URL to players. Everyone opens the same URL and enters `Squads`.

## Important

Do not upload `node.exe` to GitHub or Render. The `.gitignore` keeps it local.

Local play still works with:

```bat
start-multiplayer.bat
```

Public play works from the Render URL.
