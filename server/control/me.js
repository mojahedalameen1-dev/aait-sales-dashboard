import { requireAdmin, sendError } from './shared.js';

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const actor = await requireAdmin(request, response);
        return response.status(200).json({ actor });
    } catch (error) {
        return sendError(response, error, 'تعذر التحقق من صلاحية الحساب');
    }
}
