// Ride preview: a 3D flyover on real terrain (or a 2D top-down follow) with a heads-up display.

import { gradeColor, bisect, fmt, fmtDuration, WIND_COLORS } from './util.js';
import { bearingDeg } from './route.js';

const ML = 'https://unpkg.com/maplibre-gl@4.7.1/dist';
const ML_CSS_SRI = 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V';
const ML_JS_SRI = 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj';

let loader;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  loader ??= new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${ML}/maplibre-gl.css`, integrity: ML_CSS_SRI, crossOrigin: '' });
    const js = Object.assign(document.createElement('script'), { src: `${ML}/maplibre-gl.js`, integrity: ML_JS_SRI, crossOrigin: '' });
    js.onload = resolve;
    js.onerror = () => reject(new Error('Could not load the 3D map library.'));
    document.head.append(css, js);
  });
  return loader;
}

const STYLE = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256, maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256, maxzoom: 14, encoding: 'terrarium',
      attribution: 'Terrain: Mapzen, AWS Open Data',
    },
  },
  layers: [
    { id: 'sat', type: 'raster', source: 'sat' },
    { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
  ],
  terrain: { source: 'dem', exaggeration: 1.4 },
  sky: {
    'sky-color': '#8fc3f2', 'horizon-color': '#e6eef7', 'fog-color': '#f2f5f9',
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.5,
  },
};

const shortest = d => ((d + 540) % 360) - 180;

export function createFlyover(els) {
  const s = {
    map: null, marker: null, failed: false,
    ctx: null, routeRef: null, km: 0, playing: false, speed: 1, view: '3d',
    camBearing: null, last: 0, mini: null, events: [],
  };

  async function ensureMap(route) {
    if (s.map || s.failed) return;
    try {
      await loadMapLibre();
      s.map = new maplibregl.Map({
        container: els.map,
        style: STYLE,
        center: [route.lon[0], route.lat[0]],
        zoom: 12,
        pitch: 55,
        maxPitch: 75,
        attributionControl: { compact: true },
      });
      s.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      await new Promise(resolve => s.map.once('load', resolve));
      s.map.addSource('route', { type: 'geojson', lineMetrics: true, data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
      const layout = { 'line-join': 'round', 'line-cap': 'round' };
      s.map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 } });
      s.map.addLayer({ id: 'route', type: 'line', source: 'route', layout, paint: { 'line-width': 5, 'line-gradient': gradient(0) } });
      const dot = document.createElement('div');
      dot.className = 'rider';
      s.marker = new maplibregl.Marker({ element: dot }).setLngLat([route.lon[0], route.lat[0]]).addTo(s.map);
      // Grabbing the map pauses playback so the rider can look around.
      s.map.on('dragstart', pause);
      s.map.on('rotatestart', e => e.originalEvent && pause());
      els.msg.hidden = true;
    } catch (e) {
      console.error(e);
      s.failed = true;
      s.map = null;
      els.msg.hidden = false;
      els.msg.textContent = 'The 3D preview needs WebGL, which this browser does not have turned on.';
    }
  }

  // Ridden part of the line turns pale; the road ahead stays red.
  const gradient = f => ['step', ['line-progress'], '#f3f4f6', Math.min(0.9999, Math.max(1e-6, f)), '#E3171B'];

  async function update(ctx) {
    s.ctx = ctx;
    const fresh = s.routeRef !== ctx.route;
    s.routeRef = ctx.route;
    if (fresh) { pause(); s.km = 0; }
    buildMini();
    buildEvents();
    render(0, false);
    await ensureMap(ctx.route);
    if (!s.map) return;
    if (fresh || !s.loadedRoute) {
      s.loadedRoute = true;
      s.map.getSource('route').setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: ctx.route.lon.map((lo, i) => [lo, ctx.route.lat[i]]) },
      });
      overview(0);
    }
    render(0, false);
  }

  function buildEvents() {
    const { route, plan, U } = s.ctx;
    const name = c => (c.cat === 'HC' ? 'HC' : `Cat ${c.cat}`);
    s.events = [
      ...route.climbs.map(c => ({ km: c.startKm, text: `${name(c)} climb, ${fmt(U.dist(c.lenKm), 1)} ${U.distL} at ${fmt(c.avg, 1)}%` })),
      ...route.climbs.map(c => ({ km: c.endKm, text: `Top of the ${name(c)} climb` })),
      ...plan.bottles.map(b => ({ km: b.km, text: `Bottle ${b.n} should be empty` })),
      ...plan.fuel.map(f => ({ km: f.km, text: `Eat ${f.grams} g carbs (${f.cumGrams} g total)` })),
      { km: route.totalKm, text: 'Finish' },
    ].sort((a, b) => a.km - b.km);
  }

  // Mini elevation profile under the map doubles as the scrubber.
  function buildMini() {
    const { route } = s.ctx;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    const w = els.mini.clientWidth || 600, h = els.mini.clientHeight || 54;
    const off = document.createElement('canvas');
    off.width = w * dpr; off.height = h * dpr;
    const g = off.getContext('2d');
    g.scale(dpr, dpr);
    const lo = route.minEle, hi = route.maxEle + 1;
    const X = km => km / route.totalKm * w;
    const Y = e => h - 4 - (e - lo) / (hi - lo) * (h - 12);
    const step = Math.max(1, Math.floor(route.d.length / w));
    for (let i = 0; i < route.d.length - 1; i += step) {
      const j = Math.min(route.d.length - 1, i + step);
      g.fillStyle = gradeColor(route.grade[i]);
      g.beginPath();
      g.moveTo(X(route.d[i]), h);
      g.lineTo(X(route.d[i]), Y(route.ele[i]));
      g.lineTo(X(route.d[j]), Y(route.ele[j]));
      g.lineTo(X(route.d[j]) + 0.5, h);
      g.fill();
    }
    s.mini = { off, w, h, dpr };
  }

  function drawMini() {
    if (!s.mini) return;
    const { off, w, h, dpr } = s.mini;
    els.mini.width = w * dpr; els.mini.height = h * dpr;
    const g = els.mini.getContext('2d');
    g.scale(dpr, dpr);
    g.drawImage(off, 0, 0, w, h);
    const x = s.km / s.ctx.route.totalKm * w;
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillRect(0, 0, x, h);
    g.fillStyle = '#14181f';
    g.fillRect(x - 1, 0, 2, h);
  }

  function position() {
    const r = s.ctx.route;
    const i = bisect(r.d, s.km);
    const j = Math.min(r.d.length - 1, i + 1);
    const f = r.d[j] > r.d[i] ? (s.km - r.d[i]) / (r.d[j] - r.d[i]) : 0;
    return { i, lat: r.lat[i] + (r.lat[j] - r.lat[i]) * f, lon: r.lon[i] + (r.lon[j] - r.lon[i]) * f };
  }

  function render(dt, moveCamera) {
    const r = s.ctx.route;
    const p = position();
    els.scrub.value = Math.round(s.km / r.totalKm * 1000);
    drawMini();
    hud(p.i);
    if (!s.map) return;
    s.marker.setLngLat([p.lon, p.lat]);
    s.map.setPaintProperty('route', 'line-gradient', gradient(s.km / r.totalKm));
    if (!moveCamera) return;

    // Aim the camera down the road a few hundred meters ahead, easing the turn.
    const k = bisect(r.d, Math.min(r.totalKm, s.km + 0.45));
    const target = k > p.i ? bearingDeg(p, { lat: r.lat[k], lon: r.lon[k] }) : (s.camBearing ?? 0);
    if (s.camBearing == null || dt === 0) s.camBearing = target;
    else s.camBearing = (s.camBearing + shortest(target - s.camBearing) * Math.min(1, dt * 1.6) + 360) % 360;

    const h = els.map.clientHeight;
    if (s.view === '3d') {
      s.map.jumpTo({ center: [p.lon, p.lat], bearing: s.camBearing, pitch: 63, zoom: 14.4, padding: { top: Math.round(h * 0.38), bottom: 0, left: 0, right: 0 } });
    } else {
      s.map.jumpTo({ center: [p.lon, p.lat], bearing: 0, pitch: 0, zoom: 13.8, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
  }

  function hud(i) {
    const { route, times, cond, U, clock, distWord } = s.ctx;
    const word = distWord();
    const g = route.grade[i];
    let wind = '';
    if (cond) {
      const cls = cond.cls[i];
      const label = { head: 'Headwind', tail: 'Tailwind', cross: 'Crosswind', calm: 'Calm' }[cls];
      // Arrow shows where the wind pushes you, relative to your direction of travel (up).
      const rel = (cond.windFrom[i] + 180 - route.bearing[i] + 360) % 360;
      wind = `<div><span>Wind</span><b style="color:${cls === 'calm' ? '#fff' : WIND_COLORS[cls]}">
        <svg class="wind-rel" viewBox="0 0 24 24" width="14" height="14" style="transform:rotate(${rel}deg)"><path d="M12 2L19 21L12 16.5L5 21Z" fill="currentColor"/></svg>
        ${label} ${fmt(U.speed(cond.windKmh[i]))}</b></div>
        <div><span>Temp</span><b>${fmt(U.temp(cond.tempC[i]))}${U.tempL}</b></div>`;
    }
    els.hud.innerHTML = `
      <div class="big">${word[0].toUpperCase() + word.slice(1)} ${fmt(U.dist(route.d[i]), 1)}</div>
      <div class="sub">${clock(times[i])} · ${fmtDuration(times[i])} into the ride</div>
      <div class="hud-grid">
        <div><span>Elevation</span><b>${fmt(U.ele(route.ele[i]))} ${U.eleL}</b></div>
        <div><span>Grade</span><b><i class="chip" style="background:${gradeColor(g)}">${fmt(g, 1)}%</i></b></div>
        ${wind}
      </div>`;
    const next = s.events.find(e => e.km > s.km + 0.02);
    els.next.hidden = !next;
    if (next) els.next.innerHTML = `Next: ${next.text} <em>in ${fmt(U.dist(next.km - s.km), 1)} ${U.distL}</em>`;
  }

  // At 1x the whole ride plays in about two minutes, never faster than needed for short rides.
  const baseKmPerSec = () => Math.max(0.4, s.ctx.route.totalKm / 120);

  function tick(ts) {
    if (!s.playing) return;
    const dt = s.last ? Math.min(0.25, (ts - s.last) / 1000) : 0;
    s.last = ts;
    s.km = Math.min(s.ctx.route.totalKm, s.km + dt * baseKmPerSec() * s.speed);
    render(dt || 0.0001, true);
    if (s.km >= s.ctx.route.totalKm) return pause();
    requestAnimationFrame(tick);
  }

  function play() {
    if (!s.ctx || !s.map) return;
    if (s.km >= s.ctx.route.totalKm) s.km = 0;
    s.playing = true;
    s.last = 0;
    s.camBearing = null;
    els.play.classList.add('on');
    els.play.setAttribute('aria-label', 'Pause');
    requestAnimationFrame(tick);
  }

  function pause() {
    s.playing = false;
    els.play.classList.remove('on');
    els.play.setAttribute('aria-label', 'Play');
  }

  function overview(duration = 1200) {
    if (!s.map) return;
    pause();
    const r = s.ctx.route;
    const b = new maplibregl.LngLatBounds();
    r.lon.forEach((lo, i) => b.extend([lo, r.lat[i]]));
    s.map.fitBounds(b, { padding: 50, pitch: s.view === '3d' ? 50 : 0, bearing: 0, duration });
  }

  els.play.addEventListener('click', () => (s.playing ? pause() : play()));
  els.speed.addEventListener('change', () => { s.speed = Number(els.speed.value); });
  els.overview.addEventListener('click', () => overview());
  els.scrub.addEventListener('input', () => {
    if (!s.ctx) return;
    s.km = Number(els.scrub.value) / 1000 * s.ctx.route.totalKm;
    render(0, true);
  });
  els.viewBtns.forEach(btn => btn.addEventListener('click', () => {
    s.view = btn.dataset.view;
    els.viewBtns.forEach(b => b.classList.toggle('on', b === btn));
    if (!s.map) return;
    s.map.setTerrain(s.view === '3d' ? STYLE.terrain : null);
    render(0, true);
  }));
  els.baseBtns.forEach(btn => btn.addEventListener('click', () => {
    els.baseBtns.forEach(b => b.classList.toggle('on', b === btn));
    if (!s.map) return;
    s.map.setLayoutProperty('sat', 'visibility', btn.dataset.base === 'sat' ? 'visible' : 'none');
    s.map.setLayoutProperty('osm', 'visibility', btn.dataset.base === 'osm' ? 'visible' : 'none');
  }));
  window.addEventListener('resize', () => { if (s.ctx) { buildMini(); drawMini(); } });

  return { update };
}
