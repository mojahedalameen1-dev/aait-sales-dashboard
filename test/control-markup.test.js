import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const controlHtml = await readFile(new URL('../control/index.html', import.meta.url), 'utf8');
const controlScript = await readFile(new URL('../control/main.js', import.meta.url), 'utf8');

test('signed-in control card shows only the authenticated admin name', () => {
    assert.match(controlHtml, /<span class="signed-in-name" id="role-label"><\/span>/);
    assert.doesNotMatch(controlHtml, /الدور المصرّح|الدور الممنوح/);
});

test('password-only forms provide a hidden, non-interactive username autocomplete hint', () => {
    for (const [id, passwordCount] of [['login-form', 1], ['change-password-form', 3]]) {
        const form = new RegExp(`<form\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/form>`).exec(controlHtml)?.[1];
        assert.ok(form, `${id} exists`);
        const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => match[0]);
        const username = inputs.find(input => /autocomplete="username"/.test(input));
        assert.ok(username, `${id} has a username autocomplete hint`);
        assert.match(username, /type="text"/);
        assert.match(username, /\bhidden\b/);
        assert.match(username, /\breadonly\b/);
        assert.match(username, /tabindex="-1"/);
        assert.doesNotMatch(username, /\brequired\b|\bvalue="[^"]+"/);
        const visibleInputs = inputs.filter(input => !/\bhidden\b/.test(input));
        assert.equal(visibleInputs.length, passwordCount);
        assert.ok(visibleInputs.every(input => /type="password"/.test(input)));
    }
});

test('control uses the existing SVG favicon and legacy favicon requests redirect to the same asset', async () => {
    assert.match(controlHtml, /<link\b[^>]*rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="\/logo\.svg"/);
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(config.redirects.find(rule => rule.source === '/favicon.ico'), {
        source: '/favicon.ico', destination: '/logo.svg', permanent: true
    });
    assert.ok(config.rewrites.some(rule => rule.source === '/api/control/:path*' && rule.destination === '/api/control?path=:path*'));
    const policy = config.headers.flatMap(rule => rule.headers).find(header => header.key === 'Content-Security-Policy')?.value;
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /form-action 'self';/);
});

test('meeting selection uses an accessible responsive grid instead of the old dropdown', () => {
    assert.match(controlHtml, /id="meeting-grid"[^>]*role="radiogroup"/);
    assert.doesNotMatch(controlHtml, /id="meeting-select"|name="meetingId"/);
    assert.match(controlScript, /role', 'radio'/);
    assert.match(controlScript, /ArrowLeft.*ArrowRight.*ArrowUp.*ArrowDown/);
    assert.match(controlScript, /formatControlTime\(meeting\.time\)/);
    assert.match(controlScript, /state !== 'cancelled'/);
});
