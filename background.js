// FocusX background service worker. Persistent state is stored locally because
// Chrome may stop a Manifest V3 service worker whenever it becomes idle.
const STORAGE = {
  settings: "settings",
  activeSession: "activeSession",
  dailyStats: "dailyStats",
  siteUsage: "siteUsage",
  sessions: "sessions",
  trackedTab: "trackedTab",
  profile: "profile",
  group: "group"
};

const SESSION_ALARM = "focus-session-end";
const USAGE_ALARM = "website-usage-flush";
const DYNAMIC_RULE_FIRST_ID = 1000;
const DYNAMIC_RULE_LIMIT = 100;

const DEFAULT_SETTINGS = {
  dailyGoalMinutes: 60,
  blockDuringFocus: true,
  blockedSites: ["youtube.com", "instagram.com", "tiktok.com"],
  apiBaseUrl: "http://localhost:4242"
};

function createDefaultProfile() {
  return {
    clientId: crypto.randomUUID(),
    totalXp: 0,
    lifetimeFocusSeconds: 0,
    totalCompletedSessions: 0,
    badges: [],
    xpEvents: [],
    goalRewardDates: []
  };
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(Object.values(STORAGE));
  const updates = {};
  const savedSettings = data[STORAGE.settings];
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) };
  if (!savedSettings || JSON.stringify(savedSettings) !== JSON.stringify(mergedSettings)) updates[STORAGE.settings] = mergedSettings;
  if (!(STORAGE.activeSession in data)) updates[STORAGE.activeSession] = null;
  if (!(STORAGE.dailyStats in data)) updates[STORAGE.dailyStats] = {};
  if (!(STORAGE.siteUsage in data)) updates[STORAGE.siteUsage] = {};
  if (!(STORAGE.sessions in data)) updates[STORAGE.sessions] = [];
  if (!(STORAGE.trackedTab in data)) updates[STORAGE.trackedTab] = null;
  if (!(STORAGE.profile in data)) updates[STORAGE.profile] = createDefaultProfile();
  if (!(STORAGE.group in data)) updates[STORAGE.group] = null;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
}

function dateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function domainFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normaliseDomain(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0];
  candidate = candidate.replace(/^www\./, "").replace(/\.$/, "");
  if (!candidate || candidate.length > 253) return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(candidate)) return null;
  return candidate;
}

function isSessionRunning(session) {
  return Boolean(session && !session.paused && session.endsAt > Date.now());
}

function hasSession(session) {
  return Boolean(session && (session.paused || session.endsAt > Date.now()));
}

function sessionIntervals(session, now = Date.now()) {
  if (!session) return [];
  const intervals = Array.isArray(session.segments) ? [...session.segments] : [];
  if (!session.paused && session.segmentStartedAt) {
    const endAt = Math.min(now, session.endsAt || now);
    if (endAt > session.segmentStartedAt) intervals.push({ startAt: session.segmentStartedAt, endAt });
  }
  return intervals;
}

function sessionElapsedSeconds(session, now = Date.now()) {
  return sessionIntervals(session, now).reduce(
    (total, interval) => total + Math.max(0, Math.floor((interval.endAt - interval.startAt) / 1000)),
    0
  );
}

function secondsWithinDay(startAt, endAt, day) {
  const [year, month, date] = day.split("-").map(Number);
  const dayStart = new Date(year, month - 1, date).getTime();
  const dayEnd = new Date(year, month - 1, date + 1).getTime();
  return Math.max(0, Math.floor((Math.min(endAt, dayEnd) - Math.max(startAt, dayStart)) / 1000));
}

function addFocusInterval(dailyStats, startAt, endAt) {
  if (endAt <= startAt) return [];
  const touchedDays = [];
  let cursor = startAt;
  while (cursor < endAt) {
    const nextDay = new Date(cursor);
    nextDay.setHours(24, 0, 0, 0);
    const segmentEnd = Math.min(endAt, nextDay.getTime());
    const key = dateKey(cursor);
    const seconds = secondsWithinDay(cursor, segmentEnd, key);
    if (seconds > 0) {
      const stat = dailyStats[key] || { focusSeconds: 0, focusMinutes: 0, completedSessions: 0, goalMet: false };
      stat.focusSeconds = (stat.focusSeconds || 0) + seconds;
      dailyStats[key] = stat;
      if (!touchedDays.includes(key)) touchedDays.push(key);
    }
    cursor = segmentEnd;
  }
  return touchedDays;
}

function computeStreak(dailyStats) {
  const date = new Date();
  if (!dailyStats[dateKey()]?.goalMet) date.setDate(date.getDate() - 1);
  let streak = 0;
  while (streak < 366 && dailyStats[dateKey(date.getTime())]?.goalMet) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

function getWeeklyMinutes(dailyStats, now = Date.now()) {
  let totalSeconds = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    totalSeconds += dailyStats[dateKey(date.getTime())]?.focusSeconds || 0;
  }
  return Math.floor(totalSeconds / 60);
}

function awardProgress(profile, dailyStats, settings, elapsedSeconds, completed, touchedDays) {
  const priorBadges = new Set(profile.badges || []);
  const newBadges = [];
  let xpGained = Math.floor(elapsedSeconds / 60) * 5;
  if (completed) xpGained += 20;

  const goalRewardDates = new Set(profile.goalRewardDates || []);
  for (const key of touchedDays) {
    const stat = dailyStats[key];
    stat.focusMinutes = Math.floor((stat.focusSeconds || 0) / 60);
    stat.goalMet = stat.focusMinutes >= (Number(settings.dailyGoalMinutes) || 60);
    if (stat.goalMet && !goalRewardDates.has(key)) {
      xpGained += 25;
      goalRewardDates.add(key);
    }
  }

  profile.totalXp = (profile.totalXp || 0) + xpGained;
  profile.lifetimeFocusSeconds = (profile.lifetimeFocusSeconds || 0) + elapsedSeconds;
  if (completed) profile.totalCompletedSessions = (profile.totalCompletedSessions || 0) + 1;
  profile.goalRewardDates = [...goalRewardDates].slice(-365);

  const streak = computeStreak(dailyStats);
  const earned = {
    "first-session": profile.totalCompletedSessions >= 1,
    "focus-hour": profile.lifetimeFocusSeconds >= 3600,
    "focus-five-hours": profile.lifetimeFocusSeconds >= 18000,
    "goal-getter": Object.values(dailyStats).some((stat) => stat.goalMet),
    "three-day-streak": streak >= 3,
    "ten-sessions": profile.totalCompletedSessions >= 10
  };
  for (const [badge, unlocked] of Object.entries(earned)) {
    if (unlocked && !priorBadges.has(badge)) {
      priorBadges.add(badge);
      newBadges.push(badge);
    }
  }

  profile.badges = [...priorBadges];
  profile.level = Math.floor(profile.totalXp / 100) + 1;
  profile.xpIntoLevel = profile.totalXp % 100;
  profile.xpEvents = [
    { at: Date.now(), amount: xpGained, task: "Focus session", completed },
    ...(profile.xpEvents || [])
  ].slice(0, 30);
  return { xpGained, newBadges, streak };
}

async function flushTrackedUsage() {
  const data = await chrome.storage.local.get([STORAGE.trackedTab, STORAGE.siteUsage]);
  const tracked = data[STORAGE.trackedTab];
  if (!tracked || !tracked.domain || !tracked.startedAt) return;
  const now = Date.now();
  if (now <= tracked.startedAt) return;

  const siteUsage = data[STORAGE.siteUsage] || {};
  let cursor = tracked.startedAt;
  while (cursor < now) {
    const dayEnd = new Date(cursor);
    dayEnd.setHours(24, 0, 0, 0);
    const segmentEnd = Math.min(now, dayEnd.getTime());
    const seconds = Math.max(0, Math.floor((segmentEnd - cursor) / 1000));
    const key = dateKey(cursor);
    if (!siteUsage[key]) siteUsage[key] = {};
    siteUsage[key][tracked.domain] = (siteUsage[key][tracked.domain] || 0) + seconds;
    cursor = segmentEnd;
  }
  await chrome.storage.local.set({
    [STORAGE.siteUsage]: siteUsage,
    [STORAGE.trackedTab]: { ...tracked, startedAt: now }
  });
}

async function switchTrackedTab(tabId) {
  const data = await chrome.storage.local.get(STORAGE.trackedTab);
  const previous = data[STORAGE.trackedTab];
  let tab = null;
  if (Number.isInteger(tabId)) {
    try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
  }
  const nextDomain = tab ? domainFromUrl(tab.url || "") : null;
  if (previous && previous.tabId === tabId && previous.domain === nextDomain) return;
  await flushTrackedUsage();
  if (!tab || !nextDomain) {
    await chrome.storage.local.set({ [STORAGE.trackedTab]: null });
    return;
  }
  await chrome.storage.local.set({ [STORAGE.trackedTab]: { tabId, domain: nextDomain, startedAt: Date.now() } });
}

async function refreshFocusedTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await switchTrackedTab(tab?.id);
  } catch {
    await switchTrackedTab(null);
  }
}

async function syncBlockingRules() {
  const data = await chrome.storage.local.get([STORAGE.settings, STORAGE.activeSession]);
  const settings = data[STORAGE.settings] || DEFAULT_SETTINGS;
  const active = isSessionRunning(data[STORAGE.activeSession]) && settings.blockDuringFocus !== false;
  const domains = active
    ? [...new Set((settings.blockedSites || []).map(normaliseDomain).filter(Boolean))].slice(0, DYNAMIC_RULE_LIMIT)
    : [];
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .filter((rule) => rule.id >= DYNAMIC_RULE_FIRST_ID && rule.id < DYNAMIC_RULE_FIRST_ID + DYNAMIC_RULE_LIMIT)
    .map((rule) => rule.id);
  const addRules = domains.map((domain, index) => ({
    id: DYNAMIC_RULE_FIRST_ID + index,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { urlFilter: `||${domain}^`, resourceTypes: ["main_frame"] }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function syncGroupScore() {
  const data = await chrome.storage.local.get([STORAGE.settings, STORAGE.group, STORAGE.profile, STORAGE.dailyStats]);
  const group = data[STORAGE.group];
  if (!group?.code) return;
  const settings = data[STORAGE.settings] || DEFAULT_SETTINGS;
  const profile = data[STORAGE.profile] || createDefaultProfile();
  const dailyStats = data[STORAGE.dailyStats] || {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    await fetch(`${String(settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/$/, "")}/api/groups/${encodeURIComponent(group.code)}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        clientId: profile.clientId,
        displayName: group.displayName,
        xp: profile.totalXp || 0,
        level: profile.level || 1,
        streak: computeStreak(dailyStats),
        weeklyMinutes: getWeeklyMinutes(dailyStats),
        badges: (profile.badges || []).length
      })
    });
  } catch {
    // Keep local focus rewards even when the group server is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

async function getState() {
  await ensureDefaults();
  const current = await chrome.storage.local.get(STORAGE.activeSession);
  const currentSession = current[STORAGE.activeSession];
  if (currentSession && !currentSession.paused && currentSession.endsAt <= Date.now()) await finishSession(true);
  const data = await chrome.storage.local.get(Object.values(STORAGE));
  const settings = data[STORAGE.settings] || DEFAULT_SETTINGS;
  const dailyStats = data[STORAGE.dailyStats] || {};
  const todayKey = dateKey();
  const todayStats = dailyStats[todayKey] || { focusSeconds: 0, focusMinutes: 0, completedSessions: 0, goalMet: false };
  const activeSession = data[STORAGE.activeSession];
  const sessionTodaySeconds = sessionIntervals(activeSession).reduce(
    (sum, interval) => sum + secondsWithinDay(interval.startAt, interval.endAt, todayKey), 0
  );
  const focusSeconds = (todayStats.focusSeconds || 0) + sessionTodaySeconds;
  const profile = data[STORAGE.profile] || createDefaultProfile();
  return {
    settings,
    profile: { ...profile, level: profile.level || Math.floor((profile.totalXp || 0) / 100) + 1 },
    group: data[STORAGE.group] || null,
    activeSession: hasSession(activeSession) ? {
      ...activeSession,
      remainingMs: activeSession.paused ? activeSession.remainingMs : Math.max(0, activeSession.endsAt - Date.now()),
      elapsedSeconds: sessionElapsedSeconds(activeSession)
    } : null,
    activeElapsedSeconds: sessionElapsedSeconds(activeSession),
    dailyStats,
    todayStats: { ...todayStats, focusSeconds, focusMinutes: Math.floor(focusSeconds / 60) },
    siteUsage: data[STORAGE.siteUsage] || {},
    sessions: data[STORAGE.sessions] || [],
    streak: computeStreak(dailyStats),
    weeklyMinutes: getWeeklyMinutes(dailyStats)
  };
}

async function startSession(durationMinutes, taskName) {
  await ensureDefaults();
  let data = await chrome.storage.local.get(STORAGE.activeSession);
  let existing = data[STORAGE.activeSession];
  if (existing && !existing.paused && existing.endsAt <= Date.now()) {
    await finishSession(true);
    data = await chrome.storage.local.get(STORAGE.activeSession);
    existing = data[STORAGE.activeSession];
  }
  if (hasSession(existing)) return { ok: false, error: "A focus session is already active." };
  const minutes = Math.max(1, Math.min(180, Math.floor(Number(durationMinutes) || 25)));
  const startedAt = Date.now();
  const session = {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    segmentStartedAt: startedAt,
    endsAt: startedAt + minutes * 60 * 1000,
    remainingMs: minutes * 60 * 1000,
    durationMinutes: minutes,
    task: String(taskName || "").trim().slice(0, 80),
    paused: false,
    segments: []
  };
  await chrome.storage.local.set({ [STORAGE.activeSession]: session });
  chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
  await syncBlockingRules();
  await refreshFocusedTab();
  return { ok: true, session };
}

async function pauseSession() {
  const data = await chrome.storage.local.get(STORAGE.activeSession);
  const session = data[STORAGE.activeSession];
  if (!session || session.paused) return { ok: false, error: "There is no running session to pause." };
  if (Date.now() >= session.endsAt) return finishSession(true);
  const pausedAt = Date.now();
  const segments = Array.isArray(session.segments) ? session.segments : [];
  if (session.segmentStartedAt && pausedAt > session.segmentStartedAt) segments.push({ startAt: session.segmentStartedAt, endAt: pausedAt });
  const updated = {
    ...session,
    paused: true,
    pausedAt,
    remainingMs: Math.max(0, session.endsAt - pausedAt),
    endsAt: null,
    segmentStartedAt: null,
    segments
  };
  await chrome.storage.local.set({ [STORAGE.activeSession]: updated });
  chrome.alarms.clear(SESSION_ALARM);
  await syncBlockingRules();
  return { ok: true, paused: true };
}

async function resumeSession() {
  const data = await chrome.storage.local.get(STORAGE.activeSession);
  const session = data[STORAGE.activeSession];
  if (!session?.paused) return { ok: false, error: "There is no paused session to resume." };
  const resumedAt = Date.now();
  const remainingMs = Math.max(1000, Number(session.remainingMs) || 1000);
  const updated = {
    ...session,
    paused: false,
    pausedAt: null,
    segmentStartedAt: resumedAt,
    endsAt: resumedAt + remainingMs,
    remainingMs
  };
  await chrome.storage.local.set({ [STORAGE.activeSession]: updated });
  chrome.alarms.create(SESSION_ALARM, { when: updated.endsAt });
  await syncBlockingRules();
  return { ok: true, session: updated };
}

async function finishSession(naturallyCompleted) {
  const data = await chrome.storage.local.get([
    STORAGE.activeSession, STORAGE.settings, STORAGE.dailyStats, STORAGE.sessions, STORAGE.profile
  ]);
  const session = data[STORAGE.activeSession];
  if (!session) return { ok: false, error: "There is no active session." };
  const settings = data[STORAGE.settings] || DEFAULT_SETTINGS;
  const now = Date.now();
  const completed = Boolean(naturallyCompleted || (!session.paused && now >= session.endsAt));
  const endedAt = completed ? session.endsAt : now;
  const intervals = Array.isArray(session.segments) ? [...session.segments] : [];
  if (!session.paused && session.segmentStartedAt) {
    const finalSegmentEnd = completed ? session.endsAt : Math.min(now, session.endsAt);
    if (finalSegmentEnd > session.segmentStartedAt) intervals.push({ startAt: session.segmentStartedAt, endAt: finalSegmentEnd });
  }
  const elapsedSeconds = intervals.reduce((sum, interval) => sum + Math.max(0, Math.floor((interval.endAt - interval.startAt) / 1000)), 0);
  const dailyStats = data[STORAGE.dailyStats] || {};
  const sessions = data[STORAGE.sessions] || [];
  const touchedDays = new Set();
  for (const interval of intervals) {
    for (const key of addFocusInterval(dailyStats, interval.startAt, interval.endAt)) touchedDays.add(key);
  }
  if (completed) {
    const completionDay = dateKey(endedAt);
    const stat = dailyStats[completionDay] || { focusSeconds: 0, focusMinutes: 0, completedSessions: 0, goalMet: false };
    stat.completedSessions = (stat.completedSessions || 0) + 1;
    dailyStats[completionDay] = stat;
    touchedDays.add(completionDay);
  }

  const profile = data[STORAGE.profile] || createDefaultProfile();
  const reward = awardProgress(profile, dailyStats, settings, elapsedSeconds, completed, [...touchedDays]);
  sessions.unshift({
    id: session.id,
    task: session.task || "",
    startedAt: session.startedAt,
    endedAt,
    durationMinutes: session.durationMinutes,
    elapsedSeconds,
    completed,
    segments: intervals
  });
  await chrome.storage.local.set({
    [STORAGE.activeSession]: null,
    [STORAGE.dailyStats]: dailyStats,
    [STORAGE.sessions]: sessions.slice(0, 100),
    [STORAGE.profile]: profile
  });
  chrome.alarms.clear(SESSION_ALARM);
  await syncBlockingRules();
  syncGroupScore();
  return { ok: true, completed, elapsedSeconds, xpGained: reward.xpGained, newBadges: reward.newBadges, streak: reward.streak };
}

async function reconcileSession() {
  await ensureDefaults();
  const data = await chrome.storage.local.get(STORAGE.activeSession);
  const session = data[STORAGE.activeSession];
  if (session && !session.paused && session.endsAt <= Date.now()) await finishSession(true);
  else if (session && !session.paused) {
    chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
    await syncBlockingRules();
  } else {
    chrome.alarms.clear(SESSION_ALARM);
    await syncBlockingRules();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  chrome.alarms.create(USAGE_ALARM, { periodInMinutes: 1 });
  await reconcileSession();
  await refreshFocusedTab();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  chrome.alarms.create(USAGE_ALARM, { periodInMinutes: 1 });
  await reconcileSession();
  await refreshFocusedTab();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SESSION_ALARM) {
    const data = await chrome.storage.local.get(STORAGE.activeSession);
    const session = data[STORAGE.activeSession];
    if (session && !session.paused && session.endsAt <= Date.now()) await finishSession(true);
  }
  if (alarm.name === USAGE_ALARM) await flushTrackedUsage();
});

chrome.tabs.onActivated.addListener(() => refreshFocusedTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    if (tab?.url) enforceBlockedSite(tab.url);
    refreshFocusedTab();
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.local.get(STORAGE.trackedTab);
  if (data[STORAGE.trackedTab]?.tabId === tabId) await refreshFocusedTab();
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) await switchTrackedTab(null);
  else {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    await switchTrackedTab(tab?.id);
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE.settings]) syncBlockingRules();
});

async function enforceBlockedSite(url) {
  const domain = domainFromUrl(url);
  if (!domain) return;
  const data = await chrome.storage.local.get([STORAGE.settings, STORAGE.activeSession]);
  const session = data[STORAGE.activeSession];
  const settings = data[STORAGE.settings] || DEFAULT_SETTINGS;
  if (!isSessionRunning(session) || settings.blockDuringFocus === false) return;
  const blocked = (settings.blockedSites || []).map(normaliseDomain).filter(Boolean);
  if (!blocked.some((site) => domain === site || domain.endsWith(`.${site}`))) return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const currentTab = tabs[0];
  if (!currentTab?.id || domainFromUrl(currentTab.url || "") !== domain) return;
  try { await chrome.tabs.update(currentTab.id, { url: chrome.runtime.getURL("blocked.html") }); } catch { /* Protected pages cannot be redirected. */ }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_STATE") return { ok: true, state: await getState() };
    if (message?.type === "START_SESSION") return startSession(message.durationMinutes, message.task);
    if (message?.type === "PAUSE_SESSION") return pauseSession();
    if (message?.type === "RESUME_SESSION") return resumeSession();
    if (message?.type === "STOP_SESSION") return finishSession(false);
    if (message?.type === "REFRESH_BLOCK_RULES") { await syncBlockingRules(); return { ok: true }; }
    if (message?.type === "SYNC_GROUP") { await syncGroupScore(); return { ok: true }; }
    return { ok: false, error: "Unknown request." };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || "Something went wrong." }));
  return true;
});
