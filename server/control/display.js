import { firebaseDatabaseRequest, readJsonBody, requireAdmin, sendError, verifyDisplayToken } from './shared.js';

const DISPLAY_PATH = 'controlAuth/trustedDisplay';

/** An anonymous Firebase identity alone is not proof that the installed display sent an acknowledgement. */
export function createTrustedDisplayVerifier({ verify = verifyDisplayToken, read = firebaseDatabaseRequest } = {}) {
    return async idToken => {
        const claims = await verify(idToken);
        const display = await read(DISPLAY_PATH);
        if (!display?.uid || display.uid !== claims.sub) {
            throw Object.assign(new Error('جهاز العرض غير معتمد لتأكيد النداءات'), { statusCode: 403 });
        }
        return claims;
    };
}

export function createDisplayRegistrationHandler({ authenticate = requireAdmin, verify = verifyDisplayToken, write = firebaseDatabaseRequest } = {}) {
    return async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST');
            return response.status(405).json({ error: 'Method not allowed' });
        }
        try {
            const actor = await authenticate(request, response);
            if (actor.roleId !== 'general_manager') {
                return response.status(403).json({ error: 'اعتماد شاشة العرض متاح للمدير العام فقط' });
            }
            const { displayToken } = await readJsonBody(request);
            if (typeof displayToken !== 'string' || !displayToken || displayToken.length > 5000) {
                return response.status(400).json({ error: 'تعذر تحديد هوية متصفح العرض' });
            }
            const display = await verify(displayToken);
            await write(DISPLAY_PATH, 'PUT', { uid: display.sub, registeredAt: Date.now(), registeredBy: actor.uid });
            return response.status(200).json({ registered: true });
        } catch (error) {
            return sendError(response, error, 'تعذر اعتماد شاشة العرض');
        }
    };
}

export const verifyTrustedDisplay = createTrustedDisplayVerifier();
export default createDisplayRegistrationHandler();
