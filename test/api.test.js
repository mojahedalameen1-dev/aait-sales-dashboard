import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSheets, fetchWithRetry, normalizeArabic } from '../api/meetings.js';

test('published sheet index parser discovers tab names and gids', () => {
    const html = 'items.push({name: "يوليو 2026", pageUrl: "x&gid=1", gid: "1446268678"});' +
        'items.push({name: "اغسطس 2026", pageUrl: "x&gid=2", gid: "474705831"});';
    assert.deepEqual(extractSheets(html), [
        { name: 'يوليو 2026', gid: '1446268678' },
        { name: 'اغسطس 2026', gid: '474705831' }
    ]);
});

test('Arabic tab name matching tolerates hamza variants', () => {
    assert.equal(normalizeArabic('أغسطس 2026'), normalizeArabic('اغسطس 2026'));
});

test('upstream fetch retries a transient server failure', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return calls === 1
            ? new Response('', { status: 502 })
            : new Response('ok', { status: 200 });
    };

    try {
        const response = await fetchWithRetry('https://example.test', {
            attempts: 2,
            timeoutMs: 100,
            retryDelayMs: 0
        });
        assert.equal(await response.text(), 'ok');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('upstream fetch retries a transient Google Sheets 400 response', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return calls === 1
            ? new Response('', { status: 400 })
            : new Response('csv', { status: 200 });
    };

    try {
        const response = await fetchWithRetry('https://example.test', {
            attempts: 2,
            timeoutMs: 100,
            retryDelayMs: 0
        });
        assert.equal(await response.text(), 'csv');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('upstream fetch does not retry a permanent client error', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return new Response('', { status: 404 });
    };

    try {
        await assert.rejects(
            fetchWithRetry('https://example.test', {
                attempts: 2,
                timeoutMs: 100,
                retryDelayMs: 0
            }),
            /returned 404/
        );
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
