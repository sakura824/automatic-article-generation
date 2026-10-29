'use strict';
/**
 * radar-auto.js —— 选题雷达「全自动」策略（v2.4）。
 *
 * 定时任务在 radar 模式下：按聚合配置搜索全网 → 得到已分级排序的热点清单 →
 * 用这里的纯函数挑出可以直接成文的选题（跳过需人工确认的敏感话题）→ 成文 → 上传草稿箱。
 *
 * 全部是纯函数，不读文件、不发网络，便于单测锁死语义。
 */

const { isSensitiveTopic } = require('./aggregate');

/** 自动选用的条数上限（与成文入口「勾选 1~3 条」的约束保持一致）。 */
const MAX_AUTO_PICK = 3;

/**
 * 从配置里取出自动选题策略。
 * 缺省值：选 1 条、跳过敏感话题（与 config.defaultConfig 一致）。
 */
function autoOptionsOf(cfg) {
  const a = (cfg && cfg.aggregate) || {};
  const raw = a.autoPickCount;
  const n = Number.isInteger(raw) ? raw : 1;
  const out = {
    pickCount: Math.min(MAX_AUTO_PICK, Math.max(1, n)),
    skipSensitive: a.autoSkipSensitive !== false,
  };
  // 敏感话题关键词：仅在用户配置了列表时透出（isSensitiveTopic 缺省回退默认预设）
  if (Array.isArray(a.sensitiveKeywords) && a.sensitiveKeywords.length) out.sensitiveKeywords = a.sensitiveKeywords;
  return out;
}

/**
 * 按清单顺序（已由 rankResults 排好序）取出前 count 条可自动成文的选题。
 * skipSensitive 为真时，标题+摘要命中敏感关键词的选题被跳过并记入 skipped，
 * 不会占用 count 名额——保证「每天一篇」不会被敏感话题白白浪费。
 *
 * @returns {{picked: object[], skipped: {id: string|null, title: string, reason: string}[]}}
 */
function pickTopTopics(topics, { count = 1, skipSensitive = true, keywords } = {}) {
  const list = Array.isArray(topics) ? topics : [];
  const want = Math.min(MAX_AUTO_PICK, Math.max(1, Number.isInteger(count) ? count : 1));
  const picked = [];
  const skipped = [];
  for (const t of list) {
    if (picked.length >= want) break;
    if (!t || typeof t !== 'object') continue;
    const text = `${t.title || ''} ${t.summary || ''}`.trim();
    // isSensitiveTopic 返回命中的关键词数组（空数组表示不敏感）；keywords 来自 aggregate.sensitiveKeywords
    const hits = skipSensitive ? isSensitiveTopic(text, keywords) : [];
    if (hits.length > 0) {
      skipped.push({
        id: t.id || null,
        title: String(t.title || ''),
        reason: `命中敏感话题「${hits.join('、')}」，全自动模式跳过，需要人工确认`,
      });
      continue;
    }
    picked.push(t);
  }
  return { picked, skipped };
}

/** 供日志/通知用的选题描述：「《标题A》（L1 人民日报）」这种一句话。 */
function describePick(topic) {
  if (!topic) return '';
  const tier = topic.tier || topic.sourceTier || '';
  const source = topic.source || topic.account || '';
  const tail = [tier, source].filter(Boolean).join(' · ');
  return `《${topic.title || '未命名选题'}》${tail ? `（${tail}）` : ''}`;
}

module.exports = { MAX_AUTO_PICK, autoOptionsOf, pickTopTopics, describePick };
