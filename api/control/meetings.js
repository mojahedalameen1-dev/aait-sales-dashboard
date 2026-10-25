import {
    listSelectableMeetings,
    loadFreshMeetings,
    requireAdmin,
    sendError
} from './shared.js';

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        await requireAdmin(request, response);
        const source = await loadFreshMeetings();
        response.setHeader('Cache-Control', 'no-store');
        return response.status(200).json({
            meetings: listSelectableMeetings(source.meetings),
            sheetName: source.sheetName,
            fetchedAt: source.fetchedAt
        });
    } catch (error) {
        return sendError(response, error, 'تعذر قراءة اجتماعات اليوم من المصدر');
    }
}
