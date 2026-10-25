import test from 'node:test';
import assert from 'node:assert/strict';
import controlHandler from '../api/control.js';

function makeResponse() {
    return {
        statusCode: 200,
        headers: new Map(),
        payload: null,
        setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; }
    };
}

test('control router dispatches existing endpoint paths through the shared function', async () => {
    const response = makeResponse();
    await controlHandler({ method: 'GET', query: { path: 'ack' } }, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.deepEqual(response.payload, { error: 'Method not allowed' });
});

test('control router rejects unknown endpoint paths', async () => {
    const response = makeResponse();
    await controlHandler({ method: 'GET', url: '/api/control?path=unknown' }, response);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.payload, { error: 'Not found' });
});
