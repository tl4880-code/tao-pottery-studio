# 陶 TAO — Digital Pottery Studio

A small two-student web project: shape a 3D vessel, choose a glaze, watch a short firing animation, then name and save the piece to a shared gallery. The interface is in English, with the original 陶 TAO logo.

## Run locally

Use Node.js 20 or later. From this folder:

```bash
npm install
npm start
```

Open [http://localhost:3210](http://localhost:3210). Keep the server running while using the studio.

```bash
npm run dev   # Restart the server when its source changes
npm test      # Run the server tests
```

To choose a different port or storage file:

```bash
PORT=4000 DATA_FILE=./data/pots.json npm start
```

## Make a piece

1. Drag the vessel with a mouse or touch to change its shape. Use the height slider to make it taller or shorter.
2. Choose **Celadon**, **Ivory**, or **Ink**.
3. Run the short firing animation, then give the piece a name and save it.
4. Open the gallery to see saved pieces. Refresh the gallery to load other visitors' additions.

Keyboard controls provide sliders for adjusting the shape without dragging; use Tab to reach a control and arrow keys to adjust it. The current draft is kept in the browser's local storage. Saving a finished piece sends it to the shared server.

The vessel uses 48 radius values and Three.js lathe geometry. Firing is a visual simulation, not a physical kiln model.

## Sending and receiving data

| Request | Purpose | Response |
| --- | --- | --- |
| `POST /api/pots` | Save the name, author, shape, height, glaze, and PNG preview | `201` with `{ "pot": ... }` |
| `GET /api/pots` | Load the shared gallery | `{ "pots": [...] }`, newest first |
| `GET /api/health` | Check the server | `{ "ok": true }` |

Express validates incoming pieces, adds an ID and timestamp, and writes them through lowdb. The gallery uses `fetch` to receive saved pieces and display them. Visitors connected to the same server share the collection; updates appear after refreshing it, without WebSockets.

For a class demonstration, save a piece in one browser window, then load the gallery in a second window connected to the same server. The new piece should appear there too.

## Suggested two-person split

- **Student 1:** Three.js vessel, shape controls, glazes, firing animation, and page layout.
- **Student 2:** Express routes, lowdb storage, validation, gallery loading and saving, and server tests.

This is a suggested division of work, not a record of who implemented each part. Both students can test the complete flow together.

## Files and stack

- `public/`: HTML, CSS, and browser interaction code.
- `server.js`: Express 5 routes, validation, and lowdb 7 persistence.
- `test/server.test.js`: Tests for saving, restart persistence, validation, concurrent writes, and the gallery limit.
- `data/pots.json`: Automatically created storage file; keeps the newest 500 pieces.
- `package.json`: Node.js scripts and dependencies, including locally served Three.js.

## Deployment

Deploy to a Node.js host with a persistent disk. Set `PORT` as required by the host and point `DATA_FILE` to the persistent location; it defaults to `data/pots.json` in this project. Run one server process with this JSON store; multiple instances need a shared database. A local preview is not automatically public, and a `localhost` link will not give someone on another computer access to this server.

For Railway, deploy this repository with its included `railway.json`. Attach a volume to the app service at `/data`, set `DATA_FILE=/data/pots.json`, and generate a public domain under Settings → Networking. The configuration starts the app with `npm start` and checks `/api/health`. No separate build command is needed.
