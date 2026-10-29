'use strict';
/**
 * style.js —— 文风画像模块（PRD v2 §4 样本库 / 一键分析 / 生成时注入 / 二次改写）。
 *
 * 职责：
 * - 样文解析（parseSample：.txt/.md/.html 兼容公众号导出）与统计（computeSampleStats）；
 * - 样文库管理（addSample/removeSample，persist.js 按 id 一文件，dataDir/style-samples/）；
 * - 画像 JSON 生成（analyzeStyle：本地统计 + LLM 定性字段，mockKind='style'）与固定形状归一
 *   （normalizeProfile，画像存 cfg.style.profile，由渲染层经 config:set 保存）；
 * - few-shot 范文挑选（pickFewShots：主题词重叠打分）；
 * - 提示词注入块（buildStyleInjection：画像 + 范文 + AI 味禁用词硬约束）；
 * - 二次改写辅助（scanBannedWords：草稿禁用词扫描）。
 *
 * 依赖注入：LLM 走 llm.callLlmMessages（mock 模式由 llm.js 短路，测试零真实网络）。
 * 仅 Node 内置模块。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { jsonFiles, readJson, writeJson, removeJson, ioError } = require('./persist');
const { callLlmMessages, LlmFormatError } = require('./llm');
const { countWords } = require('./article');

/** AI 味默认禁用词（PRD v2 §4：如"首先其次总总""值得注意的是""深入探讨"、排比八股等）。 */
const DEFAULT_BANNED_WORDS = [
  '首先', '其次', '再者', '总之', '综上所述', '总而言之', '值得注意的是',
  '需要指出的是', '值得一提的是', '深入探讨', '众所周知', '不难发现',
  '由此可见', '赋能', '抓手', '闭环', '底层逻辑',
];

/** 样文单文件大小上限（1 MiB，防误选大文件）。 */
const MAX_SAMPLE_BYTES = 1024 * 1024;
/** 样文夹扫描的单层文件数上限。 */
const MAX_FOLDER_FILES = 50;
/** few-shot 单篇范文摘录默认上限（码点）。 */
const DEFAULT_FEWSHOT_CHARS = 600;
/** 画像最多保留的高频词条数。 */
const MAX_TOP_BIGRAMS = 10;

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function isoNow(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

/* ----------------------------- 样文解析与统计 ----------------------------- */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
};

function decodeEntities(s) {
  let out = String(s);
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** 是否疑似 HTML（公众号导出兼容）。 */
function looksLikeHtml(raw) {
  return /<html[\s>]|<body[\s>]|<div[\s>]|<p[\s>]|<br[\s>]*\/?>/i.test(String(raw || ''));
}

/** HTML → 纯文本（剥 script/style/head/nav/footer、块级标签转换行、解码实体）。 */
function htmlToPlain(raw) {
  let s = String(raw || '');
  s = s.replace(/<(script|style|noscript|head|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s);
}

/**
 * 解析样文 → {text, paragraphs}。
 * text：规范化的纯文本（\n 分段、行内空白折叠、首尾 trim）；paragraphs：非空行数组。
 * .txt/.md 原样规范化；html 自动剥离标签。
 */
function parseSample(raw) {
  const input = String(raw == null ? '' : raw);
  if (!input.trim()) throw inputError('样文内容为空');
  const plain = looksLikeHtml(input) ? htmlToPlain(input) : decodeEntities(input);
  const paragraphs = plain
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) throw inputError('样文解析后没有有效内容（可能只有标签或空白）');
  return { text: paragraphs.join('\n'), paragraphs };
}

/** 单个 CJK 连续段的字符二元组计数。 */
function countBigrams(paragraphs) {
  const counts = new Map();
  for (const line of paragraphs) {
    const runs = line.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || [];
    for (const run of runs) {
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 2);
        counts.set(bg, (counts.get(bg) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * 单篇样文统计（确定性）→
 * {paraCount, sentenceCount, avgSentenceLen, exclamations, questions, subtitleCount, topBigrams:[[词,次数]]}
 */
function computeSampleStats(text) {
  const { paragraphs } = parseSample(text);
  const joined = paragraphs.join('\n');
  const sentences = joined.split(/[。！？!?；;]+/).map((s) => s.trim()).filter((s) => Array.from(s).length > 1);
  const charTotal = paragraphs.reduce((acc, p) => acc + Array.from(p.replace(/\s/g, '')).length, 0);
  const bigrams = [...countBigrams(paragraphs).entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_TOP_BIGRAMS);
  return {
    paraCount: paragraphs.length,
    sentenceCount: sentences.length,
    avgSentenceLen: sentences.length ? Math.round((charTotal / sentences.length) * 10) / 10 : charTotal,
    exclamations: (joined.match(/[！!]/g) || []).length,
    questions: (joined.match(/[？?]/g) || []).length,
    subtitleCount: paragraphs.filter((p) => /^(#{1,6}\s|【|第[一二三四五六七八九十\d]+[章节部分])/.test(p)).length,
    topBigrams: bigrams,
  };
}

/** 合并多篇统计（高频词按计数合并取 Top N）。 */
function mergeStats(statsList) {
  const merged = {
    paraCount: 0, sentenceCount: 0, exclamations: 0, questions: 0, subtitleCount: 0,
    avgSentenceLen: 0, topBigrams: [],
  };
  const charTotals = [];
  const bigramTotals = new Map();
  for (const s of statsList) {
    merged.paraCount += s.paraCount;
    merged.sentenceCount += s.sentenceCount;
    merged.exclamations += s.exclamations;
    merged.questions += s.questions;
    merged.subtitleCount += s.subtitleCount;
    charTotals.push(s.avgSentenceLen * s.sentenceCount);
    for (const [w, n] of s.topBigrams || []) bigramTotals.set(w, (bigramTotals.get(w) || 0) + n);
  }
  const totalSentences = merged.sentenceCount;
  merged.avgSentenceLen = totalSentences
    ? Math.round((charTotals.reduce((a, b) => a + b, 0) / totalSentences) * 10) / 10
    : 0;
  merged.topBigrams = [...bigramTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_BIGRAMS);
  return merged;
}

/* ------------------------------- 样文库管理 ------------------------------- */

function sampleDir(dataDir) {
  return path.join(dataDir, 'style-samples');
}

/** 新增样文：内容指纹做 id（同文不重复入库）。返回 {sample, duplicate}。 */
function addSample(samples, { name, text, now } = {}) {
  if (!Array.isArray(samples)) throw inputError('addSample 需要样文数组');
  const { text: clean } = parseSample(text);
  const id = `sm-${crypto.createHash('sha256').update(clean, 'utf8').digest('hex').slice(0, 12)}`;
  const existing = samples.find((s) => s && s.id === id);
  if (existing) return { sample: existing, duplicate: true };
  const sample = {
    id,
    name: String(name || '').trim() || `样文 ${samples.length + 1}`,
    text: clean,
    words: countWords(clean),
    addedAt: isoNow(now),
  };
  samples.push(sample);
  return { sample, duplicate: false };
}

/** 移除样文：返回被移除的样文；未找到返回 null。 */
function removeSample(samples, id) {
  if (!Array.isArray(samples)) throw inputError('removeSample 需要样文数组');
  const idx = samples.findIndex((s) => s && s.id === id);
  if (idx < 0) return null;
  return samples.splice(idx, 1)[0];
}

/** 保存单篇样文到样文库目录（<id>.json，原子写）。 */
function saveSample(dataDir, sample) {
  if (!dataDir) throw ioError('保存样文失败：缺少数据目录');
  if (!sample || !sample.id) throw inputError('saveSample 需要带 id 的样文对象');
  writeJson(sampleDir(dataDir), `${sample.id}.json`, sample);
  return sample;
}

/** 读取全部样文（按加入时间升序）。 */
function loadSamples(dataDir) {
  return jsonFiles(sampleDir(dataDir))
    .map((file) => readJson(file))
    .filter(Boolean)
    .sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));
}

/** 删除样文文件（幂等）。 */
function deleteSample(dataDir, id) {
  return removeJson(sampleDir(dataDir), `${String(id || '').replace(/[\\/:*?"<>|]/g, '_')}.json`);
}

const SAMPLE_EXTS = new Set(['.txt', '.md', '.html', '.htm']);

/** 读取单个样文文件（仅 .txt/.md/.html/.htm，≤1MiB）。 */
function readSampleFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SAMPLE_EXTS.has(ext)) {
    throw inputError(`不支持的样文格式 ${ext || '（无扩展名)'}：仅支持 .txt / .md / .html`);
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    throw ioError(`样文文件不存在或不可读：${filePath}（${e.message}）`);
  }
  if (!stat.isFile()) throw inputError(`不是文件：${filePath}`);
  if (stat.size > MAX_SAMPLE_BYTES) throw inputError(`样文文件过大（${stat.size} 字节 > 1MiB）：${path.basename(filePath)}`);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw ioError(`读取样文失败：${filePath}（${e.message}）`);
  }
  const { text } = parseSample(raw);
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), text };
}

/** 扫描文件夹（单层）下全部 .txt/.md/.html 样文；最多 MAX_FOLDER_FILES 篇。 */
function scanSampleFolder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw ioError(`读取样文目录失败：${dir}（${e.message}）`);
  }
  const files = entries
    .filter((ent) => ent.isFile() && SAMPLE_EXTS.has(path.extname(ent.name).toLowerCase()))
    .map((ent) => path.join(dir, ent.name))
    .sort()
    .slice(0, MAX_FOLDER_FILES);
  const out = [];
  const errors = [];
  for (const f of files) {
    try {
      out.push(readSampleFile(f));
    } catch (e) {
      errors.push(`${path.basename(f)}：${e.message}`); // 单文件失败不阻断导入，如实记录
    }
  }
  return { samples: out, errors };
}

/* ------------------------------- 文风画像 ------------------------------- */

const QUALITATIVE_KEYS = ['opening', 'closing', 'sentenceRhythm', 'petPhrases', 'subtitleStyle', 'punctuationEmoji'];

const EMPTY_QUALITATIVE = QUALITATIVE_KEYS.reduce((acc, k) => ({ ...acc, [k]: '' }), {});

/**
 * 画像固定形状归一（config.js 注释约定的契约点：cfg.style.profile 由本函数固定形状）。
 * 非对象 → E_INVALID_INPUT；缺失字段补默认值；bannedWords 去重去空；topBigrams 取前 N；
 * 未知字段丢弃。返回新对象（不修改入参）。
 */
function normalizeProfile(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw inputError('文风画像应为对象（可在「设置 → 内容与文风」重新分析生成）');
  }
  const q = input.qualitative || {};
  const qualitative = {};
  for (const k of QUALITATIVE_KEYS) qualitative[k] = typeof q[k] === 'string' ? q[k] : '';
  let banned = Array.isArray(input.bannedWords) ? input.bannedWords : [];
  banned = [...new Set(banned.map((w) => String(w).trim()).filter(Boolean))];
  let top = Array.isArray(input.topBigrams) ? input.topBigrams : [];
  top = top
    .filter((it) => Array.isArray(it) && typeof it[0] === 'string' && it[0] && Number.isFinite(Number(it[1])))
    .map(([w, n]) => [String(w), Number(n)])
    .slice(0, MAX_TOP_BIGRAMS);
  return {
    version: 1,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '默认文风画像',
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : null,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    qualitative,
    bannedWords: banned,
    topBigrams: top,
    stats: input.stats && typeof input.stats === 'object' && !Array.isArray(input.stats) ? input.stats : null,
    sampleCount: Number.isInteger(input.sampleCount) && input.sampleCount >= 0 ? input.sampleCount : 0,
  };
}

/** 从配置读取画像：cfg.style.profile（无 → null）。 */
function loadProfile(cfg) {
  const p = cfg && cfg.style && cfg.style.profile;
  return p ? normalizeProfile(p) : null;
}

/** 一键分析提示词：要求 LLM 只输出约定 JSON（mockStyleProfileRaw 按同格式返回）。 */
function buildAnalysisPrompt(samples, stats) {
  const excerpts = samples
    .map((s, i) => `[样文${i + 1}·${s.name}] ${Array.from(s.text).slice(0, 400).join('')}${Array.from(s.text).length > 400 ? '…' : ''}`)
    .join('\n');
  return [
    '你是文风分析师。请分析下面样文的语言风格，只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），字段为：',
    '{"opening":"开头习惯","closing":"结尾习惯","sentenceRhythm":"句长节奏","petPhrases":"口头禅","subtitleStyle":"小标题风格（若是整齐排比请注明）","punctuationEmoji":"标点与表情习惯","bannedWordsExtra":["额外建议禁用的 AI 味词，如空泛套话"]}',
    '',
    `样文统计：共 ${samples.length} 篇，平均句长 ${stats.avgSentenceLen} 字，感叹号 ${stats.exclamations} 个，问号 ${stats.questions} 个，小标题 ${stats.subtitleCount} 个；高频词：${stats.topBigrams.map(([w, n]) => `${w}(${n})`).join('、') || '无'}`,
    '',
    '样文摘录：',
    excerpts,
  ].join('\n');
}

/** 解析 LLM 画像 JSON（容忍 ```json 围栏）；格式不符抛 LlmFormatError。 */
function parseProfileJson(raw) {
  let s = String(raw == null ? '' : raw).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  let data;
  try {
    data = JSON.parse(s);
  } catch (e) {
    throw new LlmFormatError(`文风画像输出不是有效 JSON：${String(raw).slice(0, 120)}…`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LlmFormatError('文风画像输出应为 JSON 对象');
  }
  return data;
}

/**
 * 一键分析 → 画像 JSON（normalizeProfile 形状）。
 * 本地统计始终计算；定性字段由 LLM 生成（mockKind='style'）；禁用词 = 默认清单 ∪ LLM 增补。
 */
async function analyzeStyle(cfg, samples, { deps = {}, now } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw inputError('没有样文：先在「设置 → 内容与文风 → 文章样本库」导入至少 1 篇样文');
  }
  const statsList = samples.map((s) => computeSampleStats(s.text));
  const stats = mergeStats(statsList);
  const prompt = buildAnalysisPrompt(samples, stats);
  const { raw, model } = await callLlmMessages(cfg, [{ role: 'user', content: prompt }], { ...deps, mockKind: 'style' });
  const parsed = parseProfileJson(raw);
  const extra = Array.isArray(parsed.bannedWordsExtra) ? parsed.bannedWordsExtra : [];
  const profile = normalizeProfile({
    name: '我的文风画像',
    updatedAt: isoNow(now),
    qualitative: parsed,
    bannedWords: [...DEFAULT_BANNED_WORDS, ...extra],
    topBigrams: stats.topBigrams,
    stats,
    sampleCount: samples.length,
  });
  return { profile, raw, model };
}

/* ----------------------------- few-shot 与注入 ----------------------------- */

/** 主题词分词：拉丁词（≥2 字符）+ CJK 二元组。 */
function topicTerms(topic) {
  const t = String(topic || '');
  const terms = new Set();
  for (const w of t.match(/[a-z0-9]+/gi) || []) if (w.length >= 2) terms.add(w.toLowerCase());
  for (const seg of t.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) terms.add(seg.slice(i, i + 2));
  }
  return terms;
}

/**
 * few-shot 范文挑选（PRD v2 §4.3：自动挑选 2~3 篇最相关样文）。
 * 打分 = 与主题重叠的独立主题词数；同分按字数多者优先，再按入库顺序。
 * topic 为空或全部 0 分 → 按入库顺序取前 count 篇。最多返回 count（默认 3）。
 */
function pickFewShots(samples, topic, { count = 3 } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const n = Math.max(1, Math.min(count, samples.length));
  const terms = topicTerms(topic);
  const scored = samples.map((s, i) => {
    let score = 0;
    if (terms.size) {
      for (const term of terms) if (s.text.includes(term)) score += 1;
    }
    return { sample: s, score, index: i };
  });
  if (!terms.size || scored.every((x) => x.score === 0)) {
    return scored.slice(0, n).map((x) => x.sample);
  }
  return scored
    .sort((a, b) => b.score - a.score || b.sample.words - a.sample.words || a.index - b.index)
    .slice(0, n)
    .map((x) => x.sample);
}

/**
 * 生成时注入块（PRD v2 §4.3）：文风画像 + 范文 few-shot + 负面清单硬约束。
 * 无画像时禁用词段回退默认清单（硬约束不随画像缺失而消失）；至少返回禁用词段。
 */
function buildStyleInjection(profile, fewShots, { maxFewShotChars = DEFAULT_FEWSHOT_CHARS } = {}) {
  const parts = [];
  const p = profile && typeof profile === 'object' ? profile : null;
  if (p) {
    const q = p.qualitative || EMPTY_QUALITATIVE;
    const lines = [];
    const label = {
      opening: '开头习惯', closing: '结尾习惯', sentenceRhythm: '句长节奏',
      petPhrases: '口头禅', subtitleStyle: '小标题风格', punctuationEmoji: '标点与表情',
    };
    for (const k of QUALITATIVE_KEYS) if (q[k]) lines.push(`- ${label[k]}：${q[k]}`);
    if (Array.isArray(p.topBigrams) && p.topBigrams.length) {
      lines.push(`- 高频词：${p.topBigrams.map(([w, n]) => `${w}(${n})`).join('、')}`);
    }
    if (lines.length) parts.push(`【文风画像】\n${lines.join('\n')}`);
  }
  const shots = (Array.isArray(fewShots) ? fewShots : []).filter((s) => s && s.text);
  if (shots.length) {
    const body = shots
      .map((s, i) => {
        const chars = Array.from(s.text);
        const excerpt = chars.slice(0, maxFewShotChars).join('') + (chars.length > maxFewShotChars ? '…' : '');
        return `${i + 1}.《${s.name || '样文'}》：${excerpt}`;
      })
      .join('\n');
    parts.push(`【范文参考】（学习其节奏、用词与结构习惯；禁止照搬句子）\n${body}`);
  }
  // 空数组也要回退默认清单：空画像（未配置）不应把 AI 味硬约束整体压掉
  const banned = p && Array.isArray(p.bannedWords) && p.bannedWords.length ? p.bannedWords : DEFAULT_BANNED_WORDS;
  if (banned.length) {
    parts.push(`【AI 味禁用词（硬约束，正文中一律不得出现）】${banned.join('、')}`);
  }
  return parts.join('\n\n');
}

/** 二次改写辅助：扫描草稿中的禁用词 → [{word, count}]（按次数降序，仅含命中项）。 */
function scanBannedWords(text, bannedWords = DEFAULT_BANNED_WORDS) {
  const s = String(text || '');
  const out = [];
  for (const word of bannedWords) {
    const w = String(word || '').trim();
    if (!w) continue;
    const count = s.split(w).length - 1;
    if (count > 0) out.push({ word: w, count });
  }
  return out.sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));
}

/**
 * 从配置直接构造文风注入块（PRD v2 §4.3）——所有创作模式（含 v1 仓库自动管线）共用：
 * 画像启用时 = 画像 + few-shot 范文 + 禁用词硬约束；未启用/无画像 → ''。
 */
function styleInjectionFor(cfg, dataDir, topicText) {
  try {
    const profile = loadProfile(cfg);
    if (!profile || !cfg || !cfg.style || cfg.style.enabled === false) return '';
    let fewShots = [];
    try {
      fewShots = pickFewShots(loadSamples(dataDir), topicText, { count: 3 });
    } catch (e) {
      fewShots = []; // 样文读取失败不阻断成文，仅丢失范文参考
    }
    return buildStyleInjection(profile, fewShots);
  } catch (e) {
    return ''; // 文风模块异常不阻断主流程
  }
}

module.exports = {
  DEFAULT_BANNED_WORDS,
  MAX_SAMPLE_BYTES,
  DEFAULT_FEWSHOT_CHARS,
  parseSample,
  computeSampleStats,
  mergeStats,
  addSample,
  removeSample,
  sampleDir,
  saveSample,
  loadSamples,
  deleteSample,
  readSampleFile,
  scanSampleFolder,
  normalizeProfile,
  loadProfile,
  buildAnalysisPrompt,
  parseProfileJson,
  analyzeStyle,
  topicTerms,
  pickFewShots,
  buildStyleInjection,
  styleInjectionFor,
  scanBannedWords,
};
