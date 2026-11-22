import { defineConfig } from 'vite';

export default defineConfig({
    server: { host: '127.0.0.1', port: 5191, strictPort: true, open: false },
    plugins: [{
        name: 'isolated-audio-test',
        configureServer(server) {
            const events = [];
            server.middlewares.use('/__audio-test/events', (request, response) => {
                if (request.method === 'POST') {
                    let body = '';
                    request.on('data', chunk => { if (body.length < 32768) body += chunk; });
                    request.on('end', () => {
                        try { events.push(JSON.parse(body)); if (events.length > 400) events.shift(); } catch {}
                        response.writeHead(204).end();
                    });
                } else {
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify(events));
                }
            });
            // Accidental requests to app APIs can never reach Sheets/Firebase/Groq.
            server.middlewares.use('/api', (_, response) => response.writeHead(404).end());
        }
    }]
});
