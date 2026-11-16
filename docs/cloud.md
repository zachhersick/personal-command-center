# Phone, web and cloud sync

## Phone and web

[jarvis.example.com](https://jarvis.example.com) is the same interface running against a cloud copy of your plan, so it works with every computer off. Sign in with GitHub; only the account in `ALLOWED_GITHUB_ID` gets in. On the phone you get Today (check off, move and open tasks), Focus (timer, notes, keeps the screen on, an **Open Spotify** link), the Roadmap with the NeetCode log, the Jobs pipeline (log, move and annotate applications), Music (stats, and creating and editing synced playlists), and a read-only Agents board from your desktops. Projects, starting agents, hooks, wallpapers, Spotify control and updates stay on the desktop.

**On the iPhone:** open the site in Safari, sign in, then **Share → Add to Home Screen**. It opens full screen like an app, and the last plan it loaded stays readable offline (changes need a connection).

**Connecting a desktop:** on the website, **Settings → Devices → Connect a desktop** shows a token once. In Jarvis on that computer, **Settings → Cloud sync**, paste it and **Connect**. Each desktop then syncs the plan every minute and two seconds after any change, merging record by record (newest edit wins, deletions included), and pushes its agents board every 30 seconds while it changes. The board sends session titles, repo, branch, status and the latest message preview; full transcripts never leave the computer. Revoke a desktop from the same Devices list. The token is stored hashed in the cloud and in `config/cloud-sync.local.json` on the desktop.

### Hosting it

The site is a separate Vercel project built from this repo (`vercel.json`): `scripts/build-web.mjs` copies `public/` and the vendored Preact files into `web-dist/`, and every `/api/*` request goes to the single function `api/index.js` (`server/cloud/`). The roadmap file is bundled into the function and never served as a static file. Storage is Neon Postgres; the tables are created on first use.

One-time setup:

1. In Vercel, **Add New → Project**, import `zachhersick/jarvis` (name it `jarvis-web`; framework preset *Other*; the build settings come from `vercel.json`). Add the domain `jarvis.example.com`.
2. **Storage → Marketplace → Neon** on that project. This sets `DATABASE_URL`.
3. Create a GitHub OAuth app (GitHub **Settings → Developer settings → OAuth Apps**) with homepage `https://jarvis.example.com` and callback `https://jarvis.example.com/api/auth/callback`.
4. Add these environment variables in Vercel, then redeploy:

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://jarvis.example.com` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from the OAuth app |
| `ALLOWED_GITHUB_ID` | your numeric GitHub id (`gh api user --jq .id`) |
| `SESSION_SECRET` | 32+ random characters (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) |
| `TIME_ZONE` | `America/Los_Angeles` (the zone your days are planned in; this is the default) |

Sessions last 30 days in an HttpOnly cookie. Every write needs the session cookie, a JSON body and an `Origin` matching `APP_URL`; desktops use their bearer token on `POST /api/sync` only.

To try it locally, run `npm run build:web` and `npm run cloud:dev`, then open `http://localhost:4320`. It uses an in-memory store (or `DATABASE_URL` if set) and **Sign in** skips GitHub and signs you straight in.
