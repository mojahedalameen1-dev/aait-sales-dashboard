import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';

test('Cloudflare Worker serves the dashboard and control static assets from the asset binding', async () => {
    const requested = [];
    const env = { ASSETS: { fetch: async input => {
        requested.push(new URL(input.url || input).pathname);
        return new Response('asset');
    } } };

    const dashboard = await worker.fetch(new Request('https://example.test/'), env, {});
    const control = await worker.fetch(new Request('https://example.test/control'), env, {});

    assert.equal(await dashboard.text(), 'asset');
    assert.equal(await control.text(), 'asset');
    assert.deepEqual(requested, ['/', '/control/index.html']);
});

test('Cloudflare Worker routes control APIs through the existing Vercel handler contract', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/control/not-a-route'), {}, {});
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'Not found');
    assert.match(response.headers.get('Content-Security-Policy'), /default-src 'self'/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('Cloudflare Worker returns a JSON 404 for unknown API paths without falling through to the SPA', async () => {
    let assetsRequested = false;
    const response = await worker.fetch(new Request('https://example.test/api/unknown'), {
        ASSETS: { fetch: async () => { assetsRequested = true; return new Response('asset'); } }
    }, {});

    assert.equal(response.status, 404);
    assert.equal(assetsRequested, false);
    assert.equal((await response.json()).error, 'Not found');
});

test('the hosted admin UI redirects to HTTPS and rejects insecure form submissions without forwarding them', async () => {
    const host = 'http://aait-sales.aait-sales.workers.dev';
    const ui = await worker.fetch(new Request(host + '/control/'), {}, {});
    assert.equal(ui.status, 308);
    assert.equal(ui.headers.get('location'), 'https://aait-sales.aait-sales.workers.dev/control/');

    const post = await worker.fetch(new Request(host + '/api/control/login', {
        method: 'POST',
        body: 'not parsed'
    }), {}, {});
    assert.equal(post.status, 403);
});

test('the Worker rejects an oversized login body before calling Firebase', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/control/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'ع'.repeat(7000) })
    }), {}, {});
    assert.equal(response.status, 413);
});
