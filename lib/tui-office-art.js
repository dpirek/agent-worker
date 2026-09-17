// Hex palette and a 24 × 16 pixel scene. Each terminal cell holds two pixels.
const palette = [
  '#111827', // wall
  '#334155', // window frame / chair
  '#7DD3FC', // daylight
  '#E0F2FE', // reflection
  '#422B28', // hair / shoes
  '#F4BD96', // skin
  '#FFFFFF', // shirt / mug
  '#60A5FA', // cardigan
  '#FB7185', // tie
  '#0F172A', // monitor frame
  '#34D399', // screen
  '#A7F3D0', // screen text
  '#B88762', // desktop
  '#75533E', // desk legs
  '#64748B', // keyboard
  '#D8E3EE', // steam
];

const pixels = Array.from({ length: 16 }, () => Array(24).fill(0));
function rectangle(x, y, width, height, color) {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) pixels[row][column] = color;
  }
}

// Window, seated worker, computer, coffee, and desk.
rectangle(1, 1, 7, 7, 1);
rectangle(2, 2, 5, 5, 2);
rectangle(2, 2, 2, 2, 3);
rectangle(4, 2, 1, 5, 1);
rectangle(2, 4, 5, 1, 1);
rectangle(10, 1, 4, 1, 4);
rectangle(9, 2, 6, 3, 4);
rectangle(10, 3, 4, 4, 5);
rectangle(13, 4, 1, 1, 4);
rectangle(14, 5, 1, 1, 5);
rectangle(11, 7, 2, 1, 5);
rectangle(7, 8, 2, 5, 1);
rectangle(9, 8, 6, 4, 7);
rectangle(11, 8, 2, 4, 6);
rectangle(12, 9, 1, 2, 8);
rectangle(14, 10, 2, 1, 7);
rectangle(16, 10, 2, 1, 5);
rectangle(17, 4, 6, 6, 9);
rectangle(18, 5, 4, 4, 10);
rectangle(18, 6, 2, 1, 11);
rectangle(19, 8, 2, 1, 11);
rectangle(19, 10, 2, 1, 14);
rectangle(15, 11, 7, 1, 14);
rectangle(4, 9, 1, 1, 15);
rectangle(3, 10, 3, 2, 6);
rectangle(6, 10, 1, 1, 6);
rectangle(1, 12, 22, 1, 12);
rectangle(1, 13, 22, 1, 13);
rectangle(2, 14, 1, 2, 13);
rectangle(21, 14, 1, 2, 13);
rectangle(10, 14, 2, 1, 1);
rectangle(13, 14, 2, 1, 1);
rectangle(9, 15, 3, 1, 4);
rectangle(13, 15, 3, 1, 4);

const rgb = palette.map(hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(';'));

export function renderOfficeWorker(color = true) {
  const lines = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let line = '';
    for (let x = 0; x < 24; x++) {
      const top = pixels[y][x], bottom = pixels[y + 1][x];
      line += color
        ? `\x1b[38;2;${rgb[top]}m\x1b[48;2;${rgb[bottom]}m▀`
        : top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + (color ? '\x1b[0m' : ''));
  }
  return lines;
}
