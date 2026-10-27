// Draws the virtual SSD1306 (the 'oled' messages of simple-touch.js) on a
// canvas, one square per pixel with a gap, so the panel's dots show.
//
// ram:  8 pages x 128 bytes; bit n of byte [page * 128 + x] is row page * 8 + n
// info: bit 0 on, 1 inverted, 2 mirrored left-right, 3 mirrored top-bottom,
//       4 all pixels on, 8..15 rows

export const OLED_WIDTH = 128;

export function oledRows(info) {
  return (info >> 8) & 0xff || 32;
}

export function drawOled(canvas, ram, info, { color = '#dff1ff', background = '#06080a', gap = 0.2 } = {}) {
  const ctx = canvas.getContext('2d');
  const rows = oledRows(info);
  const cell = Math.min(canvas.width / OLED_WIDTH, canvas.height / rows);
  const dot = Math.max(1, cell * (1 - gap));
  const x0 = (canvas.width - cell * OLED_WIDTH) / 2;
  const y0 = (canvas.height - cell * rows) / 2;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!(info & 1) || !ram) return;

  const invert = !!(info & 2), flipX = !!(info & 4), flipY = !!(info & 8), allOn = !!(info & 16);
  ctx.fillStyle = color;
  for (let y = 0; y < rows; y++) {
    const ry = flipY ? rows - 1 - y : y;
    const page = (ry >> 3) * OLED_WIDTH;
    const bit = 1 << (ry & 7);
    for (let x = 0; x < OLED_WIDTH; x++) {
      const rx = flipX ? OLED_WIDTH - 1 - x : x;
      const lit = allOn || (ram[page + rx] & bit) !== 0;
      if (lit !== invert) ctx.fillRect(x0 + x * cell, y0 + y * cell, dot, dot);
    }
  }
}

// Plays the boot film (SimpleTouch.boot: what setup showed, with times),
// then hands over. Returns a function that stops it early.
export function playBoot(frames, show, done) {
  let i = 0;
  let timer = null;
  const t0 = frames.length ? frames[0].ms : 0;
  const start = performance.now();
  const step = () => {
    const now = performance.now() - start;
    while (i < frames.length && frames[i].ms - t0 <= now) show(frames[i++]);
    if (i < frames.length) timer = setTimeout(step, frames[i].ms - t0 - now);
    else done?.();
  };
  step();
  return () => {
    clearTimeout(timer);
    i = frames.length;
  };
}
