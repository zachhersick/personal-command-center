// Generated focus backgrounds. Each scene renders to a canvas at a modest
// resolution and frame rate so it stays calm and cheap while you work.

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function verticalGradient(ctx, height, stops) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  return gradient;
}

const aurora = {
  id: "aurora",
  label: "Aurora",
  swatch: "linear-gradient(160deg, #04060f 10%, #0d3b4a 55%, #3b2a6b)",
  scale: 0.25,
  fps: 30,
  init(width, height) {
    const random = seeded(7);
    return {
      stars: Array.from({ length: 140 }, () => ({ x: random() * width, y: random() * height * 0.7, r: random() * 0.9 + 0.2, p: random() * 6.28 }))
    };
  },
  draw(ctx, width, height, t, state) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#02040b"], [0.55, "#061322"], [1, "#0b1a24"]]);
    ctx.fillRect(0, 0, width, height);
    for (const star of state.stars) {
      ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * 0.8 + star.p);
      ctx.fillStyle = "#cfe6ff";
      ctx.fillRect(star.x, star.y, star.r, star.r);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
    const ribbons = [
      { hue: "64, 255, 190", base: 0.38, amp: 0.09, f: 1.7, s: 0.09, phase: 0, alpha: 0.42, depth: 0.32 },
      { hue: "60, 170, 255", base: 0.31, amp: 0.07, f: 2.6, s: -0.07, phase: 2, alpha: 0.32, depth: 0.26 },
      { hue: "170, 110, 255", base: 0.24, amp: 0.06, f: 1.2, s: 0.05, phase: 4, alpha: 0.26, depth: 0.22 }
    ];
    for (const ribbon of ribbons) {
      const top = [];
      for (let x = 0; x <= width; x += 4) {
        const u = x / width;
        const y = height * (ribbon.base + ribbon.amp * Math.sin(u * ribbon.f * 6.28 + t * ribbon.s * 6 + ribbon.phase) + 0.035 * Math.sin(u * 13 - t * 0.6 + ribbon.phase));
        top.push([x, y]);
      }
      const gradient = ctx.createLinearGradient(0, height * (ribbon.base - ribbon.amp), 0, height * (ribbon.base + ribbon.depth + ribbon.amp));
      gradient.addColorStop(0, `rgba(${ribbon.hue}, 0)`);
      gradient.addColorStop(0.18, `rgba(${ribbon.hue}, ${ribbon.alpha})`);
      gradient.addColorStop(1, `rgba(${ribbon.hue}, 0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(0, top[0][1]);
      for (const [x, y] of top) ctx.lineTo(x, y);
      for (let i = top.length - 1; i >= 0; i -= 1) {
        const [x, y] = top[i];
        ctx.lineTo(x, y + height * ribbon.depth * (0.75 + 0.25 * Math.sin(x / width * 9 + t * 0.4 + ribbon.phase)));
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = verticalGradient(ctx, height, [[0.72, "rgba(2,4,9,0)"], [1, "rgba(2,4,9,0.95)"]]);
    ctx.fillRect(0, 0, width, height);
  }
};

const rain = {
  id: "rain",
  label: "Rain on glass",
  swatch: "radial-gradient(circle at 30% 40%, #ffb36b55, transparent 30%), radial-gradient(circle at 70% 60%, #6bc6ff44, transparent 30%), #0a0f18",
  scale: 0.6,
  fps: 30,
  init(width, height) {
    const random = seeded(11);
    const backdrop = document.createElement("canvas");
    backdrop.width = width;
    backdrop.height = height;
    const b = backdrop.getContext("2d");
    b.fillStyle = verticalGradient(b, height, [[0, "#070b13"], [0.6, "#0c1422"], [1, "#141a24"]]);
    b.fillRect(0, 0, width, height);
    b.filter = `blur(${Math.round(width / 70)}px)`;
    const colors = ["255, 176, 96", "255, 214, 150", "110, 190, 255", "255, 120, 140", "160, 230, 255"];
    for (let i = 0; i < 70; i += 1) {
      const x = random() * width;
      const y = height * (0.25 + random() * 0.7);
      const r = width * (0.008 + random() * 0.03);
      b.fillStyle = `rgba(${colors[Math.floor(random() * colors.length)]}, ${0.18 + random() * 0.4})`;
      b.beginPath();
      b.arc(x, y, r, 0, Math.PI * 2);
      b.fill();
    }
    b.filter = "none";
    const beads = Array.from({ length: Math.round((width * height) / 2600) }, () => ({ x: random() * width, y: random() * height, r: random() * 1.6 + 0.4 }));
    const drops = Array.from({ length: 34 }, () => ({ x: random() * width, y: random() * height, r: random() * 2.4 + 1.6, v: random() * 40 + 15, wobble: random() * 6.28 }));
    return { backdrop, beads, drops, random, last: 0 };
  },
  draw(ctx, width, height, t, state) {
    const dt = state.last ? Math.min(0.1, t - state.last) : 0;
    state.last = t;
    ctx.drawImage(state.backdrop, 0, 0);
    ctx.fillStyle = "rgba(220, 235, 255, 0.16)";
    for (const bead of state.beads) {
      ctx.beginPath();
      ctx.arc(bead.x, bead.y, bead.r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const drop of state.drops) {
      drop.y += drop.v * dt * (0.6 + 0.4 * Math.sin(t * 2 + drop.wobble));
      drop.x += Math.sin(t * 1.3 + drop.wobble) * 0.15;
      if (drop.y - 60 > height) {
        drop.y = -10;
        drop.x = state.random() * width;
        drop.v = state.random() * 40 + 15;
      }
      const trail = ctx.createLinearGradient(drop.x, drop.y - 60, drop.x, drop.y);
      trail.addColorStop(0, "rgba(200, 225, 255, 0)");
      trail.addColorStop(1, "rgba(200, 225, 255, 0.18)");
      ctx.strokeStyle = trail;
      ctx.lineWidth = drop.r * 0.9;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y - 60);
      ctx.lineTo(drop.x, drop.y);
      ctx.stroke();
      ctx.fillStyle = "rgba(225, 240, 255, 0.34)";
      ctx.beginPath();
      ctx.ellipse(drop.x, drop.y, drop.r, drop.r * 1.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.beginPath();
      ctx.arc(drop.x - drop.r * 0.3, drop.y - drop.r * 0.4, drop.r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

function ridge(random, width, height, base, roughness) {
  const points = [];
  let y = base;
  for (let x = -20; x <= width + 20; x += width / 60) {
    y += (random() - 0.5) * roughness;
    y = Math.max(base - roughness * 3, Math.min(base + roughness * 2, y));
    points.push([x, y]);
  }
  return points;
}

const night = {
  id: "night",
  label: "Night sky",
  swatch: "linear-gradient(180deg, #050816 0%, #1b1440 70%, #3d2350)",
  scale: 0.75,
  fps: 24,
  init(width, height) {
    const random = seeded(23);
    const stars = Array.from({ length: Math.round((width * height) / 1800) }, () => {
      const band = random() < 0.45;
      const u = random();
      return {
        x: band ? u * width : random() * width,
        y: band ? height * (0.1 + u * 0.45 + (random() - 0.5) * 0.12) : random() * height * 0.75,
        r: random() < 0.04 ? random() * 1.4 + 1 : random() * 0.9 + 0.25,
        p: random() * 6.28,
        s: random() * 1.5 + 0.4
      };
    });
    return {
      stars,
      random,
      ridges: [
        { points: ridge(random, width, height, height * 0.8, height * 0.03), color: "#140f26" },
        { points: ridge(random, width, height, height * 0.86, height * 0.025), color: "#0c0a18" },
        { points: ridge(random, width, height, height * 0.93, height * 0.015), color: "#06050d" }
      ],
      meteor: null,
      nextMeteor: 6
    };
  },
  draw(ctx, width, height, t, state) {
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#03050f"], [0.55, "#0f0c2c"], [0.85, "#2a1840"], [1, "#3b2045"]]);
    ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width * 0.65, height * 0.35, 0, width * 0.65, height * 0.35, width * 0.5);
    glow.addColorStop(0, "rgba(120, 110, 255, 0.08)");
    glow.addColorStop(1, "rgba(120, 110, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    for (const star of state.stars) {
      ctx.globalAlpha = 0.45 + 0.55 * Math.max(0, Math.sin(t * star.s + star.p));
      ctx.fillStyle = star.r > 1 ? "#fff6e0" : "#dfe8ff";
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!state.meteor && t > state.nextMeteor) {
      state.meteor = { x: state.random() * width * 0.7 + width * 0.2, y: state.random() * height * 0.3, start: t };
      state.nextMeteor = t + 9 + state.random() * 14;
    }
    if (state.meteor) {
      const age = t - state.meteor.start;
      if (age > 1.1) state.meteor = null;
      else {
        const x = state.meteor.x - age * width * 0.35;
        const y = state.meteor.y + age * height * 0.22;
        const tail = ctx.createLinearGradient(x, y, x + width * 0.08, y - height * 0.05);
        tail.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - age)})`);
        tail.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = tail;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + width * 0.08, y - height * 0.05);
        ctx.stroke();
      }
    }
    for (const layer of state.ridges) {
      ctx.fillStyle = layer.color;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (const [x, y] of layer.points) ctx.lineTo(x, y);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
  }
};

const ocean = {
  id: "ocean",
  label: "Deep ocean",
  swatch: "linear-gradient(180deg, #0c5d73 0%, #062a44 50%, #020a16)",
  scale: 0.5,
  fps: 30,
  init(width, height) {
    const random = seeded(31);
    return {
      motes: Array.from({ length: 90 }, () => ({ x: random() * width, y: random() * height, r: random() * 1.8 + 0.4, v: random() * 8 + 3, p: random() * 6.28 })),
      rays: Array.from({ length: 7 }, (_, index) => ({ x: (index + 0.5) / 7, w: 0.04 + random() * 0.06, p: random() * 6.28, s: 0.1 + random() * 0.2 }))
    };
  },
  draw(ctx, width, height, t, state) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#0b5168"], [0.35, "#06304b"], [0.75, "#03142a"], [1, "#010711"]]);
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const ray of state.rays) {
      const cx = width * (ray.x + 0.05 * Math.sin(t * ray.s + ray.p));
      const spread = width * ray.w;
      const gradient = ctx.createLinearGradient(0, 0, 0, height * 0.85);
      gradient.addColorStop(0, `rgba(150, 230, 255, ${0.1 + 0.05 * Math.sin(t * 0.7 + ray.p)})`);
      gradient.addColorStop(1, "rgba(150, 230, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(cx - spread * 0.4, 0);
      ctx.lineTo(cx + spread * 0.4, 0);
      ctx.lineTo(cx + spread * 2.2 - width * 0.12, height * 0.85);
      ctx.lineTo(cx - spread * 0.6 - width * 0.12, height * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    for (const mote of state.motes) {
      mote.y -= mote.v * 0.016;
      if (mote.y < -5) mote.y = height + 5;
      const x = mote.x + Math.sin(t * 0.5 + mote.p) * 6;
      ctx.fillStyle = `rgba(180, 235, 255, ${0.25 + 0.2 * Math.sin(t + mote.p)})`;
      ctx.beginPath();
      ctx.arc(x, mote.y, mote.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

const dusk = {
  id: "dusk",
  label: "Dusk",
  swatch: "linear-gradient(135deg, #1d1b3a, #6b3a5e 55%, #e58e6b)",
  scale: 0.2,
  fps: 15,
  init() {
    return {};
  },
  draw(ctx, width, height, t) {
    const shift = Math.sin(t * 0.05) * 0.5 + 0.5;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${245 + shift * 15}, 35%, 13%)`);
    gradient.addColorStop(0.55, `hsl(${320 + shift * 10}, 30%, ${24 + shift * 4}%)`);
    gradient.addColorStop(1, `hsl(${18 + shift * 8}, 65%, ${55 + shift * 6}%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    const sun = ctx.createRadialGradient(width * 0.78, height * 0.82, 0, width * 0.78, height * 0.82, width * 0.45);
    sun.addColorStop(0, "rgba(255, 200, 150, 0.35)");
    sun.addColorStop(1, "rgba(255, 200, 150, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, height);
  }
};

// ---------- seasons ----------

// Petals, leaves and snow all fall and sway; only their look differs.
function drifters(random, count, width, height, { size, fall, sway }) {
  return Array.from({ length: count }, () => ({
    x: random() * width,
    y: random() * height,
    size: size[0] + random() * (size[1] - size[0]),
    fall: fall[0] + random() * (fall[1] - fall[0]),
    sway: sway[0] + random() * (sway[1] - sway[0]),
    spin: (random() - 0.5) * 2.2,
    phase: random() * 6.28
  }));
}

function driftAt(particle, t, width, height) {
  return {
    x: (particle.x + Math.sin(t * particle.sway + particle.phase) * width * 0.05 + width * 2) % width,
    y: ((particle.y + t * particle.fall * height) % (height * 1.15)) - height * 0.08,
    angle: particle.phase + t * particle.spin
  };
}

// A pointed oval, drawn around the origin: petal or leaf.
function leafPath(ctx, size) {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.quadraticCurveTo(size * 0.85, -size * 0.15, 0, size);
  ctx.quadraticCurveTo(-size * 0.85, -size * 0.15, 0, -size);
  ctx.closePath();
  ctx.fill();
}

const spring = {
  id: "spring",
  label: "Cherry blossom",
  swatch: "linear-gradient(170deg, #2a1430 10%, #6d2f4d 55%, #c06a74)",
  scale: 0.5,
  fps: 30,
  init(width, height) {
    const random = seeded(31);
    return {
      petals: drifters(random, Math.round((width * height) / 5200), width, height, { size: [2.5, 7], fall: [0.012, 0.03], sway: [0.25, 0.7] }),
      tints: ["#ffd7e6", "#ffc3d8", "#fff2f6", "#f7b7cf"]
    };
  },
  draw(ctx, width, height, t, state) {
    // Blossom at dusk: dark enough for the white timer to sit on.
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#1d0f26"], [0.38, "#3f1b3c"], [0.72, "#7b3650"], [1, "#b05f66"]]);
    ctx.fillRect(0, 0, width, height);
    const sun = ctx.createRadialGradient(width * 0.26, height * 0.78, 0, width * 0.26, height * 0.78, width * 0.5);
    sun.addColorStop(0, "rgba(255, 196, 170, 0.3)");
    sun.addColorStop(1, "rgba(255, 196, 170, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, height);
    state.petals.forEach((petal, index) => {
      const at = driftAt(petal, t, width, height);
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.rotate(at.angle);
      ctx.globalAlpha = 0.5 + 0.4 * Math.abs(Math.cos(at.angle));
      ctx.fillStyle = state.tints[index % state.tints.length];
      leafPath(ctx, petal.size);
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = verticalGradient(ctx, height, [[0.75, "rgba(120, 96, 70, 0)"], [1, "rgba(94, 76, 56, 0.35)"]]);
    ctx.fillRect(0, 0, width, height);
  }
};

const summer = {
  id: "summer",
  label: "Summer evening",
  swatch: "linear-gradient(180deg, #1f5f7d 10%, #f3a95f 52%, #c8603f 68%, #10202e)",
  scale: 0.4,
  fps: 24,
  init(width, height) {
    const random = seeded(53);
    const horizon = height * 0.62;
    return {
      horizon,
      glints: Array.from({ length: Math.round(height / 7) }, () => ({
        y: horizon + random() * (height - horizon),
        w: random() * 0.16 + 0.02,
        x: random(),
        s: random() * 0.5 + 0.15,
        p: random() * 6.28
      }))
    };
  },
  draw(ctx, width, height, t, state) {
    const { horizon } = state;
    ctx.fillStyle = verticalGradient(ctx, height, [
      [0, "#174f6e"], [0.26, "#3f7f91"], [0.46, "#e9a263"], [0.58, "#f3c177"], [0.62, "#c9693f"], [0.8, "#1d3346"], [1, "#0d1a26"]
    ]);
    ctx.fillRect(0, 0, width, height);
    const sunY = horizon - height * 0.04;
    const glow = ctx.createRadialGradient(width * 0.5, sunY, 0, width * 0.5, sunY, width * 0.38);
    glow.addColorStop(0, "rgba(255, 214, 150, 0.55)");
    glow.addColorStop(0.45, "rgba(255, 170, 110, 0.18)");
    glow.addColorStop(1, "rgba(255, 170, 110, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffdca2";
    ctx.beginPath();
    ctx.arc(width * 0.5, sunY, height * 0.045, 0, Math.PI * 2);
    ctx.fill();
    // Water: a reflection column plus drifting glints.
    ctx.globalCompositeOperation = "lighter";
    for (const glint of state.glints) {
      const depth = (glint.y - horizon) / Math.max(1, height - horizon);
      const centre = width * 0.5 + Math.sin(t * glint.s + glint.p) * width * (0.03 + depth * 0.1);
      const w = width * glint.w * (0.4 + depth);
      ctx.globalAlpha = (0.3 - depth * 0.2) * (0.6 + 0.4 * Math.sin(t * 1.3 + glint.p));
      ctx.fillStyle = depth < 0.35 ? "#ffd9a0" : "#9fd3e0";
      ctx.fillRect(centre - w / 2, glint.y, w, Math.max(1, height * 0.004));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = verticalGradient(ctx, height, [[0.78, "rgba(6, 14, 22, 0)"], [1, "rgba(6, 14, 22, 0.85)"]]);
    ctx.fillRect(0, 0, width, height);
  }
};

const fall = {
  id: "fall",
  label: "Falling leaves",
  swatch: "linear-gradient(165deg, #2b1710 10%, #7d3a16 55%, #c9772a)",
  scale: 0.5,
  fps: 30,
  init(width, height) {
    const random = seeded(71);
    // Three depths: the near layer is bigger, slower and hazier.
    const layers = [
      { count: Math.round((width * height) / 14000), size: [6, 11], fall: [0.014, 0.024], alpha: 0.35 },
      { count: Math.round((width * height) / 9000), size: [3.5, 6.5], fall: [0.026, 0.042], alpha: 0.72 },
      { count: Math.round((width * height) / 7000), size: [2, 3.8], fall: [0.045, 0.07], alpha: 0.95 }
    ];
    return {
      layers: layers.map((layer) => ({ ...layer, leaves: drifters(random, layer.count, width, height, { size: layer.size, fall: layer.fall, sway: [0.3, 0.9] }) })),
      tints: ["#d98324", "#c1440e", "#e9b44c", "#9c4a1a", "#b8651f"]
    };
  },
  draw(ctx, width, height, t, state) {
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#20110b"], [0.4, "#55250f"], [0.75, "#8a4318"], [1, "#b05f1f"]]);
    ctx.fillRect(0, 0, width, height);
    const shaft = ctx.createRadialGradient(width * 0.72, height * 0.12, 0, width * 0.72, height * 0.12, width * 0.6);
    shaft.addColorStop(0, "rgba(255, 196, 110, 0.26)");
    shaft.addColorStop(1, "rgba(255, 196, 110, 0)");
    ctx.fillStyle = shaft;
    ctx.fillRect(0, 0, width, height);
    for (const layer of state.layers) {
      layer.leaves.forEach((leaf, index) => {
        const at = driftAt(leaf, t, width, height);
        ctx.save();
        ctx.translate(at.x, at.y);
        ctx.rotate(at.angle);
        // Tumbling: the leaf narrows as it turns edge-on.
        ctx.scale(0.35 + 0.65 * Math.abs(Math.cos(at.angle * 0.8)), 1);
        ctx.globalAlpha = layer.alpha;
        ctx.fillStyle = state.tints[index % state.tints.length];
        leafPath(ctx, leaf.size);
        ctx.restore();
      });
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "rgba(20, 9, 5, 0.5)"], [0.35, "rgba(20, 9, 5, 0)"], [1, "rgba(20, 9, 5, 0.45)"]]);
    ctx.fillRect(0, 0, width, height);
  }
};

const christmas = {
  id: "christmas",
  label: "Christmas lights",
  swatch: "radial-gradient(circle at 20% 15%, #ff5b4a55, transparent 28%), radial-gradient(circle at 62% 12%, #ffd16655, transparent 28%), linear-gradient(180deg, #06201c, #07151f)",
  scale: 0.5,
  fps: 24,
  init(width, height) {
    const random = seeded(97);
    const bulbs = [];
    const count = Math.max(12, Math.round(width / 26));
    const swags = 3;
    for (let i = 0; i <= count; i += 1) {
      const u = i / count;
      bulbs.push({
        u,
        // Swagged wire: shallow arcs between pins across the top.
        sag: Math.sin(u * Math.PI * swags) ** 2,
        colour: ["#ff5b4a", "#ffd166", "#6ee7a8", "#7cc7ff", "#ff8ad1"][i % 5],
        p: random() * 6.28,
        s: random() * 0.8 + 0.5
      });
    }
    return {
      bulbs,
      snow: drifters(random, Math.round((width * height) / 5000), width, height, { size: [0.9, 2.6], fall: [0.03, 0.075], sway: [0.2, 0.6] })
    };
  },
  draw(ctx, width, height, t, state) {
    ctx.fillStyle = verticalGradient(ctx, height, [[0, "#04171a"], [0.5, "#072019"], [1, "#061320"]]);
    ctx.fillRect(0, 0, width, height);
    const wireY = (bulb) => height * (0.04 + bulb.sag * 0.07);
    ctx.strokeStyle = "rgba(216, 230, 225, 0.3)";
    ctx.lineWidth = Math.max(0.8, height * 0.0016);
    ctx.beginPath();
    state.bulbs.forEach((bulb, index) => {
      const x = bulb.u * width;
      if (index === 0) ctx.moveTo(x, wireY(bulb));
      else ctx.lineTo(x, wireY(bulb));
    });
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    const radius = Math.max(1.4, height * 0.006);
    for (const bulb of state.bulbs) {
      const x = bulb.u * width;
      const y = wireY(bulb) + radius * 2.2;
      const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(t * bulb.s + bulb.p));
      ctx.fillStyle = bulb.colour;
      ctx.globalAlpha = 0.07 + 0.1 * pulse;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.5 + 0.45 * pulse;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#f3f8ff";
    for (const flake of state.snow) {
      const at = driftAt(flake, t, width, height);
      ctx.globalAlpha = 0.35 + 0.4 * Math.sin(t * 0.9 + flake.phase) ** 2;
      ctx.beginPath();
      ctx.arc(at.x, at.y, flake.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = verticalGradient(ctx, height, [[0.6, "rgba(2, 10, 12, 0)"], [1, "rgba(2, 10, 12, 0.8)"]]);
    ctx.fillRect(0, 0, width, height);
  }
};

export const SCENES = [aurora, night, rain, ocean, dusk, spring, summer, fall, christmas];

export function sceneById(id) {
  return SCENES.find((scene) => scene.id === id) || aurora;
}

// Mounts a scene on a canvas; returns a cleanup function.
export function runScene(canvas, scene, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext("2d");
  let state = null;
  let frame = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  const started = performance.now();

  const resize = () => {
    width = Math.max(1, Math.round(window.innerWidth * scene.scale));
    height = Math.max(1, Math.round(window.innerHeight * scene.scale));
    canvas.width = width;
    canvas.height = height;
    state = scene.init(width, height);
    scene.draw(ctx, width, height, 0, state);
  };
  const loop = (now) => {
    frame = requestAnimationFrame(loop);
    if (document.hidden || now - last < 1000 / scene.fps) return;
    last = now;
    scene.draw(ctx, width, height, (now - started) / 1000, state);
  };
  resize();
  window.addEventListener("resize", resize);
  if (!reducedMotion) frame = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
  };
}
