# Pages

The app has seven places:

- `Today`: the day as a timeline. Classes, gym and meals are fixed blocks; tasks are slotted around them and can be dragged to a new time. Unfinished work from earlier days lands in a **Carried over** tray where you can spread it across the week, push it to next week, mark it done or skip it. Spreading keeps ordered sets in order (behavioral and Hello Interview lessons, numbered series, repairs per project, each week's study and build pairs, and `AN-` backlog tickets), moving later steps back when it has to and leaving pinned or in-focus tasks alone. `AN-` tickets get the first available room, and when the week has none they push Build and Review work later. Job search, coursework and paid work keep their time. The rail shows what's next, the week's outcome and checkpoint, Spotify, and your NeetCode review queue.
- `Focus`: pick a task and lock in. The window goes fullscreen and stays on top over an animated scene (Aurora, Night sky, Rain on glass, Deep ocean, Dusk, Cherry blossom, Summer evening, Falling leaves, Christmas lights) or your own image or video wallpaper, with a countdown, Pomodoro or stopwatch timer, the task's plan and resources, a notes pad, ambient noise and Spotify controls. The speaker button in the Spotify dock moves playback to another Spotify Connect device: this computer, your phone, a speaker. Switching between headphones and speakers on one computer is still done in Windows or macOS sound settings, because Spotify doesn't let other apps change that. While agents are running, the top bar shows how many need you, are working or are queued; click it for the list. Hold `Esc` for two seconds to leave early; early exits and their reason are logged on the session, and focused time is credited to the task. On Windows with more than one monitor, the other windows on Jarvis's monitor move to your other monitor while you focus, so apps like Spotify stay usable, and go back where they were when you leave. Windows you close or move yourself in the meantime are left alone. Apps you open, or bring back from the taskbar, while you focus are moved over within a couple of seconds and stay on the other monitor afterwards. Turn it off in **Settings → Focus**.
- `Roadmap`: all 34 weeks on a phase timeline, a drag-and-drop week board with daily capacity, the portfolio repair track (98 audit items across 40 sessions), the Hello Interview and behavioral library, the NeetCode log, and search across every task.
- `Jobs`: every application from applied to offer, filled in from your job Gmail and the “I applied” bookmark (see [Jobs](jobs.md)).
- `Agents`: your coding-agent runs in a sidebar, each opening into its conversation, changes and logs, plus the task board and every other Claude Code and Codex session on this computer (see [Agents hub](agents.md)).
- `Music`: listening stats, a stats view for any artist, and auto-updating Spotify playlists (see [Music](music.md)).
- `Projects`: your repos with branch, last commit, CI and PR state, and Open in VS Code. Checking every repo takes a few seconds, so after the first visit the page opens on the last check (it says how long ago) and rechecks in the background once that's a minute old. **Check again** waits for a fresh one. **Ask an agent** on a card opens the Agents composer for that repo in Plan first mode; when the card shows a failing CI run, changes requested on its pull request or Dependabot alerts, the prompt already lists them with links.

`Ctrl+K` opens the command palette: jump to any week, find any task, start focus on it (`Ctrl+Enter`), or run commands. `Alt+1`…`Alt+7` switch pages.

The look comes from the tokens in `public/app/theme.css`, in dark (the default) and light:
- **Sky blue** marks what you can act on: buttons, links, focus, progress.
- **Orange** marks what is live or waiting on you: the current block, this week, agents that need you.
- **Green, yellow and red** keep their status meanings.
- **Type** is Geist and Geist Mono, served from `public/fonts/` (SIL Open Font License) so the desktop app works offline.

Drop focus wallpapers (`.jpg`, `.png`, `.webp`, `.gif`, `.mp4`, `.webm`) into the `wallpapers/` folder of the workspace, or use **Settings → Open wallpapers folder**.

On Windows, the background menu also lists the **video** wallpapers from your Wallpaper Engine library, read straight out of Steam's Workshop folder, so nothing is copied or synced. Wallpaper Engine's own *scene* and *web* wallpapers (Fall, Christmas and the like) only render inside that app, so they can't be listed; the menu says how many were skipped. For anything it can't reach — a mountain clip, say — drop the file in the wallpapers folder.

## Career Roadmap

The plan lives in [`data/plan/roadmap-plan.v1.json`](../data/plan/roadmap-plan.v1.json): 34 weekly modules (goal, checkpoint, study and build tasks), the Hello Interview and behavioral library, the recurring-task templates, and the 98-item portfolio audit with its 40 repair sessions. It was imported from the hosted roadmap site, which this app replaces. `server/plan/` generates the 1,010 dated tasks from that file and your schedule settings, then lays out each day around classes, the gym cycle and meals. `tests/plan-generator.test.js` checks the generator against a snapshot of the site's own output.

Your progress is stored in `runtime-state.local.json` under `plan`. It holds only what changed (done, moved, notes, focus time, custom tasks, settings), so the plan file can be updated without losing it. Site progress was imported from `data/plan-site-import.local.json`; local changes always win over a re-import.



