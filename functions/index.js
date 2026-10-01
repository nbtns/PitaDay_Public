const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions");

initializeApp();

const db = getFirestore();

// プロジェクトIDからホスティングURLを生成（通知タップ時の遷移先）
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
const APP_URL = `https://${projectId}.web.app/?tab=notifications`;
// ============================================================================
// ヘルパー: 日本時間を取得
// ============================================================================
function getJST() {
    const now = new Date();
    // UTC + 9時間 = JST
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return jst;
}

// ============================================================================
// ヘルパー: カレンダーメンバーのFCMトークンを取得（通知設定フィルタリング対応）
// notifType: 'completion' | 'proposal' | 'reminder' | null(フィルタなし)
// ============================================================================
async function getMemberTokens(memberUids, excludeUid = null, notifType = null) {
    const tokens = [];
    for (const uid of memberUids) {
        if (uid === excludeUid) continue;
        try {
            const userDoc = await db.collection("users").doc(uid).get();
            if (userDoc.exists) {
                const data = userDoc.data();

                // 通知設定チェック（notifSettings.completion / .proposal / .reminder）
                if (notifType && data.notifSettings) {
                    if (data.notifSettings[notifType] === false) {
                        continue; // この通知種別がOFFのユーザーはスキップ
                    }
                }

                if (data.fcmTokens && Array.isArray(data.fcmTokens)) {
                    tokens.push(...data.fcmTokens);
                }
            }
        } catch (e) {
            logger.error(`Error fetching user ${uid}:`, e);
        }
    }
    return tokens;
}

// ============================================================================
// ヘルパー: 通知送信（重複コード削減）
// ============================================================================
async function sendToTokens(tokens, message) {
    let sent = 0;
    for (const token of tokens) {
        try {
            await getMessaging().send({ ...message, token });
            sent++;
        } catch (e) {
            logger.error("Send error:", e.code, e.message);
            if (e.code === "messaging/invalid-registration-token" ||
                e.code === "messaging/registration-token-not-registered") {
                await removeInvalidToken(token);
            }
        }
    }
    return sent;
}

// ============================================================================
// トリガー1: カレンダー更新時の通知（集合提案 & 全員完了）
// ============================================================================
exports.onCalendarUpdate = onDocumentUpdated({
    document: "calendars/{calId}",
    memory: "128MiB",
    timeoutSeconds: 30,
    minInstances: 0,
}, async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after) return;

    const calId = event.params.calId;
    const calName = after.name || "カレンダー";
    const members = after.members || [];

    // ========== 新しい提案を検出 ==========
    const beforeProposals = before.proposals || [];
    const afterProposals = after.proposals || [];
    const beforeIds = new Set(beforeProposals.map(p => String(p.id)));
    const newProposals = afterProposals.filter(p => !beforeIds.has(String(p.id)));

    for (const proposal of newProposals) {
        const tokens = await getMemberTokens(members, proposal.from, 'proposal');
        if (tokens.length === 0) continue;

        const memberName = (after.memberNames && after.memberNames[proposal.from]) || "メンバー";
        const dateStr = proposal.date || "";
        let timeStr = proposal.startTime || "";
        if (proposal.endTime) timeStr += `〜${proposal.endTime}`;

        const message = {
            data: {
                type: "proposal",
                calId,
                title: `📩 ${calName}`,
                body: `${memberName}さんが ${dateStr} ${timeStr} の集合を提案しました`,
            },
        };

        const sent = await sendToTokens(tokens, message);
        logger.info(`Proposal notification sent to ${sent}/${tokens.length} tokens`);
    }

    // ========== 全員完了を検出 ==========
    const beforeCompNotifs = before.completionNotifs || [];
    const afterCompNotifs = after.completionNotifs || [];

    // 新しい completionNotif を検出（IDベースで比較）
    const beforeCompIds = new Set(beforeCompNotifs.map(n => String(n.id)));
    const newCompNotifs = afterCompNotifs.filter(n => !beforeCompIds.has(String(n.id)));

    for (const notif of newCompNotifs) {
        if (notif.from !== "all") continue;

        logger.info("All members completed - sending push notification");
        const tokens = await getMemberTokens(members, null, 'completion');
        if (tokens.length === 0) continue;

        const message = {
            data: {
                type: "completion",
                calId,
                title: `🎉 ${calName}`,
                body: `${notif.monthLabel || notif.month}の予定登録が全員完了しました！`,
            },
        };

        const sent = await sendToTokens(tokens, message);
        logger.info(`Completion notification sent to ${sent}/${tokens.length} tokens`);
    }

    // ========== 投票確定（全員OK）を検出 ==========
    for (const afterP of afterProposals) {
        const votes = afterP.votes || {};
        // 全メンバーがOK投票しているか確認
        const allOk = members.length > 0 && members.every(uid => votes[uid] === 'ok');
        if (!allOk) continue;

        // 更新前の同じ提案では全員OKではなかったことを確認（重複通知防止）
        const beforeP = beforeProposals.find(p => String(p.id) === String(afterP.id));
        if (beforeP) {
            const beforeVotes = beforeP.votes || {};
            const wasAllOk = members.every(uid => beforeVotes[uid] === 'ok');
            if (wasAllOk) continue; // 既に確定済みだったのでスキップ
        }

        logger.info(`Vote confirmed (all OK) for proposal ${afterP.id} on ${afterP.date}`);
        const tokens = await getMemberTokens(members, null, 'confirmed');
        if (tokens.length === 0) continue;

        const dateStr = afterP.date || "";
        let timeStr = afterP.startTime || "";
        if (afterP.endTime) timeStr += `〜${afterP.endTime}`;

        const message = {
            data: {
                type: "confirmed",
                calId,
                title: `🏅 ${calName}`,
                body: `${dateStr} ${timeStr} の予定が確定しました！全員参加OK！`,
            },
        };

        const sent = await sendToTokens(tokens, message);
        logger.info(`Confirmed notification sent to ${sent}/${tokens.length} tokens`);
    }
});

// ============================================================================
// トリガー2: リマインド通知（毎時実行 - JST基準）
// ============================================================================
exports.sendReminders = onSchedule({
    schedule: "0 * * * *",
    memory: "128MiB",
    timeoutSeconds: 30,
    minInstances: 0,
}, async (event) => {
    const jst = getJST();
    const todayStr = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    const nowHour = jst.getUTCHours();
    const nowMinute = jst.getUTCMinutes();

    logger.info(`Reminder check: JST date=${todayStr}, time=${nowHour}:${String(nowMinute).padStart(2, "0")}`);

    const calendarsSnap = await db.collection("calendars").get();
    let remindersSent = 0;
    // ユーザー情報キャッシュ（同じユーザーのFirestore読み取りを1回で済ませる）
    const userCache = new Map();

    for (const calDoc of calendarsSnap.docs) {
        const cal = calDoc.data();
        const proposals = cal.proposals || [];

        // 今日の提案を検索
        const todayProposals = proposals.filter(p => p.date === todayStr);
        if (todayProposals.length === 0) continue;

        logger.info(`Calendar ${calDoc.id}: ${todayProposals.length} proposals today`);

        for (const proposal of todayProposals) {
            if (!proposal.startTime) continue;
            const [eventHour, eventMinute] = proposal.startTime.split(":").map(Number);

            const members = cal.members || [];
            for (const uid of members) {
                let userData;
                if (userCache.has(uid)) {
                    userData = userCache.get(uid);
                } else {
                    const userDoc = await db.collection("users").doc(uid).get();
                    if (!userDoc.exists) {
                        userCache.set(uid, null);
                        continue;
                    }
                    userData = userDoc.data();
                    userCache.set(uid, userData);
                }
                if (!userData) continue;
                const reminderHours = userData.reminderHours !== undefined ? userData.reminderHours : 1;
                if (reminderHours < 0) continue; // リマインド無効

                // リマインド時刻を計算（イベント時刻 - リマインド時間）
                const eventMinutes = eventHour * 60 + eventMinute;
                const reminderMinutes = eventMinutes - (reminderHours * 60);
                const nowMinutes = nowHour * 60 + nowMinute;

                // リマインド時刻から30分以内なら通知を送信
                const diff = Math.abs(nowMinutes - reminderMinutes);
                if (diff > 30) continue;

                // 重複送信チェック
                const reminderKey = `reminder_${proposal.id}_${uid}_${todayStr}`;
                const sentDoc = await db.collection("sentReminders").doc(reminderKey).get();
                if (sentDoc.exists) continue;

                const tokens = userData.fcmTokens || [];
                if (tokens.length === 0) continue;

                const calName = cal.name || "カレンダー";
                const message = {
                    data: {
                        type: "reminder",
                        calId: calDoc.id,
                        title: `⏰ ${calName}`,
                        body: `今日 ${proposal.startTime} から予定があります！`,
                    },
                };

                await sendToTokens(tokens, message);

                // 送信済み記録
                await db.collection("sentReminders").doc(reminderKey).set({
                    sentAt: jst.toISOString(),
                    proposalId: proposal.id,
                    uid: uid,
                });
                remindersSent++;
            }
        }
    }

    logger.info(`Reminder check complete: ${remindersSent} reminders sent`);
});

// ============================================================================
// 無効トークンの削除
// ============================================================================
async function removeInvalidToken(token) {
    const usersSnap = await db.collection("users").get();
    for (const userDoc of usersSnap.docs) {
        const data = userDoc.data();
        if (data.fcmTokens && data.fcmTokens.includes(token)) {
            const updated = data.fcmTokens.filter(t => t !== token);
            await userDoc.ref.update({ fcmTokens: updated });
            logger.info(`Removed invalid token from user ${userDoc.id}`);
        }
    }
}
