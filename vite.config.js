import { defineConfig } from 'vite';
import meetingsApi from './api/meetings.js';

function localMeetingsApi() {
  return {
    name: 'local-meetings-api',
    configureServer(server) {
      server.middlewares.use('/api/meetings', async (request, response) => {
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
          await meetingsApi(request, response);
        } catch (error) {
          server.config.logger.error(`[local-meetings-api] ${error.message}`);
          if (!response.headersSent) response.status(500).json({ error: 'تعذر تشغيل واجهة الاجتماعات المحلية' });
        }
      });
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
