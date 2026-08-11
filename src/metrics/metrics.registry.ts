import { Registry, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  registers: [registry],
});

export const activeGames = new Gauge({
  name: 'active_games',
  help: 'Currently in-progress Acid Rain matches',
  registers: [registry],
});

export const websocketConnections = new Gauge({
  name: 'websocket_connections',
  help: 'Currently connected WebSocket clients',
  labelNames: ['namespace'],
  registers: [registry],
});
