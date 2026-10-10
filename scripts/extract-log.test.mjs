import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSession, renderMarkdown, render, resolveSessionFiles, findSessions,
  humanBody, cut, marksOf, projectDirName,
} from './extract-log.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract-log.mjs');
const T1 = '2026-10-09T08:00:00.000Z';
const T2 = '2026-10-09T09:00:00.000Z';
const T3 = '2026-10-09T10:00:00.000Z';
const SID = '1746abcd-0000-4000-8000-000000000001';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-log-'));
}

// 行の配列を1つの jsonl にして返す（文字列の行は壊れた行としてそのまま書く）
function writeLog(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

const human = (uuid, text, timestamp = T1) => ({ type: 'user', uuid, timestamp, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const ai = (uuid, content, timestamp = T1) => ({ type: 'assistant', uuid, timestamp, message: { role: 'assistant', content } });
const toolUse = (name, input) => ({ type: 'tool_use', name, input });

async function parseRows(rows, opts) {
  const file = writeLog(path.join(tmpDir(), `${SID}.jsonl`), rows);
  return parseSession(file, opts);
}

test('人・中継・回答だけが一覧に入り、他は数えない', async () => {
  const s = await parseRows([
    human('u1', 'サムネも5案作って'),
    { type: 'user', uuid: 'u2', timestamp: T1, origin: { kind: 'peer' }, isMeta: true, message: { content: 'Another Claude session sent a message: 参考' } },
    { type: 'user', uuid: 'u3', timestamp: T1, toolUseResult: { answers: { 'どの案にしますか？': 'B案' }, annotations: { 'どの案にしますか？': { notes: '明るい方' } } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'user', uuid: 'u4', isCompactSummary: true, origin: { kind: 'human' }, message: { content: 'summary' } },
    { type: 'user', uuid: 'u5', isMeta: true, message: { content: 'Base directory for this skill: /x' } },
    { type: 'user', uuid: 'u6', origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } },
    { type: 'user', uuid: 'u7', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'out' }] } },
    { ...human('u8', '子の会話の発言'), isSidechain: true },
    { type: 'user', uuid: 'u9', isMeta: true, message: { content: 'Stop hook feedback:\n（自動応答: ユーザーは席を外しています。以下は…）A案で' } },
    { type: 'user', uuid: 'u10', isMeta: true, message: { content: 'Stop hook feedback:\nユーザーは席を外しています（自動応答）。返事を待たずに' } },
    { type: 'user', uuid: 'u11', isMeta: true, message: { content: 'Stop hook feedback:\n終了報告が300字を超えています' } },
    { type: 'user', uuid: 'u12', timestamp: T1, toolUseResult: 'Error: PreToolUse:AskUserQuestion hook error: （自動応答: ユーザーは席を外しています。以下は…）毎回で', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', is_error: true, content: 'x' }] } },
  ]);
  assert.deepEqual(s.items.map((i) => i.kind), ['human', 'peer', 'answer']);
  assert.equal(s.autoReplies, 3);
  assert.equal(s.items[2].question, 'どの案にしますか？');
  assert.equal(s.items[2].answer, 'B案');
  assert.equal(s.items[2].note, '明るい方');
});

test('作業中に割り込んだ発言（queued_command）を人・中継として拾い、通知は拾わない', async () => {
  const queued = (uuid, kind, prompt, extra = {}) => ({ type: 'attachment', uuid, timestamp: T3, attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind }, prompt, timestamp: T2, ...extra } });
  const s = await parseRows([
    human('u1', '動画を作って'),
    ai('a1', [{ type: 'text', text: '作っています' }]),
    queued('q1', 'human', 'ソフトバンクはデビュープランを第1選択肢に 全て共通 スキルにいれておいて'),
    queued('q2', 'peer', 'Another Claude session sent a message: 参考'),
    queued('q3', 'task-notification', '<task-notification>done</task-notification>', { commandMode: 'task-notification' }),
    { type: 'attachment', uuid: 'q4', timestamp: T3, attachment: { type: 'hook_success', content: 'ok' } },
  ]);
  assert.deepEqual(s.items.map((i) => i.kind), ['human', 'human', 'peer']);
  assert.match(s.items[1].text, /スキルにいれておいて/);
  assert.equal(s.items[1].at, T2);
  assert.equal(s.items[1].context, '作っています');
  assert.ok(s.items[1].marks.includes('rule'));
});

test('system-reminder 除去・コマンドの整形・貼り付けの印', async () => {
  const s = await parseRows([
    human('u1', '<system-reminder>除く</system-reminder>本文'),
    human('u2', '<command-name>/x</command-name><command-message>x</command-message><command-args>引数 を\n渡す</command-args>'),
    human('u3', '<command-name>/clear</command-name><command-args></command-args>'),
    human('u4', 'A<pasted_content id="1">他人の文</pasted_content>B'),
    human('u5', '<system-reminder>だけ</system-reminder>  '),
    human('u6', 'C<pasted_content id="2">閉じタグに属性</pasted_content id="2">D'),
    human('u7', 'E<pasted_content id="3">閉じ忘れ'),
  ]);
  assert.deepEqual(s.items.map((i) => i.text), [
    '本文',
    '/x 引数 を 渡す',
    'A〔貼り付け〕他人の文〔貼り付け終わり〕B',
    'C〔貼り付け〕閉じタグに属性〔貼り付け終わり〕D',
    'E〔貼り付け〕閉じ忘れ〔貼り付け終わり〕',
  ]);
  assert.equal(humanBody('<command-name>/model</command-name><command-args> </command-args>'), null);
});

test('使ったskill（Skill・/x・Read）と skillへの書き込み（Edit/Write）を集計する', async () => {
  const skillFile = '/Users/me/.claude/skills/colorful-video/references/explainer-script.md';
  const s = await parseRows([
    human('u1', '<command-name>/colorful-video</command-name><command-args>作って</command-args>'),
    ai('a1', [toolUse('Skill', { skill: 'youtube-publish' })]),
    ai('a2', [
      toolUse('Read', { file_path: '/Users/me/.claude/skills/colorful-video/SKILL.md' }),
      toolUse('Read', { file_path: '/Users/me/.claude/skills/colorful-video/references/x.md' }),
    ]),
    ai('a3', [toolUse('Edit', { file_path: skillFile })], T2),
    ai('a4', [toolUse('Write', { file_path: skillFile })], T3),
    ai('a5', [toolUse('Edit', { file_path: '/Users/me/Documents/memo.md' })]),
  ]);
  assert.deepEqual(s.skills, [
    { name: 'colorful-video', calls: 1, reads: 2 },
    { name: 'youtube-publish', calls: 1, reads: 0 },
  ]);
  assert.deepEqual(s.skillWrites, [{ path: skillFile, count: 2, firstAt: T2 }]);
});

test('直前のAI発言が付き、--max-chars と --context-chars で切れて全字数が出る', async () => {
  const s = await parseRows([
    ai('a1', [{ type: 'text', text: '  前の回答です  ' }]),
    human('u1', '長い本文です'),
  ], { maxChars: 3, contextChars: 2 });
  assert.equal(s.items[0].text, '長い本…（全6字）');
  assert.equal(s.items[0].context, '前の…（全6字）');
  const full = await parseRows([ai('a1', [{ type: 'text', text: '前の回答です' }]), human('u1', '長い本文です')], { maxChars: 0 });
  assert.equal(full.items[0].text, '長い本文です');
  assert.equal(full.items[0].context, '前の回答です');
  assert.equal(cut('abcdef', 0), 'abcdef');
});

test('rule と once の目印（両方・片方・無し）', () => {
  assert.deepEqual(marksOf('今後もこの形で'), ['rule']);
  assert.deepEqual(marksOf('今回だけ短く'), ['once']);
  assert.deepEqual(marksOf('今後は今回だけ'), ['rule', 'once']);
  assert.deepEqual(marksOf('普通の文'), []);
});

test('同じ uuid は1回だけ数え、壊れた行で落ちない', async () => {
  const s = await parseRows([
    human('u1', '同じ'),
    human('u1', '同じ'),
    '{ 壊れた行',
    human('u2', '次'),
  ]);
  assert.deepEqual(s.items.map((i) => i.text), ['同じ', '次']);
});

test('sessionId は前方一致。0件・複数件はエラー', () => {
  const root = tmpDir();
  const project = '/Users/x/proj';
  const dir = path.join(root, projectDirName(project));
  writeLog(path.join(dir, '1746aaaa-0000.jsonl'), []);
  writeLog(path.join(dir, '1746bbbb-0000.jsonl'), []);
  writeLog(path.join(dir, '9999cccc-0000.jsonl'), []);
  const opts = { projectsRoot: root, project };
  assert.equal(path.basename(resolveSessionFiles(['9999'], opts)[0]), '9999cccc-0000.jsonl');
  assert.throws(() => resolveSessionFiles(['1746'], opts), /2件に当たりました/);
  assert.throws(() => resolveSessionFiles(['0000'], opts), /見つかりません/);
});

test('find は --days より古いファイルを除き、--grep を大文字小文字を無視して部分一致する', async () => {
  const root = tmpDir();
  const project = '/Users/x/proj';
  const dir = path.join(root, projectDirName(project));
  const recent = writeLog(path.join(dir, 'aaaaaaaa-recent.jsonl'), [human('u1', 'Keyword 入り')]);
  const old = writeLog(path.join(dir, 'bbbbbbbb-old.jsonl'), [human('u2', 'Keyword 入り')]);
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
  const rows = await findSessions({ projectsRoot: root, project, grep: 'keyword', days: 3, allProjects: false });
  assert.deepEqual(rows.map((r) => r.sessionId), ['aaaaaaaa-recent']);
  assert.equal(rows[0].hits, 1);
  assert.equal(rows[0].first, 'Keyword 入り');
  assert.ok(fs.existsSync(recent));
  assert.deepEqual(await findSessions({ projectsRoot: root, project, grep: 'なし', days: 3, allProjects: false }), []);
});

test('Markdown と --json の形', async () => {
  const file = writeLog(path.join(tmpDir(), `${SID}.jsonl`), [
    { type: 'ai-title', aiTitle: '題名テスト', sessionId: SID },
    ai('a1', [{ type: 'text', text: '案を出しました' }]),
    human('u1', '今後もこの形で作って'),
    { type: 'user', uuid: 'u2', timestamp: T2, toolUseResult: { answers: { 'どれ？': 'B' } }, message: { content: [] } },
  ]);
  const s = await parseSession(file);
  const md = renderMarkdown(s);
  assert.match(md, /^# 題名テスト（1746abcd）/);
  assert.match(md, /### 1\. \d\d\/\d\d \d\d:\d\d 人 \[rule\]\n> 直前のAI: 案を出しました\n今後もこの形で作って/);
  assert.match(md, /### 2\. \d\d\/\d\d \d\d:\d\d 回答\nQ: どれ？\nA: B/);
  const json = JSON.parse(render([s], { json: true }));
  assert.deepEqual(Object.keys(json.sessions[0]), ['sessionId', 'title', 'start', 'end', 'autoReplies', 'skills', 'skillWrites', 'items']);
  assert.equal(json.sessions[0].items[0].kind, 'human');
});

test('CLI: 使い方の誤りは終了コード1、extract は --out へ書いて件数を1行出す', () => {
  const bad = spawnSync(process.execPath, [SCRIPT, 'extract'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /セッションIDか \.jsonl/);
  const file = writeLog(path.join(tmpDir(), `${SID}.jsonl`), [human('u1', 'こんにちは')]);
  const out = path.join(tmpDir(), 'out.md');
  const ok = spawnSync(process.execPath, [SCRIPT, 'extract', file, '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /書き出しました: .*（1件）/);
  assert.match(fs.readFileSync(out, 'utf8'), /こんにちは/);
});
