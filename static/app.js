const GUESS_COOLDOWN_MS = 30 * 1000;

let toastHideTimer = null;
let toastHideToken = 0;
let lastToastText = "";

const MUSIC_STORAGE_KEY = "zeronight_music_enabled";
let musicEnabled = false;
let audioCtx = null;
let musicNodes = null;
let musicStartArmed = false;
let bgAudio = null;

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function setMusicBtnState(btn) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", musicEnabled ? "true" : "false");
}

function stopMusic() {
  musicStartArmed = false;

  if (bgAudio) {
    try {
      bgAudio.pause();
      bgAudio.currentTime = 0;
    } catch {}
  }

  if (musicNodes) {
    if (musicNodes.timer) {
      clearInterval(musicNodes.timer);
    }

    if (musicNodes.active && musicNodes.active.size) {
      for (const n of musicNodes.active) {
        try {
          n.stop();
        } catch {}
      }
      musicNodes.active.clear();
    }

    try {
      musicNodes.osc1.stop();
    } catch {}
    try {
      musicNodes.osc2.stop();
    } catch {}
    try {
      musicNodes.lfo.stop();
    } catch {}
    musicNodes = null;
  }

  if (audioCtx) {
    const ctx = audioCtx;
    audioCtx = null;
    ctx.close().catch(() => {});
  }
}

function ensureMusicStarted() {
  if (!musicEnabled) return;

  if (bgAudio) {
    try {
      bgAudio.volume = 0.35;
      const p = bgAudio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          showToast("Tap again to enable audio", { timeoutMs: 2600 });
        });
      }
      return;
    } catch {
      // fall back to WebAudio
    }
  }

  if (musicNodes) return;

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioCtx.state !== "running") {
    audioCtx.resume().catch(() => {});
  }

  const ctx = audioCtx;

  const master = ctx.createGain();
  master.gain.value = 0.02;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  filter.Q.value = 0.6;

  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = 0.32;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.22;
  const wet = ctx.createGain();
  wet.gain.value = 0.42;
  const dry = ctx.createGain();
  dry.gain.value = 0.9;

  filter.connect(dry);
  dry.connect(master);

  filter.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(master);

  master.connect(ctx.destination);

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.05;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 120;
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);
  lfo.start();

  const active = new Set();
  const makeVoice = ({ freq, when, duration, type, gainValue, attack, release }) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gainValue, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + duration - release);

    osc.connect(g);
    g.connect(filter);

    osc.start(when);
    osc.stop(when + duration);
    active.add(osc);
    osc.onended = () => active.delete(osc);
  };

  const progression = [
    [60, 64, 67],
    [57, 60, 64],
    [53, 57, 60],
    [55, 59, 62],
  ];
  let step = 0;

  const tick = () => {
    const now = ctx.currentTime + 0.02;
    const chord = progression[step % progression.length];
    step += 1;

    for (const m of chord) {
      makeVoice({
        freq: midiToFreq(m - 12),
        when: now,
        duration: 3.9,
        type: "triangle",
        gainValue: 0.06,
        attack: 0.12,
        release: 0.5,
      });
      makeVoice({
        freq: midiToFreq(m),
        when: now,
        duration: 3.9,
        type: "sine",
        gainValue: 0.028,
        attack: 0.18,
        release: 0.55,
      });
    }

    const arpOrder = [0, 1, 2, 1];
    for (let i = 0; i < 8; i++) {
      const note = chord[arpOrder[i % arpOrder.length]] + 12;
      makeVoice({
        freq: midiToFreq(note),
        when: now + i * 0.45,
        duration: 0.9,
        type: "sine",
        gainValue: 0.02,
        attack: 0.01,
        release: 0.22,
      });
    }
  };

  tick();
  const timer = setInterval(tick, 4000);

  musicNodes = {
    master,
    filter,
    delay,
    feedback,
    wet,
    dry,
    lfo,
    lfoGain,
    active,
    timer,
    osc1: { stop() {} },
    osc2: { stop() {} },
  };
}

function initMusic() {
  const btn = document.getElementById("musicBtn");
  if (!btn) return;

  bgAudio = document.getElementById("bgAudio");
  if (bgAudio) {
    bgAudio.loop = true;
    bgAudio.addEventListener("error", () => {
      showToast("Music file missing: add /static/relax.mp3", { timeoutMs: 4500 });
    });
  }

  musicEnabled = localStorage.getItem(MUSIC_STORAGE_KEY) === "1";
  setMusicBtnState(btn);

  const armStartOnFirstGesture = () => {
    if (!musicEnabled) return;
    if (musicStartArmed) return;
    musicStartArmed = true;

    const startOnce = () => {
      window.removeEventListener("pointerdown", startOnce);
      window.removeEventListener("touchstart", startOnce);
      window.removeEventListener("click", startOnce);
      window.removeEventListener("keydown", startOnce);
      try {
        ensureMusicStarted();
      } catch {
        // ignore
      }
    };

    window.addEventListener("pointerdown", startOnce, { once: true });
    window.addEventListener("touchstart", startOnce, { once: true, passive: true });
    window.addEventListener("click", startOnce, { once: true });
    window.addEventListener("keydown", startOnce, { once: true });
  };

  btn.addEventListener("click", () => {
    musicEnabled = !musicEnabled;
    localStorage.setItem(MUSIC_STORAGE_KEY, musicEnabled ? "1" : "0");
    setMusicBtnState(btn);

    if (!musicEnabled) {
      stopMusic();
      return;
    }

    try {
      ensureMusicStarted();
    } catch {
      // ignore
    }

    setTimeout(() => {
      if (!musicEnabled) return;
      if (bgAudio && bgAudio.paused) {
        showToast("Tap once to enable audio (and disable iPhone silent mode)", { timeoutMs: 4500 });
        armStartOnFirstGesture();
        return;
      }

      if (audioCtx && audioCtx.state !== "running") {
        showToast("Tap once to enable audio (and disable iPhone silent mode)", { timeoutMs: 4500 });
        armStartOnFirstGesture();
      }
    }, 500);
  });

  armStartOnFirstGesture();
}

async function fetchState() {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("Failed to load state");
  return await res.json();
}

function updateNoticeOverlay() {
  const overlay = document.getElementById("noticeOverlay");
  const toastEl = document.getElementById("toast");
  const cooldownEl = document.getElementById("cooldown");
  if (!overlay || !toastEl || !cooldownEl) return;

  const hasToast = Boolean((toastEl.textContent || "").trim());
  const hasCooldown = Boolean((cooldownEl.textContent || "").trim());

  const show = hasToast || hasCooldown;
  overlay.classList.toggle("show", show);
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
}

async function fetchFullState() {
  const res = await fetch("/api/state?full=1");
  if (!res.ok) throw new Error("Failed to load state");
  return await res.json();
}

async function fetchLevelState(level) {
  const res = await fetch(`/api/level_state?level=${encodeURIComponent(level)}`);
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    const err = new Error("Failed to load level state");
    err.status = res.status;
    err.detail = data?.detail;
    throw err;
  }
  return await res.json();
}

function renderBotLevelTrack() {
  const track = document.getElementById("botLevelTrack");
  if (!track) return;
  track.innerHTML = "";

  const doneCount = botSolved;

  for (const l of levels) {
    const node = document.createElement("div");
    node.className = "level-node" + (l.level <= doneCount ? " done" : "");

    const dot = document.createElement("button");
    dot.className = "level-dot";
    dot.type = "button";
    dot.disabled = true;

    if (l.level <= doneCount) dot.classList.add("done");

    node.appendChild(dot);
    track.appendChild(node);
  }
}

function renderLevelTrack() {
  const track = document.getElementById("levelTrack");
  if (!track) return;
  track.innerHTML = "";

  const unlocked = nextUnlockedLevel();

  for (const l of levels) {
    const node = document.createElement("div");
    node.className = "level-node" + (isSolved(l.level) ? " done" : "");

    const dot = document.createElement("button");
    dot.className = "level-dot";
    dot.type = "button";
    dot.title = `Level ${l.level}`;
    dot.setAttribute("aria-label", `Level ${l.level}`);

    if (isSolved(l.level)) dot.classList.add("done");
    if (l.level === currentLevel) dot.classList.add("current");

    const locked = !(isSolved(l.level) || l.level === unlocked);
    if (locked) {
      dot.classList.add("locked");
      dot.disabled = true;
    }

    dot.addEventListener("click", () => gotoLevel(l.level));

    node.appendChild(dot);
    track.appendChild(node);
  }
}

function showToast(msg, opts = {}) {
  const el = document.getElementById("toast");
  const text = msg || "";

  const autoHide = opts.autoHide !== false;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2600;

  if (text === lastToastText && autoHide && toastHideTimer) {
    updateNoticeOverlay();
    return;
  }

  lastToastText = text;
  el.textContent = text;

  if (toastHideTimer) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }

  const trimmed = text.trim();
  if (trimmed && autoHide) {
    const token = ++toastHideToken;
    toastHideTimer = setTimeout(() => {
      if (toastHideToken !== token) return;
      lastToastText = "";
      el.textContent = "";
      updateNoticeOverlay();
    }, timeoutMs);
  }

  updateNoticeOverlay();
}

function setCooldownText(text) {
  const el = document.getElementById("cooldown");
  if (!el) return;
  el.textContent = text || "";
  updateNoticeOverlay();
}

function startGuessCooldown(ms) {
  const until = Date.now() + ms;
  guessCooldownUntilMs = Math.max(guessCooldownUntilMs, until);

  const sec0 = Math.ceil((guessCooldownUntilMs - Date.now()) / 1000);
  setCooldownText(sec0 > 0 ? `Cooldown: ${sec0}s` : "");

  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  cooldownTimer = setInterval(() => {
    const left = guessCooldownUntilMs - Date.now();
    if (left <= 0) {
      guessCooldownUntilMs = 0;
      setCooldownText("");
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      return;
    }

    const sec = Math.ceil(left / 1000);
    setCooldownText(`Cooldown: ${sec}s`);
  }, 250);
}

function isGuessOnCooldown() {
  return guessCooldownUntilMs > Date.now();
}

function createKeyboard() {
  const kb = document.getElementById("keyboard");
  kb.innerHTML = "";

  const rows = [
    ["Q","W","E","R","T","Y","U","I","O","P"],
    ["A","S","D","F","G","H","J","K","L"],
    ["ENTER","Z","X","C","V","B","N","M","BACK"],
  ];

  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";

    for (const key of row) {
      const btn = document.createElement("button");
      btn.className = "key" + (key === "ENTER" || key === "BACK" ? " wide" : "");
      btn.textContent = key === "BACK" ? "DELETE" : key;
      btn.dataset.key = key;
      btn.addEventListener("click", () => onKey(key));
      rowEl.appendChild(btn);
    }

    kb.appendChild(rowEl);
  }
}

let levels = [];
let currentLevel = 1;
let currentGuess = "";
let currentRow = 0;
let lockInput = false;
let keyState = {}; // letter -> absent/present/correct
let playerSolved = new Set();
let botSolved = 0;
let botTotal = 0;
let botFinished = false;
let statePoller = null;
let guessCooldownUntilMs = 0;
let cooldownTimer = null;

function nextUnlockedLevel() {
  for (const l of levels) {
    if (!isSolved(l.level)) return l.level;
  }
  return levels.length ? levels[levels.length - 1].level : 1;
}

function playerSolvedCount() {
  return levels.filter((l) => isSolved(l.level)).length;
}

function isPlayerFinished() {
  return levels.length > 0 && playerSolvedCount() === levels.length;
}

function updateGameLockFromBot() {
  if (botFinished && !isPlayerFinished()) {
    lockInput = true;
    showToast("AI finished first. Everyone loses.", { autoHide: false });
  }
}

function canNavigateTo(level) {
  if (isSolved(level)) return true;
  return level === nextUnlockedLevel();
}

function gotoLevel(level) {
  if (!canNavigateTo(level)) {
    showToast("Locked. Solve previous levels first.");
    return;
  }

  if (botFinished && !isPlayerFinished()) {
    lockInput = true;
    showToast("AI finished first. Everyone loses.", { autoHide: false });
    return;
  }

  currentLevel = level;
  resetLevelState();
  renderBoard();
  updateKeyboardColors();
  renderLevelTrack();
  renderBotLevelTrack();
  loadAndApplyLevelState(level);
  showToast("");
}

async function fetchLevels() {
  const res = await fetch("/api/levels");
  if (!res.ok) throw new Error("Failed to load levels");
  return await res.json();
}

function levelData(level) {
  return levels.find((l) => l.level === level);
}

function attemptsForLevel(level) {
  const l = levelData(level);
  return l ? l.max_attempts : 6;
}

function lengthForLevel(level) {
  const l = levelData(level);
  return l ? l.length : 5;
}

function isSolved(level) {
  return playerSolved.has(level);
}

function resetLevelState() {
  currentGuess = "";
  currentRow = 0;
  lockInput = false;
  keyState = {};
}

function applyLevelState(levelState) {
  keyState = {};

  const attempts = Array.isArray(levelState?.attempts) ? levelState.attempts : [];
  const len = lengthForLevel(currentLevel);
  const rows = attemptsForLevel(currentLevel);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < len; c++) {
      setTile(r, c, "", "");
    }
  }

  let solvedNow = false;
  for (let r = 0; r < attempts.length; r++) {
    const a = attempts[r];
    const guess = (a?.guess || "").toUpperCase();
    const result = Array.isArray(a?.result) ? a.result : [];
    for (let i = 0; i < Math.min(len, guess.length); i++) {
      const st = result[i] || "";
      setTile(r, i, guess[i], st);
      if (st) mergeKeyState(guess[i], st);
    }
    if (a?.is_correct) solvedNow = true;
  }

  updateKeyboardColors();

  currentGuess = "";
  currentRow = Math.min(attempts.length, rows);

  if (solvedNow) {
    lockInput = true;
  }

  if (attempts.length >= rows && !solvedNow) {
    lockInput = true;
    showToast("No attempts left for this level.");
  }
}

async function loadAndApplyLevelState(level) {
  try {
    const ls = await fetchLevelState(level);
    applyLevelState(ls);
  } catch (e) {
    if (e?.status === 403 && e?.detail === "Locked level") {
      await refreshState();
      const next = nextUnlockedLevel();
      if (next !== level) {
        currentLevel = next;
        resetLevelState();
        renderBoard();
        renderLevelTrack();
        renderBotLevelTrack();
        await loadAndApplyLevelState(next);
      }
      return;
    }
    // ignore transient errors
  }
}

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";

  const len = lengthForLevel(currentLevel);
  const rows = attemptsForLevel(currentLevel);

  const rootStyle = getComputedStyle(document.documentElement);
  const tileSize = (rootStyle.getPropertyValue("--tile-size") || "50px").trim();

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement("div");
    rowEl.className = "board-row";
    rowEl.style.gridTemplateColumns = `repeat(${len}, ${tileSize})`;

    for (let c = 0; c < len; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      rowEl.appendChild(tile);
    }

    board.appendChild(rowEl);
  }
}

function updateKeyboardColors() {
  const keys = document.querySelectorAll("button.key");
  for (const btn of keys) {
    const k = btn.dataset.key;
    if (!k || k.length !== 1) continue;

    btn.classList.remove("absent", "present", "correct");
    const st = keyState[k];
    if (st) btn.classList.add(st);
  }
}

function setTile(row, col, letter, cls) {
  const tile = document.querySelector(`.tile[data-row='${row}'][data-col='${col}']`);
  if (!tile) return;

  tile.textContent = letter || "";
  tile.classList.toggle("filled", Boolean(letter));

  tile.classList.remove("absent", "present", "correct");
  if (cls) tile.classList.add(cls);
}

function paintCurrentGuess() {
  const len = lengthForLevel(currentLevel);
  for (let c = 0; c < len; c++) {
    const ch = currentGuess[c] || "";
    setTile(currentRow, c, ch, "");
  }
}

function mergeKeyState(letter, status) {
  const prev = keyState[letter];
  const rank = { absent: 1, present: 2, correct: 3 };
  if (!prev || rank[status] > rank[prev]) {
    keyState[letter] = status;
  }
}

async function submitGuess() {
  if (lockInput) return;

  if (isGuessOnCooldown()) {
    const left = Math.ceil((guessCooldownUntilMs - Date.now()) / 1000);
    setCooldownText(`Cooldown: ${left}s`);
    return;
  }

  if (botFinished && !isPlayerFinished()) {
    lockInput = true;
    showToast("AI finished first. Everyone loses.", { autoHide: false });
    return;
  }

  if (isSolved(currentLevel)) {
    showToast("This level is already solved.");
    return;
  }

  const len = lengthForLevel(currentLevel);
  if (currentGuess.length !== len) {
    showToast(`Need ${len} letters.`);
    return;
  }

  lockInput = true;

  try {
    const res = await fetch("/api/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: currentLevel, guess: currentGuess }),
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 403 && data?.detail === "AI finished") {
        botFinished = true;
        updateGameLockFromBot();
        showResultModal({
          type: "ai",
          title: "Too late",
          body: "The AI reached the seed phrase first.",
        });
        lockInput = true;
        return;
      }

      if (res.status === 403 && data?.detail === "Locked level") {
        showToast("Locked. Solve the next available level first.");
        await refreshState();
        lockInput = false;
        return;
      }

      if (res.status === 403 && data?.detail === "No attempts left") {
        lockInput = true;
        showResultModal({
          type: "lose",
          title: "No attempts left",
          body: "No more attempts for this level.",
        });
        return;
      }

      if (res.status === 409 && data?.detail === "Already solved") {
        await refreshState();
        showToast("This level is already solved.");
        lockInput = false;
        return;
      }

      if (res.status === 429 && data?.detail?.error === "cooldown") {
        const retryAfterSec = Number(data.detail.retry_after) || 30;
        startGuessCooldown(retryAfterSec * 1000);
        showToast(`Cooldown: ${retryAfterSec}s`);
      } else {
        showToast(data?.detail || "Invalid guess");
      }
      lockInput = false;
      return;
    }

    startGuessCooldown(GUESS_COOLDOWN_MS);
    for (let i = 0; i < data.result.length; i++) {
      setTile(currentRow, i, currentGuess[i], data.result[i]);
      mergeKeyState(currentGuess[i], data.result[i]);
    }

    updateKeyboardColors();

    if (data.is_correct) {
      playerSolved.add(currentLevel);
      renderLevelTrack();
      updateGameLockFromBot();

      lockInput = true;
      showResultModal({
        type: "win",
        title: "Correct!",
        body: "Level cleared.",
      });
      return;
    }

    currentRow += 1;
    currentGuess = "";

    if (currentRow >= attemptsForLevel(currentLevel)) {
      lockInput = true;
      showResultModal({
        type: "lose",
        title: "No attempts left",
        body: "No more attempts for this level.",
      });
      return;
    }

    showToast("Try again");
    lockInput = false;
  } catch (e) {
    showToast("Network error");
    lockInput = false;
  }
}

function onKey(key) {
  if (lockInput) return;

  const onCooldown = isGuessOnCooldown();

  if (key === "ENTER") {
    if (onCooldown) {
      const left = Math.ceil((guessCooldownUntilMs - Date.now()) / 1000);
      setCooldownText(`Cooldown: ${left}s`);
      return;
    }
    submitGuess();
    return;
  }

  if (key === "BACK") {
    currentGuess = currentGuess.slice(0, -1);
    paintCurrentGuess();
    return;
  }

  if (key.length === 1 && /[A-Z]/.test(key)) {
    if (isSolved(currentLevel)) {
      showToast("This level is already solved.");
      return;
    }

    const len = lengthForLevel(currentLevel);
    if (currentGuess.length >= len) return;

    currentGuess += key;
    paintCurrentGuess();
  }
}

function attachPhysicalKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (document.querySelector(".modal-backdrop.open")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = e.code;

    if (code === "Enter") {
      e.preventDefault();
      onKey("ENTER");
      return;
    }

    if (code === "Backspace") {
      e.preventDefault();
      onKey("BACK");
      return;
    }

    if (/^Key[A-Z]$/.test(code)) {
      e.preventDefault();
      onKey(code.slice(3));
    }
  });
}

async function refreshState() {
  try {
    const state = await fetchState();

    if (Array.isArray(state.levels)) {
      levels = state.levels;
    }
    botSolved = state.bot.solved;
    botTotal = state.bot.total;
    botFinished = Boolean(state.bot.finished);
    playerSolved = new Set(state.player?.solved_levels || []);

    renderLevelTrack();
    renderBotLevelTrack();
    updateGameLockFromBot();
  } catch {
    // ignore transient errors
  }
}

function startStatePoller() {
  if (statePoller) {
    clearInterval(statePoller);
    statePoller = null;
  }

  statePoller = setInterval(() => {
    refreshState();
  }, 5000);
}

function attachRulesModal() {
  const modal = document.getElementById("rulesModal");
  const openBtn = document.getElementById("rulesBtn");
  const closeBtn = document.getElementById("rulesCloseBtn");
  const minBtn = document.getElementById("rulesMinBtn");

  if (!modal || !openBtn || !closeBtn) return;

  const open = () => {
    modal.classList.add("open");
  };

  const close = () => {
    modal.classList.remove("open");
  };

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  if (minBtn) minBtn.addEventListener("click", close);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

function showResultModal({ type, title, body }) {
  const modal = document.getElementById("resultModal");
  const titleEl = document.getElementById("resultTitle");
  const bodyEl = document.getElementById("resultBody");
  const primaryBtn = document.getElementById("resultPrimaryBtn");
  const closeBtn = document.getElementById("resultCloseBtn");
  const minBtn = document.getElementById("resultMinBtn");

  if (!modal || !titleEl || !bodyEl || !primaryBtn || !closeBtn) return;

  titleEl.textContent = title;
  bodyEl.textContent = body;

  const close = () => {
    modal.classList.remove("open");
  };

  const primary = () => {
    if (type === "lose" || type === "ai") {
      close();
      return;
    }

    const next = nextUnlockedLevel();
    close();

    gotoLevel(next);
  };

  primaryBtn.textContent = type === "win" ? "Next" : "Close";
  primaryBtn.onclick = primary;
  closeBtn.onclick = () => {
    close();
  };
  if (minBtn) {
    minBtn.onclick = () => {
      close();
    };
  }

  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") close();
    },
    { once: true }
  );

  modal.classList.add("open");
}

async function main() {
  initMusic();
  createKeyboard();
  attachPhysicalKeyboard();
  attachRulesModal();
  setCooldownText("");

  try {
    const state = await fetchFullState();
    levels = state.levels || [];
    botSolved = state.bot.solved;
    botTotal = state.bot.total;
    botFinished = Boolean(state.bot.finished);
    playerSolved = new Set(state.player?.solved_levels || []);

    currentLevel = nextUnlockedLevel();
    renderBoard();
    renderLevelTrack();
    renderBotLevelTrack();
    await loadAndApplyLevelState(currentLevel);
    startStatePoller();
    updateGameLockFromBot();

    showToast("");
  } catch {
    showToast("Failed to load game state");
  }
}

main();
