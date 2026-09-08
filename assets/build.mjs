import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const svg = await readFile(new URL("./favicon.svg", import.meta.url), "utf8");
const sizes = [16, 32, 48];
const images = await Promise.all(
  sizes.map((size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  header[entry] = sizes[index];
  header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
const ico = Buffer.concat([header, ...images]);
await writeFile(new URL("./favicon.ico", import.meta.url), ico);
await writeFile(
  new URL("./generated.ts", import.meta.url),
  `// Generated from favicon.svg by build.mjs.\nexport const faviconSvg = ${JSON.stringify(svg)};\nexport const faviconIco = new Uint8Array([${[...ico].join(",")}]);\n`,
);
