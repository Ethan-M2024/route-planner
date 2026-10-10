import { UNITS, fmt, fmtDuration, fmtClock, escapeHtml, bisect } from './util.js';
import { parseGPX, analyzeRoute } from './route.js';
import { weatherStations, fetchWeather, conditionsAlong, weatherText } from './weather.js';
import { estimateTimes, buildPlan } from './plan.js';
import { drawProfile, W as PW, P as PP } from './profile.js';
import { createFlyover } from './flyover.js';
import { drawWindChart, drawWindStrip, createMap, renderMap, setMapHover, compass } from './windviz.js';

const $ = id => document.getElementById(id);
const state = {
  units: 'imperial',
  gpx: null,
  gpxId: 0,
  fileName: '',
  route: null,
  wx: null,
  wxKey: '',
  colorMode: 'red',
  map: null,
  fitNext: true,
  result: null,
};

// ---------- Setup ----------

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
$('date').value = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

function setStatus(msg, isErr = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('err', isErr);
}

function loadText(text, name) {
  try {
    state.gpx = parseGPX(text);
  } catch (e) {
    setStatus(e.message, true);
    return false;
  }
  state.fileName = name.replace(/\.gpx$/i, '');
  state.gpxId++;
  state.route = null;
  state.wxKey = '';
  state.fitNext = true;
  $('dropText').textContent = `${name} · ${fmt(state.gpx.points.length)} points loaded`;
  $('drop').classList.add('loaded');
  $('go').disabled = false;
  setStatus('');
  return true;
}

$('file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f && loadText(await f.text(), f.name)) run();
});

const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async e => {
  const f = e.dataTransfer.files[0];
  if (f && loadText(await f.text(), f.name)) run();
});

$('sample').addEventListener('click', async () => {
  setStatus('Loading sample route...');
  const res = await fetch('sample/boulder-ward-nederland.gpx');
  if (loadText(await res.text(), 'boulder-ward-nederland.gpx')) run();
});

$('go').addEventListener('click', run);

document.querySelectorAll('[data-units]').forEach(btn => btn.addEventListener('click', () => {
  const next = btn.dataset.units;
  if (next === state.units) return;
  const from = UNITS[state.units], to = UNITS[next];
  $('speed').value = Math.round(to.speed(from.toKmh(+$('speed').value)) * 2) / 2;
  $('bottle').value = Math.round(to.vol(from.toMl(+$('bottle').value)));
  state.units = next;
  document.querySelectorAll('[data-units]').forEach(b => b.classList.toggle('on', b === btn));
  document.querySelectorAll('.u-speed').forEach(s => { s.textContent = to.speedL; });
  document.querySelectorAll('.u-vol').forEach(s => { s.textContent = to.volL; });
  if (state.result) render();
}));

document.querySelectorAll('[data-color]').forEach(btn => btn.addEventListener('click', () => {
  state.colorMode = btn.dataset.color;
  document.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b === btn));
  if (state.result) drawMap();
}));

let rerunTimer;
['date', 'time', 'speed', 'sweat', 'carbs', 'bottle'].forEach(id => $(id).addEventListener('change', () => {
  if (!state.result) return;
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(run, 250);
}));
$('showPlan').addEventListener('change', () => state.result && drawProfileView());

$('wxBack').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('wxMenu').addEventListener('click', () => downloadCanvas($('windChart'), 'wind'));
$('dlProfile').addEventListener('click', () => downloadCanvas($('profile'), 'elevation'));

function downloadCanvas(canvas, suffix) {
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.fileName || 'route').replace(/[^\w]+/g, '-').toLowerCase()}-${suffix}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

function readSettings() {
  const U = UNITS[state.units];
  const speed = Math.min(60, Math.max(5, +$('speed').value || 16));
  const bottle = Math.max(100, U.toMl(+$('bottle').value || 24));
  return {
    flatKmh: U.toKmh(speed),
    bottleMl: bottle,
    sweat: $('sweat').value,
    carbRate: $('carbs').value,
  };
}

// ---------- Pipeline ----------

let running = false;
async function run() {
  if (!state.gpx || running) return;
  running = true;
  $('go').disabled = true;
  try {
    if (!state.route) {
      setStatus('Reading route...');
      state.route = await analyzeRoute(state.gpx, msg => setStatus(msg));
    }
    const route = state.route;
    const settings = readSettings();
    const stations = weatherStations(route);
    const dateStr = $('date').value || $('date').defaultValue;
    const timeStr = $('time').value || '08:00';

    let wxError = null;
    const key = `${state.gpxId}|${dateStr}`;
    if (state.wxKey !== key) {
      setStatus('Getting the forecast along your route...');
      try {
        state.wx = await fetchWeather(route, stations, dateStr);
        state.wxKey = key;
      } catch (e) {
        state.wx = null;
        state.wxKey = '';
        wxError = e.message;
      }
    }
    const wx = state.wx;

    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mi] = timeStr.split(':').map(Number);
    const offset = wx ? wx.offset : -new Date(y, mo - 1, d, hh, mi).getTimezoneOffset() * 60;
    const startUnix = Date.UTC(y, mo - 1, d, hh, mi) / 1000 - offset;

    // Time the ride on terrain alone, look up wind for those times, then retime with the wind.
    let times = estimateTimes(route, settings.flatKmh);
    let cond = null;
    if (wx) {
      cond = conditionsAlong(route, times, wx, startUnix, stations);
      times = estimateTimes(route, settings.flatKmh, cond.head);
      cond = conditionsAlong(route, times, wx, startUnix, stations);
    }
    const plan = buildPlan(route, times, cond, settings);

    state.result = { route, times, cond, plan, wx, wxError, stations, startUnix, offset, dateStr, settings };
    const first = $('results').hidden;
    $('results').hidden = false;
    render();
    setStatus('');
    if (first) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Something went wrong reading that route.', true);
  } finally {
    running = false;
    $('go').disabled = false;
  }
}

// ---------- Rendering ----------

const U = () => UNITS[state.units];
const distWord = () => (state.units === 'imperial' ? 'mile' : 'km');
const clock = t => fmtClock(state.result.startUnix + t, state.result.offset);
const dLabel = km => fmt(U().dist(km), 1);
const timeAtKm = km => state.result.times[bisect(state.result.route.d, km)];
const latlngAt = km => {
  const { route } = state.result;
  const i = bisect(route.d, km);
  return [route.lat[i], route.lon[i]];
};

const flyover = createFlyover({
  map: $('fly'), hud: $('hud'), next: $('flyNext'), msg: $('flyMsg'),
  play: $('flyPlay'), scrub: $('flyScrub'), mini: $('flyProfile'), speed: $('flySpeed'), overview: $('flyOverview'),
  viewBtns: document.querySelectorAll('[data-view]'), baseBtns: document.querySelectorAll('[data-base]'),
});

function render() {
  renderStats();
  drawProfileView();
  renderClimbs();
  const { route, times, cond, plan } = state.result;
  flyover.update({ route, times, cond, plan, U: U(), clock, distWord });
  renderWeather();
  renderPlan();
}

function routeTitle() {
  return state.result.route.name || state.fileName.replace(/[-_]+/g, ' ') || 'My Ride';
}

function niceDate() {
  const [y, m, d] = state.result.dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function renderStats() {
  const { route, plan, cond, times } = state.result;
  const u = U();
  const avg = u.speed(route.totalKm / (times.at(-1) / 3600));
  const tiles = [
    ['Distance', `${fmt(u.dist(route.totalKm), 1)} ${u.distL}`],
    ['Elevation gain', `${fmt(u.ele(route.gainM))} ${u.eleL}`, `High point ${fmt(u.ele(route.maxEle))} ${u.eleL}`],
    ['Moving time', fmtDuration(plan.totalSec), `Conservative, ${fmt(avg, 1)} ${u.speedL} average`],
    ['Finish around', clock(plan.totalSec), `Rolling out ${clock(0)}`],
  ];
  if (cond) {
    const temps = cond.tempC.filter(v => v != null);
    tiles.push(['Temperature', `${fmt(u.temp(Math.min(...temps)))} to ${fmt(u.temp(Math.max(...temps)))}${u.tempL}`]);
  }
  tiles.push(['Water', `${fmt(u.vol(plan.totalMl))} ${u.volL}`, `${fmt(plan.bottlesNeeded, 1)} bottles`]);
  tiles.push(['Carbs', `${fmt(plan.totalCarbs)} g`, plan.carbRate ? `${plan.carbRate} g per hour` : 'Water is enough']);
  $('stats').innerHTML = tiles.map(([k, v, s]) => `<div class="stat"><span>${k}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`).join('');
}

function badgeList() {
  const { route, plan } = state.result;
  const b = [{ km: 0, type: 'start', label: 'Start' }, { km: route.totalKm, type: 'finish', label: 'Finish' }];
  route.climbs.forEach(c => b.push({ km: c.endKm, type: 'climb', label: c.cat }));
  route.pois.forEach(p => b.push({ km: p.km, type: 'poi', label: p.name }));
  if ($('showPlan').checked) {
    plan.bottles.forEach(x => b.push({ km: x.km, type: 'water', label: String(x.n) }));
    plan.fuel.forEach(x => b.push({ km: x.km, type: 'fuel', label: String(x.n) }));
  }
  return b;
}

function drawProfileView() {
  const { route } = state.result;
  const u = U();
  drawProfile($('profile'), {
    route,
    U: u,
    title: routeTitle(),
    subtitle: `${fmt(u.dist(route.totalKm), 1)} ${u.distL}   ·   ${fmt(u.ele(route.gainM))} ${u.eleL} elevation gain   ·   ${niceDate()}`,
    badges: badgeList(),
    footerRight: route.elevationSource === 'lookup' ? 'Elevation looked up from terrain data' : 'Elevation from GPX',
  });
}

function renderClimbs() {
  const { route } = state.result;
  const u = U();
  if (!route.climbs.length) {
    $('climbs').innerHTML = '<p class="fine">No categorized climbs on this route.</p>';
    return;
  }
  $('climbs').innerHTML = route.climbs.map(c => `
    <div class="climb">
      <div class="cat">${c.cat}</div>
      <div>
        <b>${c.cat === 'HC' ? 'Hors catégorie' : `Category ${c.cat}`} climb</b>, ${distWord()} ${dLabel(c.startKm)} to ${dLabel(c.endKm)}
        <div class="muted">${fmt(u.dist(c.lenKm), 1)} ${u.distL} at ${fmt(c.avg, 1)}% average, steepest ${fmt(c.maxGrade, 0)}%, ${fmt(u.ele(c.gainM))} ${u.eleL} of climbing. Top around ${clock(timeAtKm(c.endKm))}.</div>
      </div>
    </div>`).join('');
}

// Profile hover: show distance, elevation, grade and arrival time, and track the spot on the map.
const wrap = $('profileWrap');
wrap.addEventListener('mousemove', e => {
  if (!state.result) return;
  const rect = $('profile').getBoundingClientRect();
  const scale = rect.width / PW;
  const px = (e.clientX - rect.left) / scale;
  if (px < PP.l || px > PP.r) return hideHover();
  const { route, cond, times } = state.result;
  const u = U();
  const km = (px - PP.l) / (PP.r - PP.l) * route.totalKm;
  const i = bisect(route.d, km);
  const line = $('hoverLine'), tip = $('tip');
  line.hidden = false;
  line.style.left = `${e.clientX - rect.left}px`;
  line.style.top = `${PP.t * scale}px`;
  line.style.height = `${(PP.b - PP.t) * scale}px`;
  const word = distWord();
  const wind = cond ? `<br>${{ head: 'Headwind', tail: 'Tailwind', cross: 'Crosswind', calm: 'Calm' }[cond.cls[i]]}, ${fmt(u.speed(cond.windKmh[i]))} ${u.speedL} from ${compass(cond.windFrom[i])}` : '';
  tip.innerHTML = `<b>${word[0].toUpperCase() + word.slice(1)} ${dLabel(route.d[i])}</b> · ${fmt(u.ele(route.ele[i]))} ${u.eleL} · ${fmt(route.grade[i], 1)}%<br>Around ${clock(times[i])} (${fmtDuration(times[i])} in)${wind}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(rect.width - 140, Math.max(140, e.clientX - rect.left))}px`;
  tip.style.top = `${Math.max(70, e.clientY - rect.top - 12)}px`;
  if (state.map) setMapHover(state.map, [route.lat[i], route.lon[i]]);
});
wrap.addEventListener('mouseleave', hideHover);
function hideHover() {
  $('hoverLine').hidden = true;
  $('tip').hidden = true;
  if (state.map) setMapHover(state.map, null);
}

function renderWeather() {
  const { cond, wx, wxError, plan } = state.result;
  const u = U();
  $('wxSub').textContent = `${niceDate()} · ${clock(0)} start${wx?.tzAbbr ? ` ${wx.tzAbbr}` : ''}`;

  const notes = [];
  if (wxError) notes.push(`Weather could not be loaded (${escapeHtml(wxError)}). The water plan assumes mild temperatures.`);
  if (wx?.mode === 'typical') notes.push(`Forecasts only reach 16 days out. Showing the actual weather from ${wx.sourceDate} on this route as a rough guide. Check back closer to ride day.`);
  if (wx?.mode === 'past') notes.push('This date is in the past, so you are seeing recorded weather.');
  if (cond?.outOfRange) notes.push('Part of this ride runs past the end of the forecast window, so later hours repeat the last available forecast.');
  $('wxNotice').hidden = !notes.length;
  $('wxNotice').innerHTML = notes.join('<br>');

  // Without weather, hide the wind chart module but keep the map.
  $('windChart').closest('.wx-module').hidden = !cond;

  if (!cond) {
    $('wxTiles').innerHTML = '';
    drawMap();
    return;
  }

  const n = cond.tempC.length;
  const pick = arr => arr.filter(v => v != null);
  const feels = pick(cond.feelsC);
  const gusts = pick(cond.gustKmh);
  const probs = pick(cond.precipProb);
  const codes = pick(cond.code);
  const worst = codes.length ? Math.max(...codes) : null;
  const mid = cond.code[Math.floor(n / 2)];
  const avgWind = cond.windKmh.reduce((s, v) => s + v, 0) / n;
  const rainMm = pick(cond.precip).reduce((s, v) => s + v, 0) / Math.max(1, n) * plan.hours;
  const imperial = state.units === 'imperial';

  const tiles = [
    ['At the start', `${fmt(u.temp(cond.tempC[0]))}${u.tempL}`, `${weatherText(cond.code[0]).icon} ${weatherText(cond.code[0]).label}`],
    ['At the finish', `${fmt(u.temp(cond.tempC[n - 1]))}${u.tempL}`, `${weatherText(cond.code[n - 1]).icon} ${weatherText(cond.code[n - 1]).label}`],
    ['Feels like', feels.length ? `${fmt(u.temp(Math.min(...feels)))} to ${fmt(u.temp(Math.max(...feels)))}${u.tempL}` : 'n/a', 'Range over the ride'],
    probs.length
      ? ['Rain chance', `${fmt(Math.max(...probs))}%`, worst >= 51 ? `Watch for ${weatherText(worst).label.toLowerCase()}` : 'Peak along the route']
      : ['Rain', `${fmt(imperial ? rainMm / 25.4 : rainMm, imperial ? 2 : 1)} ${imperial ? 'in' : 'mm'}`, 'Recorded during the ride window'],
    ['Wind', `${fmt(u.speed(avgWind))} ${u.speedL}`, gusts.length ? `Gusts to ${fmt(u.speed(Math.max(...gusts)))} ${u.speedL}` : ''],
    ['Sky mid ride', `${weatherText(mid).icon} ${weatherText(mid).label}`, ''],
  ];
  $('wxTiles').innerHTML = tiles.map(([k, v, s]) => `<div class="wx-tile"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('');

  drawWindViews();
  $('windSummary').innerHTML = windSummary();
  drawMap();
}

function drawWindViews() {
  const { route, times, cond, startUnix, offset } = state.result;
  drawWindChart($('windChart'), { times, cond, U: U(), startUnix, offset });
  drawWindStrip($('windStrip'), { route, cond, U: U() });
}

function windSummary() {
  const { route, cond } = state.result;
  const u = U();
  const km = { head: 0, cross: 0, tail: 0, calm: 0 };
  const runs = [];
  let cur = null;
  for (let i = 1; i < route.d.length; i++) {
    const dd = route.d[i] - route.d[i - 1];
    km[cond.cls[i]] += dd;
    if (cond.cls[i] === 'head') {
      if (cur && route.d[i] - cur.end <= 1.5) { cur.end = route.d[i]; cur.sum += cond.head[i] * dd; cur.len += dd; }
      else { cur = { start: route.d[i - 1], end: route.d[i], sum: cond.head[i] * dd, len: dd }; runs.push(cur); }
    }
  }
  const total = route.totalKm;
  const pct = k => Math.round(km[k] / total * 100);
  if (km.head < total * 0.08 && km.tail < total * 0.08) {
    return 'Mostly light or crosswinds. Wind should not be a big factor on this ride.';
  }
  let s = `Headwind for <b>${fmt(u.dist(km.head), 1)} ${u.distL}</b> (${pct('head')}%), tailwind for <b>${fmt(u.dist(km.tail), 1)} ${u.distL}</b> (${pct('tail')}%), crosswind for ${fmt(u.dist(km.cross), 1)} ${u.distL}.`;
  const best = runs.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  if (best && best.end - best.start > 2) {
    s += ` Toughest stretch is ${distWord()} ${dLabel(best.start)} to ${dLabel(best.end)}, with about <b>${fmt(u.speed(best.sum / best.len))} ${u.speedL}</b> of wind in your face. Plan to tuck in or share the work there.`;
  }
  return s;
}

function drawMap() {
  const { route, cond, stations, plan } = state.result;
  if (!state.map) state.map = createMap($('map'));
  state.map.map.invalidateSize();

  const markers = [];
  const loop = Math.abs(route.lat[0] - route.lat.at(-1)) + Math.abs(route.lon[0] - route.lon.at(-1)) < 0.003;
  markers.push({ type: 'start', latlng: latlngAt(0), tip: loop ? `Start and finish, ${clock(0)}` : `Start, ${clock(0)}` });
  if (!loop) markers.push({ type: 'finish', latlng: latlngAt(route.totalKm), tip: `Finish, around ${clock(plan.totalSec)}` });
  route.climbs.forEach(c => markers.push({
    type: 'climb', label: c.cat, latlng: latlngAt(c.endKm),
    tip: `Top of ${c.cat === 'HC' ? 'HC' : `Cat ${c.cat}`} climb, ${distWord()} ${dLabel(c.endKm)}`,
  }));
  plan.bottles.forEach(b => markers.push({
    type: 'water', latlng: latlngAt(b.km),
    tip: `Bottle ${b.n} empty by ${distWord()} ${dLabel(b.km)} (${clock(b.t)})`,
  }));
  plan.fuel.forEach(f => markers.push({
    type: 'fuel', latlng: latlngAt(f.km),
    tip: `Eat ${f.grams} g carbs by ${distWord()} ${dLabel(f.km)} (${clock(f.t)}), ${f.cumGrams} g total`,
  }));

  renderMap(state.map, { route, cond, stations, U: U(), colorMode: state.colorMode, markers, fit: state.fitNext });
  state.fitNext = false;
}

const dropSvg = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M6 .5C7 3 10 5 10 7.5A4 4 0 0 1 2 7.5C2 5 5 3 6 .5Z" fill="#fff"/></svg>';
const forkSvg = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 1v3.5M3.5 1v3.5M5 1v3.5M2 4.5h3M3.5 4.5V11M8 11V1c2 1 2.4 3.5 1.8 5H8" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>';

function renderPlan() {
  const { plan } = state.result;
  const u = U();
  const bottle = `${fmt(u.vol(plan.bottleMl))} ${u.volL}`;
  const perHour = u.vol(plan.totalMl / plan.hours);

  let water = `<div class="plan">
    <h3><span class="dot" style="background:#06B6D4">${dropSvg}</span>Water</h3>
    <p class="lead">Drink about <b>${fmt(u.vol(plan.totalMl))} ${u.volL}</b> over ${fmtDuration(plan.totalSec)}, which is <b>${fmt(plan.bottlesNeeded, 1)} bottles</b> of ${bottle}. That works out to ${fmt(perHour)} ${u.volL} per hour, so take a few big sips every 10 to 15 minutes.</p>`;
  if (plan.bottles.length) {
    water += `<table><tr><th>Bottle</th><th>Empty by</th><th>Clock</th><th>Ride time</th></tr>${
      plan.bottles.map(b => `<tr><td>#${b.n}</td><td>${distWord()} ${dLabel(b.km)}</td><td>${clock(b.t)}</td><td>${fmtDuration(b.t)}</td></tr>`).join('')
    }</table>`;
  } else {
    water += '<p class="lead">You will not finish a full bottle on this ride. Sip steadily anyway.</p>';
  }
  if (plan.bottlesNeeded > 2 && plan.bottles[1]) {
    water += `<div class="callout warn">Two cages hold ${fmt(u.vol(plan.bottleMl * 2))} ${u.volL}. Plan a refill stop before ${distWord()} ${dLabel(plan.bottles[1].km)}${plan.bottlesNeeded > 4 && plan.bottles[3] ? `, and another before ${distWord()} ${dLabel(plan.bottles[3].km)}` : ''}.</div>`;
  } else {
    water += '<div class="callout">Two bottles cover this ride with no refill stop.</div>';
  }
  if (plan.sodiumMgH) {
    water += `<div class="callout">Add electrolytes: roughly <b>${plan.sodiumMgH} mg sodium per hour</b>${plan.hot ? ' because a lot of this ride is hot' : ''}. A drink mix in every bottle is the easy way.</div>`;
  }
  water += `<p class="fine">Before you go: drink ${fmt(u.vol(500))} ${u.volL} in the two hours before you roll out.</p></div>`;

  let fuel = `<div class="plan"><h3><span class="dot" style="background:#1E6FD9">${forkSvg}</span>Carbs</h3>`;
  if (!plan.carbRate) {
    fuel += '<p class="lead">Under an hour of riding, water is enough. Eat a normal carb heavy meal two to three hours before.</p></div>';
  } else {
    const gels = Math.ceil(plan.totalCarbs / 25);
    const half = Math.round(plan.carbRate / 2);
    fuel += `<p class="lead">Target <b>${plan.carbRate} g of carbs per hour</b>${plan.carbAuto ? ' (picked for a ride this long)' : ''}, about <b>${fmt(plan.totalCarbs)} g</b> in total. Start eating in the first 30 minutes and keep the rhythm, even when you do not feel hungry.</p>
      <table><tr><th>Eat by</th><th>Clock</th><th>Ride time</th><th>Amount</th><th>Running total</th></tr>${
        plan.fuel.map(f => `<tr><td>${distWord()} ${dLabel(f.km)}</td><td>${clock(f.t)}</td><td>${fmtDuration(f.t)}</td><td>${f.grams} g</td><td>${f.cumGrams} g</td></tr>`).join('')
      }</table>
      <div class="callout">What ${half} g looks like: ${half >= 35 ? 'one gel plus a few chews, or most of a bar' : 'one gel, one banana, or half a bar'}. Whole ride: about ${gels} gels worth, so pack ${gels + 1} servings to have a spare.</div>
      <p class="fine">Before you go: a breakfast with 1 to 2 g of carbs per kg of body weight, two to three hours before the start.</p></div>`;
  }

  $('waterPlan').innerHTML = water;
  $('fuelPlan').innerHTML = fuel;
}

let resizeTimer;
window.addEventListener('resize', () => {
  if (!state.result?.cond) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawWindViews, 150);
});
