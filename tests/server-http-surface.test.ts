import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Integration tests for the production HTTP surface. These spawn the real server process
 * (the same entrypoint Render runs) rather than importing it, because server.ts starts
 * listening at module load. No mocks: these assert the actual wire behaviour.
 *
 * NODE_ENV=production makes the server serve from dist/, so the SPA fallback needs a real
 * build. Build it here if absent rather than depending on the caller having run `npm run
 * build` first, which otherwise fails only in CI and only on the fallback assertion.
 */

const PORT = 13399;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

let server: ChildProcess;

function ensureBuilt() {
  if (fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
}

async function waitForReady(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not become ready in time');
}

beforeAll(async () => {
  ensureBuilt();
  server = spawn('npx', ['tsx', 'server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  await waitForReady();
}, 120_000);

afterAll(async () => {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1_500));
  if (!server.killed) server.kill('SIGKILL');
});

describe('production HTTP surface', () => {
  it('returns a JSON 404 for an unknown API route instead of the SPA shell', async () => {
    const res = await fetch(`${BASE}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('still serves the SPA shell for client-side routes', async () => {
    const res = await fetch(`${BASE}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root">');
  });

  it('sends the hardening headers on document responses', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The client legitimately loads crest images and Google Fonts; both must be allowed.
    expect(csp).toContain('https://crests.football-data.org');
    expect(csp).toContain('https://fonts.gstatic.com');
  });

  it('answers /api/status without contacting the upstream provider', async () => {
    const res = await fetch(`${BASE}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('configured');
  });
});
