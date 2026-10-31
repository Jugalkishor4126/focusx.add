# FocusX.Jugal.Add

**FocusX** is an advanced student wellbeing project with four connected features: a smart analytics dashboard, XP and badges, friend leaderboards, and an AI study coach. The ZIP includes a Chrome extension and a small Node.js backend.

## What each feature does

### A. Smart analytics dashboard

- Shows focus minutes, goal completion, sessions and streak.
- Compares the last 7 days with the previous 7 days.
- Shows weekly average, goal-hit days, the strongest focus time window and a short rule-based insight.
- Lists the most visited browser domains for today.
- Focus history and website-time totals are calculated and kept in the current Chrome profile.

The dashboard insight is calculated from the student's own saved session data; it does not send browsing history to the AI service.

### B. XP, rewards and badges

- Earn **5 XP per focused minute**.
- Earn **20 bonus XP** when a session timer completes.
- Earn **25 XP once per day** when the daily focus goal is reached.
- Every 100 XP increases the level.
- Badges include first session, one focus hour, daily goal, a 3-day streak, five focus hours and ten completed sessions.
- Early-ended sessions keep their focused minutes and XP; they do not get the completion bonus.

### C. Friends leaderboard

- Create a study group and share its six-character invite code.
- Friends join using the same backend URL and code.
- Ranking is by weekly focused minutes, with XP as a tie-breaker.
- The group server receives display name, weekly focus minutes, XP, level, streak and badge count. It does not receive website domains or task titles.
- The sample server saves group scores in `server/focusx-data.json`.

For a same-computer demo, everyone uses `http://localhost:4242`. For friends on other devices, run the server on a network they can reach and give everyone that same URL. A publicly hosted server needs HTTPS and stronger sign-in/security before real users rely on it.

### D. AI study coach

- Ask for a next-session plan, a way to reduce distractions or help reflecting on progress.
- With `OPENAI_API_KEY` configured, the Node server calls the OpenAI Responses API and returns a concise Hinglish coaching answer. The current default model is `gpt-6-astra`; change `OPENAI_MODEL` in `.env` if needed. [Official OpenAI text-generation guide](https://developers.openai.com/api/docs/guides/text)
- If no API key is configured, the coach clearly labels its response as a **demo tip**, not an AI-generated answer.
- Only the question and aggregate focus numbers are sent to the server/model. Site names and task names are excluded. The API request sets `store: false`.
- OpenAI API usage may incur charges under your API account. The key is kept in the server's `.env` file and is not included in this ZIP.

## Project layout

```text
focusx.jugal.add/
├─ extension/
│  ├─ manifest.json       Chrome Manifest V3 configuration
│  ├─ background.js       Timer, site blocking, XP, badges and local storage
│  ├─ popup.html/js       Focus timer and quick progress
│  ├─ dashboard.html/js   Analytics, rewards, groups and study coach
│  ├─ blocked.html        Focus pause screen
│  ├─ styles.css          Interface design
│  └─ README.md           Extension-only quick notes
└─ server/
   ├─ server.js           Node API for groups and AI coach
   ├─ package.json        Start command and Node requirement
   ├─ .env.example        Safe environment-variable template
   └─ .gitignore          Excludes the API key and local group database
```

### Data path in plain language

```text
Chrome popup/dashboard → extension background → browser-local history/rewards
                                          ├── group score → Node backend → JSON group file
                                          └── coach question + aggregate stats → Node backend → OpenAI API (optional)
```

The extension never stores the OpenAI key. Website blocking uses Chrome's Declarative Net Request API; active tab details use the Tabs API. Chrome will show a website-access permission prompt because automatic website timing and blocking require access to website URLs. [Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest/), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)

## Requirements

- Google Chrome with Manifest V3 extension support.
- Node.js 20 or newer for the bundled server. It uses Node's built-in HTTP server and `fetch`, so there is no `npm install` step. [Node HTTP documentation](https://nodejs.org/api/http.html)
- Internet access is only needed for real AI answers. Friend sync needs the extension to reach the backend.

## Start the backend on Windows

1. Extract the ZIP.
2. Open PowerShell in the extracted `server` folder.
3. Create a private environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

4. To enable real AI answers, open `.env` and put your key after `OPENAI_API_KEY=`. Keep the key in this server file; never paste it into extension code or share it in the ZIP. You can leave the field empty to use demo tips.
5. Start the server:

   ```powershell
   node server.js
   ```

6. Keep this terminal open. Visit `http://localhost:4242/api/health`; a JSON response with `"ok": true` means the server is up.

No key is needed for XP, analytics, or local focus sessions. The backend is needed for friend groups; a key is needed only for actual AI-generated coach answers.

## Load the Chrome extension

1. In Chrome, open `chrome://extensions`.
2. Turn **Developer mode** on.
3. Select **Load unpacked**.
4. Choose the ZIP's extracted `extension` folder—the folder where `manifest.json` is directly visible.
5. Pin FocusX from Chrome's Extensions menu, open the dashboard and leave the backend URL as `http://localhost:4242` for a same-computer demo.

## Make the demo work with friends

### On the same computer

Each person can make a Chrome profile, load the extension, and join the same group code using `http://localhost:4242`. For a hackathon presentation, separate profiles on the presenter's computer can demonstrate multiple members.

### On other computers in the same Wi-Fi network

1. Start the server on one computer. It listens on the network interface by default (`HOST=0.0.0.0`).
2. Find that computer's private IPv4 address and allow Node.js through Windows Firewall on the private network if prompted.
3. On each friend's extension dashboard, save the same backend address, for example `http://192.168.1.20:4242` (replace the example IP with the server computer's actual address).
4. One person creates a group; everyone else joins with its invite code.

Public internet deployment needs a reachable HTTPS backend and persistent storage. The included JSON-file server is a hackathon/demo service: group invite codes are not account authentication, and the server does not include production-grade login or abuse protection. Keep it on a trusted network for the demo.

## Recommended presentation flow

1. Start the Node server and show its health page.
2. In Chrome, start a short focus session with a task name.
3. Pause and resume once to show the timer and website blocking behavior.
4. Complete a 1-minute demo session; show XP gain and the first badge.
5. Open the dashboard and show the weekly chart, trend, goal days and best time window.
6. Create a study group in one Chrome profile, join from a second profile, then press **Sync now**.
7. Ask the coach for a small plan. With an API key configured it uses the AI; without one the page says **Demo tip · AI not configured**.

## Troubleshooting

- **Server offline:** keep the server terminal running and check `http://localhost:4242/api/health`.
- **Group code does not work:** confirm both extensions use the same backend URL. Check the code is six characters and uppercase/lowercase does not matter.
- **Friends cannot reach the server:** `localhost` only means the current computer. For another device, use the server computer's LAN IP and allow the private-network firewall connection.
- **Coach shows a demo tip:** set `OPENAI_API_KEY` in `server/.env`, restart `node server.js`, then refresh the dashboard. API key/account access is required for actual model answers.
- **Coach gets an API error:** confirm the key and model setting, then read the error in the coach panel. OpenAI's Responses API text generation uses `/v1/responses`; this project reads text output from response message content.
- **Website is not paused:** focus session must be running and **Pause sites during focus** must be on. Add the domain without a path, such as `youtube.com`.
- **Import fails:** select the extracted `extension` folder, not the ZIP itself.

## Important prototype limits

- Browser website timing is a proxy: it counts the active Chrome tab while a Chrome window is focused, not whether the student is looking at the screen.
- The extension does not track phone apps or other browsers.
- The leaderboard syncs when a session ends, when the dashboard syncs, or when **Sync now** is pressed. The displayed score contains aggregate totals only.
- The demo backend is intentionally small. Add proper identity/authentication, HTTPS, persistent database hosting and stricter CORS before a public launch.
