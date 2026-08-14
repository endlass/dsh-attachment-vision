'use strict'
// dsh-attachment-vision —— 给纯文本 DeepSeek 模型加上"看图"能力（附件直发 + 自动转写 + view_image 桥接）。
// 能力：
//   1) deepseek-official 模态声明放行（Web 附件上传检查通过）
//   2) llm/stream 水瀑：消息中的图片块改写为「附件本地路径」文本（veto 重入，不触碰深冻结消息），
//      模型下一轮用 view_image 读图（deepseek API 本身不收图）
//   3) view_image 工具：本地图片/URL → OpenAI 兼容视觉模型（默认 qwen3-vl-flash）→ 文本描述
// 零依赖：单文件 CommonJS，仅用 Node 内置模块与全局 fetch。
//
// 配置（~/.dsh/.env 或 .credentials.yaml）：
//   QWEN_VL_API_KEY（或 VISION_API_KEY / DASHSCOPE_API_KEY）—— 必填
//   QWEN_VL_BASE_URL（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
//   QWEN_VL_MODEL（默认 qwen3-vl-flash）
//   环境变量 DSH_ATTACHMENT_VISION_DEBUG=1 可开启调试日志（/tmp/dsh-attachment-vision.log）
//
// ⚠️ 已知架构性依赖（README 有详述）：
//   - 依赖 dsh-attachment-local 的存储规则 attachmentId="sha256:<64hex>" → objects/<前2hex>/<64hex>
//   - 依赖 dsh-llm 的 llm/stream waterfall veto 语义（rc.6），dsh 升级需回归

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEBUG = process.env.DSH_ATTACHMENT_VISION_DEBUG === '1'
const MARK_FILE = '/tmp/dsh-attachment-vision.log'
function mark(step, detail) {
  if (!DEBUG) return
  try {
    fsSync.appendFileSync(MARK_FILE, new Date().toISOString() + ' [' + step + '] ' + String(detail || '') + '\n')
  } catch (e) { /* ignore */ }
}

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'qwen3-vl-flash'
const KEY_REFS = ['QWEN_VL_API_KEY', 'VISION_API_KEY', 'DASHSCOPE_API_KEY']
const MAX_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 180000

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon',
}

function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return undefined
}

function mimeOf(name, bytes) {
  const parts = String(name).toLowerCase().split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1] : ''
  return sniffMime(bytes) || MIME_BY_EXT[ext] || 'image/png'
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function stripThink(text) {
  const s = String(text == null ? '' : text)
  const stripped = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return stripped || s.trim()
}

async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  if (!credentials) return undefined
  for (const ref of KEY_REFS) {
    try {
      const r = await credentials.resolve(ref)
      if (r && r.value) return r.value
    } catch (e) { /* keep looking */ }
  }
  return undefined
}

async function configValue(ctx, name, fallback) {
  const credentials = ctx.get('credentials')
  if (!credentials) return fallback
  try {
    const r = await credentials.resolve(name)
    return (r && r.value) || fallback
  } catch (e) {
    return fallback
  }
}

module.exports = {
  // 2026-08-14 修复：view_image 工具注册需 tools；veto 重入 llm.stream() 需 llm
  inject: ['tools', 'llm'],
  apply(ctx) {
    mark('apply-start', 'pid=' + process.pid)
    const attachmentsRoot = path.join(dshHome(), 'attachments', 'v1')
    try {

    // ---------- 1) 模态声明放行（可逆） ----------
    ctx.effect(() => {
      try {
        const llm = ctx.get('llm')
        const reg = llm && llm.adapters && typeof llm.adapters.get === 'function'
          ? llm.adapters.get('deepseek-official') : undefined
        if (!reg || !reg.adapter || typeof reg.adapter.resolveModel !== 'function' ||
            reg.adapter.__dshVisionModalityPatched) return () => {}
        const orig = reg.adapter.resolveModel.bind(reg.adapter)
        reg.adapter.resolveModel = async (provider, model, signal) => {
          const info = await orig(provider, model, signal)
          if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
            return Object.assign({}, info, { inputModalities: info.inputModalities.concat('image') })
          }
          return info
        }
        reg.adapter.__dshVisionModalityPatched = true
        mark('patch-done')
        console.log('[dsh-attachment-vision] deepseek resolveModel patched: inputModalities +image')
        return () => {
          try {
            if (reg.adapter.__dshVisionModalityPatched) {
              reg.adapter.resolveModel = orig
              delete reg.adapter.__dshVisionModalityPatched
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.error('[dsh-attachment-vision] modality patch failed:', e)
        return () => {}
      }
    })

    // ---------- 2) llm/stream 水瀑：图片块 → 附件路径文本 ----------
    // ⚠️ 2026-08-14 修复：dsh 的 llm/stream options.messages 是深冻结对象
    // （dsh-llm deep-freeze 不变式），原地赋值会抛
    // "Cannot assign to read only property 'messages'"。
    // 改为 waterfall veto：浅拷贝新请求（改写后的 messages + 重入标记），
    // 重新进入 ctx.llm.stream()；第二层看到标记直接放行到 adapter。
    ctx.on('llm/stream', (options, next) => {
      try {
        if (!options || options.__dshVisionRewritten) return next()
        const messages = options.messages
        if (Array.isArray(messages)) {
          let changed = false
          const rewritten = []
          for (const msg of messages) {
            const content = msg && msg.content
            if (!Array.isArray(content)) { rewritten.push(msg); continue }
            const blocks = []
            for (const block of content) {
              if (!block || block.type !== 'image') { blocks.push(block); continue }
              const att = block.attachment
              const ref = att && typeof att.attachmentId === 'string' ? att.attachmentId : undefined
              // dsh 附件存储规则（dsh-attachment-local）：
              // attachmentId = "sha256:<64hex>" → objects/<前2hex>/<64hex>（无扩展名原始字节）
              const m = ref && /^sha256:([a-f0-9]{64})$/.exec(ref)
              if (!m) { blocks.push(block); continue }
              const hex = m[1]
              changed = true
              blocks.push({
                type: 'text',
                text: '[用户发送了一张图片（' + (att.mediaType || 'image') + '，' +
                  (att.width || '?') + 'x' + (att.height || '?') + '）。图片本体未随本消息发送，其本地文件在：' +
                  attachmentsRoot + '/objects/' + hex.slice(0, 2) + '/' + hex +
                  '（原始字节文件，无扩展名）。你是纯文本模型看不到图片，请调用 view_image 工具查看该路径来理解图片内容。]',
              })
            }
            rewritten.push(Object.assign({}, msg, { content: blocks }))
          }
          if (changed) {
            const newOptions = Object.assign({}, options, {
              messages: rewritten,
              __dshVisionRewritten: true,
            })
            // veto：不调 next()，改写后的请求重新进入 llm/stream 链
            return ctx.llm.stream(newOptions)
          }
        }
      } catch (e) {
        console.error('[dsh-attachment-vision] llm/stream hook error:', e)
      }
      return next()
    })
    mark('hook-done')

    // ---------- 3) view_image 工具 ----------
    try {
      const tool = {
        name: 'view_image',
        description: '查看并理解一张图片（本地文件路径、file:// URL 或公网 http(s) URL）：截图、报错界面、图表、UI 布局、照片等。' +
          '当用户要求“看/查看/描述/识别/检查”某张图片或图片里的内容时使用。你本身是纯文本模型，无法直接看到图片，' +
          '必须通过本工具把图片发给视觉模型（默认 qwen3-vl-flash，可用 QWEN_VL_MODEL 覆盖）换取文字描述。本地图片支持 png/jpg/jpeg/webp/gif/bmp，单张不超过 10MB。',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: '图片来源：本地文件路径（如 ~/Desktop/screenshot.png）、file:// URL，或公网 http(s) 图片 URL（直接透传给视觉模型）。',
            },
            question: {
              type: 'string',
              description: '针对图片的具体问题（可选），例如“这个报错的完整文本是什么？”“图表里各产品的销售额是多少？”。缺省为详细描述图片内容。',
            },
          },
          required: ['source'],
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
        },
        async execute(args, exec) {
          const source = String(args.source == null ? '' : args.source).trim()
          const question = (args.question && String(args.question).trim()) ||
            '请详细描述这张图片的内容，包括其中的文字（逐字转录）和整体布局。'
          if (!source) return { text: '错误：缺少 source 参数（图片路径或 URL）。' }
          try {
            const baseUrl = (await configValue(ctx, 'QWEN_VL_BASE_URL', DEFAULT_BASE)).replace(/\/+$/, '')
            const model = await configValue(ctx, 'QWEN_VL_MODEL', DEFAULT_MODEL)

            let imageUrl
            if (/^https?:\/\//i.test(source)) {
              imageUrl = source
            } else {
              const p = source.replace(/^file:\/\//i, '')
              let bytes
              try {
                const st = await fs.stat(p)
                if (!st.isFile()) return { text: '错误：不是文件：' + p }
                if (st.size > MAX_BYTES) return { text: '错误：图片超过 10MB 上限，无法发送给视觉模型。' }
                bytes = await fs.readFile(p)
              } catch (e) {
                return { text: '错误：无法读取图片 ' + p + '：' + String((e && e.message) || e) }
              }
              imageUrl = 'data:' + mimeOf(p, bytes) + ';base64,' + Buffer.from(bytes).toString('base64')
            }

            const key = await resolveApiKey(ctx)
            if (!key) {
              return { text: '错误：未配置视觉模型 API Key。请在 ~/.dsh/.env 中设置 QWEN_VL_API_KEY=sk-xxx（或 VISION_API_KEY / DASHSCOPE_API_KEY）后重试。' }
            }

            const payload = {
              model,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageUrl } },
                  { type: 'text', text: question },
                ],
              }],
              max_tokens: 2048,
            }

            const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
            if (exec && exec.signal) signals.push(exec.signal)
            const resp = await fetch(baseUrl + '/chat/completions', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + key,
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
              return { text: '错误：视觉模型 API 返回 HTTP ' + status + (msg ? '：' + msg : '') + hint + '。' }
            }
            if (!parsed || !parsed.choices || !parsed.choices.length) {
              return { text: '错误：视觉模型返回了无法解析的响应：' + (body.slice(0, 500) || '(空)') }
            }
            const content = parsed.choices[0].message && parsed.choices[0].message.content
            const text = stripThink(content)
            if (!text) return { text: '错误：视觉模型返回了空内容。' }
            return { text }
          } catch (e) {
            const name = e && e.name
            if (name === 'TimeoutError' || name === 'AbortError') {
              return { text: '错误：视觉模型调用超时或中断（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + 's）。' }
            }
            return { text: '错误：视觉模型调用失败：' + String((e && e.message) || e) }
          }
        },
      }
      ctx.effect(() => ctx.tools.register(tool))
      mark('tool-done')
    } catch (e) {
      mark('tool-error', (e && e.stack) || String(e))
      console.error('[dsh-attachment-vision] tool registration failed:', e)
    }

      mark('apply-end', 'attachments=' + attachmentsRoot)
      console.log('[dsh-attachment-vision] static vision plugin active; attachments=' + attachmentsRoot)
    } catch (e) {
      mark('apply-error', (e && e.stack) || String(e))
      console.error('[dsh-attachment-vision] apply failed:', e)
    }
  },
}
