import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import meetingsApi from './api/meetings.js';
import prayerTimesApi from './api/prayer-times.js';
import controlConfigApi from './server/control/config.js';
import controlMeApi from './server/control/me.js';
import controlMeetingsApi from './server/control/meetings.js';
import controlCallsApi from './server/control/calls.js';
import controlAckApi from './server/control/ack.js';
import controlAudioApi from './server/control/audio.js';
import controlStatusApi from './server/control/status.js';
import controlLoginApi from './server/control/login.js';
import controlPasswordApi from './server/control/password.js';
import controlLogoutApi from './server/control/logout.js';
import prayerAudioApi from './server/control/prayer-audio.js';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const LOCAL_API_HANDLERS = new Map([
  ['/api/meetings', meetingsApi],
  ['/api/prayer-times', prayerTimesApi],
  ['/api/control/config', controlConfigApi],
  ['/api/control/me', controlMeApi],
  ['/api/control/meetings', controlMeetingsApi],
  ['/api/control/calls', controlCallsApi],
  ['/api/control/ack', controlAckApi],
  ['/api/control/audio', controlAudioApi],
  ['/api/control/prayer-audio', prayerAudioApi],
  ['/api/control/status', controlStatusApi],
  ['/api/control/login', controlLoginApi],
  ['/api/control/password', controlPasswordApi],
  ['/api/control/logout', controlLogoutApi]
]);

function localMeetingsApi() {
  return {
    name: 'local-meetings-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/control') request.url = '/control/';
        next();
      });
      for (const [path, handler] of LOCAL_API_HANDLERS) {
        server.middlewares.use(path, async (request, response) => {
        const url = new URL(request.url || '/', 'http://localhost');
        request.query = Object.fromEntries(url.searchParams.entries());
        response.status = code => {
          response.statusCode = code;
          return response;
        };
        response.json = payload => {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify(payload));
          return response;
        };
        response.send = body => {
          response.end(body);
          return response;
        };

        try {
          await handler(request, response);
        } catch (error) {
          server.config.logger.error(`[local-api] ${path}: ${error.message}`);
          if (!response.headersSent) response.status(500).json({ error: 'تعذر تشغيل واجهة البيانات المحلية' });
        }
      });
      }
    }
  };
}

export default defineConfig({
  plugins: [localMeetingsApi()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
  },
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve(projectRoot, 'index.html'),
        control: resolve(projectRoot, 'control/index.html')
      }
    }
  },
});
