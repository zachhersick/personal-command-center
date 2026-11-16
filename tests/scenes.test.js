import test from "node:test";
import assert from "node:assert/strict";
import { SCENES, sceneById } from "../public/app/focus/scenes.js";

// Enough of a 2D context to run a scene headless. It records what was painted
// and refuses anything that isn't a finite number, which is how a typo in a
// scene (a missing state field, a bad gradient stop) shows up.
function stubContext() {
  const painted = [];
  const colours = [];
  const bad = [];
  const numbers = (name, args) => {
    for (const value of args) {
      if (typeof value === "number" && !Number.isFinite(value)) bad.push(`${name}(${args.join(", ")})`);
    }
  };
  // A browser throws on a malformed colour; this is the same check.
  const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\))$/i;
  const colour = (where, value) => {
    if (typeof value !== "string" || !COLOUR.test(value.trim())) bad.push(`${where}: ${value}`);
    colours.push(value);
  };
  const gradient = () => ({
    addColorStop(at, value) {
      numbers("addColorStop", [at]);
      if (at < 0 || at > 1) bad.push(`addColorStop(${at})`);
      colour("addColorStop", value);
    }
  });
  const ctx = {
    painted,
    colours,
    bad,
    canvas: { width: 0, height: 0 },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    _fill: "#000",
    _stroke: "#000",
    set fillStyle(value) { if (typeof value === "string") colour("fillStyle", value); this._fill = value; },
    get fillStyle() { return this._fill; },
    set strokeStyle(value) { if (typeof value === "string") colour("strokeStyle", value); this._stroke = value; },
    get strokeStyle() { return this._stroke; },
    createLinearGradient: (...args) => (numbers("createLinearGradient", args), gradient()),
    createRadialGradient: (...args) => (numbers("createRadialGradient", args), gradient()),
    fillRect: (...args) => (numbers("fillRect", args), painted.push("fillRect")),
    fill: () => painted.push("fill"),
    stroke: () => painted.push("stroke"),
    beginPath: () => {},
    closePath: () => {},
    moveTo: (...args) => numbers("moveTo", args),
    lineTo: (...args) => numbers("lineTo", args),
    quadraticCurveTo: (...args) => numbers("quadraticCurveTo", args),
    arc: (...args) => numbers("arc", args),
    ellipse: (...args) => numbers("ellipse", args),
    drawImage: (image, ...args) => (numbers("drawImage", args), painted.push("drawImage")),
    save: () => {},
    restore: () => {},
    translate: (...args) => numbers("translate", args),
    rotate: (...args) => numbers("rotate", args),
    scale: (...args) => numbers("scale", args),
    filter: "none"
  };
  return ctx;
}

// Some scenes build an offscreen canvas in init(); give them one.
globalThis.document = {
  createElement() {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => Object.assign(stubContext(), { canvas });
    return canvas;
  }
};

test("every scene is shaped the way runScene expects", () => {
  assert.ok(SCENES.length >= 9);
  const ids = new Set();
  const labels = new Set();
  for (const scene of SCENES) {
    assert.match(scene.id, /^[a-z]+$/, `${scene.id} is a plain id`);
    assert.ok(scene.label && scene.swatch, `${scene.id} has a label and swatch`);
    assert.ok(scene.scale > 0 && scene.scale <= 1, `${scene.id} scale`);
    assert.ok(scene.fps > 0 && scene.fps <= 30, `${scene.id} fps stays modest`);
    assert.equal(typeof scene.init, "function");
    assert.equal(typeof scene.draw, "function");
    assert.ok(!ids.has(scene.id), `${scene.id} is unique`);
    assert.ok(!labels.has(scene.label), `${scene.label} is unique`);
    ids.add(scene.id);
    labels.add(scene.label);
  }
  for (const id of ["spring", "summer", "fall", "christmas"]) assert.ok(ids.has(id), `${id} is offered`);
  assert.equal(sceneById("spring").label, "Cherry blossom");
  assert.equal(sceneById("nope").id, "aurora", "an unknown id falls back");
});

test("every scene paints at several sizes and times without a bad value", () => {
  for (const scene of SCENES) {
    for (const [width, height] of [[480, 270], [1920, 1080], [300, 900]]) {
      const ctx = stubContext();
      const state = scene.init(width, height);
      for (const t of [0, 0.3, 7.5, 61, 3600]) scene.draw(ctx, width, height, t, state);
      assert.deepEqual(ctx.bad, [], `${scene.id} at ${width}x${height}`);
      assert.ok(ctx.painted.length > 3, `${scene.id} painted something at ${width}x${height}`);
      // Either a filled background or a prebuilt backdrop image.
      assert.ok(ctx.painted.some((call) => call === "fillRect" || call === "drawImage"), `${scene.id} covers the background`);
    }
  }
});

test("scenes leave the context in a clean state for the next frame", () => {
  for (const scene of SCENES) {
    const ctx = stubContext();
    const state = scene.init(640, 360);
    scene.draw(ctx, 640, 360, 12, state);
    assert.equal(ctx.globalAlpha, 1, `${scene.id} resets globalAlpha`);
    assert.equal(ctx.globalCompositeOperation, "source-over", `${scene.id} resets compositing`);
  }
});
