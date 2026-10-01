/**
 * The colour overlays as Signal K chart resources (`charts`) and resource
 * groups (`groups`) for a chartplotter such as Freeboard-SK, plus which
 * layers have their data (shared with the tile prebuilder).
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import * as fs from 'node:fs';
import { LAYER_PARAMS } from './layers';
import * as path from 'node:path';
import { MERC_MAX_LAT } from '../geo/mercator';
import { HOUR_MS } from '../geo/units';
import { runLastMs, type ArcoRun } from '../data/arco';
import { GLYPH_LAYERS, GLYPH_LAYER_SPECS, type GlyphLayer } from './glyphtiles';
import { PNG_LAYERS, PNG_LAYER_SPECS, type PngLayer } from './pngtiles';
import type { TileLayer } from './tiles';
import type { DataStatus, ForecastRunInfo } from './protocol';
import type { ResourceProvider } from './plotterext';

export interface ChartsDeps {
  app: {
    registerResourceProvider?: (provider: ResourceProvider) => void;
    resourcesApi?: { setResource: (type: string, id: string, data: Record<string, unknown>, providerId?: string) => Promise<void> };
  };
  pluginId: string;
  basePath: string;
  dataDir: () => string;
  isStopped: () => boolean;
  forecastRun: () => ForecastRunInfo | null;
  tidesRun: () => ArcoRun | null;
  tidesEnabled: () => boolean;
  dataStatus: () => DataStatus | null;
  log: (m: string) => void;
  error: (m: string) => void;
}

const CHART_OVERRIDE_KEYS = ['defaultOpacity', 'displayMinZoom', 'imageAdjustment'];

/**
 * The chart layers in Freeboard-SK's resource Groups (the `groups`
 * collection: named sets a chartplotter shows in one tap). One group per
 * colour layer, with its glyphs, written whenever the forecast is
 * (re)loaded and holding the layers whose data is there; ids are fixed,
 * so they are updated in place, and a group with no available layer is
 * left out. Needs a `groups` collection on the
 * server (Freeboard creates one in resources-provider); otherwise skipped.
 */
const CHART_GROUPS: { id: string; name: string; description: string; layers: (PngLayer | GlyphLayer)[] }[] = [
  // One colour layer per group (two heatmaps over each other are unreadable), with the glyphs that belong with it.
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000001',
    name: 'Wind (Weather Router Plus)',
    description: 'Wind speed with wind barbs, by the hour.',
    layers: ['wind', 'barbs'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000002',
    name: 'Waves (Weather Router Plus)',
    description: 'Wave height with wind barbs, by the hour.',
    layers: ['waves', 'barbs'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000003',
    name: 'Currents (Weather Router Plus)',
    description: 'Current speed with current arrows, by the hour.',
    layers: ['current', 'arrows'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000004',
    name: 'Pressure (Weather Router Plus)',
    description: 'Isobars with wind barbs, by the hour.',
    layers: ['isobars', 'barbs'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000005',
    name: 'Sea state (Weather Router Plus)',
    description: 'Wind-against-current sea state with current arrows, by the hour.',
    layers: ['sea_state', 'arrows'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000006',
    name: 'Tide (Weather Router Plus)',
    description: 'Tide height with current arrows, by the hour.',
    layers: ['tide', 'arrows'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000007',
    name: 'Rain (Weather Router Plus)',
    description: 'Precipitation with isobars, by the hour.',
    layers: ['precip', 'isobars'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000008',
    name: 'Air temperature (Weather Router Plus)',
    description: 'Air temperature with isobars, by the hour.',
    layers: ['temperature', 'isobars'],
  },
  {
    id: 'c2b7e6a0-5d1c-4abc-9000-000000000009',
    name: 'Sea temperature (Weather Router Plus)',
    description: 'Sea surface temperature with current arrows, by the hour.',
    layers: ['sst', 'arrows'],
  },
];

export class ChartsProvider {
  private overrides: Record<string, Record<string, unknown>> = {};
  private groupsWritten = '';
  private registered = false;

  constructor(private readonly deps: ChartsDeps) {}

  private overridesFile(): string {
    return path.join(this.deps.dataDir(), 'chart-overrides.json');
  }

  /**
   * The colour overlays as Signal K chart resources (`charts`): PNG tiles
   * served by /api/tile/<layer>/{z}/{x}/{y}.png (pngtiles.ts). A chartplotter
   * such as Freeboard-SK lists them with its charts and, from the `time`
   * block, offers its own time scrubber over the forecast hours; the
   * plotter re-reads the resource every `refreshInterval`, so a new cycle
   * moves the timeline on. Listed only while the data is there (forecast;
   * currents or tides for those layers). A display setting the plotter
   * saves on one of them (opacity, minimum zoom, image adjustment) is kept
   * in chart-overrides.json in the data directory; the charts themselves
   * cannot be deleted.
   */
  /** Is the layer's data there (forecast fields; currents or tides for those layers)? */
  layerAvailable(layer: TileLayer | PngLayer | GlyphLayer): boolean {
    const forecastRun = this.deps.forecastRun();
    const tidesRun = this.deps.tidesRun();
    const dataStatus = this.deps.dataStatus();
    if (!forecastRun) return false;
    if (layer === 'tide') return this.deps.tidesEnabled() && !!tidesRun;
    if (layer === 'current' || layer === 'arrows') return (dataStatus?.currents.length ?? 0) > 0;
    if ((layer === 'waves' || layer === 'sea_state') && dataStatus?.forecast && !dataStatus.forecast.hasWaves) return false;
    const params = forecastRun.index.request.params;
    return (LAYER_PARAMS[layer] ?? []).every(p => params.includes(p));
  }
  resource(layer: PngLayer | GlyphLayer): Record<string, unknown> | null {
    const forecastRun = this.deps.forecastRun();
    const tidesRun = this.deps.tidesRun();
    if (this.deps.isStopped() || !forecastRun || !this.layerAvailable(layer)) return null;
    const spec = layer in PNG_LAYER_SPECS ? PNG_LAYER_SPECS[layer as PngLayer] : GLYPH_LAYER_SPECS[layer as GlyphLayer];
    const steps = forecastRun.index.steps;
    const lastMs = layer === 'tide' ? (tidesRun ? runLastMs(tidesRun) : null) : steps[steps.length - 1].validMs;
    if (lastMs === null) return null;
    const fromMs = Math.max(steps[0].validMs, Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const base = `${this.deps.basePath}/api/tile/${layer}/{z}/{x}/{y}.png`;
    return {
      identifier: spec.chartId,
      name: `${spec.name} (Weather Router Plus)`,
      description: spec.description,
      type: 'tilelayer',
      format: 'png',
      url: base,
      time: {
        url: `${base}?time={time}`,
        current: true,
        from: new Date(fromMs).toISOString(),
        to: new Date(Math.max(fromMs, lastMs)).toISOString(),
        step: HOUR_MS,
      },
      refreshInterval: 600_000,
      bounds: [-180, -MERC_MAX_LAT, 180, MERC_MAX_LAT],
      minzoom: 2,
      maxzoom: 18,
      tileSize: 256,
      defaultOpacity: 0.7,
      ...(this.overrides[spec.chartId] ?? {}),
    };
  }
  resources(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const layer of [...PNG_LAYERS, ...GLYPH_LAYERS]) {
      const c = this.resource(layer);
      if (c) out[c.identifier as string] = c;
    }
    return out;
  }
  async publishGroups(): Promise<void> {
    if (!this.deps.app.resourcesApi?.setResource || this.deps.isStopped()) return;
    const charts = this.resources();
    const groups = CHART_GROUPS.map(g => ({
      ...g,
      charts: g.layers
        .map(l => (l in PNG_LAYER_SPECS ? PNG_LAYER_SPECS[l as PngLayer] : GLYPH_LAYER_SPECS[l as GlyphLayer]).chartId)
        .filter(id => id in charts),
    })).filter(g => g.charts.length > 0);
    const key = JSON.stringify(groups.map(g => [g.id, g.charts]));
    if (key === this.groupsWritten) return;
    try {
      for (const g of groups)
        await this.deps.app.resourcesApi.setResource('groups', g.id, { name: g.name, description: g.description, charts: g.charts });
      this.groupsWritten = key;
      this.deps.log(
        `chart groups written: ${groups.map(g => `${g.name.replace(' (Weather Router Plus)', '')} (${g.charts.length})`).join(', ')}`
      );
    } catch (err) {
      // Not recorded as written: a transient or partial failure is tried again on the next forecast.
      // (No groups collection on this server, or no permission: the layers are still in the Chart list.)
      this.deps.log(`chart groups not written: ${(err as Error).message}`);
    }
  }
  register(): void {
    if (this.registered || typeof this.deps.app.registerResourceProvider !== 'function') return;
    try {
      this.overrides = JSON.parse(fs.readFileSync(this.overridesFile(), 'utf8')) as Record<string, Record<string, unknown>>;
    } catch {
      this.overrides = {};
    }
    try {
      this.deps.app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: async () => this.resources(),
          getResource: async (id: string) => {
            const c = this.resources()[id];
            if (!c) throw new Error(`no chart ${id}`);
            return c;
          },
          setResource: async (id: string, value: unknown) => {
            if (![...Object.values(PNG_LAYER_SPECS), ...Object.values(GLYPH_LAYER_SPECS)].some(s => s.chartId === id))
              throw new Error(`no chart ${id}`);
            const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
            const keep: Record<string, unknown> = {};
            for (const k of CHART_OVERRIDE_KEYS) {
              if (!(k in v)) continue;
              const x = v[k];
              if (k === 'defaultOpacity' && !(typeof x === 'number' && x >= 0 && x <= 1))
                throw new Error(`${k} must be a number from 0 to 1`);
              if (k === 'displayMinZoom' && !(typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 24))
                throw new Error(`${k} must be a whole number from 0 to 24`);
              if (k === 'imageAdjustment' && !(x && typeof x === 'object' && !Array.isArray(x))) throw new Error(`${k} must be an object`);
              keep[k] = x;
            }
            // Persist a candidate first: the map changes only once the write succeeded.
            const next = { ...this.overrides, [id]: { ...(this.overrides[id] ?? {}), ...keep } };
            fs.writeFileSync(this.overridesFile(), JSON.stringify(next, null, 2));
            this.overrides = next;
          },
          deleteResource: async (id: string) => {
            throw new Error(`chart ${id} is provided by the plugin and cannot be deleted`);
          },
        },
      });
      this.registered = true;
      this.deps.log(`registered as a charts provider (${PNG_LAYERS.length + GLYPH_LAYERS.length} overlay layers as PNG tiles)`);
    } catch (err) {
      this.deps.error(`charts provider not registered: ${(err as Error).message}`);
    }
  }
}
