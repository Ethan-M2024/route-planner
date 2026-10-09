// Template 1: VeloViewer style elevation profile, 1200 x 675, slices colored by gradient.

import { gradeColor, niceStep, interpAt, bisect, fmt } from './util.js';

export const W = 1200, H = 675;
export const P = { l: 86, r: 1150, t: 136, b: 536 };
const R = 13;
const font = (w, s) => `${w} ${s}px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif`;

export const BADGE_STYLE = {
  start: { fill: '#1E6FD9', name: 'Start' },
  finish: { fill: '#ffffff', name: 'Finish' },
  climb: { fill: '#D62828', name: 'Climb top' },
  water: { fill: '#06B6D4', name: 'Bottle empty' },
  fuel: { fill: '#1E6FD9', name: 'Eat' },
  poi: { fill: '#6B7280', name: 'Waypoint' },
};
// Lower numbers get placed first so they sit closest to the profile line.
const PRIORITY = { start: 0, finish: 0, climb: 1, poi: 2, water: 3, fuel: 4 };

function drawIcon(ctx, type, label, x, y, r = R) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.28)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_STYLE[type].fill;
  ctx.fill();
  ctx.restore();

  ctx.save();
  if (type === 'finish') {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    const s = r / 2;
    for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) {
      if ((i + j) % 2 === 0) { ctx.fillStyle = '#14181f'; ctx.fillRect(x + i * s, y + j * s, s, s); }
    }
    ctx.restore();
    ctx.save();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = type === 'finish' ? '#14181f' : '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  const k = r / 13;
  if (type === 'start') {
    ctx.beginPath();
    ctx.moveTo(x - 4 * k, y - 6 * k);
    ctx.lineTo(x + 6.5 * k, y);
    ctx.lineTo(x - 4 * k, y + 6 * k);
    ctx.closePath();
    ctx.fill();
  } else if (type === 'water') {
    ctx.beginPath();
    ctx.moveTo(x, y - 8 * k);
    ctx.bezierCurveTo(x + 2 * k, y - 4 * k, x + 6 * k, y - 1 * k, x + 6 * k, y + 2.5 * k);
    ctx.arc(x, y + 2.5 * k, 6 * k, 0, Math.PI);
    ctx.bezierCurveTo(x - 6 * k, y - 1 * k, x - 2 * k, y - 4 * k, x, y - 8 * k);
    ctx.fill();
  } else if (type === 'fuel') {
    ctx.lineWidth = 1.6 * k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const dx of [-6.5, -4, -1.5]) { ctx.moveTo(x + dx * k, y - 7 * k); ctx.lineTo(x + dx * k, y - 2 * k); }
    ctx.moveTo(x - 6.5 * k, y - 2 * k); ctx.lineTo(x - 1.5 * k, y - 2 * k);
    ctx.moveTo(x - 4 * k, y - 2 * k); ctx.lineTo(x - 4 * k, y + 7 * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 3 * k, y + 7 * k);
    ctx.lineTo(x + 3 * k, y - 7 * k);
    ctx.quadraticCurveTo(x + 7.5 * k, y - 4 * k, x + 6.5 * k, y + 1 * k);
    ctx.lineTo(x + 3 * k, y + 1 * k);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type !== 'finish') {
    const text = type === 'poi' ? (label || '?').slice(0, 1).toUpperCase() : label;
    ctx.font = font(800, text.length > 1 ? 10.5 * k : 12.5 * k);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }
  ctx.restore();
}

export function drawProfile(canvas, { route, U, title, subtitle, badges, footerRight }) {
  const dpr = 2;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Header: title, metadata subtitle, accent lines, branding.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#14181f';
  let size = 34;
  do { ctx.font = font(800, size); size -= 1; } while (ctx.measureText(title).width > 760 && size > 18);
  ctx.fillText(title, W / 2, 60);

  ctx.font = font(500, 17);
  ctx.fillStyle = '#4a5260';
  ctx.fillText(subtitle, W / 2, 94);
  const half = ctx.measureText(subtitle).width / 2;
  ctx.strokeStyle = '#E65100';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - half - 22, 88); ctx.lineTo(W / 2 - half - 130, 88);
  ctx.moveTo(W / 2 + half + 22, 88); ctx.lineTo(W / 2 + half + 130, 88);
  ctx.stroke();
  ctx.strokeStyle = '#e3e6eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 116.5); ctx.lineTo(W - 40, 116.5);
  ctx.stroke();

  ctx.save();
  ctx.translate(W - 172, 22);
  ctx.beginPath();
  ctx.moveTo(0, 18); ctx.lineTo(7, 8); ctx.lineTo(11, 13); ctx.lineTo(16, 3); ctx.lineTo(23, 18); ctx.closePath();
  ctx.fillStyle = '#E65100';
  ctx.fill();
  ctx.font = font(800, 12.5);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#14181f';
  ctx.fillText('ROUTE PLANNER', 30, 16);
  ctx.restore();

  // Scales in display units.
  const dD = route.d.map(U.dist);
  const eD = route.ele.map(U.ele);
  const totalD = dD.at(-1);
  const minE = Math.min(...eD), maxE = Math.max(...eD);
  const range = Math.max(maxE - minE, U.eleL === 'ft' ? 150 : 50);
  const step = niceStep(range / 4);
  let lo = Math.floor((minE - range * 0.15) / step) * step;
  if (minE >= 0) lo = Math.max(0, lo);
  const hi = maxE + (maxE - lo) * 0.42;
  const X = v => P.l + v / totalD * (P.r - P.l);
  const Y = e => P.b - (e - lo) / (hi - lo) * (P.b - P.t);

  // Gridlines and elevation labels.
  ctx.font = font(500, 12);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let topTick = lo;
  for (let v = lo; Y(v) >= P.t; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = '#eceef1';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.r, y); ctx.stroke();
    ctx.fillStyle = '#6b7380';
    ctx.fillText(fmt(v), P.l - 10, y);
    topTick = v;
  }
  ctx.font = font(700, 11);
  ctx.fillText(U.eleL, P.l - 10, Y(topTick) - 18);

  // Gradient slices: merge consecutive samples that share a color bucket.
  const n = dD.length;
  const key = i => Math.round((route.grade[i] + route.grade[Math.min(n - 1, i + 1)]) / 2);
  let a = 0;
  while (a < n - 1) {
    const kk = key(a);
    let b = a + 1;
    while (b < n - 1 && key(b) === kk) b++;
    ctx.beginPath();
    ctx.moveTo(X(dD[a]), P.b);
    for (let i = a; i <= b; i++) ctx.lineTo(X(dD[i]), Y(eD[i]));
    ctx.lineTo(X(dD[b]), P.b);
    ctx.closePath();
    ctx.fillStyle = gradeColor(kk);
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    a = b;
  }

  ctx.beginPath();
  for (let i = 0; i < n; i++) i ? ctx.lineTo(X(dD[i]), Y(eD[i])) : ctx.moveTo(X(dD[i]), Y(eD[i]));
  ctx.strokeStyle = '#1d232c';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Asphalt baseline with lane dashes and distance ticks.
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(P.l, P.b, P.r - P.l, 18);
  ctx.save();
  ctx.setLineDash([12, 9]);
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(P.l + 4, P.b + 9); ctx.lineTo(P.r - 4, P.b + 9); ctx.stroke();
  ctx.restore();

  const dStep = niceStep(totalD / 9);
  ctx.font = font(600, 12.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let v = 0; v <= totalD + 1e-9; v += dStep) {
    const x = Math.round(X(v)) + 0.5;
    ctx.strokeStyle = '#2b2f36';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, P.b + 18); ctx.lineTo(x, P.b + 24); ctx.stroke();
    ctx.fillStyle = '#3a414c';
    ctx.fillText(`${fmt(v, dStep < 1 ? 1 : 0)} ${U.distL}`, x, P.b + 40);
  }

  // Badges: place important ones first, then stack the rest upward to avoid overlaps.
  const placed = [];
  const sorted = [...badges].sort((p, q) => PRIORITY[p.type] - PRIORITY[q.type] || p.km - q.km);
  for (const b of sorted) {
    const v = U.dist(b.km);
    const x = Math.min(P.r, Math.max(P.l, X(v)));
    const i0 = bisect(dD, v - (14 / (P.r - P.l)) * totalD);
    const i1 = bisect(dD, v + (14 / (P.r - P.l)) * totalD);
    let localTop = Infinity;
    for (let i = i0; i <= Math.min(n - 1, i1 + 1); i++) localTop = Math.min(localTop, Y(eD[i]));
    const curveY = Y(interpAt(dD, eD, v));
    let y = localTop - 30;
    let guard = 0;
    while (placed.some(p => Math.hypot(p.x - x, p.y - y) < 2 * R + 3) && guard++ < 20) y -= 2 * R + 4;
    y = Math.max(y, 132);
    placed.push({ x, y, curveY, ...b });
  }
  for (const p of placed) {
    ctx.strokeStyle = 'rgba(20,24,31,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(p.x) + 0.5, p.y + R); ctx.lineTo(Math.round(p.x) + 0.5, p.curveY); ctx.stroke();
  }
  for (const p of placed) drawIcon(ctx, p.type, p.label, p.x, p.y);

  // Badge key on the left, gradient legend on the right.
  const used = [...new Set(badges.map(b => b.type))].sort((p, q) => PRIORITY[p] - PRIORITY[q]);
  let kx = P.l;
  ctx.font = font(500, 12);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const t of used) {
    drawIcon(ctx, t, t === 'climb' ? '2' : 'W', kx + 8, 612, 8);
    ctx.fillStyle = '#3a414c';
    ctx.fillText(BADGE_STYLE[t].name, kx + 21, 612.5);
    kx += 34 + ctx.measureText(BADGE_STYLE[t].name).width;
  }

  const lx = 830, lw = 320, ly = 604;
  for (let i = 0; i < lw; i++) {
    ctx.fillStyle = gradeColor(-25 + 50 * i / (lw - 1));
    ctx.fillRect(lx + i, ly, 1.5, 12);
  }
  ctx.strokeStyle = '#c9ced6';
  ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, 11);
  ctx.font = font(600, 11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#4a5260';
  for (const g of [-25, -10, 0, 10, 25]) ctx.fillText(`${g}%`, lx + (g + 25) / 50 * lw, ly + 28);
  ctx.textAlign = 'right';
  ctx.font = font(700, 11.5);
  ctx.fillText('GRADIENT', lx - 10, ly + 10);

  ctx.font = font(500, 11.5);
  ctx.fillStyle = '#8a929e';
  ctx.textAlign = 'left';
  ctx.fillText('Route Planner  ·  weather and terrain by Open-Meteo  ·  map data © OpenStreetMap', 40, 660);
  ctx.textAlign = 'right';
  ctx.fillText(footerRight || '', W - 40, 660);

  return { totalD, lo, hi };
}
