// Units, formatting and the gradient color scale shared by every view.

export const UNITS = {
  imperial: {
    dist: km => km * 0.621371, distL: 'mi',
    ele: m => m * 3.28084, eleL: 'ft',
    speed: kmh => kmh * 0.621371, speedL: 'mph',
    temp: c => c * 9 / 5 + 32, tempL: '°F',
    vol: ml => ml / 29.5735, volL: 'oz',
    toKm: v => v / 0.621371,
    toKmh: v => v / 0.621371,
    toMl: v => v * 29.5735,
  },
  metric: {
    dist: km => km, distL: 'km',
    ele: m => m, eleL: 'm',
    speed: kmh => kmh, speedL: 'km/h',
    temp: c => c, tempL: '°C',
    vol: ml => ml, volL: 'ml',
    toKm: v => v,
    toKmh: v => v,
    toMl: v => v,
  },
};

export const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// Clock time at the route's location: unix seconds plus the location's UTC offset.
export function fmtClock(unix, offsetSec) {
  const d = new Date((unix + offsetSec) * 1000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Index of the last element in a sorted array that is <= v.
export function bisect(arr, v) {
  let lo = 0, hi = arr.length - 1;
  if (v <= arr[0]) return 0;
  if (v >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

// Linear lookup of ys at x along a sorted xs.
export function interpAt(xs, ys, x) {
  const i = bisect(xs, x);
  if (i >= xs.length - 1) return ys[xs.length - 1];
  const span = xs[i + 1] - xs[i];
  const f = span > 0 ? (x - xs[i]) / span : 0;
  return ys[i] + (ys[i + 1] - ys[i]) * f;
}

// Percent grade to fill color, following the VeloViewer style palette.
export const GRADE_STOPS = [
  [-25, '#00008B'],
  [-10, '#00FFFF'],
  [-2, '#90EE90'],
  [3, '#00E000'],
  [4, '#ADFF2F'],
  [7, '#FFFF00'],
  [8, '#FFA500'],
  [12, '#FF0000'],
  [16, '#8B0000'],
  [25, '#2B0033'],
];

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const STOPS_RGB = GRADE_STOPS.map(([g, h]) => [g, hexRgb(h)]);

export function gradeColor(g) {
  if (g <= STOPS_RGB[0][0]) return `rgb(${STOPS_RGB[0][1]})`;
  for (let i = 1; i < STOPS_RGB.length; i++) {
    const [g1, c1] = STOPS_RGB[i];
    if (g <= g1) {
      const [g0, c0] = STOPS_RGB[i - 1];
      const f = (g - g0) / (g1 - g0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return `rgb(${STOPS_RGB.at(-1)[1]})`;
}

export const WIND_COLORS = { head: '#d7263d', cross: '#f4a259', tail: '#2a9d8f', calm: '#a7b0bd' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
