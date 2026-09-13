import { resolveTestEnvironment } from '../support/test-environment.js'

// Do not read any .env or local database credentials. Every exercised DB is a
// Vitest fake; accidental configuration resolves to a non-serving local port.
Object.assign(process.env, resolveTestEnvironment({
  NODE_ENV: 'test', APP_ENV: 'test', DATABASE_URL: 'postgresql://127.0.0.1:1/chevoink_test',
  DIRECT_URL: '', SHADOW_DATABASE_URL: '',
}, {}, 'tests/.env.import-safety-does-not-exist'))
