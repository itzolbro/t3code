// Render the Pi Tie mark SVG to PNG/ICO at the sizes the web + desktop
// builds need. Uses sharp (prebuilt binaries; installed as a root devDep).
//
// Usage: node scripts/render-pi-tie-mark.cjs
//   Writes:
//     apps/web/public/favicon.svg            (copied)
//     apps/web/public/favicon-16x16.png
//     apps/web/public/favicon-32x32.png
//     apps/web/public/apple-touch-icon.png   (180px)
//     apps/web/public/favicon.ico            (16/32/48/256, PNG-compressed)
//     assets/branding/pi-tie-mark-256.png
//     assets/branding/pi-tie-mark-512.png
//     assets/prod/logo.svg                   (source of truth for builds)
//     assets/prod/t3-black-windows.ico       (installer icon source)
//     assets/prod/t3-black-web-favicon.ico
//     assets/prod/t3-black-web-favicon-16x16.png
//     assets/prod/t3-black-web-favicon-32x32.png
//     assets/prod/t3-black-web-apple-touch-180.png
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SVG_PATH = path.join(ROOT, "assets", "branding", "pi-tie-mark.svg");

const PNG_OUT = {
  "apps/web/public/favicon-16x16.png": 16,
  "apps/web/public/favicon-32x32.png": 32,
  "apps/web/public/apple-touch-icon.png": 180,
  "assets/branding/pi-tie-mark-256.png": 256,
  "assets/branding/pi-tie-mark-512.png": 512,
  "assets/prod/t3-black-web-favicon-16x16.png": 16,
  "assets/prod/t3-black-web-favicon-32x32.png": 32,
  "assets/prod/t3-black-web-apple-touch-180.png": 180,
};

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  // Web + branding PNGs.
  for (const [rel, size] of Object.entries(PNG_OUT)) {
    const png = await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
    const outPath = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
    console.log("wrote", rel, `${size}px`);
  }

  // ICO files (16/32/48/256, PNG-compressed entries — standard ICONDIR).
  const icoSizes = [16, 32, 48, 256];
  const pngs = [];
  for (const size of icoSizes) {
    pngs.push(await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer());
  }
  const ico = buildIco(pngs, icoSizes);
  for (const rel of [
    "apps/web/public/favicon.ico",
    "assets/prod/t3-black-web-favicon.ico",
    "assets/prod/t3-black-windows.ico",
  ]) {
    const outPath = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, ico);
    console.log("wrote", rel);
  }

  // Source of truth for future builds: the mark as the brand logo.
  fs.copyFileSync(SVG_PATH, path.join(ROOT, "assets/prod/logo.svg"));
  console.log("wrote assets/prod/logo.svg");
}

// Standard ICO container: ICONDIR + per-image ICONDIRENTRY, payload is the
// PNG bytes (allowed since Vista).
function buildIco(pngs, sizes) {
  let offset = 6 + 16 * pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  for (let index = 0; index < pngs.length; index += 1) {
    const png = pngs[index];
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size === 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs]);
}

main().catch((error) => {
  console.error("failed:", error.message);
  process.exit(1);
});
