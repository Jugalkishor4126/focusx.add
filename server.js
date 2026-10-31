const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomBytes } = require("node:crypto");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
const DATA_FILE = path.join(ROOT, "focusx-data.json");
const MAX_BODY_BYTES = 64 * 1024;
const MAX_GROUP_MEMBERS = 40;
const coachRequests = new Map();

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || match[1].startsWith("#") || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

let database = { groups: [] };
let saveQueue = Promise.resolve();

async function loadDatabase() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(DATA_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.groups)) database = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read FocusX data file; starting with an empty database.");
  }
}

function saveDatabase() {
  const snapshot = JSON.stringify(database, null, 2);
  saveQueue = saveQueue.then(() => fs.promises.writeFile(DATA_FILE, snapshot, "utf8"));
  return saveQueue;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request is too large.");
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function cleanText(value, maximum, fallback = "") {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) || fallback;
}

function cleanNumber(value, maximum = 10000000) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(maximum, number));
}

function findGroup(code) {
  return database.groups.find((group) => group.code === code.toUpperCase());
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes.slice(0, 6), (byte) => alphabet[byte % alphabet.length]).join("");
}

function normaliseMember(payload) {
  return {
    clientId: cleanText(payload.clientId, 80),
    displayName: cleanText(payload.displayName, 30, "Study buddy"),
    xp: cleanNumber(payload.xp),
    level: Math.max(1, cleanNumber(payload.level, 100000)),
    streak: cleanNumber(payload.streak, 3650),
    weeklyMinutes: cleanNumber(payload.weeklyMinutes, 100000),
    badges: cleanNumber(payload.badges, 100),
    updatedAt: new Date().toISOString()
  };
}

function getPublicMembers(group, currentClientId = "") {
  return [...group.members]
    .sort((a, b) => b.weeklyMinutes - a.weeklyMinutes || b.xp - a.xp || a.displayName.localeCompare(b.displayName))
    .map((member, index) => ({
      rank: index + 1,
      clientId: member.clientId,
      displayName: member.displayName,
      xp: member.xp,
      level: member.level,
      streak: member.streak,
      weeklyMinutes: member.weeklyMinutes,
      badges: member.badges,
      isYou: member.clientId === currentClientId
    }));
}

function getGroupCodeFromPath(pathname, ending) {
  const match = pathname.match(new RegExp(`^/api/groups/([A-Z0-9]{6})/${ending}$`, "i"));
  return match?.[1]?.toUpperCase() || null;
}

function demoCoachAnswer(question, summary) {
  const minutes = cleanNumber(summary.todayMinutes, 1440);
  const goal = Math.max(1, cleanNumber(summary.dailyGoalMinutes, 720) || 60);
  const remaining = Math.max(0, goal - minutes);
  const opener = minutes >= goal
    ? "Aaj ka focus goal complete hai—shabaash."
    : `Aaj ${remaining} minute ka goal baaki hai.`;
  const questionHint = /plan|schedule|time|routine/i.test(question)
    ? "25-minute study block rakho: 2 minute topic choose, 20 minute focused practice, 3 minute recap."
    : /distract|phone|scroll|procrastinat/i.test(question)
      ? "Agla chhota step: phone ko reach se bahar rakho, ek task likho, aur 15-minute timer chalao."
      : "Ek hi chhota task choose karo, uska pehla step likho, phir 15–25 minute ka timer chalao.";
  return `${opener}\n\nLocal demo tip (AI key configured nahi hai): ${questionHint}\n\nQuestion ke liye AI answer chahiye toh server/.env mein OPENAI_API_KEY set karke server restart karo.`;
}

function extractResponseText(payload) {
  const parts = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function askOpenAI(question, summary) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-6-astra",
        instructions: "You are FocusX, a supportive study coach for school and college students. Reply in friendly Hinglish unless the user clearly writes in another language. Be practical, kind, non-punitive, and concise. Give one next action and at most three steps. Use only the supplied aggregate study metrics. Do not diagnose mental-health conditions, shame the student, or claim certainty about why they struggle.",
        input: JSON.stringify({ question, focusSummary: summary }),
        max_output_tokens: 450,
        store: false
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || `AI service returned HTTP ${response.status}.`;
      const error = new Error(message);
      error.statusCode = 502;
      throw error;
    }
    const answer = extractResponseText(payload);
    if (!answer) {
      const error = new Error("AI returned no text. Try asking in a shorter way.");
      error.statusCode = 502;
      throw error;
    }
    return answer;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI took too long to respond. Please try again.");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function withinCoachLimit(ip) {
  const now = Date.now();
  const current = coachRequests.get(ip);
  if (!current || now - current.startedAt >= 60000) {
    coachRequests.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= 12) return false;
  current.count += 1;
  return true;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, aiEnabled: Boolean(process.env.OPENAI_API_KEY), groups: database.groups.length });
    return;
  }

  if (request.method === "POST" && pathname === "/api/groups") {
    const body = await readJson(request);
    const member = normaliseMember(body);
    if (!member.clientId) return sendJson(response, 400, { error: "Missing clientId." });
    const groupName = cleanText(body.groupName, 40, "Study group");
    let code = generateCode();
    while (findGroup(code)) code = generateCode();
    const group = { code, name: groupName, createdAt: new Date().toISOString(), members: [member] };
    database.groups.push(group);
    await saveDatabase();
    sendJson(response, 201, { code, name: group.name, members: getPublicMembers(group, member.clientId) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/groups/join") {
    const body = await readJson(request);
    const code = cleanText(body.code, 8).toUpperCase();
    const group = findGroup(code);
    if (!group) return sendJson(response, 404, { error: "Group code not found. Check the code with your friend." });
    const member = normaliseMember(body);
    if (!member.clientId) return sendJson(response, 400, { error: "Missing clientId." });
    const existing = group.members.find((item) => item.clientId === member.clientId);
    if (existing) Object.assign(existing, member);
    else if (group.members.length >= MAX_GROUP_MEMBERS) return sendJson(response, 409, { error: "This demo group has reached its member limit." });
    else group.members.push(member);
    await saveDatabase();
    sendJson(response, 200, { code, name: group.name, members: getPublicMembers(group, member.clientId) });
    return;
  }

  const scoreCode = getGroupCodeFromPath(pathname, "score");
  if (request.method === "POST" && scoreCode) {
    const group = findGroup(scoreCode);
    if (!group) return sendJson(response, 404, { error: "Group not found." });
    const body = await readJson(request);
    const member = normaliseMember(body);
    if (!member.clientId) return sendJson(response, 400, { error: "Missing clientId." });
    const existing = group.members.find((item) => item.clientId === member.clientId);
    if (existing) Object.assign(existing, member);
    else if (group.members.length >= MAX_GROUP_MEMBERS) return sendJson(response, 409, { error: "This demo group has reached its member limit." });
    else group.members.push(member);
    await saveDatabase();
    sendJson(response, 200, { ok: true, members: getPublicMembers(group, member.clientId) });
    return;
  }

  const boardCode = getGroupCodeFromPath(pathname, "leaderboard");
  if (request.method === "GET" && boardCode) {
    const group = findGroup(boardCode);
    if (!group) return sendJson(response, 404, { error: "Group not found." });
    const clientId = cleanText(url.searchParams.get("clientId"), 80);
    sendJson(response, 200, { code: group.code, name: group.name, members: getPublicMembers(group, clientId) });
    return;
  }

  const leaveMatch = pathname.match(/^\/api\/groups\/([A-Z0-9]{6})\/members\/([A-Za-z0-9_-]{1,80})$/i);
  if (request.method === "DELETE" && leaveMatch) {
    const group = findGroup(leaveMatch[1].toUpperCase());
    if (!group) return sendJson(response, 404, { error: "Group not found." });
    const clientId = decodeURIComponent(leaveMatch[2]);
    group.members = group.members.filter((member) => member.clientId !== clientId);
    await saveDatabase();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/coach") {
    if (!withinCoachLimit(request.socket.remoteAddress || "unknown")) {
      return sendJson(response, 429, { error: "Coach request limit reached. Wait a minute and try again." });
    }
    const body = await readJson(request);
    const question = cleanText(body.question, 1200);
    if (!question) return sendJson(response, 400, { error: "Write a question for the study coach first." });
    const source = body.focusSummary && typeof body.focusSummary === "object" ? body.focusSummary : {};
    const summary = {
      todayMinutes: cleanNumber(source.todayMinutes, 1440),
      dailyGoalMinutes: cleanNumber(source.dailyGoalMinutes, 720),
      streakDays: cleanNumber(source.streakDays, 3650),
      weeklyMinutes: cleanNumber(source.weeklyMinutes, 100000),
      sessionsThisWeek: cleanNumber(source.sessionsThisWeek, 1000),
      goalsReachedThisWeek: cleanNumber(source.goalsReachedThisWeek, 7)
    };

    if (!process.env.OPENAI_API_KEY) {
      sendJson(response, 200, { mode: "demo", answer: demoCoachAnswer(question, summary) });
      return;
    }
    const answer = await askOpenAI(question, summary);
    sendJson(response, 200, { mode: "ai", model: process.env.OPENAI_MODEL || "gpt-6-astra", answer });
    return;
  }

  sendJson(response, 404, { error: "Route not found." });
}

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "Server error. Check the server console." });
    } else response.end();
  }
});

loadDatabase().then(() => {
  const port = cleanNumber(process.env.PORT, 65535) || 4242;
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`FocusX server running at http://localhost:${port}`);
    console.log(`AI coach: ${process.env.OPENAI_API_KEY ? "configured" : "demo fallback (add API key in .env)"}`);
    console.log("Demo groups are saved in server/focusx-data.json.");
  });
}).catch((error) => {
  console.error("Could not start FocusX server:", error.message);
  process.exitCode = 1;
});
