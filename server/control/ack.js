import {
    bearerToken,
    firebaseDatabaseRequest,
    firebaseDatabaseReadWithEtag,
    readJsonBody,
    sendError
} from './shared.js';
import { verifyTrustedDisplay } from './display.js';

const ALLOWED_STATUSES = new Set(['displayed', 'audio_started', 'audio_completed', 'audio_failed']);
const STATUS_RANK = { sent: 0, displayed: 1, audio_started: 2, audio_failed: 3, audio_completed: 4 };
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export const createAckHandler = ({
    verify = verifyTrustedDisplay, read = firebaseDatabaseReadWithEtag, write = firebaseDatabaseRequest
} = {}) => async function handler(request, response) {
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
        for (let attempt = 0; attempt < 3; attempt++) {
            const { data: event, etag } = await read(path);
            if (!event || Number(event.expiresAt) <= Date.now()) return response.status(404).json({ error: 'انتهت صلاحية النداء' });
            const current = event.statusVerified === true ? event.status : 'sent';
            if (STATUS_RANK[current] >= STATUS_RANK[status]) {
                return response.status(200).json({ status: current, unchanged: true });
            }
            try {
                await write(path, 'PUT', { ...event, status, statusAt: Date.now(), statusVerified: true }, { 'If-Match': etag });
                return response.status(200).json({ status });
            } catch (error) {
                if (error?.statusCode !== 412) throw error;
            }
        }
        return response.status(409).json({ error: 'حالة النداء قيد التحديث' });
    } catch (error) {
        return sendError(response, error, 'تعذر تحديث حالة النداء');
    }
};

export default createAckHandler();
