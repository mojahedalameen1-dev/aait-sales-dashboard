import {
    authenticateAdminPassword,
    establishFirebaseSession
} from './auth.js';
import {
    clearLoginAttempts,
    consumeLoginAttempt,
    getClientAddressKey,
    readJsonBody,
    sendError
} from './shared.js';

const GENERIC_LOGIN_ERROR = 'تعذر تسجيل الدخول. تحقق من كلمة المرور أو حاول لاحقًا.';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const { password } = await readJsonBody(request);
        const addressKey = getClientAddressKey(request);
        const limit = await consumeLoginAttempt(addressKey);
        if (!limit.allowed) {
            response.setHeader('Retry-After', String(limit.retryAfterSeconds));
            return response.status(429).json({ error: 'تجاوزت عدد المحاولات المسموح؛ حاول بعد قليل.' });
        }
        if (typeof password !== 'string' || password.length > 256) {
            return response.status(401).json({ error: GENERIC_LOGIN_ERROR });
        }
        const account = await authenticateAdminPassword(password);
        if (!account) return response.status(401).json({ error: GENERIC_LOGIN_ERROR });
        try { await clearLoginAttempts(addressKey); } catch { /* successful login remains valid if limiter cleanup fails */ }
        await establishFirebaseSession(account.uid, account.sessionVersion, request, response);
        return response.status(200).json({ signedIn: true });
    } catch (error) {
        return sendError(response, error, GENERIC_LOGIN_ERROR);
    }
}
