/**
 * The plugin as a chartplotter extension (Signal K Plotter Extensions API,
 * version 1): a toolbar button and a panel (public/plotterext/) that run a
 * route and hand it to the plotter as a draft route. Discovered by hosts
 * such as Freeboard-SK through the `plotterExtensions` resource type; the
 * panel is served by the server as part of this webapp, so no extra route
 * is mounted. Registered once; while the plugin is stopped the collection
 * is empty, which is how a host learns the extension is gone.
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { panelFilesHash } from './webfiles';

export interface PlotterExtensionDeps {
  app: { registerResourceProvider?: (provider: ResourceProvider) => void };
  pluginId: string;
  /** The webapp's public directory and the package root (package.json). */
  publicDir: string;
  packageDir: string;
  isStopped: () => boolean;
  log: (m: string) => void;
  error: (m: string) => void;
}

export interface ResourceProvider {
  type: string;
  methods: {
    listResources: (query?: unknown) => Promise<Record<string, unknown>>;
    getResource: (id: string) => Promise<unknown>;
    setResource: (id: string, value: unknown) => Promise<void>;
    deleteResource: (id: string) => Promise<void>;
  };
}

export function makePlotterExtension(deps: PlotterExtensionDeps): { register: () => void } {
  let registered = false;
  function manifest(): Record<string, unknown> {
    let version: string;
    try {
      version = (JSON.parse(fs.readFileSync(path.join(deps.packageDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '';
    } catch {
      version = '';
    }
    return {
      name: 'Weather Router Plus',
      description: 'Weather routing between the vessel and a destination, as a draft route on the chart.',
      version,
      apiVersion: '1',
      requires: ['buttons', 'panels.iframe', 'routes'],
      optional: ['map', 'units', 'signalk.stream'],
      buttons: [
        {
          id: 'open-weather-router',
          title: 'Weather route',
          slot: 'mapToolbar',
          icon: 'sailing',
          action: { type: 'togglePanel', panel: 'weather-router-panel' },
        },
      ],
      panels: [
        {
          id: 'weather-router-panel',
          title: 'Weather Router Plus',
          type: 'iframe',
          // Versioned by the panel files' own content, so a browser's cached
          // copy (the server serves these files with a 4-hour cache lifetime)
          // is bypassed whenever they change, release or not.
          url: `/${deps.pluginId}/plotterext/panel.html?v=${encodeURIComponent(version)}-${panelFilesHash(deps.publicDir)}`,
          lifecycle: 'keepAlive',
        },
      ],
    };
  }
  function register(): void {
    if (registered || typeof deps.app.registerResourceProvider !== 'function') return;
    try {
      deps.app.registerResourceProvider({
        type: 'plotterExtensions',
        methods: {
          listResources: async () => (deps.isStopped() ? {} : { [deps.pluginId]: manifest() }),
          getResource: async (id: string) => {
            if (deps.isStopped() || id !== deps.pluginId) throw new Error(`no plotterExtensions resource ${id}`);
            return manifest();
          },
          setResource: async () => {
            throw new Error('plotterExtensions is read-only');
          },
          deleteResource: async () => {
            throw new Error('plotterExtensions is read-only');
          },
        },
      });
      registered = true;
      deps.log('registered as a plotter extension (plotterExtensions resource provider)');
    } catch (err) {
      deps.error(`plotter extension not registered: ${(err as Error).message}`);
    }
  }
  return { register };
}
