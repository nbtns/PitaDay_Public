import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { projectRoot } from '../scripts/prepare-config.mjs';

function demoContext(saved = {}) {
    const storage = new Map(Object.entries(saved));
    const elements = new Map();
    const timers = [];
    const element = () => ({
        style: {}, classList: { add() {}, remove() {}, contains() { return true; }, toggle() {} },
        addEventListener() {}, appendChild() {}, setAttribute() {}, querySelector() { return null; },
        innerHTML: '', textContent: '', hidden: true, value: '', checked: false
    });
    const document = {
        addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; },
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, body: element(), documentElement: element()
    };
    const localStorage = {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
    };
    const context = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {} }, document, localStorage,
        sessionStorage: localStorage, URLSearchParams, URL, Date,
        window: { addEventListener() {}, auth: null, db: null, history: { replaceState() {} }, location: { search: '', pathname: '/', origin: 'http://localhost:4173' } },
        location: { search: '', pathname: '/', origin: 'http://localhost:4173' },
        navigator: {}, confirm: () => true,
        setTimeout(fn, delay) { timers.push(delay); return 0; }, setInterval() { return 0; }, clearTimeout() {}, clearInterval() {}
    });
    const content = fs.readFileSync(path.join(projectRoot, 'public/app.js'), 'utf8').replace(/^import .*;\n/gm, '');
    vm.runInContext('const demoMode = true; const isDev = true; const vapidKey = "";\n' + content, context);
    vm.runInContext(`
        showToast = () => {};
        renderCompletionStatus = () => {};
        renderCalendar = () => {};
        closeCalSettingsModal = () => {};
        showCalendarList = () => {};
        globalThis.demo = { loadData, initUser, initPublicDemo, createCalendarObj, saveCalendarToFirestore,
            saveScheduleFieldToFirestore, saveLocal, deleteCalendar, markComplete, checkInviteURL,
            setupFirestoreListeners, state, user: () => MY_USER };
    `, context);
    return { demo: context.demo, storage, timers, context };
}

test('Firebase設定なしでサンプルを表示でき、接続の再試行を行わない', async () => {
    const { demo, timers } = demoContext();
    demo.loadData(); demo.initUser(); demo.initPublicDemo();
    demo.setupFirestoreListeners(); await demo.checkInviteURL();
    assert.equal(Object.keys(demo.state.calendars).length, 1);
    assert.equal(demo.state.calendars.public_demo_calendar.members.length, 3);
    assert(!timers.includes(500));
});

test('新規カレンダーと日付のNG設定が再読み込み後も残る', async () => {
    const first = demoContext();
    first.demo.loadData(); first.demo.initUser(); first.demo.initPublicDemo();
    const calendar = first.demo.createCalendarObj('検証カレンダー', 'full', '', '', '09:00', '22:00');
    first.demo.state.calendars[calendar.id] = calendar;
    await first.demo.saveCalendarToFirestore(calendar, true);
    calendar.schedules['2026-10-05'] = { [first.demo.user().id]: { isAllDay: true, times: [] } };
    await first.demo.saveScheduleFieldToFirestore(calendar, '2026-10-05');
    const second = demoContext(Object.fromEntries(first.storage));
    second.demo.loadData(); second.demo.initUser(); second.demo.initPublicDemo();
    assert.equal(second.demo.state.calendars[calendar.id].name, '検証カレンダー');
    assert.equal(second.demo.state.calendars[calendar.id].schedules['2026-10-05'][second.demo.user().id].isAllDay, true);
});

test('登録完了の切り替えとデモカレンダーの削除をFirebaseなしで行える', async () => {
    const { demo, storage } = demoContext();
    demo.loadData(); demo.initUser(); demo.initPublicDemo();
    const id = 'public_demo_calendar';
    await demo.markComplete(id);
    const month = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
    assert.equal(demo.state.calendars[id].completed[demo.user().id][month], true);
    await demo.markComplete(id);
    assert.equal(demo.state.calendars[id].completed[demo.user().id][month], false);
    demo.state.activeCal = id;
    await demo.deleteCalendar();
    assert.equal(Object.keys(JSON.parse(storage.get('ssPublicCalendars'))).length, 0);
    const second = demoContext(Object.fromEntries(storage));
    second.demo.loadData(); second.demo.initUser(); second.demo.initPublicDemo();
    assert.equal(Object.keys(second.demo.state.calendars).length, 0);
});

test('初期設定はFirebase接続と通知を無効にし、ブラウザへ管理者資格情報を渡さない', () => {
    const example = fs.readFileSync(path.join(projectRoot, 'public/config.example.js'), 'utf8');
    assert(example.includes('demoMode = true'));
    assert(example.includes('enablePush = false'));
    const html = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
    assert(html.includes('if (!demoMode) {'));
    assert(!html.includes('pagead2.googlesyndication.com'));
    assert.equal((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length, 'モーダルのタグの対応');
    const server = fs.readFileSync(path.join(projectRoot, 'scripts/serve.mjs'), 'utf8');
    assert(server.includes("path.join(projectRoot, 'public')"));
});
