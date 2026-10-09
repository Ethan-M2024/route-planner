// Template 2: wind timeline chart, wind effect strip, and route map with wind arrows.

import { niceStep, fmt, fmtClock, WIND_COLORS } from './util.js';
import { BADGE_STYLE } from './profile.js';

const font = (w, s) => `${w} ${s}px Inter, Helvetica, Arial, sans-serif`;

export function compass(deg) {
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
}

function setupCanvas(canvas) {
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 900, h = canvas.clientHeight || 240;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function drawWindChart(canvas, { times, cond, U, startUnix, offset }) {
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 44, r: 44, t: 34, b: 30 };
  const total = times.at(-1);
  const stride = Math.max(1, Math.ceil(times.length / 400));
  const idx = [];
  for (let i = 0; i < times.length; i += stride) idx.push(i);
  if (idx.at(-1) !== times.length - 1) idx.push(times.length - 1);

  const ws = idx.map(i => U.speed(cond.windKmh[i]));
  const gs = idx.map(i => cond.gustKmh[i] == null ? null : U.speed(cond.gustKmh[i]));
  const peak = Math.max(10, ...ws, ...gs.filter(v => v != null));
  const step = niceStep(peak / 4);
  const top = Math.ceil(peak * 1.08 / step) * step;
  const X = t => pad.l + t / total * (w - pad.l - pad.r);
  const Y = v => h - pad.b - v / top * (h - pad.t - pad.b);

  ctx.font = font(500, 11.5);
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = '#e9edf2';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#6b7380';
    ctx.textAlign = 'right'; ctx.fillText(fmt(v), pad.l - 8, y);
    ctx.textAlign = 'left'; ctx.fillText(fmt(v), w - pad.r + 8, y);
  }

  // Vertical gridlines on the hour, labeled with local clock time.
  const startLocal = startUnix + offset;
  const firstHour = Math.ceil(startLocal / 3600) * 3600 - startLocal;
  const hourStep = total > 8 * 3600 ? 7200 : 3600;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let t = firstHour; t <= total; t += hourStep) {
    const x = Math.round(X(t)) + 0.5;
    ctx.strokeStyle = '#e9edf2';
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.fillStyle = '#6b7380';
    ctx.fillText(fmtClock(startUnix + t, offset).replace(':00', ''), x, h - 10);
  }

  ctx.beginPath();
  ctx.moveTo(X(times[idx[0]]), Y(0));
  idx.forEach((i, k) => ctx.lineTo(X(times[i]), Y(ws[k])));
  ctx.lineTo(X(times[idx.at(-1)]), Y(0));
  ctx.closePath();
  ctx.fillStyle = '#D0E1F9';
  ctx.fill();

  if (gs.some(v => v != null)) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    idx.forEach((i, k) => { if (gs[k] != null) k ? ctx.lineTo(X(times[i]), Y(gs[k])) : ctx.moveTo(X(times[i]), Y(gs[k])); });
    ctx.strokeStyle = '#7DA7D9';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  idx.forEach((i, k) => k ? ctx.lineTo(X(times[i]), Y(ws[k])) : ctx.moveTo(X(times[i]), Y(ws[k])));
  ctx.strokeStyle = '#2F6FBA';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Legend.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font(600, 12);
  ctx.fillStyle = '#2F6FBA';
  ctx.fillRect(pad.l, 10, 14, 10);
  ctx.fillStyle = '#3a414c';
  ctx.fillText(`Wind speed (${U.speedL})`, pad.l + 20, 15.5);
  const gx = pad.l + 40 + ctx.measureText(`Wind speed (${U.speedL})`).width;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#7DA7D9';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(gx, 15.5); ctx.lineTo(gx + 18, 15.5); ctx.stroke();
  ctx.restore();
  ctx.fillText('Gusts', gx + 24, 15.5);
}

export function drawWindStrip(canvas, { route, cond, U }) {
  const { ctx, w } = setupCanvas(canvas);
  const pad = { l: 44, r: 44 };
  const totalD = U.dist(route.totalKm);
  const X = km => pad.l + U.dist(km) / totalD * (w - pad.l - pad.r);
  let a = 0;
  const n = route.d.length;
  while (a < n - 1) {
    let b = a + 1;
    while (b < n - 1 && cond.cls[b] === cond.cls[a]) b++;
    ctx.fillStyle = WIND_COLORS[cond.cls[a]];
    ctx.fillRect(X(route.d[a]), 4, X(route.d[b]) - X(route.d[a]) + 0.6, 18);
    a = b;
  }
  const step = niceStep(totalD / 8);
  ctx.font = font(500, 11.5);
  ctx.fillStyle = '#6b7380';
  ctx.textAlign = 'center';
  for (let v = 0; v <= totalD + 1e-9; v += step) {
    ctx.fillText(`${fmt(v, step < 1 ? 1 : 0)} ${U.distL}`, pad.l + v / totalD * (w - pad.l - pad.r), 40);
  }
}

export function createMap(el) {
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  return { map, layer: L.layerGroup().addTo(map), hover: null };
}

const pinIcon = (bg, inner, color = '#fff') => L.divIcon({
  className: '',
  html: `<div class="pin" style="background:${bg};color:${color}">${inner}</div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const SVG = {
  start: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 1.5L10.5 6L3 10.5Z" fill="#fff"/></svg>',
  finish: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M0 0h3v3H0zM6 0h3v3H6zM3 3h3v3H3zM9 3h3v3H9zM0 6h3v3H0zM6 6h3v3H6zM3 9h3v3H3zM9 9h3v3H9z" fill="#14181f"/></svg>',
  water: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 .5C7 3 10 5 10 7.5A4 4 0 0 1 2 7.5C2 5 5 3 6 .5Z" fill="#fff"/></svg>',
  fuel: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 1v3.5M3.5 1v3.5M5 1v3.5M2 4.5h3M3.5 4.5V11M8 11V1c2 1 2.4 3.5 1.8 5H8" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>',
};

export function renderMap(m, { route, cond, stations, U, colorMode, markers, fit }) {
  m.layer.clearLayers();
  const ll = route.lat.map((la, i) => [la, route.lon[i]]);
  L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(m.layer);

  if (colorMode === 'wind' && cond) {
    let a = 0;
    while (a < ll.length - 1) {
      let b = a + 1;
      while (b < ll.length - 1 && cond.cls[b] === cond.cls[a]) b++;
      L.polyline(ll.slice(a, b + 1), { color: WIND_COLORS[cond.cls[a]], weight: 5.5, opacity: 1 }).addTo(m.layer);
      a = b;
    }
  } else {
    L.polyline(ll, { color: '#E3171B', weight: 4.5, opacity: 1 }).addTo(m.layer);
  }

  if (cond) {
    const first = stations[0];
    stations.forEach((i, k) => {
      // Loops end where they start; skip the duplicate arrow.
      if (k > 0 && Math.abs(route.lat[i] - route.lat[first]) + Math.abs(route.lon[i] - route.lon[first]) < 0.008) return;
      const sp = cond.windKmh[i], from = cond.windFrom[i];
      const size = Math.round(22 + Math.min(18, sp * 0.7));
      const html = `<div class="wind-icon" style="width:${size}px;height:${size}px">
        <div class="arr" style="transform:rotate(${(from + 180) % 360}deg)">
          <svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 1.5L19.5 21L12 16.5L4.5 21Z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>
        </div><span class="lbl">${Math.round(U.speed(sp))}</span></div>`;
      const gust = cond.gustKmh[i] != null ? `, gusts ${Math.round(U.speed(cond.gustKmh[i]))}` : '';
      L.marker(ll[i], { icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), keyboard: false })
        .bindTooltip(`${U.distL === 'mi' ? 'Mile' : 'Km'} ${fmt(U.dist(route.d[i]), 1)}: ${Math.round(U.speed(sp))} ${U.speedL} from the ${compass(from)}${gust}`)
        .addTo(m.layer);
    });
  }

  for (const mk of markers) {
    const bg = mk.type === 'finish' ? '#fff' : mk.type === 'climb' ? BADGE_STYLE.climb.fill : BADGE_STYLE[mk.type].fill;
    const inner = SVG[mk.type] || mk.label;
    L.marker(mk.latlng, { icon: pinIcon(bg, inner), zIndexOffset: mk.type === 'start' || mk.type === 'finish' ? 1000 : 500 })
      .bindTooltip(mk.tip)
      .addTo(m.layer);
  }

  if (fit) m.map.fitBounds(L.latLngBounds(ll), { padding: [28, 28] });
}

export function setMapHover(m, latlng) {
  if (!latlng) { if (m.hover) { m.hover.remove(); m.hover = null; } return; }
  if (!m.hover) {
    m.hover = L.circleMarker(latlng, { radius: 7, color: '#14181f', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(m.map);
  } else {
    m.hover.setLatLng(latlng);
  }
}
