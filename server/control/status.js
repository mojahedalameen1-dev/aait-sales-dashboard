import { firebaseDatabaseRequest, requireAdmin, sendError } from './shared.js';

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        await requireAdmin(request, response);
        const id = typeof request.query?.id === 'string' ? request.query.id : '';
        if (!CALL_ID_PATTERN.test(id)) return response.status(400).json({ error: 'معرّف النداء غير صالح' });
        const event = await firebaseDatabaseRequest(`calls/public/${id}`);
        if (!event) return response.status(404).json({ error: 'النداء غير موجود' });
        response.setHeader('Cache-Control', 'no-store');
        return response.status(200).json({ status: event.status || 'sent', statusAt: event.statusAt || null, audioStatus: event.audioStatus });
    } catch (error) {
        return sendError(response, error, 'تعذر قراءة حالة النداء');
    }
}
