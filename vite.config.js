import { defineConfig } from 'vite';
import meetingsApi from './api/meetings.js';
import prayerTimesApi from './api/prayer-times.js';

function localMeetingsApi() {
  return {
    name: 'local-meetings-api',
    configureServer(server) {
      for (const [path, handler] of [['/api/meetings', meetingsApi], ['/api/prayer-times', prayerTimesApi]]) {
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
});
