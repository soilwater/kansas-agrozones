# Kansas environments

A web app that groups Kansas into environments (agro-ecological zones) from climate and soil layers. Users choose the layers, the number of zones, and whether each layer drives the climate (macro) or soil (micro) step. The app runs everything in the browser on a 1-km grid (273,579 pixels).

Zoning is hierarchical:
1. **Macrozones:** k-means on climate layers.
2. **Microzones:** inside each macrozone, k-means again on soil layers, so every microzone sits inside one macrozone.

With no micro layers, the result is one pooled clustering. Layers are z-scored over the state. Silhouette scores for each number of zones are shown as a guide.

An optional **crop mask** then keeps only the counties where a crop is grown: counties are ranked by their area of the crop, and the largest are kept until together they hold a chosen share (50–99%) of the Kansas area of that crop. The zones themselves are still made from the whole state, so a breeder can zone Kansas once and then look only at, say, the counties that grow 90% of the state's winter wheat. Crops: winter wheat, corn, soybeans, grain sorghum, alfalfa and rangeland.

The approach follows Sexton-Bowser, Roozeboom and Patrignani (2026), *Agricultural and Forest Meteorology* 378, 110999, https://doi.org/10.1016/j.agrformet.2025.110999.

## Run locally

The page loads its data with `fetch`, so serve the folder over http rather than opening the file:

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Any static host (for example GitHub Pages) works the same way. There is no build step and there are no external libraries.

## Files

| path | content |
|---|---|
| `index.html`, `css/style.css`, `js/app.js` | the app |
| `data/layers.bin.gz` | every layer as uint8 on the 1-km grid, gzip (read with the browser's `DecompressionStream`) |
| `data/county_id.bin.gz` | county of every pixel (1–105, alphabetical; 0 = outside Kansas) |
| `data/meta.json` | grid, layer names, units, ranges, definitions and sources, county outlines |
| `data/crops.json` | mean county area of each crop from the Cropland Data Layer, for the crop mask |
| `python/build_layers.ipynb` | builds `data/` from `inputs/` and runs the default zoning once as a check |
| `python/build_crops.py` | builds `data/crops.json` from the Cropland Data Layer on Google Earth Engine |
| `inputs/` | the 1-km input rasters (EPSG:4326, 336 × 832) and county boundaries |
| `inputs/cdl_county/` | pixel counts of every CDL class by county, one file per year (cache for `build_crops.py`) |
| `figures/zones_default.png` | the default zoning from the notebook |

## Layers

| layer | units | source | default step |
|---|---|---|---|
| Annual rainfall | mm | PRISM 1991–2020 normal | macro |
| Annual reference ET | mm | gridMET 1991–2020 mean (ASCE grass reference) | macro |
| Aridity index | rainfall / ETo | computed | off |
| Atmospheric water deficit | mm, ETo − rainfall | computed | off |
| Growing degree days | °C·d | PRISM daily 1991–2020, base 10 °C, Tmax capped at 30 °C, Tmin floored at 10 °C | macro |
| Deficit-days | FAW-days per year | Kansas 1-km soil moisture model, median of 2002–2025 | off |
| Surplus-days | FAW-days per year | Kansas 1-km soil moisture model, median of 2002–2025 | off |
| Plant available water capacity | mm, 0–60 cm | −10 kPa to wilting point, SSURGO texture | micro |
| Soil organic matter | kg m⁻², whole profile | SSURGO (CSRL) | micro |
| Clay | %, 0–60 cm | SSURGO (CSRL) | micro |
| Sand | %, 0–60 cm | SSURGO (CSRL) | off |

FAW is the fraction of plant available water in 0–60 cm. The yearly deficit-days are Σ max(0, 0.5 − FAW), and surplus-days are Σ max(0, FAW − 0.5).

## Rebuilding the layers

Replace or add a raster in `inputs/` (same grid as `inputs/kansas_mask.tif`), edit the layer list in `python/build_layers.ipynb` if needed, and run the notebook from the `python/` folder. It needs `numpy`, `pandas`, `rasterio`, `geopandas`, `scipy`, `scikit-learn` and `matplotlib`. Growing degree days are downloaded from Google Earth Engine only if `inputs/gdd10_annual_normal.tif` is missing.

## Crop areas

`python build_crops.py` counts, on Google Earth Engine, the pixels of every Cropland Data Layer class in each Kansas county (TIGER 2018 boundaries) for the last 10 CDL years. The counts are made on Google's servers, so only one small table per county and year comes back; no maps are downloaded. The counts are cached in `inputs/cdl_county/`, so the crop definitions below can be changed and the script rerun without querying Earth Engine again.

| crop | CDL classes |
|---|---|
| Winter wheat | 24 Winter Wheat; double crops 26 WinWht/Soybeans, 225 WinWht/Corn, 236 WinWht/Sorghum, 238 WinWht/Cotton |
| Corn | 1 Corn; double crops 225, 226 Oats/Corn, 237 Barley/Corn, 241 Corn/Soybeans |
| Soybeans | 5 Soybeans; double crops 26, 240 Soybeans/Oats, 241, 254 Barley/Soybeans |
| Grain sorghum | 4 Sorghum; double crop 236 |
| Alfalfa | 36 Alfalfa |
| Rangeland | 176 Grass/Pasture, 152 Shrubland |

Double crops count toward both crops. CDL Grass/Pasture also includes hay meadows, tame pastures and Conservation Reserve Program grass, so rangeland is an upper bound on native range.

## Data sources

- PRISM Climate Group, Oregon State University (rainfall, temperature).
- gridMET (reference ET).
- USDA-NRCS SSURGO, gridded by the California Soil Resource Lab (soil).
- US Census TIGER (county boundaries).
- USDA NASS Cropland Data Layer (county crop areas), through Google Earth Engine (`USDA/NASS/CDL`).
