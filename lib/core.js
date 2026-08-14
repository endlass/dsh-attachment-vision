'use strict'
// dsh-attachment-vision 核心逻辑（纯函数，可单测）。
// 与宿主 dsh API 零耦合：index.js 负责 Cordis 接线，这里只做数据变换。
// 零 npm 依赖：仅 Node 内置模块 + 全局 fetch。

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')

// ---------- 路径 ----------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function attachmentsRootOf(dshHomeDir) {
  return path.join(dshHomeDir, 'attachments', 'v1')
}

/**
 * dsh-attachment-local 存储规则：
 * attachmentId = "sha256:<64hex>" → objects/<前2位hex>/<64hex>（原始字节，无扩展名）
 * 非法 id 返回 undefined。
 */
function attachmentPath(attachmentsRoot, attachmentId) {
  const m = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId == null ? '' : attachmentId))
  if (!m) return undefined
  const hex = m[1]
  return path.join(attachmentsRoot, 'objects', hex.slice(0, 2), hex)
}

// ---------- 消息改写（llm/stream 图片块 → 附件路径文本） ----------

/**
 * 把消息数组里的 image 内容块改写为「附件本地路径」提示文本。
 * 绝不修改入参（dsh-llm 深冻结不变式），返回新数组。
 * @returns {{changed: boolean, rewritten: Array}}
 */
function rewriteMessages(messages, attachmentsRoot) {
  if (!Array.isArray(messages)) return { changed: false, rewritten: messages }
  let changed = false
  const rewritten = []
  for (const msg of messages) {
    const content = msg && msg.content
    if (!Array.isArray(content)) { rewritten.push(msg); continue }
    const blocks = []
    for (const block of content) {
      if (!block || block.type !== 'image') { blocks.push(block); continue }
      const att = block.attachment
      const filePath = attachmentPath(attachmentsRoot, att && att.attachmentId)
      if (!filePath) { blocks.push(block); continue }
      changed = true
      blocks.push({
        type: 'text',
        text: '[用户发送了一张图片（' + (att.mediaType || 'image') + '，' +
          (att.width || '?') + 'x' + (att.height || '?') + '）。图片本体未随本消息发送，其本地文件在：' +
          filePath + '（原始字节文件，无扩展名）。你是纯文本模型看不到图片，请调用 view_image 工具查看该路径来理解图片内容。]',
      })
    }
    rewritten.push(Object.assign({}, msg, { content: blocks }))
  }
  // 无任何变更时返回原数组引用（对调用方友好，也便于测试）
  return changed ? { changed: true, rewritten } : { changed: false, rewritten: messages }
}

// ---------- 文本工具 ----------

function stripThink(text) {
  const s = String(text == null ? '' : text)
  const stripped = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return stripped || s.trim()
}

/**
 * OpenAI 兼容响应抽取：content 可能是字符串或 parts 数组。
 * @returns {string|undefined}
 */
function extractText(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const content = choices[0].message && choices[0].message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map(part => (typeof part === 'object' && part !== null && typeof part.text === 'string') ? part.text : '')
      .filter(t => t !== '')
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

/** 错误信息脱敏：把 API key 从任何文本里替换成 ***。 */
function redactText(text, apiKey) {
  const s = String(text == null ? '' : text)
  return (apiKey && s.includes(apiKey)) ? s.replaceAll(apiKey, '***') : s
}

// ---------- MIME 识别 ----------

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
}

function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x67) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  // HEIC/HEIF: 4..8 字节为 ftyp，后随品牌 heic/heix/hevc/hevx/mif1/msf1
  if (b.length >= 12 &&
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase()
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  return undefined
}

function mimeOf(name, bytes) {
  const parts = String(name).toLowerCase().split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1] : ''
  return sniffMime(bytes) || MIME_BY_EXT[ext] || 'image/png'
}

// ---------- VLM 调用（可注入 fetch，便于测试） ----------

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'qwen3-vl-flash'
const KEY_REFS = ['QWEN_VL_API_KEY', 'VISION_API_KEY', 'DSH_VISION_API_KEY', 'ZHIPUAI_API_KEY', 'DASHSCOPE_API_KEY']
const MAX_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 180000
const DEFAULT_QUESTION = '请详细描述这张图片的内容，包括其中的文字（逐字转录）和整体布局。'

/**
 * 把 source 解析为端点可接受的 image URL：http(s)/data: 直通，本地文件 base64 内联。
 * @throws 扩展名不支持 / 文件不存在 / 超限
 */
async function toImageUrl(source, maxImageBytes = MAX_BYTES) {
  if (/^(https?|data):/i.test(source)) return source
  const p = source.replace(/^file:\/\//i, '')
  const st = await fs.stat(p).catch(() => { throw new Error('文件不存在：' + p) })
  if (!st.isFile()) throw new Error('不是文件：' + p)
  if (st.size > maxImageBytes) {
    throw new Error('图片超过 ' + Math.round(maxImageBytes / 1024 / 1024) + 'MB 上限，无法发送给视觉模型。')
  }
  const bytes = await fs.readFile(p)
  return 'data:' + mimeOf(p, bytes) + ';base64,' + Buffer.from(bytes).toString('base64')
}

/**
 * 一次 VLM 问答。任何错误消息都已脱敏（apiKey → ***）。
 * @returns {Promise<string>} 视觉模型回答文本
 */
async function visionChat({ baseUrl, model, apiKey, source, question, maxTokens = 2048, timeoutMs = REQUEST_TIMEOUT_MS, maxImageBytes = MAX_BYTES, fetchImpl = fetch, signal }) {
  const redact = (t) => redactText(t, apiKey)
  const imageUrl = await toImageUrl(source, maxImageBytes)
  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: question },
      ],
    }],
    max_tokens: maxTokens,
  }
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const resp = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.any(signals),
  })
  const status = resp.status
  const body = await resp.text()
  let parsed
  try { parsed = JSON.parse(body) } catch (e) { parsed = undefined }

  if (status >= 400) {
    const msg = parsed && parsed.error && (parsed.error.message || parsed.error.code)
    let hint = ''
    if (status === 401) {
      hint = '（API Key 被拒绝：请检查 QWEN_VL_API_KEY 是否正确、是否属于当前端点；非百炼官方端点可用 QWEN_VL_BASE_URL 覆盖）'
    } else if (status === 404) {
      hint = '（端点或模型不存在：可用 QWEN_VL_BASE_URL / QWEN_VL_MODEL 覆盖）'
    }
    const err = new Error('视觉模型 API 返回 HTTP ' + status + (msg ? '：' + redact(msg) : '') + hint)
    err.visionStatus = status
    throw err
  }
  const text = extractText(parsed)
  if (!text) {
    const err = new Error('视觉模型返回了无法解析的响应：' + redact(body.slice(0, 500) || '(空)'))
    err.visionStatus = 0
    throw err
  }
  const stripped = stripThink(text)
  if (!stripped) {
    const err = new Error('视觉模型返回了空内容。')
    err.visionStatus = 0
    throw err
  }
  return stripped
}

/** 哪些错误值得降级换模型重试：限流(429)、服务端错误(5xx)、超时/中断、网络错误(TypeError)。 */
function isRetryable(e) {
  if (e && e.visionStatus) return e.visionStatus === 429 || e.visionStatus >= 500
  const name = e && e.name
  return name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError'
}

/**
 * 带降级链的 VLM 问答：依次尝试 models 列表，可重试错误（429/5xx/超时/网络）
 * 自动切下一个模型；401/404 等配置类错误立即抛出不降级。
 * @returns {Promise<{text: string, model: string}>}
 */
async function visionChatWithFallback({ models, ...rest }) {
  let lastError
  for (let i = 0; i < models.length; i++) {
    try {
      const text = await visionChat(Object.assign({}, rest, { model: models[i] }))
      return { text, model: models[i] }
    } catch (e) {
      lastError = e
      if (!isRetryable(e) || i === models.length - 1) throw e
    }
  }
  throw lastError // 不可达（列表至少 1 个），防御
}

module.exports = {
  dshHome, attachmentsRootOf, attachmentPath, rewriteMessages,
  stripThink, extractText, redactText, mimeOf, toImageUrl, visionChat,
  visionChatWithFallback, isRetryable,
  DEFAULT_BASE, DEFAULT_MODEL, DEFAULT_QUESTION, KEY_REFS, MAX_BYTES, REQUEST_TIMEOUT_MS,
}
