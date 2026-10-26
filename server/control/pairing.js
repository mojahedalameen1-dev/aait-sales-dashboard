import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    bearerToken,
    configuredDisplayUids,
    firebaseDatabaseReadWithEtag,
    firebaseDatabaseRequest,
    getClientAddressKey,
    isTrustedDisplay,
    readJsonBody,
    requireAdmin,
    sendError,
    verifyFirebaseIdToken
} from './shared.js';

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const PAIRING_RATE_WINDOW_MS = 15 * 60 * 1000;
const PAIRING_RATE_LIMIT = 5;
const CODE_PATTERN = /^\d{8}$/;

function sessionSecret() {
    const secret = process.env.CALL_AUTH_SESSION_SECRET?.trim() || '';
    if (secret.length < 32) throw Object.assign(new Error('إعداد جلسة الدخول غير مكتمل'), { statusCode: 503 });
    return secret;
}

function makePairingCode(uid, salt) {
    const digest = createHmac('sha256', sessionSecret()).update(`${uid}:${salt}`).digest();
    const number = digest.readUInt32BE(0) % 100_000_000;
    return String(number).padStart(8, '0');
}

function digestCode(code, salt) {
    return createHash('sha256').update(`${salt}:${code}`).digest();
}

function matchesCode(code, record) {
    if (!record?.uid || typeof record.salt !== 'string' || typeof record.codeHash !== 'string') return false;
    const expected = Buffer.from(record.codeHash, 'base64url');
    const actual = digestCode(code, record.salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function issuePairingRequest(request, response) {
    const claims = await verifyFirebaseIdToken(bearerToken(request), { allowAnonymous: true });
    const uid = claims.sub;
    if (isTrustedDisplay(claims)) return response.status(200).json({ paired: true });
    const pairedRecord = await firebaseDatabaseRequest(`controlAuth/displays/${uid}`);
    if (pairedRecord && !pairedRecord.revokedAt && Number.isFinite(Number(pairedRecord.pairedAt))) {
        return response.status(200).json({ paired: true });
    }
    const existing = await firebaseDatabaseRequest(`controlAuth/pairingRequests/${uid}`);
    const now = Date.now();
    if (existing && Number(existing.expiresAt) > now && typeof existing.salt === 'string') {
        return response.status(200).json({
            paired: false,
            pairingCode: makePairingCode(uid, existing.salt),
            expiresAt: existing.expiresAt
        });
    }

    const salt = randomBytes(18).toString('base64url');
    const pairingCode = makePairingCode(uid, salt);
    await firebaseDatabaseRequest(`controlAuth/pairingRequests/${uid}`, 'PUT', {
        uid,
        salt,
        codeHash: digestCode(pairingCode, salt).toString('base64url'),
        createdAt: now,
        expiresAt: now + PAIRING_LIFETIME_MS,
        deviceLabel: 'شاشة الاجتماعات'
    });
    response.setHeader('Cache-Control', 'no-store');
    return response.status(201).json({ paired: false, pairingCode, expiresAt: now + PAIRING_LIFETIME_MS });
}

async function readPairingStatus(request, response) {
    const claims = await verifyFirebaseIdToken(bearerToken(request), { allowAnonymous: true });
    const staticallyPaired = isTrustedDisplay(claims);
    const record = staticallyPaired ? true : await firebaseDatabaseRequest(`controlAuth/displays/${claims.sub}`);
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).json({ paired: staticallyPaired || Boolean(record && !record.revokedAt) });
}

async function consumeApprovalAttempt(addressKey) {
    const path = 'controlAuth/pairingRateLimits';
    const now = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await firebaseDatabaseReadWithEtag(path);
        const records = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
        const active = Object.fromEntries(Object.entries(records).filter(([, value]) =>
            Number(value?.windowStartedAt) + PAIRING_RATE_WINDOW_MS > now && Number.isFinite(Number(value?.attempts))));
        const record = active[addressKey];
        const activeWindow = Number(record?.windowStartedAt) + PAIRING_RATE_WINDOW_MS > now;
        const windowStartedAt = activeWindow ? Number(record.windowStartedAt) : now;
        const attempts = activeWindow ? Number(record?.attempts || 0) : 0;
        if (attempts >= PAIRING_RATE_LIMIT) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + PAIRING_RATE_WINDOW_MS - now) / 1000)) };
        }
        active[addressKey] = { windowStartedAt, attempts: attempts + 1 };
        if (Object.keys(active).length > 5000) throw Object.assign(new Error('حماية محاولات الاقتران مشغولة حاليًا'), { statusCode: 503 });
        try {
            await firebaseDatabaseRequest(path, 'PUT', active, { 'if-match': current.etag });
            return { allowed: true };
        } catch (error) { if (error.statusCode !== 412) throw error; }
    }
    throw Object.assign(new Error('تعذر التحقق من محاولات الاقتران'), { statusCode: 503 });
}

async function approveDisplay(request, response, code, actor) {
    const attempt = await consumeApprovalAttempt(getClientAddressKey(request));
    if (!attempt.allowed) {
        response.setHeader('Retry-After', String(attempt.retryAfterSeconds));
        return response.status(429).json({ error: 'تجاوزت عدد محاولات الاقتران المسموح؛ حاول بعد قليل.' });
    }
    const now = Date.now();
    const current = await firebaseDatabaseReadWithEtag('controlAuth/pairingRequests');
    const requests = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
    let matchedUid = '';
    for (const [uid, item] of Object.entries(requests)) {
        const valid = Number(item?.expiresAt) > now && matchesCode(code, item);
        if (valid) matchedUid = uid;
    }
    if (!matchedUid) return response.status(404).json({ error: 'الرمز غير صحيح أو انتهت صلاحيته.' });

    const remaining = Object.fromEntries(Object.entries(requests).filter(([uid, item]) =>
        uid !== matchedUid && Number(item?.expiresAt) > now));
    try {
        await firebaseDatabaseRequest('controlAuth/pairingRequests', 'PUT', remaining, { 'if-match': current.etag });
    } catch (error) {
        if (error.statusCode === 412) return response.status(409).json({ error: 'تغيرت طلبات الاقتران؛ حدّث الصفحة وحاول مجددًا.' });
        throw error;
    }
    await firebaseDatabaseRequest(`controlAuth/displays/${matchedUid}`, 'PUT', {
        pairedAt: now,
        pairedBy: actor.uid,
        deviceLabel: 'شاشة الاجتماعات'
    });
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).json({ paired: true, displaySuffix: matchedUid.slice(-4) });
}

async function listDisplays(response, actor) {
    const records = await firebaseDatabaseRequest('controlAuth/displays');
    const pairedDisplays = Object.entries(records || {})
        .filter(([, value]) => value && !value.revokedAt && Number.isFinite(Number(value.pairedAt)))
        .map(([uid, value]) => ({ suffix: uid.slice(-4), pairedAt: value.pairedAt, pairedBy: value.pairedBy === actor.uid }));
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).json({ displays: pairedDisplays, count: pairedDisplays.length + configuredDisplayUids().length });
}

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    try {
        const url = new URL(request.url || '/', 'https://aait.invalid');
        if (request.method === 'GET' && url.searchParams.get('mode') === 'status') return await readPairingStatus(request, response);
        if (request.method === 'GET') {
            const actor = await requireAdmin(request, response);
            return await listDisplays(response, actor);
        }
        if (request.method === 'POST') {
            const body = await readJsonBody(request);
            if (body.action === 'request') return await issuePairingRequest(request, response);
            if (body.action === 'approve') {
                const actor = await requireAdmin(request, response);
                const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
                if (!CODE_PATTERN.test(code)) return response.status(400).json({ error: 'أدخل رمز اقتران من 8 أرقام.' });
                return await approveDisplay(request, response, code, actor);
            }
        }
        response.setHeader('Allow', 'GET, POST');
        return response.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
        return sendError(response, error, 'تعذر إكمال اقتران شاشة العرض');
    }
}
