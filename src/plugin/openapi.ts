/** OpenAPI 3.0 description of the plugin API, served at /api/openapi.json and via getOpenApi(). */

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
      sail_thresh_ms: { type: 'number' },
      name: { type: 'string', description: 'Name for the Signal K route resource' },
      stages: { type: 'integer', minimum: 4, maximum: 200 },
      no_forecast: { type: 'boolean', description: 'Route with calm wind' },
      publish: { type: 'boolean', description: 'Override the configured auto-publish to the Resources API' },
      vessel: {
        type: 'object',
        properties: {
          name: { type: 'string' }, draught: { type: 'number' }, air_draft: { type: 'number' }, loa: { type: 'number' },
          beam: { type: 'number' }, motor_speed_ms: { type: 'number' }, under_keel_clearance: { type: 'number' },
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
      '/api/status': { get: { summary: 'Plugin, forecast and queue status', responses: { 200: { description: 'OK' } } } },
      '/api/forecast': {
        get: {
          summary: 'Resident forecast metadata, optionally sampled at a position',
          parameters: [
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'lon', in: 'query', schema: { type: 'number' } },
          ],
          responses: { 200: { description: 'OK' } },
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
