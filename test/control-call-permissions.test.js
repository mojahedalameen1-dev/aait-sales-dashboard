import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import callsHandler from '../server/control/calls.js';
import { setFirebaseSessionCookie, ADMIN_ROLES } from '../server/control/shared.js';
import { getCurrentSheetName } from '../api/meetings.js';
import { formatTodayDate, getCurrentTimeParts, mapRowsToMeetings } from '../src/data.js';

const uid = 'test-general-manager-uid';
const adminMap = {
    [uid]: { role: 'general_manager' },
    'test-business-manager-uid': { role: 'business_development_manager' },
    'test-deputy-manager-uid': { role: 'deputy_general_manager' }
};

function createIdToken(privateKey, sessionVersion = 1) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'call-permission-test-key' });
    const now = Math.floor(Date.now() / 1000);
    const claims = encode({
        aud: 'control-call-permission-test',
        iss: 'https://securetoken.google.com/control-call-permission-test',
        sub: uid, user_id: uid, uid, sessionVersion, iat: now, exp: now + 3600,
        firebase: { sign_in_provider: 'custom' }
    });
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

function createCsv({ via = 'عن بعد', status = 'قائم', owner = 'م. مجاهد' } = {}) {
    const { hours, minutes } = getCurrentTimeParts();
    const start = Math.min(23 * 60 + 59, hours * 60 + minutes + 15);
    const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    return {
        time,
        csv: `التاريخ,المشروع,الفريق,,الوقت,النوع,الحالة,التذكرة,الاجتماع,حالة العميل\n${formatTodayDate()},اجتماع تسليم المنصة AA81747,${owner},,${time},${via},${status},,https://meet.google.com/abc-defg-hij,مؤكد`
    };
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

test('general manager can send a meeting call server-side with source owner and caller in private speech only', async () => {
    const savedKeys = [
        'FIREBASE_PROJECT_ID', 'FIREBASE_WEB_API_KEY', 'FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON',
        'CALL_ADMIN_UIDS_JSON', 'CALL_AUTH_SESSION_SECRET', 'FIREBASE_DATA_NAMESPACE', 'VERCEL_ENV',
        'GOOGLE_SHEETS_PUBLISH_KEY', 'GROQ_API_KEY'
    ];
    const savedEnv = Object.fromEntries(savedKeys.map(key => [key, process.env[key]]));
    const priorFetch = globalThis.fetch;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const dbUrl = 'https://control-call-permission-test-default-rtdb.firebaseio.com';
    const privateAudioRequests = {};
    const publicCalls = {};
    const recentCallGuards = {};
    const recentCallGuardVersions = new Map();
    let sheetCsv = createCsv();

    process.env.FIREBASE_PROJECT_ID = 'control-call-permission-test';
    process.env.FIREBASE_WEB_API_KEY = 'test-web-key';
    process.env.FIREBASE_DATABASE_URL = dbUrl;
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: 'call-test@example.invalid',
        private_key: serviceKey.export({ type: 'pkcs8', format: 'pem' })
    });
    process.env.CALL_ADMIN_UIDS_JSON = JSON.stringify(adminMap);
    process.env.CALL_AUTH_SESSION_SECRET = 'test-only-call-session-secret-0123456789';
    delete process.env.FIREBASE_DATA_NAMESPACE;
    delete process.env.VERCEL_ENV;
    delete process.env.GOOGLE_SHEETS_PUBLISH_KEY;
    delete process.env.GROQ_API_KEY;

    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('robot/v1/metadata/x509/securetoken')) {
            return new Response(JSON.stringify({ 'call-permission-test-key': publicPem }), {
                status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
            });
        }
        if (url.includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'test-service-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('docs.google.com/spreadsheets') && url.endsWith('/pubhtml')) {
            return new Response(`<script>items.push({name:"${getCurrentSheetName()}", gid:"123"});</script>`, { status: 200 });
        }
        if (url.includes('docs.google.com/spreadsheets') && url.includes('output=csv')) {
            return new Response(sheetCsv.csv, { status: 200 });
        }
        if (url.startsWith(`${dbUrl}/`)) {
            const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, '').replace(/\.json$/, ''));
            if (path === `controlAuth/admins/${uid}`) return new Response(JSON.stringify({ role: 'general_manager', sessionVersion: 1 }), { status: 200 });
            if (path === 'calls/public') return new Response(JSON.stringify(publicCalls), { status: 200 });
            if (path === 'calls/audioRequests') return new Response(JSON.stringify(privateAudioRequests), { status: 200 });
            if (path.startsWith('calls/recentCallGuards/')) {
                const tag = `"${recentCallGuardVersions.get(path) || 0}"`;
                const id = path.split('/').at(-1);
                if (!options.method || options.method === 'GET') {
                    return new Response(JSON.stringify(recentCallGuards[id] || null), { status: 200, headers: { ETag: tag } });
                }
                const expectedTag = new Headers(options.headers).get('if-match');
                if (expectedTag !== tag) return new Response('precondition failed', { status: 412 });
                if (options.method === 'PUT') recentCallGuards[id] = JSON.parse(options.body);
                else if (options.method === 'DELETE') delete recentCallGuards[id];
                recentCallGuardVersions.set(path, (recentCallGuardVersions.get(path) || 0) + 1);
                return new Response(JSON.stringify(recentCallGuards[id] || null), { status: 200 });
            }
            if (path.startsWith('calls/public/')) {
                const id = path.split('/').at(-1);
                if (options.method === 'PUT') {
                    publicCalls[id] = JSON.parse(options.body);
                    return new Response(JSON.stringify(publicCalls[id]), { status: 200 });
                }
                return new Response(JSON.stringify(publicCalls[id] || null), { status: 200 });
            }
            if (path.startsWith('calls/audioRequests/')) {
                const id = path.split('/').at(-1);
                if (options.method === 'PUT') {
                    privateAudioRequests[id] = JSON.parse(options.body);
                    return new Response(JSON.stringify(privateAudioRequests[id]), { status: 200 });
                }
                return new Response(JSON.stringify(privateAudioRequests[id] || null), { status: 200 });
            }
            return new Response('null', { status: 200 });
        }
        throw new Error(`Unexpected network call during isolated test: ${url}`);
    };

    try {
        const sessionResponse = makeResponse();
        const requestMeta = { headers: { 'x-forwarded-proto': 'https' } };
        setFirebaseSessionCookie(sessionResponse, requestMeta, {
            idToken: createIdToken(privateKey), refreshToken: 'test-refresh-token'
        });
        const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
        const sourceMeeting = mapRowsToMeetings([['date', 'project', 'owner', '', 'time', 'via', 'status', 'ticket', 'meet', 'client'], [
            formatTodayDate(), 'اجتماع تسليم المنصة AA81747', 'م. مجاهد', '', sheetCsv.time, 'عن بعد', 'قائم', '', 'https://meet.google.com/abc-defg-hij', 'مؤكد'
        ]])[0];
        const response = makeResponse();
        await callsHandler({
            method: 'POST',
            headers: { cookie, 'x-forwarded-proto': 'https' },
            body: { callId: 'general-manager-meeting-0001', employeeId: 'shady', callType: 'meeting', meetingId: sourceMeeting.id, meetingMode: 'online' }
        }, response);

        assert.equal(ADMIN_ROLES.general_manager.meeting, true);
        assert.equal(response.statusCode, 201);
        assert.equal(response.payload.audioStatus, 'pending');
        assert.match(privateAudioRequests['general-manager-meeting-0001'].text, /اجتماع تسليم المنصة/);
        assert.match(privateAudioRequests['general-manager-meeting-0001'].text, /للمهندس مُجاهد/);
        assert.match(privateAudioRequests['general-manager-meeting-0001'].text, /الأستاذ مُحَمَّد الزَّهْرَانِي/);
        assert.doesNotMatch(privateAudioRequests['general-manager-meeting-0001'].text, /https?:\/\/|AA81747/);
        assert.doesNotMatch(JSON.stringify(publicCalls['general-manager-meeting-0001']), /تسليم المنصة|مُحَمَّد الزَّهْرَانِي|https?:\/\//);

        const repeatCallBody = { callId: 'recent-repeat-call-000001', employeeId: 'shady', callType: 'office' };
        const repeatConfirmation = makeResponse();
        await callsHandler({
            method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' }, body: repeatCallBody
        }, repeatConfirmation);
        assert.equal(repeatConfirmation.statusCode, 409);
        assert.equal(repeatConfirmation.payload.code, 'RECENT_DUPLICATE_CALL');
        assert.equal(repeatConfirmation.payload.previousCallType, 'meeting');
        assert.equal(publicCalls[repeatCallBody.callId], undefined);

        const confirmedRepeat = makeResponse();
        await callsHandler({
            method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' },
            body: { ...repeatCallBody, confirmedRecentDuplicate: true }
        }, confirmedRepeat);
        assert.equal(confirmedRepeat.statusCode, 201);
        assert.equal(publicCalls[repeatCallBody.callId].employeeId, 'shady');

        const repeatedAgain = makeResponse();
        await callsHandler({
            method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' },
            body: { callId: 'recent-repeat-call-000002', employeeId: 'shady', callType: 'office' }
        }, repeatedAgain);
        assert.equal(repeatedAgain.statusCode, 409);
        assert.equal(repeatedAgain.payload.code, 'RECENT_DUPLICATE_CALL');
        assert.equal(repeatedAgain.payload.previousCallType, 'office');

        const differentEmployee = makeResponse();
        await callsHandler({
            method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' },
            body: { callId: 'recent-other-employee-0001', employeeId: 'mojahed', callType: 'office' }
        }, differentEmployee);
        assert.equal(differentEmployee.statusCode, 201);

        const concurrentCalls = await Promise.all(['concurrent-repeat-call-0001', 'concurrent-repeat-call-0002'].map(async callId => {
            const concurrentResponse = makeResponse();
            await callsHandler({
                method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' },
                body: { callId, employeeId: 'hossam', callType: 'office' }
            }, concurrentResponse);
            return concurrentResponse;
        }));
        assert.deepEqual(concurrentCalls.map(result => result.statusCode).sort(), [201, 409]);
        assert.equal(concurrentCalls.find(result => result.statusCode === 409).payload.code, 'RECENT_DUPLICATE_CALL');

        const callAgain = async (callId, context = {}) => {
            const failed = makeResponse();
            await callsHandler({
                method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' },
                body: { callId, employeeId: 'shady', callType: 'meeting', meetingId: sourceMeeting.id, ...context }
            }, failed);
            return failed;
        };

        sheetCsv = createCsv({ via: 'حضوري' });
        const missingLocation = await callAgain('general-manager-meeting-0002', { meetingMode: 'in_person' });
        assert.equal(missingLocation.statusCode, 400);
        assert.equal(missingLocation.payload.code, 'MEETING_LOCATION_REQUIRED');

        sheetCsv = createCsv({ via: 'عن بعد', status: 'لم يتم' });
        const cancelled = await callAgain('general-manager-meeting-0003', { meetingMode: 'online' });
        assert.equal(cancelled.statusCode, 409);

        sheetCsv = createCsv({ via: 'عن بعد', status: 'تم' });
        const ended = await callAgain('general-manager-meeting-0004', { meetingMode: 'online' });
        assert.equal(ended.statusCode, 409);
        assert.equal(ended.payload.code, 'ENDED_MEETING_CONFIRMATION_REQUIRED');
    } finally {
        globalThis.fetch = priorFetch;
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
