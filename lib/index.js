'use strict'
// dsh-attachment-vision —— 给纯文本 DeepSeek 模型加上"看图"能力（附件直发 + 自动转写 + view_image 桥接）。
// 本文件是 Cordis 接线层（插件入口），纯逻辑在 lib/core.js（可单测）。
// 能力：
//   1) deepseek-official 模态声明放行（Web 附件上传检查通过）
//   2) llm/stream 水瀑：消息中的图片块改写为「附件本地路径」文本（veto 重入，不触碰深冻结消息），
//      模型下一轮用 view_image 读图（deepseek API 本身不收图）
//   3) view_image 工具：本地图片/URL → OpenAI 兼容视觉模型（默认 qwen3-vl-flash）→ 文本描述
// 零 npm 依赖：仅 Node 内置模块与全局 fetch。
//
// 配置（~/.dsh/.env 或 .credentials.yaml）：
//   QWEN_VL_API_KEY（或 VISION_API_KEY / DSH_VISION_API_KEY / ZHIPUAI_API_KEY / DASHSCOPE_API_KEY）—— 必填
//   QWEN_VL_BASE_URL（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
//   QWEN_VL_MODEL（默认 qwen3-vl-flash）
//   环境变量 DSH_ATTACHMENT_VISION_DEBUG=1 可开启调试日志（/tmp/dsh-attachment-vision.log）
//
// ⚠️ 已知架构性依赖（README 有详述）：
//   - 依赖 dsh-attachment-local 的存储规则 attachmentId="sha256:<64hex>" → objects/<前2hex>/<64hex>
//   - 依赖 dsh-llm 的 llm/stream waterfall veto 语义（rc.6），dsh 升级需回归

const fsSync = require('node:fs')
const core = require('./core')

const DEBUG = process.env.DSH_ATTACHMENT_VISION_DEBUG === '1'
const MARK_FILE = '/tmp/dsh-attachment-vision.log'
function mark(step, detail) {
  if (!DEBUG) return
  try {
    fsSync.appendFileSync(MARK_FILE, new Date().toISOString() + ' [' + step + '] ' + String(detail || '') + '\n')
  } catch (e) { /* ignore */ }
}

async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  if (!credentials) return undefined
  for (const ref of core.KEY_REFS) {
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
    const attachmentsRoot = core.attachmentsRootOf(core.dshHome())
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
        const { changed, rewritten } = core.rewriteMessages(options.messages, attachmentsRoot)
        if (changed) {
          const newOptions = Object.assign({}, options, {
            messages: rewritten,
            __dshVisionRewritten: true,
          })
          // veto：不调 next()，改写后的请求重新进入 llm/stream 链
          return ctx.llm.stream(newOptions)
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
          '必须通过本工具把图片发给视觉模型（默认 qwen3-vl-flash，可用 QWEN_VL_MODEL 覆盖）换取文字描述。本地图片支持 png/jpg/jpeg/webp/gif/bmp/tif/tiff/heic，单张不超过 10MB。',
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
          const question = (args.question && String(args.question).trim()) || core.DEFAULT_QUESTION
          if (!source) return { text: '错误：缺少 source 参数（图片路径或 URL）。' }
          let apiKey
          let models = [core.DEFAULT_MODEL]
          try {
            const baseUrl = (await configValue(ctx, 'QWEN_VL_BASE_URL', core.DEFAULT_BASE)).replace(/\/+$/, '')
            const primaryModel = await configValue(ctx, 'QWEN_VL_MODEL', core.DEFAULT_MODEL)
            // 降级链：QWEN_VL_FALLBACK_MODELS="m1,m2" 逗号分隔；主模型限流/5xx/超时/网络错误时依次尝试
            const fallbackRaw = await configValue(ctx, 'QWEN_VL_FALLBACK_MODELS', '')
            const fallback = String(fallbackRaw || '').split(',').map(s => s.trim()).filter(Boolean)
            models = [primaryModel].concat(fallback)
            apiKey = await resolveApiKey(ctx)
            if (!apiKey) {
              return { text: '错误：未配置视觉模型 API Key。请在 ~/.dsh/.env 中设置 QWEN_VL_API_KEY=sk-xxx（或 VISION_API_KEY / DSH_VISION_API_KEY / ZHIPUAI_API_KEY / DASHSCOPE_API_KEY）后重试。' }
            }
            const { text, model } = await core.visionChatWithFallback({
              baseUrl, models, apiKey, source, question,
              signal: exec && exec.signal,
            })
            if (model !== primaryModel) {
              return { text: text + '\n（注：主模型 ' + primaryModel + ' 不可用，本次由降级模型 ' + model + ' 完成识别）' }
            }
            return { text }
          } catch (e) {
            const name = e && e.name
            if (name === 'TimeoutError' || name === 'AbortError') {
              return { text: '错误：视觉模型调用超时或中断（' + Math.round(core.REQUEST_TIMEOUT_MS / 1000) + 's）。' }
            }
            // 脱敏兜底：任何错误消息里都不允许出现 API Key
            const tried = models ? models.length : 1
            const safe = core.redactText((e && e.message) || e, apiKey)
            return { text: '错误：视觉模型调用失败（已尝试 ' + tried + ' 个模型）：' + safe }
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
