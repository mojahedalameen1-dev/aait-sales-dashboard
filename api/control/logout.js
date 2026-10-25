import { revokeAdminSessions } from './auth.js';
import { clearFirebaseSessionCookie, requireAdmin, sendError } from './shared.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const actor = await requireAdmin(request, response);
        await revokeAdminSessions(actor.uid);
        clearFirebaseSessionCookie(response, request);
        return response.status(200).json({ signedOut: true });
    } catch (error) {
        clearFirebaseSessionCookie(response, request);
        if (error.statusCode === 401) return response.status(200).json({ signedOut: true, alreadyExpired: true });
        return sendError(response, error, 'تعذر إبطال جلسة الدخول');
    }
}
