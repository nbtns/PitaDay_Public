// 設定の形を示すサンプル。実際のconfig.jsはnpm startで.envから生成します。
// 管理者用秘密鍵・OAuth client_secret等をブラウザ用ファイルへ含めないでください。
export const demoMode = true;
export const isDev = true;
export const enablePush = false;
export const firebaseConfig = {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
};
export const vapidKey = '';
