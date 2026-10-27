import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import loginHandler from '../server/control/login.js';
import meHandler from '../server/control/me.js';
import passwordHandler from '../server/control/password.js';
import logoutHandler from '../server/control/logout.js';
import callsHandler from '../server/control/calls.js';
import { ADMIN_ROLES, setFirebaseSessionCookie } from '../server/control/shared.js';
import { hashAdminPassword } from '../server/control/auth.js';

const ADMINS = {
    'fixed-general-manager-uid': { role: 'general_manager' },
    'fixed-business-manager-uid': { role: 'business_development_manager' },
    'fixed-deputy-manager-uid': { role: 'deputy_general_manager' }
};
const PASSWORDS = Object.fromEntries(Object.keys(ADMINS).map(uid => [uid, randomBytes(24).toString('base64url')]));
const firebaseSigningKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

function createIdToken(uid, sessionVersion) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'flow-test-key' });
    const claims = encode({
        aud: 'control-flow-test',
        iss: 'https://securetoken.google.com/control-flow-test',
        sub: uid,
        user_id: uid,
        uid,
        sessionVersion,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        firebase: { sign_in_provider: 'custom' }
    });
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(firebaseSigningKeys.privateKey).toString('base64url')}`;
}

function getHeader(headers, name) {
    const target = name.toLowerCase();
    if (headers instanceof Headers) return headers.get(name);
    return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target)?.[1] || null;
}

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

function makeRequest(method, body, { ip = '198.51.100.19', cookie = '' } = {}) {
    return { method, body, headers: { 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } };
}

function cookieFrom(response) {
    const header = response.headers.get('set-cookie');
    assert.ok(header, 'successful auth should issue a session cookie');
    return header.split(';')[0];
}

async function requestWith(handler, request) {
    const response = makeResponse();
    await handler(request, response);
    return response;
}

test('password-only auth maps all admins, denies bad/unknown users, changes passwords, and revokes sessions', async () => {
    const envKeys = [
        'FIREBASE_PROJECT_ID', 'FIREBASE_WEB_API_KEY', 'FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON',
        'CALL_ADMIN_UIDS_JSON', 'CALL_AUTH_RATE_LIMIT_SECRET', 'CALL_AUTH_SESSION_SECRET', 'VERCEL'
    ];
    const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const previousFetch = globalThis.fetch;
    const serviceKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const records = {};
    const versions = {};
    for (const [uid, entry] of Object.entries(ADMINS)) {
        records[uid] = { passwordHash: await hashAdminPassword(PASSWORDS[uid]), sessionVersion: 1, role: entry.role };
        versions[uid] = 1;
    }
    let rateLimits = {};
    let rateVersion = 1;
    const dbUrl = 'https://control-flow-test-default-rtdb.firebaseio.com';
    process.env.FIREBASE_PROJECT_ID = 'control-flow-test';
    process.env.FIREBASE_WEB_API_KEY = 'flow-test-key';
    process.env.FIREBASE_DATABASE_URL = dbUrl;
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: 'flow-test@example.invalid',
        private_key: serviceKey.export({ type: 'pkcs8', format: 'pem' })
    });
    process.env.CALL_ADMIN_UIDS_JSON = JSON.stringify(ADMINS);
    process.env.CALL_AUTH_RATE_LIMIT_SECRET = 'rate-limit-secret-for-tests-only-0000000000';
    process.env.CALL_AUTH_SESSION_SECRET = 'session-secret-for-tests-only-000000000000';
    delete process.env.VERCEL;

    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('robot/v1/metadata/x509/securetoken')) {
            const pem = firebaseSigningKeys.publicKey.export({ type: 'spki', format: 'pem' });
            return new Response(JSON.stringify({ 'flow-test-key': pem }), {
                status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
            });
        }
        if (url.includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'test-admin-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken')) {
            const custom = JSON.parse(options.body);
            const claims = JSON.parse(Buffer.from(custom.token.split('.')[1], 'base64url').toString('utf8'));
            return new Response(JSON.stringify({
                idToken: createIdToken(claims.uid, claims.claims.sessionVersion),
                refreshToken: randomBytes(32).toString('base64url'),
                expiresIn: '3600'
            }), { status: 200 });
        }
        if (url.startsWith(`${dbUrl}/`)) {
            const parsed = new URL(url);
            const path = decodeURIComponent(parsed.pathname.replace(/^\//, '').replace(/\.json$/, ''));
            if (path === 'controlAuth/loginRateLimits') {
                const currentEtag = `"rate-${rateVersion}"`;
                if (options.method === 'PUT') {
                    if (getHeader(options.headers, 'if-match') !== currentEtag) return new Response(JSON.stringify({ error: 'etag mismatch' }), { status: 412 });
                    rateLimits = JSON.parse(options.body);
                    rateVersion += 1;
                    return new Response(JSON.stringify(rateLimits), { status: 200, headers: { ETag: `"rate-${rateVersion}"` } });
                }
                const headers = getHeader(options.headers, 'x-firebase-etag') ? { ETag: currentEtag } : {};
                return new Response(JSON.stringify(rateLimits), { status: 200, headers });
            }
            if (path === 'controlAuth/admins' && options.method === 'GET') {
                return new Response(JSON.stringify(records), { status: 200 });
            }
            const adminMatch = /^controlAuth\/admins\/([A-Za-z0-9:_-]+)$/.exec(path);
            if (adminMatch) {
                const uid = adminMatch[1];
                const currentEtag = `"admin-${uid}-${versions[uid]}"`;
                if (options.method === 'PUT') {
                    if (getHeader(options.headers, 'if-match') !== currentEtag) return new Response(JSON.stringify({ error: 'etag mismatch' }), { status: 412 });
                    records[uid] = JSON.parse(options.body);
                    versions[uid] += 1;
                    return new Response(JSON.stringify(records[uid]), { status: 200 });
                }
                const headers = getHeader(options.headers, 'x-firebase-etag') ? { ETag: currentEtag } : {};
                return new Response(JSON.stringify(records[uid] || null), { status: 200, headers });
            }
        }
        throw new Error(`Unexpected test request: ${url}`);
    };

    try {
        const expectedPermissions = {
            general_manager: { office: true, meeting: true },
            business_development_manager: { office: true, meeting: true },
            deputy_general_manager: { office: true, meeting: true }
        };
        const cookies = {};
        for (const [uid, entry] of Object.entries(ADMINS)) {
            const login = await requestWith(loginHandler, makeRequest('POST', { password: PASSWORDS[uid] }));
            assert.equal(login.statusCode, 200);
            cookies[uid] = cookieFrom(login);
            const whoAmI = await requestWith(meHandler, makeRequest('GET', null, { cookie: cookies[uid] }));
            assert.equal(whoAmI.statusCode, 200);
            assert.equal(whoAmI.payload.actor.roleId, entry.role);
            assert.equal(whoAmI.payload.actor.roleLabel, ADMIN_ROLES[entry.role].label);
            assert.equal(whoAmI.payload.actor.displayName, ADMIN_ROLES[entry.role].displayName);
            assert.deepEqual(whoAmI.payload.actor.permissions, expectedPermissions[entry.role]);
        }

        const badLogin = await requestWith(loginHandler, makeRequest('POST', { password: randomBytes(24).toString('base64url') }));
        assert.equal(badLogin.statusCode, 401);
        assert.equal(badLogin.payload.error, 'تعذر تسجيل الدخول. تحقق من كلمة المرور أو حاول لاحقًا.');

        const unknownResponse = makeResponse();
        setFirebaseSessionCookie(unknownResponse, makeRequest('GET', null), {
            idToken: createIdToken('unlisted-manager-uid', 1), refreshToken: 'test-refresh'
        });
        const unauthorizedCall = await requestWith(callsHandler, makeRequest('POST', {
            callId: 'unauthorized-call-0001', employeeId: 'ashraf', callType: 'office'
        }, { cookie: cookieFrom(unknownResponse) }));
        assert.equal(unauthorizedCall.statusCode, 403);

        const businessUid = 'fixed-business-manager-uid';
        const newPassword = randomBytes(24).toString('base64url');
        const changed = await requestWith(passwordHandler, makeRequest('POST', {
            currentPassword: PASSWORDS[businessUid], newPassword
        }, { cookie: cookies[businessUid] }));
        assert.equal(changed.statusCode, 200);
        const rotatedCookie = cookieFrom(changed);
        assert.equal(records[businessUid].sessionVersion, 2);
        const formerCookieResult = await requestWith(meHandler, makeRequest('GET', null, { cookie: cookies[businessUid] }));
        assert.equal(formerCookieResult.statusCode, 401);
        const changedPasswordLogin = await requestWith(loginHandler, makeRequest('POST', { password: newPassword }));
        assert.equal(changedPasswordLogin.statusCode, 200);
        const changedPasswordCookie = cookieFrom(changedPasswordLogin);
        const afterChange = await requestWith(meHandler, makeRequest('GET', null, { cookie: changedPasswordCookie }));
        assert.equal(afterChange.payload.actor.roleId, 'business_development_manager');

        const signedOut = await requestWith(logoutHandler, makeRequest('POST', null, { cookie: rotatedCookie }));
        assert.equal(signedOut.statusCode, 200);
        assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
        assert.equal(records[businessUid].sessionVersion, 3);
        const afterLogout = await requestWith(meHandler, makeRequest('GET', null, { cookie: changedPasswordCookie }));
        assert.equal(afterLogout.statusCode, 401);

        const lockoutIp = '203.0.113.70';
        for (let attempt = 0; attempt < 5; attempt++) {
            const failed = await requestWith(loginHandler, makeRequest('POST', { password: randomBytes(24).toString('base64url') }, { ip: lockoutIp }));
            assert.equal(failed.statusCode, 401);
        }
        const blocked = await requestWith(loginHandler, makeRequest('POST', { password: randomBytes(24).toString('base64url') }, { ip: lockoutIp }));
        assert.equal(blocked.statusCode, 429);
        assert.equal(blocked.headers.get('retry-after') !== undefined, true);
    } finally {
        globalThis.fetch = previousFetch;
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
