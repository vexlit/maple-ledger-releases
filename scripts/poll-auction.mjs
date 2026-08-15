import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const API_BASE = 'https://api.mskr.nexon.com/v1';
const ITEM_API_BASE = `${API_BASE}/market/web/items`;
const SEARCH_URL = `${ITEM_API_BASE}/searches/tool-tip`;

const CONDITIONS_PATH = new URL('../auction-conditions.json', import.meta.url);
const RESULTS_PATH = new URL('../auction-results.json', import.meta.url);
const STATUS_PATH = new URL('../auction-poll-status.json', import.meta.url);
const MAX_RESULTS = 300;
const MAX_SEEN_PER_CONDITION = 300;

const ALERT_URL = 'https://maple-ledger-inquiry.maple-ledger-inquiry.workers.dev/internal/alert';
const ALERT_SECRET = process.env.ALERT_SECRET;

const NEXON_COOKIE = process.env.NEXON_COOKIE;
if (!NEXON_COOKIE) {
  console.error('NEXON_COOKIE 환경변수가 없습니다.');
  process.exit(1);
}

const DEVICE_ID = process.env.NEXON_DEVICE_ID || randomBytes(16).toString('hex');

async function sendAlert(message, { cookieButton = false } = {}) {
  if (!ALERT_SECRET) return;
  try {
    await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alert-secret': ALERT_SECRET },
      body: JSON.stringify({ message, cookieButton }),
    });
  } catch (err) {
    console.error(`알림 전송 실패: ${err.message}`);
  }
}

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

function sumRows(rows) {
  const out = {};
  for (const r of rows) out[r.option] = (out[r.option] ?? 0) + r.minValue;
  return out;
}

function eachRows(rows) {
  return rows.map((r) => ({ [r.option]: r.minValue }));
}

function buildCreateBody(p, id) {
  const filters = { exactMatch: p.exactMatch ?? false };
  if (p.keyword) filters.keyword = p.keyword;

  if (p.category || p.jobClass) {
    const cat = {};
    if (p.category) cat.itemDetailCategory = p.category;
    if (p.jobClass) cat.itemJobCategory = p.jobClass;
    filters.itemCategory = cat;
  }

  if (p.priceMin != null || p.priceMax != null) {
    const price = {};
    if (p.priceMin != null) price.min = String(p.priceMin);
    if (p.priceMax != null) price.max = String(p.priceMax);
    filters.price = price;
  }

  if (p.levelMin != null || p.levelMax != null || p.gender != null || p.royalSpecialType != null || p.petGrade != null) {
    const basic = {};
    if (p.levelMin != null) basic.levelMin = p.levelMin;
    if (p.levelMax != null) basic.levelMax = p.levelMax;
    if (p.gender != null) basic.gender = p.gender;
    if (p.royalSpecialType != null) basic.royalSpecialType = p.royalSpecialType;
    if (p.petGrade != null) basic.petGrade = p.petGrade;
    filters.basicOption = basic;
  }

  const enh = {};
  if (p.starforceMin != null) enh.starforceMin = p.starforceMin;
  if (p.starforceMax != null) enh.starforceMax = p.starforceMax;
  if (p.potentialGrade != null) enh.potentialGrade = p.potentialGrade;
  if (p.additionalPotentialGrade != null) enh.additionalPotentialGrade = p.additionalPotentialGrade;
  if (p.potentialOptions?.length) {
    if (p.potentialSum ?? true) enh.potentialOptionSum = sumRows(p.potentialOptions);
    else enh.potentialOptions = eachRows(p.potentialOptions);
  }
  if (p.additionalPotentialOptions?.length) {
    if (p.additionalPotentialSum ?? true) enh.additionalPotentialOptionSum = sumRows(p.additionalPotentialOptions);
    else enh.additionalPotentialOptions = eachRows(p.additionalPotentialOptions);
  }
  for (const r of p.extraOptions ?? []) enh[r.option] = r.minValue;
  for (const r of p.scrollOptions ?? []) enh[r.option] = r.minValue;
  if (p.remainUpgradeCountMin != null) enh.remainUpgradeCountMin = p.remainUpgradeCountMin;
  if (p.remainUpgradeCountMax != null) enh.remainUpgradeCountMax = p.remainUpgradeCountMax;
  if (Object.keys(enh).length) filters.enhancementOption = enh;

  const etc = {};
  if (p.seedRingLevelMin != null) etc.seedRingLevelMin = p.seedRingLevelMin;
  if (p.seedRingLevelMax != null) etc.seedRingLevelMax = p.seedRingLevelMax;
  if (p.cuttableCountMin != null) etc.cuttableCountMin = p.cuttableCountMin;
  if (p.cuttableCountMax != null) etc.cuttableCountMax = p.cuttableCountMax;
  if (p.uncuttable) etc.uncuttable = true;
  if (p.isBindedWhenEquipped) etc.isBindedWhenEquipped = true;
  if (p.isExOptExtractable) etc.isExOptExtractable = true;
  if (p.isPotentialExtractable) etc.isPotentialExtractable = true;
  if (Object.keys(etc).length) filters.etcOption = etc;

  if (p.cashOptions?.length) filters.cashOption = sumRows(p.cashOptions);

  if (p.myWorldOnly) filters.myWorldOnly = true;

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
      page: '1', limit: '50', sortType: 'PRICE_PER_ITEM_ASC',
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

  const status = readJson(STATUS_PATH, { authFailing: false });

  let id;
  try {
    id = await discoverIdentity();
  } catch (err) {
    if (!status.authFailing) {
      await sendAlert(
        `옥션 알림 폴링이 인증 실패로 멈췄어요.\n아래 "쿠키 갱신하기" 버튼을 눌러 새 쿠키 값을 입력해주세요.\n${err.message}`,
        { cookieButton: true }
      );
      writeJson(STATUS_PATH, { authFailing: true });
    }
    throw err;
  }

  if (status.authFailing) {
    await sendAlert('✅ 옥션 알림 폴링 인증이 복구됐어요.');
    writeJson(STATUS_PATH, { authFailing: false });
  }

  console.log(`신원 확인 완료: worldId=${id.worldId} accountId=${id.accountId} characterId=${id.characterId}`);

  let newResultCount = 0;
  // 조건별로 이번 폴링에서 실제로 확인된 tradeSn 집합. 폴링에 성공한 조건만
  // 기록해서, 실패한 조건의 기존 매물을 "팔렸다"고 오판해 지우지 않게 한다.
  const currentByCondition = new Map();
  for (const entry of conditions) {
    entry.seenTradeSns ??= [];
    try {
      const { items, searchKey, mode } = await fetchItems(entry, id);
      entry.searchKey = searchKey;
      currentByCondition.set(entry.id, new Set(items.map((item) => parseTradeSn(item._id))));

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
          // 상세보기 모달용 원본 데이터. 넥슨 검색 응답의 tool-tip이 이미
          // 잠재능력/스탯/강화정보를 다 담고 있어서 그대로 저장한다.
          icon: item.itemIcon?.fallBackUrl ?? null,
          toolTip: item.toolTip ?? null,
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

  // 이번 폴링에서 확인한 조건인데 더 이상 목록에 없는 매물은 판매완료/만료로
  // 보고 결과에서 제거한다. 폴링 자체가 실패한 조건은 건드리지 않는다.
  const liveResults = results.filter((r) => {
    const current = currentByCondition.get(r.conditionId);
    if (!current) return true;
    if (current.has(r.tradeSn)) return true;
    return false;
  });
  const removedCount = results.length - liveResults.length;
  if (removedCount > 0) console.log(`판매완료/만료로 제거된 매물: ${removedCount}건`);

  liveResults.sort((a, b) => a.foundAt.localeCompare(b.foundAt));
  const trimmedResults = liveResults.slice(-MAX_RESULTS);

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
