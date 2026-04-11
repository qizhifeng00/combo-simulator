#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const {
  createOcgcoreWrapper,
  DirScriptReader,
  SqljsCardReader,
  _OcgcoreConstants,
} = require('koishipro-core.js');

const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const koishiEntry = appRequire.resolve('koishipro-core.js');
const koishiRequire = createRequire(koishiEntry);

function requirePreferApp(moduleName) {
  try {
    return appRequire(moduleName);
  } catch {
    return koishiRequire(moduleName);
  }
}

function requireOptional(moduleName) {
  try {
    return requirePreferApp(moduleName);
  } catch {
    return null;
  }
}

const initSqlJsModule = requirePreferApp('sql.js');
const ygopro = requirePreferApp('ygopro-msg-encode');
const ygoproCdb = requireOptional('ygopro-cdb-encode');
const ygoproYrp = requireOptional('ygopro-yrp-encode');

const initSqlJs =
  typeof initSqlJsModule === 'function' ? initSqlJsModule : initSqlJsModule.default;

const {
  OcgcoreScriptConstants: SCRIPT,
  OcgcoreCommonConstants: COMMON,
} = _OcgcoreConstants;

const {
  LOCATION_DECK,
  LOCATION_EXTRA,
  LOCATION_HAND,
  LOCATION_MZONE,
  LOCATION_SZONE,
  LOCATION_GRAVE,
  LOCATION_REMOVED,
  LOCATION_FZONE,
  POS_FACEDOWN_DEFENSE,
} = SCRIPT;

const QUERY_FLAG_SNAPSHOT =
  COMMON.QUERY_CODE |
  COMMON.QUERY_TYPE |
  COMMON.QUERY_ATTACK |
  COMMON.QUERY_DEFENSE |
  COMMON.QUERY_POSITION;

const IDLE_CMD = {
  SUMMON: 0,
  SPSUMMON: 1,
  REPOS: 2,
  MSET: 3,
  SSET: 4,
  ACTIVATE: 5,
  TO_BP: 6,
  TO_EP: 7,
  SHUFFLE: 8,
};

const BATTLE_CMD = {
  ACTIVATE: 0,
  ATTACK: 1,
  TO_M2: 2,
  TO_EP: 3,
};

const DEFAULT_OPTIONS = {
  drawCount: 1,
  maxDepth: 200,
  maxNodes: 100000,
  maxBeamWidth: 20,
  maxActionsPerNode: 12,
  maxProcessPerStep: 2000,
  snapshotPoolSize: 512,
  seed:  2014839433,
  topK: 20,
};

const DEFAULT_LIB_DIR = path.join(process.cwd(), 'lib');
const DEFAULT_LOCAL_FILES = {
  deck: path.join(DEFAULT_LIB_DIR, 'slm.ydk'),
  cards: path.join(DEFAULT_LIB_DIR, 'cards.cdb'),
  scripts: path.join(DEFAULT_LIB_DIR, 'ygopro-scripts'),
};

function printHelp() {
  console.log(`
Combo 推演器（koishipro-core.js）

用法:
  node scripts/combo-simulator.cjs [选项]

默认会优先调用本地目录:
  卡组:   ${DEFAULT_LOCAL_FILES.deck}
  卡池:   ${DEFAULT_LOCAL_FILES.cards}
  脚本:   ${DEFAULT_LOCAL_FILES.scripts}

可选参数:
  --deck              主玩家 .ydk（默认 lib/slm.ydk）
  --cards             cards.cdb 路径（默认 lib/cards.cdb）
  --scripts           脚本资源路径（默认 lib/ygopro-scripts）
  --resource-dir      资源根目录（会推导 slm.ydk/cards.cdb/ygopro-scripts）
  --opponent-deck     对手 .ydk（默认与 --deck 相同）
  --seed              随机种子（默认 ${DEFAULT_OPTIONS.seed}）
  --draw-count        起手张数（默认 ${DEFAULT_OPTIONS.drawCount}）
  --opening-cards     固定我方起手卡ID，逗号分隔（需与 --draw-count 数量一致）
  --opponent-opening-cards
                      固定对方起手卡ID，逗号分隔（需与 --draw-count 数量一致）
  --max-depth         搜索最大深度（默认 ${DEFAULT_OPTIONS.maxDepth}）
  --max-nodes         随机搜索节点预算（默认 ${DEFAULT_OPTIONS.maxNodes}）
  --beam-width        Beam 束宽（默认 ${DEFAULT_OPTIONS.maxBeamWidth}）
  --max-actions       每节点最多扩展动作数（默认 ${DEFAULT_OPTIONS.maxActionsPerNode}）
  --snapshot-pool     状态快照池大小（默认 ${DEFAULT_OPTIONS.snapshotPoolSize}）
  --top               输出步数最多的前 N 条路径（默认 ${DEFAULT_OPTIONS.topK}）
  --expand-script-keywords
                      保留 reposition/set 的脚本关键词，多个关键词用逗号分隔
  --export-yrp        导出 top 路径为 .yrp（可选值: 输出目录或文件）
  --yrp-version       replay 格式版本: 1 或 2（默认 1）
  --verbose           打印调试信息
  --help              显示帮助
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toUInt32(input, fallback = DEFAULT_OPTIONS.seed) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback >>> 0;
  return n >>> 0;
}

function toInt(input, fallback) {
  const n = Number(input);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

function parseKeywordList(input) {
  if (!input) return [];
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCodeList(input, optionName = 'codes') {
  if (!input) return [];
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${optionName} 包含无效卡片ID: ${token}`);
      }
      return n >>> 0;
    });
}

function parseYrpVersion(input, fallback = 1) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return n === 2 ? 2 : 1;
}

function cloneHistoryState(state) {
  if (!state || !Array.isArray(state.history)) return { history: [] };
  const out = {
    history: state.history.map((item) => ({ ...item })),
  };
  if (typeof state.snapshotBase64 === 'string' && state.snapshotBase64) {
    out.snapshotBase64 = state.snapshotBase64;
  }
  return out;
}

function encodedActionToReplayResponse(action) {
  if (typeof action?.intResponse === 'number') {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setInt32(0, action.intResponse | 0, true);
    return out;
  }
  if (typeof action?.responseBase64 === 'string') {
    return Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
  }
  return new Uint8Array(0);
}

function makeSeedSequence(seed, count = 8) {
  const rnd = makeXorshift32(seed ^ 0x6a09e667);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push((rnd() * 0x100000000) >>> 0);
  }
  return out;
}

function buildReplayMainDeck(openingInfo, fallbackMain) {
  const opening = openingInfo?.opening;
  const remain = openingInfo?.remain;
  if (Array.isArray(opening) && Array.isArray(remain) && opening.length > 0) {
    return [...remain, ...opening.slice().reverse()];
  }
  return [...(fallbackMain ?? [])];
}

function exportReplayYrp(params) {
  if (!ygoproYrp?.YGOProYrp || !ygoproYrp?.ReplayHeader) {
    throw new Error('未检测到 ygopro-yrp-encode，无法导出 .yrp');
  }

  const {
    seed,
    drawCount,
    playerDeck,
    opponentDeck,
    playerOpening,
    opponentOpening,
    state,
    responsesEncoded,
    outPath,
    yrpVersion = 1,
  } = params;

  const sourceResponses =
    Array.isArray(responsesEncoded) && responsesEncoded.length > 0
      ? responsesEncoded
      : (state?.history ?? []);

  const responses = sourceResponses
    .map(encodedActionToReplayResponse)
    .filter((seg) => seg.length > 0);

  const {
    YGOProYrp,
    ReplayHeader,
    REPLAY_ID_YRP1,
    REPLAY_ID_YRP2,
    REPLAY_COMPRESSED_FLAG,
  } = ygoproYrp;

  const header = new ReplayHeader();
  header.id = (yrpVersion === 2 ? REPLAY_ID_YRP2 : REPLAY_ID_YRP1) ?? 829452921;
  header.version = 4962;
  header.flag = REPLAY_COMPRESSED_FLAG ?? 1;
  header.seed = seed >>> 0;
  header.hash = ((seed >>> 0) * 2654435761) >>> 0;
  header.props = [93, 0, 0, 32, 0, 0, 0, 0];
  if (yrpVersion === 2) {
    header.seedSequence = makeSeedSequence(seed >>> 0);
    header.headerVersion = 1;
    header.value1 = 0;
    header.value2 = 0;
    header.value3 = 0;
  } else {
    header.seedSequence = [];
    header.headerVersion = 0;
    header.value1 = 0;
    header.value2 = 0;
    header.value3 = 0;
  }

  const yrp = new YGOProYrp({
    header,
    hostName: 'ComboBot',
    clientName: 'OpponentBot',
    startLp: 8000,
    startHand: drawCount,
    drawCount: 1,
    opt: 0,
    hostDeck: {
      main: buildReplayMainDeck(playerOpening, playerDeck.main),
      extra: [...(playerDeck.extra ?? [])],
      side: [...(playerDeck.side ?? [])],
    },
    clientDeck: {
      main: buildReplayMainDeck(opponentOpening, opponentDeck.main),
      extra: [...(opponentDeck.extra ?? [])],
      side: [...(opponentDeck.side ?? [])],
    },
    responses,
  });

  const bytes = yrp.toYrp();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(bytes));
  return {
    outPath,
    responseCount: responses.length,
    byteLength: bytes.length,
    yrpVersion,
  };
}

function assertFileExists(filePath, name) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${name} 不存在: ${filePath ?? '(empty)'}`);
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}

function resolveScriptDirs(inputPath) {
  const abs = path.resolve(inputPath);
  const candidates = [abs];
  if (path.basename(abs).toLowerCase() === 'script') {
    candidates.push(path.dirname(abs));
  } else {
    candidates.push(path.join(abs, 'script'));
  }
  return uniq(candidates.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()));
}

function parseYdk(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const deck = { main: [], extra: [], side: [] };
  let section = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower === '#main') {
      section = 'main';
      continue;
    }
    if (lower === '#extra') {
      section = 'extra';
      continue;
    }
    if (lower === '!side') {
      section = 'side';
      continue;
    }
    if (line.startsWith('#')) continue;
    const code = Number(line);
    if (!Number.isFinite(code)) continue;
    deck[section].push(code >>> 0);
  }
  return deck;
}

function makeXorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function simulateOpeningHand(mainDeck, drawCount, seed) {
  const deck = mainDeck.slice();
  const rnd = makeXorshift32(seed);
  shuffleInPlace(deck, rnd);
  return {
    opening: deck.slice(0, drawCount),
    remain: deck.slice(drawCount),
  };
}

function buildFixedOpening(mainDeck, openingCards, label = '固定起手') {
  const remain = mainDeck.slice();
  const opening = [];
  for (const rawCode of openingCards ?? []) {
    const code = rawCode >>> 0;
    const idx = remain.indexOf(code);
    if (idx < 0) {
      throw new Error(`${label} 不在主卡组中或数量不足: ${code}`);
    }
    opening.push(code);
    remain.splice(idx, 1);
  }
  return { opening, remain };
}

class CardTextResolver {
  constructor(sqlDb) {
    this.sqlDb = sqlDb;
    this.cache = new Map();
    this.cols = this.detectColumns();
  }

  detectColumns() {
    const result = this.sqlDb.exec('PRAGMA table_info(texts);');
    const effectCols = [];
    if (result[0]) {
      for (const row of result[0].values || []) {
        const name = String(row[1]);
        const m = /^(str|desc)(\d+)$/i.exec(name);
        if (m) effectCols.push({ key: name, idx: Number(m[2]) });
      }
    }
    effectCols.sort((a, b) => a.idx - b.idx);
    return effectCols;
  }

  getCard(code) {
    const id = code >>> 0;
    if (this.cache.has(id)) return this.cache.get(id);

    const stmt = this.sqlDb.prepare('SELECT * FROM texts WHERE id = ?');
    let row = null;
    try {
      stmt.bind([id]);
      if (stmt.step()) row = stmt.getAsObject();
    } finally {
      stmt.free();
    }

    const name = (row?.name ? String(row.name) : String(id)).trim();
    const desc = (row?.desc ? String(row.desc) : '').trim();
    const effectByIndex = {};
    const effects = [];
    if (row) {
      for (const col of this.cols) {
        const v = row[col.key];
        if (typeof v !== 'string' || !v.trim()) continue;
        const text = v.trim();
        effectByIndex[col.idx] = text;
        effects.push(text);
      }
    }

    const card = { id, name, desc, effects, effectByIndex };
    this.cache.set(id, card);
    return card;
  }

  getName(code) {
    return this.getCard(code).name;
  }

  getDescription(code) {
    return this.getCard(code).desc;
  }

  getEffectDescription(code, descId) {
    if (!descId) return '';
    const card = this.getCard(code);
    const id = Number(descId) >>> 0;
    const candidates = [];
    const lowNibble = id & 0xf;
    if (lowNibble > 0) candidates.push(lowNibble);
    const lowByte = id & 0xff;
    if (lowByte > 0) candidates.push(lowByte);
    const shifted = id >>> 4;
    if (shifted > 0 && shifted < 64) candidates.push(shifted);

    for (const idx of uniq(candidates)) {
      if (card.effectByIndex[idx]) return card.effectByIndex[idx];
    }
    if (card.effects.length === 1) return card.effects[0];
    return '';
  }
}

function trimText(text, max = 24) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

class DuelRunner {
  constructor(params) {
    this.wrapper = params.wrapper;
    this.cardText = params.cardText;
    this.seed = params.seed >>> 0;
    this.config = params.config;
    this.playerDeck = params.playerDeck;
    this.opponentDeck = params.opponentDeck;
    this.playerOpening = params.playerOpening;
    this.opponentOpening = params.opponentOpening;

    this.duel = null;
    this.currentDecision = null;
    this.actionHistory = [];
    this.replayCollector = null;
    this.statePool = new Map();
    this.statePoolOrder = [];
    this.maxStatePoolSize = Math.max(0, this.config.snapshotPoolSize ?? DEFAULT_OPTIONS.snapshotPoolSize);

    this.classes = {
      Response: ygopro.YGOProMsgResponseBase,
      Retry: ygopro.YGOProMsgRetry,
      SelectIdle: ygopro.YGOProMsgSelectIdleCmd,
      SelectBattle: ygopro.YGOProMsgSelectBattleCmd,
      SelectChain: ygopro.YGOProMsgSelectChain,
      SelectCard: ygopro.YGOProMsgSelectCard,
      SelectOption: ygopro.YGOProMsgSelectOption,
      SelectYesNo: ygopro.YGOProMsgSelectYesNo,
      SelectEffectYn: ygopro.YGOProMsgSelectEffectYn,
      SelectPlace: ygopro.YGOProMsgSelectPlace,
      SelectDisField: ygopro.YGOProMsgSelectDisField,
      SelectPosition: ygopro.YGOProMsgSelectPosition,
      SelectUnselect: ygopro.YGOProMsgSelectUnselectCard,
    };
  }

  init() {
    this.rebuildFromHistory([]);
  }

  makeHistoryKey(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    return history
      .map((item) =>
        typeof item?.intResponse === 'number'
          ? `i:${item.intResponse | 0}`
          : `b:${item?.responseBase64 ?? ''}`,
      )
      .join('|');
  }

  putStateIntoPool(key, duel, decision, history) {
    if (!duel) return;
    if (this.maxStatePoolSize <= 0) {
      try {
        duel.endDuel();
      } catch {
        // ignore
      }
      return;
    }
    const old = this.statePool.get(key);
    if (old?.duel && old.duel !== duel) {
      try {
        old.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.statePool.set(key, {
      duel,
      decision,
      history: history.map((x) => ({ ...x })),
    });
    this.statePoolOrder = this.statePoolOrder.filter((k) => k !== key);
    this.statePoolOrder.push(key);
    while (this.statePoolOrder.length > this.maxStatePoolSize) {
      const evictKey = this.statePoolOrder.shift();
      if (evictKey === undefined) break;
      const entry = this.statePool.get(evictKey);
      this.statePool.delete(evictKey);
      if (!entry?.duel) continue;
      try {
        entry.duel.endDuel();
      } catch {
        // ignore
      }
    }
  }

  takeStateFromPool(key) {
    if (!this.statePool.has(key)) return null;
    const entry = this.statePool.get(key);
    this.statePool.delete(key);
    this.statePoolOrder = this.statePoolOrder.filter((k) => k !== key);
    return entry ?? null;
  }

  collectReplayResponse(entry) {
    if (!this.replayCollector) return;
    if (typeof entry?.intResponse === 'number') {
      this.replayCollector.push({ intResponse: entry.intResponse | 0 });
      return;
    }
    if (entry?.response) {
      this.replayCollector.push({
        responseBase64: Buffer.from(entry.response).toString('base64'),
      });
    }
  }

  buildReplayResponseHistory(state) {
    const saved = this.saveState();
    const manualHistory = Array.isArray(state?.history)
      ? state.history.map((item) => ({ ...item }))
      : [];
    const replayResponses = [];

    try {
      this.replayCollector = replayResponses;
      this.restoreState({ history: [] });

      for (const encoded of manualHistory) {
        const action = this.decodeAction(encoded);
        if (typeof action.intResponse === 'number') {
          this.duel.setResponseInt(action.intResponse);
          this.collectReplayResponse({ intResponse: action.intResponse });
        } else {
          this.duel.setResponse(action.response);
          this.collectReplayResponse({ response: action.response });
        }
        this.currentDecision = this.advanceUntilDecision();
        if (this.currentDecision?.terminal) break;
      }
    } finally {
      this.replayCollector = null;
      this.restoreState(saved);
    }

    return replayResponses;
  }

  destroyDuel() {
    if (this.duel) {
      try {
        this.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.duel = null;
    for (const entry of this.statePool.values()) {
      if (!entry?.duel) continue;
      try {
        entry.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.statePool.clear();
    this.statePoolOrder = [];
  }

  loadDeck(duel, deck, opening, owner, player) {
    for (const code of opening.opening) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_HAND,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
    for (const code of opening.remain) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_DECK,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
    for (const code of deck.extra) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_EXTRA,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
  }

  createDuelInstance() {
    const duel = this.wrapper.createDuel(this.seed);
    duel.setPlayerInfo({ player: 0, lp: 8000, startHand: 0, drawCount: 1 });
    duel.setPlayerInfo({ player: 1, lp: 8000, startHand: 0, drawCount: 1 });

    for (const preload of ['./script/patches/entry.lua', './script/special.lua', './script/init.lua']) {
      try {
        duel.preloadScript(preload);
      } catch {
        // ignore
      }
    }

    this.loadDeck(duel, this.playerDeck, this.playerOpening, 0, 0);
    this.loadDeck(duel, this.opponentDeck, this.opponentOpening, 1, 1);
    duel.startDuel(0);
    return duel;
  }

  encodeAction(action) {
    if (typeof action.intResponse === 'number') {
      return { label: action.label, intResponse: action.intResponse };
    }
    return {
      label: action.label,
      responseBase64: Buffer.from(action.response).toString('base64'),
    };
  }

  decodeAction(encoded) {
    if (typeof encoded.intResponse === 'number') {
      return { label: encoded.label, intResponse: encoded.intResponse };
    }
    return {
      label: encoded.label,
      response: Uint8Array.from(Buffer.from(encoded.responseBase64, 'base64')),
    };
  }

  hasNativeSnapshotApi() {
    return (
      this.duel &&
      typeof this.duel.saveState === 'function' &&
      typeof this.duel.loadState === 'function'
    );
  }

  captureNativeSnapshotBase64() {
    if (!this.hasNativeSnapshotApi()) return '';
    try {
      const raw = this.duel.saveState();
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : Array.isArray(raw)
          ? Uint8Array.from(raw)
          : null;
      if (!bytes || bytes.length === 0) return '';
      return Buffer.from(bytes).toString('base64');
    } catch {
      return '';
    }
  }

  restoreNativeSnapshotBase64(snapshotBase64) {
    if (!snapshotBase64 || !this.hasNativeSnapshotApi()) return false;
    try {
      const bytes = Uint8Array.from(Buffer.from(snapshotBase64, 'base64'));
      if (bytes.length === 0) return false;
      this.duel.loadState(bytes);
      this.currentDecision = this.advanceUntilDecision();
      return true;
    } catch {
      return false;
    }
  }

  saveState() {
    const state = {
      history: this.actionHistory.map((item) => ({ ...item })),
    };
    const snapshotBase64 = this.captureNativeSnapshotBase64();
    if (snapshotBase64) state.snapshotBase64 = snapshotBase64;
    return state;
  }

  restoreState(state) {
    if (Array.isArray(state?.history)) {
      const history = state.history.map((item) => ({ ...item }));
      const currentKey = this.makeHistoryKey(this.actionHistory);
      const targetKey = this.makeHistoryKey(history);
      if (this.duel && currentKey === targetKey) return;
      if (this.restoreNativeSnapshotBase64(state.snapshotBase64)) {
        this.actionHistory = history;
        return;
      }
      this.rebuildFromHistory(history);
      return;
    }
    const n = Math.max(0, Math.min(this.actionHistory.length, state?.historyLength ?? 0));
    this.rebuildFromHistory(this.actionHistory.slice(0, n));
  }

  rebuildFromHistory(history) {
    const targetHistory = history.map((item) => ({ ...item }));
    const targetKey = this.makeHistoryKey(targetHistory);
    const currentKey = this.makeHistoryKey(this.actionHistory);
    if (this.duel && currentKey === targetKey) return;

    if (this.duel) {
      this.putStateIntoPool(currentKey, this.duel, this.currentDecision, this.actionHistory);
      this.duel = null;
      this.currentDecision = null;
      this.actionHistory = [];
    }

    const pooled = this.takeStateFromPool(targetKey);
    if (pooled?.duel) {
      this.duel = pooled.duel;
      this.currentDecision = pooled.decision;
      this.actionHistory = Array.isArray(pooled.history)
        ? pooled.history.map((item) => ({ ...item }))
        : [];
      return;
    }

    this.duel = this.createDuelInstance();
    this.currentDecision = this.advanceUntilDecision();
    this.actionHistory = [];

    for (const encoded of targetHistory) {
      const action = this.decodeAction(encoded);
      if (typeof action.intResponse === 'number') {
        this.duel.setResponseInt(action.intResponse);
      } else {
        this.duel.setResponse(action.response);
      }
      this.actionHistory.push(this.encodeAction(action));
      this.currentDecision = this.advanceUntilDecision();
      if (this.currentDecision.terminal) break;
    }
  }

  step(action) {
    if (typeof action.intResponse === 'number') {
      this.duel.setResponseInt(action.intResponse);
    } else {
      this.duel.setResponse(action.response);
    }
    this.actionHistory.push(this.encodeAction(action));
    this.currentDecision = this.advanceUntilDecision();
    return this.currentDecision;
  }

  autoRespond(msg) {
    const sendResponse = (resp) => {
      this.duel.setResponse(resp);
      this.collectReplayResponse({ response: resp });
      return true;
    };
    const sendInt = (value) => {
      this.duel.setResponseInt(value | 0);
      this.collectReplayResponse({ intResponse: value | 0 });
      return true;
    };

    try {
      const def = msg.defaultResponse?.();
      if (def) {
        return sendResponse(def);
      }
    } catch {
      // ignore
    }

    if (msg instanceof this.classes.SelectOption) {
      const val = msg.options?.[0] ?? 0;
      try {
        return sendResponse(msg.prepareResponse(val));
      } catch {
        // ignore
      }
      try {
        return sendResponse(msg.prepareResponse(0));
      } catch {
        // ignore
      }
    }

    try {
      return sendInt(0);
    } catch {
      return false;
    }
  }

  advanceUntilDecision() {
    let guard = 0;
    while (guard < this.config.maxProcessPerStep) {
      guard += 1;
      const res = this.duel.process();
      const messages =
        Array.isArray(res.messages) && res.messages.length > 0
          ? res.messages
          : res.message
          ? [res.message]
          : [];

      for (const msg of messages) {
        if (msg instanceof this.classes.Retry) {
          return { terminal: true, reason: 'MSG_RETRY', actions: [] };
        }
        if (msg instanceof this.classes.Response) {
          const responsePlayer = typeof msg.responsePlayer === 'function' ? msg.responsePlayer() : 0;
          if (responsePlayer !== 0) {
            if (!this.autoRespond(msg)) return { terminal: true, reason: 'AUTO_RESPONSE_FAIL', actions: [] };
            continue;
          }

          const actions = this.enumerateActions(msg);
          if (actions.length === 0) return { terminal: true, reason: 'NO_ACTION', actions: [] };
          return { terminal: false, reason: null, actions, message: msg };
        }
      }

      if (res.status === 2) return { terminal: true, reason: 'STATUS_END', actions: [] };
      if (res.raw && res.raw.length > 0 && res.raw[0] === COMMON.MSG_RETRY) {
        return { terminal: true, reason: 'MSG_RETRY_RAW', actions: [] };
      }
    }
    return { terminal: true, reason: 'PROCESS_GUARD', actions: [] };
  }

  makeAction({ label, kind, response, intResponse, text }) {
    return {
      label,
      kind,
      response,
      intResponse,
      text,
    };
  }

  enumerateActions(msg) {
    const actions = [];
    const add = (action) => {
      if (action) actions.push(action);
    };
    const cardName = (code) => this.cardText.getName(code);
    const effectText = (code, desc) =>
      `${this.cardText.getDescription(code)} ${this.cardText.getEffectDescription(code, desc)}`.trim();

    if (msg instanceof this.classes.SelectIdle) {
      for (const card of msg.summonableCards ?? []) {
        add(this.makeAction({
          label: `通常召唤[${cardName(card.code)}]`,
          kind: 'summon',
          response: msg.prepareResponse(IDLE_CMD.SUMMON, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.spSummonableCards ?? []) {
        add(this.makeAction({
          label: `特殊召唤[${cardName(card.code)}]`,
          kind: 'spsummon',
          response: msg.prepareResponse(IDLE_CMD.SPSUMMON, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.reposableCards ?? []) {
        add(this.makeAction({
          label: `改变表示[${cardName(card.code)}]`,
          kind: 'reposition',
          response: msg.prepareResponse(IDLE_CMD.REPOS, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.msetableCards ?? []) {
        add(this.makeAction({
          label: `盖放怪兽[${cardName(card.code)}]`,
          kind: 'set',
          response: msg.prepareResponse(IDLE_CMD.MSET, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.ssetableCards ?? []) {
        add(this.makeAction({
          label: `盖放魔陷[${cardName(card.code)}]`,
          kind: 'set',
          response: msg.prepareResponse(IDLE_CMD.SSET, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.activatableCards ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(card.code, card.desc), 18);
        add(this.makeAction({
          label: `发动效果[${cardName(card.code)}]${effect ? `(${effect})` : ''}`,
          kind: 'activate',
          response: msg.prepareResponse(IDLE_CMD.ACTIVATE, card),
          text: effectText(card.code, card.desc),
        }));
      }
      if (msg.canBp) {
        add(this.makeAction({ label: '进入战斗阶段', kind: 'other', response: msg.prepareResponse(IDLE_CMD.TO_BP), text: '' }));
      }
      if (msg.canEp) {
        add(this.makeAction({ label: '结束回合', kind: 'phase_end', response: msg.prepareResponse(IDLE_CMD.TO_EP), text: '' }));
      }
    } else if (msg instanceof this.classes.SelectBattle) {
      for (const card of msg.activatableCards ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(card.code, card.desc), 18);
        add(this.makeAction({
          label: `战阶发动[${cardName(card.code)}]${effect ? `(${effect})` : ''}`,
          kind: 'activate',
          response: msg.prepareResponse(BATTLE_CMD.ACTIVATE, card),
          text: effectText(card.code, card.desc),
        }));
      }
      for (const card of msg.attackableCards ?? []) {
        add(this.makeAction({
          label: `攻击[${cardName(card.code)}]`,
          kind: 'attack',
          response: msg.prepareResponse(BATTLE_CMD.ATTACK, card),
          text: '',
        }));
      }
      if (msg.canM2) {
        add(this.makeAction({ label: '进入主要阶段2', kind: 'other', response: msg.prepareResponse(BATTLE_CMD.TO_M2), text: '' }));
      }
      if (msg.canEp) {
        add(this.makeAction({ label: '战阶结束', kind: 'phase_end', response: msg.prepareResponse(BATTLE_CMD.TO_EP), text: '' }));
      }
    } else if (msg instanceof this.classes.SelectChain) {
      for (const chain of msg.chains ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(chain.code, chain.desc), 18);
        add(this.makeAction({
          label: `连锁发动[${cardName(chain.code)}]${effect ? `(${effect})` : ''}`,
          kind: 'chain',
          response: msg.prepareResponse(chain),
          text: effectText(chain.code, chain.desc),
        }));
      }
      const def = msg.defaultResponse?.();
      if (def) add(this.makeAction({ label: '不连锁', kind: 'other', response: def, text: '' }));
    } else if (msg instanceof this.classes.SelectEffectYn) {
      const text = effectText(msg.code, msg.desc);
      add(this.makeAction({ label: `发动[${cardName(msg.code)}]`, kind: 'activate', response: msg.prepareResponse(true), text }));
      add(this.makeAction({ label: `不发动[${cardName(msg.code)}]`, kind: 'other', response: msg.prepareResponse(false), text: '' }));
    } else if (msg instanceof this.classes.SelectYesNo) {
      add(this.makeAction({ label: '选择[是]', kind: 'yes', response: msg.prepareResponse(true), text: '' }));
      add(this.makeAction({ label: '选择[否]', kind: 'other', response: msg.prepareResponse(false), text: '' }));
    } else if (msg instanceof this.classes.SelectOption) {
      for (let i = 0; i < (msg.options?.length ?? 0); i += 1) {
        const optionValue = msg.options[i];
        try {
          add(this.makeAction({
            label: `选择选项#${i + 1}`,
            kind: 'option',
            response: msg.prepareResponse(optionValue),
            text: '',
          }));
        } catch {
          try {
            add(this.makeAction({
              label: `选择选项#${i + 1}`,
              kind: 'option',
              response: msg.prepareResponse(i),
              text: '',
            }));
          } catch {
            // ignore
          }
        }
      }
    } else if (msg instanceof this.classes.SelectCard) {
      const min = Math.max(1, msg.min ?? 1);
      const cards = msg.cards ?? [];
      if (min <= 1) {
        for (const c of cards.slice(0, 6)) {
          add(this.makeAction({
            label: `选择卡片[${cardName(c.code)}]`,
            kind: 'other',
            response: msg.prepareResponse([c]),
            text: this.cardText.getDescription(c.code),
          }));
        }
      } else {
        const picked = cards.slice(0, min);
        if (picked.length === min) {
          add(this.makeAction({
            label: `选择${min}张卡片`,
            kind: 'other',
            response: msg.prepareResponse(picked),
            text: picked.map((c) => this.cardText.getDescription(c.code)).join(' '),
          }));
        }
      }
    } else if (msg instanceof this.classes.SelectPlace || msg instanceof this.classes.SelectDisField) {
      const places = msg.getSelectablePlaces?.() ?? [];
      const need = Math.max(1, msg.count ?? 1);
      if (places.length >= need) {
        add(this.makeAction({
          label: '选择区域',
          kind: 'other',
          response: msg.prepareResponse(places.slice(0, need)),
          text: '',
        }));
      }
    } else if (msg instanceof this.classes.SelectPosition) {
      const POS = [1, 2, 4, 8];
      for (const p of POS) {
        if ((msg.positions & p) !== 0) {
          add(this.makeAction({ label: `选择表示形式(${p})`, kind: 'other', response: msg.prepareResponse(p), text: '' }));
        }
      }
    } else if (msg instanceof this.classes.SelectUnselect) {
      const selectable = msg.selectableCards ?? [];
      for (const c of selectable.slice(0, 6)) {
        add(this.makeAction({
          label: `选择卡片[${cardName(c.code)}]`,
          kind: 'other',
          response: msg.prepareResponse(c),
          text: this.cardText.getDescription(c.code),
        }));
      }
      // 只有在“当前可完成”且通常没有可继续选择的素材时，才优先给确认，避免无效确认循环。
      if (msg.finishable && (selectable.length === 0 || (msg.min ?? 0) === 0)) {
        try {
          add(this.makeAction({
            label: '确认选择',
            kind: selectable.length === 0 ? 'option' : 'fallback',
            response: msg.prepareResponse(null),
            text: '',
          }));
        } catch {
          // ignore
        }
      }
    } else {
      const def = msg.defaultResponse?.();
      if (def) add(this.makeAction({ label: `默认响应[${msg.constructor.name}]`, kind: 'fallback', response: def, text: '' }));
      else add(this.makeAction({ label: `整数响应0[${msg.constructor.name}]`, kind: 'fallback', intResponse: 0, text: '' }));
    }

    const scriptKeywords = this.config.expandScriptKeywords ?? [];
    const filtered = actions.filter((action) => {
      if (action.kind !== 'reposition' && action.kind !== 'set') return true;
      if (!Array.isArray(scriptKeywords) || scriptKeywords.length === 0) return false;
      const haystack = `${action.label} ${action.text ?? ''}`.toLowerCase();
      return scriptKeywords.some((kw) => haystack.includes(String(kw).toLowerCase()));
    });

    const picked = filtered.length > 0 ? filtered : actions.filter((a) => a.kind !== 'reposition' && a.kind !== 'set');
    return picked.slice(0, this.config.maxActionsPerNode);
  }

  queryCodes(player, location) {
    const out = this.duel.queryFieldCard({ player, location, queryFlag: QUERY_FLAG_SNAPSHOT });
    return (out.cards ?? []).map((c) => c.code >>> 0).filter((c) => c > 0);
  }

  captureSnapshot() {
    const info = this.duel.queryFieldInfo().field;
    const p0 = info.players?.[0];
    const p1 = info.players?.[1];
    const snapshot = {
      lp: { p0: p0?.lp ?? 0, p1: p1?.lp ?? 0 },
      p0: {
        mzone: this.queryCodes(0, LOCATION_MZONE),
        szone: this.queryCodes(0, LOCATION_SZONE | LOCATION_FZONE),
        hand: this.queryCodes(0, LOCATION_HAND),
        grave: this.queryCodes(0, LOCATION_GRAVE),
        banished: this.queryCodes(0, LOCATION_REMOVED),
      },
      p1: {
        mzone: this.queryCodes(1, LOCATION_MZONE),
        szone: this.queryCodes(1, LOCATION_SZONE | LOCATION_FZONE),
        hand: this.queryCodes(1, LOCATION_HAND),
        grave: this.queryCodes(1, LOCATION_GRAVE),
        banished: this.queryCodes(1, LOCATION_REMOVED),
      },
    };
    snapshot.cardIdList = {
      p0Field: [...snapshot.p0.mzone, ...snapshot.p0.szone],
      p0Extra: this.queryCodes(0, LOCATION_EXTRA), // 添加这一行
      p1Field: [...snapshot.p1.mzone, ...snapshot.p1.szone],
      p0Hand: [...snapshot.p0.hand],
      p0Grave: [...snapshot.p0.grave],
    };
    return snapshot;
  }

  scoreSnapshot(snapshot) {
    const ownField = snapshot.p0.mzone.length * 6 + snapshot.p0.szone.length * 3;
    const ownResource = snapshot.p0.hand.length * 2 + snapshot.p0.grave.length;
    const oppPressure = snapshot.p1.mzone.length * 4 + snapshot.p1.szone.length * 2;
    const lpDelta = (snapshot.lp.p0 - snapshot.lp.p1) / 800;
    return ownField + ownResource - oppPressure + lpDelta;
  }
}

function makeExactStateKey(state, snapshot, decision) {
  const sortCodes = (codes) =>
    [...(codes ?? [])]
      .map((x) => x >>> 0)
      .sort((a, b) => a - b)
      .join(',');

  const decisionSig = decision?.actions?.length
    ? decision.actions
        .slice(0, 12)
        .map((action) => `${action.kind}:${action.label}`)
        .join('^')
    : decision?.message?.constructor?.name ?? decision?.reason ?? 'terminal';

  return [
    snapshot?.lp?.p0 ?? 0,
    snapshot?.lp?.p1 ?? 0,
    sortCodes(snapshot?.p0?.mzone),
    sortCodes(snapshot?.p0?.szone),
    sortCodes(snapshot?.p0?.hand),
    sortCodes(snapshot?.p0?.grave),
    sortCodes(snapshot?.p0?.banished),
    sortCodes(snapshot?.p1?.mzone),
    sortCodes(snapshot?.p1?.szone),
    sortCodes(snapshot?.p1?.hand),
    sortCodes(snapshot?.p1?.grave),
    sortCodes(snapshot?.p1?.banished),
    decisionSig,
  ].join('|');
}

function rankActionForLongestPath(action) {
  const base = {
    chain: 8,
    activate: 7,
    spsummon: 6,
    summon: 5,
    option: 4,
    yes: 3,
    attack: 2,
    other: 1,
    fallback: -2,
    phase_end: -8,
  }[action?.kind] ?? 0;

  let score = base;
  if (/^不/.test(action?.label ?? '')) score -= 2;
  if ((action?.text ?? '').length > 0) score += 0.5;
  return score;
}

function sortActionsForLongestPath(actions) {
  return [...(actions ?? [])].sort(
    (a, b) =>
      rankActionForLongestPath(b) - rankActionForLongestPath(a) ||
      String(a?.label ?? '').localeCompare(String(b?.label ?? ''), 'zh-Hans-CN'),
  );
}

function searchTopLongestPathsExactSingle(runner, opts) {
  const best = {
    nodes: 0,
    terminalCount: 0,
    topPaths: [],
  };
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
  const progressEvery = Math.max(1, opts.progressEvery ?? 200);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const rootState = runner.saveState();
  const pathStateCounts = new Map();
  const chain = [];
  let lastReportedNodes = -1;

  const settleTerminal = (chain, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    const snapshot = snapshotOverride ?? runner.captureSnapshot();
    const score = runner.scoreSnapshot(snapshot);
    best.terminalCount += 1;
    best.topPaths.push({
      chain: chain.slice(),
      depth: chain.length,
      score,
      reason: reasonHint,
      snapshot,
      state: stateOverride ? cloneHistoryState(stateOverride) : null,
    });
    best.topPaths.sort((a, b) => b.depth - a.depth || b.score - a.score);
    if (best.topPaths.length > topK) best.topPaths.length = topK;
  };

  const maybeReportProgress = (currentDepth) => {
    if (!onProgress) return;
    if (best.nodes !== 0 && best.nodes % progressEvery !== 0 && best.nodes < opts.maxNodes) return;
    if (best.nodes === lastReportedNodes) return;
    lastReportedNodes = best.nodes;
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth,
      done: false,
    });
  };

  const explore = (state, depth, sameKeyStreak = 0) => {
    if (best.nodes >= opts.maxNodes) return;

    runner.restoreState(state);
    const snapshot = runner.captureSnapshot();
    const current = runner.currentDecision;
    const stateKey = makeExactStateKey(state, snapshot, current);

    if (!current || current.terminal || !current.actions?.length) {
      settleTerminal(chain, snapshot, current?.reason ?? 'NO_ACTION_OR_NULL', state);
      return;
    }
    if (depth >= opts.maxDepth) {
      settleTerminal(chain, snapshot, 'MAX_DEPTH', state);
      return;
    }

    pathStateCounts.set(stateKey, (pathStateCounts.get(stateKey) ?? 0) + 1);
    let exploredChild = false;

    const nonEndActions = current.actions.filter((a) => a.kind !== 'phase_end');
    const iterActions = sortActionsForLongestPath(
      nonEndActions.length > 0 ? nonEndActions : current.actions,
    );

    for (const action of iterActions) {
      if (best.nodes >= opts.maxNodes) break;

      runner.step(action);
      best.nodes += 1;
      chain.push(action.label);

      const childState = runner.saveState();
      const childSnapshot = runner.captureSnapshot();
      const childDecision = runner.currentDecision;
      const childDepth = depth + 1;

      if (action.kind === 'phase_end') {
        exploredChild = true;
        settleTerminal(chain, childSnapshot, 'TURN_END', childState);
        runner.restoreState(state);
        chain.pop();
        maybeReportProgress(childDepth);
        continue;
      }

      const childStateKey = makeExactStateKey(childState, childSnapshot, childDecision);
      const childSameKeyStreak = childStateKey === stateKey ? sameKeyStreak + 1 : 0;
      const childPathCount = pathStateCounts.get(childStateKey) ?? 0;
      const skipBecauseLoop =
        (childStateKey === stateKey && (action.kind === 'fallback' || action.label === '确认选择')) ||
        childSameKeyStreak > 2 ||
        childPathCount >= 3;

      if (!skipBecauseLoop) {
        exploredChild = true;
        explore(childState, childDepth, childSameKeyStreak);
      }

      runner.restoreState(state);
      chain.pop();
      maybeReportProgress(childDepth);
    }

    const nextCount = (pathStateCounts.get(stateKey) ?? 1) - 1;
    if (nextCount > 0) pathStateCounts.set(stateKey, nextCount);
    else pathStateCounts.delete(stateKey);

    if (!exploredChild) {
      settleTerminal(
        chain,
        snapshot,
        best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'ALL_CHILDREN_PRUNED',
        state,
      );
    }
  };

  runner.restoreState(rootState);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: false,
    });
  }

  explore(rootState, 0);

  runner.restoreState(rootState);
  if (best.topPaths.length === 0) {
    settleTerminal([], null, best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'NO_RESULT', rootState);
  }
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: true,
    });
  }
  return best;
}

function searchTopLongestPathsRandom(runner, opts) {
  const best = {
    nodes: 0,
    terminalCount: 0,
    topPaths: [],
  };
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
  const progressEvery = Math.max(1, opts.progressEvery ?? 200);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const rootState = runner.saveState();
  const rnd = makeXorshift32(((opts.seed ?? DEFAULT_OPTIONS.seed) ^ 0x85ebca6b) >>> 0);

  const settleTerminal = (chain, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    const snapshot = snapshotOverride ?? runner.captureSnapshot();
    const score = runner.scoreSnapshot(snapshot);
    best.terminalCount += 1;
    best.topPaths.push({
      chain: chain.slice(),
      depth: chain.length,
      score,
      reason: reasonHint,
      snapshot,
      state: stateOverride ? cloneHistoryState(stateOverride) : null,
    });
    best.topPaths.sort((a, b) => b.depth - a.depth || b.score - a.score);
    if (best.topPaths.length > topK) best.topPaths.length = topK;
  };

  runner.restoreState(rootState);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: false,
    });
  }

  while (best.nodes < opts.maxNodes) {
    runner.restoreState(rootState);

    const chain = [];
    let depth = 0;
    let reason = 'NO_ACTION_OR_NULL';

    while (depth < opts.maxDepth && best.nodes < opts.maxNodes) {
      const current = runner.currentDecision;
      if (!current || current.terminal || !current.actions?.length) {
        reason = current?.reason ?? 'NO_ACTION_OR_NULL';
        break;
      }

      const nonEndActions = current.actions.filter((a) => a.kind !== 'phase_end');
      const iterActions = nonEndActions.length > 0 ? nonEndActions : current.actions;
      if (!iterActions.length) {
        reason = 'NO_ACTION_OR_NULL';
        break;
      }

      const action = iterActions[Math.floor(rnd() * iterActions.length)];
      runner.step(action);
      chain.push(action.label);
      depth += 1;
      best.nodes += 1;

      if (action.kind === 'phase_end') {
        reason = 'TURN_END';
        break;
      }
      if (depth >= opts.maxDepth) {
        reason = 'MAX_DEPTH';
        break;
      }
      const next = runner.currentDecision;
      if (!next || next.terminal || !next.actions?.length) {
        reason = next?.reason ?? 'NO_ACTION_OR_NULL';
        break;
      }

      if (onProgress && (best.nodes % progressEvery === 0 || best.nodes >= opts.maxNodes)) {
        onProgress({
          nodes: best.nodes,
          maxNodes: opts.maxNodes,
          terminalCount: best.terminalCount,
          currentDepth: depth,
          done: false,
        });
      }
    }

    if (best.nodes >= opts.maxNodes && depth < opts.maxDepth && reason === 'NO_ACTION_OR_NULL') {
      reason = 'MAX_NODES';
    }

    settleTerminal(chain, null, reason, runner.saveState());
  }

  runner.restoreState(rootState);
  if (best.topPaths.length === 0) settleTerminal([], null, 'NO_RESULT', rootState);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: true,
    });
  }
  return best;
}

function searchTopLongestPaths(runner, opts) {
  if (opts?.exactSingleSearch) {
    return searchTopLongestPathsExactSingle(runner, opts);
  }
  return searchTopLongestPathsRandom(runner, opts);
}

async function createRuntime(cardsPath, scriptDirs) {
  if (typeof initSqlJs !== 'function') {
    throw new Error('sql.js 初始化函数不可用');
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(cardsPath));
  const cardText = new CardTextResolver(db);

  const wrapper = await createOcgcoreWrapper();
  wrapper.setScriptReader(DirScriptReader(...scriptDirs), true);
  wrapper.setCardReader(SqljsCardReader(db), true);

  return { wrapper, db, cardText };
}

function formatCards(codes, cardText) {
  return codes.map((c) => `${cardText.getName(c)}(${c})`);
}

function resolveTopReplayOutputPaths(exportYrpArg, seed, topPathsCount) {
  const count = Math.max(1, topPathsCount | 0);
  const defaultDir = path.join(process.cwd(), 'replays', `combo-seed${seed}`);
  const makeDefaultPath = (idx, depth) =>
    path.join(defaultDir, `top${idx + 1}-depth${depth}.yrp`);

  if (exportYrpArg === true) {
    return (depths) => depths.map((depth, idx) => makeDefaultPath(idx, depth));
  }

  const resolved = path.resolve(String(exportYrpArg));
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.yrp' && count === 1) {
    return () => [resolved];
  }
  if (ext === '.yrp' && count > 1) {
    const dir = path.dirname(resolved);
    const base = path.basename(resolved, '.yrp');
    return (depths) =>
      depths.map((depth, idx) => path.join(dir, `${base}-top${idx + 1}-depth${depth}.yrp`));
  }
  return (depths) =>
    depths.map((depth, idx) => path.join(resolved, `top${idx + 1}-depth${depth}.yrp`));
}

function renderProgressBar(nodes, maxNodes, currentDepth, terminalCount) {
  const total = Math.max(1, maxNodes | 0);
  const value = Math.max(0, Math.min(total, nodes | 0));
  const ratio = value / total;
  const width = 28;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const percent = `${(ratio * 100).toFixed(1)}%`;
  return `探索进度 [${bar}] ${percent} (${value}/${total}) | 深度:${Math.max(0, currentDepth | 0)} | 终局:${Math.max(0, terminalCount | 0)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const resourceDir = args['resource-dir']
    ? path.resolve(String(args['resource-dir']))
    : DEFAULT_LIB_DIR;
  const deckPath = args.deck
    ? path.resolve(String(args.deck))
    : path.join(resourceDir, 'slm.ydk');
  const opponentDeckPath = args['opponent-deck']
    ? path.resolve(String(args['opponent-deck']))
    : deckPath;
  const cardsPath = args.cards
    ? path.resolve(String(args.cards))
    : path.join(resourceDir, 'cards.cdb');
  const scriptsRoot = args.scripts
    ? path.resolve(String(args.scripts))
    : path.join(resourceDir, 'ygopro-scripts');

  assertFileExists(deckPath, 'deck');
  assertFileExists(opponentDeckPath, 'opponent deck');
  assertFileExists(cardsPath, 'cards.cdb');

  const seed = toUInt32(args.seed, DEFAULT_OPTIONS.seed);
  const drawCount = toInt(args['draw-count'], DEFAULT_OPTIONS.drawCount);
  const maxDepth = toInt(args['max-depth'], DEFAULT_OPTIONS.maxDepth);
  const maxNodes = toInt(args['max-nodes'], DEFAULT_OPTIONS.maxNodes);
  const maxBeamWidth = Math.max(1, toInt(args['beam-width'], DEFAULT_OPTIONS.maxBeamWidth));
  const maxActionsPerNode = toInt(args['max-actions'], DEFAULT_OPTIONS.maxActionsPerNode);
  const snapshotPoolSize = toInt(args['snapshot-pool'], DEFAULT_OPTIONS.snapshotPoolSize);
  const topK = Math.max(1, toInt(args.top, DEFAULT_OPTIONS.topK));
  const expandScriptKeywords = parseKeywordList(args['expand-script-keywords']);
  const openingCards = parseCodeList(args['opening-cards'], '--opening-cards');
  const opponentOpeningCards = parseCodeList(args['opponent-opening-cards'], '--opponent-opening-cards');
  const exportYrpArg = args['export-yrp'];
  const yrpVersion = parseYrpVersion(args['yrp-version'], 1);
  const verbose = !!args.verbose;

  const scriptDirs = resolveScriptDirs(scriptsRoot);
  if (scriptDirs.length === 0) {
    throw new Error(`脚本目录无效: ${scriptsRoot}`);
  }

  const playerDeck = parseYdk(deckPath);
  const opponentDeck = parseYdk(opponentDeckPath);
  if (playerDeck.main.length < drawCount || opponentDeck.main.length < drawCount) {
    throw new Error(`主卡组数量不足以抽${drawCount}张起手`);
  }
  if (openingCards.length > 0 && openingCards.length !== drawCount) {
    throw new Error(`--opening-cards 数量(${openingCards.length}) 必须等于 --draw-count(${drawCount})`);
  }
  if (opponentOpeningCards.length > 0 && opponentOpeningCards.length !== drawCount) {
    throw new Error(`--opponent-opening-cards 数量(${opponentOpeningCards.length}) 必须等于 --draw-count(${drawCount})`);
  }

  const playerOpening =
    openingCards.length > 0
      ? buildFixedOpening(playerDeck.main, openingCards, '我方固定起手')
      : simulateOpeningHand(playerDeck.main, drawCount, seed);
  const opponentOpening =
    opponentOpeningCards.length > 0
      ? buildFixedOpening(opponentDeck.main, opponentOpeningCards, '对方固定起手')
      : simulateOpeningHand(opponentDeck.main, drawCount, (seed ^ 0x9e3779b9) >>> 0);
  const exactSingleSearch = playerOpening.opening.length === 1;

  console.log(`随机种子: ${seed}`);
  console.log(`我方起手(模拟抽${drawCount}): ${playerOpening.opening.join(', ')}`);
  console.log(`对方起手(模拟抽${drawCount}): ${opponentOpening.opening.join(', ')}`);
  console.log(`搜索模式: ${exactSingleSearch ? '精确DFS(一卡起手)' : '随机搜索'}`);

  let runtime = null;
  let runner = null;
  try {
    runtime = await createRuntime(cardsPath, scriptDirs);
    runner = new DuelRunner({
      wrapper: runtime.wrapper,
      cardText: runtime.cardText,
      seed,
      config: {
        maxDepth,
        maxNodes,
        maxBeamWidth,
        maxActionsPerNode,
        maxProcessPerStep: DEFAULT_OPTIONS.maxProcessPerStep,
        snapshotPoolSize,
        expandScriptKeywords,
      },
      playerDeck,
      opponentDeck,
      playerOpening,
      opponentOpening,
    });

    runner.init();
    if (verbose) {
      console.log('初始决策消息:', runner.currentDecision?.message?.constructor?.name ?? '终局');
      console.log('起手卡名:', formatCards(playerOpening.opening, runtime.cardText).join(', '));
      const loadedPkgs = [
        ygoproCdb ? 'ygopro-cdb-encode' : null,
        ygopro ? 'ygopro-msg-encode' : null,
        ygoproYrp ? 'ygopro-yrp-encode' : null,
      ].filter(Boolean);
      console.log('已加载编码库:', loadedPkgs.join(', ') || '无');
    }

    const result = searchTopLongestPaths(runner, {
      maxDepth,
      maxNodes,
      maxBeamWidth,
      topK,
      seed,
      exactSingleSearch,
      progressEvery: Math.max(50, Math.floor(maxNodes / 200)),
      onProgress: ({ nodes, maxNodes: total, currentDepth, terminalCount, done }) => {
        const line = renderProgressBar(nodes, total, currentDepth, terminalCount);
        if (process.stdout.isTTY) {
          process.stdout.write(`\r${line}${done ? '\n' : ''}`);
        } else if (done || nodes === 0 || nodes === total) {
          console.log(line);
        }
      },
    });

    console.log(`\n===== Top ${topK} 最长路径 =====`);
    result.topPaths.forEach((item, idx) => {
      const chainText = item.chain.length > 0 ? item.chain.join(' -> ') : '[无可执行展开链]';
      console.log(`\n#${idx + 1} | 步数: ${item.depth}`);
      console.log(chainText);
      if (verbose) {
        console.log(`终止原因: ${item.reason || '未知'} | 评分: ${item.score.toFixed(2)}`);
      }
    });
    console.log(`\n搜索节点: ${result.nodes} | 终局分支: ${result.terminalCount}`);
    if (result.nodes >= maxNodes) {
      console.log('注意: 已触及 max-nodes，上面的最长路径仍可能被更深分支继续刷新。');
    }
    if (verbose && result.topPaths[0]?.snapshot?.cardIdList) {
      const cardIdList = result.topPaths[0].snapshot.cardIdList;
      const cardIdListZh = {
        我方场上: cardIdList.p0Field ?? [],
        我方额外牌组: cardIdList.p0Extra ?? [],
        对方场上: cardIdList.p1Field ?? [],
        我方手牌: cardIdList.p0Hand ?? [],
        我方墓地: cardIdList.p0Grave ?? [],
      };
      console.log('\nTop1 终场卡片ID:');
      console.log(JSON.stringify(cardIdListZh, null, 2));
    }

    if (exportYrpArg !== undefined && exportYrpArg !== false) {
      const topPaths = result.topPaths.filter((p) => p?.state?.history?.length > 0);
      if (topPaths.length === 0) {
        console.log('\n===== Replay 导出 =====');
        console.log('没有可导出的路径状态');
      } else {
        const toPathList = resolveTopReplayOutputPaths(exportYrpArg, seed, topPaths.length);
        const depths = topPaths.map((p) => p.depth);
        const outPaths = toPathList(depths);
        console.log('\n===== Replay 导出 =====');
        topPaths.forEach((pathItem, idx) => {
          const fullReplayResponses = runner.buildReplayResponseHistory(pathItem.state);
          const replayInfo = exportReplayYrp({
            seed,
            drawCount,
            playerDeck,
            opponentDeck,
            playerOpening,
            opponentOpening,
            state: pathItem.state,
            responsesEncoded: fullReplayResponses,
            outPath: outPaths[idx],
            yrpVersion,
          });
          console.log(
            `Top${idx + 1}: ${replayInfo.outPath} | YRP${replayInfo.yrpVersion} | depth=${pathItem.depth} | responses=${replayInfo.responseCount} | size=${replayInfo.byteLength}`,
          );
        });
      }
    }
  } finally {
    if (runner) runner.destroyDuel();
    if (runtime?.wrapper) {
      try {
        runtime.wrapper.finalize();
      } catch {
        // ignore
      }
    }
    if (runtime?.db) {
      try {
        runtime.db.close();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((err) => {
  console.error(`[combo-simulator] ${err?.message ?? err}`);
  process.exit(1);
});
