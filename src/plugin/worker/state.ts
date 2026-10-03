/**
 * The worker's state: what the role's modules share, created once by worker.ts.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import type { Worker } from 'node:worker_threads';
import type { EcmwfClient } from '../../data/ecmwf';
import type { ForecastStore } from '../../data/forecast';
import type { DecodedRun } from '../../data/decoded';
import type { LandMask } from '../../geo/landmask';
import type { OnDemandLand } from '../../geo/landcache';
import type { WaterGrid } from '../../geo/watergrid';
import type { PolarDiagram } from '../../vessel/polar';
import type { HarmonicCurrentSource } from '../../currents/harmonic';
import type { CurrentStack } from '../../currents/stack';
import type { RtofsClient, RtofsCurrentSource } from '../../currents/rtofs';
import type { SmocClient, SmocCurrentSource } from '../../currents/smoc';
import type { SeaLevelClient, TideSource } from '../../tides/sealevel';
import type { ResolvedConfig } from '../config';
import type { DataStatus, ForecastMemory, ForecastRunInfo, VesselPosition, WorkerRole, WorkerToMain } from '../protocol';

export interface WorkerState {
  readonly role: WorkerRole;
  /** Shared Int32: 1 cancels the running route. */
  readonly cancelFlag: Int32Array;
  readonly send: (m: WorkerToMain) => void;
  readonly log: (level: 'debug' | 'info' | 'error', message: string) => void;
  config: ResolvedConfig | null;
  client: EcmwfClient | null;
  rtofsClient: RtofsClient | null;
  /** The decoded run in use (on disk; only its index is in memory). */
  run: DecodedRun | null;
  /** How it became current (status). */
  runInfo: ForecastRunInfo | null;
  /** Forecast memory this thread holds (query windows, the route's corridor store). */
  readonly forecastMemory: ForecastMemory;
  /** Last streaming decode (status). */
  lastDecode: DataStatus['lastDecode'];
  /** One-step block size while a decode runs. */
  decodingBlockBytes: number | null;
  /** Bytes of the decoded runs and GRIB cache on disk, refreshed after each forecast check. */
  diskBytes: { decoded: number; grib: number };
  /** On-demand overlay land rasters (data / tiles worker). */
  overlayLand: OnDemandLand | null;
  polar: PolarDiagram | null;
  landCache: { key: string; mask: LandMask } | null;
  harmonic: HarmonicCurrentSource[];
  rtofs: RtofsCurrentSource | null;
  smocClient: SmocClient | null;
  smoc: SmocCurrentSource | null;
  /** Last vessel position from the main thread (SMOC resident area centre). */
  vesselPos: VesselPosition | null;
  stack: CurrentStack;
  /** overlayLand.builds when data-status was last sent. */
  reportedLandBuilds: number;
  /** SMOC revision when data-status was last sent. */
  reportedSmocRev: number;
  /** Plugin data directory (cache root). */
  cacheRoot: string;
  /** Regional runs decoded from signalk-grib-downloader, per source (data worker). */
  regional: Map<string, import('../protocol').RegionalDecodeState>;
  /** Copernicus Marine sea level (data worker only). */
  seaLevelClient: SeaLevelClient | null;
  tides: TideSource | null;
  /** Last tide probe / load error (status). */
  tidesError: string | null;
  /** Tide revision when data-status was last sent. */
  reportedTidesRev: number;
  /** Global water grid (route worker). */
  waterGrid: WaterGrid | null;
  /** Builder thread while a rebuild runs. */
  gridBuilder: Worker | null;
  /** The running route's forecast area (released when the route ends). */
  routeWindow: ForecastStore | null;
  /** The running route's regional wind areas (released with the route). */
  routeRegional: ForecastStore[];
  /** Queries the main thread cancelled before they started (its client went away). */
  readonly cancelledQueries: Set<number>;
}

export function requireInit(st: WorkerState): { config: ResolvedConfig; client: EcmwfClient } {
  if (!st.config || !st.client) throw new Error('worker not initialised');
  return { config: st.config, client: st.client };
}
