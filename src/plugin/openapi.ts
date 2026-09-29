/** OpenAPI 3.0 description of the plugin API, served at /api/openapi.json and via getOpenApi(). */

import { SETTINGS_GROUPS, SETTINGS_SPEC, type SettingSpec } from './settings';

/** JSON schema of one setting's value (SI). */
function settingValueSchema(s: SettingSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: `${s.label}${s.unit ? ` (${s.unit})` : ''}. ${s.help}` };
  switch (s.type) {
    case 'boolean':
      return { ...base, type: 'boolean', default: s.default };
    case 'string':
      return { ...base, type: 'string', maxLength: s.maxLength, default: s.default };
    case 'enum':
      return { ...base, type: 'string', enum: [...(s.enum ?? [])], default: s.default };
    default:
      return {
        ...base,
        type: s.type === 'integer' ? 'integer' : 'number',
        minimum: s.min,
        maximum: s.max,
        ...(s.multipleOf ? { multipleOf: s.multipleOf } : {}),
        ...(s.nullable ? { nullable: true } : {}),
        default: s.default,
      };
  }
}

/** {group: {key: schema}} for the settings values object. */
function settingsValuesSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const g of SETTINGS_GROUPS) {
    const inner: Record<string, unknown> = {};
    for (const s of SETTINGS_SPEC.filter(x => x.group === g.id)) inner[s.key.split('.')[1]] = settingValueSchema(s);
    props[g.id] = { type: 'object', description: `${g.label}. ${g.help}`, properties: inner };
  }
  return { type: 'object', properties: props };
}

export function openApiDocument(basePath: string): Record<string, unknown> {
  const point = {
    type: 'object',
    required: ['lat', 'lon'],
    properties: { lat: { type: 'number' }, lon: { type: 'number' } },
  };
  const routeRequest = {
    type: 'object',
    required: ['start', 'end'],
    properties: {
      start: point,
      end: point,
      waypoints: {
        type: 'array',
        maxItems: 20,
        description:
          'Ordered waypoints; each ends one leg and starts the next. radius_m overrides arrival_radius_m for that waypoint (approximate precision).',
        items: { ...point, properties: { ...point.properties, radius_m: { type: 'number', minimum: 0, maximum: 5000 } } },
      },
      precision: {
        type: 'string',
        enum: ['precise', 'approximate'],
        default: 'precise',
        description:
          'precise: each leg ends exactly on its waypoint; approximate: a leg ends as soon as the route enters the waypoint circle and the next leg starts there. The destination is always exact.',
      },
      arrival_radius_m: {
        type: 'number',
        minimum: 0,
        maximum: 5000,
        default: 200,
        description: 'Waypoint circle radius in metres for approximate precision (must be > 0 then); ignored when precise.',
      },
      departure: { type: 'string', format: 'date-time', description: 'Empty or absent = now' },
      mode: { type: 'string', enum: ['sail_max', 'fastest', 'motor'], default: 'sail_max' },
      sail_thresh_ms: { type: 'number', description: 'Overrides the routing.sailThreshold setting (m/s)' },
      simplify_m: {
        type: 'number',
        minimum: 0,
        maximum: 5000,
        description: 'RDP simplification tolerance in metres (0 = off); overrides routing.simplify',
      },
      smoother: { type: 'boolean', description: 'Run the shortcut smoother; overrides routing.smoother' },
      smoother_tolerance: {
        type: 'number',
        minimum: 0,
        maximum: 0.5,
        description: 'Shortcut time tolerance as a ratio; overrides routing.smootherTolerance',
      },
      name: { type: 'string', description: 'Name for the Signal K route resource' },
      stages: { type: 'integer', minimum: 4, maximum: 200, description: 'Overrides the routing.stages setting' },
      no_forecast: { type: 'boolean', description: 'Route with calm wind' },
      publish: { type: 'boolean', description: 'Override the publish.toResources setting for this route' },
      vessel: {
        type: 'object',
        description: 'Per-route overrides of the vessel settings (SI); absent keys use the settings.',
        properties: {
          name: { type: 'string' },
          draught: { type: 'number' },
          air_draft: { type: 'number' },
          loa: { type: 'number' },
          beam: { type: 'number' },
          motor_speed_ms: { type: 'number' },
          under_keel_clearance: { type: 'number' },
          tack_penalty_s: { type: 'number', minimum: 0, maximum: 600 },
          polar_performance: {
            type: 'number',
            minimum: 0.3,
            maximum: 1.2,
            description: 'Share of the polar boat speeds achieved under sail (ratio, 1 = as written)',
          },
          polar: { type: 'string', maxLength: 200, description: 'Polar token from /api/polars; absent = the configured default' },
        },
      },
    },
  };
  const job = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
      request: routeRequest,
      created_at: { type: 'string' },
      started_at: { type: 'string' },
      finished_at: { type: 'string' },
      progress: { type: 'array', items: { type: 'object' } },
      summary: { type: 'object' },
      error: { type: 'string' },
      resource_id: { type: 'string' },
      links: { type: 'object' },
    },
  };
  return {
    openapi: '3.0.0',
    info: {
      title: 'signalk-weather-router-plus',
      version: '0.1.0',
      description: 'Standalone open-water weather routing on ECMWF open data. All values SI (m, m/s, s, degrees true).',
    },
    servers: [{ url: basePath }],
    paths: {
      '/api/status': {
        get: {
          summary: 'Plugin, forecast (decoded run on disk, memory held), currents, overlay land cache and queue status',
          description:
            '`forecast` (null until a run is ready): {cycle, valid_from, valid_to, steps, params, coverage, storage: "decoded-on-disk", loaded_at, has_waves, ' +
            'source: "disk" (a complete decoded run was already on disk, no decode) | "grib" (decoded from the GRIB cache / download), ready_ms, fields_downloaded, ' +
            'decoded_dir, decoded_bytes (this run on disk), decoded_at, decode_ms, decoded_disk_bytes (all decoded runs kept), grib_cache_bytes, ' +
            'last_decode: {at, cycle, ms, stepBlockBytes, writtenBytes, downloaded} | null, memory: {data_worker_held_bytes, data_worker_largest_recent_window, ' +
            'route_worker_held_bytes, route_worker_largest_recent_window, decoding_block_bytes}} — the decoded forecast is never resident; `memory` is what ' +
            "requests hold now (a route's corridor store while it runs, a query's window while it is answered). `process_rss_bytes`: the Signal K process RSS. " +
            "`currents` lists the data worker's current sources in priority order ({name, priority, resolutionM, bbox, validFrom, validTo}); " +
            'the CMEMS-SMOC entry adds `smoc`: {run, run_last_time, stac_updated, settled, step_hours, horizon_hours, half_width_deg, ' +
            'resident: {bbox, centre, steps, valid_from, valid_to, bytes, layout} | null, on_demand: {areas, bytes, budget_bytes, list}, memory_bytes, ' +
            'shared_resident, last_download: {at, reason, bytes, chunks, downloaded, from_disk, seconds, decode_ms} | null, downloaded_bytes_total, disk_cache_bytes, layouts}. ' +
            '`currents_route_worker` is the same for the route worker (its own on-demand SMOC areas). ' +
            '`tides` (null when off or not loaded; `tides_enabled`, `tides_error`): the Copernicus Marine sea-level source {name, doi, datum, run, run_last_time, ' +
            'stac_updated, settled, half_width_deg, horizon_hours, resident: {bbox, centre, steps, valid_from, valid_to, bytes, layout} | null, on_demand: {areas, bytes, budget_bytes, list}, ' +
            'point_cache: {entries, bytes, queries, hits}, memory_bytes, last_download, last_point_query: {at, lat, lon, bytes, chunks, downloaded, from_disk, seconds, cached} | null, ' +
            'downloaded_bytes_total, disk_cache_bytes, layouts, mean_window_days}.',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/settings': {
        get: {
          summary:
            'Web-app settings (vessel, forecast, currents, routing, publishing) with their schema. Values are SI: m, m/s, s (degrees for the heading increment).',
          responses: {
            200: {
              description:
                '{values, schema: {groups[{id,label,help}], settings[{key, group, label, type, unit, quantity, min, max, multipleOf, default, nullable, enum, maxLength, help, reload}]}}',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { values: settingsValuesSchema(), schema: { type: 'object' } } },
                },
              },
            },
            503: { description: 'Plugin not started' },
          },
        },
        put: {
          summary:
            'Update some settings (readwrite). Only the keys sent change; validated all-or-nothing, saved to settings.json and applied live: a new forecast horizon or extra-fields choice reloads the forecast, SMOC and RTOFS settings reload currents, tide settings reload tides only, everything else applies to the next route.',
          requestBody: { required: true, content: { 'application/json': { schema: settingsValuesSchema() } } },
          responses: {
            200: { description: '{values, changed: ["group.key"], reloaded: {forecast, currents, tides, refresh_timer, jobs}}' },
            400: { description: '{error, errors: {"group.key": message}}; nothing saved' },
            401: { description: 'Not signed in' },
            403: { description: 'Needs readwrite access' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/forecast': {
        get: {
          summary: 'Forecast (global, decoded on disk) metadata, optionally sampled at any position (every step)',
          parameters: [
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'lon', in: 'query', schema: { type: 'number' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/polars': {
        get: {
          summary: 'Polar library: the configured default plus every .pol/.csv in the polars directory',
          responses: { 200: { description: '[{path,label,source}]' } },
        },
      },
      '/api/polar-angles': {
        get: {
          summary: 'Best upwind/downwind VMG angles per TWS for a polar',
          parameters: [
            {
              name: 'path',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Token from /api/polars; absent or empty = the configured default',
            },
          ],
          responses: { 200: { description: '{tws_ms[], beat_deg[], run_deg[]}' }, 404: { description: 'Not in the library' } },
        },
      },
      '/api/polars/table': {
        get: {
          summary: 'Polar speed table in SI (m/s) for drawing',
          parameters: [
            {
              name: 'path',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Token from /api/polars; absent or empty = the configured default',
            },
          ],
          responses: { 200: { description: '{twa_deg[], tws_ms[], speeds_ms[][]}' }, 404: { description: 'Not in the library' } },
        },
      },
      '/api/polar-from-specs': {
        post: {
          summary:
            'Generate a polar from boat specs with the physics polar calculator (ORC sail forces, Delft hull resistance, heeling limit; no spinnaker) and save it to <polarsDir>/user/<slug>.csv',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'specs'],
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 60,
                      description: 'Slugified to the file name: lower case, spaces to _, only [a-z0-9_-] kept',
                    },
                    overwrite: { type: 'boolean', default: false },
                    specs: {
                      type: 'object',
                      required: ['loa_m', 'lwl_m', 'beam_m', 'draft_m', 'displacement_kg', 'sail_area_upwind_m2'],
                      properties: {
                        loa_m: { type: 'number', minimum: 3, maximum: 50 },
                        lwl_m: { type: 'number', minimum: 2, maximum: 50, description: 'Must not exceed loa_m (+0.01)' },
                        beam_m: { type: 'number', minimum: 0.5, maximum: 15 },
                        draft_m: { type: 'number', minimum: 0.1, maximum: 8 },
                        displacement_kg: { type: 'number', minimum: 50, maximum: 500000 },
                        ballast_kg: { type: 'number', nullable: true },
                        sail_area_upwind_m2: { type: 'number', exclusiveMinimum: true, minimum: 0, description: 'Main + 100% jib' },
                        sail_area_downwind_m2: {
                          type: 'number',
                          default: 0,
                          description: 'Accepted but not used: the calculator assumes no spinnaker (a value > 0 adds a warning)',
                        },
                        mast_height_m: { type: 'number', nullable: true },
                        rig_type: { type: 'string', enum: ['sloop', 'cutter', 'ketch', 'yawl', 'cat'], default: 'sloop' },
                        keel_type: { type: 'string', enum: ['fin', 'bulb', 'wing', 'full', 'centerboard', 'swing'], default: 'fin' },
                        hull_type: { type: 'string', enum: ['monohull', 'catamaran', 'trimaran'], default: 'monohull' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description:
                '{path: "user/<slug>.csv" (token for /api/polars and vessel.polar), label, warnings[], polar: {path, twa_deg[], tws_ms[], speeds_ms[][]}}',
            },
            400: { description: 'Invalid specs or name, or no polarsDir configured' },
            409: { description: 'A polar with that name exists and overwrite is false' },
            422: { description: 'Hull type the polar calculator does not model (multihulls)' },
          },
        },
      },
      '/api/field': {
        get: {
          summary: 'JSON value grid for a heatmap layer over a bbox at one time',
          description:
            'layer=current returns display values: gridded model currents (CMEMS SMOC, RTOFS) are extended up to 2 source-grid cells into the ' +
            'cells the model leaves empty at the coast (inverse-distance weights over valid cells; valid cells unchanged), for clipping with /api/land-mask. ' +
            'When the bbox is outside the resident SMOC area it is loaded on demand first (at most 60 s wait). ' +
            'layer=tide returns `tide_m`: the tide height in metres above MEAN SEA LEVEL (not chart datum) from Copernicus Marine `ocean_tide` (FES2014) at the hour ' +
            '(linear between hourly steps), with the same 2-cell coastal extension for display; outside the resident tide area the hour is loaded on demand ' +
            '(1/3° grid for res ≥ 0.25°).',
          parameters: [
            {
              name: 'layer',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['wind', 'waves', 'msl', 'temperature', 'sst', 'precip', 'sea_state', 'current', 'tide'] },
            },
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'res',
              in: 'query',
              schema: { type: 'number', minimum: 0.002, maximum: 2 },
              description: 'lattice spacing, degrees (coarsened to at most 40k cells)',
            },
          ],
          responses: {
            200: { description: '{layer, time, bbox, res, lons, lats, fields: {name: rows from the south, null = no data}, land, units}' },
          },
        },
      },
      '/api/conditions': {
        get: {
          summary:
            'Hourly point series of every conditions field, plus tide height, total water level and surge with the high and low waters',
          description:
            'Rows: every conditions field (wind_ms, wind_dir_deg, swh_m, mwp_s, mwd_deg, current_ms, current_dir_deg, msl_pa, t2m_k, skt_k, precip_rate_ms, precip_type, precip_type_label, dewpoint_k, rh, feels_like_k, feels_like_basis, wind_chill_k, heat_index_k, beaufort, douglas, douglas_label, sea_state_index, sea_state, sea_state_partial) plus `time` and the tide fields `tide_m` (tide height above mean sea level, m; Copernicus Marine ocean_tide, FES2014), ' +
            '`water_level_m` (total water level above local mean sea level, m = total_sea_level − local mean), `surge_m` (non-tidal residual = water level − tide, m), ' +
            '`tide_extrapolated` (a bilinear corner is model land and took the value of valid cells within 2 cells, ~18 km), `tide_tendency` (rising / falling / steady within ±2 cm/h). ' +
            'Tide fields are null when tides are off or there is no model water within 2 cells. ' +
            '`tides`: {highs: [{time, height_m, water_level_m}], lows: [...], range_m (mean of consecutive high−low differences), max_range_m, of: "tide_m", source, run, ' +
            'datum: "mean sea level", msl_offset_m (mean of total_sea_level − ocean_tide over mean_window, removed from the total level), mean_window: {from, to, samples}, extrapolated, doi} ' +
            'or null (`tides_error` says why). High / low waters are those of the tide height, refined with a parabola through the hourly samples. ' +
            'Heights are relative to mean sea level, NOT chart datum: not for under-keel clearance.',
          parameters: [
            { name: 'lon', in: 'query', required: true, schema: { type: 'number' } },
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Default: the current hour' },
            { name: 'hours', in: 'query', schema: { type: 'number', minimum: 1, maximum: 240, default: 72 } },
            { name: 'step_h', in: 'query', schema: { type: 'number', minimum: 1, maximum: 24, default: 1 } },
          ],
          responses: {
            200: {
              description:
                '{lon, lat, is_land, from, hours, step_h, forecast_time_range, truncated, series: [row], tides, tides_error, sources: {forecast_cycle, currents, tides}}',
            },
            400: { description: 'Bad parameters' },
          },
        },
      },
      '/api/legends': {
        get: {
          summary:
            'Colour ramps for the heatmap layers: {key: {title, quantity, si_unit, kind, stops: [[SI value, css colour]], bands?}}; `tide`: tide height above mean sea level, −3..+3 m diverging',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/currents': {
        get: {
          summary: 'Current arrows on a lattice (display values, extended to the coast as for /api/field?layer=current)',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'res',
              in: 'query',
              schema: { type: 'number', minimum: 0.005, maximum: 5, default: 0.05 },
              description: 'lattice spacing, degrees',
            },
          ],
          responses: { 200: { description: '[{lon, lat, u_ms, v_ms, speed_ms, dir_deg (TO)}], land and near-slack points dropped' } },
        },
      },
      '/api/land-mask': {
        get: {
          summary: 'Land mask at screen resolution for clipping drawn layers to the coastline',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'w', in: 'query', required: true, schema: { type: 'integer', minimum: 16, maximum: 2048 } },
            { name: 'h', in: 'query', required: true, schema: { type: 'integer', minimum: 16, maximum: 2048 } },
          ],
          responses: {
            200: {
              description: 'gzip-encoded bytes, one per pixel (1 = land), row 0 at the north edge; X-Mask-Width/X-Mask-Height headers',
            },
          },
        },
      },
      '/api/forecast/refresh': { post: { summary: 'Check ECMWF for a newer cycle', responses: { 202: { description: 'Accepted' } } } },
      '/api/routes': {
        post: {
          summary: 'Submit a route job',
          requestBody: { required: true, content: { 'application/json': { schema: routeRequest } } },
          responses: { 202: { description: 'Job accepted' }, 400: { description: 'Invalid request' }, 429: { description: 'Queue full' } },
        },
        get: {
          summary: 'List jobs',
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: job } } } } },
        },
      },
      '/api/routes/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Job status',
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: job } } }, 404: { description: 'Not found' } },
        },
        delete: { summary: 'Delete a finished job', responses: { 204: { description: 'Deleted' } } },
      },
      '/api/routes/{id}/events': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Server-Sent Events: status, progress, route, done, error',
          responses: { 200: { description: 'text/event-stream' } },
        },
      },
      '/api/routes/{id}/result': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Route as GeoJSON FeatureCollection (LineString + one Point per waypoint)',
          responses: { 200: { description: 'OK' }, 409: { description: 'Not finished' } },
        },
      },
      '/api/routes/{id}/signalk': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'Route as a Signal K Resources API route record', responses: { 200: { description: 'OK' } } },
      },
      '/api/routes/{id}/cancel': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Cancel a queued or running job', responses: { 202: { description: 'Accepted' } } },
      },
      '/api/routes/{id}/publish': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Save the route to /signalk/v2/api/resources/routes',
          responses: { 200: { description: 'Published' }, 502: { description: 'Resources API error' } },
        },
      },
    },
  };
}
