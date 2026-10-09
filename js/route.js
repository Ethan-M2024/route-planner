// GPX parsing and route analysis: resampling, smoothing, gradient, climbs.

const R_KM = 6371.0088;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Compass bearing from a to b, 0 = north, 90 = east.
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file could not be read as GPX.');

  const readPts = tag => [...doc.getElementsByTagName(tag)].map(n => {
    const e = n.getElementsByTagName('ele')[0];
    return { lat: parseFloat(n.getAttribute('lat')), lon: parseFloat(n.getAttribute('lon')), ele: e ? parseFloat(e.textContent) : NaN };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  let points = readPts('trkpt');
  if (points.length < 2) points = readPts('rtept');
  if (points.length < 2) throw new Error('No track or route points were found in that GPX file.');

  const waypoints = [...doc.getElementsByTagName('wpt')].map(n => ({
    lat: parseFloat(n.getAttribute('lat')),
    lon: parseFloat(n.getAttribute('lon')),
    name: n.getElementsByTagName('name')[0]?.textContent?.trim() || 'Waypoint',
  })).filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon));

  const nameNode = doc.querySelector('trk > name') || doc.querySelector('rte > name') || doc.querySelector('metadata > name');
  return { name: nameNode?.textContent?.trim() || '', points, waypoints };
}

// Fill short elevation gaps by linear interpolation. Returns the share of points that were missing.
function patchElevation(points) {
  const missing = points.filter(p => !Number.isFinite(p.ele)).length;
  if (!missing || missing === points.length) return missing / points.length;
  let last = -1;
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].ele)) continue;
    if (last === -1) for (let k = 0; k < i; k++) points[k].ele = points[i].ele;
    else for (let k = last + 1; k < i; k++) points[k].ele = points[last].ele + (points[i].ele - points[last].ele) * (k - last) / (i - last);
    last = i;
  }
  for (let k = last + 1; k < points.length; k++) points[k].ele = points[last].ele;
  return missing / points.length;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Look up terrain elevation from Open-Meteo in batches of 100, backing off on rate limits.
async function fetchElevations(lats, lons, onProgress) {
  const out = [];
  for (let i = 0; i < lats.length; i += 100) {
    const la = lats.slice(i, i + 100).map(v => v.toFixed(5)).join(',');
    const lo = lons.slice(i, i + 100).map(v => v.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`;
    let data;
    for (let attempt = 0; attempt < 6 && !data; attempt++) {
      const res = await fetch(url);
      if (res.ok) data = await res.json();
      else if (res.status === 429) await sleep(3000 * (attempt + 1));
      else throw new Error(`Elevation lookup failed (${res.status}).`);
    }
    if (!data) throw new Error('Elevation service is busy. Try again in a minute.');
    out.push(...data.elevation);
    onProgress?.(Math.min(1, (i + 100) / lats.length));
    if (i + 100 < lats.length) await sleep(1200);
  }
  return out;
}

function movingAverage(arr, half) {
  if (half < 1) return arr.slice();
  const pre = [0];
  for (const v of arr) pre.push(pre.at(-1) + v);
  return arr.map((_, i) => {
    const a = Math.max(0, i - half), b = Math.min(arr.length - 1, i + half);
    return (pre[b + 1] - pre[a]) / (b - a + 1);
  });
}

function medianFilter(arr, half) {
  return arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - half), Math.min(arr.length, i + half + 1)).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
}

const CATS = [[80000, 'HC'], [64000, '1'], [32000, '2'], [16000, '3'], [8000, '4']];

function findClimbs(d, e, grade) {
  const climbs = [];
  const idxAhead = (i, km) => { let j = i; while (j < d.length - 1 && d[j] - d[i] < km) j++; return j; };

  const push = (s, t) => {
    // Trim a flat run in at the bottom so the average grade reflects the actual climb.
    while (s < t && e[idxAhead(s, 0.5)] - e[s] < 5) s++;
    const gain = e[t] - e[s];
    const lenKm = d[t] - d[s];
    if (lenKm < 0.3 || gain < 25) return;
    const avg = gain / (lenKm * 1000) * 100;
    if (avg < 2.5) return;
    const score = lenKm * 1000 * avg;
    const cat = CATS.find(([min]) => score >= min)?.[1];
    if (!cat) return;
    let maxGrade = 0;
    for (let i = s; i <= t; i++) maxGrade = Math.max(maxGrade, grade[i]);
    climbs.push({ startKm: d[s], endKm: d[t], lenKm, gainM: gain, avg, maxGrade, cat, startIdx: s, topIdx: t });
  };

  let start = 0, top = 0;
  for (let i = 1; i < e.length; i++) {
    if (e[i] > e[top]) top = i;
    if (top === start && e[i] < e[start]) { start = i; top = i; continue; }
    const gain = e[top] - e[start];
    const allowedDip = Math.max(20, Math.min(60, gain * 0.1));
    if (e[top] - e[i] > allowedDip) {
      push(start, top);
      start = i; top = i;
    }
  }
  push(start, top);
  return climbs;
}

// Turn raw GPX points into evenly spaced samples with smoothed elevation, grade and bearing.
export async function analyzeRoute(gpx, onStatus) {
  const pts = gpx.points.map(p => ({ ...p }));
  const missingShare = patchElevation(pts);

  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineKm(pts[i - 1], pts[i]));
  const totalKm = cum.at(-1);
  if (totalKm < 0.2) throw new Error('That route is too short to plan.');

  const step = Math.min(0.2, Math.max(0.025, totalKm / 2500));
  const n = Math.max(2, Math.ceil(totalKm / step) + 1);
  const d = [], lat = [], lon = [], rawEle = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = totalKm * k / (n - 1);
    while (j < pts.length - 2 && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / span)) : 0;
    d.push(target);
    lat.push(pts[j].lat + (pts[j + 1].lat - pts[j].lat) * f);
    lon.push(pts[j].lon + (pts[j + 1].lon - pts[j].lon) * f);
    rawEle.push(pts[j].ele + (pts[j + 1].ele - pts[j].ele) * f);
  }

  let elevationSource = 'gpx';
  if (missingShare > 0.2) {
    // Route builders sometimes export without elevation. Look it up on a coarser grid.
    elevationSource = 'lookup';
    const every = Math.max(1, Math.ceil(n / 1200));
    const idx = [];
    for (let k = 0; k < n; k += every) idx.push(k);
    if (idx.at(-1) !== n - 1) idx.push(n - 1);
    onStatus?.(`This GPX has no elevation data. Looking it up for ${idx.length} points...`);
    const looked = await fetchElevations(idx.map(k => lat[k]), idx.map(k => lon[k]),
      p => onStatus?.(`Looking up elevation... ${Math.round(p * 100)}%`));
    const xs = idx.map(k => d[k]);
    for (let k = 0; k < n; k++) {
      let a = 0;
      while (a < xs.length - 2 && xs[a + 1] < d[k]) a++;
      const f = Math.min(1, Math.max(0, (d[k] - xs[a]) / (xs[a + 1] - xs[a] || 1)));
      rawEle[k] = looked[a] + (looked[a + 1] - looked[a]) * f;
    }
  }

  // Median first to knock out DEM spikes (canyon walls, bridges), then a moving average.
  const half = Math.max(1, Math.round(0.15 / step));
  const ele = movingAverage(medianFilter(rawEle, Math.max(2, Math.round(0.1 / step))), half);

  const grade = d.map((_, i) => {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const run = (d[b] - d[a]) * 1000;
    return run > 0 ? Math.max(-30, Math.min(30, (ele[b] - ele[a]) / run * 100)) : 0;
  });

  const bearing = d.map((_, i) => {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    return bearingDeg({ lat: lat[a], lon: lon[a] }, { lat: lat[b], lon: lon[b] });
  });

  // Count gain with a small dead band so leftover noise does not add up over long rides.
  let gainM = 0, lossM = 0, ref = ele[0];
  for (let i = 1; i < n; i++) {
    const de = ele[i] - ref;
    if (de >= 2) { gainM += de; ref = ele[i]; } else if (de <= -2) { lossM -= de; ref = ele[i]; }
  }

  // Snap GPX waypoints to the nearest point on the route.
  const pois = gpx.waypoints.map(w => {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const dd = (lat[k] - w.lat) ** 2 + ((lon[k] - w.lon) * Math.cos(rad(w.lat))) ** 2;
      if (dd < bestD) { bestD = dd; best = k; }
    }
    return { km: d[best], name: w.name, offKm: Math.sqrt(bestD) * 111.2 };
  }).filter(p => p.offKm < 0.5);

  return {
    name: gpx.name,
    d, lat, lon, ele, grade, bearing,
    totalKm, gainM, lossM,
    minEle: Math.min(...ele), maxEle: Math.max(...ele),
    climbs: findClimbs(d, ele, grade),
    pois,
    elevationSource,
  };
}
