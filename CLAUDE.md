# BeanHunt Backend — Claude Code Context

## What This Is
Node.js/Express backend for BeanHunt — a community/VIP slot bonus hunt tracker. Handles Discord OAuth, hunt state, real-time Socket.IO events, slot autocomplete, and file-based persistence. Deployed on Railway.

## Live URLs
- Backend: https://beanhunt-backend-production.up.railway.app
- Frontend: https://twitchbean-hunt.vercel.app
- Backend repo: https://github.com/RandyCabbages/beanhunt-backend
- Frontend repo: https://github.com/RandyCabbages/beanhunt-frontend
- Railway Project ID: `21885da4-a512-4d3c-b3ff-9d499cb82d4a`

## Local Paths
- Backend: `C:\Users\kylew\beanhunt-backend`
- Frontend: `C:\Users\kylew\beanhunt-frontend`

## ⚠️ ALWAYS PULL BEFORE EDITING
The VIP fix was committed directly on GitHub. Local clone may be behind.
```bash
cd C:\Users\kylew\beanhunt-backend
git pull origin main
```

## Deploy Workflow
```bash
git pull origin main
git add server.js
git commit -m "message"
git push origin main
# Railway auto-deploys (~1-3 min)
# WARNING: deploy restarts server → clears in-memory sessions → everyone gets logged out
```

## Project Structure
```
server.js        ← entire backend (Express + Passport + Socket.IO)
package.json
.env             ← secrets (never commit)
hunts_data.json  ← file-based hunt persistence (auto-generated, don't commit)
```

## Auth System
- Discord OAuth via Passport.js
- Sessions are **in-memory** (lost on restart/deploy)
- `displayName` set from `profile.global_name || profile.username` at OAuth time

## VIP / Admin Logic (CRITICAL — DO NOT BREAK)
```javascript
// Admin by Discord ID (permanent, immune to display name changes)
const ADMIN_IDS = (process.env.ADMIN_IDS || '135203806676779008')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(user) {
  return user
    ? (ADMINS.includes(nameOf(user)) || ADMIN_IDS.includes(String(user.id)))
    : false;
}
```
- Owner Discord ID: `135203806676779008` — hardcoded as default in `ADMIN_IDS`
- VIP gates throughout code use pattern: `isAdmin(req.user) || VIP_HOSTS.includes(nameOf(req.user))`
- Because `isAdmin` is checked first, owner gets VIP everywhere automatically
- To add more admins: set `ADMIN_IDS` env var in Railway with comma-separated Discord IDs
- **Never gate access on display name** — it can change and locks people out (this happened)

## Key API Endpoints
```
GET  /api/slots              → 5000+ slot names array (frontend caches on mount)
GET  /api/slots/search?q=    → autocomplete search (hits slot.report API, cached 1hr)
GET  /auth/me                → current user + isAdmin/isVipHost flags
GET  /auth/discord           → start Discord OAuth
POST /api/my-hunt/start      → VIP-gated hunt creation
GET  /api/health             → health check
```

## Slot Autocomplete
```javascript
// Fetches from slot.report API, caches for 1 hour
let slotCache = { games: [], fetchedAt: 0 };
async function getSlotGames() { ... }
// Pre-fetched on startup
getSlotGames().catch(() => {});
```
- Returns: `{ name, slug, provider, thumb }` objects
- Thumb URL pattern: `https://usercontent.cc/images/games/{provider_slug}/{slug}.webp`

## Hunt Persistence
- Hunts stored in `hunts_data.json` via `fs.writeFileSync`
- Survives server restarts on Railway
- `fs` and `path` requires must be at the TOP of the file (before usage)

## Railway Environment Variables
```
ADMIN_IDS=135203806676779008        # Discord IDs for admin/VIP access
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
SESSION_SECRET=...
```

## Owner Info
- Discord ID: `135203806676779008` (permanent)
- Discord username: `randycabbage_`
- Display name: `Cabbage` (changeable — never use for auth)

## Pending Items
- [ ] Sync local clone: `git pull origin main` (may be behind)
- [ ] Held base-games vault feature (frontend pending too)
- [ ] Community Hunt punt calculator (frontend feature)
