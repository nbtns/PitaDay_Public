// ============================================================================
// PitaDay インタラクティブ チュートリアル（短縮版 3ステップ）
// ============================================================================

const COACH_STEPS = [
    {
        // Step 0: ウェルカム
        target: null,
        title: 'PitaDay へようこそ！ 📅',
        text: 'みんなの空きが一目でわかる\nスケジュール調整アプリです',
        position: 'center',
        emoji: '👋'
    },
    {
        // Step 1: 新規作成ボタン
        target: '#openCreateModal',
        title: 'まずはカレンダーを作ろう ✨',
        text: 'ここから新しいカレンダーを作って\nメンバーを招待しましょう！',
        position: 'top'
    },
    {
        // Step 2: 完了
        target: null,
        title: '準備完了！ 🎉',
        text: '日付をタップしてスケジュールを登録すれば\nみんなの空き状況が自動で計算されます',
        position: 'center',
        emoji: '🚀',
        isLast: true
    }
];

let coachStep = 0;
let coachActive = false;
let coachRetryCount = 0;
const COACH_MAX_RETRIES = 5;

function showTutorial() {
    coachStep = 0;
    coachActive = true;
    // カレンダータブに戻す
    const calTab = document.querySelector('[data-tab="tabCalendar"]');
    if (calTab) calTab.click();
    // カレンダー一覧に戻す
    const listView = document.getElementById('calendarListView');
    const detailView = document.getElementById('calendarDetailView');
    if (listView) listView.classList.remove('hidden');
    if (detailView) detailView.classList.add('hidden');
    // 日付モーダルを閉じる
    const dateModal = document.getElementById('dateModal');
    if (dateModal) dateModal.classList.add('hidden');
    // チュートリアル中はCookie同意バナーを非表示にする（重なり防止）
    const cookieBanner = document.getElementById('cookieConsentBanner');
    if (cookieBanner) cookieBanner.classList.add('hidden');

    setTimeout(() => renderCoachStep(), 100);
}

function closeTutorial() {
    coachActive = false;
    const overlay = document.getElementById('tutorialOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.classList.remove('coach-spotlight-mode');
        overlay.innerHTML = '<div id="tutorialContent"></div>';
    }
    document.body.style.overflow = '';
    localStorage.setItem('tutorialDone', 'true');
    // 日付モーダル閉じる
    const dateModal = document.getElementById('dateModal');
    if (dateModal) dateModal.classList.add('hidden');
    // カレンダー詳細画面を閉じてリスト画面に戻す
    const detailView = document.getElementById('calendarDetailView');
    const listView = document.getElementById('calendarListView');
    if (detailView && !detailView.classList.contains('hidden')) {
        detailView.classList.add('hidden');
        if (listView) listView.classList.remove('hidden');
    }
    // タブバーを再表示（モーダル表示中に隠されている場合の復元）
    const tabBar = document.querySelector('.tab-bar');
    if (tabBar) tabBar.classList.remove('tab-bar-hidden');
    // カレンダータブに戻す
    const calTab = document.querySelector('[data-tab="tabCalendar"]');
    if (calTab) calTab.click();
    // Cookie同意バナーを再表示（まだ同意していない場合のみ）
    if (!localStorage.getItem('cookieConsent')) {
        const cookieBanner = document.getElementById('cookieConsentBanner');
        if (cookieBanner) cookieBanner.classList.remove('hidden');
    }
}

function renderCoachStep() {
    if (!coachActive) return;
    const step = COACH_STEPS[coachStep];
    const overlay = document.getElementById('tutorialOverlay');
    if (!overlay) return;

    const total = COACH_STEPS.length;
    const isLast = step.isLast === true;
    const isFirst = coachStep === 0;

    // ドットHTML
    let dotsHtml = '<div class="coach-dots">';
    for (let i = 0; i < total; i++) {
        dotsHtml += `<span class="coach-dot ${i === coachStep ? 'active' : ''}"></span>`;
    }
    dotsHtml += '</div>';

    if (step.target === null) {
        overlay.className = 'active';
        overlay.style.cssText = '';
        overlay.innerHTML = `
            ${isLast ? '' : '<button class="coach-skip" onclick="window.closeTutorial()">スキップ</button>'}
            <div class="coach-fullscreen">
                <div class="coach-center-content">
                    <div class="coach-center-emoji">${step.emoji || '📅'}</div>
                    <h2 class="coach-center-title">${step.title}</h2>
                    <p class="coach-center-text">${step.text.replace(/\n/g, '<br>')}</p>
                </div>
                ${dotsHtml}
                <div class="coach-buttons">
                    ${!isFirst ? `<button class="coach-btn-prev" onclick="window.coachPrev()"><i class="fa-solid fa-chevron-left"></i> 戻る</button>` : '<div></div>'}
                    <button class="coach-btn-next" onclick="${isLast ? 'window.closeTutorial()' : 'window.coachNext()'}">
                        ${isLast ? '<i class="fa-solid fa-rocket"></i> はじめる！' : '次へ <i class="fa-solid fa-chevron-right"></i>'}
                    </button>
                </div>
            </div>
        `;
        return;
    }

    const targetEl = document.querySelector(step.target);
    const targetRect = targetEl ? targetEl.getBoundingClientRect() : null;

    // 要素が見つからない、または描画前（rect=0,0）の場合はリトライ
    if (!targetEl || (targetRect.width === 0 && targetRect.height === 0)) {
        if (coachRetryCount < COACH_MAX_RETRIES) {
            coachRetryCount++;
            setTimeout(() => renderCoachStep(), 500);
            return;
        }
        // リトライ上限 → スキップ
        coachRetryCount = 0;
        coachStep++;
        if (coachStep < total) renderCoachStep();
        return;
    }
    coachRetryCount = 0;

    const rect = targetEl.getBoundingClientRect();
    const padding = 8;
    let spotX = rect.left - padding;
    let spotY = rect.top - padding;
    let spotW = rect.width + padding * 2;
    let spotH = rect.height + padding * 2;

    const svgW = window.innerWidth;
    const svgH = window.innerHeight;

    // ハイライト枠が画面外にはみ出さないようにクランプ
    const edgeMargin = 2;
    if (spotX < edgeMargin) { spotW -= (edgeMargin - spotX); spotX = edgeMargin; }
    if (spotY < edgeMargin) { spotH -= (edgeMargin - spotY); spotY = edgeMargin; }
    if (spotX + spotW > svgW - edgeMargin) { spotW = svgW - spotX - edgeMargin; }
    if (spotY + spotH > svgH - edgeMargin) { spotH = svgH - spotY - edgeMargin; }
    const spotR = Math.min(16, spotH / 2);

    let tooltipStyle = '';
    let arrowClass = '';
    const tooltipMaxW = Math.min(300, svgW - 40);
    const tooltipEstH = 200;

    // ターゲットの中心X座標
    const targetCenterX = rect.left + rect.width / 2;

    // tooltipの左位置計算
    const tooltipLeft = Math.max(20, Math.min(targetCenterX - tooltipMaxW / 2, svgW - tooltipMaxW - 20));

    // 矢印のX位置
    const arrowLeftInTooltip = Math.max(20, Math.min(targetCenterX - tooltipLeft, tooltipMaxW - 20));

    const spaceAbove = rect.top - padding - 16;
    const spaceBelow = svgH - rect.bottom - padding - 16;

    let showBelow;

    if (step.position === 'bottom') {
        showBelow = spaceBelow >= tooltipEstH;
    } else if (step.position === 'top') {
        showBelow = spaceAbove < tooltipEstH;
    }

    const arrowLeftStyle = `--arrow-left:${arrowLeftInTooltip}px;`;

    if (showBelow) {
        tooltipStyle = `top:${rect.bottom + padding + 16}px; left:${tooltipLeft}px; width:${tooltipMaxW}px; ${arrowLeftStyle}`;
        arrowClass = 'arrow-top';
    } else {
        const rawBottom = svgH - rect.top + padding + 16;
        const minBottom = tooltipEstH + 20;
        const safeBottom = Math.max(rawBottom, minBottom);
        tooltipStyle = `bottom:${safeBottom}px; left:${tooltipLeft}px; width:${tooltipMaxW}px; ${arrowLeftStyle}`;
        arrowClass = 'arrow-bottom';
    }

    overlay.className = 'active coach-spotlight-mode';
    overlay.style.cssText = '';
    overlay.innerHTML = `
        <svg class="coach-spotlight-svg" width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <mask id="spotMask">
                    <rect width="100%" height="100%" fill="white"/>
                    <rect x="${spotX}" y="${spotY}" width="${spotW}" height="${spotH}" rx="${spotR}" fill="black"/>
                </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(0,0,0,0.75)" mask="url(#spotMask)"/>
            <rect x="${spotX}" y="${spotY}" width="${spotW}" height="${spotH}" rx="${spotR}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="0.7"/>
        </svg>
        <div class="coach-tooltip ${arrowClass}" style="${tooltipStyle}">
            <h3 class="coach-tooltip-title">${step.title}</h3>
            <p class="coach-tooltip-text">${step.text.replace(/\n/g, '<br>')}</p>
            ${dotsHtml}
            <div class="coach-buttons">
                ${!isFirst ? `<button class="coach-btn-prev" onclick="window.coachPrev()"><i class="fa-solid fa-chevron-left"></i></button>` : '<div></div>'}
                <button class="coach-btn-next" onclick="window.coachNext()">
                    次へ <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        </div>
        <button class="coach-skip coach-skip-spotlight" onclick="window.closeTutorial()">スキップ</button>
    `;
}

function coachNext() {
    if (coachStep >= COACH_STEPS.length) {
        closeTutorial();
        return;
    }

    coachStep++;
    if (coachStep >= COACH_STEPS.length) {
        closeTutorial();
    } else {
        renderCoachStep();
    }
}

function coachPrev() {
    if (coachStep <= 0) return;
    coachStep--;
    setTimeout(() => renderCoachStep(), 200);
}

// リサイズ時に再描画
window.addEventListener('resize', () => {
    if (coachActive) renderCoachStep();
});

// グローバル公開
window.showTutorial = showTutorial;
window.closeTutorial = closeTutorial;
window.coachNext = coachNext;
window.coachPrev = coachPrev;
