import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(import.meta.dirname, '..');

export function prepareConfig() {
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    const mode = process.env.PITADAY_MODE || 'demo';
    if (!['demo', 'firebase'].includes(mode)) throw new Error('PITADAY_MODEはdemoまたはfirebaseを指定してください');
    const demoMode = mode === 'demo';
    const enablePush = !demoMode && process.env.PITADAY_ENABLE_PUSH === 'true';
    const fields = {
        apiKey: 'API_KEY', authDomain: 'AUTH_DOMAIN', projectId: 'PROJECT_ID',
        storageBucket: 'STORAGE_BUCKET', messagingSenderId: 'MESSAGING_SENDER_ID', appId: 'APP_ID'
    };
    const firebaseConfig = Object.fromEntries(Object.entries(fields).map(([key, envName]) =>
        [key, demoMode ? '' : (process.env['PITADAY_FIREBASE_' + envName] || '')]));
    const vapidKey = demoMode ? '' : (process.env.PITADAY_VAPID_KEY || '');
    if (!demoMode && Object.values(firebaseConfig).some(value => !value)) throw new Error('独立したFirebase環境のWeb設定を.envに指定してください');
    if (enablePush && !vapidKey) throw new Error('通知を使う場合はPITADAY_VAPID_KEYが必要です');
    const config = { demoMode, isDev: demoMode, enablePush, firebaseConfig, vapidKey };
    const moduleSource = '// .envから生成。Gitに含めないでください。\n' + Object.entries(config)
        .map(([key, value]) => `export const ${key} = ${JSON.stringify(value, null, 2)};`).join('\n') + '\n';
    fs.writeFileSync(path.join(projectRoot, 'public/config.js'), moduleSource);
    fs.writeFileSync(path.join(projectRoot, 'public/sw-config.js'), '// .envから生成。Gitに含めないでください。\nself.PITADAY_CONFIG = ' + JSON.stringify(config) + ';\n');
    return config;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const config = prepareConfig();
    console.log(config.demoMode ? '公開デモ用の設定を生成しました（Firebase未接続）' : '独立したFirebase環境用の設定を生成しました');
}
