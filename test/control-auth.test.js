import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify, randomBytes } from 'node:crypto';
import {
    createFirebaseCustomToken,
    getAdminPasswordSetup,
    hashAdminPassword,
    matchAdminPassword,
    rotateAdminRecord,
    validateNewPassword,
    verifyAdminPassword
} from '../server/control/auth.js';
import { ADMIN_ROLES, getAdminActor, isCurrentAdminSession, requireAdmin, setFirebaseSessionCookie } from '../server/control/shared.js';

const ADMIN_MAP = {
    'fixed-general-manager-uid': { role: 'general_manager' },
    'fixed-business-manager-uid': { role: 'business_development_manager' },
    'fixed-deputy-manager-uid': { role: 'deputy_general_manager' }
};
const TEST_PASSWORDS = Object.fromEntries(Object.keys(ADMIN_MAP)
    .map(uid => [uid, randomBytes(24).toString('base64url')]));
const FIREBASE_TOKEN_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });

function makeFirebaseIdToken(uid, sessionVersion, now = Math.floor(Date.now() / 1000)) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key-id' });
    const claims = encode({
        aud: 'control-auth-test',
        iss: 'https://securetoken.google.com/control-auth-test',
        sub: uid,
        user_id: uid,
        uid,
        sessionVersion,
        iat: now,
        exp: now + 3600,
        firebase: { sign_in_provider: 'custom' }
    });
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(FIREBASE_TOKEN_KEY.privateKey).toString('base64url')}`;
}

test('password hashes use unique random salts and verify only the matching password', async () => {
    const password = TEST_PASSWORDS['fixed-general-manager-uid'];
    const first = await hashAdminPassword(password);
    const second = await hashAdminPassword(password);
    assert.notEqual(first, password);
    assert.notEqual(first, second);
    assert.equal(await verifyAdminPassword(password, first), true);
    assert.equal(await verifyAdminPassword(`${password}!`, first), false);
    assert.equal(await verifyAdminPassword(password, 'not-a-password-hash'), false);
});

test('three admins are recognized by three distinct passwords, with the expected role permissions', async () => {
    const records = {};
    for (const [uid, entry] of Object.entries(ADMIN_MAP)) {
        records[uid] = { passwordHash: await hashAdminPassword(TEST_PASSWORDS[uid]), sessionVersion: 1, role: entry.role };
    }
    for (const [uid, entry] of Object.entries(ADMIN_MAP)) {
        const result = await matchAdminPassword(TEST_PASSWORDS[uid], ADMIN_MAP, records);
        assert.deepEqual(result, { uid, roleId: entry.role });
        const actor = getAdminActor({ uid });
        assert.equal(actor, null, 'the production role map must not trust unconfigured UIDs');
    }
    const previous = process.env.CALL_ADMIN_UIDS_JSON;
    process.env.CALL_ADMIN_UIDS_JSON = JSON.stringify(ADMIN_MAP);
    try {
        const expected = [
            ['general_manager', { office: true, meeting: true }],
            ['business_development_manager', { office: true, meeting: true }],
            ['deputy_general_manager', { office: true, meeting: true }]
        ];
        for (const [uid, entry] of Object.entries(ADMIN_MAP)) {
            const actor = getAdminActor({ uid });
            assert.equal(actor.roleId, entry.role);
            assert.deepEqual(actor.permissions, expected.find(([role]) => role === entry.role)[1]);
            assert.equal(actor.roleLabel, ADMIN_ROLES[entry.role].label);
            assert.equal(actor.displayName, ADMIN_ROLES[entry.role].displayName);
        }
    } finally {
        if (previous === undefined) delete process.env.CALL_ADMIN_UIDS_JSON;
        else process.env.CALL_ADMIN_UIDS_JSON = previous;
    }
    assert.equal(await matchAdminPassword(randomBytes(24).toString('base64url'), ADMIN_MAP, records), null);
});

test('bootstrap requires three different strong passwords and exactly one configured account per role', () => {
    assert.equal(validateNewPassword('short'), false);
    assert.equal(validateNewPassword(TEST_PASSWORDS['fixed-general-manager-uid']), true);
    assert.equal(getAdminPasswordSetup(ADMIN_MAP, TEST_PASSWORDS).length, 3);
    assert.equal(getAdminPasswordSetup(ADMIN_MAP, {
        ...TEST_PASSWORDS,
        'fixed-business-manager-uid': TEST_PASSWORDS['fixed-general-manager-uid']
    }), null);
});

test('session version mismatch invalidates an otherwise known admin and preserves role policies', () => {
    assert.equal(isCurrentAdminSession({ sessionVersion: 2 }, { sessionVersion: 2 }), true);
    assert.equal(isCurrentAdminSession({ sessionVersion: 1 }, { sessionVersion: 2 }), false);
    assert.equal(isCurrentAdminSession({ sessionVersion: '2' }, { sessionVersion: 2 }), false);
    const oldSession = { sessionVersion: 4 };
    const changedPassword = rotateAdminRecord({ passwordHash: 'old', sessionVersion: 4 }, { passwordHash: 'new' });
    const loggedOut = rotateAdminRecord({ sessionVersion: changedPassword.sessionVersion });
    assert.equal(changedPassword.sessionVersion, 5);
    assert.equal(isCurrentAdminSession(oldSession, changedPassword), false);
    assert.equal(loggedOut.sessionVersion, 6);
});

test('a signed Firebase session from a UID outside the admin map cannot call admin endpoints', async () => {
    const previous = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        apiKey: process.env.FIREBASE_WEB_API_KEY,
        databaseUrl: process.env.FIREBASE_DATABASE_URL,
        adminMap: process.env.CALL_ADMIN_UIDS_JSON
    };
    const publicKeyPem = FIREBASE_TOKEN_KEY.publicKey.export({ type: 'spki', format: 'pem' });
    process.env.FIREBASE_PROJECT_ID = 'control-auth-test';
    process.env.FIREBASE_WEB_API_KEY = 'test-key';
    process.env.FIREBASE_DATABASE_URL = 'https://control-auth-test-default-rtdb.firebaseio.com';
    process.env.CALL_ADMIN_UIDS_JSON = JSON.stringify(ADMIN_MAP);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ 'test-key-id': publicKeyPem }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
    try {
        const token = makeFirebaseIdToken('unauthorized-user-uid', 1);
        await assert.rejects(
            () => requireAdmin({ headers: { authorization: `Bearer ${token}` } }),
            error => error.statusCode === 403
        );
    } finally {
        globalThis.fetch = previousFetch;
        if (previous.projectId === undefined) delete process.env.FIREBASE_PROJECT_ID;
        else process.env.FIREBASE_PROJECT_ID = previous.projectId;
        if (previous.apiKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
        else process.env.FIREBASE_WEB_API_KEY = previous.apiKey;
        if (previous.databaseUrl === undefined) delete process.env.FIREBASE_DATABASE_URL;
        else process.env.FIREBASE_DATABASE_URL = previous.databaseUrl;
        if (previous.adminMap === undefined) delete process.env.CALL_ADMIN_UIDS_JSON;
        else process.env.CALL_ADMIN_UIDS_JSON = previous.adminMap;
    }
});

test('HttpOnly cookie sessions are verified server-side and rejected after session revocation', async () => {
    const saved = Object.fromEntries(['FIREBASE_PROJECT_ID', 'FIREBASE_WEB_API_KEY', 'FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'CALL_ADMIN_UIDS_JSON', 'CALL_AUTH_SESSION_SECRET']
        .map(key => [key, process.env[key]]));
    const publicKeyPem = FIREBASE_TOKEN_KEY.publicKey.export({ type: 'spki', format: 'pem' });
    const servicePrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    process.env.FIREBASE_PROJECT_ID = 'control-auth-test';
    process.env.FIREBASE_WEB_API_KEY = 'test-key';
    process.env.FIREBASE_DATABASE_URL = 'https://control-auth-test-default-rtdb.firebaseio.com';
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: 'service-account@example.invalid',
        private_key: servicePrivateKey.export({ type: 'pkcs8', format: 'pem' })
    });
    process.env.CALL_ADMIN_UIDS_JSON = JSON.stringify(ADMIN_MAP);
    process.env.CALL_AUTH_SESSION_SECRET = 'session-secret-for-tests-only-0000000000000000';
    let currentVersion = 8;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('robot/v1/metadata/x509/securetoken')) {
            return new Response(JSON.stringify({ 'test-key-id': publicKeyPem }), {
                status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
            });
        }
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'test-admin-access-token', expires_in: 3600 }), { status: 200 });
        }
        if (String(url).startsWith('https://control-auth-test-default-rtdb.firebaseio.com/')) {
            return new Response(JSON.stringify({ sessionVersion: currentVersion, passwordHash: 'test-only' }), { status: 200 });
        }
        throw new Error(`Unexpected test fetch: ${options.method || 'GET'}`);
    };
    try {
        const responseHeaders = new Map();
        const cookieResponse = { setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value) };
        const idToken = makeFirebaseIdToken('fixed-business-manager-uid', 8);
        const request = { headers: { 'x-forwarded-proto': 'https' } };
        setFirebaseSessionCookie(cookieResponse, request, { idToken, refreshToken: 'test-refresh-token' });
        const cookieHeader = responseHeaders.get('set-cookie');
        assert.match(cookieHeader, /HttpOnly/);
        assert.match(cookieHeader, /SameSite=Strict/);
        assert.match(cookieHeader, /Secure/);
        const cookieRequest = { headers: { cookie: cookieHeader.split(';')[0], 'x-forwarded-proto': 'https' } };
        assert.equal((await requireAdmin(cookieRequest, cookieResponse)).roleId, 'business_development_manager');
        currentVersion = 9;
        await assert.rejects(() => requireAdmin(cookieRequest, cookieResponse), error => error.statusCode === 401);
    } finally {
        globalThis.fetch = previousFetch;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('Firebase custom token binds the fixed UID and current session version with a verifiable signature', () => {
    const previousKey = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: 'service-account@example.invalid',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
    });
    try {
        const token = createFirebaseCustomToken('fixed-business-manager-uid', 7, 1_800_000_000);
        const [headerPart, claimsPart, signaturePart] = token.split('.');
        const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${headerPart}.${claimsPart}`);
        verifier.end();
        assert.equal(verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url')), true);
        assert.equal(claims.uid, 'fixed-business-manager-uid');
        assert.equal(claims.claims.sessionVersion, 7);
        assert.equal(claims.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
    } finally {
        if (previousKey === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previousKey;
    }
});
