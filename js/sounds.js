// Sound cues for the game. Audio files live in the sounds/ folder.
// Change the file names in SOUND_FILES to swap which sound plays when.
// Music cues loop in the background; the short cues play over the top.
// If a file is missing, the short cues fall back to a simple built-in tone,
// and the music cues are just skipped. Press "M" during a game to mute.

const SOUND_FILES = {
  // Music (loops)
  theme: "theme.mp3", // title screen and team setup
  fastMoney: "fast-money.mp3", // Fast Money intro
  clock: "clock.mp3", // while the Fast Money clock is running

  // Short cues
  reveal: "ding.mp3", // an answer flips over on the board
  strike: "strike.mp3", // the big red X
  win: "round-win.mp3", // a team banks the round's points
  dupe: "try-again.mp3", // Fast Money: player 2 repeated an answer (the "eh-eh" buzzer)
  timer: "times-up.mp3", // Fast Money: the clock runs out
  winner: "winner.mp3", // final results
};

const MUSIC = new Set(["theme", "fastMoney", "clock"]);

let music = null;
let musicName = null;
let muted = false;
let ctx = null;
const missing = new Set();

export function mediaUrl(path) {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return path.replace(/^\/+/, "");
}

export function playSound(name) {
  if (MUSIC.has(name)) return playMusic(name);
  if (name === "winner") stopMusic();
  if (muted) return;
  const file = SOUND_FILES[name];
  if (!file || missing.has(name)) return synth(name);
  const audio = new Audio(`sounds/${file}`);
  audio.addEventListener(
    "error",
    () => {
      missing.add(name);
      synth(name);
    },
    { once: true }
  );
  // A blocked autoplay just fails quietly.
  audio.play().catch(() => {});
}

// Play a short cue a moment from now, e.g. after a tile finishes flipping.
export function playSoundLater(name, ms) {
  setTimeout(() => playSound(name), ms);
}

function playMusic(name) {
  if (musicName === name && music) return; // already playing
  stopMusic();
  if (muted) return;
  const file = SOUND_FILES[name];
  if (!file || missing.has(name)) return;
  const audio = new Audio(`sounds/${file}`);
  audio.loop = true;
  music = audio;
  musicName = name;
  audio.addEventListener(
    "error",
    () => {
      missing.add(name);
      if (music === audio) stopMusic();
    },
    { once: true }
  );
  audio.play().catch(() => {});
}

export function stopMusic() {
  if (music) music.pause();
  music = null;
  musicName = null;
}

export function toggleMute() {
  muted = !muted;
  if (muted) stopMusic();
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  if (muted) stopMusic();
}

export function isMuted() {
  return muted;
}

// Built-in fallback tones: [frequency in Hz, start time, length] per note.
const TONES = {
  reveal: [[988, 0, 0.5]],
  strike: [[110, 0, 0.7]],
  win: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.4]],
  // The "eh-eh" duplicate-answer buzzer: two short, low buzzes, each two slightly clashing notes.
  dupe: [[165, 0, 0.26], [175, 0, 0.26], [165, 0.36, 0.26], [175, 0.36, 0.26]],
  timer: [[220, 0, 1.1]],
  winner: [[523, 0, 0.15], [659, 0.15, 0.15], [784, 0.3, 0.15], [1047, 0.45, 0.7]],
};

function synth(name) {
  const notes = TONES[name];
  if (!notes || muted) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime + 0.02;
    const harsh = name === "strike" || name === "timer";
    const buzz = name === "dupe";
    for (const [freq, start, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = harsh || buzz ? "sawtooth" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(harsh ? 0.14 : buzz ? 0.1 : 0.25, t0 + start + 0.02);
      // A buzzer holds its volume and cuts off; the other tones fade out.
      if (buzz) gain.gain.setValueAtTime(0.1, t0 + start + len - 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.05);
    }
  } catch {
    // No audio available; ignore.
  }
}
