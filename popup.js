const timerDisplay = document.getElementById("timerDisplay");
const sessionStatus = document.getElementById("sessionStatus");
const sessionButton = document.getElementById("sessionButton");
const pauseButton = document.getElementById("pauseButton");
const sessionActions = document.getElementById("sessionActions");
const durationControl = document.getElementById("durationControl");
const durationSelect = document.getElementById("durationSelect");
const taskControl = document.getElementById("taskControl");
const taskInput = document.getElementById("taskInput");
const todayMinutes = document.getElementById("todayMinutes");
const goalMinutes = document.getElementById("goalMinutes");
const todayProgress = document.getElementById("todayProgress");
const streakCount = document.getElementById("streakCount");
const popupMessage = document.getElementById("popupMessage");
const BADGE_NAMES = {
  "first-session": "First Step",
  "focus-hour": "Focus Hour",
  "goal-getter": "Goal Getter",
  "three-day-streak": "Three in a Row",
  "focus-five-hours": "Deep Worker",
  "ten-sessions": "Ten Sessions"
};

function formatClock(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function showMessage(message = "") {
  popupMessage.textContent = message;
}

async function render() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (!response?.ok) throw new Error(response?.error || "Could not load your progress.");
    const state = response.state;
    const session = state.activeSession;
    const goal = Number(state.settings.dailyGoalMinutes) || 60;
    const focusedMinutes = state.todayStats.focusMinutes || 0;

    todayMinutes.textContent = String(focusedMinutes);
    goalMinutes.textContent = String(goal);
    streakCount.textContent = String(state.streak || 0);
    document.getElementById("xpChip").textContent = `Level ${state.profile.level || 1} · ${state.profile.totalXp || 0} XP`;
    todayProgress.style.width = `${Math.min(100, Math.round((focusedMinutes / goal) * 100))}%`;

    if (session) {
      const remainingSeconds = session.paused
        ? Math.ceil(session.remainingMs / 1000)
        : Math.ceil((session.endsAt - Date.now()) / 1000);
      timerDisplay.textContent = formatClock(remainingSeconds);
      sessionStatus.textContent = session.paused
        ? `Paused${session.task ? ` · ${session.task}` : ""}`
        : `Focus in progress${session.task ? ` · ${session.task}` : ""}`;
      sessionButton.textContent = "End session";
      sessionButton.classList.add("stop-button");
      pauseButton.textContent = session.paused ? "Resume" : "Pause";
      sessionActions.hidden = false;
      durationControl.hidden = true;
      taskControl.hidden = true;
    } else {
      timerDisplay.textContent = formatClock(Number(durationSelect.value) * 60);
      sessionStatus.textContent = "Ready when you are.";
      sessionButton.textContent = "Start focus";
      sessionButton.classList.remove("stop-button");
      sessionActions.hidden = true;
      durationControl.hidden = false;
      taskControl.hidden = false;
    }
  } catch (error) {
    showMessage(error.message);
  }
}

sessionButton.addEventListener("click", async () => {
  showMessage("");
  sessionButton.disabled = true;
  try {
    const isActive = sessionButton.classList.contains("stop-button");
    const response = await chrome.runtime.sendMessage(isActive
      ? { type: "STOP_SESSION" }
      : {
          type: "START_SESSION",
          durationMinutes: Number(durationSelect.value),
          task: taskInput.value.trim()
        });
    if (!response?.ok) throw new Error(response?.error || "Could not update the session.");
    if (response.xpGained !== undefined) {
      const badgeText = response.newBadges?.length
        ? ` · New badge: ${response.newBadges.map((badge) => BADGE_NAMES[badge] || badge).join(", ")}`
        : "";
      showMessage(`+${response.xpGained} XP${response.completed ? " · Session complete" : " · Session ended"}${badgeText}`);
    }
    else if (response.completed) showMessage("Session complete — nice work!");
    else if (response.elapsedSeconds !== undefined) showMessage("Session ended. Your focus time was saved.");
    else showMessage("Focus session started. You’ve got this.");
    await render();
  } catch (error) {
    showMessage(error.message);
  } finally {
    sessionButton.disabled = false;
  }
});

pauseButton.addEventListener("click", async () => {
  showMessage("");
  pauseButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: pauseButton.textContent === "Resume" ? "RESUME_SESSION" : "PAUSE_SESSION"
    });
    if (!response?.ok) throw new Error(response?.error || "Could not update the session.");
    showMessage(response.paused ? "Timer paused. Blocked websites are available until you resume." : "Timer resumed.");
    await render();
  } catch (error) {
    showMessage(error.message);
  } finally {
    pauseButton.disabled = false;
  }
});

durationSelect.addEventListener("change", render);
document.getElementById("dashboardButton").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

render();
window.setInterval(render, 1000);
