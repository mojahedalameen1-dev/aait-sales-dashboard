import ackHandler from '../server/control/ack.js';
import audioHandler from '../server/control/audio.js';
import callsHandler from '../server/control/calls.js';
import configHandler from '../server/control/config.js';
import loginHandler from '../server/control/login.js';
import logoutHandler from '../server/control/logout.js';
import meHandler from '../server/control/me.js';
import meetingsHandler from '../server/control/meetings.js';
import passwordHandler from '../server/control/password.js';
import statusHandler from '../server/control/status.js';
import prayerAudioHandler from '../server/control/prayer-audio.js';

const handlers = new Map([
    ['ack', ackHandler],
    ['audio', audioHandler],
    ['prayer-audio', prayerAudioHandler],
    ['calls', callsHandler],
    ['config', configHandler],
    ['login', loginHandler],
    ['logout', logoutHandler],
    ['me', meHandler],
    ['meetings', meetingsHandler],
    ['password', passwordHandler],
    ['status', statusHandler]
]);

export default async function handler(request, response) {
    const url = new URL(request.url || '/', 'https://vercel.invalid');
    const route = request.query?.path || url.searchParams.get('path') || '';
    const endpoint = Array.isArray(route) ? route[0] : String(route).split('/')[0];
    const selectedHandler = handlers.get(endpoint);

    if (!selectedHandler) return response.status(404).json({ error: 'Not found' });
    return selectedHandler(request, response);
}
