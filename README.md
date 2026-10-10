# Route Planner

Upload a GPX file for a bike route and get:

* **Elevation profile** in the VeloViewer style, colored by gradient, with climb categories, bottle and fuel markers. Downloadable as PNG.
* **Ride day weather** along the route, sampled at the time you will actually reach each spot.
* **Ride preview**: a 3D flyover on satellite imagery and real terrain, or a 2D top down follow, with mile, grade, wind and what is coming next.
* **Wind** over the ride, a headwind and tailwind breakdown by distance, and a map with wind arrows on the route.
* **Water plan**: which mile each bottle should be empty by, plus refill and electrolyte advice.
* **Carb plan**: how many grams to eat and by which mile, every 30 minutes.

Live site: https://ethan-m2024.github.io/route-planner/

## How it works

Everything runs in the browser. Your GPX file never leaves your computer.

* Weather and missing elevation come from [Open-Meteo](https://open-meteo.com/) (free, no API key).
* Forecasts reach 16 days out. Further out, the app shows last year's weather on the same date as a rough guide.
* Ride timing is deliberately conservative: climbs cost a lot, descents give back little, headwinds slow you but tailwinds earn no credit, and pace fades after two hours.
* The 3D preview uses MapLibre GL with AWS terrain tiles and Esri satellite imagery.
* Map tiles are from OpenStreetMap, drawn with Leaflet.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A server is needed because the app uses ES modules.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles |
| `js/route.js` | GPX parsing, resampling, smoothing, gradient, climb detection |
| `js/weather.js` | Open-Meteo lookups and conditions along the route |
| `js/plan.js` | Ride timing, water and carb plan |
| `js/profile.js` | Elevation profile graphic (Template 1) |
| `js/windviz.js` | Wind chart, wind strip and map (Template 2) |
| `js/flyover.js` | 3D and 2D ride preview |
| `js/app.js` | Wiring and rendering |
| `sample/` | Sample GPX: Boulder, Ward and Nederland loop |

Nutrition and hydration numbers are general endurance guidelines, not medical advice.
