// Ambient noise and the session chime, generated with WebAudio so no audio
// files ship with the app.

let audio = null;
let current = null;

function context() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === "suspended") audio.resume();
  return audio;
}

function noiseBuffer(ctx, kind) {
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      if (kind === "brown") {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      } else {
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.12;
      }
    }
  }
  return buffer;
}

export const AMBIENT = [
  { id: "off", label: "Off" },
  { id: "brown", label: "Brown noise" },
  { id: "rain", label: "Rain" },
  { id: "waves", label: "Waves" }
];

export function stopAmbient() {
  if (!current) return;
  const { nodes, gain } = current;
  const ctx = context();
  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  setTimeout(() => nodes.forEach((node) => {
    try {
      node.stop?.();
      node.disconnect();
    } catch {
      // Already stopped.
    }
  }), 1500);
  current = null;
}

export function playAmbient(kind, volume = 0.5) {
  stopAmbient();
  if (!kind || kind === "off") return;
  const ctx = context();
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, kind === "rain" ? "pink" : "brown");
  source.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const nodes = [source, gain];
  let tail = source;
  if (kind === "rain") {
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 500;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 7000;
    tail.connect(high);
    high.connect(low);
    tail = low;
    nodes.push(high, low);
  }
  if (kind === "waves") {
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 900;
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const depth = ctx.createGain();
    depth.gain.value = 0.45;
    lfo.connect(depth);
    depth.connect(swell.gain);
    lfo.start();
    tail.connect(low);
    low.connect(swell);
    tail = swell;
    nodes.push(low, swell, lfo, depth);
  }
  tail.connect(gain);
  gain.connect(ctx.destination);
  source.start();
  gain.gain.setTargetAtTime(volume * 0.6, ctx.currentTime, 0.6);
  current = { nodes, gain };
}

export function setAmbientVolume(volume) {
  if (!current) return;
  const ctx = context();
  current.gain.gain.setTargetAtTime(volume * 0.6, ctx.currentTime, 0.15);
}

export function chime() {
  try {
    const ctx = context();
    [659.25, 987.77, 1318.5].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.7);
    });
  } catch {
    // Audio unavailable; the visual cue still shows.
  }
}
