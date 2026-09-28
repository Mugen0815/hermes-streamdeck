// Renders the plugin's PNG icon (Stream Deck requires PNG for the marketplace icon).
// Dependency-free: rasterizes a rounded square with an "H" and encodes it with node:zlib.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = "io.github.mugen0815.hermes-streamdeck.sdPlugin/imgs/plugin";
const BG = [0x1d, 0x4e, 0xd8];
const FG = [0xff, 0xff, 0xff];

// Shape in a 288-unit design grid (same as marketplace.svg).
const RADIUS = 48;
const H_RECTS = [
	[76, 64, 112, 224],
	[176, 64, 212, 224],
	[112, 128, 176, 160],
];

function coverage(x, y) {
	// Rounded-rect alpha with 4x4 supersampling for smooth corners.
	let inside = 0;
	for (let sy = 0; sy < 4; sy++) {
		for (let sx = 0; sx < 4; sx++) {
			const px = x + (sx + 0.5) / 4;
			const py = y + (sy + 0.5) / 4;
			const cx = Math.min(Math.max(px, RADIUS), 288 - RADIUS);
			const cy = Math.min(Math.max(py, RADIUS), 288 - RADIUS);
			if ((px - cx) ** 2 + (py - cy) ** 2 <= RADIUS ** 2) inside++;
		}
	}
	return inside / 16;
}

function render(size) {
	const scale = size / 288;
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0; // filter: none
		for (let x = 0; x < size; x++) {
			const gx = x / scale;
			const gy = y / scale;
			const alpha = coverage(gx, gy);
			const onH = H_RECTS.some(([x0, y0, x1, y1]) => gx >= x0 && gx < x1 && gy >= y0 && gy < y1);
			const [r, g, b] = onH ? FG : BG;
			const o = y * (size * 4 + 1) + 1 + x * 4;
			raw[o] = r;
			raw[o + 1] = g;
			raw[o + 2] = b;
			raw[o + 3] = Math.round(alpha * 255);
		}
	}
	return png(size, size, raw);
}

function png(width, height, raw) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function crc32(buf) {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	return ~c >>> 0;
}

writeFileSync(`${OUT}/marketplace.png`, render(288));
writeFileSync(`${OUT}/marketplace@2x.png`, render(576));
console.log("icons written");
