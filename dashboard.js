const DEFAULT_SETTINGS = {
  dailyGoalMinutes: 60,
  blockDuringFocus: true,
  blockedSites: ["youtube.com", "instagram.com", "tiktok.com"],
  apiBaseUrl: "http://localhost:4242"
};

const BADGES = [
  { id: "first-session", icon: "🌱", title: "First Step", detail: "Finish your first focus session." },
  { id: "focus-hour", icon: "⏳", title: "Focus Hour", detail: "Reach 60 lifetime focus minutes." },
  { id: "goal-getter", icon: "🎯", title: "Goal Getter", detail: "Reach a daily focus goal." },
  { id: "three-day-streak", icon: "🔥", title: "Three in a Row", detail: "Reach your goal 3 days in a row." },
  { id: "focus-five-hours", icon: "📚", title: "Deep Worker", detail: "Reach 5 lifetime focus hours." },
  { id: "ten-sessions", icon: "🏅", title: "Ten Sessions", detail: "Finish 10 focus sessions." }
];

const goalInput = document.getElementById("goalInput");
const siteInput = document.getElementById("siteInput");
const siteMessage = document.getElementById("siteMessage");
const dashboardMessage = document.getElementById("dashboardMessage");
const groupMessage = document.getElementById("groupMessage");
let lastGroupSyncAt = 0;
let groupSyncInFlight = false;

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAtOffset(offset) {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return date;
}

function formatDuration(seconds) {
  const minutes = Math.floor((Number(seconds) || 0) / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function normaliseDomain(value) {
  let domain = String(value || "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0];
  domain = domain.replace(/^www\./, "").replace(/\.$/, "");
  if (!domain || domain.length > 253) return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return domain;
}

async function getData() {
  const data = await chrome.storage.local.get(["settings", "dailyStats", "siteUsage", "sessions", "activeSession", "profile", "group"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    dailyStats: data.dailyStats || {},
    siteUsage: data.siteUsage || {},
    sessions: data.sessions || [],
    activeSession: data.activeSession || null,
    profile: data.profile || { clientId: "", totalXp: 0, lifetimeFocusSeconds: 0, totalCompletedSessions: 0, badges: [] },
    group: data.group || null
  };
}

async function getLiveState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "Could not load progress.");
  return response.state;
}

function getApiBase(settings) {
  return String(settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).trim().replace(/\/+$/, "");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Server returned HTTP ${response.status}.`);
  return payload;
}

function renderSiteUsage(siteUsage) {
  const list = document.getElementById("siteUsageList");
  const empty = document.getElementById("emptyUsage");
  list.replaceChildren();
  const entries = Object.entries(siteUsage[localDayKey()] || {})
    .filter(([, seconds]) => Number(seconds) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  empty.hidden = entries.length > 0;
  for (const [domain, seconds] of entries) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const label = document.createElement("span");
    label.className = "usage-domain";
    label.textContent = domain;
    const time = document.createElement("strong");
    time.textContent = formatDuration(seconds);
    row.append(label, time);
    list.append(row);
  }
}

function renderBlockedSites(settings) {
  const list = document.getElementById("blockedSitesList");
  list.replaceChildren();
  const sites = Array.isArray(settings.blockedSites) ? settings.blockedSites : [];
  document.getElementById("siteCount").textContent = String(sites.length);
  document.getElementById("blockToggle").checked = settings.blockDuringFocus !== false;
  for (const site of sites) {
    const item = document.createElement("li");
    item.className = "blocked-site-item";
    const label = document.createElement("span");
    label.textContent = site;
    const remove = document.createElement("button");
    remove.className = "remove-site-button";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${site} from paused websites`);
    remove.addEventListener("click", async () => {
      const data = await getData();
      data.settings.blockedSites = (data.settings.blockedSites || []).filter((entry) => entry !== site);
      await chrome.storage.local.set({ settings: data.settings });
      await chrome.runtime.sendMessage({ type: "REFRESH_BLOCK_RULES" });
      await render();
    });
    item.append(label, remove);
    list.append(item);
  }
}

function renderSessions(sessions) {
  const list = document.getElementById("sessionsList");
  const empty = document.getElementById("emptySessions");
  list.replaceChildren();
  const today = localDayKey();
  const todaySessions = sessions.filter((session) => localDayKey(new Date(session.endedAt || session.startedAt)) === today).slice(0, 6);
  empty.hidden = todaySessions.length > 0;
  for (const session of todaySessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = session.task || (session.completed ? "Focus session completed" : "Session ended early");
    const time = document.createElement("span");
    const started = new Date(session.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    time.textContent = `${started} · ${session.completed ? "Completed" : "Ended early"}`;
    left.append(title, time);
    const duration = document.createElement("span");
    duration.className = session.completed ? "session-badge" : "session-badge session-badge-muted";
    duration.textContent = `${formatDuration(session.elapsedSeconds)} · ${session.completed ? "Finished" : "Early"}`;
    row.append(left, duration);
    list.append(row);
  }
}

function renderRewards(profile, streak) {
  const totalXp = profile.totalXp || 0;
  const level = profile.level || Math.floor(totalXp / 100) + 1;
  const intoLevel = totalXp % 100;
  const unlocked = new Set(profile.badges || []);
  document.getElementById("level").textContent = String(level);
  document.getElementById("totalXp").textContent = String(totalXp);
  document.getElementById("xpToNext").textContent = `${intoLevel} / 100 XP to next level`;
  document.getElementById("levelProgress").style.width = `${intoLevel}%`;

  const badgesGrid = document.getElementById("badgesGrid");
  badgesGrid.replaceChildren();
  for (const badge of BADGES) {
    const card = document.createElement("article");
    card.className = `badge-card${unlocked.has(badge.id) ? " unlocked" : ""}`;
    const icon = document.createElement("span");
    icon.className = "badge-icon";
    icon.textContent = badge.icon;
    const title = document.createElement("strong");
    title.textContent = badge.title;
    const detail = document.createElement("small");
    detail.textContent = unlocked.has(badge.id) ? "Unlocked" : badge.detail;
    card.append(icon, title, detail);
    badgesGrid.append(card);
  }
  if (streak >= 3 && !unlocked.has("three-day-streak")) {
    document.getElementById("smartInsight").textContent = "Three-day streak reached. Keep your daily goal realistic so the habit stays sustainable.";
  }
}

function focusWindowFor(sessions) {
  const totals = { Morning: 0, Afternoon: 0, Evening: 0, Night: 0 };
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const session of sessions) {
    if (!session.completed || session.startedAt < cutoff) continue;
    const hour = new Date(session.startedAt).getHours();
    const period = hour >= 5 && hour < 12 ? "Morning" : hour >= 12 && hour < 17 ? "Afternoon" : hour >= 17 && hour < 22 ? "Evening" : "Night";
    totals[period] += session.elapsedSeconds || 0;
  }
  const best = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 1800 ? best[0] : "Not enough data";
}

function renderAnalytics(dailyStats, sessions, liveState) {
  const days = [];
  let weekSeconds = 0;
  let weekSessions = 0;
  let goalDays = 0;
  let priorWeekSeconds = 0;
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = dateAtOffset(offset);
    const key = localDayKey(date);
    const stat = dailyStats[key] || {};
    const seconds = offset === 0 ? liveState.todayStats.focusSeconds || 0 : stat.focusSeconds || 0;
    days.push({ key, label: date.toLocaleDateString([], { weekday: "short" }), minutes: Math.floor(seconds / 60), today: offset === 0 });
    weekSeconds += seconds;
    weekSessions += stat.completedSessions || 0;
    if (stat.goalMet) goalDays += 1;
  }
  for (let offset = 7; offset < 14; offset += 1) {
    const date = dateAtOffset(offset);
    priorWeekSeconds += dailyStats[localDayKey(date)]?.focusSeconds || 0;
  }

  const weeklyMinutes = Math.floor(weekSeconds / 60);
  document.getElementById("weeklyMinutes").textContent = String(weeklyMinutes);
  document.getElementById("weeklySessions").textContent = String(weekSessions);
  document.getElementById("weeklyAverage").textContent = `${Math.floor(weeklyMinutes / 7)} min`;
  document.getElementById("weeklyGoalDays").textContent = `${goalDays} / 7 days`;
  document.getElementById("bestFocusWindow").textContent = focusWindowFor(sessions);

  const previousMinutes = Math.floor(priorWeekSeconds / 60);
  let trend = "New activity";
  if (previousMinutes > 0) {
    const change = Math.round(((weeklyMinutes - previousMinutes) / previousMinutes) * 100);
    trend = change > 0 ? `↑ ${change}%` : change < 0 ? `↓ ${Math.abs(change)}%` : "No change";
  }
  document.getElementById("weeklyTrend").textContent = trend;

  const chart = document.getElementById("weeklyChart");
  chart.replaceChildren();
  const maximum = Math.max(30, ...days.map((day) => day.minutes));
  for (const day of days) {
    const wrapper = document.createElement("div");
    wrapper.className = `chart-day${day.today ? " today" : ""}`;
    const column = document.createElement("div");
    column.className = "chart-column";
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${day.minutes ? Math.max(5, Math.round((day.minutes / maximum) * 100)) : 2}%`;
    bar.title = `${day.label}: ${day.minutes} focused minutes`;
    column.append(bar);
    const label = document.createElement("div");
    label.className = "chart-day-label";
    const minutesLabel = document.createElement("span");
    minutesLabel.className = "chart-day-minutes";
    minutesLabel.textContent = `${day.minutes}m`;
    label.append(minutesLabel, document.createElement("br"), document.createTextNode(day.label));
    wrapper.append(column, label);
    chart.append(wrapper);
  }

  const insight = goalDays >= 4
    ? `Strong consistency: you reached your goal on ${goalDays} of the last 7 days.`
    : weeklyMinutes > previousMinutes && previousMinutes > 0
      ? `Your focus time is up compared with last week. Your strongest session window is ${focusWindowFor(sessions).toLowerCase()}.`
      : weeklyMinutes > 0
        ? `You logged ${weeklyMinutes} focus minutes this week. Try one small session at your strongest time: ${focusWindowFor(sessions).toLowerCase()}.`
        : "Complete a few sessions and FocusX will surface a study pattern here.";
  document.getElementById("smartInsight").textContent = insight;
}

function setBackendStatus(message, mode = "pending") {
  const pill = document.getElementById("backendStatus");
  pill.textContent = message;
  pill.className = `connection-pill${mode === "connected" ? " connected" : mode === "offline" ? " offline" : ""}`;
}

async function checkBackend() {
  const data = await getData();
  try {
    const health = await requestJson(`${getApiBase(data.settings)}/api/health`);
    setBackendStatus(health.aiEnabled ? "Server · AI ready" : "Server · demo coach", "connected");
    return health;
  } catch {
    setBackendStatus("Server offline", "offline");
    return null;
  }
}

function renderGroupMembers(groupResult, clientId) {
  const list = document.getElementById("leaderboardList");
  list.replaceChildren();
  const members = groupResult.members || [];
  if (!members.length) {
    const item = document.createElement("li");
    item.className = "empty-state";
    item.textContent = "No group members yet. Share the invite code with a friend.";
    list.append(item);
    return;
  }
  for (const member of members) {
    const item = document.createElement("li");
    item.className = `leaderboard-row${member.clientId === clientId ? " current-user" : ""}`;
    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `#${member.rank}`;
    const nameWrap = document.createElement("span");
    nameWrap.className = "leaderboard-name-wrap";
    const name = document.createElement("span");
    name.className = "leaderboard-name";
    name.textContent = member.displayName + (member.clientId === clientId ? " (you)" : "");
    const sub = document.createElement("small");
    sub.className = "leaderboard-sub";
    sub.textContent = `Level ${member.level} · ${member.streak} day streak · ${member.badges} badges`;
    nameWrap.append(name, sub);
    const score = document.createElement("span");
    score.className = "leaderboard-score";
    const minutes = document.createElement("strong");
    minutes.textContent = `${member.weeklyMinutes} min`;
    const xp = document.createElement("small");
    xp.textContent = `${member.xp} XP`;
    score.append(minutes, xp);
    item.append(rank, nameWrap, score);
    list.append(item);
  }
}

async function syncLeaderboard({ silent = false } = {}) {
  if (groupSyncInFlight) return;
  groupSyncInFlight = true;
  lastGroupSyncAt = Date.now();
  try {
    const [data, state] = await Promise.all([getData(), getLiveState()]);
    if (!data.group?.code) return;
    const base = getApiBase(data.settings);
    const profile = state.profile;
    const groupCode = encodeURIComponent(data.group.code);
    await requestJson(`${base}/api/groups/${groupCode}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: profile.clientId,
        displayName: data.group.displayName,
        xp: profile.totalXp || 0,
        level: profile.level || 1,
        streak: state.streak || 0,
        weeklyMinutes: state.weeklyMinutes || 0,
        badges: (profile.badges || []).length
      })
    });
    const board = await requestJson(`${base}/api/groups/${groupCode}/leaderboard?clientId=${encodeURIComponent(profile.clientId)}`);
    renderGroupMembers(board, profile.clientId);
    document.getElementById("groupNameLabel").textContent = board.name || data.group.name || "Study group";
    setBackendStatus("Group synced", "connected");
    if (!silent) groupMessage.textContent = "Leaderboard updated.";
  } catch (error) {
    if (!silent) groupMessage.textContent = error.message;
    setBackendStatus("Could not sync", "offline");
  } finally {
    groupSyncInFlight = false;
  }
}

async function renderGroup(data) {
  const setup = document.getElementById("groupSetup");
  const ready = document.getElementById("groupReady");
  const group = data.group;
  setup.hidden = Boolean(group?.code);
  ready.hidden = !group?.code;
  const apiBaseInput = document.getElementById("apiBaseInput");
  if (document.activeElement !== apiBaseInput) apiBaseInput.value = getApiBase(data.settings);
  if (!group?.code) return;
  document.getElementById("groupCode").textContent = group.code;
  document.getElementById("groupNameLabel").textContent = group.name || "Study group";
  document.getElementById("displayNameInput").value = group.displayName || "";
  if (Date.now() - lastGroupSyncAt > 60000) syncLeaderboard({ silent: true });
}

async function render() {
  try {
    const [data, liveState] = await Promise.all([getData(), getLiveState()]);
    const todayStats = liveState.todayStats || data.dailyStats[localDayKey()] || {};
    const minutes = todayStats.focusMinutes || 0;
    const goal = Number(data.settings.dailyGoalMinutes) || 60;
    const percent = Math.min(100, Math.round((minutes / goal) * 100));
    document.getElementById("focusToday").textContent = String(minutes);
    document.getElementById("completedSessions").textContent = String(todayStats.completedSessions || 0);
    document.getElementById("streak").textContent = String(liveState.streak || 0);
    document.getElementById("dashboardProgress").style.width = `${percent}%`;
    document.getElementById("goalCaption").textContent = `${percent}% of your ${goal} min goal`;
    if (document.activeElement !== goalInput) goalInput.value = String(goal);
    renderRewards(liveState.profile, liveState.streak);
    renderAnalytics(data.dailyStats, data.sessions, liveState);
    renderSiteUsage(data.siteUsage);
    renderBlockedSites(data.settings);
    renderSessions(data.sessions);
    await renderGroup(data);
  } catch (error) {
    dashboardMessage.textContent = error.message;
  }
}

document.getElementById("siteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  siteMessage.textContent = "";
  const domain = normaliseDomain(siteInput.value);
  if (!domain) { siteMessage.textContent = "Enter a domain like youtube.com."; return; }
  const data = await getData();
  const sites = new Set(data.settings.blockedSites || []);
  if (sites.has(domain)) { siteMessage.textContent = "That website is already on your list."; return; }
  if (sites.size >= 100) { siteMessage.textContent = "The pause list is full (100 websites)."; return; }
  sites.add(domain);
  data.settings.blockedSites = [...sites];
  await chrome.storage.local.set({ settings: data.settings });
  await chrome.runtime.sendMessage({ type: "REFRESH_BLOCK_RULES" });
  siteInput.value = "";
  siteMessage.textContent = "Website added.";
  await render();
});

document.getElementById("saveGoal").addEventListener("click", async () => {
  const goal = Math.max(1, Math.min(720, Math.floor(Number(goalInput.value) || 60)));
  const data = await getData();
  data.settings.dailyGoalMinutes = goal;
  const key = localDayKey();
  const today = data.dailyStats[key] || { focusSeconds: 0, focusMinutes: 0, completedSessions: 0, goalMet: false };
  today.focusMinutes = Math.floor((today.focusSeconds || 0) / 60);
  today.goalMet = today.focusMinutes >= goal;
  data.dailyStats[key] = today;
  await chrome.storage.local.set({ settings: data.settings, dailyStats: data.dailyStats });
  dashboardMessage.textContent = "Daily goal saved.";
  await render();
});

document.getElementById("blockToggle").addEventListener("change", async (event) => {
  const data = await getData();
  data.settings.blockDuringFocus = event.target.checked;
  await chrome.storage.local.set({ settings: data.settings });
  await chrome.runtime.sendMessage({ type: "REFRESH_BLOCK_RULES" });
  dashboardMessage.textContent = event.target.checked ? "Website pause is on." : "Website pause is off.";
  await render();
});

document.getElementById("backToTimer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});

document.getElementById("saveApiBase").addEventListener("click", async () => {
  const input = document.getElementById("apiBaseInput");
  try {
    const parsed = new URL(input.value.trim());
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Use an http or https backend URL.");
    const data = await getData();
    data.settings.apiBaseUrl = parsed.origin;
    await chrome.storage.local.set({ settings: data.settings });
    dashboardMessage.textContent = "Backend URL saved.";
    await checkBackend();
    await render();
  } catch (error) {
    dashboardMessage.textContent = error.message || "Enter a valid backend URL.";
  }
});

document.getElementById("createGroup").addEventListener("click", async () => {
  groupMessage.textContent = "Creating group…";
  try {
    const [data, state] = await Promise.all([getData(), getLiveState()]);
    const displayName = document.getElementById("displayNameInput").value.trim();
    const groupName = document.getElementById("groupNameInput").value.trim();
    if (!displayName) throw new Error("Add a display name first.");
    const result = await requestJson(`${getApiBase(data.settings)}/api/groups`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: state.profile.clientId, displayName, groupName })
    });
    await chrome.storage.local.set({ group: { code: result.code, name: result.name, displayName } });
    groupMessage.textContent = "Group created. Share its invite code with friends.";
    lastGroupSyncAt = 0;
    await render();
    await syncLeaderboard({ silent: false });
  } catch (error) { groupMessage.textContent = error.message; }
});

document.getElementById("joinGroup").addEventListener("click", async () => {
  groupMessage.textContent = "Joining group…";
  try {
    const [data, state] = await Promise.all([getData(), getLiveState()]);
    const displayName = document.getElementById("displayNameInput").value.trim();
    const code = document.getElementById("joinCodeInput").value.trim().toUpperCase();
    if (!displayName) throw new Error("Add a display name first.");
    if (!code) throw new Error("Enter your friend's invite code.");
    const result = await requestJson(`${getApiBase(data.settings)}/api/groups/join`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, clientId: state.profile.clientId, displayName })
    });
    await chrome.storage.local.set({ group: { code: result.code, name: result.name, displayName } });
    groupMessage.textContent = "Joined. Your leaderboard is ready.";
    lastGroupSyncAt = 0;
    await render();
    await syncLeaderboard({ silent: false });
  } catch (error) { groupMessage.textContent = error.message; }
});

document.getElementById("syncLeaderboard").addEventListener("click", () => syncLeaderboard({ silent: false }));

document.getElementById("copyCode").addEventListener("click", async () => {
  const code = document.getElementById("groupCode").textContent;
  try {
    await navigator.clipboard.writeText(code);
    groupMessage.textContent = "Invite code copied.";
  } catch {
    groupMessage.textContent = `Share this invite code: ${code}`;
  }
});

document.getElementById("leaveGroup").addEventListener("click", async () => {
  const [data, state] = await Promise.all([getData(), getLiveState()]);
  if (!data.group?.code) return;
  const confirmed = window.confirm("Leave this group on this device? Your local focus history and rewards stay saved.");
  if (!confirmed) return;
  try {
    await fetch(`${getApiBase(data.settings)}/api/groups/${encodeURIComponent(data.group.code)}/members/${encodeURIComponent(state.profile.clientId)}`, { method: "DELETE" });
  } catch { /* Local disconnect still works if the server is offline. */ }
  await chrome.storage.local.set({ group: null });
  groupMessage.textContent = "Disconnected from the group on this device.";
  lastGroupSyncAt = 0;
  await render();
});

document.querySelectorAll(".prompt-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.getElementById("coachQuestion").value = chip.dataset.prompt || "";
    document.getElementById("coachQuestion").focus();
  });
});

document.getElementById("askCoach").addEventListener("click", async () => {
  const button = document.getElementById("askCoach");
  const question = document.getElementById("coachQuestion").value.trim();
  if (!question) { dashboardMessage.textContent = "Write a question for your study coach first."; return; }
  button.disabled = true;
  button.textContent = "Thinking…";
  dashboardMessage.textContent = "";
  try {
    const [data, state] = await Promise.all([getData(), getLiveState()]);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sessionsThisWeek = data.sessions.filter((session) => session.completed && session.endedAt >= cutoff).length;
    const goalsReachedThisWeek = Array.from({ length: 7 }, (_, offset) => localDayKey(dateAtOffset(offset)))
      .filter((key) => data.dailyStats[key]?.goalMet).length;
    const response = await requestJson(`${getApiBase(data.settings)}/api/coach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        focusSummary: {
          todayMinutes: state.todayStats.focusMinutes || 0,
          dailyGoalMinutes: data.settings.dailyGoalMinutes,
          streakDays: state.streak || 0,
          weeklyMinutes: state.weeklyMinutes || 0,
          sessionsThisWeek,
          goalsReachedThisWeek
        }
      })
    });
    document.getElementById("coachMode").textContent = response.mode === "ai" ? `AI coach · ${response.model}` : "Demo tip · AI not configured";
    document.getElementById("coachAnswer").textContent = response.answer;
    document.getElementById("coachResponse").hidden = false;
  } catch (error) {
    document.getElementById("coachMode").textContent = "Coach unavailable";
    document.getElementById("coachAnswer").textContent = `${error.message}\n\nCheck that the FocusX backend is running and its URL is correct.`;
    document.getElementById("coachResponse").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Ask study coach";
  }
});

document.getElementById("exportData").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  const exportFile = { product: "FocusX", exportedAt: new Date().toISOString(), note: "Contains local extension settings, profile, rewards, group code, and focus summaries.", data };
  const blob = new Blob([JSON.stringify(exportFile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `focusx-data-${localDayKey()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  dashboardMessage.textContent = "Your FocusX data export was downloaded.";
});

document.getElementById("clearProgress").addEventListener("click", async () => {
  const confirmed = window.confirm("Clear session and website history? XP, badges, settings, and group connection will stay.");
  if (!confirmed) return;
  await chrome.storage.local.set({ dailyStats: {}, siteUsage: {}, sessions: [] });
  dashboardMessage.textContent = "Session and website history cleared. Rewards were kept.";
  await render();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") render();
});

render();
checkBackend();
window.setInterval(render, 10000);
window.setInterval(checkBackend, 60000);
