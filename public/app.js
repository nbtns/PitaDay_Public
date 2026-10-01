/**
 * PitaDay - Multi-Calendar with Invite Links & Date Ranges
 */
import { collection, doc, setDoc, getDoc, onSnapshot, addDoc, updateDoc, deleteDoc, deleteField, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider, deleteUser } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-storage.js";
import { vapidKey, isDev, demoMode } from './config.js';

const APP_VERSION = 'v84.1-public.1';
const MEMBER_NAMES = { 'u_me': 'あなた', 'u2': 'メンバー B', 'u3': 'メンバー C', 'u4': 'メンバー D' };

// ======= Simple Local Auth & Firebase Auth =======
let MY_USER = { id: 'u_me', name: 'あなた' };

/** テストモード判定（開発環境 + ?testMode=true の時のみ有効） */
const IS_TEST_MODE = demoMode || (isDev && new URLSearchParams(window.location.search).has('testMode'));

function initUser() {
    // ※※※ テストモードバイパス（開発環境専用） ※※※
    // isDev===true かつ URLに ?testMode=true がある場合のみ、ログインをスキップしてモックユーザーでアプリを動かす
    if (IS_TEST_MODE) {
        console.log('[TestMode] テストモードで起動（ログインバイパス）');
        MY_USER = { id: 'test_user_dev', name: 'デモユーザー' };
        MEMBER_NAMES['test_user_dev'] = 'デモユーザー';
        localStorage.setItem('ssUserId', 'test_user_dev');
        localStorage.setItem('ssUserName', 'デモユーザー');

        // ログインゲートを非表示
        const loginGate = document.getElementById('loginGate');
        if (loginGate) loginGate.style.display = 'none';

        // マイページのプロフィールをモック設定
        const nameEl = document.getElementById('myName');
        const avatarEl = document.getElementById('myAvatar');
        const subEl = document.getElementById('myProfileSub');
        if (nameEl) nameEl.textContent = 'デモユーザー';
        if (avatarEl) avatarEl.textContent = 'T';
        if (subEl) subEl.textContent = '公開デモ・このブラウザに保存';

        // ログイン/ログアウトボタンの表示調整
        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        if (loginBtn) loginBtn.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.add('hidden');
        document.getElementById('deleteAccountBtn')?.classList.add('hidden');

        return; // Auth Listenerをスキップ
    }

    let uid = localStorage.getItem('ssUserId');
    let uname = localStorage.getItem('ssUserName');

    if (!uid) {
        uid = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        uname = 'ゲスト' + Math.floor(Math.random() * 1000);
        localStorage.setItem('ssUserId', uid);
        localStorage.setItem('ssUserName', uname);
    }

    MY_USER = { id: uid, name: uname };
    MEMBER_NAMES[uid] = uname;

    // Auth Listener
    // index.html で window.auth が定義されるまでポーリングで待機
    let authCheckCount = 0;
    const checkAuthStatus = () => {
        if (window.auth) {
            console.log(`[Auth] window.auth found after ${authCheckCount} checks`);
            onAuthStateChanged(window.auth, async (user) => {
                const loginGate = document.getElementById('loginGate');
                if (user) {
                    // ゲストID→Firebase UID移行チェック
                    const oldGuestId = localStorage.getItem('ssUserId');
                    const newUid = user.uid;
                    const needsMigration = oldGuestId && oldGuestId !== newUid && oldGuestId.startsWith('u_');

                    MY_USER = { id: user.uid, name: user.displayName || 'ユーザー' };
                    MEMBER_NAMES[user.uid] = user.displayName || 'ユーザー';

                    // localStorageから通知を復元（ログアウト→再ログイン時用）
                    try {
                        const savedNotifs = JSON.parse(localStorage.getItem('ssNotifications') || '[]');
                        if (savedNotifs.length > 0 && state.notifications.length === 0) {
                            state.notifications = savedNotifs;
                            renderNotifications();
                        }
                    } catch (e) { /* ignore */ }

                    // ログインゲートを非表示にする
                    if (loginGate) loginGate.style.display = 'none';

                    // チュートリアル未完了なら即座にオーバーレイを表示して操作をブロック
                    if (!localStorage.getItem('tutorialDone') && window.showTutorial) {
                        const overlay = document.getElementById('tutorialOverlay');
                        if (overlay) overlay.classList.add('active');
                    }



                    // ゲスト→Googleアカウント移行処理（fetchJoinedCalsの前に実行必須）
                    if (needsMigration) {
                        console.log(`[Migration] ゲストID ${oldGuestId} → Firebase UID ${newUid} の移行を開始`);
                        try {
                            // localStorageのjoinedCalsからカレンダーIDを取得（state.calendarsはまだ空）
                            const joinedCalIds = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
                            for (const calId of joinedCalIds) {
                                try {
                                    const calRef = doc(window.db, "calendars", calId);
                                    const calSnap = await getDoc(calRef);
                                    if (!calSnap.exists()) continue;
                                    const cal = calSnap.data();
                                    let changed = false;
                                    // members配列
                                    if (cal.members && cal.members.includes(oldGuestId)) {
                                        cal.members = cal.members.map(m => m === oldGuestId ? newUid : m);
                                        changed = true;
                                    }
                                    // memberNames
                                    if (cal.memberNames && cal.memberNames[oldGuestId]) {
                                        cal.memberNames[newUid] = cal.memberNames[oldGuestId];
                                        delete cal.memberNames[oldGuestId];
                                        changed = true;
                                    }
                                    // schedules（全日付）
                                    if (cal.schedules) {
                                        Object.keys(cal.schedules).forEach(ds => {
                                            if (cal.schedules[ds] && cal.schedules[ds][oldGuestId]) {
                                                cal.schedules[ds][newUid] = cal.schedules[ds][oldGuestId];
                                                delete cal.schedules[ds][oldGuestId];
                                                changed = true;
                                            }
                                        });
                                    }
                                    // completed
                                    if (cal.completed && cal.completed[oldGuestId]) {
                                        cal.completed[newUid] = cal.completed[oldGuestId];
                                        delete cal.completed[oldGuestId];
                                        changed = true;
                                    }
                                    // creatorId
                                    if (cal.creatorId === oldGuestId) {
                                        cal.creatorId = newUid;
                                        changed = true;
                                    }
                                    // proposals内の投票とfrom
                                    if (cal.proposals) {
                                        cal.proposals.forEach(p => {
                                            if (p.votes && p.votes[oldGuestId]) {
                                                p.votes[newUid] = p.votes[oldGuestId];
                                                delete p.votes[oldGuestId];
                                                changed = true;
                                            }
                                            if (p.from === oldGuestId) {
                                                p.from = newUid;
                                                changed = true;
                                            }
                                        });
                                    }
                                    if (changed) {
                                        await setDoc(calRef, cal);
                                        console.log(`[Migration] カレンダー ${cal.name || calId} のID移行完了`);
                                    }
                                } catch (calErr) {
                                    console.warn('[Migration] カレンダーの移行スキップ:', calId, calErr);
                                }
                            }
                            // localStorageのIDを新UIDに更新（次回以降移行をスキップ）
                            localStorage.setItem('ssUserId', newUid);
                            localStorage.setItem('ssUserName', user.displayName || 'ユーザー');
                            showToast('アカウントの移行が完了しました ✅');
                            console.log('[Migration] 全カレンダーの移行完了');
                        } catch (e) {
                            console.error('[Migration] 移行エラー:', e);
                        }
                    }

                    const nameEl = document.getElementById('myName');
                    const avatarEl = document.getElementById('myAvatar');
                    const subEl = document.getElementById('myProfileSub');
                    const loginBtn = document.getElementById('loginBtn');
                    const logoutBtn = document.getElementById('logoutBtn');
                    const deleteAccountBtn = document.getElementById('deleteAccountBtn');

                    if (nameEl) nameEl.textContent = user.displayName;
                    if (avatarEl) {
                        const photoURL = user.photoURL || (user.providerData && user.providerData[0] && user.providerData[0].photoURL);
                        if (photoURL) {
                            avatarEl.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
                        } else {
                            avatarEl.textContent = (user.displayName || 'U').charAt(0).toUpperCase();
                        }
                    }
                    if (subEl) subEl.textContent = user.email;
                    if (loginBtn) loginBtn.classList.add('hidden');
                    if (logoutBtn) logoutBtn.classList.remove('hidden');
                    if (deleteAccountBtn) deleteAccountBtn.classList.remove('hidden');

                    // Firestoreからカレンダーリストを取得してからレンダリング
                    await fetchJoinedCalsFromFirestore();
                    renderCalendarList();
                    if (state.activeCal) renderCalendar();

                    // joinedCalsも新UIDで再同期（移行後に必要）
                    if (needsMigration) syncJoinedCalsToFirestore();

                    // FCMプッシュ通知のセットアップ（トークン取得・保存）
                    setupPushNotifications();

                    // フォアグラウンドメッセージング設定
                    setupForegroundMessaging();

                    // Googleカレンダー自動同期（ログイン後に実行）
                    setTimeout(() => _autoSyncGoogleCalendar(), 3000);

                    // バージョン更新チェック（version.jsonと比較）
                    checkVersionFromServer();

                    // 初回ログイン時にチュートリアル用カレンダーを作成してからチュートリアルを表示
                    // オーバーレイは上で既に表示済みなので、ここではカレンダー作成とチュートリアル開始のみ
                    if (!localStorage.getItem('tutorialDone') && window.showTutorial) {
                        setTimeout(async () => {
                            if (Object.keys(state.calendars).length === 0) {
                                try {
                                    const tutCal = createCalendarObj('Tutorial', 'full', '', '', '00:00', '24:00');
                                    state.calendars[tutCal.id] = tutCal;
                                    await saveCalendarToFirestore(tutCal, true);
                                    joinCalendarLocally(tutCal.id);
                                    renderCalendarList();
                                } catch (e) { console.error('Tutorial calendar creation error:', e); }
                            }
                            // カレンダー作成後すぐにチュートリアル開始
                            setTimeout(() => window.showTutorial(), 300);
                        }, 500);
                    }

                } else {
                    // 未ログイン → ログインゲートを表示する
                    if (loginGate) loginGate.style.display = 'flex';

                    let lUid = localStorage.getItem('ssUserId');
                    let lUname = localStorage.getItem('ssUserName');
                    MY_USER = { id: lUid, name: lUname };
                    MEMBER_NAMES[lUid] = lUname;

                    const nameEl = document.getElementById('myName');
                    const avatarEl = document.getElementById('myAvatar');
                    const subEl = document.getElementById('myProfileSub');
                    const loginBtn = document.getElementById('loginBtn');
                    const logoutBtn = document.getElementById('logoutBtn');
                    const deleteAccountBtn = document.getElementById('deleteAccountBtn');

                    if (nameEl) nameEl.textContent = 'ユーザー';
                    if (avatarEl) avatarEl.innerHTML = 'A';
                    if (subEl) subEl.textContent = 'ゲストとして利用中（データはブラウザに保存）';
                    if (loginBtn) loginBtn.classList.remove('hidden');
                    if (logoutBtn) logoutBtn.classList.add('hidden');
                    if (deleteAccountBtn) deleteAccountBtn.classList.add('hidden');

                    renderCalendarList();
                    if (state.activeCal) renderCalendar();
                }
            });
        } else {
            authCheckCount++;
            if (authCheckCount % 20 === 0) {
                console.log(`[Auth] waiting for window.auth... (${authCheckCount} checks)`);
            }
            setTimeout(checkAuthStatus, 100);
        }
    };
    checkAuthStatus();
}

// ログインゲートボタンのクリックハンドラー
// ログインボタンのイベントリスナーはDOMContentLoadedで handleLogin に統一（下部参照）

// ログアウトボタンのリスナーはinitUI内でhandleLogoutに統一（確認ダイアログ付き）

// アカウント削除ボタン
document.getElementById('deleteAccountBtn')?.addEventListener('click', async () => {
    await deleteAccount();
});

/**
 * アカウント削除処理
 * 参加中の全カレンダーからユーザーデータを削除し、
 * Firestoreのユーザードキュメント・Firebase Authアカウント・localStorageを全削除する。
 * ストア審査（Apple/Google）で必須の機能。
 */
async function deleteAccount() {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    if (!window.auth?.currentUser || !window.db) {
        showToast('ログイン状態を確認してください', 'error');
        return;
    }

    // 1段階目: 確認ダイアログ
    if (!confirm('アカウントを完全に削除しますか？\n\nこの操作は取り消せません。\n・あなたが作成したカレンダーは完全に削除されます\n・参加中のカレンダーからあなたのデータが削除されます\n・すべての設定・通知データが消去されます')) {
        return;
    }

    // 2段階目: テキスト入力による確認（誤タップ防止）
    const confirmText = prompt('最終確認: 削除するには「アカウント削除」と入力してください');
    if (confirmText !== 'アカウント削除') {
        if (confirmText !== null) {
            showToast('入力が一致しません。削除を中止しました。', 'error');
        }
        return;
    }

    try {
        showToast('アカウントを削除中...');
        const uid = MY_USER.id;

        // 全参加カレンダーを処理
        for (const [calId, cal] of Object.entries(state.calendars)) {
            try {
                if (cal.creatorId === uid) {
                    // 自分が作成者 → カレンダーごと完全削除
                    await deleteDoc(doc(window.db, 'calendars', calId));
                    console.log(`[DeleteAccount] カレンダー "${cal.name}" を完全削除`);
                } else {
                    // メンバーとして参加 → 自分のデータだけ削除
                    const updates = {};

                    // members配列から自分を除去
                    if (cal.members && cal.members.includes(uid)) {
                        updates.members = cal.members.filter(m => m !== uid);
                    }

                    // memberNamesから自分を削除
                    updates[`memberNames.${uid}`] = deleteField();

                    // schedulesの全日付から自分のデータを削除
                    if (cal.schedules) {
                        Object.keys(cal.schedules).forEach(ds => {
                            if (cal.schedules[ds]?.[uid]) {
                                updates[`schedules.${ds}.${uid}`] = deleteField();
                            }
                        });
                    }

                    // completedから自分を削除
                    if (cal.completed?.[uid]) {
                        updates[`completed.${uid}`] = deleteField();
                    }

                    // proposals内の自分の投票を削除
                    if (cal.proposals && Array.isArray(cal.proposals)) {
                        const updatedProposals = cal.proposals.map(p => {
                            if (p.votes?.[uid]) {
                                const newVotes = { ...p.votes };
                                delete newVotes[uid];
                                return { ...p, votes: newVotes };
                            }
                            return p;
                        });
                        updates.proposals = updatedProposals;
                    }

                    await updateDoc(doc(window.db, 'calendars', calId), updates);
                    console.log(`[DeleteAccount] カレンダー "${cal.name}" から自分のデータを削除`);
                }
            } catch (e) {
                console.error('[DeleteAccount] カレンダーの処理エラー:', calId, e);
            }
        }

        // Firestoreリスナーを全解除
        Object.values(activeCalendarListeners).forEach(unsub => unsub());
        activeCalendarListeners = {};
        if (unsubscribeUserJoinedCals) {
            unsubscribeUserJoinedCals();
            unsubscribeUserJoinedCals = null;
        }

        // usersドキュメントを削除
        try {
            await deleteDoc(doc(window.db, 'users', uid));
            console.log('[DeleteAccount] usersドキュメント削除完了');
        } catch (e) {
            console.error('[DeleteAccount] usersドキュメント削除エラー:', e);
        }

        // Firebase Authユーザーを削除
        try {
            await deleteUser(window.auth.currentUser);
            console.log('[DeleteAccount] Firebase Authユーザー削除完了');
        } catch (e) {
            console.error('[DeleteAccount] Auth削除エラー:', e);
            // auth/requires-recent-login の場合は再ログインが必要
            if (e.code === 'auth/requires-recent-login') {
                showToast('セキュリティのため再ログインが必要です。再ログイン後もう一度お試しください。', 'error');
                await signOut(window.auth);
                Object.keys(localStorage).filter(key => key.startsWith('ss')).forEach(key => localStorage.removeItem(key));
                location.reload();
                return;
            }
        }

        // localStorageを完全クリア
        Object.keys(localStorage).filter(key => key.startsWith('ss')).forEach(key => localStorage.removeItem(key));
        console.log('[DeleteAccount] アカウント削除処理完了');

        // リロードしてログインゲートに戻す
        location.reload();
    } catch (e) {
        console.error('[DeleteAccount] アカウント削除エラー:', e);
        showToast('アカウント削除中にエラーが発生しました', 'error');
    }
}

function getMemberName(uid, calId) {
    // カレンダーのニックネームを優先
    if (calId && state.calendars[calId]?.memberNames?.[uid]) {
        return state.calendars[calId].memberNames[uid];
    }
    // グローバルMEMBER_NAMESをチェック
    if (MEMBER_NAMES[uid] && MEMBER_NAMES[uid] !== uid) {
        return MEMBER_NAMES[uid];
    }
    // 全カレンダーのmemberNamesを横断検索（フォールバック）
    for (const cal of Object.values(state.calendars)) {
        if (cal.memberNames?.[uid]) {
            return cal.memberNames[uid];
        }
    }
    return uid;
}

function setTheme(theme) {
    if (theme === 'light') {
        document.documentElement.classList.add('theme-light');
    } else {
        document.documentElement.classList.remove('theme-light');
    }
    localStorage.setItem('ssTheme', theme);
}

const state = {
    calendars: {},       // { calId: { name, type, rangeStart, rangeEnd, inviteCode, members, schedules, createdAt } }
    notifications: [],
    dismissedNotifIds: new Set(),  // 削除済み通知ID（Firestore同期時スキップ用）
    activeCal: null,     // current open calendar ID
    currentDate: new Date(),
    selectedDate: null,
    batchMode: false,
    batchTime: { start: '', end: '' },
    batchSelectedDates: new Set(),
    activeMode: 'allDay',
    createType: 'full',
    weekStart: localStorage.getItem('ssWeekStart') || 'sun',  // 'sun' or 'mon'
    timeModalMode: 'ng'  // 'ng' または 'ok'（時間モーダルの入力モード）
};

// ============================================================================
// ============================================================================
// Init
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initUser();
    if (demoMode) initPublicDemo();
    initUI();
    renderCalendarList();
    renderNotifications();
    renderMyPage();

    // 週の始まり設定を復元
    const savedWeekStart = localStorage.getItem('ssWeekStart') || 'sun';
    state.weekStart = savedWeekStart;
    const weekStartRadio = document.querySelector(`input[name="weekStart"][value="${savedWeekStart}"]`);
    if (weekStartRadio) weekStartRadio.checked = true;

    // Cookie同意バナー & 広告の初期化
    initCookieConsent();

    // 本番環境ではGoogleカレンダー同期を非表示にする（Google OAuth審査通過まで）
    if (demoMode || !isDev) {
        const gcalSection = document.getElementById('googleCalSyncSection');
        if (gcalSection) gcalSection.style.display = 'none';
    }

    // プッシュ通知タップで通知タブに遷移（URLパラメータ経由）
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tab') === 'notifications') {
        switchTab('tabNotifications');
        // パラメータをURLから消去（残っているとリロード時にも通知タブになるため）
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Service Workerからのメッセージで通知タブに切り替え（アプリが既に開いている場合）
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data?.type === 'OPEN_NOTIFICATIONS_TAB') {
                switchTab('tabNotifications');
            }
        });
    }
});

// ============================================================================
// Firestore Sync Logic
// ============================================================================
function loadData() {
    const ver = localStorage.getItem('ssVer');
    if (ver !== 'v6') {
        Object.keys(localStorage).filter(key => key.startsWith('ss')).forEach(key => localStorage.removeItem(key));
        localStorage.setItem('ssVer', 'v6');
    }

    // Notifications (Local for now, or fetch from Firestore if needed later)
    const n = localStorage.getItem('ssNotifications');
    state.notifications = n ? JSON.parse(n) : [];
    // 削除済み通知IDを復元
    const dismissed = localStorage.getItem('ssDismissedNotifIds');
    state.dismissedNotifIds = dismissed ? new Set(JSON.parse(dismissed)) : new Set();

    if (demoMode) {
        try { state.calendars = JSON.parse(localStorage.getItem('ssPublicCalendars') || '{}'); }
        catch { state.calendars = {}; }
        return;
    }

    // Initialize listeners for calendars
    setupFirestoreListeners();

    // Check for invite URL
    checkInviteURL();
}

async function checkInviteURL() {
    if (demoMode) return;
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');

    if (inviteCode && window.db) {
        // Google認証完了を待つ（MY_USER.idがゲストIDの場合はAuth完了後にリトライ）
        if (MY_USER.id.startsWith('u_') && window.auth) {
            // まだ認証が完了していないので少し待ってリトライ
            setTimeout(checkInviteURL, 500);
            return;
        }
        try {
            // Firestore から該当の招待コードを持つカレンダーを検索
            const { collection, query, where, getDocs } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
            const q = query(collection(window.db, "calendars"), where("inviteCode", "==", inviteCode));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const calDoc = querySnapshot.docs[0];
                const calId = calDoc.id;
                const calData = calDoc.data();

                // Firestoreのメンバー名をローカルにMEMBER_NAMESに即座同期
                if (calData.memberNames) {
                    Object.entries(calData.memberNames).forEach(([uid, name]) => {
                        MEMBER_NAMES[uid] = name;
                    });
                }

                const alreadyMember = calData.members && calData.members.includes(MY_USER.id);

                // 自分がメンバーに含まれていなければ追加（arrayUnionでアトミックに追加）
                let shouldUpdate = false;
                if (!alreadyMember) {
                    // arrayUnionで競合を防ぐ（同時参加でもメンバーが消えない）
                    await updateDoc(doc(window.db, "calendars", calId), {
                        members: arrayUnion(MY_USER.id)
                    });
                    calData.members.push(MY_USER.id);
                    shouldUpdate = true;
                }
                if (!calData.memberNames) calData.memberNames = {};
                if (calData.memberNames[MY_USER.id] !== MY_USER.name) {
                    calData.memberNames[MY_USER.id] = MY_USER.name;
                    shouldUpdate = true;
                }

                // URL参加時のNG引き継ぎ確認
                if (!calData.schedules) calData.schedules = {};
                // 新規参加の場合のみ確認する
                if (!alreadyMember && confirm("他の参加中カレンダーからあなたのNG設定を引き継ぎますか？")) {
                    const aggregated = aggregateAllMyNGs();
                    Object.keys(aggregated).forEach(ds => {
                        if (!calData.schedules[ds]) calData.schedules[ds] = {};
                        calData.schedules[ds][MY_USER.id] = aggregated[ds];
                    });
                    shouldUpdate = true;
                }

                if (shouldUpdate) {
                    // members以外のデータを更新（membersはarrayUnionで曢に更新済み）
                    const { members, ...dataWithoutMembers } = calData;
                    await setDoc(doc(window.db, "calendars", calId), dataWithoutMembers, { merge: true });
                }

                // ローカルの参加リストに追加してリスナーを起動
                joinCalendarLocally(calId);

                // アクティブなカレンダーに設定して表示
                state.activeCal = calId;
                showToast(`「${calData.name}」に参加しました！`);

                // URLからパラメータを消去
                window.history.replaceState({}, document.title, window.location.pathname);

                // 少し待ってからカレンダーを開く
                setTimeout(() => openCalendar(calId), 300);
            } else {
                showToast("無効な招待リンクです");
            }
        } catch (error) {
            console.error("Error fetching invite calendar:", error);
            showToast("カレンダーの取得に失敗しました");
        }
    } else if (inviteCode) {
        // DB未初期化時は少し待ってリトライ
        setTimeout(checkInviteURL, 500);
    }
}

async function joinCalendarByCode() {
    if (demoMode) { document.getElementById('inputCodeError').textContent = '公開デモでは他の人との共有は利用できません'; return; }
    const input = document.getElementById('joinInviteCodeInput').value.trim();
    const err = document.getElementById('inputCodeError');
    err.textContent = "";

    if (!input) {
        err.textContent = "招待コードを入力してください";
        return;
    }

    if (!window.db) {
        err.textContent = "データベースに接続中です。少し待って再試行してください";
        return;
    }

    try {
        const { collection, query, where, getDocs, setDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
        const q = query(collection(window.db, "calendars"), where("inviteCode", "==", input));
        const querySnapshot = await getDocs(q);

        if (!querySnapshot.empty) {
            const calDoc = querySnapshot.docs[0];
            const calId = calDoc.id;
            const calData = calDoc.data();

            // Firestoreのメンバー名をローカルにMEMBER_NAMESに即座同期
            if (calData.memberNames) {
                Object.entries(calData.memberNames).forEach(([uid, name]) => {
                    MEMBER_NAMES[uid] = name;
                });
            }

            const alreadyMember = calData.members && calData.members.includes(MY_USER.id);

            // 自分がメンバーに含まれていなければ追加
            let decreaseIndent = false;
            let shouldUpdate = false;
            if (!alreadyMember) {
                // arrayUnionで競合を防ぐ（同時参加でもメンバーが消えない）
                await updateDoc(doc(window.db, "calendars", calId), {
                    members: arrayUnion(MY_USER.id)
                });
                calData.members.push(MY_USER.id);
                shouldUpdate = true;
            }
            if (!calData.memberNames) calData.memberNames = {};
            if (calData.memberNames[MY_USER.id] !== MY_USER.name) {
                calData.memberNames[MY_USER.id] = MY_USER.name;
                shouldUpdate = true;
            }

            // コード参加時のNG引き継ぎ確認
            if (!calData.schedules) calData.schedules = {};
            const inheritNg = document.getElementById('inheritNgJoin').checked;
            if (!alreadyMember && inheritNg) {
                const aggregated = aggregateAllMyNGs();
                Object.keys(aggregated).forEach(ds => {
                    if (!calData.schedules[ds]) calData.schedules[ds] = {};
                    calData.schedules[ds][MY_USER.id] = aggregated[ds];
                });
                shouldUpdate = true;
            }

            if (shouldUpdate) {
                // members以外のデータを更新（membersはarrayUnionで曢に更新済み）
                const { members, ...dataWithoutMembers } = calData;
                await setDoc(doc(window.db, "calendars", calId), dataWithoutMembers, { merge: true });
            }

            // ローカルの参加リストに追加してリスナーを起動
            joinCalendarLocally(calId);

            // モーダルを閉じて画面遷移
            document.getElementById('inputCodeModal').classList.add('hidden');
            document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');

            showToast(`「${calData.name}」に参加しました！`);
            // リスナー再描画後に確実に遷移するため遅延実行
            setTimeout(() => {
                state.activeCal = calId;
                openCalendar(calId);
            }, 500);
        } else {
            err.textContent = "無効な招待コードです";
        }
    } catch (error) {
        console.error("Error joining calendar by code:", error);
        err.textContent = "カレンダーの取得に失敗しました";
    }
}

function setupFirestoreListeners() {
    if (demoMode) return;
    if (!window.db) {
        setTimeout(setupFirestoreListeners, 500); // 読み込み待ち
        return;
    }

    // Listen to all calendars for now (Since there is no auth yet, we fetch all or based on known IDs)
    // Note: In a real app with auth, you'd only fetch calendars the user is a member of.
    // For this prototype, we'll maintain a local list of "joined" calendar IDs.
    let joinedCals = localStorage.getItem('ssJoinedCals');
    joinedCals = joinedCals ? JSON.parse(joinedCals) : [];

    if (joinedCals.length > 0) {
        joinedCals.forEach(calId => attachCalendarListener(calId));
    }
}

let activeCalendarListeners = {};

function attachCalendarListener(calId) {
    if (!window.db) return;
    if (activeCalendarListeners[calId]) return; // 既にリスナーがある場合は重複作成しない

    const calRef = doc(window.db, "calendars", calId);

    const unsubscribe = onSnapshot(calRef, (docSnap) => {
        if (docSnap.exists()) {
            const calData = docSnap.data();
            state.calendars[calId] = calData;
            renderCalendarList(); // カレンダーデータ到着時にリスト更新

            // MEMBER_NAMES スナップショット同期
            if (calData.memberNames) {
                Object.entries(calData.memberNames).forEach(([uid, name]) => {
                    MEMBER_NAMES[uid] = name;
                });
            }

            // 自分がメンバーなのにmemberNamesに正しい名前がない場合、自動修復
            if (calData.members && calData.members.includes(MY_USER.id) && MY_USER.name) {
                if (!calData.memberNames || calData.memberNames[MY_USER.id] !== MY_USER.name) {
                    const fixedNames = calData.memberNames || {};
                    fixedNames[MY_USER.id] = MY_USER.name;
                    setDoc(calRef, { memberNames: fixedNames }, { merge: true }).catch(e => console.warn('memberNames自動修復失敗:', e));
                }
            }

            // proposals(通知)の同期
            if (calData.proposals && Array.isArray(calData.proposals)) {
                const firestoreProposalIds = new Set(calData.proposals.map(p => String(p.id)));
                calData.proposals.forEach(p => {
                    const idx = state.notifications.findIndex(n => String(n.id) === String(p.id));
                    const nData = { ...p, calId: calId, calName: calData.name };
                    if (state.dismissedNotifIds.has(String(p.id))) return; // 削除済みはスキップ
                    if (idx >= 0) {
                        nData.read = state.notifications[idx].read;
                        state.notifications[idx] = nData;
                    } else {
                        state.notifications.unshift(nData);
                    }
                });
                // Firestoreに存在しない提案の通知を削除（取り消し済み提案のクリーンアップ）
                state.notifications = state.notifications.filter(n => {
                    if (n.calId === calId && n.type !== 'completion' && !firestoreProposalIds.has(String(n.id))) {
                        return false;
                    }
                    return true;
                });
                saveLocal();
                renderNotifications();
            }

            // completionNotifs(全員完了通知)の同期
            if (calData.completionNotifs && Array.isArray(calData.completionNotifs)) {
                calData.completionNotifs.forEach(cn => {
                    const idx = state.notifications.findIndex(n => String(n.id) === String(cn.id));
                    const nData = { ...cn, calId: calId, calName: calData.name };
                    if (state.dismissedNotifIds.has(String(cn.id))) return; // 削除済みはスキップ
                    if (idx >= 0) {
                        nData.read = state.notifications[idx].read;
                        state.notifications[idx] = nData;
                    } else {
                        state.notifications.unshift(nData);
                    }
                });
                saveLocal();
                renderNotifications();
            }

            // 投票詳細モーダルが開いている場合は再描画（実際に表示中の場合のみ）
            const voteModal = document.getElementById('voteDetailModal');
            if (state._openVoteDetailId && voteModal && !voteModal.classList.contains('hidden')) {
                const updatedNotif = state.notifications.find(n => String(n.id) === String(state._openVoteDetailId));
                if (updatedNotif) {
                    showVoteDetailModal(updatedNotif);
                }
            }

            // メンバーリストモーダルが開いている場合は再描画
            const memberModal = document.getElementById('memberListModal');
            if (memberModal && !memberModal.classList.contains('hidden') && state.activeCal === calId) {
                showMemberListModal();
            }
            // キック検出: 自分がmembersに含まれていない場合
            if (calData.members && !calData.members.includes(MY_USER.id)) {
                console.log(`[Kick] カレンダー ${calData.name} からキックされました`);
                delete state.calendars[calId];
                if (activeCalendarListeners[calId]) {
                    activeCalendarListeners[calId]();
                    delete activeCalendarListeners[calId];
                }
                let joinedCals = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
                joinedCals = joinedCals.filter(id => id !== calId);
                localStorage.setItem('ssJoinedCals', JSON.stringify(joinedCals));
                syncJoinedCalsToFirestore();
                // モーダルが開いていたら閉じる
                document.querySelectorAll('.overlay-modal').forEach(m => m.classList.add('hidden'));
                const tabBar = document.querySelector('.tab-bar');
                if (tabBar) tabBar.classList.remove('tab-bar-hidden');
                if (state.activeCal === calId) {
                    state.activeCal = null;
                    showCalendarList();
                    showToast('このカレンダーから退出させられました');
                } else {
                    renderCalendarList();
                }
                renderMyPage();
                return;
            }

            renderCalendarList();
            if (state.activeCal === calId) { renderCalendar(); renderCompletionStatus(); }
            renderMyPage();
        } else {
            // Calendar was deleted or doesn't exist
            delete state.calendars[calId];
            if (activeCalendarListeners[calId]) {
                activeCalendarListeners[calId](); // リスナー解除
                delete activeCalendarListeners[calId];
            }
            let joinedCals = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
            joinedCals = joinedCals.filter(id => id !== calId);
            localStorage.setItem('ssJoinedCals', JSON.stringify(joinedCals));
            syncJoinedCalsToFirestore();

            if (state.activeCal === calId) showCalendarList();
            else renderCalendarList();
        }
    }, (error) => {
        console.error("Error listening to calendar:", error);
        // 権限エラー時はリスナーを削除して再試行可能にする
        if (activeCalendarListeners[calId]) {
            activeCalendarListeners[calId]();
            delete activeCalendarListeners[calId];
        }
    });

    activeCalendarListeners[calId] = unsubscribe;
}

function joinCalendarLocally(calId) {
    let joinedCals = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
    if (!joinedCals.includes(calId)) {
        joinedCals.push(calId);
        localStorage.setItem('ssJoinedCals', JSON.stringify(joinedCals));
        syncJoinedCalsToFirestore();
        attachCalendarListener(calId);
    }
}

async function syncJoinedCalsToFirestore() {
    if (!window.db || !MY_USER || MY_USER.id.startsWith('u_')) return;
    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
        const joinedCals = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
        await setDoc(doc(window.db, "users", MY_USER.id), { joinedCals, updatedAt: new Date().toISOString() }, { merge: true });
    } catch (e) { console.error("Error sync user data", e); }
}

let unsubscribeUserJoinedCals = null;

async function fetchJoinedCalsFromFirestore() {
    if (!window.db || !MY_USER || MY_USER.id.startsWith('u_')) return;
    try {
        // ファイル先頭で import 済みの doc, getDoc, onSnapshot をそのまま使用（動的importを廃止）
        const docRef = doc(window.db, "users", MY_USER.id);

        // 初回は getDoc で即座に取得（onSnapshot より速い）
        try {
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                _processJoinedCalsSnapshot(docSnap);
            } else {
                syncJoinedCalsToFirestore();
            }
        } catch (e) {
            console.log('[fetchJoinedCals] getDoc failed, falling back to onSnapshot:', e);
        }

        // その後 onSnapshot でリアルタイム更新を購読
        if (unsubscribeUserJoinedCals) unsubscribeUserJoinedCals();

        unsubscribeUserJoinedCals = onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                _processJoinedCalsSnapshot(docSnap);
            } else {
                syncJoinedCalsToFirestore();
            }
        });
    } catch (e) { console.error("Error setting up user joinedCals listener", e); }
}

// joinedCals スナップショットの共通処理
function _processJoinedCalsSnapshot(docSnap) {
    const data = docSnap.data();
    if (data.joinedCals && Array.isArray(data.joinedCals)) {

        const remoteJoined = data.joinedCals;

        // localStorageのカレンダーIDとマージ（ローカルにあるがFirestoreにないものを補完）
        const localJoined = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
        const merged = [...new Set([...remoteJoined, ...localJoined])];
        localStorage.setItem('ssJoinedCals', JSON.stringify(merged));

        // Firestoreにマージ結果を同期（ローカルのみにあるIDを追加）
        if (merged.length > remoteJoined.length) {
            syncJoinedCalsToFirestore();
        }

        // 古いカレンダーを除外
        Object.keys(state.calendars).forEach(calId => {
            if (!merged.includes(calId)) {
                delete state.calendars[calId];
            }
        });

        // リスナーをアタッチ
        merged.forEach(calId => attachCalendarListener(calId));

        renderCalendarList();
        renderMyPage();
    }
}

async function saveCalendarToFirestore(cal, isNew) {
    if (demoMode) { saveLocal(); return; }
    if (!window.db) return;
    try {
        if (isNew) {
            // 新規カレンダー作成: 全フィールドを保存（memberNames含む）
            await setDoc(doc(window.db, "calendars", cal.id), cal);
        } else {
            // 既存カレンダーの更新: memberNamesを除外してmerge保存
            const { memberNames, ...calWithoutNames } = cal;
            await setDoc(doc(window.db, "calendars", cal.id), calWithoutNames, { merge: true });
        }
    } catch (e) {
        console.error("Error saving calendar to Firestore: ", e);
        showToast("データ保存エラー");
    }
}

function saveLocal() {
    if (demoMode) localStorage.setItem('ssPublicCalendars', JSON.stringify(state.calendars));
    // 古い localStorage への直接保存は Notifications のみとする
    localStorage.setItem('ssNotifications', JSON.stringify(state.notifications));
    // 削除済みIDも保存
    localStorage.setItem('ssDismissedNotifIds', JSON.stringify([...state.dismissedNotifIds]));
}

function createCalendarObj(name, type, rangeStart, rangeEnd, timeStart, timeEnd) {
    const id = 'cal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const inviteCode = Math.random().toString(36).slice(2, 10).toUpperCase();
    return {
        id, name, type, // 'full' | 'range'
        rangeStart: rangeStart || '',
        rangeEnd: rangeEnd || '',
        timeStart: timeStart || '00:00',
        timeEnd: timeEnd || '24:00',
        inviteCode,
        creatorId: MY_USER.id,
        members: [MY_USER.id],
        memberNames: { [MY_USER.id]: MY_USER.name },
        iconUrl: '',
        schedules: {},
        createdAt: new Date().toISOString()
    };
}

// ============================================================================
// カレンダーアイコン画像のリサイズ＆アップロード
// ============================================================================

/** 画像ファイルをmaxSizepxの正方形にリサイズしてBlobで返す */
function resizeImage(file, maxSize = 128) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                // 正方形にクロップ（中央基準）
                const side = Math.min(img.width, img.height);
                const sx = (img.width - side) / 2;
                const sy = (img.height - side) / 2;
                canvas.width = maxSize;
                canvas.height = maxSize;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas toBlob failed'));
                }, 'image/webp', 0.8);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/** カレンダーアイコンをFirebase Storageにアップロードしてダウンロード URLを返す */
async function uploadCalendarIcon(calId, file) {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    if (!window.firebaseStorage) throw new Error('Firebase Storage未初期化');
    const blob = await resizeImage(file, 128);
    const storageRef = ref(window.firebaseStorage, `calendar-icons/${calId}/icon.webp`);
    await uploadBytes(storageRef, blob, { contentType: 'image/webp' });
    return await getDownloadURL(storageRef);
}

// アイコン選択用の一時変数
let _pendingCreateIconFile = null;
let _pendingEditIconFile = null;

/** アイコン選択ボタンのセットアップ（作成モーダル用と設定モーダル用で共通） */
function _setupIconPicker(pickBtnId, previewId, clearBtnId, mode) {
    const pickBtn = document.getElementById(pickBtnId);
    const clearBtn = document.getElementById(clearBtnId);
    if (!pickBtn) return;

    pickBtn.addEventListener('click', () => {
        // 隠しfile inputを動的に作成してクリック
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            // プレビュー表示
            const reader = new FileReader();
            reader.onload = (e) => {
                const preview = document.getElementById(previewId);
                if (preview) {
                    preview.innerHTML = `<img src="${e.target.result}" alt="preview" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`;
                }
                document.getElementById(clearBtnId)?.classList.remove('hidden');
            };
            reader.readAsDataURL(file);
            // 一時変数にセット
            if (mode === 'create') _pendingCreateIconFile = file;
            else _pendingEditIconFile = file;
        });
        input.click();
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const preview = document.getElementById(previewId);
            if (preview) preview.innerHTML = '<i class="fa-solid fa-camera" style="font-size:1.2rem; opacity:0.5;"></i>';
            clearBtn.classList.add('hidden');
            if (mode === 'create') _pendingCreateIconFile = null;
            else _pendingEditIconFile = false; // falseは「明示的に削除」を意味
        });
    }
}

function save() {
    // 互換性維持: 現在アクティブなカレンダーがある場合はそれをFirestoreに保存する
    if (state.activeCal && state.calendars[state.activeCal]) {
        saveCalendarToFirestore(state.calendars[state.activeCal]);
    }
    saveLocal();
}

// ============================================================================
// UI Init
// ============================================================================
function initUI() {
    // Tabs
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
            // If going back to calendar tab, show list
            if (btn.dataset.tab === 'tabCalendar') {
                showCalendarList();
            }
        });
    });

    // Auth
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    const loginGateBtn = document.getElementById('loginGateBtn');
    if (loginGateBtn) loginGateBtn.addEventListener('click', handleLogin);
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);


    // Create Calendar
    document.getElementById('openCreateModal').addEventListener('click', openCreateModal);
    document.getElementById('closeCreateModal')?.addEventListener('click', closeCreateModal);
    document.getElementById('cancelCreateCal').addEventListener('click', closeCreateModal);
    document.getElementById('confirmCreateCal').addEventListener('click', createCalendar);
    document.getElementById('typeFull').addEventListener('click', () => setCreateType('full'));
    document.getElementById('typeRange').addEventListener('click', () => setCreateType('range'));

    // Invite & Settings
    // Version Label
    const vLabel = document.getElementById('appVersionLabel');
    if (vLabel) vLabel.textContent = APP_VERSION;

    // テーマ設定（初回読み込み時にlocalStorageから復元）
    const savedTheme = localStorage.getItem('ssTheme') || 'dark';
    setTheme(savedTheme);

    document.getElementById('showMemberList').addEventListener('click', showMemberListModal);
    document.getElementById('closeMemberListModal')?.addEventListener('click', () => { document.getElementById('memberListModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });
    document.getElementById('closeMemberListModal2').addEventListener('click', () => { document.getElementById('memberListModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });

    document.getElementById('showInviteLink').addEventListener('click', showInviteModal);
    document.getElementById('closeInviteModal')?.addEventListener('click', () => { document.getElementById('inviteModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });
    document.getElementById('closeInviteModal2').addEventListener('click', () => { document.getElementById('inviteModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });
    document.getElementById('copyInviteLink').addEventListener('click', copyInviteLink);
    document.getElementById('copyInviteCode').addEventListener('click', copyInviteCodeOnly);

    // アイコン選択ボタンのイベントリスナー
    _setupIconPicker('createIconPickBtn', 'createIconPreview', 'createIconClearBtn', 'create');
    _setupIconPicker('editIconPickBtn', 'editIconPreview', 'editIconClearBtn', 'edit');

    // 設定ボタン
    document.getElementById('openSettingsBtn')?.addEventListener('click', () => {
        const settingsModal = document.getElementById('settingsPageModal');
        settingsModal.classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
        // テーマの現在値をselectに反映
        const currentTheme = localStorage.getItem('ssTheme') || 'dark';
        const themeRadio = document.querySelector(`input[name="settingsTheme"][value="${currentTheme}"]`);
        if (themeRadio) themeRadio.checked = true;
        // 通知設定の現在値を反映
        const notifSettings = JSON.parse(localStorage.getItem('ssNotifSettings') || '{}');
        document.getElementById('notifProposal').checked = notifSettings.proposal !== false;
        document.getElementById('notifCompletion').checked = notifSettings.completion !== false;
        document.getElementById('notifConfirmed').checked = notifSettings.confirmed !== false;
        // リマインダーselect
        const reminderSel = document.getElementById('notifReminder');
        if (reminderSel) reminderSel.value = notifSettings.reminder || '2h';
        // バージョン表示
        const vl = document.getElementById('settingsVersionLabel');
        if (vl) vl.textContent = APP_VERSION;
        // アップデート赤バッジ表示
        const redDot = document.getElementById('updateRedDot');
        if (redDot) {
            if (state.swUpdateAvailable) {
                redDot.classList.remove('hidden');
            } else {
                redDot.classList.add('hidden');
            }
        }
        // 週の始まりの現在値を反映
        const weekStartRadio = document.querySelector(`input[name="weekStart"][value="${state.weekStart}"]`);
        if (weekStartRadio) weekStartRadio.checked = true;
        // Googleカレンダー読み込みのトグル状態を復元
        const gcalToggle = document.getElementById('googleCalSyncToggle');
        if (gcalToggle) gcalToggle.checked = localStorage.getItem('gcalSyncEnabled') === 'true';
    });
    // 設定モーダルを閉じる
    document.getElementById('closeSettingsPage')?.addEventListener('click', () => {
        document.getElementById('settingsPageModal').classList.add('hidden');
        // タブメニューを再表示
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });
    // テーマ変更（設定モーダル内 - radio方式）
    document.querySelectorAll('input[name="settingsTheme"]').forEach(r => {
        r.addEventListener('change', (e) => {
            setTheme(e.target.value);
            const mainRadio = document.querySelector(`input[name="appTheme"][value="${e.target.value}"]`);
            if (mainRadio) mainRadio.checked = true;
        });
    });
    // 通知設定トグル（設定モーダル内）
    // トグルをONにしたとき、通知が未許可ならOS標準の許可ダイアログを表示
    ['notifProposal', 'notifCompletion', 'notifConfirmed'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', async (e) => {
            // OFF→ON にしたとき、通知権限をチェック
            if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                try {
                    const permission = await Notification.requestPermission();
                    if (permission === 'granted') {
                        showToast('通知を有効にしました ✅');
                        await _registerFcmToken();
                    } else {
                        // 拒否された → トグルを戻す
                        e.target.checked = false;
                        showToast('通知が許可されていません。端末の設定から通知を許可してください');
                        return;
                    }
                } catch (err) {
                    e.target.checked = false;
                    showToast('通知の設定中にエラーが発生しました');
                    return;
                }
            }
            const settings = {
                proposal: document.getElementById('notifProposal').checked,
                completion: document.getElementById('notifCompletion').checked,
                confirmed: document.getElementById('notifConfirmed').checked,
                reminder: document.getElementById('notifReminder')?.value || '2h'
            };
            localStorage.setItem('ssNotifSettings', JSON.stringify(settings));
            if (window.db && MY_USER && !MY_USER.id.startsWith('u_')) {
                setDoc(doc(window.db, 'users', MY_USER.id), { notifSettings: settings }, { merge: true })
                    .catch(e => console.error('notifSettings save error:', e));
            }
            const isEnabled = e.target.checked;
            showToast(isEnabled ? 'プッシュ通知を有効にしました' : 'プッシュ通知を無効にしました');
        });
    });
    // リマインダーselect
    document.getElementById('notifReminder')?.addEventListener('change', () => {
        const settings = {
            proposal: document.getElementById('notifProposal').checked,
            completion: document.getElementById('notifCompletion').checked,
            confirmed: document.getElementById('notifConfirmed').checked,
            reminder: document.getElementById('notifReminder').value
        };
        localStorage.setItem('ssNotifSettings', JSON.stringify(settings));
        if (window.db && MY_USER && !MY_USER.id.startsWith('u_')) {
            setDoc(doc(window.db, 'users', MY_USER.id), { notifSettings: settings }, { merge: true })
                .catch(e => console.error('notifSettings save error:', e));
        }
        showToast('リマインダー設定を更新しました ✅');
    });
    // バージョン更新通知トグル
    document.getElementById('notifVersion')?.addEventListener('change', () => {
        const settings = JSON.parse(localStorage.getItem('ssNotifSettings') || '{}');
        settings.version = document.getElementById('notifVersion').checked;
        localStorage.setItem('ssNotifSettings', JSON.stringify(settings));
        if (window.db && MY_USER && !MY_USER.id.startsWith('u_')) {
            setDoc(doc(window.db, 'users', MY_USER.id), { notifSettings: settings }, { merge: true })
                .catch(e => console.error('notifSettings save error:', e));
        }
        showToast('バージョン更新通知を' + (settings.version ? 'ON' : 'OFF') + 'にしました ✅');
    });

    // Googleカレンダー読み込みトグル
    document.getElementById('googleCalSyncToggle')?.addEventListener('change', async (e) => {
        if (e.target.checked) {
            // ON → 同期開始（OAuth認証を含む）
            await syncGoogleCalendar(false);
            // 認証が失敗した場合はトグルを戻す
            if (!sessionStorage.getItem('gcalAccessToken')) {
                e.target.checked = false;
                localStorage.removeItem('gcalSyncEnabled');
            }
        } else {
            // OFF → 同期を無効化（既存のNGは残す）
            localStorage.removeItem('gcalSyncEnabled');
            sessionStorage.removeItem('gcalAccessToken');
            const statusEl = document.getElementById('googleCalSyncStatus');
            if (statusEl) statusEl.style.display = 'none';
            showToast('Googleカレンダーの読み込みをOFFにしました');
        }
    });

    // 週の始まり設定
    document.querySelectorAll('input[name="weekStart"]').forEach(radio => {
        radio.addEventListener('change', () => {
            state.weekStart = radio.value;
            localStorage.setItem('ssWeekStart', radio.value);
            // カレンダーが開いている場合は再描画
            if (state.activeCal) renderCalendar();
            showToast(`週の始まりを${radio.value === 'mon' ? '月曜日' : '日曜日'}に変更しました ✅`);
        });
    });
    // キャッシュクリア（設定モーダル内）
    document.getElementById('hardReloadBtnSettings')?.addEventListener('click', async () => {
        if (confirm("アプリのキャッシュを消去し、最新版に更新しますか？")) {
            _showUpdateOverlay();
            if ('caches' in window) {
                const keys = await caches.keys();
                for (let key of keys) { await caches.delete(key); }
            }
            window.location.reload();
        }
    });

    // よくある質問ボタン
    document.getElementById('openQaBtn')?.addEventListener('click', () => {
        const qaModal = document.getElementById('qaModal');
        if (qaModal) qaModal.classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    });
    // FAQモーダルを閉じる
    document.getElementById('closeQaModal')?.addEventListener('click', () => {
        document.getElementById('qaModal').classList.add('hidden');
        // タブメニューを再表示
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });

    // NG登録一覧ボタン
    document.getElementById('openMyNgListBtn')?.addEventListener('click', () => {
        renderMyNgList();
        document.getElementById('myNgListModal').classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    });
    // NG登録一覧モーダルを閉じる
    document.getElementById('closeMyNgListModal')?.addEventListener('click', () => {
        document.getElementById('myNgListModal').classList.add('hidden');
        // タブメニューを再表示
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });

    // 確定予約一覧ボタン
    document.getElementById('openConfirmedListBtn')?.addEventListener('click', () => {
        renderConfirmedList();
        document.getElementById('confirmedListModal').classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    });
    // 確定予約一覧モーダルを閉じる
    document.getElementById('closeConfirmedListModal')?.addEventListener('click', () => {
        document.getElementById('confirmedListModal').classList.add('hidden');
        // タブメニューを再表示
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });

    // プライバシーポリシーボタン
    document.getElementById('openPrivacyPolicyBtn')?.addEventListener('click', () => {
        document.getElementById('privacyPolicyModal').classList.remove('hidden');
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    });
    document.getElementById('closePrivacyPolicyModal')?.addEventListener('click', () => {
        const modal = document.getElementById('privacyPolicyModal');
        modal.classList.add('hidden');
        modal.style.zIndex = '';
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });

    // 利用規約ボタン
    document.getElementById('openTermsBtn')?.addEventListener('click', () => {
        document.getElementById('termsModal').classList.remove('hidden');
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    });
    document.getElementById('closeTermsModal')?.addEventListener('click', () => {
        const modal = document.getElementById('termsModal');
        modal.classList.add('hidden');
        modal.style.zIndex = '';
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    });

    // 特定商取引法に基づく表記ボタン（設定モーダル内）
    // 設定画面は閉じずに、特商法モーダルを上に重ねて表示する
    document.getElementById('settingsCommercialTransactionBtn')?.addEventListener('click', () => {
        document.getElementById('commercialTransactionModal').classList.remove('hidden');
    });
    document.getElementById('closeCommercialTransactionModal')?.addEventListener('click', () => {
        document.getElementById('commercialTransactionModal').classList.add('hidden');
    });

    // ログインゲートからプライバシーポリシー・利用規約を開く
    // ログインゲートはz-index:99999なので、モーダルを上に表示する
    document.getElementById('loginGatePrivacyLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        const modal = document.getElementById('privacyPolicyModal');
        modal.style.zIndex = '100000';
        modal.classList.remove('hidden');
    });
    document.getElementById('loginGateTermsLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        const modal = document.getElementById('termsModal');
        modal.style.zIndex = '100000';
        modal.classList.remove('hidden');
    });

    // Cookie同意バナーのロジック（広告導入時に有効化）
    // 現在はバナーはhidden状態。広告導入時にshowCookieConsentを呼び出すことで表示される
    document.getElementById('cookieAcceptAll')?.addEventListener('click', () => {
        localStorage.setItem('ssCookieConsent', 'all');
        document.getElementById('cookieConsentBanner').classList.add('hidden');
    });
    document.getElementById('cookieAcceptNecessary')?.addEventListener('click', () => {
        localStorage.setItem('ssCookieConsent', 'necessary');
        document.getElementById('cookieConsentBanner').classList.add('hidden');
    });

    // チュートリアルを見るボタン（設定モーダル内）
    document.getElementById('settingsShowTutorial')?.addEventListener('click', () => {
        document.getElementById('settingsPageModal').classList.add('hidden');
        // タブメニューを再表示
        document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
        if (window.showTutorial) {
            localStorage.removeItem('tutorialDone');
            window.showTutorial();
        } else {
            showToast('チュートリアルは準備中です');
        }
    });


    // 「他の日にも終日NGを設定する」ボタン
    document.getElementById('batchAllDayBtn')?.addEventListener('click', () => {
        const dateKey = state.selectedDate;
        if (!dateKey) return;
        // 当日には保存せず、バッチモードで当日を自動選択
        // 「適用」で全日付（当日含む）に一括保存する
        state.batchMode = true;
        state.batchType = 'allday';
        state.batchTime = null;
        state.batchSelectedDates = new Set([dateKey]);
        closeDateModal();
        // バッチモードUIを表示
        document.getElementById('batchModeBanner')?.classList.remove('hidden');
        document.getElementById('batchTimeDisplay').textContent = '終日NGで一括';
        document.getElementById('batchCountHeader').textContent = '1件選択中';
        // ヘッダー切替
        document.getElementById('backToList')?.classList.add('hidden');
        document.getElementById('batchHeaderCancel')?.classList.remove('hidden');
        document.getElementById('calHeaderActions')?.classList.add('hidden');
        document.getElementById('batchHeaderActions')?.classList.remove('hidden');
        document.getElementById('calDetailName')?.classList.add('hidden');
        document.getElementById('calDetailRange')?.classList.add('hidden');
        document.querySelector('.tab-bar').style.display = 'none';
        document.getElementById('markCompleteBtn')?.classList.add('hidden');
        renderCalendar();
        showToast('他の日を選択してください');
    });

    // 「他の日にも同じ時間帯NGを設定する」ボタン
    document.getElementById('batchTimeNgBtn')?.addEventListener('click', () => {
        if (!state.selectedDate) return;
        // フラグをセットして時間帯設定モーダルを開く
        // saveTimeNG内でこのフラグを検知してバッチモードに自動遷移する
        state._batchAfterTimeSave = true;
        openTimeModal(state.selectedDate);
    });

    // モーダル外タップで閉じる
    document.querySelectorAll('.overlay-modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
                // タブメニューを再表示
                document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
            }
        });
    });

    // スワイプで戻る（指追従アニメーション付き）
    function setupSwipeBack(element, onSwipeComplete) {
        let startX = 0;
        let startY = 0;
        let swiping = false;

        element.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            swiping = false;
            element.style.transition = 'none';
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
            const dx = e.touches[0].clientX - startX;
            const dy = Math.abs(e.touches[0].clientY - startY);
            if (dx > 20 && dx > dy) {
                swiping = true;
                const progress = Math.min(dx / window.innerWidth, 1);
                element.style.transform = `translateX(${dx}px)`;
                element.style.opacity = `${1 - progress * 0.5}`;
            }
        }, { passive: true });

        element.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - startX;
            const dy = Math.abs(e.changedTouches[0].clientY - startY);
            if (swiping && dx > 100 && dx > dy) {
                element.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                element.style.transform = `translateX(${window.innerWidth}px)`;
                element.style.opacity = '0';
                setTimeout(() => {
                    element.style.transform = '';
                    element.style.opacity = '';
                    element.style.transition = '';
                    onSwipeComplete();
                }, 260);
            } else {
                element.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                element.style.transform = '';
                element.style.opacity = '';
                setTimeout(() => { element.style.transition = ''; }, 200);
            }
            swiping = false;
        }, { passive: true });
    }

    // カレンダー詳細画面のスワイプ（無効化 — 戻りはボタンで行う）
    // setupSwipeBack(detailView, ...) は意図的に無効化

    // 日付詳細モーダルのスワイプ（左右で前後日に遷移）
    const dateModalInner = document.querySelector('#dateModal .full-modal-inner');
    if (dateModalInner) {
        let dSwipeStartX = 0;
        let dSwipeStartY = 0;
        let dSwiping = false;
        dateModalInner.addEventListener('touchstart', (e) => {
            dSwipeStartX = e.touches[0].clientX;
            dSwipeStartY = e.touches[0].clientY;
            dSwiping = false;
        }, { passive: true });
        dateModalInner.addEventListener('touchmove', (e) => {
            const dx = e.touches[0].clientX - dSwipeStartX;
            const dy = Math.abs(e.touches[0].clientY - dSwipeStartY);
            if (Math.abs(dx) > 20 && Math.abs(dx) > dy) {
                dSwiping = true;
            }
        }, { passive: true });
        dateModalInner.addEventListener('touchend', (e) => {
            if (!dSwiping) return;
            const dx = e.changedTouches[0].clientX - dSwipeStartX;
            const dy = Math.abs(e.changedTouches[0].clientY - dSwipeStartY);
            if (Math.abs(dx) > 60 && Math.abs(dx) > dy) {
                const modalScroll = dateModalInner.querySelector('.modal-scroll');
                if (dx > 0) {
                    // 右スワイプ → 前の日（今日以前には遷移しない）
                    const today = fmt(new Date());
                    if (state.selectedDate && state.selectedDate <= today) {
                        dSwiping = false;
                        return;
                    }
                    if (modalScroll) {
                        modalScroll.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                        modalScroll.style.transform = 'translateX(100%)';
                        modalScroll.style.opacity = '0';
                    }
                    setTimeout(() => {
                        document.getElementById('prevDay')?.click();
                        if (modalScroll) {
                            modalScroll.style.transition = 'none';
                            modalScroll.style.transform = 'translateX(-100%)';
                            modalScroll.style.opacity = '0';
                            requestAnimationFrame(() => {
                                modalScroll.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                                modalScroll.style.transform = '';
                                modalScroll.style.opacity = '';
                            });
                        }
                    }, 250);
                } else {
                    // 左スワイプ → 次の日
                    if (modalScroll) {
                        modalScroll.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                        modalScroll.style.transform = 'translateX(-100%)';
                        modalScroll.style.opacity = '0';
                    }
                    setTimeout(() => {
                        document.getElementById('nextDay')?.click();
                        if (modalScroll) {
                            modalScroll.style.transition = 'none';
                            modalScroll.style.transform = 'translateX(100%)';
                            modalScroll.style.opacity = '0';
                            requestAnimationFrame(() => {
                                modalScroll.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                                modalScroll.style.transform = '';
                                modalScroll.style.opacity = '';
                            });
                        }
                    }, 250);
                }
            }
            dSwiping = false;
        }, { passive: true });
    }

    // Input Code Modal
    document.getElementById('openInputCodeModal').addEventListener('click', () => {
        document.getElementById('joinInviteCodeInput').value = '';
        document.getElementById('inputCodeError').textContent = '';
        document.getElementById('inputCodeModal').classList.remove('hidden');
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');

    });
    document.getElementById('closeInputCodeModal')?.addEventListener('click', () => { document.getElementById('inputCodeModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });
    document.getElementById('cancelInputCode').addEventListener('click', () => { document.getElementById('inputCodeModal').classList.add('hidden'); document.querySelector('.tab-bar').classList.remove('tab-bar-hidden'); });
    document.getElementById('confirmInputCode').addEventListener('click', joinCalendarByCode);

    document.getElementById('showCalSettings').addEventListener('click', openCalSettingsModal);
    document.getElementById('closeCalSettingsModal')?.addEventListener('click', closeCalSettingsModal);
    document.getElementById('cancelCalSettings').addEventListener('click', closeCalSettingsModal);
    document.getElementById('saveCalSettings').addEventListener('click', saveCalSettings);
    document.getElementById('deleteCalBtn').addEventListener('click', deleteCalendar);
    document.getElementById('leaveCalBtn').addEventListener('click', leaveCalendar);

    // Settings Type Change Event
    document.querySelectorAll('input[name="editCalType"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const rangeInputs = document.getElementById('editRangeInputs');
            if (e.target.value === 'range') {
                rangeInputs.classList.remove('hidden');
            } else {
                rangeInputs.classList.add('hidden');
            }
        });
    });

    // Calendar detail
    // ヒントバナーの×ボタン（グローバルに非表示にする）
    document.getElementById('calHintDismiss')?.addEventListener('click', () => {
        const banner = document.getElementById('calHintBanner');
        if (banner) banner.classList.add('hidden');
        localStorage.setItem('calHintDismissed', 'true');
    });
    document.getElementById('backToList').addEventListener('click', () => {
        if (state.batchMode) {
            cancelBatchMode();
        } else {
            showCalendarList();
        }
    });
    document.getElementById('prevMonth').addEventListener('click', () => {
        // 現在月より前には遷移させない
        const now = new Date();
        if (state.currentDate.getFullYear() === now.getFullYear() && state.currentDate.getMonth() === now.getMonth()) return;
        if (state.currentDate < now) return;
        state.currentDate.setMonth(state.currentDate.getMonth() - 1);
        renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', () => { state.currentDate.setMonth(state.currentDate.getMonth() + 1); renderCalendar(); });

    // Date modal
    document.getElementById('closeDateModal').addEventListener('click', closeDateModal);
    document.getElementById('modeAllDay').addEventListener('click', () => switchMode('allDay'));
    document.getElementById('modeDateToTime').addEventListener('click', () => switchMode('dateToTime'));
    // 前日・次日ボタン（スワイプからも .click() で呼ばれる）
    document.getElementById('prevDay')?.addEventListener('click', () => {
        if (!state.selectedDate) return;
        // 今日より前には遷移させない
        const today = fmt(new Date());
        if (state.selectedDate <= today) return;
        const d = new Date(state.selectedDate);
        d.setDate(d.getDate() - 1);
        openDateModal(fmt(d));
    });
    document.getElementById('nextDay')?.addEventListener('click', () => {
        if (!state.selectedDate) return;
        const d = new Date(state.selectedDate);
        d.setDate(d.getDate() + 1);
        openDateModal(fmt(d));
    });

    document.getElementById('toggleAllDayNgBtn').addEventListener('click', () => { if (state.selectedDate) toggleAllDayNG(state.selectedDate); });
    document.getElementById('openTimeNgModalBtn').addEventListener('click', () => { if (state.selectedDate) openTimeModal(state.selectedDate); });
    document.getElementById('cancelTimeNgBtn')?.addEventListener('click', () => { if (state.selectedDate) cancelTimeNG(state.selectedDate); });
    document.getElementById('saveDateCommentBtn')?.addEventListener('click', () => { if (state.selectedDate) saveDateComment(state.selectedDate); });
    // Enterキーでもコメント保存
    document.getElementById('dateCommentInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.selectedDate) { e.preventDefault(); saveDateComment(state.selectedDate); }
    });

    document.getElementById('batchApply')?.addEventListener('click', applyBatchNG);
    document.getElementById('batchCancel')?.addEventListener('click', cancelBatchMode);
    document.getElementById('batchHeaderCancel')?.addEventListener('click', cancelBatchMode);
    document.getElementById('cancelTimeModal')?.addEventListener('click', closeTimeModal);
    document.getElementById('saveTimeModal')?.addEventListener('click', saveTimeNG);
    document.getElementById('addTimeNgBtn')?.addEventListener('click', addTimeNgToList);
    // 時間モーダルのOK/NG切り替えトグル
    document.getElementById('timeModalModeNG')?.addEventListener('click', () => { state.timeModalMode = 'ng'; updateTimeModalMode(); });
    document.getElementById('timeModalModeOK')?.addEventListener('click', () => { state.timeModalMode = 'ok'; updateTimeModalMode(); });
    document.getElementById('sendProposalBtn')?.addEventListener('click', sendProposal);
    document.getElementById('toggleProposeBtn')?.addEventListener('click', () => {
        const form = document.getElementById('proposalForm');
        form.classList.toggle('hidden');
        // 開いたら提案ボタンまで自動スクロール
        if (!form.classList.contains('hidden')) {
            setTimeout(() => {
                const sendBtn = document.getElementById('sendProposalBtn');
                if (sendBtn) {
                    sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 300);
        }
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    if (tabId === 'tabNotifications') {
        renderNotifications();
        // Clear badge when opening notifications
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.classList.add('hidden');
            badge.textContent = '';
        }
        state.notifications.forEach(n => n.read = true);
        saveLocal();
    }
    if (tabId === 'tabMyPage') renderMyPage();
    // 広告バナーの表示/非表示を更新
    _updateAdVisibility();
}

// ============================================================================
// Calendar List (Home)
// ============================================================================
function renderCalendarList() {
    const list = document.getElementById('calendarList');
    list.innerHTML = '';
    const cals = Object.values(state.calendars).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (cals.length === 0) {
        list.className = 'my-cal-list';
        list.innerHTML = '<div class="my-ng-empty">まだカレンダーがありません。<br>新しく作成しましょう！</div>';
        return;
    }

    cals.forEach(cal => {
        const card = document.createElement('div');
        card.className = 'cal-card';
        const isRange = cal.type === 'range';
        let sub = `${cal.members.length}人参加中`;
        if (isRange && cal.rangeStart && cal.rangeEnd) {
            sub += ` · ${fmtShort(cal.rangeStart)}〜${fmtShort(cal.rangeEnd)}`;
        }
        card.innerHTML = `
            <div class="cal-card-icon ${isRange ? 'range' : 'full'}">
                ${cal.iconUrl
                    ? `<img src="${esc(cal.iconUrl)}" alt="icon" class="cal-card-icon-img">`
                    : `<i class="fa-solid ${isRange ? 'fa-calendar-week' : 'fa-calendar'}"></i>`}
            </div>
            <div class="cal-card-info">
                <h4>${esc(cal.name)}</h4>
                <span>${sub}</span>
            </div>
            <div class="cal-card-arrow"><i class="fa-solid fa-chevron-right"></i></div>`;
        card.addEventListener('click', () => openCalendar(cal.id));
        list.appendChild(card);
    });
}

function showCalendarList() {
    state.activeCal = null;
    document.getElementById('calendarListView').classList.remove('hidden');
    document.getElementById('calendarDetailView').classList.add('hidden');
    renderCalendarList();
    // カレンダー一覧に戻ったら広告を再表示
    _updateAdVisibility();
}

function openCalendar(calId) {
    state.activeCal = calId;
    const cal = state.calendars[calId];
    document.getElementById('calendarListView').classList.add('hidden');
    document.getElementById('calendarDetailView').classList.remove('hidden');
    // カレンダー詳細画面では広告を非表示
    _updateAdVisibility();
    document.getElementById('calDetailName').textContent = cal.name;

    const rangeBadge = document.getElementById('calDetailRange');
    if (cal.type === 'range' && cal.rangeStart && cal.rangeEnd) {
        rangeBadge.textContent = `${fmtShort(cal.rangeStart)} 〜 ${fmtShort(cal.rangeEnd)}`;
        rangeBadge.style.display = 'inline';
    } else {
        rangeBadge.style.display = 'none';
    }

    // If range type, set currentDate to the range start month
    if (cal.type === 'range' && cal.rangeStart) {
        const [y, m] = cal.rangeStart.split('-').map(Number);
        state.currentDate = new Date(y, m - 1, 1);
    } else {
        state.currentDate = new Date();
    }

    renderCalendar();
    renderCompletionStatus();
    _updateCalHintBanner(calId);
}

// ============================================================================
// Create Calendar
// ============================================================================
function openCreateModal() {
    document.getElementById('newCalName').value = '';
    document.getElementById('createCalError').textContent = '';
    setCreateType('full');
    const today = new Date();
    document.getElementById('rangeStart').value = fmt(today);
    const end = new Date(today); end.setDate(end.getDate() + 14);
    document.getElementById('rangeEnd').value = fmt(end);
    document.getElementById('createCalModal').classList.remove('hidden');
    document.querySelector('.tab-bar').classList.add('tab-bar-hidden');

}

function closeCreateModal() {
    document.getElementById('createCalModal').classList.add('hidden');
    document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    // iOS PWA: キーボード閉じ後のスクロール位置リセット
    if (typeof _resetIOSScroll === 'function') { setTimeout(_resetIOSScroll, 50); setTimeout(_resetIOSScroll, 300); }
    // アイコンプレビューをリセット
    _pendingCreateIconFile = null;
    const preview = document.getElementById('createIconPreview');
    if (preview) preview.innerHTML = '<i class="fa-solid fa-camera" style="font-size:1.2rem; opacity:0.5;"></i>';
    document.getElementById('createIconClearBtn')?.classList.add('hidden');
}

function setCreateType(type) {
    state.createType = type;
    document.getElementById('typeFull').classList.toggle('active', type === 'full');
    document.getElementById('typeRange').classList.toggle('active', type === 'range');
    document.getElementById('rangeFields').classList.toggle('hidden', type !== 'range');
}

async function createCalendar() {
    const name = document.getElementById('newCalName').value.trim();
    const err = document.getElementById('createCalError');
    if (!name) { err.textContent = 'カレンダー名を入力してください'; return; }

    let rangeStart = '', rangeEnd = '';
    if (state.createType === 'range') {
        rangeStart = document.getElementById('rangeStart').value;
        rangeEnd = document.getElementById('rangeEnd').value;
        if (!rangeStart || !rangeEnd) { err.textContent = '開始日と終了日を選択してください'; return; }
        if (rangeStart >= rangeEnd) { err.textContent = '終了日は開始日より後にしてください'; return; }
    }

    const timeStart = document.getElementById('calTimeStart').value;
    const timeEndStr = document.getElementById('calTimeEnd').value;
    const timeEnd = timeEndStr === '23:59' ? '24:00' : timeEndStr;
    // 日跨ぎの設定（例: 22:00〜03:00）を許容するため、開始>=終了のバリデーションを削除

    const cal = createCalendarObj(name, state.createType, rangeStart, rangeEnd, timeStart, timeEnd);

    // アイコン画像のアップロード（選択されている場合）
    if (_pendingCreateIconFile) {
        try {
            const url = await uploadCalendarIcon(cal.id, _pendingCreateIconFile);
            cal.iconUrl = url;
        } catch (e) {
            console.error('アイコンアップロードエラー:', e);
            // アイコンなしで続行
        }
        _pendingCreateIconFile = null;
    }

    // NG設定の引継ぎ
    const inheritNg = document.getElementById('inheritNgCreate').checked;
    if (inheritNg) {
        const aggregated = aggregateAllMyNGs();
        Object.keys(aggregated).forEach(ds => {
            if (!cal.schedules[ds]) cal.schedules[ds] = {};
            cal.schedules[ds][MY_USER.id] = aggregated[ds];
        });
    }

    state.calendars[cal.id] = cal;
    saveCalendarToFirestore(cal);
    joinCalendarLocally(cal.id);
    renderCalendarList();

    closeCreateModal();
    showToast("カレンダーを作成しました！");

    // Auto-show invite link newly restored
    setTimeout(() => {
        openCalendar(cal.id);
        if (!demoMode) showInviteModal();
    }, 600);
}

// ============================================================================
// Invite & Settings
// ============================================================================
function showMemberListModal() {
    try {
        const cal = getCal();
        if (!cal) return;

        if (!cal.memberNames) { cal.memberNames = {}; }

        const ul = document.getElementById('memberListUl');
        ul.innerHTML = '';

        // 完了ボタン重複防止
        const existingCompletion = document.querySelector('.completion-section');
        if (existingCompletion) existingCompletion.remove();

        if (!Array.isArray(cal.members)) {
            showToast("エラー: membersが配列ではありません");
            return;
        }

        // 管理者判定
        const isAdmin = cal.creatorId === MY_USER.id;

        cal.members.forEach(mId => {
            const name = getMemberName(mId, state.activeCal);
            // 登録完了判定：cal.completed で判定
            const now = new Date();
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const hasCompleted = cal.completed && cal.completed[mId] && cal.completed[mId][month];
            const statusBadge = hasCompleted
                ? '<span style="font-size:0.75rem; color:#22c55e; white-space:nowrap;"><i class="fa-solid fa-circle-check" style="margin-right:2px;"></i>登録完了</span>'
                : '<span style="font-size:0.75rem; color:#f59e0b; white-space:nowrap;"><i class="fa-solid fa-hourglass-half" style="margin-right:2px;"></i>未完了</span>';
            const li = document.createElement('li');
            li.style.cssText = 'padding:12px 10px; border-bottom:1px solid var(--glass-border); display:flex; align-items:center; gap:10px;';

            // 管理者バッジ
            const adminBadge = (mId === cal.creatorId) ? '<span style="font-size:0.7rem; color:#f59e0b; white-space:nowrap; margin-left:2px;"><i class="fa-solid fa-crown"></i></span>' : '';

            li.innerHTML = `<div style="width:32px; height:32px; border-radius:50%; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-weight:bold; flex-shrink:0;">${esc(name.charAt(0).toUpperCase())}</div><span style="font-size:1.1em; color:var(--text); min-width:0;">${esc(name)}</span>${adminBadge}`;
            // ニックネーム編集ボタン（自分自身の場合のみ）
            if (mId === MY_USER.id) {
                const editBtn = document.createElement('button');
                editBtn.innerHTML = '<i class="fa-solid fa-pen" style="font-size:0.8rem;"></i>';
                editBtn.style.cssText = 'background:none; border:none; color:var(--accent); cursor:pointer; padding:6px; flex-shrink:0;';
                editBtn.addEventListener('click', () => {
                    const newName = prompt('表示名を変更', name);
                    if (newName && newName.trim()) {
                        cal.memberNames[MY_USER.id] = newName.trim();
                        MEMBER_NAMES[MY_USER.id] = newName.trim();
                        if (demoMode) saveLocal();
                        else setDoc(doc(window.db, "calendars", cal.id), { memberNames: cal.memberNames }, { merge: true });
                        showMemberListModal();
                        showToast('表示名を変更しました');
                    }
                });
                li.appendChild(editBtn);
            }
            // ステータスバッジはペンの後ろに配置
            const badge = document.createElement('span');
            badge.innerHTML = statusBadge;
            badge.style.cssText = 'flex-shrink:0; margin-left:auto;';
            li.appendChild(badge);

            // キックボタン（管理者のみ、自分以外のメンバーに表示）
            if (isAdmin && mId !== MY_USER.id) {
                const kickBtn = document.createElement('button');
                kickBtn.innerHTML = '<i class="fa-solid fa-user-xmark" style="font-size:0.8rem;"></i>';
                kickBtn.style.cssText = 'background:none; border:none; color:var(--ng); cursor:pointer; padding:6px; flex-shrink:0; opacity:0.7;';
                kickBtn.title = 'メンバーを退出させる';
                kickBtn.addEventListener('click', () => kickMember(state.activeCal, mId));
                li.appendChild(kickBtn);
            }

            ul.appendChild(li);
        });

        document.getElementById('memberListModal').classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    } catch (e) {
        showToast("MemberList Modal Error: " + e.message);
        console.error(e);
    }
}

// メンバーをカレンダーから強制退出させる（管理者専用）
async function kickMember(calId, memberId) {
    if (demoMode) { showToast('サンプルメンバーは変更できません'); return; }
    const cal = state.calendars[calId];
    if (!cal) return;
    // 管理者チェック
    if (cal.creatorId !== MY_USER.id) {
        showToast('管理者のみがメンバーを退出させることができます', 'error');
        return;
    }

    const memberName = getMemberName(memberId, calId);
    if (!confirm(`${memberName} をこのカレンダーから退出させますか？`)) return;

    try {
        // Firestoreで確実にフィールドを削除するためのupdateデータを構築
        const updateData = {};

        // membersから削除
        cal.members = cal.members.filter(m => m !== memberId);
        updateData.members = cal.members;

        // memberNamesから削除
        if (cal.memberNames && cal.memberNames[memberId]) {
            delete cal.memberNames[memberId];
            updateData[`memberNames.${memberId}`] = deleteField();
        }

        // schedulesから削除（日付ごとにメンバーのエントリを削除）
        if (cal.schedules) {
            Object.keys(cal.schedules).forEach(ds => {
                if (cal.schedules[ds] && cal.schedules[ds][memberId]) {
                    delete cal.schedules[ds][memberId];
                    updateData[`schedules.${ds}.${memberId}`] = deleteField();
                    // ローカルで空になったら削除
                    if (Object.keys(cal.schedules[ds]).length === 0) {
                        delete cal.schedules[ds];
                        updateData[`schedules.${ds}`] = deleteField();
                    }
                }
            });
        }

        // completedから削除
        if (cal.completed && cal.completed[memberId]) {
            delete cal.completed[memberId];
            updateData[`completed.${memberId}`] = deleteField();
        }

        // proposalsの投票から削除（配列なので全体を上書き）
        if (cal.proposals) {
            cal.proposals.forEach(p => {
                if (p.votes) delete p.votes[memberId];
            });
            updateData.proposals = cal.proposals;
        }

        // Firestoreにupdateで保存（deleteFieldが確実に反映される）
        await updateDoc(doc(window.db, "calendars", calId), updateData);

        showMemberListModal(); // メンバーリストを再描画
        renderCalendar();
        showToast(`${memberName} を退出させました`);
    } catch (e) {
        console.error("Error kicking member:", e);
        showToast('メンバーの退出に失敗しました', 'error');
    }
}

function showInviteModal() {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    if (!state.activeCal) return;
    const cal = state.calendars[state.activeCal];
    const inviteCode = cal.inviteCode || Math.random().toString(36).slice(2, 10).toUpperCase();
    const url = `${location.origin}${location.pathname}?invite=${inviteCode}`;
    document.getElementById('inviteLinkText').value = url;
    document.getElementById('inviteCodeText').value = inviteCode;
    document.getElementById('inviteModal').classList.remove('hidden');
    // タブメニューを非表示
    document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
}

function copyInviteLink() {
    const urlText = document.getElementById('inviteLinkText').value;
    const codeText = document.getElementById('inviteCodeText').value;
    const fullText = `${urlText}\n招待コード: ${codeText}`;
    navigator.clipboard.writeText(fullText).then(() => {
        showToast('招待リンクとコードをコピーしました！');
    }).catch(() => {
        const ta = document.createElement('textarea'); ta.value = fullText;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('コピーしました！');
    });
}

function copyInviteCodeOnly() {
    const codeText = document.getElementById('inviteCodeText').value;
    navigator.clipboard.writeText(codeText).then(() => {
        showToast('招待コードをコピーしました！');
    }).catch(() => {
        const ta = document.createElement('textarea'); ta.value = codeText;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('コピーしました！');
    });
}

function openCalSettingsModal() {
    if (!state.activeCal) return;
    const cal = state.calendars[state.activeCal];

    document.getElementById('editCalName').value = cal.name;
    document.getElementById('editCalTimeStart').value = cal.timeStart || '00:00';
    document.getElementById('editCalTimeEnd').value = cal.timeEnd === '24:00' ? '23:59' : (cal.timeEnd || '23:59');

    document.querySelector(`input[name="editCalType"][value="${cal.type}"]`).checked = true;

    const rangeInputs = document.getElementById('editRangeInputs');
    if (cal.type === 'range') {
        rangeInputs.classList.remove('hidden');
        document.getElementById('editCalRangeStart').value = cal.rangeStart || '';
        document.getElementById('editCalRangeEnd').value = cal.rangeEnd || '';
    } else {
        rangeInputs.classList.add('hidden');
        document.getElementById('editCalRangeStart').value = '';
        document.getElementById('editCalRangeEnd').value = '';
    }

    // カレンダー作成者判定: creatorIdがあるか、membersの最初の人
    const isCreator = (cal.creatorId === MY_USER.id) || (!cal.creatorId && cal.members.length > 0 && cal.members[0] === MY_USER.id);
    document.getElementById('deleteCalBtn').style.display = isCreator ? 'inline-block' : 'none';
    document.getElementById('leaveCalBtn').style.display = !isCreator ? 'inline-block' : 'none';

    document.getElementById('editCalError').textContent = '';

    // アイコンプレビュー表示
    const iconPreview = document.getElementById('editIconPreview');
    const iconClearBtn = document.getElementById('editIconClearBtn');
    _pendingEditIconFile = null;
    if (cal.iconUrl) {
        iconPreview.innerHTML = `<img src="${esc(cal.iconUrl)}" alt="icon" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`;
        iconClearBtn.classList.remove('hidden');
    } else {
        iconPreview.innerHTML = '<i class="fa-solid fa-camera" style="font-size:1.2rem; opacity:0.5;"></i>';
        iconClearBtn.classList.add('hidden');
    }

    // アイコン変更はホストのみ
    const editIconField = document.getElementById('editIconField');
    editIconField.style.display = isCreator ? '' : 'none';

    document.getElementById('calSettingsModal').classList.remove('hidden');
    // タブメニューを非表示
    document.querySelector('.tab-bar').classList.add('tab-bar-hidden');

}

function closeCalSettingsModal() {
    document.getElementById('calSettingsModal').classList.add('hidden');
    // タブメニューを再表示
    document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    // iOS PWA: キーボード閉じ後のスクロール位置リセット
    if (typeof _resetIOSScroll === 'function') { setTimeout(_resetIOSScroll, 50); setTimeout(_resetIOSScroll, 300); }
}

async function saveCalSettings() {
    const err = document.getElementById('editCalError');
    const name = document.getElementById('editCalName').value.trim();
    if (!name) { err.textContent = 'カレンダー名を入力してください'; return; }

    const type = document.querySelector('input[name="editCalType"]:checked').value;
    let rStart = '', rEnd = '';

    if (type === 'range') {
        rStart = document.getElementById('editCalRangeStart').value;
        rEnd = document.getElementById('editCalRangeEnd').value;
        if (!rStart || !rEnd) { err.textContent = '開始日と終了日を選択してください'; return; }
        if (rStart > rEnd) { err.textContent = '終了日は開始日以降にしてください'; return; }

        // Ensure range does not exceed 6 months (approx 180 days)
        const diff = (new Date(rEnd) - new Date(rStart)) / (1000 * 60 * 60 * 24);
        if (diff > 180) { err.textContent = '期間は最大6ヶ月までです'; return; }
    }

    const tStart = document.getElementById('editCalTimeStart').value;
    const tEndStr = document.getElementById('editCalTimeEnd').value;
    const tEnd = tEndStr === '23:59' ? '24:00' : tEndStr;
    // 日跨ぎ設定のため、以下の終了時間の方が早い場合のバリデーションを削除

    if (state.activeCal && state.calendars[state.activeCal]) {
        const cal = state.calendars[state.activeCal];
        cal.name = name;
        cal.type = type;
        cal.rangeStart = rStart;
        cal.rangeEnd = rEnd;
        cal.timeStart = tStart;
        cal.timeEnd = tEnd;

        // アイコン画像の更新
        if (_pendingEditIconFile) {
            try {
                showToast('アイコンをアップロード中...');
                const url = await uploadCalendarIcon(cal.id, _pendingEditIconFile);
                cal.iconUrl = url;
            } catch (e) {
                console.error('アイコンアップロードエラー:', e);
                showToast('アイコンのアップロードに失敗しました', 'error');
            }
            _pendingEditIconFile = null;
        } else if (_pendingEditIconFile === false) {
            // 明示的に削除された場合
            cal.iconUrl = '';
            _pendingEditIconFile = null;
        }

        // Recalculate range logic, adjust currentDate if necessary
        if (cal.type === 'range' && cal.rangeStart) {
            const [y, m] = cal.rangeStart.split('-').map(Number);
            const rStartMonth = new Date(y, m - 1, 1);

            const [ey, em] = cal.rangeEnd.split('-').map(Number);
            const rEndMonth = new Date(ey, em - 1, 1);

            // If current view month is completely outside the new range, reset to start month
            if (state.currentDate < rStartMonth || state.currentDate > rEndMonth) {
                state.currentDate = rStartMonth;
            }
        }

        saveCalendarToFirestore(cal);
        renderCalendarList(); // Refresh list names
        openCalendar(state.activeCal); // Refresh calendar view
        closeCalSettingsModal();
        showToast('設定を保存しました');
    }
}

async function deleteCalendar() {
    if (demoMode) {
        if (!state.activeCal || !confirm('このブラウザに保存したデモカレンダーを削除しますか？')) return;
        delete state.calendars[state.activeCal];
        state.activeCal = null;
        saveLocal();
        closeCalSettingsModal();
        showCalendarList();
        showToast('デモカレンダーを削除しました');
        return;
    }
    if (!state.activeCal) return;
    const calId = state.activeCal;
    if (confirm("本当にこのカレンダーを削除しますか？\n（参加している全員のデータも消去されます）")) {
        try {
            const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
            await deleteDoc(doc(window.db, "calendars", calId));

            // Delete locally
            delete state.calendars[calId];

            // Remove from joined list
            let joined = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
            joined = joined.filter(id => id !== calId);
            localStorage.setItem('ssJoinedCals', JSON.stringify(joined));
            syncJoinedCalsToFirestore();
            if (demoMode) saveLocal();

            closeCalSettingsModal();
            state.activeCal = null;
            renderCalendarList();
            switchTab('tabCalendar');
            showToast("カレンダーを削除しました");
        } catch (e) {
            console.error("Error deleting calendar", e);
            document.getElementById('editCalError').textContent = "削除に失敗しました";
        }
    }
}

async function leaveCalendar() {
    if (!state.activeCal) return;
    const calId = state.activeCal;
    const cal = state.calendars[calId];
    if (confirm("このカレンダーから退出しますか？\n（再度参加するには招待リンクが必要です）")) {
        try {
            // Remove from members array
            cal.members = cal.members.filter(m => m !== MY_USER.id);
            saveCalendarToFirestore(cal);

            // Remove from local state
            delete state.calendars[calId];

            // Firestore リスナーを解除（更新で再表示されないように）
            if (activeCalendarListeners[calId]) {
                activeCalendarListeners[calId]();
                delete activeCalendarListeners[calId];
            }

            // Remove from joined list
            let joined = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
            joined = joined.filter(id => id !== calId);
            localStorage.setItem('ssJoinedCals', JSON.stringify(joined));
            syncJoinedCalsToFirestore();
            if (demoMode) saveLocal();

            closeCalSettingsModal();
            state.activeCal = null;
            showCalendarList();
            showToast("カレンダーを退出しました");
        } catch (e) {
            console.error("Error leaving calendar", e);
            document.getElementById('editCalError').textContent = "退出に失敗しました";
        }
    }
}

// ============================================================================
// Calendar Rendering
// ============================================================================
function getCal() { return state.activeCal ? state.calendars[state.activeCal] : null; }

function calcAvail(ds) {
    const cal = getCal(); if (!cal) return { status: 'ALL_OK' };

    const tStartStr = cal.timeStart || '00:00';
    const tEndStr = cal.timeEnd || '24:00';
    const tStart = toMin(tStartStr);
    const tEnd = toMin(tEndStr === '23:59' ? '24:00' : tEndStr);

    const d = cal.schedules[ds];
    if (!d || !Object.keys(d).length) return { status: 'ALL_OK', freeSlots: [{ start: fromMin(tStart), end: fromMin(tEnd) }] };
    for (const s of Object.values(d)) if (s.isAllDay) return { status: 'NO_OK' };

    let blocks = [];
    for (const s of Object.values(d)) {
        if (s.times) {
            s.times.forEach(t => {
                const sMin = Math.max(tStart, toMin(t.start));
                const eMin = Math.min(tEnd, toMin(t.end));
                if (sMin < eMin) blocks.push({ s: sMin, e: eMin });
            });
        }
    }
    if (!blocks.length) return { status: 'ALL_OK', freeSlots: [{ start: fromMin(tStart), end: fromMin(tEnd) }] };

    blocks.sort((a, b) => a.s - b.s);
    let merged = [{ ...blocks[0] }];
    for (let i = 1; i < blocks.length; i++) {
        const l = merged[merged.length - 1];
        if (blocks[i].s <= l.e) l.e = Math.max(l.e, blocks[i].e);
        else merged.push({ ...blocks[i] });
    }
    let free = [], c = tStart;
    for (const b of merged) { if (c < b.s) free.push({ s: c, e: b.s }); c = Math.max(c, b.e); }
    if (c < tEnd) free.push({ s: c, e: tEnd });

    if (free.length === 1 && free[0].s === tStart && free[0].e === tEnd) return { status: 'ALL_OK', freeSlots: free.map(f => ({ start: fromMin(f.s), end: fromMin(f.e) })) };
    if (!free.length) return { status: 'NO_OK' };
    return { status: 'PARTIAL_OK', freeSlots: free.map(f => ({ start: fromMin(f.s), end: fromMin(f.e) })) };
}

function toMin(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function fromMin(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

function renderCalendar() {
    try {
        const cal = getCal();
        if (!cal) {
            console.warn("renderCalendar called but no active calendar found.");
            return;
        }

        const y = state.currentDate.getFullYear(), m = state.currentDate.getMonth();

        // For range calendars, show/hide nav buttons
        const prevBtn = document.getElementById('prevMonth');
        const nextBtn = document.getElementById('nextMonth');
        prevBtn.style.visibility = 'visible';
        nextBtn.style.visibility = 'visible';

        const now = new Date();
        const todayY = now.getFullYear();
        const todayM = now.getMonth();

        // 過去の月には移動できないようにする
        if (y < todayY || (y === todayY && m <= todayM)) {
            prevBtn.style.visibility = 'hidden';
        }

        // Range bounds
        let rStart = null, rEnd = null;
        if (cal.type === 'range' && cal.rangeStart && cal.rangeEnd) {
            rStart = cal.rangeStart;
            rEnd = cal.rangeEnd;

            const startY = parseInt(rStart.slice(0, 4), 10);
            const startM = parseInt(rStart.slice(5, 7), 10) - 1;
            const endY = parseInt(rEnd.slice(0, 4), 10);
            const endM = parseInt(rEnd.slice(5, 7), 10) - 1;

            if (y < startY || (y === startY && m <= startM)) prevBtn.style.visibility = 'hidden';
            if (y > endY || (y === endY && m >= endM)) nextBtn.style.visibility = 'hidden';
        }

        document.getElementById('currentMonthYear').textContent = `${y}年${m + 1}月`;
        const container = document.getElementById('calendarDays');
        container.innerHTML = '';

        if (!cal.memberNames) { cal.memberNames = {}; }

        const pad = new Date(y, m, 1).getDay();
        const total = new Date(y, m + 1, 0).getDate();
        const todayStr = fmt(new Date());

        // 週の始まりに応じて曜日ヘッダーを動的に更新
        const isMondayStart = state.weekStart === 'mon';
        const weekdaysEl = document.querySelector('.weekdays');
        if (weekdaysEl) {
            weekdaysEl.innerHTML = isMondayStart
                ? '<span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span><span>日</span>'
                : '<span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span>';
        }

        // パディングを週の始まりに応じて計算
        const adjustedPad = isMondayStart ? (pad === 0 ? 6 : pad - 1) : pad;

        for (let i = 0; i < adjustedPad; i++) { const c = document.createElement('div'); c.className = 'day-cell empty'; container.appendChild(c); }

        for (let i = 1; i <= total; i++) {
            const ds = fmt(new Date(y, m, i));
            const cell = document.createElement('div');
            cell.className = 'day-cell';

            const isPast = ds < todayStr;
            // Range check: dim out-of-range dates
            if (isPast || (rStart && (ds < rStart || ds > rEnd))) {
                cell.classList.add('outside');
            }

            if (ds === todayStr) cell.classList.add('today');

            const inRange = !isPast && (!rStart || (ds >= rStart && ds <= rEnd));
            if (state.batchMode) {
                cell.classList.add('batch-selectable');
                if (state.batchSelectedDates.has(ds)) cell.classList.add('batch-selected');
                // バッチモードでも自分のNG状態を表示
                if (inRange) {
                    const cal = getCal();
                    const sched = cal && cal.schedules && cal.schedules[ds];
                    const my = sched && sched[MY_USER.id];
                    if (my) {
                        if (my.isAllDay) {
                            cell.classList.add('my-ng-allday');
                            const l = document.createElement('div'); l.className = 'ok-label'; l.style.cssText = 'color:var(--ng); font-size:0.65rem;'; l.textContent = '終日NG';
                            cell.appendChild(l);
                        } else if (my.times && my.times.length > 0) {
                            cell.classList.add('my-ng-partial');
                            const l = document.createElement('div'); l.className = 'ok-label'; l.style.cssText = 'color:var(--partial); font-size:0.6rem;'; l.textContent = `${my.times[0].start}〜`;
                            cell.appendChild(l);
                        }
                    }
                }
            } else if (state.selectedDate === ds) cell.classList.add('selected');

            const num = document.createElement('div');
            num.className = 'day-number'; num.textContent = i;
            cell.appendChild(num);

            if (!state.batchMode && inRange) {
                const a = calcAvail(ds);

                // 投票確定日チェック（カレンダーのproposalsで全員OKの日）
                let isConfirmed = false;
                if (cal.proposals && Array.isArray(cal.proposals)) {
                    isConfirmed = cal.proposals.some(p => {
                        if (p.date !== ds) return false;
                        const votes = p.votes || {};
                        const members = cal.members || [];
                        return members.length > 0 && members.every(uid => votes[uid] === 'ok');
                    });
                }

                if (isConfirmed) {
                    // 🏅 投票確定マーカー（ピンク枠）
                    cell.classList.add('confirmed-event');
                    cell.style.cssText += 'border: 2px solid #FF4081 !important; border-radius: 8px;';
                    num.style.color = '#FF4081';
                    const l = document.createElement('div');
                    l.className = 'ok-label';
                    l.style.cssText = 'color:#FF4081; font-size:0.55rem; margin-top:2px;';
                    l.textContent = '✓ 確定';
                    cell.appendChild(l);
                } else if (a && a.status === 'ALL_OK') {
                    cell.classList.add('ok-all');
                    const l = document.createElement('div'); l.className = 'ok-label'; l.textContent = '✓ OK!';
                    cell.appendChild(l);
                } else if (a && a.status === 'PARTIAL_OK' && a.freeSlots && a.freeSlots.length > 0) {
                    cell.classList.add('ok-partial');
                    const l = document.createElement('div'); l.className = 'ok-label'; l.textContent = `${a.freeSlots[0].start}〜`;
                    cell.appendChild(l);
                }

                // コメントアイコン表示（誰かがコメントを残している日）
                const daySched = cal.schedules && cal.schedules[ds];
                if (daySched) {
                    const hasComment = Object.entries(daySched).some(([uid, data]) => data && data.comment && data.comment.trim());
                    if (hasComment) {
                        const commentIcon = document.createElement('i');
                        commentIcon.className = 'fa-solid fa-comment';
                        commentIcon.style.cssText = 'position:absolute; top:2px; right:2px; font-size:0.45rem; color:var(--accent); opacity:0.8;';
                        cell.style.position = 'relative';
                        cell.appendChild(commentIcon);
                    }
                }
            }

            if (inRange) {
                cell.addEventListener('click', () => {
                    if (state.batchMode) {
                        state.batchSelectedDates.has(ds) ? state.batchSelectedDates.delete(ds) : state.batchSelectedDates.add(ds);
                        const displayCount = `${state.batchSelectedDates.size}件選択中`;
                        document.getElementById('batchCountHeader').textContent = displayCount;
                        renderCalendar();
                    } else {
                        state.selectedDate = ds;
                        renderCalendar();
                        openDateModal(ds);
                    }
                });
            }
            container.appendChild(cell);
        }
    } catch (e) {
        showToast("Render Error: " + e.message);
        console.error(e);
    }

    // 凡例をモードに応じて切替
    const legend = document.getElementById('calLegend');
    if (legend) {
        if (state.batchMode) {
            legend.innerHTML = '<span style="margin-right:12px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ng);margin-right:4px;"></span>終日NG</span><span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--partial);margin-right:4px;"></span>時間帯NG</span>';
        } else {
            legend.innerHTML = '<span><div class="dot dot-ok"></div> 終日OK!</span><span><div class="dot dot-partial"></div> 一部OK</span>';
        }
    }
}

// ============================================================================
// Date Modal
// ============================================================================
function openDateModal(ds) {
    state.selectedDate = ds;
    const [y, m, d] = ds.split('-').map(Number);
    document.getElementById('dateModalTitle').textContent = `${y}年${m}月${d}日`;
    document.getElementById('dateModal').classList.remove('hidden');
    // タブメニューを非表示
    document.querySelector('.tab-bar').classList.add('tab-bar-hidden');
    // prevDay ボタンのグレーアウト制御（今日以前は押せない）
    const prevDayBtn = document.getElementById('prevDay');
    if (prevDayBtn) {
        const today = fmt(new Date());
        if (ds <= today) {
            prevDayBtn.style.opacity = '0.25';
            prevDayBtn.style.pointerEvents = 'none';
        } else {
            prevDayBtn.style.opacity = '';
            prevDayBtn.style.pointerEvents = '';
        }
    }
    // モードを終日NGにリセット
    switchMode('allDay');

    // 詳細設定の折りたたみを閉じる
    const details = document.getElementById('scheduleOptionsDetails');
    if (details) details.removeAttribute('open');

    // 繰り返しチェックボックスのリセットと曜日テキスト更新
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const dayOfWeek = new Date(y, m - 1, d).getDay();
    const dayName = dayNames[dayOfWeek];
    const repeatCheckbox = document.getElementById('repeatNgCheckbox');
    if (repeatCheckbox) repeatCheckbox.checked = false;
    const repeatNgText = document.getElementById('repeatNgText');
    if (repeatNgText) repeatNgText.textContent = `毎週${dayName}曜日に繰り返す`;

    // 日付モーダル初回ヒント表示（1回だけ表示して3秒後にフェードアウト）
    _showDateModalHintOnce();

    const cal = getCal(); if (!cal) return;
    const avail = calcAvail(ds);
    const okArea = document.getElementById('okTimesArea');
    const propForm = document.getElementById('proposalForm');
    const dayData = cal.schedules[ds] || {};

    // Build timeline HTML
    let html = '';

    if (avail.status === 'ALL_OK') {
        html += `<div class="ok-status-icon"><i class="fa-solid fa-circle-check" style="font-size:1.8rem; color:var(--ok);"></i></div>
            <div class="ok-status-text"><span style="color:var(--ok);font-weight:700;font-size:1.05rem;">終日OK！</span><br>
            <span style="color:var(--text-sub);font-size:0.85rem;">メンバー全員が参加できます</span></div>`;
        html += renderTimeline(dayData, avail);
        propForm.classList.add('hidden'); // default hidden
        document.getElementById('proposeStartTime').value = '19:00';
        document.getElementById('proposeEndTime').value = '';
    } else if (avail.status === 'PARTIAL_OK') {
        html += `<div class="ok-status-icon"><i class="fa-regular fa-clock" style="font-size:1.6rem; color:var(--partial);"></i></div>
            <div class="ok-status-text"><span style="color:var(--partial);font-weight:600;">一部の時間帯がOKです</span></div>`;
        html += renderTimeline(dayData, avail);
        propForm.classList.add('hidden'); // default hidden
        document.getElementById('proposeStartTime').value = avail.freeSlots[0].start;
        document.getElementById('proposeEndTime').value = '';
    } else {
        html += `<div class="no-availability">この日は集まれません</div>`;
        html += renderTimeline(dayData, avail);
        propForm.classList.add('hidden');
    }
    // 確定予約がある場合はキャンセルボタンを表示
    if (cal.proposals && Array.isArray(cal.proposals)) {
        cal.proposals.forEach(p => {
            if (p.date !== ds) return;
            const votes = p.votes || {};
            const members = cal.members || [];
            const isConfirmed = members.length > 0 && members.every(uid => votes[uid] === 'ok');
            if (!isConfirmed) return;
            const timeStr = p.endTime ? `${p.startTime} 〜 ${p.endTime}` : `${p.startTime} 〜`;
            html += `<div style="margin-top:12px; padding:12px; border:1px solid #FF4081; border-radius:10px; background:rgba(255,64,129,0.08);">`;
            html += `<div style="display:flex; align-items:center; justify-content:space-between;">`;
            html += `<div><span style="color:#FF4081; font-weight:600; font-size:0.95rem;"><i class="fa-solid fa-trophy" style="margin-right:4px;"></i>確定予約</span>`;
            html += `<div style="color:var(--text-sub); font-size:0.85rem; margin-top:4px;"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${timeStr}</div></div>`;
            html += `<button class="icon-btn" onclick="cancelConfirmedEvent('${cal.id}','${p.id}')" style="color:var(--ng); width:36px; height:36px; font-size:1rem;" title="予約をキャンセル"><i class="fa-solid fa-trash-can"></i></button>`;
            html += `</div></div>`;
        });
    }

    okArea.innerHTML = html;

    // My NG
    const my = dayData[MY_USER.id] || { isAllDay: false, times: [] };
    const btn = document.getElementById('toggleAllDayNgBtn');
    if (my.isAllDay) {
        btn.classList.add('active');
        btn.style.cssText = 'background:var(--ng); color:#fff; border-color:var(--ng);';
        btn.innerHTML = '<i class="fa-solid fa-times-circle"></i><span>終日NGをキャンセル</span>';
    } else {
        btn.classList.remove('active');
        btn.style.cssText = '';
        btn.innerHTML = '<i class="fa-solid fa-ban"></i><span>終日NGにする</span>';
    }
    const summary = document.getElementById('myNgSummary');
    if (my.isAllDay) {
        summary.style.border = '1px solid var(--glass-border)';
        summary.style.padding = '8px 12px';
        summary.innerHTML = `<div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
            <span style="color:var(--accent); font-size:0.95rem;"><i class="fa-solid fa-ban" style="margin-right:4px;"></i>終日NGを設定済</span>
            <button class="icon-btn" onclick="toggleAllDayNG('${ds}')" style="color:var(--ng); width:36px; height:36px; font-size:1rem;" title="NG設定をキャンセル"><i class="fa-solid fa-trash-can"></i></button>
        </div>`;
    } else if (my.times.length > 0) {
        summary.style.border = '1px solid var(--glass-border)';
        summary.style.padding = '8px 12px';
        let timesHtml = '';
        my.times.forEach((t, idx) => {
            timesHtml += `<div style="display:flex; align-items:center; justify-content:space-between; width:100%;${idx > 0 ? ' margin-top:6px; padding-top:6px; border-top:1px solid var(--glass-border);' : ''}">
                <span style="color:var(--accent); font-size:0.95rem;"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${t.start} 〜 ${t.end}</span>
                <button class="icon-btn" onclick="deleteTimeNG('${ds}',${idx})" style="color:var(--ng); width:36px; height:36px; font-size:1rem;" title="NG設定をキャンセル"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
        });
        summary.innerHTML = timesHtml;
    } else {
        summary.innerHTML = '';
        summary.style.border = 'none';
        summary.style.padding = '0';
    }

    // 時間帯NGキャンセルボタンの表示/非表示制御
    const cancelTimeNgBtn = document.getElementById('cancelTimeNgBtn');
    if (cancelTimeNgBtn) {
        if (!my.isAllDay && my.times.length > 0) {
            cancelTimeNgBtn.classList.remove('hidden');
        } else {
            cancelTimeNgBtn.classList.add('hidden');
        }
    }

    // コメントセクションの表示
    const commentInput = document.getElementById('dateCommentInput');
    const commentsArea = document.getElementById('dateCommentsArea');
    if (commentInput && commentsArea) {
        // 自分のコメントを入力欄にセット
        const myComment = dayData[MY_USER.id]?.comment || '';
        commentInput.value = myComment;

        // 他メンバーのコメントを表示
        let commentsHtml = '';
        const memberNames = cal.memberNames || {};
        Object.entries(dayData).forEach(([uid, data]) => {
            if (uid === MY_USER.id) return; // 自分は除外
            if (!data || !data.comment || !data.comment.trim()) return;
            const name = memberNames[uid] || uid.slice(0, 8);
            commentsHtml += `<div style="display:flex; align-items:flex-start; gap:8px; padding:6px 0; border-bottom:1px solid var(--glass-border);">
                <span style="font-weight:600; font-size:0.8rem; color:var(--accent); white-space:nowrap;">${name}</span>
                <span style="font-size:0.85rem; color:var(--text-main);">${esc(data.comment)}</span>
            </div>`;
        });
        commentsArea.innerHTML = commentsHtml;
    }
}

/**
 * 日付コメントを保存する
 * 同期チェックボックスがONなら全カレンダーに同期
 */
function saveDateComment(ds) {
    const cal = getCal();
    if (!cal) return;
    const commentInput = document.getElementById('dateCommentInput');
    const commentText = commentInput ? commentInput.value.trim() : '';

    const syncCheckbox = document.getElementById('syncCommentCheckbox');
    const doSync = syncCheckbox && syncCheckbox.checked;

    const calendarsToUpdate = doSync
        ? Object.values(state.calendars).filter(c => c.members && c.members.includes(MY_USER.id))
        : [cal];

    calendarsToUpdate.forEach(targetCal => {
        // 期間指定カレンダーの場合は範囲内かチェック
        if (targetCal.type === 'range') {
            if (!targetCal.rangeStart || !targetCal.rangeEnd || ds < targetCal.rangeStart || ds > targetCal.rangeEnd) {
                return;
            }
        }
        ensureSched(targetCal, ds);
        if (commentText) {
            targetCal.schedules[ds][MY_USER.id].comment = commentText;
        } else {
            delete targetCal.schedules[ds][MY_USER.id].comment;
        }
        cleanupSched(targetCal, ds);
        saveScheduleFieldToFirestore(targetCal, ds);
    });

    closeDateModal(); renderCalendar();
    if (commentText) {
        showToast('コメントを保存しました');
    } else {
        showToast('コメントを削除しました');
    }
}

// Render horizontal timeline bar
function renderTimeline(dayData, avail) {
    const cal = getCal();
    const tStartStr = cal ? (cal.timeStart || '00:00') : '00:00';
    const tEndStr = cal ? (cal.timeEnd || '24:00') : '24:00';
    const tStart = toMin(tStartStr);
    const tEnd = toMin(tEndStr === '23:59' ? '24:00' : tEndStr);
    const totalMins = tEnd - tStart;

    // Grid lines every 1 hour within the range
    let gridLines = '';
    const startHour = Math.ceil(tStart / 60);
    const endHour = Math.floor(tEnd / 60);
    for (let h = startHour + 1; h < endHour; h++) {
        const m = h * 60;
        const pct = ((m - tStart) / totalMins) * 100;
        const isMajor = h % 6 === 0;
        const opacity = isMajor ? '0.3' : '0.1';
        gridLines += `<div class="tl-grid" style="left:${pct}%;background:rgba(255,255,255,${opacity});"></div>`;
    }

    // Time labels
    let labels = '';
    const labelHours = [Math.floor(tStart / 60), ...[6, 12, 18].filter(h => h > startHour && h < endHour), endHour];
    const uniqueLabels = [...new Set(labelHours)];
    uniqueLabels.forEach(h => {
        const m = h * 60;
        const renderM = Math.max(tStart, Math.min(tEnd, m));
        const pct = ((renderM - tStart) / totalMins) * 100;
        let transform = 'translateX(-50%)';
        if (pct === 0) transform = 'translateX(0)';
        if (pct === 100) transform = 'translateX(-100%)';
        const labelText = h === 0 ? '0' : h === 24 ? '24' : `${h}`;
        labels += `<span style="left:${pct}%; transform:${transform};">${labelText}</span>`;
    });

    // Combined availability bar segments
    let segments = '';
    if (avail.status === 'ALL_OK') {
        segments = `<div class="tl-seg tl-ok" style="left:0;width:100%"></div>`;
    } else if (avail.status === 'NO_OK') {
        segments = `<div class="tl-seg tl-ng" style="left:0;width:100%"></div>`;
    } else if (avail.freeSlots) {
        segments = `<div class="tl-seg tl-ng" style="left:0;width:100%"></div>`;
        avail.freeSlots.forEach(s => {
            const sMin = Math.max(tStart, toMin(s.start));
            const eMin = Math.min(tEnd, toMin(s.end));
            if (sMin < eMin) {
                const left = ((sMin - tStart) / totalMins) * 100;
                const width = ((eMin - sMin) / totalMins) * 100;
                segments += `<div class="tl-seg tl-ok" style="left:${left}%;width:${width}%"></div>`;
            }
        });
    }

    // Member NG list (compact — no individual bars)
    let memberList = '';
    const memberIds = Object.keys(dayData);
    if (memberIds.length > 0) {
        let validMembersCount = 0;
        const items = memberIds.map(uid => {
            const s = dayData[uid];
            const name = getMemberName(uid, state.activeCal);
            let detailItems = [];
            let isAllDayDisp = false;

            if (s.isAllDay) {
                detailItems.push('終日');
                isAllDayDisp = true;
            } else if (s.times) {
                s.times.forEach(t => {
                    const sMin = toMin(t.start);
                    const eMin = toMin(t.end);
                    // Only include if it overlaps with [tStart, tEnd]
                    if (sMin < tEnd && eMin > tStart) {
                        detailItems.push(`${t.start}〜${t.end}`);
                    }
                });
            }

            if (detailItems.length === 0) return ''; // Hide member if all NGs are outside the range
            validMembersCount++;

            const detail = detailItems.join(' / ');
            const pillClass = isAllDayDisp ? 'pill-allday' : 'pill-time';
            return `<div class="ng-member-row">
                <span class="ng-member-name">${esc(name)}</span>
                <span class="ng-pill ${pillClass}">${detail}</span>
            </div>`;
        }).join('');

        if (validMembersCount > 0) {
            memberList = `<div class="ng-member-list">
                <div class="ng-member-header"><i class="fa-solid fa-users"></i> NG状況（${validMembersCount}人）</div>
                ${items}
            </div>`;
        }
    }

    return `
        <div class="timeline-wrap">
            <div class="tl-label">空き状況タイムライン</div>
            <div class="tl-bar-wrap">
                <div class="tl-bar tl-bar-main">${segments}${gridLines}</div>
                <div class="tl-time-labels">${labels}</div>
            </div>
            <div class="tl-legend-inline">
                <span class="tl-leg-ok"><span class="tl-leg-dot tl-leg-dot-ok"></span>OK</span>
                <span class="tl-leg-ng"><span class="tl-leg-dot tl-leg-dot-ng"></span>NG</span>
            </div>
            ${memberList}
        </div>`;
}

function closeDateModal() {
    document.getElementById('dateModal').classList.add('hidden');
    // タブメニューを再表示
    document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
    state.selectedDate = null;
    renderCalendar();
}

// ============================================================================
// Contextual Onboarding ヘルパー
// ============================================================================

/**
 * カレンダー詳細画面のヒントバナー表示制御
 * 条件: ×ボタンでグローバルに閉じていない場合に表示
 */
function _updateCalHintBanner(calId) {
    const banner = document.getElementById('calHintBanner');
    if (!banner) return;

    // グローバルで閉じた場合は表示しない
    if (localStorage.getItem('calHintDismissed')) {
        banner.classList.add('hidden');
        return;
    }

    banner.classList.remove('hidden');
}

/**
 * ヒントバナーを非表示にする（NG/OK登録時に呼ばれる）
 */
function _dismissCalHintBanner() {
    const banner = document.getElementById('calHintBanner');
    if (banner) banner.classList.add('hidden');
    localStorage.setItem('calHintDismissed', 'true');
}

/**
 * 日付モーダルの初回ヒント表示
 * NG/OK登録が完了するまで表示し続ける（フェードアウトしない）
 */
function _showDateModalHintOnce() {
    const hint = document.getElementById('dateModalHint');
    if (!hint) return;

    // 既にNG/OK登録が完了していれば非表示
    if (localStorage.getItem('dateModalHintCompleted')) {
        hint.classList.add('hidden');
        return;
    }

    // 表示
    hint.classList.remove('hidden');
}

/**
 * 日付モーダルのヒントを非表示にする（NG/OK登録完了時に呼ばれる）
 */
function _dismissDateModalHint() {
    const hint = document.getElementById('dateModalHint');
    if (hint) hint.classList.add('hidden');
    localStorage.setItem('dateModalHintCompleted', 'true');
}

function switchMode(mode) {
    state.activeMode = mode;
    document.querySelectorAll('.ng-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(mode === 'allDay' ? 'modeAllDay' : 'modeDateToTime').classList.add('active');
    document.getElementById('allDayPanel').classList.toggle('hidden', mode !== 'allDay');
    document.getElementById('dateToTimePanel').classList.toggle('hidden', mode !== 'dateToTime');
    // 詳細設定内のコピーボタンをモードに応じて切り替え
    const batchAllDay = document.getElementById('batchAllDayBtn');
    const batchTime = document.getElementById('batchTimeNgBtn');
    if (batchAllDay) batchAllDay.classList.toggle('hidden', mode !== 'allDay');
    if (batchTime) batchTime.classList.toggle('hidden', mode !== 'dateToTime');
}

// ============================================================================
// グローバル空間への関数エクスポート（HTML側からのonclick等での呼び出し用）
// ============================================================================
window.openCalendar = openCalendar;
window.toggleAllDayNG = toggleAllDayNG;
window.openTimeModal = openTimeModal;

window.applyBatchNG = applyBatchNG;
window.cancelBatchMode = cancelBatchMode;
window.sendProposal = sendProposal;

// ============================================================================
// Proposal
// ============================================================================
function sendProposal() {
    const startTime = document.getElementById('proposeStartTime').value;
    const endTime = document.getElementById('proposeEndTime').value;
    if (!startTime) {
        document.getElementById('proposeStartTime').style.borderColor = 'var(--ng)';
        setTimeout(() => document.getElementById('proposeStartTime').style.borderColor = '', 1500);
        return;
    }
    if (endTime && endTime <= startTime) { showToast('終了時間は開始より後にしてください'); return; }

    const cal = getCal(); if (!cal) return;
    const eventId = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    // Initialize votes object - proposer is automatically 'ok'
    const initialVotes = {};
    initialVotes[MY_USER.id] = 'ok';

    state.notifications.unshift({
        id: eventId, from: MY_USER.id, calId: cal.id, calName: cal.name,
        date: state.selectedDate, startTime, endTime: endTime || '',
        timestamp: new Date().toISOString(), votes: initialVotes
    });

    // Notification はローカル保存だが、提案されたイベントデータ自体はカレンダーにくっつけるか、
    // または proposals コレクションで管理するのが望ましい。
    // ここでは MVP として Notification に入れて Local で保つ（他ユーザーに同期させるなら Firestore 化必須）。
    saveLocal();

    // 他のユーザーにも表示させるには、別途 Firestore に events/proposals として addDoc すべきだが、
    // 現在の implementation では Notifications 配列で済ませている部分があるため、
    // ひとまずカレンダー自体に proposals 配列を持たせる形で同期する簡易対応を行う。
    if (!cal.proposals) cal.proposals = [];
    cal.proposals.push({
        id: eventId, from: MY_USER.id, fromName: MY_USER.name,
        date: state.selectedDate, startTime, endTime: endTime || '',
        timestamp: new Date().toISOString(), votes: initialVotes
    });
    saveCalendarToFirestore(cal);

    updateNotifBadge();
    showToast('提案を送信しました！');
    closeDateModal();
}

// ============================================================================
// Actions
// ============================================================================
function applyNgToAllCalendars(ds, callback) {
    const syncCheckbox = document.getElementById('syncOtherCalsCheckbox');
    const doSync = syncCheckbox && syncCheckbox.checked;

    if (!doSync) {
        const cal = getCal();
        if (cal) {
            callback(cal, ds);
            saveScheduleFieldToFirestore(cal, ds);
        }
    } else {
        Object.values(state.calendars).forEach(cal => {
            if (cal.members && cal.members.includes(MY_USER.id)) {
                // 期間指定カレンダーの場合は範囲内かチェック
                if (cal.type === 'range') {
                    if (!cal.rangeStart || !cal.rangeEnd || ds < cal.rangeStart || ds > cal.rangeEnd) {
                        return;
                    }
                }
                callback(cal, ds);
                saveScheduleFieldToFirestore(cal, ds);
            }
        });
    }
}

function toggleAllDayNG(ds) {
    const curCal = getCal();
    if (!curCal) return;
    ensureSched(curCal, ds);
    const targetState = !curCal.schedules[ds][MY_USER.id].isAllDay;

    // 繰り返しチェックがONなら同じ曜日の未来日付にも適用
    const repeatCheckbox = document.getElementById('repeatNgCheckbox');
    const doRepeat = repeatCheckbox && repeatCheckbox.checked;
    const datesToApply = doRepeat ? getRecurringDates(ds) : [ds];

    datesToApply.forEach(targetDs => {
        applyNgToAllCalendars(targetDs, (cal, d) => {
            ensureSched(cal, d);
            cal.schedules[d][MY_USER.id].isAllDay = targetState;
            if (!targetState) cal.schedules[d][MY_USER.id].times = [];
            cleanupSched(cal, d);
        });
    });
    _dismissCalHintBanner();
    _dismissDateModalHint();
    closeDateModal(); renderCalendar();
    if (targetState) {
        if (doRepeat && datesToApply.length > 1) {
            showToast(`${datesToApply.length}件のNG設定を登録しました`);
        } else {
            showToast('NG設定を登録しました');
        }
    } else {
        if (doRepeat && datesToApply.length > 1) {
            showToast(`${datesToApply.length}件のNG設定をキャンセルしました`);
        } else {
            showToast('NG設定をキャンセルしました');
        }
    }
}

/**
 * 時間帯NGをキャンセルする（その日の時間帯NGをすべて削除）
 * 繰り返しチェックがONの場合は同曜日の未来日付も一括解除
 */
function cancelTimeNG(ds) {
    const repeatCheckbox = document.getElementById('repeatNgCheckbox');
    const doRepeat = repeatCheckbox && repeatCheckbox.checked;
    const datesToApply = doRepeat ? getRecurringDates(ds) : [ds];

    datesToApply.forEach(targetDs => {
        applyNgToAllCalendars(targetDs, (cal, d) => {
            ensureSched(cal, d);
            cal.schedules[d][MY_USER.id].isAllDay = false;
            cal.schedules[d][MY_USER.id].times = [];
            cleanupSched(cal, d);
        });
    });
    closeDateModal(); renderCalendar();
    if (doRepeat && datesToApply.length > 1) {
        showToast(`${datesToApply.length}件のNG設定をキャンセルしました`);
    } else {
        showToast('NG設定をキャンセルしました');
    }
}

function openTimeModal(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    document.getElementById('modalDateDisplay').textContent = `${y}年${m}月${d}日`;
    document.getElementById('timeModalError').textContent = '';

    // OK/NGモードをNGにリセット
    state.timeModalMode = 'ng';

    // 現在のスケジュールの時間帯をコピーして編集用配列にセット
    const cal = getCal();
    state.editingTimeNgs = [];
    if (cal && cal.schedules[ds] && cal.schedules[ds][MY_USER.id] && cal.schedules[ds][MY_USER.id].times) {
        state.editingTimeNgs = JSON.parse(JSON.stringify(cal.schedules[ds][MY_USER.id].times));
    }
    renderEditingTimeNgs();

    // バッチモード時はモーダルのタイトルと保存ボタンを差別化
    const modalTitle = document.getElementById('timeModalTitle');
    const saveBtn = document.getElementById('saveTimeModal');
    if (state._batchAfterTimeSave) {
        if (modalTitle) modalTitle.textContent = '他の日にも設定する時間帯';
        if (saveBtn) saveBtn.textContent = '設定して日付を選択';
    } else {
        if (saveBtn) saveBtn.textContent = '設定を保存';
    }

    // OK/NGトグルのUI状態を更新
    updateTimeModalMode();

    document.getElementById('timeModal').classList.remove('hidden');
}

function renderEditingTimeNgs() {
    const list = document.getElementById('existingTimeNgs');
    list.innerHTML = '';
    const isOk = state.timeModalMode === 'ok';
    if (!state.editingTimeNgs || state.editingTimeNgs.length === 0) {
        const emptyMsg = isOk ? '現在設定されているOK時間帯はありません' : '現在設定されているNG時間帯はありません';
        list.innerHTML = `<div style="color:var(--text-sub); font-size:0.85rem; text-align:center;">${emptyMsg}</div>`;
        return;
    }

    // OKモードなら緑系、NGモードなら赤系の色
    const bgColor = isOk ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    const fgColor = isOk ? 'var(--ok)' : 'var(--ng)';

    state.editingTimeNgs.forEach((t, i) => {
        const item = document.createElement('div');
        item.style.cssText = `display:flex; justify-content:space-between; align-items:center; background:${bgColor}; padding:8px 12px; border-radius:6px; color:${fgColor}; font-weight:bold;`;
        item.innerHTML = `
            <span>${t.start} 〜 ${t.end}</span>
            <button class="icon-btn" onclick="removeEditingTimeNg(${i})" style="color:${fgColor}; width:28px; height:28px;"><i class="fa-solid fa-trash"></i></button>
        `;
        list.appendChild(item);
    });
}

window.removeEditingTimeNg = function (i) {
    if (state.editingTimeNgs) {
        state.editingTimeNgs.splice(i, 1);
        renderEditingTimeNgs();
    }
}

function closeTimeModal() {
    document.getElementById('timeModal').classList.add('hidden');
    // 「設定を保存」ボタンのハイライトをリセット
    const saveBtn = document.getElementById('saveTimeModal');
    if (saveBtn) {
        saveBtn.style.background = '';
        saveBtn.style.color = '';
        saveBtn.style.borderColor = '';
        saveBtn.style.fontWeight = '';
        saveBtn.style.boxShadow = '';
    }
    // バッチモードフラグをクリア（キャンセル時に残らないように）
    state._batchAfterTimeSave = false;
}

window.addTimeNgToList = function () {
    const start = document.getElementById('startTime').value;
    const end = document.getElementById('endTime').value;
    const err = document.getElementById('timeModalError');
    if (!start || !end) { err.textContent = '両方選んでください'; return; }
    if (start >= end) { err.textContent = '終了は開始より後に'; return; }

    state.editingTimeNgs.push({ start, end });

    // 時間帯をソート
    state.editingTimeNgs.sort((a, b) => a.start.localeCompare(b.start));

    err.textContent = '';
    renderEditingTimeNgs();

    // 「設定を保存」ボタンをハイライト（OKモードなら緑、NGモードならアクセント色）
    const saveBtn = document.getElementById('saveTimeModal');
    const isOk = state.timeModalMode === 'ok';
    if (saveBtn) {
        saveBtn.style.background = isOk ? 'var(--ok)' : 'var(--accent)';
        saveBtn.style.color = '#fff';
        saveBtn.style.borderColor = isOk ? 'var(--ok)' : 'var(--accent)';
        saveBtn.style.fontWeight = '700';
        saveBtn.style.boxShadow = isOk ? '0 0 12px rgba(34,197,94,0.5)' : '0 0 12px rgba(37,99,235,0.5)';
    }
}

window.saveTimeNG = function () {
    if (!state.editingTimeNgs || state.editingTimeNgs.length === 0) {
        const emptyMsg = state.timeModalMode === 'ok' ? 'OK時間帯を追加してください' : 'NG時間帯を追加してください';
        showToast(emptyMsg, 'error');
        return;
    }

    // OKモードの場合は補集合をNG時間帯に変換する
    const isOkMode = state.timeModalMode === 'ok';
    const savedTimes = isOkMode
        ? convertOkToNg(state.editingTimeNgs)
        : JSON.parse(JSON.stringify(state.editingTimeNgs));

    // フラグをcloseTimeModalの前に退避（closeTimeModalがフラグをクリアするため）
    const shouldBatch = state._batchAfterTimeSave;
    closeTimeModal();

    // バッチモードフラグがある場合は、当日には保存せずバッチモードに遷移
    // 「適用」で全日付（当日含む）に一括保存する
    if (shouldBatch) {
        const batchOriginDate = state.selectedDate; // closeDateModalがnullにする前に退避
        closeDateModal();
        // バッチモード開始（当日を自動選択状態にする）
        state.batchMode = true;
        state.batchType = 'time';
        state.batchTime = savedTimes;
        state.batchSelectedDates = new Set([batchOriginDate]);
        // バッチモードUIを表示
        document.getElementById('batchModeBanner')?.classList.remove('hidden');
        const timeDisp = savedTimes.map(t => t.start + '〜' + t.end).join(', ');
        document.getElementById('batchTimeDisplay').textContent = timeDisp;
        document.getElementById('batchCountHeader').textContent = '1件選択中';
        // ヘッダー切替
        document.getElementById('backToList')?.classList.add('hidden');
        document.getElementById('batchHeaderCancel')?.classList.remove('hidden');
        document.getElementById('calHeaderActions')?.classList.add('hidden');
        document.getElementById('batchHeaderActions')?.classList.remove('hidden');
        document.getElementById('calDetailName')?.classList.add('hidden');
        document.getElementById('calDetailRange')?.classList.add('hidden');
        document.querySelector('.tab-bar').style.display = 'none';
        document.getElementById('markCompleteBtn')?.classList.add('hidden');
        renderCalendar();
        showToast('他の日を選択してください');
    } else {
        // 通常モード
        // 繰り返しチェックがONなら同じ曜日の未来日付にも適用
        const repeatCheckbox = document.getElementById('repeatNgCheckbox');
        const doRepeat = repeatCheckbox && repeatCheckbox.checked;
        const datesToApply = doRepeat ? getRecurringDates(state.selectedDate) : [state.selectedDate];

        // OKモードで時間帯が全てカバーされている場合は終日NGとして設定
        const cal = getCal();
        const tStart = toMin(cal ? (cal.timeStart || '00:00') : '00:00');
        const tEnd = toMin(cal ? ((cal.timeEnd === '23:59' ? '24:00' : cal.timeEnd) || '24:00') : '24:00');
        const isFullDayNg = isOkMode && savedTimes.length === 1 && toMin(savedTimes[0].start) <= tStart && toMin(savedTimes[0].end) >= tEnd;

        datesToApply.forEach(targetDs => {
            applyNgToAllCalendars(targetDs, (cal, d) => {
                ensureSched(cal, d);
                if (isFullDayNg) {
                    // OK時間帯がゼロ（＝全部NG）の場合は終日NGにする
                    cal.schedules[d][MY_USER.id].isAllDay = true;
                    cal.schedules[d][MY_USER.id].times = [];
                } else {
                    cal.schedules[d][MY_USER.id].isAllDay = false;
                    cal.schedules[d][MY_USER.id].times = JSON.parse(JSON.stringify(savedTimes));
                }
                cleanupSched(cal, d);
            });
        });
        _dismissCalHintBanner();
        _dismissDateModalHint();
        closeDateModal(); renderCalendar();
        if (isOkMode) {
            // OKモードの場合のトーストメッセージ
            if (doRepeat && datesToApply.length > 1) {
                showToast(`${datesToApply.length}件のOK時間帯を設定しました（それ以外はNGになります）`);
            } else {
                showToast('OK時間帯を設定しました（この日のOK以外はNGになります）');
            }
        } else {
            if (doRepeat && datesToApply.length > 1) {
                showToast(`${datesToApply.length}件のNG設定を登録しました`);
            } else {
                showToast('NG設定を登録しました');
            }
        }
    }
}

/**
 * OK時間帯をNG時間帯（補集合）に変換する
 * 例: カレンダー対象時間 10:00-24:00、OK入力 13:00-17:00
 * → NG時間帯 = [10:00-13:00, 17:00-24:00]
 */
function convertOkToNg(okTimes) {
    const cal = getCal();
    const tStart = toMin(cal ? (cal.timeStart || '00:00') : '00:00');
    const tEnd = toMin(cal ? ((cal.timeEnd === '23:59' ? '24:00' : cal.timeEnd) || '24:00') : '24:00');

    // OKタイムをソートしてマージ（重複する時間帯を統合）
    let sorted = okTimes.map(t => ({ s: toMin(t.start), e: toMin(t.end) }))
                        .sort((a, b) => a.s - b.s);
    let merged = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i].s <= last.e) {
            last.e = Math.max(last.e, sorted[i].e);
        } else {
            merged.push({ ...sorted[i] });
        }
    }

    // 補集合（NG部分）を計算
    let ngTimes = [];
    let cursor = tStart;
    for (const ok of merged) {
        const okStart = Math.max(tStart, ok.s);
        const okEnd = Math.min(tEnd, ok.e);
        if (cursor < okStart) {
            ngTimes.push({ start: fromMin(cursor), end: fromMin(okStart) });
        }
        cursor = Math.max(cursor, okEnd);
    }
    if (cursor < tEnd) {
        ngTimes.push({ start: fromMin(cursor), end: fromMin(tEnd) });
    }
    return ngTimes;
}

/**
 * 時間モーダルのOK/NGモードに応じてUIを更新する
 */
function updateTimeModalMode() {
    const isOk = state.timeModalMode === 'ok';
    const ngBtn = document.getElementById('timeModalModeNG');
    const okBtn = document.getElementById('timeModalModeOK');

    const listLabel = document.getElementById('timeModalListLabel');
    const title = document.getElementById('timeModalTitle');
    const addLabel = document.getElementById('timeModalAddLabel');
    const addBtnText = document.getElementById('addTimeBtnText');
    const listBox = document.getElementById('timeModalListBox');

    if (isOk) {
        // OKモード: 緑系の表示
        ngBtn.style.background = 'transparent';
        ngBtn.style.color = 'var(--text-sub)';
        okBtn.style.background = 'var(--ok)';
        okBtn.style.color = '#fff';

        if (listLabel) listLabel.textContent = 'のOK時間帯';
        if (title) title.textContent = '時間指定OKの設定';
        if (addLabel) addLabel.textContent = 'OK時間帯を追加';
        if (addBtnText) addBtnText.textContent = 'OK時間帯を追加';
        if (listBox) listBox.style.borderColor = 'rgba(34, 197, 94, 0.3)';
    } else {
        // NGモード: 赤系の表示
        ngBtn.style.background = 'var(--ng)';
        ngBtn.style.color = '#fff';
        okBtn.style.background = 'transparent';
        okBtn.style.color = 'var(--text-sub)';

        if (listLabel) listLabel.textContent = 'のNG時間帯';
        if (title) title.textContent = '時間指定NGの設定';
        if (addLabel) addLabel.textContent = 'NG時間帯を追加';
        if (addBtnText) addBtnText.textContent = 'NG時間帯を追加';
        if (listBox) listBox.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }

    // 入力中の時間帯リストをクリアして再描画（モード切り替え時はリセットが自然）
    state.editingTimeNgs = [];
    renderEditingTimeNgs();

    // 保存ボタンのハイライトをリセット
    const saveBtn = document.getElementById('saveTimeModal');
    if (saveBtn) {
        saveBtn.style.background = '';
        saveBtn.style.color = '';
        saveBtn.style.borderColor = '';
        saveBtn.style.fontWeight = '';
        saveBtn.style.boxShadow = '';
    }
}



function applyBatchNG() {
    if (!state.batchSelectedDates.size) {
        showToast('日付を選択してください', 'error');
        return;
    }

    const count = state.batchSelectedDates.size;
    state.batchSelectedDates.forEach(ds => {
        applyNgToAllCalendars(ds, (cal, d) => {
            ensureSched(cal, d);
            if (state.batchType === 'allday') {
                cal.schedules[d][MY_USER.id].isAllDay = true;
                cal.schedules[d][MY_USER.id].times = [];
            } else {
                cal.schedules[d][MY_USER.id].isAllDay = false;
                // state.batchTime は配列（NGコピー時）またはオブジェクト（手動バッチ時）の可能性がある
                if (Array.isArray(state.batchTime)) {
                    cal.schedules[d][MY_USER.id].times = state.batchTime.map(t => ({ start: t.start, end: t.end }));
                } else {
                    cal.schedules[d][MY_USER.id].times = [{ start: state.batchTime.start, end: state.batchTime.end }];
                }
            }
            cleanupSched(cal, d);
        });
    });

    cancelBatchMode();
    showToast(`${count}件のNG設定を登録しました`);
}

function cancelBatchMode() {
    state.batchMode = false; state.batchSelectedDates = new Set();
    document.getElementById('batchModeBanner').classList.add('hidden');

    // UIを通常モードに復元
    document.getElementById('backToList').classList.remove('hidden');
    document.getElementById('batchHeaderCancel')?.classList.add('hidden');
    document.getElementById('calHeaderActions').classList.remove('hidden');
    document.getElementById('batchHeaderActions').classList.add('hidden');
    document.getElementById('calDetailName').classList.remove('hidden');
    document.getElementById('calDetailRange').classList.remove('hidden');
    document.getElementById('calLegend').innerHTML = '<span><div class="dot dot-ok"></div> 終日OK!</span><span><div class="dot dot-partial"></div> 一部OK</span>';

    document.querySelector('.tab-bar').style.display = '';
    renderCalendar();
}

window.deleteTimeNG = function (ds, idx) {
    const curCal = getCal(); if (!curCal) return;
    const my = curCal.schedules[ds]?.[MY_USER.id];
    if (!my || !my.times || !my.times[idx]) return;
    // 削除対象の時間帯を特定
    const targetTime = my.times[idx];
    // 全参加カレンダーから同じ時間帯を削除（NG同期）
    Object.values(state.calendars).forEach(cal => {
        if (!cal.members || !cal.members.includes(MY_USER.id)) return;
        if (cal.type === 'range' && (!cal.rangeStart || !cal.rangeEnd || ds < cal.rangeStart || ds > cal.rangeEnd)) return;
        const sched = cal.schedules[ds]?.[MY_USER.id];
        if (!sched || !sched.times) return;
        sched.times = sched.times.filter(t => !(t.start === targetTime.start && t.end === targetTime.end));
        cleanupSched(cal, ds);
        saveScheduleFieldToFirestore(cal, ds);
    });
    renderCalendar(); openDateModal(ds);
}

// ============================================================================
// バージョン更新チェック（version.jsonポーリング方式）
// ============================================================================
let _lastVersionCheck = 0;
async function checkVersionFromServer() {
    // 既に更新通知が出ている場合はスキップ
    if (state.swUpdateAvailable) return;
    // 30秒以内の再チェックはスキップ
    const now = Date.now();
    if (now - _lastVersionCheck < 30 * 1000) return;
    _lastVersionCheck = now;
    try {
        const res = await fetch(`./version.json?t=${now}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.version && data.version !== APP_VERSION) {
            // サーバー側に新しいバージョンがある → 通知を表示
            state.swUpdateAvailable = true;
            renderNotifications();
            showToast('新しいバージョンが利用可能です！');
        }
    } catch (e) {
        console.log('Version check skipped:', e.message);
    }
}
// アプリがフォアグラウンドに戻ったときもチェック
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && MY_USER) {
        checkVersionFromServer();
    }
});

// ============================================================================
// Notifications
// ============================================================================
function renderNotifications() {
    const list = document.getElementById('notificationList');
    const hasSwUpdate = state.swUpdateAvailable === true;
    document.getElementById('emptyNotifications').style.display = (state.notifications.length || hasSwUpdate) ? 'none' : 'block';
    list.querySelectorAll('.notif-card').forEach(c => c.remove());

    // 全削除ボタン
    const clearAllBtn = document.getElementById('clearAllNotifsBtn');
    if (clearAllBtn) {
        clearAllBtn.onclick = () => {
            // 削除対象のIDをdismissedに追加（Firestore同期で復活防止）
            state.notifications.forEach(n => {
                // 未投票の提案通知は残す（ただし元提案が取り消されていれば削除対象）
                const cal = state.calendars[n.calId];
                const proposalStillExists = cal && cal.proposals &&
                    cal.proposals.some(p => String(p.id) === String(n.id));
                const shouldKeep = n.type !== 'completion' && n.votes && !n.votes[MY_USER.id] && proposalStillExists;
                if (!shouldKeep) {
                    state.dismissedNotifIds.add(String(n.id));
                }
            });
            state.notifications = state.notifications.filter(n => {
                // 未投票かつ元提案が存在する通知のみ残す
                if (n.type !== 'completion' && n.votes && !n.votes[MY_USER.id]) {
                    const cal = state.calendars[n.calId];
                    const proposalStillExists = cal && cal.proposals &&
                        cal.proposals.some(p => String(p.id) === String(n.id));
                    return proposalStillExists;
                }
                return false;
            });
            saveLocal();
            renderNotifications();
            if (state.notifications.length > 0) {
                showToast('未回答以外の通知を削除しました');
            } else {
                showToast('全ての通知を削除しました');
            }
        };
    }

    // SW更新検知通知カード（通常の通知の前に表示）
    if (hasSwUpdate) {
        const vCard = document.createElement('div');
        vCard.className = 'notif-card';
        vCard.style.position = 'relative';
        vCard.style.cursor = 'pointer';
        vCard.style.borderLeft = '3px solid var(--accent)';
        vCard.innerHTML = `
            <button class="notif-dismiss" style="position:absolute; top:2px; right:2px; background:none; border:none; color:var(--text-sub); font-size:1.1rem; cursor:pointer; padding:10px 14px; z-index:2; opacity:0.7;" title="削除"><i class="fa-solid fa-xmark"></i></button>
            <div class="notif-header" style="padding-right:18px; margin-top:-6px;"><span class="notif-user"><i class="fa-solid fa-arrow-up-from-bracket" style="margin-right:4px;"></i>アップデート</span></div>
            <div class="notif-body">新しいバージョンが利用可能です！</div>
            <div style="font-size:0.75rem; color:var(--text-sub); margin-top:4px;">タップして「アプリを最新版に更新」を実行してください</div>
        `;
        // タップで設定画面へ遷移
        vCard.addEventListener('click', (e) => {
            if (e.target.closest('.notif-dismiss')) return;
            document.getElementById('openSettingsBtn')?.click();
        });
        // ×ボタンで通知を消す
        vCard.querySelector('.notif-dismiss')?.addEventListener('click', (e) => {
            e.stopPropagation();
            state.swUpdateAvailable = false;
            renderNotifications();
        });
        list.appendChild(vCard);
    }

    state.notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).forEach(n => {
        const card = document.createElement('div');
        card.className = 'notif-card';
        const ts = getTimeAgo(new Date(n.timestamp));

        // completion タイプの通知
        if (n.type === 'completion') {
            const dismissHtml = `<button class="notif-dismiss" style="position:absolute; top:2px; right:2px; background:none; border:none; color:var(--text-sub); font-size:1.1rem; cursor:pointer; padding:10px 14px; z-index:2; opacity:0.7;" title="削除"><i class="fa-solid fa-xmark"></i></button>`;
            card.style.position = 'relative';
            card.innerHTML = `
                ${dismissHtml}
                <div class="notif-header" style="padding-right:18px; margin-top:-6px;"><span class="notif-user"><i class="fa-solid fa-circle-check" style="color:var(--ok); margin-right:4px;"></i>全員完了</span><span class="notif-time">${ts}</span></div>
                <div class="notif-body">${esc(n.message || '')}</div>
                <div class="notif-cal-name"><i class="fa-solid fa-calendar" style="margin-right:4px;"></i>${esc(n.calName || '')}</div>
            `;
            card.style.cursor = 'pointer';
            card.addEventListener('click', (e) => {
                if (e.target.closest('.notif-dismiss')) return;
                openCalendar(n.calId);
                switchTab('tabCalendar');
            });
            // ×ボタンの処理
            card.querySelector('.notif-dismiss')?.addEventListener('click', (e) => {
                e.stopPropagation();
                state.dismissedNotifIds.add(String(n.id)); // Firestore同期で復活防止
                state.notifications = state.notifications.filter(nn => String(nn.id) !== String(n.id));
                saveLocal();
                renderNotifications();
            });
            list.appendChild(card);
            return;
        }

        // proposals 通知（簡素化版）
        // 元の提案がカレンダーから削除されているかチェック
        const sourceCal = state.calendars[n.calId];
        const proposalExists = sourceCal && sourceCal.proposals &&
            sourceCal.proposals.some(p => String(p.id) === String(n.id));

        // 🏅 全員OKで確定した提案は「確定」として表示
        if (proposalExists && sourceCal) {
            const matchedProposal = sourceCal.proposals.find(p => String(p.id) === String(n.id));
            const members = sourceCal.members || [];
            const votes = (matchedProposal && matchedProposal.votes) || {};
            const isConfirmed = members.length > 0 && members.every(uid => votes[uid] === 'ok');

            if (isConfirmed) {
                const [cy, cm, cd] = n.date.split('-').map(Number);
                let cTimeStr = n.startTime;
                if (n.endTime) cTimeStr += ` 〜 ${n.endTime}`;
                const dismissHtml = `<button class="notif-dismiss" style="position:absolute; top:2px; right:2px; background:none; border:none; color:var(--text-sub); font-size:1.1rem; cursor:pointer; padding:10px 14px; z-index:2; opacity:0.7;" title="削除"><i class="fa-solid fa-xmark"></i></button>`;
                card.style.position = 'relative';
                card.style.cursor = 'pointer';
                card.style.borderLeft = '3px solid #FF4081';
                card.innerHTML = `
                    ${dismissHtml}
                    <div class="notif-header" style="padding-right:18px; margin-top:-6px;"><span class="notif-user" style="color:#FF4081;"><i class="fa-solid fa-trophy" style="margin-right:4px;"></i>予定確定！</span><span class="notif-time">${ts}</span></div>
                    <div class="notif-body" style="font-weight:600;">${cy}年${cm}月${cd}日 ${cTimeStr}</div>
                    <div class="notif-cal-name"><i class="fa-solid fa-calendar" style="margin-right:4px;"></i>${esc(n.calName || '')} ─ 全員参加OK！</div>
                `;
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.notif-dismiss')) return;
                    n.read = true;
                    saveLocal();
                    showVoteDetailModal(n);
                });
                card.querySelector('.notif-dismiss')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.dismissedNotifIds.add(String(n.id));
                    state.notifications = state.notifications.filter(nn => String(nn.id) !== String(n.id));
                    saveLocal();
                    renderNotifications();
                });
                list.appendChild(card);
                return;
            }
        }

        if (!proposalExists && n.type !== 'completion') {
            // 提案が取り消されている → 取り消し済み表示
            card.style.position = 'relative';
            card.style.opacity = '0.6';
            card.innerHTML = `
                <button class="notif-dismiss" style="position:absolute; top:2px; right:2px; background:none; border:none; color:var(--text-sub); font-size:1.1rem; cursor:pointer; padding:10px 14px; z-index:2; opacity:0.7;" title="削除"><i class="fa-solid fa-xmark"></i></button>
                <div class="notif-header" style="padding-right:18px; margin-top:-6px;"><span class="notif-user" style="color:var(--text-sub);"><i class="fa-solid fa-ban" style="margin-right:4px;"></i>提案取り消し済み</span><span class="notif-time">${ts}</span></div>
                <div class="notif-body" style="color:var(--text-sub); text-decoration:line-through;">この提案は取り消されました</div>
                <div class="notif-cal-name"><i class="fa-solid fa-calendar" style="margin-right:4px;"></i>${esc(n.calName || '')}</div>
            `;
            card.querySelector('.notif-dismiss')?.addEventListener('click', (e) => {
                e.stopPropagation();
                state.dismissedNotifIds.add(String(n.id));
                state.notifications = state.notifications.filter(nn => String(nn.id) !== String(n.id));
                saveLocal();
                renderNotifications();
            });
            list.appendChild(card);
            return;
        }

        const userName = getMemberName(n.from, n.calId);
        // getMemberNameがUIDを返した場合、通知に保存済みのfromNameをフォールバックに使用
        const displayName = (userName === n.from && n.fromName) ? n.fromName : userName;
        const myVote = (n.votes || {})[MY_USER.id];
        let voteBadge = '<span style="color:var(--text-sub);"><i class="fa-solid fa-circle-exclamation" style="margin-right:2px;"></i> 未回答</span>';
        if (myVote === 'ok') voteBadge = '<span style="color:#22c55e;"><i class="fa-solid fa-circle" style="font-size:0.6rem; margin-right:4px;"></i> 参加</span>';
        if (myVote === 'ng') voteBadge = '<span style="color:#ef4444;"><i class="fa-solid fa-circle" style="font-size:0.6rem; margin-right:4px;"></i> 不参加</span>';

        const [ny, nm, nd] = n.date.split('-').map(Number);
        let timeStr = n.startTime;
        if (n.endTime) timeStr += ` 〜 ${n.endTime}`;

        // 未投票の通知は×ボタンを非表示
        const dismissHtml = myVote ? `<button class="notif-dismiss" style="position:absolute; top:2px; right:2px; background:none; border:none; color:var(--text-sub); font-size:1.1rem; cursor:pointer; padding:10px 14px; z-index:2; opacity:0.7;" title="削除"><i class="fa-solid fa-xmark"></i></button>` : '';

        card.style.position = 'relative';
        card.style.cursor = 'pointer';
        card.innerHTML = `
            ${dismissHtml}
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div class="notif-header" style="padding-right:30px;"><span class="notif-user"><i class="fa-solid fa-envelope" style="margin-right:4px;"></i>集合の提案</span><span class="notif-time">${ts}</span></div>
                    <div class="notif-body">${ny}年${nm}月${nd}日 ${timeStr}</div>
                    <div class="notif-cal-name"><i class="fa-solid fa-calendar" style="margin-right:4px;"></i>${esc(n.calName || '')}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${voteBadge}
                    <i class="fa-solid fa-chevron-right" style="color:var(--text-sub); font-size:0.8rem;"></i>
                </div>
            </div>
        `;

        // タップで投票詳細モーダルを開く（×ボタン以外）
        card.addEventListener('click', (e) => {
            if (e.target.closest('.notif-dismiss')) return;
            n.read = true;
            saveLocal();
            showVoteDetailModal(n);
        });

        // ×ボタンの処理
        card.querySelector('.notif-dismiss')?.addEventListener('click', (e) => {
            e.stopPropagation();
            state.dismissedNotifIds.add(String(n.id)); // Firestore同期で復活防止
            state.notifications = state.notifications.filter(nn => String(nn.id) !== String(n.id));
            saveLocal();
            renderNotifications();
        });

        list.appendChild(card);
    });

    updateNotifBadge();
}

// ============================================================================
// 投票詳細モーダル
// ============================================================================
function showVoteDetailModal(notification) {
    const n = notification;
    const cal = state.calendars[n.calId];
    if (!cal) return;

    const votes = n.votes || {};
    const members = cal.members || [];
    const myVote = votes[MY_USER.id];
    const [ny, nm, nd] = n.date.split('-').map(Number);
    let timeStr = n.startTime;
    if (n.endTime) timeStr += ` 〜 ${n.endTime}`;

    // 投票集計
    let okCount = 0, ngCount = 0;
    Object.values(votes).forEach(v => { if (v === 'ok') okCount++; if (v === 'ng') ngCount++; });
    const pendingCount = Math.max(0, members.length - okCount - ngCount);

    // メンバーリスト + 投票状態
    let memberListHtml = members.map(uid => {
        const name = getMemberName(uid, n.calId);
        const vote = votes[uid];
        let badge = '<i class="fa-solid fa-hourglass-half" style="margin-right:2px; font-size:0.8rem;"></i> 未回答';
        if (vote === 'ok') badge = '<i class="fa-solid fa-circle" style="font-size:0.6rem; margin-right:4px; color:#22c55e;"></i> 参加';
        if (vote === 'ng') badge = '<i class="fa-solid fa-circle" style="font-size:0.6rem; margin-right:4px; color:#ef4444;"></i> 不参加';
        return `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--glass-border);">
            <span>${esc(name)}</span><span>${badge}</span>
        </div>`;
    }).join('');

    // 投票ボタン（未投票時はどちらもghost、投票済みは選択された方を強調）
    const okBtnClass = myVote === 'ok' ? 'btn-primary' : 'btn-ghost';
    const ngBtnClass = myVote === 'ng' ? 'btn-ghost' : 'btn-ghost';
    const isOkActive = myVote === 'ok' ? 'background:var(--accent); color:white;' : 'border:1px solid var(--glass-border);';
    const isNgActive = myVote === 'ng' ? 'background:#ef4444; color:white;' : 'border:1px solid var(--glass-border);';

    const modalContent = `
        <h3 style="margin:0 0 12px; font-size:1.2rem;"><i class="fa-solid fa-envelope" style="margin-right:6px;"></i>集合の提案</h3>
        <div style="font-size:1.05rem; margin-bottom:8px;">${ny}年${nm}月${nd}日 ${timeStr}</div>
        <div style="color:var(--text-sub); margin-bottom:16px;"><i class="fa-solid fa-calendar" style="margin-right:4px;"></i>${esc(n.calName || '')}</div>

        <div style="display:flex; gap:8px; margin-bottom:16px;">
            <span class="vote-badge ok"><i class="fa-solid fa-circle-check"></i> 参加: ${okCount}</span>
            <span class="vote-badge ng"><i class="fa-solid fa-circle-xmark"></i> 不参加: ${ngCount}</span>
            <span class="vote-badge pending" style="color:var(--text-sub)"><i class="fa-solid fa-circle-question"></i> 未回答: ${pendingCount}</span>
        </div>

        <div style="margin-bottom:16px;">${memberListHtml}</div>

        <div style="display:flex; gap:8px; margin-bottom:12px;">
            <button id="voteOkBtn" class="${okBtnClass}" style="flex:1; padding:12px; border-radius:12px; ${isOkActive}">
                <i class="fa-solid fa-check"></i> 参加できる
            </button>
            <button id="voteNgBtn" class="${ngBtnClass}" style="flex:1; padding:12px; border-radius:12px; ${isNgActive}">
                <i class="fa-solid fa-xmark"></i> 参加できない
            </button>
        </div>

        ${n.from === MY_USER.id ? '<button id="cancelProposalBtn" class="btn-ghost" style="width:100%; border:1px dashed var(--glass-border); color:var(--text-sub); padding:10px;">提案を取り消す</button>' : ''}
    `;

    const modal = document.getElementById('voteDetailModal');
    const content = document.getElementById('voteDetailContent');
    if (modal && content) {
        content.innerHTML = modalContent;
        modal.classList.remove('hidden');
        // タブメニューを非表示
        document.querySelector('.tab-bar').classList.add('tab-bar-hidden');

        document.getElementById('voteOkBtn')?.addEventListener('click', () => submitVote(n, 'ok'));
        document.getElementById('voteNgBtn')?.addEventListener('click', () => submitVote(n, 'ng'));
        document.getElementById('cancelProposalBtn')?.addEventListener('click', () => cancelProposal(n));

        // モーダル外タップで閉じる＋タブバー再表示
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
                delete state._openVoteDetailId;
                document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
            }
        };

        // 「閉じる」ボタンのタブバー再表示（HTMLのonclickに加えてJS側でも確実に処理）
        const closeBtn = modal.querySelector('.btn-ghost[onclick]');
        if (closeBtn) {
            const origOnclick = closeBtn.onclick;
            closeBtn.onclick = (e) => {
                modal.classList.add('hidden');
                delete state._openVoteDetailId;
                document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');
            };
        }
    }

    state._openVoteDetailId = n.id;
}

function submitVote(notification, voteType) {
    const n = notification;
    const targetCalId = n.calId;
    const cal = state.calendars[targetCalId];
    if (!cal || !cal.proposals) return;

    const pIndex = cal.proposals.findIndex(p => String(p.id) === String(n.id));
    if (pIndex === -1) return;

    // Firestore側を更新
    if (!cal.proposals[pIndex].votes) cal.proposals[pIndex].votes = {};
    cal.proposals[pIndex].votes[MY_USER.id] = voteType;
    saveCalendarToFirestore(cal);

    // ローカル通知も更新
    const localNotif = state.notifications.find(nn => String(nn.id) === String(n.id));
    if (localNotif) {
        if (!localNotif.votes) localNotif.votes = {};
        localNotif.votes[MY_USER.id] = voteType;
        localNotif.read = true;
        saveLocal();
    }

    renderNotifications();
    showVoteDetailModal({ ...n, votes: cal.proposals[pIndex].votes });
    showToast(voteType === 'ok' ? '参加で回答しました' : '不参加で回答しました');
}

function cancelProposal(notification) {
    const n = notification;
    const targetCalId = n.calId;
    const cal = state.calendars[targetCalId];
    if (!cal) return;

    if (cal.proposals) {
        const pIndex = cal.proposals.findIndex(p => String(p.id) === String(n.id));
        if (pIndex !== -1) {
            cal.proposals.splice(pIndex, 1);
            saveCalendarToFirestore(cal);
        }
    }

    // ローカル通知リストからの削除
    state.dismissedNotifIds.add(String(n.id)); // Firestore同期で復活防止
    state.notifications = state.notifications.filter(nn => String(nn.id) !== String(n.id));
    saveLocal();

    // 投票詳細モーダルを閉じる
    const modal = document.getElementById('voteDetailModal');
    if (modal) modal.classList.add('hidden');
    delete state._openVoteDetailId;
    // タブメニューを再表示
    document.querySelector('.tab-bar').classList.remove('tab-bar-hidden');

    renderNotifications();
    showToast("提案を取り消しました。");
}

function updateNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    let unreadCount = state.notifications.filter(n => !n.read).length;
    // SW更新通知もカウント
    if (state.swUpdateAvailable) unreadCount++;
    if (unreadCount > 0) { badge.textContent = unreadCount; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
}

function getTimeAgo(d) {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return `${Math.floor(s / 86400)}日前`;
}

// ============================================================================
// My Page
// ============================================================================
function renderMyPage() {
    const avatarEl = document.getElementById('myAvatar');
    const nameEl = document.getElementById('myName');
    // アバター: Firebase AuthのphotoURLがあればプロフィール画像を表示
    if (avatarEl) {
        const user = window.auth && window.auth.currentUser;
        const photoURL = user && (user.photoURL || (user.providerData && user.providerData[0] && user.providerData[0].photoURL));
        if (photoURL) {
            avatarEl.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
        } else {
            avatarEl.textContent = (MY_USER.name || 'U').slice(0, 1);
        }
    }
    if (nameEl) nameEl.textContent = MY_USER.name;
    const list = document.getElementById('myCalList');
    if (!list) return;
    list.innerHTML = '';
    const cals = Object.values(state.calendars);
    if (!cals.length) { list.innerHTML = '<div class="my-ng-empty">参加中のカレンダーはありません</div>'; return; }
    cals.forEach(cal => {
        const item = document.createElement('div');
        item.className = 'my-ng-item';
        item.innerHTML = `<span class="ng-date">${esc(cal.name)}</span><span class="ng-detail">${cal.members.length}人</span>`;
        list.appendChild(item);
    });
}

// ============================================================================
// NG登録一覧ページ
// ============================================================================
function renderMyNgList() {
    const container = document.getElementById('myNgListContent');
    if (!container) return;

    const todayStr = fmt(new Date());
    // 全カレンダーから自分のNG登録を収集
    const ngEntries = [];
    Object.values(state.calendars).forEach(cal => {
        if (!cal.members || !cal.members.includes(MY_USER.id)) return;
        Object.keys(cal.schedules || {}).forEach(ds => {
            const my = cal.schedules[ds][MY_USER.id];
            if (!my) return;
            // 過去の日付はスキップ
            if (ds < todayStr) return;
            if (my.isAllDay) {
                ngEntries.push({ date: ds, calName: cal.name, calId: cal.id, type: 'allday', detail: '終日NG' });
            } else if (my.times && my.times.length > 0) {
                my.times.forEach(t => {
                    ngEntries.push({ date: ds, calName: cal.name, calId: cal.id, type: 'time', detail: `${t.start} 〜 ${t.end}` });
                });
            }
        });
    });

    if (ngEntries.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px 20px; color:var(--text-sub);">
                <i class="fa-regular fa-calendar-check" style="font-size:2rem; margin-bottom:12px; display:block; opacity:0.5;"></i>
                <p style="margin:0; font-size:0.95rem;">NG登録はありません</p>
                <p style="margin:4px 0 0; font-size:0.8rem; opacity:0.7;">カレンダーの日付をタップしてNG設定ができます</p>
            </div>`;
        return;
    }

    // 日付×NG内容で集約（キー: "日付|detail"）
    const merged = {};
    ngEntries.forEach(e => {
        const key = `${e.date}|${e.detail}`;
        if (!merged[key]) {
            merged[key] = { date: e.date, type: e.type, detail: e.detail, calNames: [], calIds: [] };
        }
        // 同じカレンダーの重複を防ぐ
        if (!merged[key].calIds.includes(e.calId)) {
            merged[key].calNames.push(e.calName);
            merged[key].calIds.push(e.calId);
        }
    });

    // 日付順にソート
    const mergedList = Object.values(merged);
    mergedList.sort((a, b) => a.date.localeCompare(b.date) || a.detail.localeCompare(b.detail));

    // 日付ごとにグループ化
    const grouped = {};
    mergedList.forEach(e => {
        if (!grouped[e.date]) grouped[e.date] = [];
        grouped[e.date].push(e);
    });

    let html = '';
    let itemIdx = 0;
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    Object.keys(grouped).sort().forEach(ds => {
        const [y, m, d] = ds.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dayName = dayNames[dateObj.getDay()];
        const isToday = ds === todayStr;
        const dateLabel = `${y}年${m}月${d}日（${dayName}）`;

        html += `<div class="ng-list-date-header">`;
        html += `<span class="ng-list-date-text${isToday ? ' ng-list-today' : ''}">${dateLabel}</span>`;
        if (isToday) html += `<span class="ng-list-today-badge">今日</span>`;
        html += `</div>`;

        grouped[ds].forEach(e => {
            const icon = e.type === 'allday'
                ? '<i class="fa-solid fa-ban" style="color:var(--ng); margin-right:6px;"></i>'
                : '<i class="fa-regular fa-clock" style="color:var(--partial); margin-right:6px;"></i>';

            const calLabel = e.calNames.length === 1
                ? `<span class="ng-list-item-cal">${esc(e.calNames[0])}</span>`
                : `<span class="ng-list-item-cal-badge" data-ng-expand="${itemIdx}">${e.calNames.length}カレンダー <i class="fa-solid fa-chevron-down" style="font-size:0.6rem; margin-left:2px;"></i></span>`;

            // 削除ボタン用のデータをグローバル配列に保持
            if (!window._ngDeleteData) window._ngDeleteData = [];
            const deleteIdx = window._ngDeleteData.length;
            window._ngDeleteData.push({ date: e.date, type: e.type, detail: e.detail, calIds: e.calIds });

            html += `<div class="ng-list-item" style="display:flex; align-items:center; gap:8px;">`;
            html += `<div style="flex:1; min-width:0; display:flex; align-items:center; justify-content:space-between;">`;
            html += `<div class="ng-list-item-detail">${icon}${esc(e.detail)}</div>`;
            html += calLabel;
            html += `</div>`;
            html += `<button class="icon-btn" data-ng-delete-idx="${deleteIdx}" style="color:var(--ng); width:32px; height:32px; font-size:0.9rem; flex-shrink:0;" title="NG設定を削除"><i class="fa-solid fa-trash-can"></i></button>`;
            html += `</div>`;

            // 展開用のカレンダー名リスト（初期非表示）
            if (e.calNames.length > 1) {
                html += `<div class="ng-list-cal-expand hidden" id="ngExpand${itemIdx}">`;
                e.calNames.forEach(name => {
                    html += `<div class="ng-list-cal-name"><i class="fa-regular fa-calendar" style="margin-right:6px; opacity:0.5;"></i>${esc(name)}</div>`;
                });
                html += `</div>`;
            }
            itemIdx++;
        });
    });

    container.innerHTML = html;

    // 削除ボタンのイベントリスナー
    container.querySelectorAll('[data-ng-delete-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.ngDeleteIdx);
            const data = window._ngDeleteData[idx];
            if (data) deleteNgFromList(data);
        });
    });

    // タップ展開のイベントリスナー
    container.querySelectorAll('[data-ng-expand]').forEach(badge => {
        badge.addEventListener('click', () => {
            const idx = badge.dataset.ngExpand;
            const expandEl = document.getElementById(`ngExpand${idx}`);
            if (expandEl) {
                const isHidden = expandEl.classList.contains('hidden');
                expandEl.classList.toggle('hidden');
                // 矢印アイコンの向きを切り替え
                const chevron = badge.querySelector('i');
                if (chevron) {
                    chevron.className = isHidden ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
                    chevron.style.fontSize = '0.6rem';
                    chevron.style.marginLeft = '2px';
                }
            }
        });
    });
}

// NG登録一覧からの削除（全参加カレンダーから同期削除）
async function deleteNgFromList(data) {
    const { date, type, detail } = data;
    // 全参加カレンダーから該当NGを削除（表示上のcalIdsだけでなく全カレンダー同期）
    const allCalIds = Object.values(state.calendars)
        .filter(cal => cal.members && cal.members.includes(MY_USER.id))
        .filter(cal => {
            if (cal.type === 'range' && (!cal.rangeStart || !cal.rangeEnd || date < cal.rangeStart || date > cal.rangeEnd)) return false;
            return true;
        })
        .map(cal => cal.id);
    for (const calId of allCalIds) {
        const cal = state.calendars[calId];
        if (!cal || !cal.schedules || !cal.schedules[date] || !cal.schedules[date][MY_USER.id]) continue;
        const my = cal.schedules[date][MY_USER.id];
        if (type === 'allday') {
            my.isAllDay = false;
            my.times = [];
        } else {
            // 時間帯NGの場合、該当する時間帯を削除
            const parts = detail.split(' 〜 ');
            if (parts.length === 2) {
                my.times = my.times.filter(t => !(t.start === parts[0] && t.end === parts[1]));
            }
        }

        // Firestoreへの保存: フィールド削除を明示的に行う
        try {
            const needsUserDelete = !my.isAllDay && (!my.times || my.times.length === 0);
            if (needsUserDelete) {
                // ユーザーのNG情報が空になったので削除
                delete cal.schedules[date][MY_USER.id];
                const dateHasOthers = Object.keys(cal.schedules[date] || {}).length > 0;
                if (!dateHasOthers) {
                    // その日付のスケジュール自体が空
                    delete cal.schedules[date];
                    await updateDoc(doc(window.db, "calendars", cal.id), {
                        [`schedules.${date}`]: deleteField()
                    });
                } else {
                    await updateDoc(doc(window.db, "calendars", cal.id), {
                        [`schedules.${date}.${MY_USER.id}`]: deleteField()
                    });
                }
            } else {
                // NG情報が一部残っているので上書き保存
                cleanupSched(cal, date);
                await updateDoc(doc(window.db, "calendars", cal.id), {
                    [`schedules.${date}.${MY_USER.id}`]: cal.schedules[date]?.[MY_USER.id] || deleteField()
                });
            }
        } catch (e) {
            console.error("Error deleting NG from Firestore:", e);
            // フォールバック: 通常の保存
            cleanupSched(cal, date);
            saveCalendarToFirestore(cal);
        }
    }
    window._ngDeleteData = []; // リセット
    renderMyNgList();
    if (state.activeCal) renderCalendar();
    showToast('NG設定をキャンセルしました');
}

// ============================================================================
// 確定予約一覧ページ
// ============================================================================
function renderConfirmedList() {
    const container = document.getElementById('confirmedListContent');
    if (!container) return;

    const todayStr = fmt(new Date());
    // 全カレンダーから確定予約（全員OK投票の提案）を収集
    const confirmedEntries = [];
    Object.values(state.calendars).forEach(cal => {
        if (!cal.members || !cal.members.includes(MY_USER.id)) return;
        if (!cal.proposals || !Array.isArray(cal.proposals)) return;
        cal.proposals.forEach(p => {
            // 過去の日付はスキップ
            if (p.date < todayStr) return;
            const votes = p.votes || {};
            const members = cal.members || [];
            // 全メンバーがOK投票した提案のみ
            const isConfirmed = members.length > 0 && members.every(uid => votes[uid] === 'ok');
            if (!isConfirmed) return;
            confirmedEntries.push({
                date: p.date,
                startTime: p.startTime || '',
                endTime: p.endTime || '',
                calName: cal.name,
                calId: cal.id,
                proposalId: p.id,
                from: p.from,
                fromName: getMemberName(p.from, cal.id) !== p.from ? getMemberName(p.from, cal.id) : (p.fromName || p.from)
            });
        });
    });

    if (confirmedEntries.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px 20px; color:var(--text-sub);">
                <i class="fa-solid fa-trophy" style="font-size:2rem; margin-bottom:12px; display:block; opacity:0.5;"></i>
                <p style="margin:0; font-size:0.95rem;">確定予約はありません</p>
                <p style="margin:4px 0 0; font-size:0.8rem; opacity:0.7;">集合を提案して全員がOKすると確定予約になります</p>
            </div>`;
        return;
    }

    // 日付順にソート
    confirmedEntries.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

    // 日付ごとにグループ化
    const grouped = {};
    confirmedEntries.forEach(e => {
        if (!grouped[e.date]) grouped[e.date] = [];
        grouped[e.date].push(e);
    });

    let html = '';
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    Object.keys(grouped).sort().forEach(ds => {
        const [y, m, d] = ds.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dayName = dayNames[dateObj.getDay()];
        const isToday = ds === todayStr;
        const dateLabel = `${y}年${m}月${d}日（${dayName}）`;

        html += `<div class="confirmed-list-date-header">`;
        html += `<span class="confirmed-list-date-text${isToday ? ' confirmed-list-today' : ''}">${dateLabel}</span>`;
        if (isToday) html += `<span class="confirmed-list-today-badge">今日</span>`;
        html += `</div>`;

        grouped[ds].forEach(e => {
            const timeStr = e.endTime ? `${e.startTime} 〜 ${e.endTime}` : `${e.startTime} 〜`;
            html += `<div class="confirmed-list-item" style="display:flex; align-items:center; justify-content:space-between;">`;
            html += `<div style="flex:1; min-width:0;">`;
            html += `<div class="confirmed-list-item-main">`;
            html += `<span class="confirmed-list-item-time"><i class="fa-regular fa-clock" style="margin-right:6px;"></i>${timeStr}</span>`;
            html += `<span class="confirmed-list-item-cal">${esc(e.calName)}</span>`;
            html += `</div>`;
            html += `<div class="confirmed-list-item-sub">`;
            html += `<i class="fa-solid fa-user" style="margin-right:4px; font-size:0.7rem;"></i>提案: ${esc(e.fromName)}`;
            html += `</div>`;
            html += `</div>`;
            html += `<button class="icon-btn" onclick="cancelConfirmedEvent('${e.calId}','${e.proposalId}')" style="color:var(--ng); width:36px; height:36px; font-size:1rem; flex-shrink:0;" title="予約をキャンセル"><i class="fa-solid fa-trash-can"></i></button>`;
            html += `</div>`;
        });
    });

    container.innerHTML = html;
}

// 確定予約のキャンセル
function cancelConfirmedEvent(calId, proposalId) {
    if (!confirm('この確定予約をキャンセルしますか？')) return;
    const cal = state.calendars[calId];
    if (!cal || !cal.proposals) return;

    const pIndex = cal.proposals.findIndex(p => String(p.id) === String(proposalId));
    if (pIndex !== -1) {
        cal.proposals.splice(pIndex, 1);
        saveCalendarToFirestore(cal);
    }

    // 関連する通知も削除
    state.dismissedNotifIds.add(String(proposalId));
    state.notifications = state.notifications.filter(n => String(n.id) !== String(proposalId));
    saveLocal();

    renderConfirmedList();
    renderCalendar();
    renderNotifications();
    showToast('確定予約をキャンセルしました');
}
window.cancelConfirmedEvent = cancelConfirmedEvent;

// ============================================================================
// Helpers
// ============================================================================

/**
 * 繰り返しNG用: 基準日と同じ曜日の未来日付リストを生成
 * 月カレンダー: 当月＋翌月の同曜日（基準日以降）
 * 期間指定カレンダー: rangeStart〜rangeEndの範囲内で同曜日
 */
function getRecurringDates(baseDateStr) {
    const [y, m, d] = baseDateStr.split('-').map(Number);
    const baseDate = new Date(y, m - 1, d);
    const targetDay = baseDate.getDay(); // 0=日, 1=月, ..., 6=土
    const results = [];
    const cal = getCal();

    if (cal && cal.type === 'range' && cal.rangeStart && cal.rangeEnd) {
        // 期間指定カレンダー: rangeStart〜rangeEndの範囲
        const [sy, sm, sd] = cal.rangeStart.split('-').map(Number);
        const [ey, em, ed] = cal.rangeEnd.split('-').map(Number);
        const start = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);
        const cursor = new Date(Math.max(baseDate.getTime(), start.getTime()));
        while (cursor <= end) {
            if (cursor.getDay() === targetDay) {
                results.push(fmt(cursor));
            }
            cursor.setDate(cursor.getDate() + 1);
        }
    } else {
        // 月カレンダー: 当月＋翌月の同曜日
        // 当月
        const monthStart = new Date(y, m - 1, 1);
        const monthEnd = new Date(y, m, 0); // 当月末
        for (let cursor = new Date(Math.max(baseDate.getTime(), monthStart.getTime())); cursor <= monthEnd; cursor.setDate(cursor.getDate() + 1)) {
            if (cursor.getDay() === targetDay) {
                results.push(fmt(new Date(cursor)));
            }
        }
        // 翌月
        const nextMonthStart = new Date(y, m, 1);
        const nextMonthEnd = new Date(y, m + 1, 0);
        // 今日より前の日付は除外
        const today = fmt(new Date());
        for (let cursor = new Date(nextMonthStart); cursor <= nextMonthEnd; cursor.setDate(cursor.getDate() + 1)) {
            if (cursor.getDay() === targetDay && fmt(cursor) >= today) {
                results.push(fmt(new Date(cursor)));
            }
        }
    }

    return results;
}

function ensureSched(cal, ds) {
    if (!cal.schedules[ds]) cal.schedules[ds] = {};
    if (!cal.schedules[ds][MY_USER.id]) cal.schedules[ds][MY_USER.id] = { isAllDay: false, times: [] };
}
function cleanupSched(cal, ds) {
    const d = cal.schedules[ds]; if (!d) return;
    const s = d[MY_USER.id];
    // NG情報もコメントも無い場合のみユーザーデータを削除
    if (s && !s.isAllDay && !s.times.length && !s.comment) delete d[MY_USER.id];
    if (!Object.keys(d).length) delete cal.schedules[ds];
}
// スケジュールフィールドをFirestoreに正しく保存するヘルパー
// setDoc({merge:true})はフィールド削除を反映しないため、
// NG情報が空になった場合はupdateDoc+deleteField()を使用する
async function saveScheduleFieldToFirestore(cal, ds) {
    if (demoMode) { saveLocal(); return; }
    if (!window.db) return;
    try {
        const userSched = cal.schedules[ds]?.[MY_USER.id];
        if (!userSched) {
            // ユーザーのNG情報が空になった → Firestoreから明示的に削除
            const dateHasOthers = cal.schedules[ds] && Object.keys(cal.schedules[ds]).length > 0;
            if (!dateHasOthers && !cal.schedules[ds]) {
                // その日付のスケジュール自体が空
                await updateDoc(doc(window.db, "calendars", cal.id), {
                    [`schedules.${ds}`]: deleteField()
                });
            } else {
                await updateDoc(doc(window.db, "calendars", cal.id), {
                    [`schedules.${ds}.${MY_USER.id}`]: deleteField()
                });
            }
        } else {
            // NG情報がまだ残っている → 上書き保存
            await updateDoc(doc(window.db, "calendars", cal.id), {
                [`schedules.${ds}.${MY_USER.id}`]: userSched
            });
        }
    } catch (e) {
        console.error("Error saving schedule field to Firestore:", e);
        // フォールバック: 通常の保存
        saveCalendarToFirestore(cal);
    }
}
function fmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtLabel(ds) { const [y, m, d] = ds.split('-').map(Number); return `${y}年${m}月${d}日`; }
function fmtShort(ds) { const [y, m, d] = ds.split('-').map(Number); return `${m}/${d}`; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function _showUpdateOverlay() {
    // 全画面「更新中」オーバーレイを表示
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:var(--bg-main,#1e1f22);color:var(--text-main,#e2e8f0);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
    overlay.innerHTML = '<div style="font-size:1.5rem;font-weight:700;">更新中です...</div><div style="width:32px;height:32px;border:3px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 0.8s linear infinite;"></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(overlay);
}
function showToast(msg, type) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.classList.remove('show');
    t.style.background = type === 'error' ? '#ef4444' : '';
    t.textContent = msg;
    requestAnimationFrame(() => {
        t.classList.add('show');
        setTimeout(() => {
            t.classList.remove('show');
            // フェードアウト完了後に背景色リセット（transitionは0.3s）
            setTimeout(() => { t.style.background = ''; }, 400);
        }, 2500);
    });
}

// NG設定をすべての参加カレンダーから収集し合算する
function aggregateAllMyNGs() {
    let aggregated = {};
    Object.values(state.calendars).forEach(cal => {
        if (!cal.members || !cal.members.includes(MY_USER.id)) return;
        Object.keys(cal.schedules || {}).forEach(ds => {
            const myDay = cal.schedules[ds][MY_USER.id];
            if (!myDay) return;

            if (!aggregated[ds]) {
                aggregated[ds] = { isAllDay: false, times: [] };
            }

            if (myDay.isAllDay) {
                aggregated[ds].isAllDay = true;
            }

            if (myDay.times && myDay.times.length > 0 && !aggregated[ds].isAllDay) {
                myDay.times.forEach(t => {
                    const exists = aggregated[ds].times.some(ext => ext.start === t.start && ext.end === t.end);
                    if (!exists) aggregated[ds].times.push({ start: t.start, end: t.end });
                });
            }
        });
    });

    // クリーンアップ
    Object.keys(aggregated).forEach(ds => {
        const d = aggregated[ds];
        if (d.isAllDay) d.times = [];
        if (!d.isAllDay && d.times.length === 0) delete aggregated[ds];
    });

    return aggregated;
}

// ============================================================================
// Auth Logic
// ============================================================================
async function handleLogin() {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    if (!window.auth || !window.googleProvider) {
        showToast("認証の準備中です。少し待ってからお試しください。");
        return;
    }
    try {
        // ポップアップベースの認証（PWAではリダイレクトが動作しないため）
        await signInWithPopup(window.auth, window.googleProvider);
    } catch (error) {
        console.error("Login error:", error);
        showToast("ログインに失敗しました");
    }
}

async function handleLogout() {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    if (!window.auth) return;
    // ログアウト確認ダイアログ
    if (!confirm('ログアウトしますか？')) return;
    try {
        // ログアウト前に通知とカレンダーIDをlocalStorageに保存（再ログイン時に復元）
        saveLocal();
        // カレンダーIDを確実に保存
        const currentJoined = Object.keys(state.calendars);
        if (currentJoined.length > 0) {
            const existingJoined = JSON.parse(localStorage.getItem('ssJoinedCals') || '[]');
            const merged = [...new Set([...existingJoined, ...currentJoined])];
            localStorage.setItem('ssJoinedCals', JSON.stringify(merged));
        }

        // 全スナップショットリスナーを解除（再ログイン時に新規作成するため）
        if (unsubscribeUserJoinedCals) {
            unsubscribeUserJoinedCals();
            unsubscribeUserJoinedCals = null;
        }
        Object.keys(activeCalendarListeners).forEach(calId => {
            if (activeCalendarListeners[calId]) {
                activeCalendarListeners[calId]();
            }
        });
        activeCalendarListeners = {};

        await signOut(window.auth);

        // メモリ上のステートをクリア（localStorageのssNotifications/ssJoinedCalsは保持）
        state.calendars = {};
        state.notifications = [];
        state.activeCal = null;
        state.selectedDate = null;
        state.batchMode = false;
        state.batchSelectedDates = new Set();
        state._copySource = null;

        showToast("ログアウトしました");

        // ホーム画面に戻す
        switchTab('tabCalendar');
        showCalendarList();
    } catch (error) {
        console.error("Logout error:", error);
        showToast("ログアウトに失敗しました");
    }
}

// ============================================================================
// 登録完了機能
// ============================================================================
async function markComplete(calId) {
    if (demoMode) {
        const cal = state.calendars[calId];
        if (!cal) return;
        const now = new Date();
        const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        cal.completed ??= {};
        cal.completed[MY_USER.id] ??= {};
        cal.completed[MY_USER.id][month] = !cal.completed[MY_USER.id][month];
        saveLocal();
        renderCompletionStatus();
        renderCalendar();
        showToast('デモの登録完了状態を変更しました');
        return;
    }
    if (markComplete._running) return;
    markComplete._running = true;

    try {
        const cal = state.calendars[calId];
        if (!cal) return;
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthLabel = `${now.getMonth() + 1}月`;
        const isCompleted = cal.completed && cal.completed[MY_USER.id] && cal.completed[MY_USER.id][month];

        if (isCompleted) {
            // === 取り消し ===
            await updateDoc(doc(window.db, "calendars", calId), {
                [`completed.${MY_USER.id}.${month}`]: deleteField()
            });

            // completionNotifsから同月の通知を削除
            if (cal.completionNotifs && Array.isArray(cal.completionNotifs)) {
                const filteredNotifs = cal.completionNotifs.filter(n => n.month !== month);
                await updateDoc(doc(window.db, "calendars", calId), {
                    completionNotifs: filteredNotifs
                });
                const removedNotif = cal.completionNotifs.find(n => n.month === month);
                if (removedNotif) {
                    let dismissedIds = JSON.parse(localStorage.getItem('ssDismissedNotifIds') || '[]');
                    dismissedIds = dismissedIds.filter(id => id !== String(removedNotif.id));
                    localStorage.setItem('ssDismissedNotifIds', JSON.stringify(dismissedIds));
                }
            }

            showToast('登録完了を取り消しました');
            // ローカル状態を即座に更新
            if (cal.completed && cal.completed[MY_USER.id]) {
                delete cal.completed[MY_USER.id][month];
            }
            renderCompletionStatus();
            renderCalendar();
            // メンバーリストモーダルが開いていれば再描画
            if (!document.getElementById('memberListModal').classList.contains('hidden')) {
                showMemberListModal();
            }
        } else {
            // === 完了 ===
            await updateDoc(doc(window.db, "calendars", calId), {
                [`completed.${MY_USER.id}.${month}`]: true
            });

            const members = cal.members || [];
            const updatedCompleted = { ...(cal.completed || {}), [MY_USER.id]: { ...(cal.completed?.[MY_USER.id] || {}), [month]: true } };
            const allCompleted = members.every(uid => updatedCompleted[uid] && updatedCompleted[uid][month]);

            if (allCompleted) {
                const existingNotifs = cal.completionNotifs || [];
                const alreadyExists = existingNotifs.some(n => n.month === month);
                if (!alreadyExists) {
                    const newNotif = {
                        id: `comp_${calId}_${month}_${Date.now()}`,
                        type: 'completion',
                        from: 'all',
                        month: month,
                        monthLabel: monthLabel,
                        timestamp: new Date().toISOString(),
                        message: `${monthLabel}の予定登録が全員完了しました！`
                    };
                    await updateDoc(doc(window.db, "calendars", calId), {
                        completionNotifs: [...existingNotifs, newNotif]
                    });
                }
            }

            showToast(`${monthLabel}の予定登録を完了しました！ ✅`);
            // ローカル状態を即座に更新
            if (!cal.completed) cal.completed = {};
            if (!cal.completed[MY_USER.id]) cal.completed[MY_USER.id] = {};
            cal.completed[MY_USER.id][month] = true;
            renderCompletionStatus();
            renderCalendar();
            // メンバーリストモーダルが開いていれば再描画
            if (!document.getElementById('memberListModal').classList.contains('hidden')) {
                showMemberListModal();
            }
        }
    } catch (e) {
        console.error("markComplete error:", e);
        showToast("エラーが発生しました");
    } finally {
        markComplete._running = false;
    }
}

function renderCompletionStatus() {
    const cal = getCal();
    if (!cal) return;
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = `${now.getMonth() + 1}月`;
    const isCompleted = cal.completed && cal.completed[MY_USER.id] && cal.completed[MY_USER.id][month];
    const statusEl = document.getElementById('completionStatus');
    const btn = document.getElementById('markCompleteBtn');
    if (!statusEl || !btn) return;

    // メンバーの完了状況を表示
    const members = cal.members || [];
    const completedCount = members.filter(uid => cal.completed?.[uid]?.[month]).length;
    statusEl.innerHTML = `<div style="font-size:0.85rem; color:var(--text-sub); margin-bottom:4px;">${monthLabel}: ${completedCount}/${members.length}人が登録完了</div>`;

    if (isCompleted) {
        btn.innerHTML = `<i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>${monthLabel}の予定登録完了`;
        btn.style.background = 'var(--glass-bg)';
        btn.style.border = '1px solid var(--accent)';
        btn.style.color = 'var(--accent)';
        btn.onclick = () => { if (confirm('登録完了を取り消しますか？')) markComplete(state.activeCal); };
    } else {
        btn.textContent = `${monthLabel}の予定登録を完了する`;
        btn.style.background = '';
        btn.style.border = '';
        btn.style.color = '';
        btn.onclick = () => markComplete(state.activeCal);
    }
}

// ============================================================================
// Event Listeners for new batch options
// ============================================================================
document.getElementById('batchTypeAllday')?.addEventListener('change', (e) => {
    if (e.target.checked) document.getElementById('batchTimeInputs').style.display = 'none';
});
document.getElementById('batchTypeTime')?.addEventListener('change', (e) => {
    if (e.target.checked) document.getElementById('batchTimeInputs').style.display = 'flex';
});

// ============================================================================
// FCM プッシュ通知
// ============================================================================
async function setupPushNotifications() {
    if (demoMode) return;
    if (!window.fcmMessaging || !window.fcmGetToken) {
        console.warn('[FCM] messaging または getToken が未初期化');
        return;
    }

    if (Notification.permission === 'granted') {
        // 既に許可済み → トークン取得・保存
        await _registerFcmToken();
    } else if (Notification.permission === 'denied') {
        // 拒否済み → トグルをOFFにする
        _setNotifTogglesOff();
    } else if (Notification.permission === 'default') {
        // 未回答 → トグルがONなら通知許可を求める
        const notifSettings = JSON.parse(localStorage.getItem('ssNotifSettings') || '{}');
        const anyEnabled = notifSettings.proposal !== false ||
                           notifSettings.completion !== false ||
                           notifSettings.confirmed !== false;
        if (!anyEnabled) return;

        // iOS判定（iOSではユーザージェスチャーなしにrequestPermissionを呼ぶとdeniedになるため呼ばない）
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (!isIOS) {
            try {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    showToast('通知を有効にしました ✅');
                    await _registerFcmToken();
                } else if (permission === 'denied') {
                    _setNotifTogglesOff();
                }
            } catch (e) {
                console.log('[FCM] requestPermission error:', e);
            }
        }
        // iOSの場合はトグルOFF→ON時にダイアログが出る（Appleの仕様制約）
    }
}


// 通知が拒否された場合にトグルを全てOFFにする
function _setNotifTogglesOff() {
    const settings = { proposal: false, completion: false, confirmed: false, reminder: 'off' };
    localStorage.setItem('ssNotifSettings', JSON.stringify(settings));
    // UI上のトグルも反映
    const p = document.getElementById('notifProposal');
    const c = document.getElementById('notifCompletion');
    const cf = document.getElementById('notifConfirmed');
    const r = document.getElementById('notifReminder');
    if (p) p.checked = false;
    if (c) c.checked = false;
    if (cf) cf.checked = false;
    if (r) r.value = 'off';
    // Firestoreにも保存
    if (window.db && MY_USER && !MY_USER.id.startsWith('u_')) {
        setDoc(doc(window.db, 'users', MY_USER.id), { notifSettings: settings }, { merge: true })
            .catch(e => console.error('notifSettings save error:', e));
    }
}

// FCMトークンの取得・保存（許可済みの場合のみ呼ぶ）
async function _registerFcmToken() {
    try {
        const swRegistration = await navigator.serviceWorker.register('./sw.js');
        console.log('[FCM] firebase-messaging-sw.js 登録成功');

        const token = await window.fcmGetToken(window.fcmMessaging, {
            vapidKey: vapidKey,
            serviceWorkerRegistration: swRegistration
        });

        if (token && window.db && MY_USER && !MY_USER.id.startsWith('u_')) {
            const prevToken = localStorage.getItem('ssFcmToken');
            const userRef = doc(window.db, 'users', MY_USER.id);

            if (prevToken && prevToken !== token) {
                await setDoc(userRef, {
                    fcmTokens: arrayRemove(prevToken)
                }, { merge: true });
                console.log('[FCM] 古いトークンを削除:', prevToken.substring(0, 20) + '...');
            }

            await setDoc(userRef, {
                fcmTokens: arrayUnion(token)
            }, { merge: true });

            localStorage.setItem('ssFcmToken', token);
            console.log('[FCM] トークン保存成功:', token.substring(0, 20) + '...');
        }
    } catch (e) {
        console.error('[FCM] Token registration error:', e);
    }
}


// フォアグラウンドメッセージ受信（トースト通知 + バッジ更新）
function setupForegroundMessaging() {
    if (!window.fcmMessaging || !window.fcmOnMessage) return;
    try {
        window.fcmOnMessage(window.fcmMessaging, (payload) => {
            console.log('フォアグラウンドメッセージ:', payload);
            const data = payload.data || {};
            const title = data.title || '';
            const body = data.body || '';
            const type = data.type || '';

            // トースト表示
            if (body) {
                showToast(`${title} ${body}`);
            }

            // 確定通知の場合は通知タブに遷移
            if (type === 'confirmed') {
                setTimeout(() => {
                    renderNotifications();
                    switchTab('tabNotifications');
                }, 500);
            } else {
                // その他の通知はバッジを更新（Firestoreリスナーが通知データを更新するのを待つ）
                setTimeout(() => {
                    renderNotifications();
                    updateNotifBadge();
                }, 500);
            }
        });
    } catch (e) {
        console.log('FCM foreground setup skipped:', e);
    }
}

// ============================================================================
// Googleカレンダー読み込み → NG自動登録
// ============================================================================

/**
 * Googleカレンダー読み込みのメイン関数
 * OAuth認証 → Calendar API予定取得 → NG自動登録の全フローを実行する。
 * 既存のログインフロー（window.googleProvider）には一切触らない。
 * @param {boolean} silent - trueなら自動同期（トーストなし）
 */
async function syncGoogleCalendar(silent = false) {
    if (demoMode) { showToast('公開デモではアカウント連携・共有・画像アップロードは利用できません'); return; }
    try {
        // アクセストークンを取得（sessionStorageにキャッシュあればそれを使用）
        let accessToken = sessionStorage.getItem('gcalAccessToken');

        if (!accessToken) {
            // トークンがない場合: 初回 or セッション切れ → OAuth認証
            if (silent) {
                // 自動同期でトークンがない場合は何もしない（ユーザーに手動ON促す）
                console.log('[GCal] 自動同期: トークンなしのためスキップ');
                return;
            }
            accessToken = await _getGoogleCalAccessToken();
            if (!accessToken) {
                showToast('Googleカレンダーの認証に失敗しました', 'error');
                return;
            }
        }

        // Google Calendar APIから予定を取得
        const events = await _fetchGCalEvents(accessToken);
        if (events === null) {
            // トークン期限切れ → sessionStorageクリアして再認証
            sessionStorage.removeItem('gcalAccessToken');
            if (!silent) {
                // 手動同期なら再認証を試みる
                accessToken = await _getGoogleCalAccessToken();
                if (!accessToken) {
                    showToast('Googleカレンダーの認証に失敗しました', 'error');
                    return;
                }
                const retryEvents = await _fetchGCalEvents(accessToken);
                if (retryEvents === null || retryEvents.length === 0) {
                    showToast('Googleカレンダーに今後の予定がありません');
                    return;
                }
                const count = await _applyGCalNGToCalendars(_convertGCalEventsToNG(retryEvents));
                if (count > 0) showToast(`${count}件のNG設定をGoogleカレンダーから登録しました`);
                else showToast('新しいNG設定はありませんでした');
                _updateGCalSyncStatus(true, count);
                return;
            }
            console.log('[GCal] 自動同期: トークン期限切れ');
            return;
        }

        if (events.length === 0) {
            if (!silent) showToast('Googleカレンダーに今後の予定がありません');
            _updateGCalSyncStatus(true, 0);
            return;
        }

        // 予定をNG形式に変換
        const ngData = _convertGCalEventsToNG(events);

        // 全参加カレンダーにNG登録（既存NGと統合）
        const count = await _applyGCalNGToCalendars(ngData);

        if (!silent) {
            if (count > 0) showToast(`${count}件のNG設定をGoogleカレンダーから登録しました`);
            else showToast('新しいNG設定はありませんでした');
        }
        _updateGCalSyncStatus(true, count);
        console.log(`[GCal] 同期完了: ${count}件のNG設定を登録`);

    } catch (e) {
        console.error('[GCal] 同期エラー:', e);
        if (!silent) showToast('Googleカレンダーの読み込みに失敗しました', 'error');
        _updateGCalSyncStatus(false, 0);
    }
}

/**
 * 専用のGoogleAuthProviderでcalendar.readonlyトークンを取得する。
 * 既存のwindow.googleProvider（ログイン用）には一切触らない。
 * @returns {string|null} アクセストークン
 */
async function _getGoogleCalAccessToken() {
    if (!window.auth) {
        console.error('[GCal] window.auth が未初期化');
        return null;
    }
    try {
        // 専用のProviderインスタンスを作成（既存のログイン用Providerとは別物）
        const calProvider = new GoogleAuthProvider();
        calProvider.addScope('https://www.googleapis.com/auth/calendar.readonly');

        const result = await signInWithPopup(window.auth, calProvider);
        const credential = GoogleAuthProvider.credentialFromResult(result);

        if (credential && credential.accessToken) {
            sessionStorage.setItem('gcalAccessToken', credential.accessToken);
            // 同期設定をlocalStorageに保存（自動同期用）
            localStorage.setItem('gcalSyncEnabled', 'true');
            console.log('[GCal] アクセストークン取得成功');
            return credential.accessToken;
        }
        console.warn('[GCal] credentialからアクセストークンが取得できません');
        return null;
    } catch (e) {
        console.error('[GCal] OAuth認証エラー:', e);
        return null;
    }
}

/**
 * Google Calendar REST APIで予定を取得する。
 * @param {string} accessToken - GoogleのOAuthアクセストークン
 * @returns {Array|null} イベント配列（エラー時はnull）
 */
async function _fetchGCalEvents(accessToken) {
    try {
        const now = new Date();
        const timeMin = now.toISOString();
        // 12ヶ月先まで取得
        const future = new Date(now);
        future.setMonth(future.getMonth() + 12);
        const timeMax = future.toISOString();

        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${encodeURIComponent(timeMin)}&` +
            `timeMax=${encodeURIComponent(timeMax)}&` +
            `singleEvents=true&` +
            `orderBy=startTime&` +
            `maxResults=2500`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.status === 401 || response.status === 403) {
            // トークン期限切れ or 権限エラー
            console.warn('[GCal] API認証エラー:', response.status);
            return null;
        }

        if (!response.ok) {
            console.error('[GCal] APIエラー:', response.status, await response.text());
            return null;
        }

        const data = await response.json();
        console.log(`[GCal] ${(data.items || []).length}件の予定を取得`);
        return data.items || [];
    } catch (e) {
        console.error('[GCal] API呼び出しエラー:', e);
        return null;
    }
}

/**
 * Googleカレンダーの予定をPitaDayのNG形式に変換する。
 * @param {Array} events - Google Calendar APIのイベント配列
 * @returns {Object} 日付をキーとしたNG情報 { "2026-03-10": { isAllDay: true } } or { "2026-03-10": { times: [{start, end}] } }
 */
function _convertGCalEventsToNG(events) {
    const ngData = {};

    // ローカルタイムゾーンでYYYY-MM-DD形式の日付文字列を取得するヘルパー
    const formatLocalDate = (date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    const todayStr = formatLocalDate(new Date());

    events.forEach(event => {
        // キャンセルされたイベントはスキップ
        if (event.status === 'cancelled') return;

        if (event.start?.date) {
            // 終日イベント
            // Google Calendar APIの終日イベントはタイムゾーンに依存しないYYYY-MM-DD形式
            // end.dateは翌日（排他的終了日）なので、startDate 〜 endDateの前日まで
            const startDate = event.start.date; // "2026-03-11"
            const endDate = event.end?.date || startDate;

            // 日付文字列を直接パースして正午に設定（タイムゾーンずれ防止）
            const current = new Date(startDate + 'T12:00:00');
            const end = new Date(endDate + 'T12:00:00');
            while (current < end) {
                const ds = formatLocalDate(current);
                // 過去日付はスキップ
                if (ds >= todayStr) {
                    ngData[ds] = { isAllDay: true, times: [] };
                }
                current.setDate(current.getDate() + 1);
            }
        } else if (event.start?.dateTime) {
            // 時間指定イベント
            const startDT = new Date(event.start.dateTime);
            const endDT = new Date(event.end?.dateTime || event.start.dateTime);

            // 過去のイベントはスキップ
            if (endDT < new Date()) return;

            // ローカルタイムゾーンで日付キーを生成（UTCに変換しない）
            const ds = formatLocalDate(startDT);
            const startTime = startDT.toTimeString().slice(0, 5); // "HH:MM" ローカルタイム
            const endTime = endDT.toTimeString().slice(0, 5);     // "HH:MM" ローカルタイム

            if (!ngData[ds]) {
                ngData[ds] = { isAllDay: false, times: [] };
            }

            // 既にその日が終日NGなら時間帯は追加しない
            if (!ngData[ds].isAllDay) {
                // 重複チェック
                const isDuplicate = ngData[ds].times.some(t => t.start === startTime && t.end === endTime);
                if (!isDuplicate) {
                    ngData[ds].times.push({ start: startTime, end: endTime });
                }
            }
        }
    });

    console.log(`[GCal] ${Object.keys(ngData).length}日分のNG情報に変換`);
    return ngData;
}

/**
 * Googleカレンダーから変換したNG情報を全参加PitaDayカレンダーに登録する。
 * 既存のNGと統合する（既存の手動NG設定は保持、Google予定の時間帯を追加）。
 * @param {Object} ngData - 日付をキーとしたNG情報
 * @returns {number} 新たに登録されたNG設定の件数
 */
async function _applyGCalNGToCalendars(ngData) {
    let totalCount = 0;

    for (const [calId, cal] of Object.entries(state.calendars)) {
        // 自分がメンバーでないカレンダーはスキップ
        if (!cal.members || !cal.members.includes(MY_USER.id)) continue;
        if (!cal.schedules) cal.schedules = {};

        let calChanged = false;

        for (const [ds, ng] of Object.entries(ngData)) {
            // 期間指定カレンダーの場合、対象期間外の日付はスキップ
            if (cal.type === 'range') {
                if (cal.rangeStart && ds < cal.rangeStart) continue;
                if (cal.rangeEnd && ds > cal.rangeEnd) continue;
            }

            if (!cal.schedules[ds]) cal.schedules[ds] = {};
            const existing = cal.schedules[ds][MY_USER.id];

            if (ng.isAllDay) {
                // Googleカレンダーで終日イベント → 終日NG
                if (!existing || !existing.isAllDay) {
                    cal.schedules[ds][MY_USER.id] = {
                        isAllDay: true,
                        times: [],
                        ...(existing?.comment ? { comment: existing.comment } : {})
                    };
                    calChanged = true;
                    totalCount++;
                }
            } else if (ng.times && ng.times.length > 0) {
                // Googleカレンダーで時間指定イベント → 時間帯NG（統合）
                if (existing && existing.isAllDay) {
                    // 既に終日NGなら何もしない（終日NGのほうが広い制約）
                    continue;
                }

                if (!existing) {
                    // 新規登録
                    cal.schedules[ds][MY_USER.id] = {
                        isAllDay: false,
                        times: JSON.parse(JSON.stringify(ng.times))
                    };
                    calChanged = true;
                    totalCount += ng.times.length;
                } else {
                    // 既存の時間帯NGと統合（重複を除く）
                    if (!existing.times) existing.times = [];
                    let addedCount = 0;
                    ng.times.forEach(newTime => {
                        const isDuplicate = existing.times.some(t =>
                            t.start === newTime.start && t.end === newTime.end
                        );
                        if (!isDuplicate) {
                            existing.times.push({ ...newTime });
                            addedCount++;
                        }
                    });
                    if (addedCount > 0) {
                        calChanged = true;
                        totalCount += addedCount;
                    }
                }
            }
        }

        // 変更があったカレンダーのみFirestoreに保存
        if (calChanged) {
            try {
                await saveCalendarToFirestore(cal);
                console.log(`[GCal] カレンダー「${cal.name}」にNG設定を登録`);
            } catch (e) {
                console.error('[GCal] カレンダーの保存エラー:', cal.name, e);
            }
        }
    }

    // UIを更新
    if (totalCount > 0) {
        renderCalendarList();
        if (state.activeCal) renderCalendar();
    }

    return totalCount;
}

/**
 * 同期ステータス表示を更新する
 * @param {boolean} success - 同期成功したか
 * @param {number} count - 登録件数
 */
function _updateGCalSyncStatus(success, count) {
    const statusEl = document.getElementById('googleCalSyncStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    if (success) {
        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
        statusEl.textContent = count > 0
            ? `✅ ${count}件のNGを登録（${timeStr}）`
            : `✅ 読み込み済み - 新しいNGなし（${timeStr}）`;
        statusEl.style.color = 'var(--ok, #16a34a)';
    } else {
        statusEl.textContent = '❌ 読み込みに失敗しました';
        statusEl.style.color = 'var(--ng, #ef4444)';
    }
}

/**
 * 自動同期: アプリ起動時やバックグラウンド復帰時に呼ばれる。
 * localStorage の gcalSyncEnabled が true の場合のみ実行。
 */
function _autoSyncGoogleCalendar() {
    if (demoMode) return;
    if (localStorage.getItem('gcalSyncEnabled') !== 'true') return;
    if (!sessionStorage.getItem('gcalAccessToken')) return;
    // 前回同期から5分以内なら再同期しない（負荷軽減）
    const lastSync = sessionStorage.getItem('gcalLastSync');
    if (lastSync && (Date.now() - parseInt(lastSync)) < 5 * 60 * 1000) return;
    sessionStorage.setItem('gcalLastSync', String(Date.now()));
    syncGoogleCalendar(true); // silent=true: トーストなし
}

// バックグラウンド復帰時の自動同期
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        _autoSyncGoogleCalendar();
    }
});

// ============================================================================
// 広告（Google AdSense）& Cookie同意バナー
// ============================================================================

/** AdSenseのパブリッシャーID（審査通過後に差し替える） */
const AD_PUBLISHER_ID = 'ca-pub-XXXXXXXXXXXXXXXX';

/** 広告スロットID（AdSenseで広告ユニット作成後に差し替える） */
const AD_SLOT_ID = '0000000000';

/**
 * Cookie同意バナーの初期化
 * localStorage の cookieConsent を確認し、未同意ならバナーを表示する。
 * 同意済みなら保存済みの設定に基づいて広告を読み込む。
 */
function initCookieConsent() {
    if (demoMode) return;
    const consent = localStorage.getItem('cookieConsent');
    const banner = document.getElementById('cookieConsentBanner');

    if (consent) {
        // 同意済み → バナーは非表示のまま、広告を読み込む
        loadAdSenseScript(consent === 'all');
    } else if (banner) {
        // 未同意 → バナーを表示
        banner.classList.remove('hidden');

        const acceptAll = document.getElementById('cookieAcceptAll');
        const acceptNecessary = document.getElementById('cookieAcceptNecessary');

        if (acceptAll) {
            acceptAll.addEventListener('click', () => {
                localStorage.setItem('cookieConsent', 'all');
                banner.classList.add('hidden');
                loadAdSenseScript(true);
                showToast('Cookieの設定を保存しました');
            });
        }
        if (acceptNecessary) {
            acceptNecessary.addEventListener('click', () => {
                localStorage.setItem('cookieConsent', 'necessary');
                banner.classList.add('hidden');
                loadAdSenseScript(false);
                showToast('Cookieの設定を保存しました');
            });
        }
    }
}

/**
 * Google AdSenseスクリプトを動的に読み込む
 * @param {boolean} personalized - パーソナライズド広告を有効にするか
 */
function loadAdSenseScript(personalized) {
    // スロットIDが未設定（ダミー値）の場合はAdSenseスクリプトを読み込まない
    // AdSenseスクリプトの自動広告機能がページレイアウトを崩すため
    if (AD_SLOT_ID === '0000000000') {
        console.log('[Ad] スロットIDが未設定のため、広告プレースホルダーを表示');
        _showAdPlaceholder();
        return;
    }

    // プレースホルダーIDの場合はスクリプトを読み込まない（開発中）
    if (AD_PUBLISHER_ID === 'ca-pub-XXXXXXXXXXXXXXXX') {
        console.log('[Ad] パブリッシャーIDが未設定のため、広告プレースホルダーを表示');
        _showAdPlaceholder();
        return;
    }

    // 既にスクリプトが読み込まれている場合はスキップ
    if (document.querySelector('script[src*="adsbygoogle"]')) {
        _initAdSlot();
        return;
    }

    // 非パーソナライズド広告の設定
    if (!personalized) {
        (window.adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = 1;
    }

    // AdSenseスクリプトの動的挿入
    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_PUBLISHER_ID}`;
    script.onload = () => {
        console.log('[Ad] AdSenseスクリプト読み込み完了');
        _initAdSlot();
    };
    script.onerror = () => {
        console.warn('[Ad] AdSenseスクリプト読み込み失敗（広告ブロッカーの可能性）');
        _showAdPlaceholder();
    };
    document.head.appendChild(script);
}

/**
 * 固定広告バナーにAdSense広告スロットを作成する
 */
function _initAdSlot() {
    const container = document.getElementById('adBannerFixed');
    if (!container) return;
    if (container.querySelector('ins.adsbygoogle')) return;

    const label = document.createElement('div');
    label.className = 'ad-label';
    label.textContent = '広告';
    container.appendChild(label);

    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', AD_PUBLISHER_ID);
    ins.setAttribute('data-ad-slot', AD_SLOT_ID);
    ins.setAttribute('data-ad-format', 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    container.appendChild(ins);

    try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
        console.warn('[Ad] 広告リクエストエラー:', e);
    }

    _updateAdVisibility();
}

/**
 * AdSenseが利用できない場合のプレースホルダー表示
 * （開発中 or 広告ブロッカー使用時）
 * ※AdSense審査通過前はバナー自体を非表示にし、
 *  グレーの枠が画面に出ないようにする
 */
function _showAdPlaceholder() {
    const container = document.getElementById('adBannerFixed');
    if (!container) return;
    if (container.querySelector('.ad-placeholder-label')) return; // 既に表示済み

    // 「ここに広告が入ります」のプレースホルダーを表示
    const label = document.createElement('div');
    label.className = 'ad-label';
    label.textContent = '広告';
    container.appendChild(label);

    const placeholder = document.createElement('div');
    placeholder.className = 'ad-placeholder-label';
    placeholder.textContent = 'ここに広告が表示されます（準備中）';
    container.appendChild(placeholder);

    container.classList.remove('hidden');
    console.log('[Ad] 広告プレースホルダーを表示');
}

/**
 * アクティブタブに応じて広告バナーの表示/非表示を切り替える
 * カレンダー一覧とマイページで表示、通知タブとカレンダー詳細画面では非表示
 */
function _updateAdVisibility() {
    const banner = document.getElementById('adBannerFixed');
    if (!banner || banner.children.length === 0) return;

    // カレンダー詳細画面が開いている場合は非表示
    const detailView = document.getElementById('calendarDetailView');
    if (detailView && !detailView.classList.contains('hidden')) {
        banner.classList.add('hidden');
        return;
    }

    // アクティブタブを確認
    const activeTab = document.querySelector('.tab-item.active');
    const tabId = activeTab?.getAttribute('data-tab') || '';

    // カレンダー一覧またはマイページの場合のみ表示
    if (tabId === 'tabCalendar' || tabId === 'tabMyPage') {
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}



// ============================================================================
// Window エクスポート（tutorial2.js から呼ばれる関数）
// ============================================================================
window.openDateModal = openDateModal;
window.closeDateModal = closeDateModal;
window.switchMode = switchMode;


// 公開用のサンプル。実ユーザー・実予定は含まない。
function initPublicDemo() {
    document.getElementById('publicDemoNotice').hidden = false;
    for (const id of ['createIconPickBtn', 'editIconPickBtn', 'deleteAccountBtn', 'logoutBtn']) {
        const element = document.getElementById(id);
        if (element) element.hidden = true;
    }
    Object.assign(MEMBER_NAMES, { demo_member_b: 'メンバー B', demo_member_c: 'メンバー C' });
    if (localStorage.getItem('ssPublicDemoInitialized')) return;
    const cal = createCalendarObj('週末の予定を合わせる（サンプル）', 'full', '', '', '09:00', '22:00');
    cal.id = 'public_demo_calendar';
    cal.members = [MY_USER.id, 'demo_member_b', 'demo_member_c'];
    cal.memberNames = Object.fromEntries(cal.members.map(uid => [uid, MEMBER_NAMES[uid]]));
    const month = new Date();
    for (const day of [5, 12, 19, 26]) {
        const ds = fmt(new Date(month.getFullYear(), month.getMonth(), day));
        cal.schedules[ds] = { demo_member_b: { isAllDay: false, times: [{ start: '09:00', end: '12:00' }] } };
    }
    cal.schedules[fmt(new Date(month.getFullYear(), month.getMonth(), 8))] = {
        demo_member_c: { isAllDay: true, times: [], comment: 'この日は予定があります（サンプル）' }
    };
    state.calendars[cal.id] = cal;
    localStorage.setItem('ssPublicDemoInitialized', 'true');
    saveLocal();
}
