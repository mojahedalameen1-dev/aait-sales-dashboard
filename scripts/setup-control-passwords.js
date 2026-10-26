import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

function loadLocalEnvironment(source) {
    for (const line of source.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match || match[1] in process.env) continue;
        let value = match[2];
        if (value.startsWith('"')) {
            try { value = JSON.parse(value); } catch { throw new Error(`قيمة ${match[1]} ليست بصيغة صالحة في .env.local`); }
        } else if (value.startsWith("'")) {
            value = value.slice(1, value.lastIndexOf("'"));
        } else {
            value = value.replace(/\s+#.*$/, '');
        }
        process.env[match[1]] = String(value);
    }
}

function readHidden(promptText) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        throw new Error('شغّل أمر الإعداد من نافذة طرفية تفاعلية؛ لا تمرّر كلمات المرور كوسائط أو متغيرات أمر.');
    }
    readline.emitKeypressEvents(process.stdin);
    return new Promise((resolvePromise, reject) => {
        let value = '';
        process.stdout.write(promptText);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const finish = result => {
            process.stdin.off('keypress', onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\n');
            resolvePromise(result);
        };
        const onKeypress = (character, key = {}) => {
            if (key.ctrl && key.name === 'c') {
                process.stdin.off('keypress', onKeypress);
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdout.write('\n');
                reject(new Error('أُلغي إعداد كلمات المرور.'));
                return;
            }
            if (key.name === 'return' || key.name === 'enter') return finish(value);
            if (key.name === 'backspace') {
                if (value.length) {
                    value = Array.from(value).slice(0, -1).join('');
                    process.stdout.write('\b \b');
                }
                return;
            }
            if (character && !key.ctrl && !key.meta && !key.sequence?.startsWith('\u001b')) {
                value += character;
                process.stdout.write('*'.repeat(Array.from(character).length));
            }
        };
        process.stdin.on('keypress', onKeypress);
    });
}

try {
    const envSource = await readFile(resolve(process.cwd(), '.env.local'), 'utf8');
    loadLocalEnvironment(envSource);
    const { ADMIN_ROLES, initializeAdminPasswords, validateNewPassword } = await import('../server/control/auth.js');
    const { parseAdminMap } = await import('../server/control/shared.js');
    const adminMap = parseAdminMap();
    if (!adminMap || Object.keys(adminMap).length !== Object.keys(ADMIN_ROLES).length) {
        throw new Error('أكمل CALL_ADMIN_UIDS_JSON في .env.local واربط UID ثابتًا بكل دور.');
    }
    const passwordsByUid = {};
    for (const [uid, entry] of Object.entries(adminMap)) {
        const label = ADMIN_ROLES[entry.role]?.callerName;
        if (!label) throw new Error('تأكد من وجود دور واحد لكل مسؤول في CALL_ADMIN_UIDS_JSON.');
        const first = await readHidden(`كلمة مرور ${label} (لا تقل عن 14 حرفًا): `);
        if (!validateNewPassword(first)) throw new Error('كلمة المرور يجب أن تكون بين 14 و128 حرفًا.');
        const second = await readHidden(`أعد كلمة مرور ${label}: `);
        if (first !== second) throw new Error('كلمتا المرور غير متطابقتين؛ لم تُحفظ أي كلمة مرور.');
        passwordsByUid[uid] = first;
    }
    const result = await initializeAdminPasswords(passwordsByUid);
    process.stdout.write(`تم إعداد ${result.adminCount} كلمات مرور منفصلة. لم تُطبع كلمات المرور أو تجزئاتها.\n`);
} catch (error) {
    process.stderr.write(`${error.message || 'تعذر إعداد كلمات المرور.'}\n`);
    process.exitCode = 1;
}
