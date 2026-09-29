/**
 * Colour ramps and legend metadata, in SI, matching the routing
 * server's `/legends` response (routers/legends.py and the per-layer
 * ramps in wind.py, waves.py, currents.py, precip.py, temperature.py,
 * sst.py, roughness.py). The browser draws every heatmap from these.
 */

export interface LegendEntry {
  title: string;
  quantity: string;
  /**
   * Signal K unit-preference category a client formats the stop values
   * with (`speed`, `depth`, `temperature`, …); null when the quantity
   * has no category (dimensionless indices, precipitation rate).
   */
  category: string | null;
  si_unit: string;
  kind: 'gradient' | 'bands';
  /** [siValue, cssColor] ascending. */
  stops: [number, string][];
  bands?: [number, string][];
}

const KT = 0.514444;
const MMH = 1 / 3_600_000; // mm/h → m/s

export const WIND_STOPS: [number, string][] = [
  [0, '#90caf9'], [5 * KT, '#4fc3f7'], [10 * KT, '#00897b'], [15 * KT, '#43a047'],
  [20 * KT, '#f9a825'], [25 * KT, '#e64a19'], [30 * KT, '#c62828'], [50 * KT, '#8a0000'],
];
export const CURRENT_STOPS: [number, string][] = [
  [0, '#cce6fa'], [0.5 * KT, '#66ccf2'], [1.0 * KT, '#4ccc73'], [1.5 * KT, '#f2d933'],
  [2.0 * KT, '#f28c26'], [3.0 * KT, '#d93326'], [5.0 * KT, '#800d0d'],
];
export const WAVE_STOPS: [number, string][] = [
  [0, '#b3e5fc'], [1, '#4fc3f7'], [2, '#43a047'], [3, '#fdd835'], [4, '#fb8c00'], [5, '#e64a19'], [6, '#c62828'],
];
/** Precipitation rate in m/s (kg m⁻² s⁻¹ × 1e-3), stops at 0/0.5/2/5/10/25 mm/h. */
export const PRECIP_STOPS: [number, string][] = [
  [0, '#b3e5fc'], [0.5 * MMH, '#b3e5fc'], [2 * MMH, '#4fc3f7'], [5 * MMH, '#43a047'], [10 * MMH, '#fdd835'], [25 * MMH, '#c2185b'],
];
export const TEMP_STOPS: [number, string][] = [
  [253.15, '#0d2673'], [263.15, '#3359b2'], [268.15, '#73a6e6'], [273.15, '#b2d9f2'], [278.15, '#66d9e6'], [288.15, '#66cc66'],
  [293.15, '#f2eb4c'], [298.15, '#faa626'], [303.15, '#f2591a'], [308.15, '#cc261a'], [313.15, '#800d0d'],
];
export const SST_STOPS: [number, string][] = [
  [271.15, '#4c1a80'], [275.15, '#1a4cbf'], [281.15, '#4ca6d9'], [287.15, '#4cbfa6'], [291.15, '#8cd966'],
  [295.15, '#f2eb4c'], [299.15, '#faa626'], [303.15, '#f24c1a'], [305.15, '#a61a1a'],
];
/** matplotlib RdYlBu_r sampled at 17 points over 0..150 (the server's legend samples). */
export const SEA_STATE_STOPS: [number, string][] = [
  [0, '#313695'], [9.375, '#3d5da8'], [18.75, '#5083bb'], [28.125, '#6ea6cd'], [37.5, '#90c3dd'], [46.875, '#b2dceb'],
  [56.25, '#d3ecf4'], [65.625, '#ecf7e1'], [75, '#fefebe'], [84.375, '#feeca2'], [93.75, '#fdd484'], [103.125, '#fdb467'],
  [112.5, '#f88e52'], [121.875, '#f0653f'], [131.25, '#de3f2e'], [140.625, '#c41e26'], [150, '#a50026'],
];
/**
 * Tide height above mean sea level, m: diverging around 0 (BrBG): low
 * water towards sand / brown (drying), high water towards teal, near-
 * white at mean sea level. Values beyond ±3 m take the end colours.
 */
export const TIDE_STOPS: [number, string][] = [
  [-3, '#543005'], [-2, '#8c510a'], [-1, '#d8b365'], [-0.25, '#f6e8c3'], [0, '#f5f5f5'],
  [0.25, '#c7eae5'], [1, '#5ab4ac'], [2, '#01665e'], [3, '#003c30'],
];
export const SEA_STATE_BANDS: [number, string][] = [[0, 'smooth'], [35, 'good'], [50, 'slight'], [75, 'choppy'], [100, 'rough'], [150, 'extreme']];

export function buildLegends(): Record<string, LegendEntry> {
  return {
    wind: { title: 'Wind', quantity: 'speed', category: 'speed', si_unit: 'm/s', kind: 'gradient', stops: WIND_STOPS },
    current: { title: 'Current', quantity: 'speed', category: 'speed', si_unit: 'm/s', kind: 'gradient', stops: CURRENT_STOPS },
    waves: { title: 'Significant wave height', quantity: 'wave_height', category: 'depth', si_unit: 'm', kind: 'gradient', stops: WAVE_STOPS },
    precip: { title: 'Precipitation rate', quantity: 'precip_depth_rate', category: null, si_unit: 'm/s', kind: 'gradient', stops: PRECIP_STOPS },
    temperature: { title: 'Air temperature (2 m)', quantity: 'temperature', category: 'temperature', si_unit: 'K', kind: 'gradient', stops: TEMP_STOPS },
    sst: { title: 'Sea surface temperature', quantity: 'temperature', category: 'temperature', si_unit: 'K', kind: 'gradient', stops: SST_STOPS },
    sea_state: { title: 'Sea state', quantity: 'index', category: null, si_unit: '', kind: 'bands', stops: SEA_STATE_STOPS, bands: SEA_STATE_BANDS },
    tide: { title: 'Tide height above mean sea level', quantity: 'sea_level', category: 'depth', si_unit: 'm', kind: 'gradient', stops: TIDE_STOPS },
  };
}
