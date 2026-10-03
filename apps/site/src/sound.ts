// ABOUTME: Sounds made on the fly with Web Audio, no files: a knock-knock, a blip for XP and a chime for a new rank.
// ABOUTME: They only play after the visitor did something, and never once they switch sound off (remembered locally).

const KEY = "soopdoop.sound";
let on = readSetting();
let ctx: AudioContext | null = null;

function readSetting(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundOn(): boolean {
  return on;
}

export function setSound(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // A private window: the choice lasts until the page closes.
  }
}

function audio(): AudioContext | null {
  if (!on) return null;
  if (ctx === null) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// One knuckle on a wooden door: a short falling thump with a click of filtered noise on top.
function knuckle(a: AudioContext, at: number): void {
  const out = a.createGain();
  out.gain.value = 0.5;
  out.connect(a.destination);

  const thump = a.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(190, at);
  thump.frequency.exponentialRampToValueAtTime(75, at + 0.09);
  const thumpGain = a.createGain();
  thumpGain.gain.setValueAtTime(0.0001, at);
  thumpGain.gain.exponentialRampToValueAtTime(0.9, at + 0.004);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
  thump.connect(thumpGain).connect(out);
  thump.start(at);
  thump.stop(at + 0.16);

  const length = Math.floor(a.sampleRate * 0.035);
  const buffer = a.createBuffer(1, length, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
  const click = a.createBufferSource();
  click.buffer = buffer;
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1500;
  band.Q.value = 2.2;
  const clickGain = a.createGain();
  clickGain.gain.value = 0.32;
  click.connect(band).connect(clickGain).connect(out);
  click.start(at);
}

export function knockKnock(): void {
  const a = audio();
  if (a === null) return;
  const t = a.currentTime + 0.02;
  knuckle(a, t);
  knuckle(a, t + 0.17);
}

function tone(a: AudioContext, at: number, from: number, to: number, length: number, level: number, type: OscillatorType): void {
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length * 0.6);
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(a.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

export function blip(): void {
  const a = audio();
  if (a === null) return;
  tone(a, a.currentTime + 0.01, 660, 1320, 0.14, 0.08, "sine");
}

export function chime(): void {
  const a = audio();
  if (a === null) return;
  const t = a.currentTime + 0.02;
  [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
    tone(a, t + i * 0.09, f, f, 0.5, 0.07, "triangle");
  });
}
