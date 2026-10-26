import {
    bearerToken,
    firebaseDatabaseRequest,
    readJsonBody,
    sendError,
    verifyTrustedDisplayToken
} from './shared.js';

const ALLOWED_STATUSES = new Set(['displayed', 'audio_started', 'audio_failed']);
const TERMINAL_STATUSES = new Set(['audio_started', 'audio_failed']);
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export const createAckHandler = ({ verify = verifyTrustedDisplayToken } = {}) => async function handler(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        await verify(bearerToken(request));
        const { eventId, status } = await readJsonBody(request);
        if (!CALL_ID_PATTERN.test(eventId || '') || !ALLOWED_STATUSES.has(status)) {
            return response.status(400).json({ error: 'بيانات تأكيد العرض غير صالحة' });
        }
        const path = `calls/public/${eventId}`;
        const event = await firebaseDatabaseRequest(path);
        if (!event || Number(event.expiresAt) <= Date.now()) return response.status(404).json({ error: 'انتهت صلاحية النداء' });
        const current = event.status || 'sent';
        if (TERMINAL_STATUSES.has(current) || (status === 'displayed' && current !== 'sent')) {
            return response.status(200).json({ status: current, unchanged: true });
        }
        await firebaseDatabaseRequest(path, 'PATCH', { status, statusAt: Date.now() });
        return response.status(200).json({ status });
    } catch (error) {
        return sendError(response, error, 'تعذر تحديث حالة النداء');
    }
};

export default createAckHandler();
