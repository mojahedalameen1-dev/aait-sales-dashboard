import { changeAdminPassword, establishFirebaseSession } from './auth.js';
import { clearFirebaseSessionCookie, readJsonBody, requireAdmin, sendError } from './shared.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const actor = await requireAdmin(request, response);
        const body = await readJsonBody(request);
        const updated = await changeAdminPassword({
            uid: actor.uid,
            currentPassword: body.currentPassword,
            newPassword: body.newPassword
        });
        try {
            await establishFirebaseSession(actor.uid, updated.sessionVersion, request, response);
        } catch {
            clearFirebaseSessionCookie(response, request);
            return response.status(200).json({ changed: true, requiresLogin: true });
        }
        return response.status(200).json({ changed: true });
    } catch (error) {
        return sendError(response, error, 'تعذر تغيير كلمة المرور');
    }
}
