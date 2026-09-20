# Project overview

This repository contains a browser-based multiplayer artillery game. A Node.js server uses Express to serve the static client from `public/` and Socket.IO for real-time gameplay.

## Run the project

- Use the **Start application** workflow in Replit.
- The workflow runs `npm start`.
- The web server listens on `0.0.0.0:5000` by default. Replit may override the port with the `PORT` environment variable.

## Project structure

- `server.js`: Express and Socket.IO game server
- `public/`: browser client, styles, and sound-effect logic
- `sound/`: audio assets
- `texture/`: image and source-art assets

## Dependencies

Install dependencies from `package.json` before running the project. No external services or additional secrets are currently required.