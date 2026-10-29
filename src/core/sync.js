'use strict';
/**
 * sync.js —— 历史状态与公众号实况的同步判定（纯函数，可单测）。
 *
 * 本地「已上传 · 待发表」只是上传那一刻的快照：用户之后可能在公众号里
 * 发表了（草稿仍留在草稿箱）、或直接删了草稿。本模块用两个权威清单判定真实状态：
 * - drafts：draft/batchget 返回的草稿箱现状（mediaId 集合）
 * - publishedTitles：freepublish 接口返回的已发表文章标题集合
 *
 * 判定规则（只针对带 draftMediaId 且尚未定稿的条目）：
 * - 草稿箱里还在        → uploaded（待发表，不变）
 * - 草稿箱没了 + 标题命中已发表列表 → published（已发表）
 * - 草稿箱没了 + 未发表  → removed（已删除 · 未使用）
 * 不带 draftMediaId 的条目（generated/failed/skipped）与已定稿状态不重复判定。
 */

const FINAL_STATUSES = ['published', 'removed', 'replaced'];

/** 标题归一：去首尾空白、压缩连续空白，避免两端的不可见差异导致匹配失败。 */
function normalizeTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Array} history  state.history 条目（{id?, date, title, status, draftMediaId?}）
 * @param {{drafts: Array<{mediaId,title}>, publishedTitles: Array<{title}>}} remote
 * @returns {{updates: Array<{key: string, status: string, title: string}>, counts: {published: number, removed: number, unchanged: number}}}
 */
function computeStatusSync(history, remote) {
  const list = Array.isArray(history) ? history : [];
  const draftMap = new Map((remote && Array.isArray(remote.drafts) ? remote.drafts : [])
    .map((d) => [d.mediaId, normalizeTitle(d.title)]));
  const publishedSet = new Set((remote && Array.isArray(remote.publishedTitles) ? remote.publishedTitles : [])
    .map((p) => normalizeTitle(p && p.title)).filter(Boolean));

  const updates = [];
  let published = 0;
  let removed = 0;
  let unchanged = 0;

  for (const r of list) {
    if (!r || !r.draftMediaId) continue;
    if (FINAL_STATUSES.includes(r.status)) continue;
    const key = r.id || r.date;
    if (draftMap.has(r.draftMediaId)) {
      unchanged += 1;
      continue;
    }
    // 草稿箱里已经没有这条草稿：发表过 → published；没发表过 → removed
    const isPublished = publishedSet.has(normalizeTitle(r.title));
    const status = isPublished ? 'published' : 'removed';
    updates.push({ key, status, title: String(r.title || '') });
    if (isPublished) published += 1;
    else removed += 1;
  }
  return { updates, counts: { published, removed, unchanged } };
}

module.exports = { computeStatusSync, normalizeTitle, FINAL_STATUSES };
