// Renders the app icons from desktop/assets/icon.svg:
//   desktop/assets/icon.png            1024px, used for the macOS .icns
//   desktop/assets/trayTemplate.png    22px  macOS menu bar template (black + alpha)
//   desktop/assets/trayTemplate@2x.png 44px
//   public/icons/icon-{180,192,512}.png  home-screen icons for the phone app
// Run with: npm run build:icons (only needed when the SVG changes).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "desktop", "assets", "icon.svg"), "utf8");

function render(source, width) {
  return new Resvg(source, { fitTo: { mode: "width", value: width } }).render().asPng();
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log("wrote", path.replace(root, "."));
}

write(join(root, "desktop", "assets", "icon.png"), render(svg, 1024));

// Menu bar icons must be a black glyph on transparency; macOS tints them.
const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  <path d="M13.5 4 V12.5 Q13.5 17 9.5 17 Q7 17 6 15" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
write(join(root, "desktop", "assets", "trayTemplate.png"), render(tray, 22));
write(join(root, "desktop", "assets", "trayTemplate@2x.png"), render(tray, 44));

// Home-screen icons: full-bleed square (iOS rounds the corners itself).
const fullBleed = svg.replace('<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>', '<rect width="1024" height="1024" fill="url(#bg)"/>')
  .replace('<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#glow)"/>', '<rect width="1024" height="1024" fill="url(#glow)"/>');
for (const size of [180, 192, 512]) write(join(root, "public", "icons", `icon-${size}.png`), render(fullBleed, size));
