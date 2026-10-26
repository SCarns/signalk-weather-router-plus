/**
 * The synthetic CMEMS sea-level store the tide tests run against (sealevel.test.ts, and the held-round test in
 * plugin/worker/forecastheld.test.ts): global 1° grid (80°S..90°N), 200 hourly steps from 2026-09-20T00Z, the
 * sea-level variable layout, served by a fetch mock. Land (fill) on 40..45°N × 10..20°E and in one cell at 0°N 0°E
 * (a coastal fill case). Layouts: time (1 h × 64 × 128), geo (48 h × 16 × 16), ds4 (2°). Not a test file by
 * content; named .test.ts so it stays out of the build (as currents/smoc.mock.test.ts).
 */

const H = 3600_000;

const FILL = -9999;
export const T0 = Date.UTC(2026, 8, 20, 0);
export const NT = 200;
const HOURS_1950 = (T0 - Date.UTC(1950, 0, 1)) / H;
export const tideTrue = (lat: number, lon: number, ti: number): number =>
  0.8 * Math.cos((2 * Math.PI * ti) / 12.42 + (lon * Math.PI) / 180) + 0.01 * lat;
export const totalTrue = (lat: number, lon: number, ti: number): number =>
  tideTrue(lat, lon, ti) - 0.4 + 0.002 * lon + 0.1 * Math.sin((2 * Math.PI * ti) / 50);
const landAt = (lat: number, lon: number): boolean => (lat >= 40 && lat <= 45 && lon >= 10 && lon <= 20) || (lat === 0 && lon === 0);
const LAYOUTS: Record<string, { d: number; chunks: number[] }> = {
  time: { d: 1, chunks: [1, 1, 64, 128] },
  geo: { d: 1, chunks: [48, 1, 16, 16] },
  ds4: { d: 2, chunks: [1, 1, 86, 180] },
};

function f4(vals: ArrayLike<number>): Uint8Array {
  return new Uint8Array(new Float32Array(Array.from(vals)).buffer);
}

export function mockFetch(counts: Map<string, number>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    counts.set(url, (counts.get(url) ?? 0) + 1);
    if (url.endsWith('dataset.stac.json'))
      return new Response(JSON.stringify({ properties: { admp_updated_data: '2026-09-28T10:00:00Z', admp_updating_start_date: null } }), {
        status: 200,
      });
    const m = /\/(time|geo|ds4)\.zarr\/(.+)$/.exec(url);
    if (!m) return new Response('no', { status: 404 });
    const L = LAYOUTS[m[1]];
    const key = m[2];
    const nLat = Math.round(170 / L.d) + 1;
    const nLon = Math.round(360 / L.d);
    const arr = (shape: number[], chunks: number[], fill: unknown): unknown => ({
      chunks,
      compressor: null,
      dtype: '<f4',
      fill_value: fill,
      filters: null,
      order: 'C',
      shape,
      zarr_format: 2,
    });
    if (key === '.zmetadata') {
      const md: Record<string, unknown> = {
        '.zattrs': {},
        'latitude/.zarray': arr([nLat], [nLat], 'NaN'),
        'latitude/.zattrs': { _ARRAY_DIMENSIONS: ['latitude'] },
        'longitude/.zarray': arr([nLon], [nLon], 'NaN'),
        'longitude/.zattrs': { _ARRAY_DIMENSIONS: ['longitude'] },
        'time/.zarray': arr([NT], [64], 'NaN'),
        'time/.zattrs': { _ARRAY_DIMENSIONS: ['time'], calendar: 'gregorian', units: 'hours since 1950-01-01' },
      };
      for (const v of ['ocean_tide', 'total_sea_level', 'invert_barometer']) {
        md[`${v}/.zarray`] = arr([NT, 1, nLat, nLon], L.chunks, FILL);
        md[`${v}/.zattrs`] = { _ARRAY_DIMENSIONS: ['time', 'elevation', 'latitude', 'longitude'], units: 'm' };
      }
      return new Response(JSON.stringify({ metadata: md, zarr_consolidated_format: 1 }), {
        status: 200,
        headers: { etag: '"e1"', 'last-modified': 'Mon, 28 Sep 2026 08:00:00 GMT' },
      });
    }
    if (key === 'latitude/0') return new Response(f4(Array.from({ length: nLat }, (_, i) => -80 + i * L.d)), { status: 200 });
    if (key === 'longitude/0') return new Response(f4(Array.from({ length: nLon }, (_, i) => -180 + i * L.d)), { status: 200 });
    const tm = /^time\/(\d+)$/.exec(key);
    if (tm)
      return new Response(f4(Array.from({ length: 64 }, (_, i) => (+tm[1] * 64 + i < NT ? HOURS_1950 + +tm[1] * 64 + i : NaN))), {
        status: 200,
      });
    const dm = /^(ocean_tide|total_sea_level)\/(\d+)\.0\.(\d+)\.(\d+)$/.exec(key);
    if (!dm) return new Response('no', { status: 404 });
    const [ct, , cr, cc] = L.chunks;
    const [tc, rc, ccI] = [+dm[2], +dm[3], +dm[4]];
    const out = new Float32Array(ct * cr * cc).fill(FILL);
    for (let t = 0; t < ct; t++) {
      const ti = tc * ct + t;
      if (ti >= NT) continue;
      for (let r = 0; r < cr; r++) {
        const gr = rc * cr + r;
        if (gr >= nLat) continue;
        for (let c = 0; c < cc; c++) {
          const gc = ccI * cc + c;
          if (gc >= nLon) continue;
          const lat = -80 + gr * L.d;
          const lon = -180 + gc * L.d;
          if (landAt(lat, lon)) continue;
          out[(t * cr + r) * cc + c] = dm[1] === 'ocean_tide' ? tideTrue(lat, lon, ti) : totalTrue(lat, lon, ti);
        }
      }
    }
    return new Response(new Uint8Array(out.buffer), { status: 200 });
  }) as typeof fetch;
}

export const URLS = {
  time: 'https://mock/time.zarr',
  geo: 'https://mock/geo.zarr',
  ds4: 'https://mock/ds4.zarr',
  stac: 'https://mock/dataset.stac.json',
};
