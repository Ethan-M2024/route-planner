// Weather along the route from Open-Meteo (free, no API key, CORS enabled).

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation_probability',
  'precipitation', 'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];
const DAY = 864e5;
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
const parseDate = s => Date.parse(`${s}T00:00:00Z`);

// Route sample indices where weather is fetched: about every 5 km, at most ~30 spots.
export function weatherStations(route) {
  const spacing = Math.max(5, route.totalKm / 30);
  const idx = [];
  let next = 0;
  for (let i = 0; i < route.d.length; i++) {
    if (route.d[i] >= next) { idx.push(i); next += spacing; }
  }
  if (idx.at(-1) !== route.d.length - 1) idx.push(route.d.length - 1);
  return idx;
}

// Forecast within 16 days. Further out, fall back to last year's weather on the same date.
export async function fetchWeather(route, stations, dateStr) {
  const today = parseDate(isoDate(Date.now()));
  const target = parseDate(dateStr);
  const diff = Math.round((target - today) / DAY);

  let api = FORECAST, mode = diff < 0 ? 'past' : 'forecast', query = target;
  if (diff > 15) {
    mode = 'typical';
    api = ARCHIVE;
    const d = new Date(target);
    do d.setUTCFullYear(d.getUTCFullYear() - 1); while (d.getTime() > today - 7 * DAY);
    query = d.getTime();
  } else if (diff < -60) {
    api = ARCHIVE;
  }

  const start = query - DAY;
  let end = query + 2 * DAY;
  if (api === FORECAST) end = Math.min(end, today + 15 * DAY);
  const vars = api === ARCHIVE ? VARS.filter(v => v !== 'precipitation_probability') : VARS;

  const lats = stations.map(i => route.lat[i].toFixed(4)).join(',');
  const lons = stations.map(i => route.lon[i].toFixed(4)).join(',');
  const url = `${api}?latitude=${lats}&longitude=${lons}&hourly=${vars.join(',')}` +
    `&start_date=${isoDate(start)}&end_date=${isoDate(end)}&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh`;

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.reason || `Weather lookup failed (${res.status}).`);
  const arr = Array.isArray(json) ? json : [json];
  const shift = (target - query) / 1000;

  return {
    mode,
    sourceDate: isoDate(query),
    offset: arr[0].utc_offset_seconds,
    tzAbbr: arr[0].timezone_abbreviation,
    locs: arr.map(x => ({ ...x.hourly, time: x.hourly.time.map(t => t + shift) })),
  };
}

function lerp(arr, pos) {
  if (!arr) return null;
  const p = Math.min(arr.length - 1, Math.max(0, pos));
  const i0 = Math.floor(p), i1 = Math.min(arr.length - 1, i0 + 1);
  const a = arr[i0], b = arr[i1];
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * (p - i0);
}

const rad = d => d * Math.PI / 180;

// Weather each route sample sees when the rider gets there, plus the wind's effect on the rider.
export function conditionsAlong(route, times, wx, startUnix, stations) {
  const n = route.d.length;
  const c = {
    tempC: [], feelsC: [], humidity: [], precipProb: [], precip: [], code: [], cloud: [],
    windKmh: [], gustKmh: [], windFrom: [], head: [], cls: [], outOfRange: false,
  };
  // Wind vector at a station and moment, so 350° and 10° average to north, not south.
  const windVec = (L, pos) => {
    const p = Math.min(L.time.length - 1, Math.max(0, pos));
    const i0 = Math.floor(p), i1 = Math.min(L.time.length - 1, i0 + 1), f = p - i0;
    const at = k => {
      const sp = L.wind_speed_10m[k] ?? 0, dir = rad(L.wind_direction_10m[k] ?? 0);
      return [sp * Math.sin(dir), sp * Math.cos(dir)];
    };
    const [x0, y0] = at(i0), [x1, y1] = at(i1);
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
  };

  let s = 0;
  for (let i = 0; i < n; i++) {
    // Blend the two stations on either side of this point by distance.
    while (s < stations.length - 2 && route.d[stations[s + 1]] <= route.d[i]) s++;
    const a = wx.locs[s], b = wx.locs[Math.min(s + 1, stations.length - 1)];
    const da = route.d[stations[s]], db = route.d[stations[Math.min(s + 1, stations.length - 1)]];
    const w = db > da ? Math.min(1, Math.max(0, (route.d[i] - da) / (db - da))) : 0;
    const t = startUnix + times[i];
    const posA = (t - a.time[0]) / 3600, posB = (t - b.time[0]) / 3600;
    if (posA < 0 || posA > a.time.length - 1) c.outOfRange = true;

    const v = key => {
      const va = lerp(a[key], posA), vb = lerp(b[key], posB);
      if (va == null) return vb;
      if (vb == null) return va;
      return va + (vb - va) * w;
    };
    c.tempC.push(v('temperature_2m'));
    c.feelsC.push(v('apparent_temperature'));
    c.humidity.push(v('relative_humidity_2m'));
    c.precipProb.push(v('precipitation_probability'));
    c.precip.push(v('precipitation'));
    c.cloud.push(v('cloud_cover'));
    const near = w < 0.5 ? a : b, nearPos = w < 0.5 ? posA : posB;
    c.code.push(near.weather_code?.[Math.min(near.time.length - 1, Math.max(0, Math.round(nearPos)))] ?? null);
    c.gustKmh.push(v('wind_gusts_10m'));

    const [xa, ya] = windVec(a, posA), [xb, yb] = windVec(b, posB);
    const x = xa + (xb - xa) * w, y = ya + (yb - ya) * w;
    const speed = Math.hypot(x, y);
    const from = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    c.windKmh.push(speed);
    c.windFrom.push(from);

    // Positive = wind in your face. Wind direction is where it comes from.
    let rel = ((from - route.bearing[i]) + 540) % 360 - 180;
    c.head.push(speed * Math.cos(rad(rel)));
    rel = Math.abs(rel);
    c.cls.push(speed < 6 ? 'calm' : rel <= 60 ? 'head' : rel >= 120 ? 'tail' : 'cross');
  }
  return c;
}

export function weatherText(code) {
  if (code == null) return { label: 'Unknown', icon: '·' };
  if (code === 0) return { label: 'Clear', icon: '☀️' };
  if (code === 1) return { label: 'Mostly clear', icon: '🌤️' };
  if (code === 2) return { label: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: '🌦️' };
  if (code >= 61 && code <= 67) return { label: 'Rain', icon: '🌧️' };
  if (code >= 71 && code <= 77) return { label: 'Snow', icon: '🌨️' };
  if (code >= 80 && code <= 82) return { label: 'Showers', icon: '🌦️' };
  if (code === 85 || code === 86) return { label: 'Snow showers', icon: '🌨️' };
  if (code >= 95) return { label: 'Thunderstorms', icon: '⛈️' };
  return { label: 'Mixed', icon: '🌥️' };
}
