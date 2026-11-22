import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAckHandler } from '../server/control/ack.js';
import { createDisplayRegistrationHandler, createTrustedDisplayVerifier } from '../server/control/display.js';
import { cleanupExpiredCalls } from '../server/control/retention.js';
import { getEngineerAudioPrefix } from '../src/config.js';
import { withMeetingsEdgeCache } from '../cloudflare/meetings-cache.js';

function responseFixture() {
    return { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('a valid guest cannot acknowledge until enrolled by the general manager; the previous display loses access', async () => {
    let registered = { uid: 'original-display' };
    let eventReads = 0;
    const read = async () => registered;
    const verify = async () => ({ sub: 'candidate-display' });
    const ack = createAckHandler({ verify: createTrustedDisplayVerifier({ verify, read }),
        read: async () => { eventReads++; return { data: { status: 'sent', expiresAt: Date.now() + 30000 }, etag: 'one' }; },
        write: async (_, __, payload) => assert.equal(payload.statusVerified, true)
    });
    const ackRequest = { method: 'POST', headers: {}, body: { eventId: 'known-request-id-123', status: 'audio_completed' } };
    assert.equal((await ack(ackRequest, responseFixture())).code, 403);
    assert.equal(eventReads, 0);
    const authRequest = { method: 'POST', body: { displayToken: 'sample-token' } };
    const write = async (path, method, payload) => {
        assert.equal(path, 'controlAuth/trustedDisplay');
        assert.equal(method, 'PUT');
        registered = payload;
    };
    const registerDeputy = createDisplayRegistrationHandler({ authenticate: async () => ({ roleId: 'deputy_general_manager' }), verify, write });
    assert.equal((await registerDeputy(authRequest, responseFixture())).code, 403);
    assert.equal(registered.uid, 'original-display');
    const register = createDisplayRegistrationHandler({ authenticate: async () => ({ uid: 'admin-one', roleId: 'general_manager' }), verify, write });
    assert.equal((await register(authRequest, responseFixture())).code, 200);
    assert.equal(registered.uid, 'candidate-display');
    assert.equal((await ack(ackRequest, responseFixture())).code, 200);
    const confirmOld = createTrustedDisplayVerifier({ verify: async () => ({ sub: 'original-display' }), read });
    await assert.rejects(confirmOld('unused'), error => error.statusCode === 403);
});

test('a legacy unverified completed status cannot suppress the first trusted receipt', async () => {
    const ack = createAckHandler({
        verify: async () => ({ sub: 'current-display' }),
        read: async () => ({ data: { status: 'audio_completed', expiresAt: Date.now() + 30000 }, etag: 'one' }),
        write: async (_, __, body) => assert.deepEqual([body.status, body.statusVerified], ['displayed', true])
    });
    const result = await ack({ method: 'POST', headers: {}, body: { eventId: 'known-request-id-123', status: 'displayed' } }, responseFixture());
    assert.equal(result.body.status, 'displayed');
});

test('scheduled cleanup only deletes expired call records and never whole subtrees or active events', async () => {
    const patches = [];
    const request = async (path, method, body) => {
        if (method === 'PATCH') { patches.push({ path, body }); return; }
        return { 'expired-call-123456': { expiresAt: 9999 }, 'active-call-1234567': { expiresAt: 10001 },
            'no-expiry-call-1234': {}, bad: { expiresAt: 9999 } };
    };
    assert.equal(await cleanupExpiredCalls({ request, now: () => 10000 }), 2);
    assert.deepEqual(patches, [{ path: 'calls', body: {
        'public/expired-call-123456': null, 'audioRequests/expired-call-123456': null
    } }]);
});

test('the edge cache falls back for one source and month only after an upstream gateway failure', async () => {
    const store = new Map();
    const cache = { match: async key => store.get(key.url)?.clone(), put: async (key, value) => { store.set(key.url, value.clone()); } };
    const url = new URL('https://test.invalid/api/meetings');
    const now = Date.parse('2026-11-22T09:00:00Z');
    const data = { csvText: 'synthetic rows', fetchedAt: new Date(now - 1000).toISOString(), sheetName: 'نوفمبر 2026' };
    const base = { url, cache, sourceKey: 'source-a', sheetName: data.sheetName, now: () => now };
    await withMeetingsEdgeCache({ ...base, fetchFresh: async () => Response.json(data) });
    const healthy = await withMeetingsEdgeCache({ ...base, fetchFresh: () => assert.fail('fresh response must be cached') });
    assert.equal(healthy.headers.get('X-Edge-Cache'), 'HIT');
    for (const key of store.keys()) if (key.includes('/fresh?')) store.delete(key);
    const failed = () => new Response(null, { status: 502 });
    const restored = await withMeetingsEdgeCache({ ...base, fetchFresh: failed });
    assert.equal(restored.status, 200);
    assert.equal(restored.headers.get('X-Meetings-Data-Stale'), 'true');
    assert.equal((await restored.json()).fetchedAt, data.fetchedAt);
    assert.equal((await withMeetingsEdgeCache({ ...base, sourceKey: 'source-b', fetchFresh: failed })).status, 502);
    assert.equal((await withMeetingsEdgeCache({ ...base, sheetName: 'ديسمبر 2026', fetchFresh: failed })).status, 502);
    assert.equal((await withMeetingsEdgeCache({ ...base, fetchFresh: () => new Response(null, { status: 404 }) })).status, 404);
    assert.equal((await withMeetingsEdgeCache({ ...base, now: () => now + 86400000, fetchFresh: failed })).status, 502);
});

test('Arabic marks do not disable the correct meeting clip; muted engineers remain muted', () => {
    assert.equal(getEngineerAudioPrefix('م. مُجَاهِد'), 'm');
    assert.equal(getEngineerAudioPrefix('أَشْرَف'), 'a');
    assert.equal(getEngineerAudioPrefix('شَادِي'), 's');
    assert.equal(getEngineerAudioPrefix('حُسَام'), null);
});

test('sound setup exposes an accessible progress message and a separate code-free display approval', async () => {
    const markup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(markup, /id="test-sound-status" role="status" aria-live="polite"/);
    assert.match(markup, /id="authorize-display-btn"/);
    assert.doesNotMatch(markup, /id="sound-toggle-btn"/);
});
