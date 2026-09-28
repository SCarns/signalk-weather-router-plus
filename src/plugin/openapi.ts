/** OpenAPI 3.0 description of the plugin API, served at /api/openapi.json and via getOpenApi(). */

import { SETTINGS_GROUPS, SETTINGS_SPEC, type SettingSpec } from './settings';

/** JSON schema of one setting's value (SI). */
function settingValueSchema(s: SettingSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: `${s.label}${s.unit ? ` (${s.unit})` : ''}. ${s.help}` };
  switch (s.type) {
    case 'boolean': return { ...base, type: 'boolean', default: s.default };
    case 'string': return { ...base, type: 'string', maxLength: s.maxLength, default: s.default };
    case 'enum': return { ...base, type: 'string', enum: [...(s.enum ?? [])], default: s.default };
    default: return {
      ...base, type: s.type === 'integer' ? 'integer' : 'number', minimum: s.min, maximum: s.max,
      ...(s.multipleOf ? { multipleOf: s.multipleOf } : {}), ...(s.nullable ? { nullable: true } : {}), default: s.default,
    };
  }
}

/** {group: {key: schema}} for the settings values object. */
function settingsValuesSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const g of SETTINGS_GROUPS) {
    const inner: Record<string, unknown> = {};
    for (const s of SETTINGS_SPEC.filter((x) => x.group === g.id)) inner[s.key.split('.')[1]] = settingValueSchema(s);
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
        description: 'Ordered pass-through points; radius_m is the disc the track must cross (default 500).',
        items: { ...point, properties: { ...point.properties, radius_m: { type: 'number' } } },
      },
      departure: { type: 'string', format: 'date-time', description: 'Empty or absent = now' },
      mode: { type: 'string', enum: ['sail_max', 'fastest', 'motor'], default: 'sail_max' },
      sail_thresh_ms: { type: 'number', description: 'Overrides the routing.sailThreshold setting (m/s)' },
      name: { type: 'string', description: 'Name for the Signal K route resource' },
      stages: { type: 'integer', minimum: 4, maximum: 200, description: 'Overrides the routing.stages setting' },
      no_forecast: { type: 'boolean', description: 'Route with calm wind' },
      publish: { type: 'boolean', description: 'Override the publish.toResources setting for this route' },
      vessel: {
        type: 'object',
        description: 'Per-route overrides of the vessel settings (SI); absent keys use the settings.',
        properties: {
          name: { type: 'string' }, draught: { type: 'number' }, air_draft: { type: 'number' }, loa: { type: 'number' },
          beam: { type: 'number' }, motor_speed_ms: { type: 'number' }, under_keel_clearance: { type: 'number' }, tack_penalty_s: { type: 'number', minimum: 0, maximum: 600 },
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
      '/api/status': { get: { summary: 'Plugin, forecast (global coverage, resident bytes, shared), currents, overlay land cache and queue status', responses: { 200: { description: 'OK' } } } },
      '/api/settings': {
        get: {
          summary: 'Web-app settings (vessel, forecast, currents, routing, publishing) with their schema. Values are SI: m, m/s, s (degrees for the heading increment).',
          responses: {
            200: {
              description: '{values, schema: {groups[{id,label,help}], settings[{key, group, label, type, unit, quantity, min, max, multipleOf, default, nullable, enum, maxLength, help, reload}]}}',
              content: { 'application/json': { schema: { type: 'object', properties: { values: settingsValuesSchema(), schema: { type: 'object' } } } } },
            },
            503: { description: 'Plugin not started' },
          },
        },
        put: {
          summary: 'Update some settings (readwrite). Only the keys sent change; validated all-or-nothing, saved to settings.json and applied live: a new forecast horizon or extra-fields choice reloads the forecast, RTOFS settings reload currents, everything else applies to the next route.',
          requestBody: { required: true, content: { 'application/json': { schema: settingsValuesSchema() } } },
          responses: {
            200: { description: '{values, changed: ["group.key"], reloaded: {forecast, currents, refresh_timer, jobs}}' },
            400: { description: '{error, errors: {"group.key": message}}; nothing saved' },
            401: { description: 'Not signed in' },
            403: { description: 'Needs readwrite access' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/forecast': {
        get: {
          summary: 'Resident (global) forecast metadata, optionally sampled at any position',
          parameters: [
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'lon', in: 'query', schema: { type: 'number' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/polars': { get: { summary: 'Polar library: the configured default plus every .pol/.csv in the polars directory', responses: { 200: { description: '[{path,label,source}]' } } } },
      '/api/polar-angles': {
        get: {
          summary: 'Best upwind/downwind VMG angles per TWS for a polar',
          parameters: [{ name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: 'Token from /api/polars; absent or empty = the configured default' }],
          responses: { 200: { description: '{tws_ms[], beat_deg[], run_deg[]}' }, 404: { description: 'Not in the library' } },
        },
      },
      '/api/polars/table': {
        get: {
          summary: 'Polar speed table in SI (m/s) for drawing',
          parameters: [{ name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: 'Token from /api/polars; absent or empty = the configured default' }],
          responses: { 200: { description: '{twa_deg[], tws_ms[], speeds_ms[][]}' }, 404: { description: 'Not in the library' } },
        },
      },
      '/api/polar-from-specs': {
        post: {
          summary: 'Generate a polar from boat specs with the empirical VPP and save it to <polarsDir>/user/<slug>.csv',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'specs'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 60, description: 'Slugified to the file name: lower case, spaces to _, only [a-z0-9_-] kept' },
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
                        sail_area_downwind_m2: { type: 'number', default: 0, description: '0 = 1.5 x upwind' },
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
            200: { description: '{path: "user/<slug>.csv" (token for /api/polars and vessel.polar), label, warnings[], polar: {path, twa_deg[], tws_ms[], speeds_ms[][]}}' },
            400: { description: 'Invalid specs or name, or no polarsDir configured' },
            409: { description: 'A polar with that name exists and overwrite is false' },
            422: { description: 'Hull type the empirical VPP cannot model (multihulls)' },
          },
        },
      },
      '/api/conditions-tile/{z}/{x}/{y}': {
        parameters: [
          { name: 'z', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'x', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'y', in: 'path', required: true, schema: { type: 'string' }, description: 'Tile row; a ".json" suffix is accepted' },
          { name: 't', in: 'query', required: true, schema: { type: 'string' }, description: 'Hour-truncated UTC ISO time, YYYY-MM-DDTHH[:00[:00]][Z]' },
        ],
        get: {
          summary: 'Conditions sample points for one XYZ tile at one hour (wind-barb spacing, land dropped, empty below zoom 5)',
          responses: {
            200: { description: '[{lon, lat, wind_ms, wind_dir_deg, swh_m, mwp_s, mwd_deg, current_ms, current_dir_deg, msl_pa, t2m_k, skt_k, precip_rate_ms, precip_type, precip_type_label, dewpoint_k, rh, feels_like_k, feels_like_basis, wind_chill_k, heat_index_k, beaufort, douglas, douglas_label, sea_state_index, sea_state, sea_state_partial}]' },
            400: { description: 'Bad t' },
            404: { description: 'Tile out of range' },
            503: { description: 'No forecast or current data loaded' },
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
        get: { summary: 'List jobs', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: job } } } } } },
      },
      '/api/routes/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'Job status', responses: { 200: { description: 'OK', content: { 'application/json': { schema: job } } }, 404: { description: 'Not found' } } },
        delete: { summary: 'Delete a finished job', responses: { 204: { description: 'Deleted' } } },
      },
      '/api/routes/{id}/events': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'Server-Sent Events: status, progress, route, done, error', responses: { 200: { description: 'text/event-stream' } } },
      },
      '/api/routes/{id}/result': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'Route as GeoJSON FeatureCollection (LineString + one Point per waypoint)', responses: { 200: { description: 'OK' }, 409: { description: 'Not finished' } } },
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
        post: { summary: 'Save the route to /signalk/v2/api/resources/routes', responses: { 200: { description: 'Published' }, 502: { description: 'Resources API error' } } },
      },
    },
  };
}
