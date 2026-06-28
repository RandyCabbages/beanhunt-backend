# Local Backend Dev Setup

How to run the backend on your own machine, log in with Discord, and get **full admin access** to all hunt options — without touching the production database.

Written for Claude Code desktop (no IDE needed). Tell Claude "follow docs/local-dev-setup.md" or just do the steps yourself in a terminal.

---

## Why bother

Running locally lets you test hunt features safely. **No `DATABASE_URL` locally = zero writes to the real DB.** Your test hunts save to local files only (`hunts_data.json`), so you can't break production.

---

## One-time setup

### 1. Make a local `.env`

In `communityhunts-backend/`, create a file named `.env` (it's gitignored — never committed). Minimum contents:

```
DISCORD_CLIENT_ID=<the local OAuth app client id>
DISCORD_CLIENT_SECRET=<the local OAuth app secret>
DISCORD_CALLBACK_URL=http://localhost:3001/auth/discord/callback
SESSION_SECRET=local_dummy_session_secret_not_for_prod
FRONTEND_URL=http://localhost:3000
PORT=3001

# Your Discord ID as admin → full access everywhere (admin is checked first at every gate)
ADMIN_IDS=<your-discord-id>
VIP_IDS=<your-discord-id>
```

- **Your Discord ID** (not your name): Discord → Settings → Advanced → turn on Developer Mode → right-click your name → Copy User ID. It's a long number like `135203806676779008`.
- Cabbage's ID `135203806676779008` is the hardcoded platform owner, so he actually gets admin **even without** `ADMIN_IDS` — but listing it is harmless and makes intent clear.
- **Do NOT add `DATABASE_URL`.** Leaving it out is what keeps you sandboxed off prod.

### 2. Make sure dotenv loads

The backend doesn't load `.env` on its own — the `dev` script does it. Confirm `package.json` has:

```json
"dev": "nodemon -r dotenv/config server.js"
```

If yours still says just `"nodemon server.js"`, change it to the line above. Without `-r dotenv/config`, your `.env` is ignored and you get no roles.

### 3. Stop the nodemon restart loop

The app writes data files (`hunts_data.json`, etc.) into the folder while running. If nodemon watches those, it restarts forever. A `nodemon.json` in `communityhunts-backend/` fixes it:

```json
{
  "watch": ["server.js", "routes", "lib"],
  "ext": "js",
  "ignore": ["hunts_data.json", "hunts_archive.json", "share_tokens.json", "*_slots.json", "*_hits.json", "node_modules"]
}
```

This watches only source code, so saving a hunt no longer triggers a restart.

---

## Daily use

From inside `communityhunts-backend/`:

```
npm run dev
```

You should see `✅ Server on port 3001` and these (all expected with no DB):

```
[pg] No DATABASE_URL — sessions and settings will be in-memory only
[tenants] no DB — using in-memory Bean only
[admins] no DB — UI-managed platform admins disabled
[memberships] no DB — community membership disabled
```

Then start the frontend (separate terminal, in `communityhunts-frontend/`):

```
npm start
```

Open http://localhost:3000, log in with Discord → you'll have all hunt options.

---

## How the roles actually work (so you know what to expect)

Two **separate** systems:

1. **Admin / VIP host** — gated on your Discord **ID** via `ADMIN_IDS` / `VIP_IDS` (+ hardcoded owner + DB admins). This is what unlocks all hunt options. Picks up on server restart, **no re-login needed**.
2. **Discord guild badges** (`isDiscordVip` / `isDiscordMod` / `isAffiliate`) — fetched from the Discord server at login, needs `DISCORD_GUILD_ID` + the role IDs in `.env`. Optional; admin already covers hunt options. To test these you must fill those vars **and log out → back in**.

Gating is **always on Discord ID, never display name** — names change and have locked people out before. Don't "fix" anything by checking names.

---

## Gotchas

- **No roles after login?** `.env` isn't loading. Check the `dev` script has `-r dotenv/config`, and that your ID is in `ADMIN_IDS`.
- **Terminal restart-spamming?** The `nodemon.json` above is missing or not in `communityhunts-backend/`.
- **Sessions reset every restart.** Normal — no DB means in-memory sessions. Just log in again.
- **Want to mirror prod data?** Add `DATABASE_URL`. ⚠️ Then your local test hunts write to the real shared DB. Only do this deliberately.
