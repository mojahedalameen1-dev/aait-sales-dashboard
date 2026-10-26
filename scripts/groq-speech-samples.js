/** Isolated localhost QA: exactly one possible Groq request; no Firebase calls or announcements. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONTROL_EMPLOYEES, ADMIN_ROLES } from '../server/control/shared.js';
import { makeCallText } from '../server/control/calls.js';
import { getSpeechSettings, isValidWav, prepareSpeechRequest, synthesizeGroqSpeech } from '../server/control/audio-cache.js';
import { loadLocalEnvironment, PROJECT_ROOT, requireProviderConfirmation } from './audio-env.js';

function wavStats(bytes) {
    let format; let samples;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4);
        if (name === 'fmt ') format = { encoding: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10), sampleRate: bytes.readUInt32LE(offset + 12), bitsPerSample: bytes.readUInt16LE(offset + 22) };
        if (name === 'data') samples = bytes.subarray(offset + 8, offset + 8 + size);
        offset += 8 + size + size % 2;
    }
    const seconds = samples.length / (format.sampleRate * format.channels * format.bitsPerSample / 8);
    const pauses = []; let clipped = 0; let silentAt = null;
    if (format.encoding === 1 && format.bitsPerSample === 16) {
        const frame = Math.max(1, Math.round(format.sampleRate * format.channels * 0.02));
        for (let start = 0; start < samples.length / 2; start += frame) {
            let power = 0; let count = 0;
            for (let index = start; index < Math.min(samples.length / 2, start + frame); index++) {
                const value = samples.readInt16LE(index * 2) / 32768; power += value * value; count++; if (Math.abs(value) >= 0.999) clipped++;
            }
            const at = start / (format.sampleRate * format.channels);
            if (Math.sqrt(power / Math.max(1, count)) < 0.008) silentAt ??= at;
            else if (silentAt !== null) { if (at - silentAt >= 0.12) pauses.push({ start: Number(silentAt.toFixed(2)), seconds: Number((at - silentAt).toFixed(2)) }); silentAt = null; }
        }
    }
    return { ...format, seconds: Number(seconds.toFixed(2)), clippedSamples: clipped, detectedPauses: pauses };
}

try {
    requireProviderConfirmation();
    await loadLocalEnvironment();
    if (!process.env.GROQ_API_KEY?.trim()) throw new Error('مفتاح Groq غير موجود في ملف المشروع؛ لم يُرسل أي طلب.');
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const token = randomBytes(24).toString('hex');
    const settings = getSpeechSettings({ GROQ_VOICE: 'fahad', GROQ_SPEECH_CONFIG_VERSION: `qa-${Date.now()}` });
    const text = makeCallText(CONTROL_EMPLOYEES[0], 'office', ADMIN_ROLES.general_manager.callerName);
    const descriptor = prepareSpeechRequest(text, settings);
    const outputDir = join(PROJECT_ROOT, '.audio-test', runId);
    await mkdir(outputDir, { recursive: true });
    let providerCalls = 0; let audio = null; let metrics = null; let providerError = null;
    const clientConfig = JSON.stringify({ token, cacheKey: descriptor.cacheKey, text, voice: settings.voice });
    const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار Groq والكاش المعزول</title>
<style>body{font-family:system-ui;background:#09131a;color:#edf8fc;max-width:920px;margin:40px auto;padding:24px}pre{direction:ltr;text-align:left;white-space:pre-wrap;background:#13232e;padding:20px;border-radius:12px}audio{width:100%}</style>
<h1>عينة واحدة معزولة بصوت فهد</h1><p>لا توجد نداءات إلى شاشة الاجتماعات، ولا تشغيل تلقائي للصوت.</p><p id="phrase"></p><pre id="result">جاري اختبار التوليد والتخزين…</pre><audio id="sample" controls></audio>
<script type="module">
import { createIndexedDbAudioStore, createAnnouncementAudioCache, requestPersistentAudioStorage } from '/cache.js';
const config = ${clientConfig}; document.querySelector('#phrase').textContent = config.text;
try {
 const store = createIndexedDbAudioStore(); const cache = createAnnouncementAudioCache({ store });
 const loadGenerated = async () => { const response = await fetch('/sample?token=' + config.token, {method:'POST'}); if (!response.ok) throw new Error('Groq request failed: ' + response.status); return response.blob(); };
 const first = await cache.getOrCreate({cacheKey:config.cacheKey,callType:'meeting',loadGenerated});
 await store.close();
 const reopenedStore = createIndexedDbAudioStore(); const reopened = createAnnouncementAudioCache({store:reopenedStore});
 const second = await reopened.getOrCreate({cacheKey:config.cacheKey,callType:'meeting',loadGenerated});
 const equal = await first.blob.arrayBuffer().then(async a => { const b = await second.blob.arrayBuffer(); return a.byteLength === b.byteLength && new Uint8Array(a).every((v,i)=>v===new Uint8Array(b)[i]); });
 const persistence = await requestPersistentAudioStorage();
 const server = await fetch('/stats?token=' + config.token).then(r=>r.json());
 const report = {pass:server.providerCalls===1 && second.cache==='hit' && second.persisted && equal, first:{cache:first.cache,source:first.source,persisted:first.persisted}, second:{cache:second.cache,source:second.source,persisted:second.persisted}, identicalBytes:equal,persistence,providerCalls:server.providerCalls,secondInstanceStats:reopened.getStats(),audio:server.metrics};
 document.querySelector('#result').textContent = JSON.stringify(report,null,2); document.body.dataset.state = report.pass?'passed':'failed';
 document.querySelector('#sample').src=URL.createObjectURL(second.blob);
 await fetch('/report?token='+config.token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
 await reopenedStore.close();
} catch(error) { document.querySelector('#result').textContent=error.message; document.body.dataset.state='failed'; }
</script></html>`;
    const server = createServer(async (request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
        const json = (status, value) => { response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); };
        try {
            if (url.pathname === '/' && request.method === 'GET') { response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return response.end(html); }
            if (url.pathname === '/cache.js' && request.method === 'GET') { response.writeHead(200, {'Content-Type':'text/javascript'}); return response.end(await readFile(join(PROJECT_ROOT,'src','announcement-audio-cache.js'))); }
            if (url.searchParams.get('token') !== token) return json(403,{error:'Forbidden'});
            if (url.pathname === '/sample' && request.method === 'POST') {
                if (providerCalls) return json(409,{error:'The single provider attempt has already been used'});
                providerCalls++; const startedAt = performance.now();
                try { audio = await synthesizeGroqSpeech(descriptor.text, settings, { onRawAudio: bytes => writeFile(join(outputDir, 'provider-response.raw.wav'), bytes, { flag: 'wx' }) }); }
                catch(error) { providerError={code:error.code||'unavailable',status:error.providerStatus||null}; console.log(JSON.stringify({providerCalls,providerError})); return json(502,{error:'Groq sample unavailable',...providerError}); }
                if (!isValidWav(audio)) throw new Error('Invalid WAV');
                metrics = {bytes:audio.length,responseMs:Math.round(performance.now()-startedAt),characters:Array.from(text).length,...wavStats(audio)};
                const samplePath=join(outputDir,'mojahed-fahad.wav'); await writeFile(samplePath,audio,{flag:'wx'});
                console.log(JSON.stringify({providerCalls,samplePath,metrics}));
                response.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length}); return response.end(audio);
            }
            if (url.pathname === '/stats' && request.method === 'GET') return json(200,{providerCalls,metrics,providerError});
            if (url.pathname === '/report' && request.method === 'POST') {
                let body=''; for await (const chunk of request) { body+=chunk; if (body.length>20000) return json(413,{error:'Too large'}); }
                const report=JSON.parse(body); await writeFile(join(outputDir,'cache-report.json'),JSON.stringify(report,null,2));
                console.log(JSON.stringify({browserCachePass:report.pass,providerCalls,second:report.second,persistence:report.persistence})); return json(200,{saved:true});
            }
            return json(404,{error:'Not found'});
        } catch { if (!response.headersSent) json(500,{error:'Isolated sample test failed'}); else response.end(); }
    });
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({testUrl:`http://127.0.0.1:${server.address().port}/`,outputDir,maxProviderCalls:1,voice:'fahad'})));
    process.on('SIGINT',()=>server.close(()=>process.exit(0)));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
} catch (error) { console.error(error.message || 'Isolated speech test failed.'); process.exitCode=1; }
