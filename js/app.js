import { playSound, playSoundLater, stopMusic, toggleMute, isMuted, mediaUrl } from "./sounds.js?v=__V__";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const MAX_ANSWERS = 12; // most answers a board can hold
const MIN_SLOTS = 8; // the board always shows at least this many slots, like the show
const MAX_STRIKES = 3;
const FM_QUESTIONS = 5;
const FM_GOAL = 200; // Fast Money target, unless the game file sets "goal"
const FM_SECONDS = [20, 25]; // player 1, player 2, unless the game file sets "seconds"
const STORE_KEY = "familyfeud.state.v1";
const UNDO_LIMIT = 60;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = freshState();
let gameList = [];
let undoStack = []; // snapshots of state, newest last
let memberDrafts = ["", ""];
let saidDraft = "";

// Short-lived effects that shouldn't survive a refresh.
let flipIndex = null; // board tile that just flipped
let fmFlash = null; // Fast Money cell that was just filled, "player-question"
let bigX = null; // number of red X's on screen
let bigXTimer = null;
let clock = null; // Fast Money interval
let clockEndsAt = 0;

function freshState() {
  return {
    screen: "loader", // loader | setup | round | summary | fmIntro | fm
    game: null,
    gameId: null,
    teams: [newTeam(), newTeam()],
    roundIndex: 0,
    round: null,
    fm: null,
  };
}

function newTeam(name = "", members = []) {
  return { name, members, score: 0 };
}

function freshRound() {
  const n = state.game.rounds[state.roundIndex].answers.length;
  return {
    phase: "faceoff", // faceoff | play | steal | done
    revealed: Array(n).fill(false),
    late: Array(n).fill(false), // shown after the round was decided (no points)
    bank: 0,
    control: null, // team index playing the board
    strikes: 0,
    winner: null,
  };
}

function save() {
  try {
    if (state.game && state.screen !== "loader") localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

function savedGame() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.game && !(s.screen === "fm" && s.fm?.phase === "done") ? s : null;
  } catch {
    return null;
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const teamName = (i) => (state.teams[i].name || "").trim() || `Team ${i + 1}`;
// "The Smiths win" but "Team 1 wins"
const plural = (i) => /s$/i.test(teamName(i));
const wins = (i) => (plural(i) ? "win" : "wins");
const currentRound = () => state.game.rounds[state.roundIndex];
const isLastRound = () => state.roundIndex >= state.game.rounds.length - 1;
const fmGoal = () => Number(state.game.fastMoney?.goal) || FM_GOAL;
const fmSeconds = (p) => Number(state.game.fastMoney?.seconds?.[p]) || FM_SECONDS[p];
const fmPlayerName = (p) => (state.fm.players[p] || "").trim() || `Player ${p + 1}`;
const fmTotal = () => state.fm.answers.flat().reduce((sum, c) => sum + (c ? c.points : 0), 0);
const fmPlayerIndex = () => (state.fm.phase === "p1" || state.fm.phase === "r1" ? 0 : 1);

// Who's up for the face-off this round, if the teams have players listed.
function faceoffName(i) {
  const m = state.teams[i].members;
  return m.length ? m[state.roundIndex % m.length] : "";
}

function leader() {
  const [a, b] = state.teams;
  return a.score === b.score ? null : a.score > b.score ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Loading games
// ---------------------------------------------------------------------------

function checkAnswers(list, where) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where} needs an "answers" list.`);
  if (list.length > MAX_ANSWERS) throw new Error(`${where} has ${list.length} answers; the board fits ${MAX_ANSWERS}.`);
  list.forEach((a, i) => {
    if (!a || a.answer === undefined || a.answer === "" || !Number.isFinite(Number(a.points)))
      throw new Error(`${where}, answer ${i + 1} needs an "answer" and a number of "points".`);
    a.points = Number(a.points);
  });
  // Highest answer goes on top, like the real board. Ties keep file order.
  return list.map((a, i) => [a, i]).sort(([a, ai], [b, bi]) => b.points - a.points || ai - bi).map(([a]) => a);
}

function validateGame(g) {
  if (!g || !Array.isArray(g.rounds) || g.rounds.length === 0) throw new Error('The file needs a "rounds" list.');
  g.rounds.forEach((r, i) => {
    if (!r.question) throw new Error(`Round ${i + 1} needs a "question".`);
    r.answers = checkAnswers(r.answers, `Round ${i + 1}`);
  });
  if (g.fastMoney) {
    const qs = g.fastMoney.questions;
    if (!Array.isArray(qs) || qs.length !== FM_QUESTIONS)
      throw new Error(`Fast Money needs exactly ${FM_QUESTIONS} "questions".`);
    qs.forEach((q, i) => {
      if (!q.question) throw new Error(`Fast Money question ${i + 1} needs a "question".`);
      q.answers = checkAnswers(q.answers, `Fast Money question ${i + 1}`);
    });
  }
  return g;
}

async function loadGameById(id) {
  const res = await fetch(`games/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't find games/${id}.json`);
  startSetup(validateGame(await res.json()), id);
}

function startSetup(game, id) {
  const keep = state.teams.map((t) => newTeam(t.name, [...t.members]));
  stopClock();
  state = freshState();
  state.teams = keep;
  state.game = game;
  state.gameId = id;
  state.screen = "setup";
  undoStack = [];
  playSound("theme");
  render();
}

// ---------------------------------------------------------------------------
// Main game
// ---------------------------------------------------------------------------

function revealAnswer(i) {
  const r = state.round;
  if (!r || !Number.isInteger(i) || i < 0 || i >= r.revealed.length || r.revealed[i]) return;
  snapshot();
  r.revealed[i] = true;
  flipIndex = i;
  playSound("reveal");
  if (r.phase === "done") {
    r.late[i] = true; // just showing what was left; no points
    return render();
  }
  r.bank += currentRound().answers[i].points;
  if (r.phase === "steal") award(1 - r.control);
  else if (r.phase === "play" && r.revealed.every(Boolean)) award(r.control);
  render();
}

function strike() {
  const r = state.round;
  if (!r) return;
  if (r.phase === "faceoff") return showX(1); // a miss in the face-off isn't a strike
  if (r.phase === "play") {
    snapshot();
    r.strikes++;
    showX(r.strikes);
    if (r.strikes >= MAX_STRIKES) r.phase = "steal";
    return render();
  }
  if (r.phase === "steal") {
    snapshot();
    showX(1);
    award(r.control);
    render();
  }
}

function giveControl(team) {
  const r = state.round;
  if (!r || r.phase !== "faceoff") return;
  snapshot();
  r.control = team;
  r.phase = "play";
  if (r.revealed.every(Boolean)) award(team);
  render();
}

function award(team) {
  const r = state.round;
  r.winner = team;
  r.phase = "done";
  state.teams[team].score += r.bank;
  playSoundLater("win", 650);
}

function showX(count) {
  bigX = count;
  playSound("strike");
  clearTimeout(bigXTimer);
  bigXTimer = setTimeout(() => {
    bigX = null;
    render();
  }, 1300);
  render();
}

function toSummary() {
  state.round = null;
  state.screen = "summary";
  playSound("winner");
  render();
}

// ---------------------------------------------------------------------------
// Fast Money
// ---------------------------------------------------------------------------

function fmDefaultPlayers(team) {
  const m = state.teams[team].members;
  return [m[0] || "", m[1] || ""];
}

function startClock() {
  const fm = state.fm;
  if (fm.running || fm.timeLeft <= 0) return;
  fm.running = true;
  clockEndsAt = Date.now() + fm.timeLeft * 1000;
  playSound("clock");
  clock = setInterval(tick, 100);
  render();
}

function pauseClock() {
  const fm = state.fm;
  if (!fm?.running) return;
  fm.timeLeft = Math.max(0, (clockEndsAt - Date.now()) / 1000);
  stopClock();
  render();
}

function stopClock() {
  clearInterval(clock);
  clock = null;
  if (state.fm) state.fm.running = false;
  stopMusic();
}

function tick() {
  const fm = state.fm;
  if (!fm || state.screen !== "fm") return stopClock();
  const left = (clockEndsAt - Date.now()) / 1000;
  if (left <= 0) {
    fm.timeLeft = 0;
    stopClock();
    playSound("timer");
    return render();
  }
  fm.timeLeft = left;
  const el = document.getElementById("fm-timer");
  if (el) el.textContent = Math.ceil(left);
  const bar = document.getElementById("fm-bar");
  if (bar) bar.style.width = `${(left / fmSeconds(fmPlayerIndex())) * 100}%`;
}

function firstOpenCell(p, after = -1) {
  const col = state.fm.answers[p];
  for (let k = 1; k <= FM_QUESTIONS; k++) {
    const q = (after + k) % FM_QUESTIONS;
    if (!col[q]) return q;
  }
  return -1;
}

function pickFm(idx) {
  const fm = state.fm;
  if (fm.phase !== "r1" && fm.phase !== "r2") return;
  if (fm.sel < 0) return;
  const p = fmPlayerIndex();
  const q = fm.sel;
  const answers = state.game.fastMoney.questions[q].answers;
  if (idx >= answers.length) return;
  snapshot();
  const said = saidDraft.trim();
  const points = idx >= 0 ? answers[idx].points : 0;
  const text = said || (idx >= 0 ? answers[idx].answer : idx === -1 ? "Not on the board" : "Pass");
  fm.answers[p][q] = { text, points, match: idx };
  saidDraft = "";
  fmFlash = `${p}-${q}`;
  playSoundLater(points > 0 ? "reveal" : "strike", 700);
  fm.sel = firstOpenCell(p, q);
  render();
}

function fmFinish() {
  const fm = state.fm;
  fm.phase = "done";
  fm.sel = -1;
  clearSaved();
  playSoundLater(fmTotal() >= fmGoal() ? "winner" : "strike", 300);
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions = {
  loadGame: async ({ id }) => {
    try {
      await loadGameById(id);
    } catch (e) {
      alert(e.message);
    }
  },
  resume: () => {
    const s = savedGame();
    if (!s) return;
    state = s;
    if (state.fm) state.fm.running = false; // the clock waits for the host
    undoStack = [];
    if (state.screen === "setup") playSound("theme");
    if (state.screen === "fmIntro") playSound("fastMoney");
    render();
  },
  pickFile: () => document.getElementById("file-input")?.click(),

  addMember: ({ team }) => {
    const i = Number(team);
    const input = document.getElementById(`member-${i}`);
    const name = String(input ? input.value : memberDrafts[i]).trim();
    if (name) state.teams[i].members.push(name);
    memberDrafts[i] = "";
    render();
    document.getElementById(`member-${i}`)?.focus();
  },
  removeMember: ({ team, index }) => {
    state.teams[Number(team)].members.splice(Number(index), 1);
    render();
  },
  startGame: () => {
    state.teams.forEach((t) => (t.score = 0));
    state.roundIndex = 0;
    state.round = freshRound();
    state.screen = "round";
    undoStack = [];
    stopMusic();
    render();
  },
  backToLoader: () => {
    stopClock();
    const keep = state.teams.map((t) => newTeam(t.name, [...t.members]));
    state = freshState();
    state.teams = keep;
    undoStack = [];
    clearSaved();
    playSound("theme");
    render();
  },

  revealAnswer: ({ i }) => revealAnswer(Number(i)),
  strike: () => strike(),
  giveControl: ({ team }) => giveControl(Number(team)),
  nextRound: () => {
    const r = state.round;
    if (!r || r.phase !== "done") return;
    snapshot();
    if (isLastRound()) return toSummary();
    state.roundIndex++;
    state.round = freshRound();
    render();
  },
  endMainGame: () => {
    if (!confirm("End the main game and go to the final scores?")) return;
    snapshot();
    toSummary();
  },
  undo: () => {
    if (!undoStack.length) return;
    if (clock) stopClock();
    state = JSON.parse(undoStack.pop());
    if (state.fm) state.fm.running = false;
    flipIndex = null;
    fmFlash = null;
    bigX = null;
    saidDraft = "";
    render();
  },

  toFastMoney: () => {
    if (!state.game.fastMoney) return;
    snapshot();
    const team = leader() ?? 0;
    state.fm = { team, players: fmDefaultPlayers(team), phase: "intro" };
    state.screen = "fmIntro";
    playSound("fastMoney");
    render();
  },
  setFmTeam: ({ team }) => {
    const t = Number(team);
    state.fm.team = t;
    state.fm.players = fmDefaultPlayers(t);
    render();
  },
  startFm: () => {
    const fm = state.fm;
    snapshot();
    Object.assign(fm, {
      phase: "p1",
      q: 0,
      timeLeft: fmSeconds(0),
      running: false,
      sel: 0,
      answers: [Array(FM_QUESTIONS).fill(null), Array(FM_QUESTIONS).fill(null)],
    });
    state.screen = "fm";
    stopMusic();
    render();
  },
  clockToggle: () => {
    const fm = state.fm;
    if (fm.phase !== "p1" && fm.phase !== "p2") return;
    if (fm.running) pauseClock();
    else startClock();
  },
  fmNav: ({ dir }) => {
    const fm = state.fm;
    if (fm.phase !== "p1" && fm.phase !== "p2") return;
    fm.q = Math.min(FM_QUESTIONS - 1, Math.max(0, fm.q + Number(dir)));
    render();
  },
  dupe: () => playSound("dupe"),
  toReveal: () => {
    const fm = state.fm;
    if (fm.phase !== "p1" && fm.phase !== "p2") return;
    if (fm.running) pauseClock();
    snapshot();
    fm.phase = fm.phase === "p1" ? "r1" : "r2";
    fm.sel = firstOpenCell(fmPlayerIndex());
    saidDraft = "";
    render();
  },
  selectFmCell: ({ p, q }) => {
    const fm = state.fm;
    if (Number(p) !== fmPlayerIndex() || (fm.phase !== "r1" && fm.phase !== "r2")) return;
    fm.sel = Number(q);
    saidDraft = "";
    render();
    document.getElementById("fm-said")?.focus();
  },
  pickFm: ({ idx }) => pickFm(Number(idx)),
  fmNext: () => {
    const fm = state.fm;
    const p = fmPlayerIndex();
    if ((fm.phase !== "r1" && fm.phase !== "r2") || fm.answers[p].some((c) => !c)) return;
    snapshot();
    if (fm.phase === "r2" || fmTotal() >= fmGoal()) return fmFinish();
    Object.assign(fm, { phase: "p2", q: 0, timeLeft: fmSeconds(1), running: false, sel: 0 });
    render();
  },

  playAgain: () => {
    clearSaved();
    startSetup(state.game, state.gameId); // same teams, fresh scores
  },
  toggleMute: () => {
    toggleMute();
    render();
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let lastScreen = null;

function render() {
  const app = document.getElementById("app");
  const view = state.screen + (state.fm?.phase || "");
  const screens = {
    loader: renderLoader,
    setup: renderSetup,
    round: renderRound,
    summary: renderSummary,
    fmIntro: renderFmIntro,
    fm: renderFm,
  };
  app.innerHTML = screens[state.screen]() + renderBigX() + renderMute();
  flipIndex = null;
  fmFlash = null;
  if (view !== lastScreen) window.scrollTo(0, 0);
  lastScreen = view;
  save();
  wireInputs();
}

// Text boxes keep their values across re-renders.
function wireInputs() {
  state.teams.forEach((t, i) => {
    const name = document.getElementById(`team-name-${i}`);
    if (name) {
      name.value = t.name;
      name.addEventListener("input", (e) => {
        t.name = e.target.value;
        save();
      });
    }
    const member = document.getElementById(`member-${i}`);
    if (member) {
      member.value = memberDrafts[i];
      member.addEventListener("input", (e) => (memberDrafts[i] = e.target.value));
    }
  });
  [0, 1].forEach((p) => {
    const el = document.getElementById(`fm-player-${p}`);
    if (el) {
      el.value = state.fm.players[p];
      el.addEventListener("input", (e) => {
        state.fm.players[p] = e.target.value;
        save();
      });
    }
  });
  const said = document.getElementById("fm-said");
  if (said) {
    said.value = saidDraft;
    said.addEventListener("input", (e) => (saidDraft = e.target.value));
  }
}

function renderMute() {
  return `<button class="mute" data-action="toggleMute" title="Mute (M)">${isMuted() ? "🔇" : "🔊"}</button>`;
}

function renderBigX() {
  if (!bigX) return "";
  return `<div class="big-x" aria-live="assertive">${Array.from({ length: bigX }, () => `<span>✕</span>`).join("")}</div>`;
}

function logo(small = false) {
  return `<div class="logo ${small ? "logo-small" : ""}">
    <div class="marquee"><span class="logo-family">Family</span><span class="logo-feud">Feud</span></div>
  </div>`;
}

function topbar(middle, buttons = "") {
  return `<header class="topbar">
    ${logo(true)}
    <div class="topbar-info">${middle}</div>
    <div class="row">${buttons}</div>
  </header>`;
}

function undoButton() {
  return `<button class="btn btn-ghost small" data-action="undo" ${undoStack.length ? "" : "disabled"} title="Undo (Z)">↶ Undo</button>`;
}

function renderLoader() {
  const resume = savedGame();
  const games = gameList.length
    ? gameList
        .map(
          (g) => `<button class="episode" data-action="loadGame" data-id="${esc(g.id)}">
            <span class="episode-title">${esc(g.title)}</span>
            ${g.description ? `<span class="episode-desc">${esc(g.description)}</span>` : ""}
          </button>`
        )
        .join("")
    : `<p class="muted">No games listed in games/index.json yet.</p>`;
  return `<main class="screen loader">
    ${logo()}
    <section class="card">
      ${resume ? `<button class="btn btn-gold wide" data-action="resume">Resume game in progress · ${esc(resume.game.title || "")}</button>` : ""}
      <h2>Pick an episode</h2>
      <div class="episodes">${games}</div>
      <button class="btn btn-ghost" data-action="pickFile">Load a game file…</button>
      <input type="file" id="file-input" accept=".json,application/json" hidden />
    </section>
  </main>`;
}

function renderSetup() {
  const g = state.game;
  const teamCard = (t, i) => `<div class="team-card team-${i}">
      <label class="field">
        <span>Team ${i + 1}</span>
        <input id="team-name-${i}" placeholder="${i ? "e.g. The Joneses" : "e.g. The Smiths"}" autocomplete="off" maxlength="28" />
      </label>
      <form class="add-player" onsubmit="return false">
        <input id="member-${i}" data-team="${i}" placeholder="Add a player" autocomplete="off" maxlength="24" />
        <button class="btn btn-gold small" data-action="addMember" data-team="${i}">Add</button>
      </form>
      <ul class="roster">
        ${t.members
          .map(
            (m, k) => `<li><span>${esc(m)}</span><button class="x" data-action="removeMember" data-team="${i}" data-index="${k}" aria-label="Remove">×</button></li>`
          )
          .join("")}
      </ul>
    </div>`;
  return `<main class="screen setup">
    ${logo(true)}
    <section class="card card-wide">
      <p class="eyebrow">${esc(g.title || "Custom game")}</p>
      <h2>Meet the families</h2>
      <div class="team-setup">${state.teams.map(teamCard).join('<div class="vs">vs</div>')}</div>
      <p class="muted small">Players are optional. List them in face-off order and the board will show who's up each round.</p>
      <details class="rules">
        <summary>How it works</summary>
        <ul>
          <li>${g.rounds.length} rounds, each with a survey question. One player from each team faces off: whoever buzzes in first answers.</li>
          <li>The host clicks the answer on the board (or presses its number). Not on the board? Press <b>X</b>.</li>
          <li>The team that wins the face-off plays the board (or passes it). Teammates take turns guessing, and every answer they find adds to the bank.</li>
          <li>Three strikes and the other team gets one guess to steal the whole bank. Clear the board and you keep it.</li>
          ${
            g.fastMoney
              ? `<li>After the last round, the team with the most points plays <b>Fast Money</b>: two players, five questions, ${fmSeconds(0)} and ${fmSeconds(1)} seconds. Score ${fmGoal()} points between them to win.</li>`
              : ""
          }
        </ul>
      </details>
      <div class="row">
        <button class="btn btn-ghost" data-action="backToLoader">Back</button>
        <button class="btn btn-orange" data-action="startGame">Let's play the Feud →</button>
      </div>
    </section>
  </main>`;
}

function renderMedia(q) {
  let html = "";
  if (q.image) html += `<img class="media" src="${esc(mediaUrl(q.image))}" alt="" />`;
  if (q.audio) html += `<audio class="media" controls src="${esc(mediaUrl(q.audio))}"></audio>`;
  if (q.video) html += `<video class="media" controls src="${esc(mediaUrl(q.video))}"></video>`;
  return html ? `<div class="media-wrap">${html}</div>` : "";
}

function strikeMarks(count) {
  return `<div class="strikes">${Array.from({ length: MAX_STRIKES }, (_, k) => `<span class="${k < count ? "on" : ""}">✕</span>`).join("")}</div>`;
}

function teamPanel(i) {
  const t = state.teams[i];
  const r = state.round;
  const playing = r.control === i && r.phase === "play";
  const stealing = r.phase === "steal" && r.control !== i;
  const won = r.phase === "done" && r.winner === i;
  const fo = r.phase === "faceoff" ? faceoffName(i) : "";
  const badge = playing
    ? `<span class="badge">Playing the board</span>`
    : stealing
    ? `<span class="badge steal">Steal!</span>`
    : won
    ? `<span class="badge win">+${r.bank}</span>`
    : "";
  return `<aside class="team team-${i} ${playing ? "playing" : ""} ${stealing ? "stealing" : ""} ${won ? "won" : ""}">
    <div class="team-name">${esc(teamName(i))}</div>
    <div class="team-score">${t.score}</div>
    ${badge}
    ${r.control === i && r.strikes ? strikeMarks(r.strikes) : ""}
    ${fo ? `<div class="faceoff-name"><span>Face-off</span>${esc(fo)}</div>` : ""}
  </aside>`;
}

function answerSlot(i, answers) {
  const r = state.round;
  if (i >= answers.length) return `<div class="slot blank"></div>`;
  if (!r.revealed[i])
    return `<button class="slot hidden" data-action="revealAnswer" data-i="${i}" title="${i < 10 ? `Reveal (${(i + 1) % 10})` : "Reveal"}"><span class="slot-num">${i + 1}</span></button>`;
  const a = answers[i];
  return `<div class="slot open ${r.late[i] ? "late" : ""} ${flipIndex === i ? "flip" : ""}">
    <span class="slot-text">${esc(a.answer)}</span>
    <span class="slot-pts">${a.points}</span>
  </div>`;
}

function hostControls() {
  const r = state.round;
  const A = esc(teamName(0));
  const B = esc(teamName(1));
  if (r.phase === "faceoff") {
    const fo = faceoffName(0) && faceoffName(1) ? `${esc(faceoffName(0))} vs ${esc(faceoffName(1))} · ` : "";
    return `<div class="host-say">${fo}Face-off! Reveal what they say, then pick who plays.</div>
      <div class="row">
        <button class="btn btn-team0" data-action="giveControl" data-team="0">← ${A} ${plural(0) ? "play" : "plays"}</button>
        <button class="btn btn-red" data-action="strike">✕ Not on the board (X)</button>
        <button class="btn btn-team1" data-action="giveControl" data-team="1">${B} ${plural(1) ? "play" : "plays"} →</button>
      </div>`;
  }
  if (r.phase === "play") {
    return `<div class="host-say"><b>${esc(teamName(r.control))}</b> ${plural(r.control) ? "are" : "is"} playing · ${r.strikes} of ${MAX_STRIKES} strikes</div>
      <div class="row"><button class="btn btn-red" data-action="strike">✕ Strike (X)</button></div>`;
  }
  if (r.phase === "steal") {
    return `<div class="host-say"><b>${esc(teamName(1 - r.control))}</b> can steal! Talk it over, then one answer. Right? Click it.</div>
      <div class="row"><button class="btn btn-red" data-action="strike">✕ Steal fails (X)</button></div>`;
  }
  const hidden = r.revealed.some((v) => !v);
  return `<div class="host-say"><b>${esc(teamName(r.winner))}</b> ${wins(r.winner)} ${r.bank} point${r.bank === 1 ? "" : "s"}!${hidden ? " Click any hidden answers to show what was left." : ""}</div>
    <div class="row"><button class="btn btn-orange" data-action="nextRound">${isLastRound() ? "Final scores" : "Next round"} (Space)</button></div>`;
}

function renderRound() {
  const rd = currentRound();
  const r = state.round;
  const count = Math.max(MIN_SLOTS, rd.answers.length + (rd.answers.length % 2)); // two even columns
  const slots = Array.from({ length: count }, (_, i) => answerSlot(i, rd.answers)).join("");
  return `<main class="screen round phase-${r.phase}">
    ${topbar(
      `<div class="eyebrow">Round ${state.roundIndex + 1} of ${state.game.rounds.length}</div>`,
      `${undoButton()}<button class="btn btn-ghost small" data-action="endMainGame">End game</button>`
    )}
    <div class="stage">
      ${teamPanel(0)}
      <section class="board-wrap">
        <div class="survey">
          <span class="survey-label">${rd.source ? `Survey · ${esc(rd.source)}` : "We surveyed 100 people"}</span>
          <div class="survey-q">${esc(rd.question)}</div>
          ${renderMedia(rd)}
        </div>
        <div class="bank"><span>${r.bank}</span></div>
        <div class="board" style="--rows:${count / 2}">${slots}</div>
      </section>
      ${teamPanel(1)}
    </div>
    <footer class="hostbar">${hostControls()}</footer>
  </main>`;
}

function renderSummary() {
  const lead = leader();
  const headline = lead === null ? "It's a tie!" : `${esc(teamName(lead))} ${wins(lead)}!`;
  const fm = state.game.fastMoney;
  return `<main class="screen summary">
    ${logo(true)}
    <h1 class="headline">${headline}</h1>
    <div class="final-scores">
      ${state.teams
        .map(
          (t, i) => `<div class="final-team team-${i} ${lead === i ? "win" : ""}">
            <div class="team-name">${esc(teamName(i))}</div>
            <div class="team-score">${t.score}</div>
          </div>`
        )
        .join("")}
    </div>
    <div class="row">
      ${undoButton()}
      <button class="btn btn-ghost" data-action="backToLoader">Pick another episode</button>
      <button class="btn btn-ghost" data-action="playAgain">Play this episode again</button>
      ${fm ? `<button class="btn btn-orange" data-action="toFastMoney">Play Fast Money → (Space)</button>` : ""}
    </div>
  </main>`;
}

function renderFmIntro() {
  const fm = state.fm;
  const prize = state.game.fastMoney.prize;
  return `<main class="screen fm-intro">
    <div class="fm-title">Fast Money</div>
    <section class="card">
      <p class="eyebrow">Who's playing?</p>
      <div class="row">
        ${[0, 1]
          .map(
            (i) => `<button class="chip-btn ${fm.team === i ? "active" : ""}" data-action="setFmTeam" data-team="${i}">${esc(teamName(i))}</button>`
          )
          .join("")}
      </div>
      <div class="fm-players">
        ${[0, 1]
          .map(
            (p) => `<label class="field"><span>Player ${p + 1} · ${fmSeconds(p)} seconds</span>
              <input id="fm-player-${p}" placeholder="Player ${p + 1}" autocomplete="off" maxlength="24" /></label>`
          )
          .join("")}
      </div>
      <ul class="fm-rules">
        <li>Player 2 leaves the room. Player 1 answers ${FM_QUESTIONS} questions in ${fmSeconds(0)} seconds.</li>
        <li>Player 2 comes back, Player 1's answers are hidden, and they get ${fmSeconds(1)} seconds. Repeat an answer and they hear the buzzer and try again.</li>
        <li>${fmGoal()} points between them wins${prize ? ` <b>${esc(prize)}</b>` : ""}.</li>
      </ul>
      <div class="row">
        ${undoButton()}
        <button class="btn btn-orange" data-action="startFm">Start with ${esc(fmPlayerName(0))} (Space)</button>
      </div>
    </section>
  </main>`;
}

function renderFm() {
  const fm = state.fm;
  if (fm.phase === "p1" || fm.phase === "p2") return renderFmClock();
  return renderFmBoard();
}

function renderFmClock() {
  const fm = state.fm;
  const p = fmPlayerIndex();
  const qs = state.game.fastMoney.questions;
  const secs = fmSeconds(p);
  const out = fm.timeLeft <= 0;
  const left = Math.ceil(fm.timeLeft);
  return `<main class="screen fm answering">
    ${topbar(`<div class="eyebrow">Fast Money · ${esc(fmPlayerName(p))}</div>`, undoButton())}
    <div class="fm-clock ${out ? "out" : ""} ${fm.running ? "running" : ""}">
      <span id="fm-timer">${out ? "0" : left}</span>
      <div class="fm-bar"><div id="fm-bar" style="width:${(fm.timeLeft / secs) * 100}%"></div></div>
    </div>
    <div class="fm-q">
      <div class="eyebrow">Question ${fm.q + 1} of ${FM_QUESTIONS}</div>
      <div class="fm-qtext">${esc(qs[fm.q].question)}</div>
      ${renderMedia(qs[fm.q])}
    </div>
    <ol class="fm-qlist">${qs.map((q, i) => `<li class="${i === fm.q ? "on" : ""}">${esc(q.question)}</li>`).join("")}</ol>
    <footer class="hostbar">
      <div class="host-say">${
        out
          ? "Time! Now reveal the answers."
          : p === 1
          ? `Player 1's answers stay hidden. Repeat one? Hit <b>Try again</b>.`
          : "Read each question; write down what they say. Use → for the next one."
      }</div>
      <div class="row">
        <button class="btn btn-ghost" data-action="fmNav" data-dir="-1" ${fm.q === 0 ? "disabled" : ""}>←</button>
        ${
          out
            ? ""
            : `<button class="btn ${fm.running ? "btn-ghost" : "btn-gold"}" data-action="clockToggle">${fm.running ? "Pause clock" : left < secs ? "Resume clock" : "Start the clock"} (Space)</button>`
        }
        <button class="btn btn-ghost" data-action="fmNav" data-dir="1" ${fm.q === FM_QUESTIONS - 1 ? "disabled" : ""}>→</button>
        ${p === 1 ? `<button class="btn btn-red" data-action="dupe">Try again (D)</button>` : ""}
        <button class="btn btn-orange" data-action="toReveal">Reveal answers${out ? " (Space)" : ""}</button>
      </div>
    </footer>
  </main>`;
}

function fmCell(p, q) {
  const fm = state.fm;
  const cell = fm.answers[p][q];
  const active = (fm.phase === "r1" || fm.phase === "r2") && p === fmPlayerIndex();
  const sel = active && fm.sel === q;
  // Player 2 can't see player 1's answers until their own turn is revealed.
  const hide = p === 1 && fm.phase === "r1";
  const inner = hide
    ? ""
    : cell
    ? `<span class="fm-text">${esc(cell.text)}</span><span class="fm-pts ${cell.points ? "" : "zero"}">${cell.points}</span>`
    : "";
  const cls = `fm-cell ${cell && !hide ? "filled" : ""} ${sel ? "sel" : ""} ${fmFlash === `${p}-${q}` ? "flash" : ""}`;
  return active
    ? `<button class="${cls}" data-action="selectFmCell" data-p="${p}" data-q="${q}">${inner}</button>`
    : `<div class="${cls}">${inner}</div>`;
}

function renderPicker() {
  const fm = state.fm;
  const p = fmPlayerIndex();
  if (fm.phase === "done") return "";
  if (fm.sel < 0) {
    const winNow = fm.phase === "r1" && fmTotal() >= fmGoal();
    return `<section class="picker done">
      <div class="host-say">${
        fm.phase === "r2" ? "That's all ten answers." : winNow ? `${fmTotal()} already. No need for Player 2!` : `Send in ${esc(fmPlayerName(1))}.`
      }</div>
      <div class="row">
        ${undoButton()}
        <button class="btn btn-orange" data-action="fmNext">${fm.phase === "r2" || winNow ? "Final total" : `${esc(fmPlayerName(1))} plays`} (Space)</button>
      </div>
    </section>`;
  }
  const q = state.game.fastMoney.questions[fm.sel];
  const p1 = p === 1 ? fm.answers[0][fm.sel] : null;
  return `<section class="picker">
    <div class="eyebrow">${esc(fmPlayerName(p))} · Question ${fm.sel + 1}</div>
    <div class="picker-q">${esc(q.question)}</div>
    <input id="fm-said" placeholder="What they said (optional, shows on the board)" autocomplete="off" maxlength="40" />
    <div class="picks">
      ${q.answers
        .map(
          (a, i) => `<button class="pick" data-action="pickFm" data-idx="${i}">
            <kbd>${i < 9 ? i + 1 : "·"}</kbd><span>${esc(a.answer)}</span>${p1 && p1.match === i ? `<em>Player 1</em>` : ""}<b>${a.points}</b>
          </button>`
        )
        .join("")}
      <button class="pick miss" data-action="pickFm" data-idx="-1"><kbd>0</kbd><span>Not on the board</span><b>0</b></button>
      <button class="pick miss" data-action="pickFm" data-idx="-2"><kbd>P</kbd><span>Passed / no answer</span><b>0</b></button>
    </div>
    <div class="row">${undoButton()}</div>
  </section>`;
}

function renderFmBoard() {
  const fm = state.fm;
  const total = fmTotal();
  const goal = fmGoal();
  const done = fm.phase === "done";
  const won = total >= goal;
  const prize = state.game.fastMoney.prize;
  const head = done
    ? won
      ? `<h1 class="headline">${esc(teamName(fm.team))} ${wins(fm.team)} Fast Money!</h1>${prize ? `<p class="prize">${esc(prize)}</p>` : ""}`
      : `<h1 class="headline">So close!</h1><p class="muted">${goal - total} point${goal - total === 1 ? "" : "s"} short.</p>`
    : "";
  return `<main class="screen fm reveal ${done ? "fm-done" : ""} ${done && won ? "fm-won" : ""}">
    ${topbar(`<div class="eyebrow">Fast Money · ${esc(teamName(fm.team))}</div>`)}
    ${head}
    <div class="fm-layout">
      <section class="fm-board">
        <div class="fm-heads"><span>${esc(fmPlayerName(0))}</span><span>${esc(fmPlayerName(1))}</span></div>
        ${Array.from({ length: FM_QUESTIONS }, (_, q) => `<div class="fm-row">${fmCell(0, q)}${fmCell(1, q)}</div>`).join("")}
        <div class="fm-total ${won ? "won" : ""}"><span>Total</span><b>${total}</b><span class="goal">of ${goal}</span></div>
      </section>
      ${renderPicker()}
    </div>
    ${
      done
        ? `<div class="row">
            <button class="btn btn-ghost" data-action="backToLoader">Pick another episode</button>
            <button class="btn btn-orange" data-action="playAgain">Play this episode again</button>
          </div>`
        : ""
    }
  </main>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  e.preventDefault();
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset);
});

document.addEventListener("change", async (e) => {
  if (e.target.id !== "file-input" || !e.target.files?.[0]) return;
  try {
    const game = validateGame(JSON.parse(await e.target.files[0].text()));
    startSetup(game, null);
  } catch (err) {
    alert(`Couldn't load that file: ${err.message}`);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
  if (typing) {
    const m = /^member-(\d)$/.exec(e.target.id);
    if (e.key === "Enter" && m) {
      e.preventDefault();
      actions.addMember({ team: m[1] });
    }
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "m") return actions.toggleMute();
  if (key === "z") return actions.undo();
  const space = key === " " || (key === "Enter" && e.target.tagName !== "BUTTON");
  const fm = state.fm;

  if (state.screen === "round") {
    const r = state.round;
    if (/^[1-9]$/.test(key)) return revealAnswer(Number(key) - 1);
    if (key === "0") return revealAnswer(9);
    if (key === "x") return strike();
    if (r.phase === "faceoff" && key === "ArrowLeft") return giveControl(0);
    if (r.phase === "faceoff" && key === "ArrowRight") return giveControl(1);
    if (space && r.phase === "done") {
      e.preventDefault();
      return actions.nextRound();
    }
    if (key === " ") e.preventDefault();
    return;
  }
  if (state.screen === "summary" && space && state.game.fastMoney) {
    e.preventDefault();
    return actions.toFastMoney();
  }
  if (state.screen === "fmIntro" && space) {
    e.preventDefault();
    return actions.startFm();
  }
  if (state.screen === "fm" && (fm.phase === "p1" || fm.phase === "p2")) {
    if (space) {
      e.preventDefault();
      return fm.timeLeft <= 0 ? actions.toReveal() : actions.clockToggle();
    }
    if (key === "ArrowRight") return actions.fmNav({ dir: 1 });
    if (key === "ArrowLeft") return actions.fmNav({ dir: -1 });
    if (key === "d") return actions.dupe();
    return;
  }
  if (state.screen === "fm" && (fm.phase === "r1" || fm.phase === "r2")) {
    if (fm.sel >= 0) {
      if (/^[1-9]$/.test(key)) return pickFm(Number(key) - 1);
      if (key === "0") return pickFm(-1);
      if (key === "p") return pickFm(-2);
    } else if (space) {
      e.preventDefault();
      return actions.fmNext();
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  try {
    const res = await fetch("games/index.json", { cache: "no-cache" });
    gameList = res.ok ? await res.json() : [];
  } catch {
    gameList = [];
  }
  const id = new URLSearchParams(location.search).get("game");
  // A refresh mid-game shows the Resume button instead of starting over.
  if (id && !savedGame()) {
    try {
      await loadGameById(id);
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  render();
}

init();
