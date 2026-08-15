import {
  Registry,
  Histogram,
  Gauge,
  Counter,
  collectDefaultMetrics,
} from 'prom-client';

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

export const registeredUsers = new Gauge({
  name: 'registered_users',
  help: 'Total number of registered user accounts',
  registers: [registry],
});

export const websocketConnections = new Gauge({
  name: 'websocket_connections',
  help: 'Currently connected WebSocket clients',
  labelNames: ['namespace'],
  registers: [registry],
});

export const wordSpawnedTotal = new Counter({
  name: 'acid_rain_word_spawned_total',
  help: 'Total Acid Rain words spawned',
  registers: [registry],
});

export const wordClearedTotal = new Counter({
  name: 'acid_rain_word_cleared_total',
  help: 'Total Acid Rain words cleared by a correct submission',
  registers: [registry],
});

export const wordMissedTotal = new Counter({
  name: 'acid_rain_word_missed_total',
  help: 'Total Acid Rain words that reached the bottom unresolved',
  registers: [registry],
});

export const matchEndedTotal = new Counter({
  name: 'acid_rain_match_ended_total',
  help: 'Total Acid Rain matches ended, by end reason',
  labelNames: ['reason'],
  registers: [registry],
});
