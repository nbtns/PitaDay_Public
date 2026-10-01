import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './prepare-config.mjs';

function list(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (['.git', 'node_modules'].includes(entry.name)) return [];
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? list(filename) : [filename];
    });
}
const files = list(projectRoot);
const forbiddenNames = new Set(['config.local.js', 'memo.md', 'CLAUDE.md', 'GEMINI.md', 'PROJECT_STATUS.md', '.firebaserc']);
const patterns = [
    /\bAIza[A-Za-z0-9_-]{30,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /GOCSPX-[A-Za-z0-9_-]{15,}/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bsk_(?:live|test)_[A-Za-z0-9]{15,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
    /pitaday-a869f|pitaday-dev|ca-pub-8988019758677266|pitaday\.app@gmail\.com/
];
let syntaxCount = 0;
for (const filename of files) {
    const relative = path.relative(projectRoot, filename);
    // 実行時に生成する設定と.envは公開対象から除外される。追跡漏れはGitleaksでも検出する。
    if (['public/config.js', 'public/sw-config.js'].includes(relative.replaceAll('\\', '/'))) continue;
    assert(!forbiddenNames.has(path.basename(filename)), '内部資料または運用設定があります: ' + relative);
    assert(!relative.split(path.sep).some(part => ['.git_disabled', '.agents', 'v50_recovery'].includes(part)), '内部フォルダがあります: ' + relative);
    if (path.basename(filename).startsWith('.env') && path.basename(filename) !== '.env.example') continue;
    if (!/\.(js|mjs|json|html|css|rules|md|yml|yaml|example)$/.test(filename) && !['.gitignore', '.env.example'].includes(path.basename(filename))) continue;
    const content = fs.readFileSync(filename, 'utf8');
    assert(!content.includes('\ufffd'), '文字化けがあります: ' + relative);
    if (!relative.startsWith('scripts' + path.sep) && !relative.startsWith('tests' + path.sep)) {
        assert(!patterns.some(pattern => pattern.test(content)), '秘密情報・運用識別子の候補があります: ' + relative);
    }
    if (/\.(js|mjs)$/.test(filename)) {
        const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: content, encoding: 'utf8' });
        assert.equal(result.status, 0, 'JavaScript構文エラー: ' + relative + '\n' + result.stderr);
        syntaxCount++;
    }
    if (filename.endsWith('.json')) JSON.parse(content);
    if (filename.endsWith('.html')) {
        const tags = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
        for (const [, script] of tags) {
            if (!script.trim()) continue;
            const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
            assert.equal(result.status, 0, 'HTML内のJavaScript構文エラー: ' + relative + '\n' + result.stderr);
        }
    }
}
for (const rule of ['firestore.rules', 'storage.rules']) {
    const content = fs.readFileSync(path.join(projectRoot, rule), 'utf8');
    assert(content.includes('allow read, write: if false;'), rule + 'は初期状態でアクセスを拒否してください');
}
for (const workflow of ['semgrep.yml', 'gitleaks.yml', 'check.yml']) assert(fs.existsSync(path.join(projectRoot, '.github/workflows', workflow)));
console.log(`公開対象の設定・内部資料・文字化け・JSONとJavaScript構文を確認しました（JavaScript ${syntaxCount}ファイル）`);
