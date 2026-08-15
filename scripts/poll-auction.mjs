import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const API_BASE = 'https://api.mskr.nexon.com/v1';
const ITEM_API_BASE = `${API_BASE}/market/web/items`;
const SEARCH_URL = `${ITEM_API_BASE}/searches/tool-tip`;

const CONDITIONS_PATH = new URL('../auction-conditions.json', import.meta.url);
const RESULTS_PATH = new URL('../auction-results.json', import.meta.url);
const MAX_RESULTS = 300;
const MAX_SEEN_PER_CONDITION = 300;

const NEXON_COOKIE = process.env.NEXON_COOKIE;
if (!NEXON_COOKIE) {
  console.error('NEXON_COOKIE 환경변수가 없습니다.');
  process.exit(1);
}

const DEVICE_ID = process.env.NEXON_DEVICE_ID || randomBytes(16).toString('hex');

function headers(hasBody = false) {
  const h = {
    accept: 'application/json, text/plain, */*',
    cookie: NEXON_COOKIE,
    'x-platform': 'PC_WEB',
    'x-device-id': DEVICE_ID,
    'x-client-version': '1.0.1',
  };
  if (hasBody) h['content-type'] = 'application/json';
  return h;
}

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: headers(body != null),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

const WORLD_NAMES = {
  0: '스카니아', 1: '베라', 3: '루나', 4: '제니스', 5: '크로아', 10: '유니온', 16: '엘리시움',
  29: '이노시스', 43: '레드', 44: '오로라', 45: '에오스', 46: '헬리오스', 48: '챌린저스2',
  49: '챌린저스', 50: '아케인', 51: '노바', 52: '챌린저스3', 54: '챌린저스4',
};
const KNOWN_WORLD_IDS = Object.keys(WORLD_NAMES).map(Number);

async function discoverIdentity() {
  let accRes = await api(`${API_BASE}/accounts`);
  if (!accRes.ok && accRes.status === 401) {
    await api(`${API_BASE}/auth/web-token/session`, 'POST');
    accRes = await api(`${API_BASE}/accounts`);
  }
  if (!accRes.ok) throw new Error(`계정 조회 실패 (HTTP ${accRes.status})`);

  const accounts = accRes.data?.accounts ?? [];
  if (!accounts.length) throw new Error('이 넥슨 계정에 메이플 계정이 없습니다.');

  for (const acc of accounts) {
    for (const worldId of KNOWN_WORLD_IDS) {
      const reply = await api(`${API_BASE}/accounts/${acc.accountId}/gameWorlds/${worldId}/characters`);
      if (!reply.ok) continue;
      const chars = reply.data?.characters ?? [];
      if (chars.length) {
        return { worldId, accountId: acc.accountId, characterId: chars[0].characterId };
      }
    }
  }
  throw new Error('메이플 캐릭터를 찾지 못했습니다.');
}

function buildCreateBody(condition, id) {
  const filters = { exactMatch: false };
  if (condition.keyword) filters.keyword = condition.keyword;
  if (condition.category) filters.itemCategory = { itemDetailCategory: condition.category };
  if (condition.priceMin != null || condition.priceMax != null) {
    filters.price = {};
    if (condition.priceMin != null) filters.price.min = String(condition.priceMin);
    if (condition.priceMax != null) filters.price.max = String(condition.priceMax);
  }
  return {
    worldId: id.worldId,
    accountId: id.accountId,
    characterId: id.characterId,
    page: 1,
    limit: 10,
    sortType: 'PRICE_PER_ITEM_ASC',
    saveRecentKeyword: false,
    filters,
  };
}

function parseTradeSn(itemId) {
  const i = String(itemId).lastIndexOf(':');
  return i < 0 ? String(itemId) : String(itemId).slice(0, i);
}

async function fetchItems(entry, id) {
  if (entry.searchKey) {
    const qs = new URLSearchParams({
      page: '1', limit: '20', sortType: 'PRICE_PER_ITEM_ASC',
      accountId: String(id.accountId), characterId: String(id.characterId),
    });
    const reply = await api(`${ITEM_API_BASE}/searches/${encodeURIComponent(entry.searchKey)}/tool-tip?${qs}`);
    if (reply.ok) return { items: reply.data?.items ?? [], searchKey: entry.searchKey, mode: 'GET(재사용)' };
  }
  const body = buildCreateBody(entry.condition, id);
  const created = await api(SEARCH_URL, 'POST', body);
  if (!created.ok) throw new Error(`검색 생성 실패 (HTTP ${created.status}): ${JSON.stringify(created.data)}`);
  return { items: created.data?.items ?? [], searchKey: created.data?.searchKey ?? null, mode: 'POST(신규)' };
}

async function main() {
  const conditions = readJson(CONDITIONS_PATH, []);
  const results = readJson(RESULTS_PATH, []);

  if (!conditions.length) {
    console.log('등록된 감시 조건이 없습니다. 종료.');
    return;
  }

  const id = await discoverIdentity();
  console.log(`신원 확인 완료: worldId=${id.worldId} accountId=${id.accountId} characterId=${id.characterId}`);

  let newResultCount = 0;
  for (const entry of conditions) {
    entry.seenTradeSns ??= [];
    try {
      const { items, searchKey, mode } = await fetchItems(entry, id);
      entry.searchKey = searchKey;

      const seen = new Set(entry.seenTradeSns);
      const priceMax = entry.condition?.priceMax;
      const newMatches = items.filter((item) => {
        const price = Number(item.pricePerItem);
        const tradeSn = parseTradeSn(item._id);
        if (seen.has(tradeSn)) return false;
        if (priceMax != null && Number.isFinite(price) && price > priceMax) return false;
        return true;
      });

      for (const item of newMatches) {
        const tradeSn = parseTradeSn(item._id);
        seen.add(tradeSn);
        results.push({
          id: `${entry.id}:${tradeSn}`,
          conditionId: entry.id,
          machineId: entry.machineId,
          itemName: item.itemName,
          price: Number(item.pricePerItem),
          tradeSn,
          endDate: item.endDate,
          foundAt: new Date().toISOString(),
        });
        newResultCount++;
      }
      for (const item of items) seen.add(parseTradeSn(item._id));
      entry.seenTradeSns = Array.from(seen).slice(-MAX_SEEN_PER_CONDITION);

      console.log(`[${entry.id}] ${mode} · 조회 ${items.length}건 · 신규 매칭 ${newMatches.length}건`);
    } catch (err) {
      console.error(`[${entry.id}] 실패: ${err.message}`);
    }
  }

  results.sort((a, b) => a.foundAt.localeCompare(b.foundAt));
  const trimmedResults = results.slice(-MAX_RESULTS);

  writeJson(CONDITIONS_PATH, conditions);
  writeJson(RESULTS_PATH, trimmedResults);

  const dl = await api(`${API_BASE}/market/web/daily-limit`);
  if (dl.ok) console.log(`남은 검색 생성 횟수: ${dl.data?.search?.remaining}/${dl.data?.search?.limit}`);

  console.log(`완료. 신규 매칭 총 ${newResultCount}건.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
