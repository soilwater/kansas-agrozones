"""County crop areas from the USDA NASS Cropland Data Layer (CDL), for the app's crop mask.

Step 1 (Earth Engine): for each of the last 10 CDL years, count the pixels of every CDL class in each
Kansas county. The reduction runs on Google's servers at 30 m in the CDL's equal-area projection
(EPSG:5070), so only one small table per county comes back: no rasters are downloaded.
Results are cached per year in inputs/cdl_county/ (one CSV per year, all classes), so crop
definitions can be changed and step 2 rerun without querying Earth Engine again.

Step 2: sum the classes of each crop, average the 10 years, and write data/crops.json.

Run from the repository root or from python/:  python build_crops.py
Needs earthengine-api and pandas, and an Earth Engine project (EE_PROJECT).
"""
import os, json, time
import pandas as pd

ROOT = os.path.abspath('..') if os.path.basename(os.getcwd()) == 'python' else os.getcwd()
CACHE, DATA = os.path.join(ROOT, 'inputs', 'cdl_county'), os.path.join(ROOT, 'data')
EE_PROJECT = 'soilmoisture-1490511638539'
N_YEARS = 10
PIXEL_M2 = 30 * 30

# CDL classes of each crop. Double crops count toward both crops (for example 26, winter wheat
# followed by soybeans, counts as winter wheat and as soybeans).
CROPS = [
    ('wheat',     'Winter wheat',  [24, 26, 225, 236, 238]),
    ('corn',      'Corn',          [1, 225, 226, 237, 241]),
    ('soybeans',  'Soybeans',      [5, 26, 240, 241, 254]),
    ('sorghum',   'Grain sorghum', [4, 236]),
    ('alfalfa',   'Alfalfa',       [36]),
    ('rangeland', 'Rangeland',     [176, 152]),     # Grass/Pasture and Shrubland
]
CODE_NAMES = {1: 'Corn', 4: 'Sorghum', 5: 'Soybeans', 24: 'Winter Wheat', 26: 'Dbl Crop WinWht/Soybeans',
              36: 'Alfalfa', 152: 'Shrubland', 176: 'Grass/Pasture', 225: 'Dbl Crop WinWht/Corn', 226: 'Dbl Crop Oats/Corn',
              236: 'Dbl Crop WinWht/Sorghum', 237: 'Dbl Crop Barley/Corn', 238: 'Dbl Crop WinWht/Cotton',
              240: 'Dbl Crop Soybeans/Oats', 241: 'Dbl Crop Corn/Soybeans', 254: 'Dbl Crop Barley/Soybeans'}


def fetch():
    """Per-county pixel counts of every CDL class, one cached CSV per year. Returns the years used."""
    import ee
    ee.Initialize(project=EE_PROJECT)
    os.makedirs(CACHE, exist_ok=True)
    years = sorted(int(y) for y in ee.ImageCollection('USDA/NASS/CDL').aggregate_array('system:index').getInfo() if y.isdigit())[-N_YEARS:]
    counties = ee.FeatureCollection('TIGER/2018/Counties').filter(ee.Filter.eq('STATEFP', '20')).select(['GEOID', 'NAME'])
    geoids = sorted(counties.aggregate_array('GEOID').getInfo())
    for y in years:
        out = os.path.join(CACHE, f'cdl_{y}.csv')
        if os.path.isfile(out): continue
        cdl = ee.Image(f'USDA/NASS/CDL/{y}').select('cropland')
        rows, t0 = [], time.time()
        for k in range(0, len(geoids), 15):                 # 15 counties per request keeps each call well under the time limit
            fc = counties.filter(ee.Filter.inList('GEOID', geoids[k:k + 15]))
            res = cdl.reduceRegions(collection=fc, reducer=ee.Reducer.frequencyHistogram().unweighted(),
                                    crs='EPSG:5070', scale=30, tileScale=4)
            for f in res.getInfo()['features']:
                p = f['properties']
                for code, n in (p.get('histogram') or {}).items():
                    if code == 'null': continue             # pixels with no CDL class
                    rows.append((p['GEOID'], p['NAME'], int(float(code)), int(n)))
        pd.DataFrame(rows, columns=['geoid', 'county', 'code', 'pixels']).to_csv(out, index=False)
        print(y, f'{time.time() - t0:.0f} s', flush=True)
    return years


def build(years):
    df = pd.concat([pd.read_csv(os.path.join(CACHE, f'cdl_{y}.csv')).assign(year=y) for y in years])
    df['ha'] = df.pixels * PIXEL_M2 / 1e4
    meta = json.load(open(os.path.join(DATA, 'meta.json'), encoding='utf-8'))
    names = meta['county_names']                              # app order: alphabetical, index 0 = county id 1
    land = df[df.code != 111].groupby('county').ha.sum() / len(years)       # county area without open water
    assert set(land.index) == set(names), set(land.index) ^ set(names)
    crops = []
    for key, name, codes in CROPS:
        a = df[df.code.isin(codes)].groupby(['county', 'year']).ha.sum().unstack(fill_value=0).reindex(names, fill_value=0)
        mean = a.mean(axis=1)
        crops.append(dict(key=key, name=name, codes=codes, classes=[f'{c} {CODE_NAMES[c]}' for c in codes],
                          ha=[round(float(v), 1) for v in mean], kansas_ha=round(float(mean.sum())),
                          by_year={int(y): round(float(a[y].sum())) for y in a.columns}))
        print(f'{name:14s} Kansas mean {mean.sum() / 1e6:5.2f} Mha   top: {", ".join(mean.sort_values(ascending=False).index[:4])}')
    out = dict(source='USDA NASS Cropland Data Layer', years=[min(years), max(years)], scale_m=30, crs='EPSG:5070',
               county_ha=[round(float(land[n]), 1) for n in names], crops=crops, built=pd.Timestamp.today().strftime('%Y-%m-%d'))
    json.dump(out, open(os.path.join(DATA, 'crops.json'), 'w'), separators=(',', ':'))
    print('data/crops.json', f'{os.path.getsize(os.path.join(DATA, "crops.json")) / 1e3:.0f} kB')


if __name__ == '__main__':
    build(fetch())
