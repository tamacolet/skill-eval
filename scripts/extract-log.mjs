#!/usr/bin/env node
// Claude Code の会話ログ（jsonl）から、人の発言・選択式の回答・使ったskill・skillへの書き込みだけを抜き出す。
// 判定はしない。rule / once は読む人が見るための目印。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const RULE_RE = /今後も|今後は|次から|これから(?:も|は)|毎回|必ず|常に|覚えておいて|忘れないで|二度と|以後|ルール化|(?:skill|スキル)\s*(?:に|へ)?\s*(?:登録|入れ|いれ|反映|追加|更新)|で統一|に統一/i;
const ONCE_RE = /今回だけ|今回は|今回のみ|この[^\s、。]{1,8}だけ|今だけ|とりあえず|一旦|いったん|(?:時|とき|場合)だけ|に限り|に限って/;
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const LABEL = { human: '人', peer: '中継', answer: '回答' };
const STOP_HOOK = 'Stop hook feedback:';
// 留守中に代わりに答える仕組みが入れる句（作者の環境のもの。無い環境では0件になる）
const AUTO_ANSWER = 'ユーザーは席を外しています';
const USAGE = [
  '使い方:',
  '  node extract-log.mjs extract <sessionId または .jsonl のパス>... [--project <作業フォルダ>] [--json] [--max-chars 1500] [--context-chars 400] [--out <file>]',
  '  node extract-log.mjs find --grep <語> [--project <作業フォルダ>] [--all-projects] [--days 3] [--json]',
].join('\n');
const VALUE_FLAGS = { '--project': 'project', '--max-chars': 'maxChars', '--context-chars': 'contextChars', '--out': 'out', '--grep': 'grep', '--days': 'days', '--projects-root': 'projectsRoot' };
const SWITCHES = { '--json': 'json', '--all-projects': 'allProjects' };

export class UsageError extends Error {}
const usage = (msg) => new UsageError(msg);

export function projectDirName(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function projectDir(opts) {
  return path.join(opts.projectsRoot, projectDirName(opts.project ?? process.cwd()));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

// 人の発言の整形。コマンドは「/x 引数」の1行にし、引数が空なら null（無視）
export function humanBody(raw) {
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw);
    const body = (args?.[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!body) return null;
    const name = cmd[1].trim();
    return { text: `${name} ${body}`, command: name };
  }
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // 実ログは閉じタグに属性が付く（</pasted_content id=…>）ことがあり、閉じ忘れの貼り付けもあるので文末まで囲む
    .replace(/<pasted_content[^>]*>([\s\S]*?)(?:<\/pasted_content[^>]*>|$)/g, (_, body) => `〔貼り付け〕${body}〔貼り付け終わり〕`)
    .trim();
  return text ? { text } : null;
}

function withBody(kind, raw) {
  const body = humanBody(raw);
  return body ? [{ kind, ...body }] : [];
}

function answerItems({ answers, annotations = {} }) {
  return Object.entries(answers).map(([question, answer]) => ({
    kind: 'answer',
    question,
    text: [].concat(answer).join('、'),
    note: annotations[question]?.notes ?? '',
  }));
}

// AIの作業中に割り込んで送った発言は user 行にならず、attachment（queued_command）にだけ残る
function queuedItems(a) {
  const kind = a?.origin?.kind;
  if (a?.type !== 'queued_command' || (kind !== 'human' && kind !== 'peer') || typeof a.prompt !== 'string') return [];
  return withBody(kind, a.prompt).map((item) => ({ ...item, at: a.timestamp }));
}

// 1行のログから取り出す項目。一覧に入れないものは空配列
function classify(o) {
  if (o.type === 'attachment') return queuedItems(o.attachment);
  if (o.type !== 'user' || o.isCompactSummary) return [];
  if (o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.answers) {
    return answerItems(o.toolUseResult);
  }
  // 選択式の質問を自動応答が代わりに答えた分（本人の回答ではない）
  if (typeof o.toolUseResult === 'string' && o.toolUseResult.includes(AUTO_ANSWER)) return [{ kind: 'auto' }];
  const raw = textOf(o.message?.content);
  if (o.origin?.kind === 'peer') return withBody('peer', raw);
  if (o.isMeta) return raw.trimStart().startsWith(STOP_HOOK) && raw.includes(AUTO_ANSWER) ? [{ kind: 'auto' }] : [];
  if (o.origin?.kind === 'human') return withBody('human', raw);
  return [];
}

export function marksOf(text) {
  return [RULE_RE.test(text) && 'rule', ONCE_RE.test(text) && 'once'].filter(Boolean);
}

// 0 は切らない。超えたら末尾に全字数を付ける
export function cut(text, max) {
  const chars = Array.from(text);
  return max && chars.length > max ? `${chars.slice(0, max).join('')}…（全${chars.length}字）` : text;
}

function newState() {
  return { seen: new Set(), items: [], skills: new Map(), writes: new Map(), auto: 0, lastAi: '', title: '', minT: null, maxT: null };
}

function addSkill(st, name, field) {
  const s = st.skills.get(name) ?? { name, calls: 0, reads: 0 };
  s[field] += 1;
  st.skills.set(name, s);
}

function skillOfPath(p) {
  return /\/skills\/([^/]+)\//.exec(p)?.[1] ?? null;
}

function noteToolUse(st, { name, input = {} }, at) {
  if (name === 'Skill' && input.skill) return addSkill(st, input.skill, 'calls');
  const p = typeof input.file_path === 'string' ? input.file_path : '';
  const skill = skillOfPath(p);
  if (!skill) return;
  if (name === 'Read') return addSkill(st, skill, 'reads');
  if (WRITE_TOOLS.includes(name)) {
    const w = st.writes.get(p) ?? { count: 0, firstAt: at };
    w.count += 1;
    st.writes.set(p, w);
  }
}

function noteAssistant(st, o) {
  if (!Array.isArray(o.message?.content)) return;
  for (const b of o.message.content) {
    if (b.type === 'text' && b.text?.trim()) st.lastAi = b.text.trim();
    if (b.type === 'tool_use') noteToolUse(st, b, o.timestamp);
  }
}

function addItem(st, item, at, opts) {
  if (item.kind === 'auto') {
    st.auto += 1;
    return;
  }
  if (item.command) addSkill(st, item.command.slice(1), 'calls');
  const marks = marksOf(`${item.text} ${item.note ?? ''}`);
  if (item.kind === 'answer') {
    st.items.push({ kind: 'answer', at, marks, question: item.question, answer: cut(item.text, opts.maxChars), note: cut(item.note, opts.maxChars) });
    return;
  }
  const context = st.lastAi ? cut(st.lastAi, opts.contextChars) : null;
  st.items.push({ kind: item.kind, at, marks, text: cut(item.text, opts.maxChars), context });
}

function trackTime(st, ts) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return;
  st.minT = st.minT === null ? t : Math.min(st.minT, t);
  st.maxT = st.maxT === null ? t : Math.max(st.maxT, t);
}

async function* readJsonLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 壊れた行は飛ばす
    }
    if (parsed && typeof parsed === 'object') yield parsed;
  }
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

export async function parseSession(file, opts = {}) {
  const cutOpts = { maxChars: opts.maxChars ?? 1500, contextChars: opts.contextChars ?? 400 };
  const st = newState();
  for await (const o of readJsonLines(file)) {
    if (o.isSidechain || (o.uuid && st.seen.has(o.uuid))) continue;
    if (o.uuid) st.seen.add(o.uuid);
    trackTime(st, o.timestamp);
    if (o.type === 'ai-title' && o.aiTitle) st.title = o.aiTitle;
    if (o.type === 'assistant') noteAssistant(st, o);
    for (const item of classify(o)) addItem(st, item, item.at ?? o.timestamp, cutOpts);
  }
  return {
    sessionId: path.basename(file, '.jsonl'),
    title: st.title,
    start: iso(st.minT),
    end: iso(st.maxT),
    autoReplies: st.auto,
    skills: [...st.skills.values()],
    skillWrites: [...st.writes].map(([p, w]) => ({ path: p, count: w.count, firstAt: w.firstAt })),
    items: st.items,
  };
}

function jstTime(iso) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const d = new Date(t + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function skillLine(skills) {
  const list = [...skills]
    .sort((a, b) => b.calls + b.reads - a.calls - a.reads)
    .map((s) => `${s.name}（${[s.calls && `呼び出し${s.calls}`, s.reads && `読んだ${s.reads}`].filter(Boolean).join('・')}）`);
  return list.length ? list.join('、') : 'なし';
}

function itemBlock(item, n) {
  const marks = item.marks.length ? ` [${item.marks.join(', ')}]` : '';
  const head = `### ${n}. ${jstTime(item.at)} ${LABEL[item.kind]}${marks}`;
  if (item.kind === 'answer') {
    const note = item.note ? ` （メモ: ${item.note}）` : '';
    return [head, `Q: ${item.question}`, `A: ${item.answer}${note}`].join('\n');
  }
  const ctx = item.context ? [`> 直前のAI: ${item.context.replace(/\s*\n\s*/g, ' ')}`] : [];
  return [head, ...ctx, item.text].join('\n');
}

export function renderMarkdown(s) {
  const count = (kind) => s.items.filter((i) => i.kind === kind).length;
  const writes = s.skillWrites.map((w) => `  - ${w.path} ×${w.count}（${jstTime(w.firstAt)}〜）`);
  const head = [
    `# ${s.title || '(無題)'}（${s.sessionId.slice(0, 8)}）`,
    `- 期間: ${jstTime(s.start)} 〜 ${jstTime(s.end)} ／ 人の発言 ${count('human')}・中継 ${count('peer')}・回答 ${count('answer')}・自動応答 ${s.autoReplies}（一覧外）`,
    `- 使ったskill: ${skillLine(s.skills)}`,
    ...(writes.length ? ['- skillへの書き込み:', ...writes] : ['- skillへの書き込み: なし']),
  ];
  const body = s.items.length ? s.items.map((it, i) => itemBlock(it, i + 1)).join('\n\n') : '（該当なし）';
  return [...head, '', '## 発言', '', body, ''].join('\n');
}

export function render(sessions, { json }) {
  if (json) return `${JSON.stringify({ sessions }, null, 2)}\n`;
  return sessions.map(renderMarkdown).join('\n');
}

function resolveId(prefix, opts) {
  const dir = projectDir(opts);
  if (!fs.existsSync(dir)) throw usage(`ログ置き場が見つかりません: ${dir}。--project で作業フォルダを確認してください`);
  const ids = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => id.startsWith(prefix));
  if (ids.length === 0) throw usage(`セッション ${prefix} が見つかりません。--project の作業フォルダが正しいか確認してください`);
  if (ids.length > 1) throw usage(`セッション ${prefix} が${ids.length}件に当たりました。もっと長く指定してください: ${ids.join(', ')}`);
  return path.join(dir, `${ids[0]}.jsonl`);
}

export function resolveSessionFiles(args, opts) {
  if (args.length === 0) throw usage('セッションIDか .jsonl のパスを1つ以上指定してください');
  return args.map((arg) => {
    if (!arg.endsWith('.jsonl')) return resolveId(arg, opts);
    if (!fs.existsSync(arg)) throw usage(`ファイルが見つかりません: ${arg}`);
    return path.resolve(arg);
  });
}

function recentFiles(dir, cutoff) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ file: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
    .filter(({ stat }) => stat.mtimeMs >= cutoff);
}

// 人の発言（human・peer）に grep の語を含むセッションを、更新が新しい順に返す
export async function findSessions(opts) {
  const roots = opts.allProjects
    ? fs.readdirSync(opts.projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [null];
  const cutoff = Date.now() - opts.days * 86400000;
  const needle = opts.grep.toLowerCase();
  const found = [];
  for (const project of roots) {
    const dir = project ? path.join(opts.projectsRoot, project) : projectDir(opts);
    if (!fs.existsSync(dir)) continue;
    for (const { file, stat } of recentFiles(dir, cutoff)) {
      const s = await parseSession(file, { maxChars: 0 });
      const hits = s.items.filter((i) => i.kind !== 'answer' && i.text.toLowerCase().includes(needle));
      if (hits.length === 0) continue;
      const first = s.items.find((i) => i.kind === 'human')?.text ?? '';
      found.push({ project, sessionId: s.sessionId, updatedAt: stat.mtime.toISOString(), size: stat.size, title: s.title, hits: hits.length, first: Array.from(first.replace(/\s+/g, ' ')).slice(0, 60).join(''), mtimeMs: stat.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const fmtSize = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)}MB` : `${Math.round(bytes / 1e3)}KB`);

function fmtFound(r) {
  const cols = [r.sessionId.slice(0, 8), jstTime(r.updatedAt), fmtSize(r.size), r.title || '(無題)', String(r.hits), r.first];
  return (r.project ? [r.project, ...cols] : cols).join(' | ');
}

function intOpt(value, def, name, min = 0) {
  const n = value === undefined ? def : Number(value);
  if (!Number.isInteger(n) || n < min) throw usage(`${name} には ${min} 以上の整数を指定してください（指定値: ${value}）`);
  return n;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const raw = { positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (Object.hasOwn(SWITCHES, a)) {
      raw[SWITCHES[a]] = true;
    } else if (Object.hasOwn(VALUE_FLAGS, a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw usage(`${a} には値を指定してください`);
      raw[VALUE_FLAGS[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      throw usage(`不明なオプションです: ${a}`);
    } else {
      raw.positional.push(a);
    }
  }
  return {
    command,
    ...raw,
    maxChars: intOpt(raw.maxChars, 1500, '--max-chars'),
    contextChars: intOpt(raw.contextChars, 400, '--context-chars'),
    days: intOpt(raw.days, 3, '--days', 1),
    projectsRoot: raw.projectsRoot ?? DEFAULT_PROJECTS_ROOT,
    out: raw.out ? path.resolve(raw.out) : undefined,
  };
}

async function runExtract(opts) {
  const files = resolveSessionFiles(opts.positional, opts);
  const sessions = [];
  for (const f of files) sessions.push(await parseSession(f, opts));
  const body = render(sessions, opts);
  if (!opts.out) {
    process.stdout.write(body);
    return;
  }
  fs.writeFileSync(opts.out, body);
  const total = sessions.reduce((n, s) => n + s.items.length, 0);
  process.stdout.write(`書き出しました: ${opts.out}（${total}件）\n`);
}

async function runFind(opts) {
  if (!opts.grep) throw usage('--grep <語> を指定してください');
  const rows = await findSessions(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(rows.map(({ mtimeMs, ...r }) => r), null, 2)}\n`);
    return;
  }
  const text = rows.length ? rows.map(fmtFound).join('\n') : `該当するセッションはありません（更新が${opts.days}日以内のもの）`;
  process.stdout.write(`${text}\n`);
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === 'extract') return runExtract(opts);
  if (opts.command === 'find') return runFind(opts);
  throw usage(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  });
}
