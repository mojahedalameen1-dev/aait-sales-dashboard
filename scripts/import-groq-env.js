import { importGroqEnvironment } from './audio-env.js';

try {
    if (process.argv.length !== 3) throw new Error('مرر مسار ملف الإعدادات المصدر فقط، وليس المفتاح');
    const result = await importGroqEnvironment(process.argv[2]);
    console.log(`Groq environment configured safely in ${result.targetPath}. Secret values were not printed.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
