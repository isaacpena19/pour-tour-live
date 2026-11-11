# Poor Tour — Live Scoring Website

A self-hosted, mobile-friendly 18-hole golf tournament app for two-person teams, with a public live leaderboard, player scoring, and an organizer dashboard. **No software dependencies** beyond Node.js 20+.

## Scoring format
- **Holes 1–6 (best ball):** enter both player scores; the **lower** score is counted for the team.
- **Holes 7–12 (modified alternate shot):** both players tee off, select one drive, then alternate strokes; enter one team score.
- **Holes 13–18 (scramble):** enter one team score.
- Scores are displayed as strokes relative to **par on holes played**. The leaderboard refreshes automatically across devices using server-sent events.

## Run locally

1. Install **Node.js 20 or later** (22 LTS recommended).
2. Unzip the project and open a terminal in the `poor-tour-live` folder.
3. Set two environment variables and start the server:

**macOS / Linux:**
```bash
export ADMIN_PASSWORD='replace-with-a-long-private-organizer-password'
export SESSION_SECRET='replace-with-a-random-secret-at-least-24-characters-long'
node server.js
```

**Windows PowerShell:**
```powershell
$env:ADMIN_PASSWORD='replace-with-a-long-private-organizer-password'
$env:SESSION_SECRET='replace-with-a-random-secret-at-least-24-characters-long'
node server.js
```

4. Open **http://localhost:3000**. Choose **Organizer**, sign in, configure course and hole pars, and create teams.
5. Give each team their assigned 6-digit PIN. Each team's players open **Scorecard** and sign in. They can edit only their own scores.
6. All guests can view **Leaderboard** without signing in. No accounts or app installations required.

## Run for a real event

To make the site accessible on phones away from your LAN, deploy this Node.js server to a hosting provider that supports **persistent storage**, or run it on your own server behind HTTPS. Set `ADMIN_PASSWORD` and `SESSION_SECRET` as private host environment variables. **Never publish them in your frontend code.**

On a VPS, use a reverse proxy such as Caddy or Nginx to issue HTTPS certificates and proxy port 3000. The score database is a JSON file at `data/tournament.json`, so **back it up** and attach a durable volume if deploying to a cloud host. Optional: set `PORT`, `HOST`, and `DATA_FILE` environment variables.

> **Important:** Hosts with ephemeral disks (including some free platform tiers) can lose scores on restart/deployment. Use persistent storage. This small-event implementation uses an on-disk JSON store, with atomic writes; it is intended for a single Node.js server instance, not multi-instance deployment.

## Pairings and scoring

Set the **Playing group** field identically for the two teams that share a foursome, e.g. `Group 1`. Each two-person team gets its own scoring access and independent leaderboard entry. Assign as many groups as you need.

## Organizer controls

- Edit event name, course, event date, all 18 hole pars.
- Add/edit/delete teams and assign playing groups.
- Get a unique six-digit team PIN when registering a team; reset it if lost.
- Select any team under **Edit scores** to correct hole results.
- Scores and event configuration persist when the server restarts.

## Security and limits

- Team scoring and organizer actions require signed sessions.
- PINs are not shown in public API responses and are stored as keyed SHA-256 digests; session tokens expire after 12 hours.
- Use a nontrivial organizer password; team PINs are short and must be shared privately.
- HTTPS is required for secure remote access. Use a private network for local trials if HTTPS is not available.
- Rate limiting is in-memory and basic; for internet hosting, configure an additional reverse-proxy rate limit.
- The leaderboard uses raw scores relative to par (no handicaps, skins, individual awards, or shotgun starting adjustments).
- The event is one tournament per deployed instance. For a new event, archive your `data/tournament.json` and remove it before restarting (this clears all teams/scores).

## File structure

- `server.js`: HTTP API, private team/admin authentication, persistent storage, live score broadcast.
- `public/index.html`: responsive frontend.
- `public/styles.css`: branded style.
- `public/app.js`: leaderboard, scorecard, organizer UX.
- `data/tournament.json`: created automatically when first started.
