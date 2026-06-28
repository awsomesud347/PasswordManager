import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Glasshouse CAPACITY test — run from an in-region EC2 load generator.
// Goal: find ceilings and identify bottlenecks, not maximize a vanity number.
//
//   API_BASE   : origin-direct target, e.g. https://10.0.1.102 (app private IP)
//   VAULT_JWT  : valid bearer token for the loadtest account (read + write tiers)
//
// Run a SINGLE tier at a time via --env TIER so metrics stay clean:
//   k6 run -e TIER=health -e API_BASE="https://10.0.1.102" capacity.js
//   k6 run -e TIER=read   -e API_BASE="..." -e VAULT_JWT="..." capacity.js
//   k6 run -e TIER=write  -e API_BASE="..." -e VAULT_JWT="..." capacity.js
//
// PREREQUISITE: nginx rate limit must be raised (10000 r/s) for the test,
// since the generator is a single IP. REVERT after.
// ---------------------------------------------------------------------------

const API_BASE = __ENV.API_BASE || 'https://10.0.1.102';
const VAULT_JWT = __ENV.VAULT_JWT || '';
const TIER = __ENV.TIER || 'health';

const healthLatency = new Trend('health_latency', true);
const readLatency = new Trend('read_latency', true);
const writeSuccess = new Counter('write_success');
const writeConflict = new Counter('write_conflict_409');
const writeOther = new Counter('write_other');

// Ramping arrival rate: push request RATE up in steps until errors/latency
// climb. This finds the ceiling (unlike fixed VUs, which cap throughput).
function rampingArrival(startRate, steps) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: startRate,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 1000,
    stages: steps,
  };
}

export const options = {
  scenarios: buildScenario(),
  thresholds: {
    // Informational — we WANT to see where these break, not fail the run.
    'http_req_failed': ['rate<1.0'],
  },
};

function buildScenario() {
  if (TIER === 'health') {
    // Push /health from 50 -> 1500 req/s. Bottleneck expected: single Uvicorn worker.
    return {
      health: { exec: 'healthTier', ...rampingArrival(50, [
        { target: 100, duration: '30s' },
        { target: 300, duration: '45s' },
        { target: 600, duration: '45s' },
        { target: 1000, duration: '45s' },
        { target: 1500, duration: '45s' },
        { target: 0, duration: '15s' },
      ]) },
    };
  }
  if (TIER === 'read') {
    // Push vault reads from 25 -> 600 req/s. Bottleneck expected: RDS / pool.
    return {
      read: { exec: 'readTier', ...rampingArrival(25, [
        { target: 50, duration: '30s' },
        { target: 150, duration: '45s' },
        { target: 300, duration: '45s' },
        { target: 450, duration: '45s' },
        { target: 600, duration: '45s' },
        { target: 0, duration: '15s' },
      ]) },
    };
  }
  if (TIER === 'write') {
    // Concurrent writes to ONE account — demonstrates optimistic-lock 409s.
    // NOT a throughput test: successful writes serialize by design.
    return {
      write: {
        exec: 'writeTier',
        executor: 'constant-arrival-rate',
        rate: 50, timeUnit: '1s', duration: '1m',
        preAllocatedVUs: 50, maxVUs: 200,
      },
    };
  }
  return {};
}

export function healthTier() {
  const res = http.get(`${API_BASE}/health`, { tags: { tier: 'health' } });
  healthLatency.add(res.timings.duration);
  check(res, { 'health 200': (r) => r.status === 200 });
}

export function readTier() {
  const res = http.get(`${API_BASE}/vault/`, {
    headers: { Authorization: `Bearer ${VAULT_JWT}` },
    tags: { tier: 'read' },
  });
  readLatency.add(res.timings.duration);
  check(res, { 'read 200': (r) => r.status === 200 });
}

export function writeTier() {
  // Read current version, then write it back. Under concurrency, most VUs
  // read the same version and collide -> 409 (proving compare-and-set).
  const cur = http.get(`${API_BASE}/vault/`, {
    headers: { Authorization: `Bearer ${VAULT_JWT}` },
    tags: { tier: 'write_read' },
  });
  let version = 0;
  try { version = JSON.parse(cur.body).version; } catch (e) { /* ignore */ }

  const payload = JSON.stringify({
    vault_blob: 'loadtest-encrypted-blob-placeholder',
    iv: 'loadtest-iv-placeholder',
    version: version,
  });
  const res = http.put(`${API_BASE}/vault/`, payload, {
    headers: { Authorization: `Bearer ${VAULT_JWT}`, 'Content-Type': 'application/json' },
    tags: { tier: 'write' },
  });
  if (res.status === 200) writeSuccess.add(1);
  else if (res.status === 409) writeConflict.add(1);
  else writeOther.add(1);
  check(res, { 'write 200 or 409': (r) => r.status === 200 || r.status === 409 });
}

// Map the active tier's exec function (ramping-arrival-rate needs `exec`).
export default function () {
  if (TIER === 'health') healthTier();
  else if (TIER === 'read') readTier();
  else if (TIER === 'write') writeTier();
}