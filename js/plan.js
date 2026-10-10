// Ride timing, hydration and carb plan.

import { interpAt } from './util.js';

// Conservative speed on a given grade. It is better to finish early than to run out of water.
// Climbs cost a lot, descents give back little, headwinds hurt but tailwinds earn no credit,
// and legs fade after two hours.
function speedFor(grade, flatKmh, headKmh, hoursIn) {
  let v = grade > 0
    ? flatKmh / (1 + 0.14 * grade)
    : Math.min(flatKmh * (1 + 0.03 * -grade), flatKmh * 1.4, 50);
  if (headKmh > 0) v -= 0.4 * headKmh;
  v *= 1 - Math.min(0.12, Math.max(0, hoursIn - 2) * 0.03);
  return Math.max(v, 4, flatKmh * 0.25);
}

// Seconds from start to every route sample. Pass head (km/h headwind per sample) to include wind.
export function estimateTimes(route, flatKmh, head) {
  const t = [0];
  for (let i = 1; i < route.d.length; i++) {
    const g = (route.grade[i - 1] + route.grade[i]) / 2;
    const h = head ? (head[i - 1] + head[i]) / 2 : 0;
    t.push(t[i - 1] + (route.d[i] - route.d[i - 1]) / speedFor(g, flatKmh, h, t[i - 1] / 3600) * 3600);
  }
  return t;
}

// ml per hour lost at mild temperatures for each sweat profile.
const BASE_ML_H = { low: 450, avg: 600, high: 780 };

export function autoCarbRate(hours) {
  if (hours < 1) return 0;
  if (hours < 1.5) return 30;
  if (hours < 2.5) return 60;
  return 75;
}

export function buildPlan(route, times, cond, s) {
  const n = route.d.length;
  const totalSec = times[n - 1];
  const hours = totalSec / 3600;

  // Water: sweat rate rises with felt temperature, climbing effort and humid heat.
  const bottles = [];
  let cumMl = 0, next = s.bottleMl, hotSec = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    const feels = cond ? (cond.feelsC[i] ?? cond.tempC[i] ?? 20) : 20;
    const humid = cond?.humidity[i] ?? 40;
    let rate = BASE_ML_H[s.sweat] + Math.max(0, feels - 18) * 25;
    if (route.grade[i] > 4) rate *= 1.15;
    if (humid > 70 && feels > 24) rate *= 1.1;
    rate = Math.min(1300, Math.max(350, rate));
    if (feels > 27) hotSec += dt;

    const before = cumMl;
    cumMl += rate * dt / 3600;
    while (cumMl >= next) {
      const f = (next - before) / (cumMl - before);
      bottles.push({
        n: bottles.length + 1,
        km: route.d[i - 1] + (route.d[i] - route.d[i - 1]) * f,
        t: times[i - 1] + dt * f,
      });
      next += s.bottleMl;
    }
  }

  // Carbs: a fixed hourly target split into a checkpoint every 30 minutes.
  const carbRate = s.carbRate === 'auto' ? autoCarbRate(hours) : Number(s.carbRate);
  const fuel = [];
  if (carbRate > 0) {
    for (let t = 1800; t <= totalSec + 60; t += 1800) {
      const tt = Math.min(t, totalSec);
      fuel.push({
        n: fuel.length + 1,
        t: tt,
        km: interpAt(times, route.d, tt),
        grams: Math.round(carbRate / 2),
        cumGrams: Math.round(carbRate * t / 3600),
      });
    }
  }

  const hot = hotSec > totalSec * 0.3;
  return {
    hours,
    totalSec,
    totalMl: cumMl,
    bottleMl: s.bottleMl,
    bottles,
    bottlesNeeded: cumMl / s.bottleMl,
    carbRate,
    carbAuto: s.carbRate === 'auto',
    totalCarbs: Math.round(carbRate * hours),
    fuel,
    sodiumMgH: hours >= 2 || hot ? (hot ? 700 : 400) : 0,
    hot,
  };
}
