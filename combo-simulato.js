import { createOcgcoreWrapper, _OcgcoreConstants } from 'koishipro-core.js'
import { CardDataEntry } from 'ygopro-cdb-encode'
import * as ygopro from 'ygopro-msg-encode'
import {
  YGOProYrp,
  ReplayHeader,
  REPLAY_ID_YRP1,
  REPLAY_ID_YRP2,
  REPLAY_COMPRESSED_FLAG,
} from 'ygopro-yrp-encode'

const {
  OcgcoreScriptConstants: SCRIPT,
  OcgcoreCommonConstants: COMMON,
} = _OcgcoreConstants

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
} = SCRIPT

const QUERY_FLAG_SNAPSHOT =
  COMMON.QUERY_CODE |
  COMMON.QUERY_TYPE |
  COMMON.QUERY_ATTACK |
  COMMON.QUERY_DEFENSE |
  COMMON.QUERY_POSITION

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
}

const BATTLE_CMD = {
  ACTIVATE: 0,
  ATTACK: 1,
  TO_M2: 2,
  TO_EP: 3,
}

const DEFAULT_OPTIONS = {
  drawCount: 1,
  maxDepth: 200,
  maxNodes: 100000,
  maxActionsPerNode: 12,
  maxProcessPerStep: 2000,
  snapshotPoolSize: 128,
  seed: 2014839433,
  topK: 20,
}

function toUInt32(input, fallback = DEFAULT_OPTIONS.seed) {
  const n = Number(input)
  if (!Number.isFinite(n)) return fallback >>> 0
  return n >>> 0
}

function toInt(input, fallback) {
  const n = Number(input)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback
}

function uniq(arr) {
  return [...new Set(arr)]
}

function trimText(text, max = 24) {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

function makeXorshift32(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function simulateOpeningHand(mainDeck, drawCount, seed) {
  const deck = mainDeck.slice()
  const rnd = makeXorshift32(seed)
  shuffleInPlace(deck, rnd)
  return {
    opening: deck.slice(0, drawCount),
    remain: deck.slice(drawCount),
  }
}

function buildFixedOpening(mainDeck, openingCards, label = '固定起手') {
  const remain = mainDeck.slice()
  const opening = []
  for (const rawCode of openingCards ?? []) {
    const code = rawCode >>> 0
    const idx = remain.indexOf(code)
    if (idx < 0) {
      throw new Error(`${label} 不在主卡组中或数量不足: ${code}`)
    }
    opening.push(code)
    remain.splice(idx, 1)
  }
  return { opening, remain }
}

function parseYdkText(text) {
  const deck = { main: [], extra: [], side: [] }
  let section = 'main'
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()
    if (lower === '#main') {
      section = 'main'
      continue
    }
    if (lower === '#extra') {
      section = 'extra'
      continue
    }
    if (lower === '!side') {
      section = 'side'
      continue
    }
    if (line.startsWith('#')) continue
    const code = Number(line)
    if (!Number.isFinite(code)) continue
    deck[section].push(code >>> 0)
  }
  return deck
}

function normalizeDeck(input) {
  if (typeof input === 'string') return parseYdkText(input)
  if (!input || typeof input !== 'object') return { main: [], extra: [], side: [] }
  const deck = {
    main: Array.isArray(input.main) ? input.main.map((x) => Number(x) >>> 0) : [],
    extra: Array.isArray(input.extra) ? input.extra.map((x) => Number(x) >>> 0) : [],
    side: Array.isArray(input.side) ? input.side.map((x) => Number(x) >>> 0) : [],
  }
  return deck
}

function normalizeCodeList(input) {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0).map((x) => x >>> 0)
  }
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const n = Number(token)
      if (!Number.isFinite(n) || n <= 0) return 0
      return n >>> 0
    })
    .filter((x) => x > 0)
}

function normalizeKeywordList(input) {
  if (!input) return []
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean)
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeScriptsMap(input) {
  const map = new Map()
  if (!input) return map
  if (input instanceof Map) {
    for (const [k, v] of input.entries()) {
      map.set(String(k), typeof v === 'string' ? v : new TextDecoder().decode(v))
    }
    return map
  }
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') map.set(String(k), v)
  }
  return map
}

function normalizeCardsMap(input) {
  const map = new Map()
  if (!input) return map
  if (input instanceof Map) {
    for (const [k, v] of input.entries()) {
      const key = Number(k) >>> 0
      if (key > 0 && v && typeof v === 'object') {
        map.set(key, { ...v, code: key })
      }
    }
    return map
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const code = Number(item?.code) >>> 0
      if (code > 0) map.set(code, { ...item, code })
    }
    return map
  }
  for (const [k, v] of Object.entries(input)) {
    const code = Number(k) >>> 0
    if (code > 0 && v && typeof v === 'object') {
      map.set(code, { ...v, code })
    }
  }
  return map
}

function normalizeScriptKey(name) {
  return String(name ?? '').replace(/\\/g, '/').replace(/^\.?\//, '')
}

function lookupScriptText(scripts, name) {
  const normalized = normalizeScriptKey(name)
  const fileName = normalized.includes('/') ? normalized.split('/').pop() : normalized
  const candidates = uniq([
    normalized,
    `script/${normalized}`,
    `./script/${normalized}`,
    fileName ? `script/${fileName}` : '',
    fileName ? `./script/${fileName}` : '',
    fileName ?? '',
  ]).filter(Boolean)
  for (const key of candidates) {
    const content = scripts.get(key)
    if (typeof content === 'string' && content.length > 0) return content
  }
  return null
}

function toCardDataEntry(raw, code) {
  if (!raw) return null
  const setcode = Array.isArray(raw.setcode) ? raw.setcode : [raw.setcode || 0]
  return new CardDataEntry().fromPartial({
    code: raw.code || code || 0,
    alias: raw.alias || 0,
    setcode,
    type: raw.type || 0,
    level: raw.level || 0,
    attribute: raw.attribute || 0,
    race: raw.race || 0,
    attack: raw.attack || 0,
    defense: raw.defense || 0,
    lscale: raw.lscale || 0,
    rscale: raw.rscale || 0,
    linkMarker: raw.link_marker || raw.linkMarker || 0,
    name: raw.name || '',
    desc: raw.desc || '',
  })
}

class CardTextResolver {
  constructor(cardsMap) {
    this.cardsMap = cardsMap
  }

  getCard(code) {
    const id = code >>> 0
    const raw = this.cardsMap.get(id) ?? {}
    const effects = Array.isArray(raw.effects) ? raw.effects.filter(Boolean).map((x) => String(x)) : []
    const effectByIndex = {}
    for (let i = 0; i < effects.length; i += 1) effectByIndex[i + 1] = effects[i]
    return {
      id,
      name: String(raw.name || id),
      desc: String(raw.desc || ''),
      effects,
      effectByIndex,
    }
  }

  getName(code) {
    return this.getCard(code).name
  }

  getDescription(code) {
    return this.getCard(code).desc
  }

  getEffectDescription(code, descId) {
    if (!descId) return ''
    const card = this.getCard(code)
    const id = Number(descId) >>> 0
    const candidates = []
    const lowNibble = id & 0xf
    if (lowNibble > 0) candidates.push(lowNibble)
    const lowByte = id & 0xff
    if (lowByte > 0) candidates.push(lowByte)
    const shifted = id >>> 4
    if (shifted > 0 && shifted < 64) candidates.push(shifted)
    for (const idx of uniq(candidates)) {
      if (card.effectByIndex[idx]) return card.effectByIndex[idx]
    }
    if (card.effects.length === 1) return card.effects[0]
    return ''
  }
}

async function createRuntime(resources, runtimeOptions = {}) {
  const wrapper = await createOcgcoreWrapper(runtimeOptions)
  const scriptReader = (name) => lookupScriptText(resources.scripts, name)
  wrapper.setScriptReader(scriptReader, true)
  wrapper.setCardReader((code) => toCardDataEntry(resources.cards.get(code >>> 0), code >>> 0), true)
  return {
    wrapper,
    cardText: new CardTextResolver(resources.cards),
  }
}

class DuelRunner {
  constructor(params) {
    this.wrapper = params.wrapper
    this.cardText = params.cardText
    this.seed = params.seed >>> 0
    this.config = params.config
    this.playerDeck = params.playerDeck
    this.opponentDeck = params.opponentDeck
    this.playerOpening = params.playerOpening
    this.opponentOpening = params.opponentOpening
    this.duel = null
    this.currentDecision = null
    this.actionHistory = []
    this.replayCollector = null
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
    }
  }

  init() {
    this.rebuildFromHistory([])
  }

  destroyDuel() {
    if (!this.duel) return
    try {
      this.duel.endDuel()
    } catch {}
    this.duel = null
    this.currentDecision = null
    this.actionHistory = []
  }

  loadDeck(duel, deck, opening, owner, player) {
    for (const code of opening.opening) {
      duel.newCard({ code, owner, player, location: LOCATION_HAND, sequence: 0, position: POS_FACEDOWN_DEFENSE })
    }
    for (const code of opening.remain) {
      duel.newCard({ code, owner, player, location: LOCATION_DECK, sequence: 0, position: POS_FACEDOWN_DEFENSE })
    }
    for (const code of deck.extra) {
      duel.newCard({ code, owner, player, location: LOCATION_EXTRA, sequence: 0, position: POS_FACEDOWN_DEFENSE })
    }
  }

  createDuelInstance() {
    const duel = this.wrapper.createDuel(this.seed)
    duel.setPlayerInfo({ player: 0, lp: 8000, startHand: 0, drawCount: 1 })
    duel.setPlayerInfo({ player: 1, lp: 8000, startHand: 0, drawCount: 1 })
    for (const preload of ['./script/patches/entry.lua', './script/special.lua', './script/init.lua']) {
      try {
        duel.preloadScript(preload)
      } catch {}
    }
    this.loadDeck(duel, this.playerDeck, this.playerOpening, 0, 0)
    this.loadDeck(duel, this.opponentDeck, this.opponentOpening, 1, 1)
    duel.startDuel(0)
    return duel
  }

  encodeAction(action) {
    if (typeof action.intResponse === 'number') {
      return { label: action.label, kind: action.kind, text: action.text || '', intResponse: action.intResponse }
    }
    return {
      label: action.label,
      kind: action.kind,
      text: action.text || '',
      responseBytes: Array.from(action.response ?? []),
    }
  }

  decodeAction(encoded) {
    if (typeof encoded.intResponse === 'number') {
      return { label: encoded.label, kind: encoded.kind, text: encoded.text || '', intResponse: encoded.intResponse }
    }
    return {
      label: encoded.label,
      kind: encoded.kind,
      text: encoded.text || '',
      response: Uint8Array.from(encoded.responseBytes ?? []),
    }
  }

  collectReplayResponse(entry) {
    if (!this.replayCollector) return
    this.replayCollector.push(this.encodeAction(entry))
  }

  buildReplayResponseHistory(state) {
    const saved = this.saveState()
    const manualHistory = Array.isArray(state?.history) ? state.history.map((item) => ({ ...item })) : []
    const replayResponses = []
    try {
      this.replayCollector = replayResponses
      this.restoreState({ history: [] })
      for (const encoded of manualHistory) {
        const action = this.decodeAction(encoded)
        if (typeof action.intResponse === 'number') {
          this.duel.setResponseInt(action.intResponse)
          this.collectReplayResponse({ intResponse: action.intResponse })
        } else {
          this.duel.setResponse(action.response)
          this.collectReplayResponse({ response: action.response })
        }
        this.currentDecision = this.advanceUntilDecision()
        if (this.currentDecision?.terminal) break
      }
    } finally {
      this.replayCollector = null
      this.restoreState(saved)
    }
    return replayResponses
  }

  captureSnapshotBytes() {
    if (!this.duel || typeof this.duel.saveState !== 'function') return null
    try {
      const raw = this.duel.saveState()
      if (raw instanceof Uint8Array) return Array.from(raw)
      if (Array.isArray(raw)) return Array.from(raw)
      return null
    } catch {
      return null
    }
  }

  restoreSnapshotBytes(bytes) {
    if (!this.duel || typeof this.duel.loadState !== 'function' || !Array.isArray(bytes) || bytes.length === 0) return false
    try {
      this.duel.loadState(Uint8Array.from(bytes))
      this.currentDecision = this.advanceUntilDecision()
      return true
    } catch {
      return false
    }
  }

  saveState() {
    const state = { history: this.actionHistory.map((item) => ({ ...item })) }
    const bytes = this.captureSnapshotBytes()
    if (bytes && bytes.length > 0) state.snapshotBytes = bytes
    return state
  }

  restoreState(state) {
    if (!Array.isArray(state?.history)) return
    const history = state.history.map((item) => ({ ...item }))
    if (this.duel && this.restoreSnapshotBytes(state.snapshotBytes)) {
      this.actionHistory = history
      return
    }
    this.rebuildFromHistory(history)
  }

  rebuildFromHistory(history) {
    if (this.duel) {
      try {
        this.duel.endDuel()
      } catch {}
    }
    this.duel = this.createDuelInstance()
    this.currentDecision = this.advanceUntilDecision()
    this.actionHistory = []
    for (const encoded of history) {
      const action = this.decodeAction(encoded)
      if (typeof action.intResponse === 'number') this.duel.setResponseInt(action.intResponse)
      else this.duel.setResponse(action.response)
      this.actionHistory.push(this.encodeAction(action))
      this.currentDecision = this.advanceUntilDecision()
      if (this.currentDecision?.terminal) break
    }
  }

  step(action) {
    if (typeof action.intResponse === 'number') this.duel.setResponseInt(action.intResponse)
    else this.duel.setResponse(action.response)
    this.actionHistory.push(this.encodeAction(action))
    this.currentDecision = this.advanceUntilDecision()
    return this.currentDecision
  }

  autoRespond(msg) {
    const sendResponse = (resp) => {
      this.duel.setResponse(resp)
      this.collectReplayResponse({ response: resp })
      return true
    }
    const sendInt = (value) => {
      this.duel.setResponseInt(value | 0)
      this.collectReplayResponse({ intResponse: value | 0 })
      return true
    }
    try {
      const def = msg.defaultResponse?.()
      if (def) return sendResponse(def)
    } catch {}
    if (msg instanceof this.classes.SelectOption) {
      const val = msg.options?.[0] ?? 0
      try {
        return sendResponse(msg.prepareResponse(val))
      } catch {}
      try {
        return sendResponse(msg.prepareResponse(0))
      } catch {}
    }
    try {
      return sendInt(0)
    } catch {
      return false
    }
  }

  advanceUntilDecision() {
    let guard = 0
    while (guard < this.config.maxProcessPerStep) {
      guard += 1
      const res = this.duel.process()
      const messages =
        Array.isArray(res.messages) && res.messages.length > 0 ? res.messages : res.message ? [res.message] : []
      for (const msg of messages) {
        if (msg instanceof this.classes.Retry) return { terminal: true, reason: 'MSG_RETRY', actions: [] }
        if (msg instanceof this.classes.Response) {
          const responsePlayer = typeof msg.responsePlayer === 'function' ? msg.responsePlayer() : 0
          if (responsePlayer !== 0) {
            if (!this.autoRespond(msg)) return { terminal: true, reason: 'AUTO_RESPONSE_FAIL', actions: [] }
            continue
          }
          const actions = this.enumerateActions(msg)
          if (actions.length === 0) return { terminal: true, reason: 'NO_ACTION', actions: [] }
          return { terminal: false, reason: null, actions, message: msg }
        }
      }
      if (res.status === 2) return { terminal: true, reason: 'STATUS_END', actions: [] }
      if (res.raw && res.raw.length > 0 && res.raw[0] === COMMON.MSG_RETRY) return { terminal: true, reason: 'MSG_RETRY_RAW', actions: [] }
    }
    return { terminal: true, reason: 'PROCESS_GUARD', actions: [] }
  }

  makeAction({ label, kind, response, intResponse, text }) {
    return { label, kind, response, intResponse, text }
  }

  enumerateActions(msg) {
    const actions = []
    const add = (action) => {
      if (action) actions.push(action)
    }
    const cardName = (code) => this.cardText.getName(code)
    const effectText = (code, desc) =>
      `${this.cardText.getDescription(code)} ${this.cardText.getEffectDescription(code, desc)}`.trim()
    if (msg instanceof this.classes.SelectIdle) {
      for (const card of msg.summonableCards ?? []) add(this.makeAction({ label: `通常召唤[${cardName(card.code)}]`, kind: 'summon', response: msg.prepareResponse(IDLE_CMD.SUMMON, card), text: this.cardText.getDescription(card.code) }))
      for (const card of msg.spSummonableCards ?? []) add(this.makeAction({ label: `特殊召唤[${cardName(card.code)}]`, kind: 'spsummon', response: msg.prepareResponse(IDLE_CMD.SPSUMMON, card), text: this.cardText.getDescription(card.code) }))
      for (const card of msg.reposableCards ?? []) add(this.makeAction({ label: `改变表示[${cardName(card.code)}]`, kind: 'reposition', response: msg.prepareResponse(IDLE_CMD.REPOS, card), text: this.cardText.getDescription(card.code) }))
      for (const card of msg.msetableCards ?? []) add(this.makeAction({ label: `盖放怪兽[${cardName(card.code)}]`, kind: 'set', response: msg.prepareResponse(IDLE_CMD.MSET, card), text: this.cardText.getDescription(card.code) }))
      for (const card of msg.ssetableCards ?? []) add(this.makeAction({ label: `盖放魔陷[${cardName(card.code)}]`, kind: 'set', response: msg.prepareResponse(IDLE_CMD.SSET, card), text: this.cardText.getDescription(card.code) }))
      for (const card of msg.activatableCards ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(card.code, card.desc), 18)
        add(this.makeAction({ label: `发动效果[${cardName(card.code)}]${effect ? `(${effect})` : ''}`, kind: 'activate', response: msg.prepareResponse(IDLE_CMD.ACTIVATE, card), text: effectText(card.code, card.desc) }))
      }
      if (msg.canBp) add(this.makeAction({ label: '进入战斗阶段', kind: 'other', response: msg.prepareResponse(IDLE_CMD.TO_BP), text: '' }))
      if (msg.canEp) add(this.makeAction({ label: '结束回合', kind: 'phase_end', response: msg.prepareResponse(IDLE_CMD.TO_EP), text: '' }))
    } else if (msg instanceof this.classes.SelectBattle) {
      for (const card of msg.activatableCards ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(card.code, card.desc), 18)
        add(this.makeAction({ label: `战阶发动[${cardName(card.code)}]${effect ? `(${effect})` : ''}`, kind: 'activate', response: msg.prepareResponse(BATTLE_CMD.ACTIVATE, card), text: effectText(card.code, card.desc) }))
      }
      for (const card of msg.attackableCards ?? []) add(this.makeAction({ label: `攻击[${cardName(card.code)}]`, kind: 'attack', response: msg.prepareResponse(BATTLE_CMD.ATTACK, card), text: '' }))
      if (msg.canM2) add(this.makeAction({ label: '进入主要阶段2', kind: 'other', response: msg.prepareResponse(BATTLE_CMD.TO_M2), text: '' }))
      if (msg.canEp) add(this.makeAction({ label: '战阶结束', kind: 'phase_end', response: msg.prepareResponse(BATTLE_CMD.TO_EP), text: '' }))
    } else if (msg instanceof this.classes.SelectChain) {
      for (const chain of msg.chains ?? []) {
        const effect = trimText(this.cardText.getEffectDescription(chain.code, chain.desc), 18)
        add(this.makeAction({ label: `连锁发动[${cardName(chain.code)}]${effect ? `(${effect})` : ''}`, kind: 'chain', response: msg.prepareResponse(chain), text: effectText(chain.code, chain.desc) }))
      }
      const def = msg.defaultResponse?.()
      if (def) add(this.makeAction({ label: '不连锁', kind: 'other', response: def, text: '' }))
    } else if (msg instanceof this.classes.SelectEffectYn) {
      const text = effectText(msg.code, msg.desc)
      add(this.makeAction({ label: `发动[${cardName(msg.code)}]`, kind: 'activate', response: msg.prepareResponse(true), text }))
      add(this.makeAction({ label: `不发动[${cardName(msg.code)}]`, kind: 'other', response: msg.prepareResponse(false), text: '' }))
    } else if (msg instanceof this.classes.SelectYesNo) {
      add(this.makeAction({ label: '选择[是]', kind: 'yes', response: msg.prepareResponse(true), text: '' }))
      add(this.makeAction({ label: '选择[否]', kind: 'other', response: msg.prepareResponse(false), text: '' }))
    } else if (msg instanceof this.classes.SelectOption) {
      for (let i = 0; i < (msg.options?.length ?? 0); i += 1) {
        const optionValue = msg.options[i]
        try {
          add(this.makeAction({ label: `选择选项#${i + 1}`, kind: 'option', response: msg.prepareResponse(optionValue), text: '' }))
        } catch {
          try {
            add(this.makeAction({ label: `选择选项#${i + 1}`, kind: 'option', response: msg.prepareResponse(i), text: '' }))
          } catch {}
        }
      }
    } else if (msg instanceof this.classes.SelectCard) {
      const min = Math.max(1, msg.min ?? 1)
      const cards = msg.cards ?? []
      if (min <= 1) {
        for (const c of cards.slice(0, 6)) add(this.makeAction({ label: `选择卡片[${cardName(c.code)}]`, kind: 'other', response: msg.prepareResponse([c]), text: this.cardText.getDescription(c.code) }))
      } else {
        const picked = cards.slice(0, min)
        if (picked.length === min) add(this.makeAction({ label: `选择${min}张卡片`, kind: 'other', response: msg.prepareResponse(picked), text: picked.map((c) => this.cardText.getDescription(c.code)).join(' ') }))
      }
    } else if (msg instanceof this.classes.SelectPlace || msg instanceof this.classes.SelectDisField) {
      const places = msg.getSelectablePlaces?.() ?? []
      const need = Math.max(1, msg.count ?? 1)
      if (places.length >= need) add(this.makeAction({ label: '选择区域', kind: 'other', response: msg.prepareResponse(places.slice(0, need)), text: '' }))
    } else if (msg instanceof this.classes.SelectPosition) {
      const POS = [1, 2, 4, 8]
      for (const p of POS) {
        if ((msg.positions & p) !== 0) add(this.makeAction({ label: `选择表示形式(${p})`, kind: 'other', response: msg.prepareResponse(p), text: '' }))
      }
    } else if (msg instanceof this.classes.SelectUnselect) {
      const selectable = msg.selectableCards ?? []
      for (const c of selectable.slice(0, 6)) add(this.makeAction({ label: `选择卡片[${cardName(c.code)}]`, kind: 'other', response: msg.prepareResponse(c), text: this.cardText.getDescription(c.code) }))
      if (msg.finishable && (selectable.length === 0 || (msg.min ?? 0) === 0)) {
        try {
          add(this.makeAction({ label: '确认选择', kind: selectable.length === 0 ? 'option' : 'fallback', response: msg.prepareResponse(null), text: '' }))
        } catch {}
      }
    } else {
      const def = msg.defaultResponse?.()
      if (def) add(this.makeAction({ label: `默认响应[${msg.constructor.name}]`, kind: 'fallback', response: def, text: '' }))
      else add(this.makeAction({ label: `整数响应0[${msg.constructor.name}]`, kind: 'fallback', intResponse: 0, text: '' }))
    }
    const scriptKeywords = this.config.expandScriptKeywords ?? []
    const filtered = actions.filter((action) => {
      if (action.kind !== 'reposition' && action.kind !== 'set') return true
      if (!Array.isArray(scriptKeywords) || scriptKeywords.length === 0) return false
      const haystack = `${action.label} ${action.text ?? ''}`.toLowerCase()
      return scriptKeywords.some((kw) => haystack.includes(String(kw).toLowerCase()))
    })
    const picked = filtered.length > 0 ? filtered : actions.filter((a) => a.kind !== 'reposition' && a.kind !== 'set')
    return picked.slice(0, this.config.maxActionsPerNode)
  }

  queryCodes(player, location) {
    const out = this.duel.queryFieldCard({ player, location, queryFlag: QUERY_FLAG_SNAPSHOT })
    return (out.cards ?? []).map((c) => c.code >>> 0).filter((c) => c > 0)
  }

  captureSnapshot() {
    const info = this.duel.queryFieldInfo().field
    const p0 = info.players?.[0]
    const p1 = info.players?.[1]
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
    }
    snapshot.cardIdList = {
      p0Field: [...snapshot.p0.mzone, ...snapshot.p0.szone],
      p0Extra: this.queryCodes(0, LOCATION_EXTRA),
      p1Field: [...snapshot.p1.mzone, ...snapshot.p1.szone],
      p0Hand: [...snapshot.p0.hand],
      p0Grave: [...snapshot.p0.grave],
    }
    return snapshot
  }

  scoreSnapshot(snapshot) {
    const ownField = snapshot.p0.mzone.length * 6 + snapshot.p0.szone.length * 3
    const ownResource = snapshot.p0.hand.length * 2 + snapshot.p0.grave.length
    const oppPressure = snapshot.p1.mzone.length * 4 + snapshot.p1.szone.length * 2
    const lpDelta = (snapshot.lp.p0 - snapshot.lp.p1) / 800
    return ownField + ownResource - oppPressure + lpDelta
  }
}

function makeExactStateKey(snapshot, decision) {
  const sortCodes = (codes) => [...(codes ?? [])].map((x) => x >>> 0).sort((a, b) => a - b).join(',')
  const decisionSig = decision?.actions?.length
    ? decision.actions.slice(0, 12).map((action) => `${action.kind}:${action.label}`).join('^')
    : decision?.message?.constructor?.name ?? decision?.reason ?? 'terminal'
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
  ].join('|')
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
  }[action?.kind] ?? 0
  let score = base
  if (/^不/.test(action?.label ?? '')) score -= 2
  if ((action?.text ?? '').length > 0) score += 0.5
  return score
}

function sortActionsForLongestPath(actions) {
  return [...(actions ?? [])].sort((a, b) =>
    rankActionForLongestPath(b) - rankActionForLongestPath(a) || String(a?.label ?? '').localeCompare(String(b?.label ?? ''), 'zh-Hans-CN'))
}

function cloneHistoryState(state) {
  if (!state || !Array.isArray(state.history)) return { history: [] }
  const out = { history: state.history.map((item) => ({ ...item })) }
  if (Array.isArray(state.snapshotBytes) && state.snapshotBytes.length > 0) out.snapshotBytes = [...state.snapshotBytes]
  return out
}

function encodedActionToReplayResponse(action) {
  if (typeof action?.intResponse === 'number') {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setInt32(0, action.intResponse | 0, true)
    return out
  }
  if (Array.isArray(action?.responseBytes)) {
    return Uint8Array.from(action.responseBytes)
  }
  return new Uint8Array(0)
}

function makeSeedSequence(seed, count = 8) {
  const rnd = makeXorshift32(seed ^ 0x6a09e667)
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push((rnd() * 0x100000000) >>> 0)
  }
  return out
}

function buildReplayMainDeck(openingInfo, fallbackMain) {
  const opening = openingInfo?.opening
  const remain = openingInfo?.remain
  if (Array.isArray(opening) && Array.isArray(remain) && opening.length > 0) {
    return [...remain, ...opening.slice().reverse()]
  }
  return [...(fallbackMain ?? [])]
}

function buildYrpBytesFromState(params) {
  const {
    seed,
    drawCount,
    playerDeck,
    opponentDeck,
    playerOpening,
    opponentOpening,
    state,
    responsesEncoded,
    yrpVersion = 1,
  } = params
  const sourceResponses =
    Array.isArray(responsesEncoded) && responsesEncoded.length > 0
      ? responsesEncoded
      : Array.isArray(state?.history)
        ? state.history
        : []
  const responses = sourceResponses.map(encodedActionToReplayResponse).filter((seg) => seg.length > 0)
  const header = new ReplayHeader()
  header.id = (yrpVersion === 2 ? REPLAY_ID_YRP2 : REPLAY_ID_YRP1) ?? 829452921
  header.version = 4962
  header.flag = REPLAY_COMPRESSED_FLAG ?? 1
  header.seed = seed >>> 0
  header.hash = ((seed >>> 0) * 2654435761) >>> 0
  header.props = [93, 0, 0, 32, 0, 0, 0, 0]
  if (yrpVersion === 2) {
    header.seedSequence = makeSeedSequence(seed >>> 0)
    header.headerVersion = 1
    header.value1 = 0
    header.value2 = 0
    header.value3 = 0
  } else {
    header.seedSequence = []
    header.headerVersion = 0
    header.value1 = 0
    header.value2 = 0
    header.value3 = 0
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
  })
  return Uint8Array.from(yrp.toYrp())
}

function searchTopLongestPathsExactSingle(runner, opts) {
  const best = { nodes: 0, terminalCount: 0, topPaths: [] }
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK)
  const progressEvery = Math.max(1, opts.progressEvery ?? 200)
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null
  const rootState = runner.saveState()
  const pathStateCounts = new Map()
  const chain = []
  let lastReportedNodes = -1
  const settleTerminal = (chainNow, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    const snapshot = snapshotOverride ?? runner.captureSnapshot()
    const score = runner.scoreSnapshot(snapshot)
    best.terminalCount += 1
    best.topPaths.push({
      chain: chainNow.slice(),
      depth: chainNow.length,
      score,
      reason: reasonHint,
      snapshot,
      state: stateOverride ? cloneHistoryState(stateOverride) : null,
    })
    best.topPaths.sort((a, b) => b.depth - a.depth || b.score - a.score)
    if (best.topPaths.length > topK) best.topPaths.length = topK
  }
  const maybeReportProgress = (currentDepth) => {
    if (!onProgress) return
    if (best.nodes !== 0 && best.nodes % progressEvery !== 0 && best.nodes < opts.maxNodes) return
    if (best.nodes === lastReportedNodes) return
    lastReportedNodes = best.nodes
    onProgress({ nodes: best.nodes, maxNodes: opts.maxNodes, terminalCount: best.terminalCount, currentDepth, done: false })
  }
  const explore = (state, depth, sameKeyStreak = 0) => {
    if (best.nodes >= opts.maxNodes) return
    if (shouldStop?.()) return
    runner.restoreState(state)
    const snapshot = runner.captureSnapshot()
    const current = runner.currentDecision
    const stateKey = makeExactStateKey(snapshot, current)
    if (!current || current.terminal || !current.actions?.length) {
      settleTerminal(chain, snapshot, current?.reason ?? 'NO_ACTION_OR_NULL', state)
      return
    }
    if (depth >= opts.maxDepth) {
      settleTerminal(chain, snapshot, 'MAX_DEPTH', state)
      return
    }
    pathStateCounts.set(stateKey, (pathStateCounts.get(stateKey) ?? 0) + 1)
    let exploredChild = false
    const nonEndActions = current.actions.filter((a) => a.kind !== 'phase_end')
    const iterActions = sortActionsForLongestPath(nonEndActions.length > 0 ? nonEndActions : current.actions)
    for (const action of iterActions) {
      if (best.nodes >= opts.maxNodes) break
      if (shouldStop?.()) break
      runner.step(action)
      best.nodes += 1
      chain.push(action.label)
      const childState = runner.saveState()
      const childSnapshot = runner.captureSnapshot()
      const childDecision = runner.currentDecision
      const childDepth = depth + 1
      if (action.kind === 'phase_end') {
        exploredChild = true
        settleTerminal(chain, childSnapshot, 'TURN_END', childState)
        runner.restoreState(state)
        chain.pop()
        maybeReportProgress(childDepth)
        continue
      }
      const childStateKey = makeExactStateKey(childSnapshot, childDecision)
      const childSameKeyStreak = childStateKey === stateKey ? sameKeyStreak + 1 : 0
      const childPathCount = pathStateCounts.get(childStateKey) ?? 0
      const skipBecauseLoop =
        (childStateKey === stateKey && (action.kind === 'fallback' || action.label === '确认选择')) ||
        childSameKeyStreak > 2 ||
        childPathCount >= 3
      if (!skipBecauseLoop) {
        exploredChild = true
        explore(childState, childDepth, childSameKeyStreak)
      }
      runner.restoreState(state)
      chain.pop()
      maybeReportProgress(childDepth)
    }
    const nextCount = (pathStateCounts.get(stateKey) ?? 1) - 1
    if (nextCount > 0) pathStateCounts.set(stateKey, nextCount)
    else pathStateCounts.delete(stateKey)
    if (!exploredChild) {
      settleTerminal(chain, snapshot, best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'ALL_CHILDREN_PRUNED', state)
    }
  }
  runner.restoreState(rootState)
  if (onProgress) onProgress({ nodes: 0, maxNodes: opts.maxNodes, terminalCount: 0, currentDepth: 0, done: false })
  explore(rootState, 0)
  runner.restoreState(rootState)
  if (best.topPaths.length === 0) settleTerminal([], null, best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'NO_RESULT', rootState)
  if (onProgress) onProgress({ nodes: best.nodes, maxNodes: opts.maxNodes, terminalCount: best.terminalCount, currentDepth: 0, done: true })
  return best
}

export async function runComboSimulation(task, hooks = {}) {
  const options = task?.options ?? {}
  const wasmBinary =
    task?.wasmBinary instanceof Uint8Array
      ? task.wasmBinary
      : Array.isArray(task?.wasmBinary)
        ? Uint8Array.from(task.wasmBinary)
        : null
  const seed = toUInt32(options.seed, DEFAULT_OPTIONS.seed)
  const drawCount = toInt(options.drawCount, DEFAULT_OPTIONS.drawCount)
  const maxDepth = toInt(options.maxDepth, DEFAULT_OPTIONS.maxDepth)
  const maxNodes = toInt(options.maxNodes, DEFAULT_OPTIONS.maxNodes)
  const maxActionsPerNode = Math.max(1, toInt(options.maxActionsPerNode, DEFAULT_OPTIONS.maxActionsPerNode))
  const snapshotPoolSize = Math.max(0, toInt(options.snapshotPoolSize, DEFAULT_OPTIONS.snapshotPoolSize))
  const topK = Math.max(1, toInt(options.topK, DEFAULT_OPTIONS.topK))
  const buildYrpCache = options.buildYrpCache !== false
  const yrpVersion = Number(options.yrpVersion) === 2 ? 2 : 1
  const expandScriptKeywords = normalizeKeywordList(options.expandScriptKeywords)
  const openingCards = normalizeCodeList(options.openingCards)
  const opponentOpeningCards = normalizeCodeList(options.opponentOpeningCards)
  const playerDeck = normalizeDeck(task?.deck)
  const opponentDeck = normalizeDeck(task?.opponentDeck ?? task?.deck)
  if (playerDeck.main.length < drawCount || opponentDeck.main.length < drawCount) {
    throw new Error(`主卡组数量不足以抽${drawCount}张起手`)
  }
  if (openingCards.length > 0 && openingCards.length !== drawCount) {
    throw new Error(`openingCards 数量(${openingCards.length}) 必须等于 drawCount(${drawCount})`)
  }
  if (opponentOpeningCards.length > 0 && opponentOpeningCards.length !== drawCount) {
    throw new Error(`opponentOpeningCards 数量(${opponentOpeningCards.length}) 必须等于 drawCount(${drawCount})`)
  }
  const playerOpening =
    openingCards.length > 0 ? buildFixedOpening(playerDeck.main, openingCards, '我方固定起手') : simulateOpeningHand(playerDeck.main, drawCount, seed)
  const opponentOpening =
    opponentOpeningCards.length > 0
      ? buildFixedOpening(opponentDeck.main, opponentOpeningCards, '对方固定起手')
      : simulateOpeningHand(opponentDeck.main, drawCount, (seed ^ 0x9e3779b9) >>> 0)
  const resources = {
    cards: normalizeCardsMap(task?.cards),
    scripts: normalizeScriptsMap(task?.scripts),
  }
  let runtime = null
  let runner = null
  try {
    runtime = await createRuntime(resources, wasmBinary ? { wasmBinary } : {})
    runner = new DuelRunner({
      wrapper: runtime.wrapper,
      cardText: runtime.cardText,
      seed,
      config: {
        maxDepth,
        maxNodes,
        maxActionsPerNode,
        maxProcessPerStep: Math.max(1, toInt(options.maxProcessPerStep, DEFAULT_OPTIONS.maxProcessPerStep)),
        snapshotPoolSize,
        expandScriptKeywords,
      },
      playerDeck,
      opponentDeck,
      playerOpening,
      opponentOpening,
    })
    runner.init()
    const result = searchTopLongestPathsExactSingle(runner, {
      maxDepth,
      maxNodes,
      topK,
      seed,
      progressEvery: Math.max(50, Math.floor(maxNodes / 200)),
      shouldStop: hooks?.shouldStop,
      onProgress: hooks?.onProgress,
    })
    const cachedReplays = []
    if (buildYrpCache) {
      for (let idx = 0; idx < result.topPaths.length; idx += 1) {
        const item = result.topPaths[idx]
        if (!Array.isArray(item?.state?.history) || item.state.history.length === 0) continue
        const responsesEncoded = runner.buildReplayResponseHistory(item.state)
        const bytes = buildYrpBytesFromState({
          seed,
          drawCount,
          playerDeck,
          opponentDeck,
          playerOpening,
          opponentOpening,
          state: item.state,
          responsesEncoded,
          yrpVersion,
        })
        cachedReplays.push({
          id: `top${idx + 1}`,
          name: `Top${idx + 1}-depth${item.depth}`,
          rank: idx + 1,
          depth: item.depth,
          score: item.score,
          reason: item.reason,
          yrpVersion,
          bytes,
        })
      }
    }
    return {
      seed,
      drawCount,
      playerOpening: playerOpening.opening,
      opponentOpening: opponentOpening.opening,
      nodes: result.nodes,
      terminalCount: result.terminalCount,
      cachedReplays,
      topPaths: result.topPaths.map((item, idx) => ({
        rank: idx + 1,
        depth: item.depth,
        score: item.score,
        reason: item.reason,
        chain: item.chain,
        snapshot: item.snapshot,
      })),
    }
  } finally {
    if (runner) runner.destroyDuel()
    if (runtime?.wrapper) {
      try {
        runtime.wrapper.finalize()
      } catch {}
    }
  }
}

let activeRunId = null
const cancelledRunIds = new Set()

async function handleWorkerRun(message) {
  const runId = String(message?.runId ?? '')
  if (!runId) throw new Error('runId 不能为空')
  activeRunId = runId
  const shouldStop = () => cancelledRunIds.has(runId)
  const onProgress = (progress) => {
    if (shouldStop()) return
    self.postMessage({ type: 'progress', runId, ...progress })
  }
  const result = await runComboSimulation(message?.task ?? {}, { shouldStop, onProgress })
  if (shouldStop()) {
    self.postMessage({ type: 'cancelled', runId })
    return
  }
  const transferables = []
  for (const item of result?.cachedReplays ?? []) {
    if (item?.bytes?.buffer) transferables.push(item.bytes.buffer)
  }
  self.postMessage({ type: 'done', runId, result }, transferables)
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (event) => {
    const message = event?.data ?? {}
    const type = String(message?.type ?? '')
    if (type === 'cancel') {
      const runId = String(message?.runId ?? '')
      if (runId) cancelledRunIds.add(runId)
      return
    }
    if (type !== 'run') return
    try {
      await handleWorkerRun(message)
    } catch (err) {
      const runId = String(message?.runId ?? activeRunId ?? '')
      self.postMessage({ type: 'error', runId, message: err?.message ?? String(err) })
    } finally {
      activeRunId = null
    }
  }
}
