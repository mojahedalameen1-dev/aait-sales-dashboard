import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function parseEnvironment(source) {
    const values = new Map();
    for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        let value = match[2];
        if (value.startsWith('"')) {
            try { value = JSON.parse(value); } catch { throw new Error(`قيمة ${match[1]} ليست بصيغة صالحة في ملف الإعدادات`); }
        } else if (value.startsWith("'")) {
            if (!value.endsWith("'")) throw new Error('ملف الإعدادات يحتوي قيمة غير مكتملة');
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
        }
        values.set(match[1], String(value));
    }
    return values;
}

export async function loadLocalEnvironment() {
    let source;
    try { source = await readFile(resolve(PROJECT_ROOT, '.env.local'), 'utf8'); }
    catch { return; }
    for (const [name, value] of parseEnvironment(source)) {
        if (!(name in process.env)) process.env[name] = value;
    }
}

/** Mechanical secret-file migration: values are never accepted in arguments or logged. */
export async function importGroqEnvironment(sourcePath) {
    const source = parseEnvironment(await readFile(resolve(sourcePath), 'utf8'));
    const key = source.get('GROQ_API_KEY')?.trim();
    if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key || '')) throw new Error('المصدر لا يحتوي مفتاح Groq صالحًا؛ لم يتغير أي ملف');
    const targetPath = resolve(PROJECT_ROOT, '.env.local');
    const current = await readFile(targetPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const existing = parseEnvironment(current);
    if (existing.get('GROQ_API_KEY')?.trim() && existing.get('GROQ_API_KEY')?.trim() !== key) {
        throw new Error('المشروع يحتوي مفتاحًا آخر؛ لم يتم استبداله');
    }
    const additions = [];
    if (!existing.get('GROQ_API_KEY')?.trim()) additions.push(`GROQ_API_KEY=${key}`);
    if (!existing.has('GROQ_VOICE')) additions.push('GROQ_VOICE=abdullah');
    if (additions.length) await writeFile(targetPath, `${current.replace(/\s*$/, '')}\n${additions.join('\n')}\n`, { mode: 0o600 });
    return { targetPath, configured: true, changed: additions.length > 0 };
}

export function requireProviderConfirmation() {
    if (!process.argv.includes('--confirm-provider-calls')) {
        throw new Error('لم يُرسل أي طلب. أعد التشغيل مع --confirm-provider-calls بعد مراجعة تكلفة Groq.');
    }
}
