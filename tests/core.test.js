'use strict'
// dsh-attachment-vision 核心逻辑单测。零依赖：node --test tests/
// 运行: node --test tests/

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  attachmentPath, rewriteMessages, stripThink, extractText,
  redactText, mimeOf, toImageUrl, visionChat,
  DEFAULT_QUESTION,
} = require('../lib/core')

const HEX64 = 'a'.repeat(64)
const JOIN = path.join // Windows 下是反斜杠，期望值统一用 path.join 构造

// ---------- attachmentPath ----------

test('attachmentPath: sha256 id → objects/<前2>/<64hex>（无前缀、无扩展名）', () => {
  assert.equal(attachmentPath('/root/.dsh/attachments/v1', 'sha256:' + HEX64),
    path.join('/root/.dsh/attachments/v1', 'objects', 'aa', HEX64))
})

test('attachmentPath: 非法 id 返回 undefined', () => {
  assert.equal(attachmentPath('/x', undefined), undefined)
  assert.equal(attachmentPath('/x', 'sha256:short'), undefined)
  assert.equal(attachmentPath('/x', 'md5:' + HEX64), undefined)
  assert.equal(attachmentPath('/x', 'sha256:' + 'Z'.repeat(64)), undefined) // 非 hex
})

// ---------- rewriteMessages ----------

function imageBlock(attachmentId) {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType: 'image/png', width: 100, height: 50 },
  }
}

test('rewriteMessages: image 块改写为路径文本，其余保留', () => {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: '看图' }, imageBlock('sha256:' + HEX64)],
  }]
  const { changed, rewritten } = rewriteMessages(messages, '/att')
  assert.equal(changed, true)
  const blocks = rewritten[0].content
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'text')
  assert.ok(blocks[1].text.includes(path.join('att', 'objects', 'aa', HEX64)))
  assert.ok(blocks[1].text.includes('image/png'))
  assert.ok(blocks[1].text.includes('100x50'))
  assert.ok(blocks[1].text.includes('view_image'))
})

test('rewriteMessages: 原消息不被修改（深冻结不变式）', () => {
  const messages = [{ role: 'user', content: [imageBlock('sha256:' + HEX64)] }]
  rewriteMessages(messages, '/att')
  assert.equal(messages[0].content[0].type, 'image') // 原对象仍是 image
})

test('rewriteMessages: 无图片 → changed=false，数组元素引用不变', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const { changed, rewritten } = rewriteMessages(messages, '/att')
  assert.equal(changed, false)
  assert.equal(rewritten, messages)
})

test('rewriteMessages: 非法 attachmentId 的 image 块原样保留', () => {
  const messages = [{ role: 'user', content: [imageBlock('nope')] }]
  const { changed, rewritten } = rewriteMessages(messages, '/att')
  assert.equal(changed, false)
  assert.equal(rewritten[0].content[0].type, 'image')
})

test('rewriteMessages: content 非数组（字符串）原样通过', () => {
  const messages = [{ role: 'user', content: 'plain text' }]
  const { changed, rewritten } = rewriteMessages(messages, '/att')
  assert.equal(changed, false)
  assert.equal(rewritten, messages)
})

// ---------- stripThink ----------

test('stripThink: 剥离推理块', () => {
  assert.equal(stripThink('a<think>secret</think>b'), 'ab')
  assert.equal(stripThink('<think>x</think>\n\nvisible'), 'visible')
  assert.equal(stripThink('no think here'), 'no think here')
  assert.equal(stripThink(null), '')
})

// ---------- extractText ----------

test('extractText: 字符串 content', () => {
  assert.equal(extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi')
})

test('extractText: parts 数组 content 拼接', () => {
  const payload = { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }, { foo: 1 }] } }] }
  assert.equal(extractText(payload), 'a\nb')
})

test('extractText: 空/畸形返回 undefined', () => {
  assert.equal(extractText(undefined), undefined)
  assert.equal(extractText({}), undefined)
  assert.equal(extractText({ choices: [] }), undefined)
  assert.equal(extractText({ choices: [{ message: {} }] }), undefined)
  assert.equal(extractText({ choices: [{ message: { content: [] } }] }), undefined)
})

// ---------- redactText ----------

test('redactText: API Key 从错误信息中抹除', () => {
  assert.equal(redactText('401: bad key sk-abc123xyz', 'sk-abc123xyz'), '401: bad key ***')
  assert.equal(redactText('no key here', 'sk-abc'), 'no key here')
  assert.equal(redactText('key undefined', undefined), 'key undefined')
})

// ---------- mimeOf ----------

test('mimeOf: magic bytes 优先于扩展名', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  assert.equal(mimeOf('x.bin', png), 'image/png')
})

test('mimeOf: 扩展名兜底 + tif/tiff/heic 支持', () => {
  assert.equal(mimeOf('a.tif', Buffer.from([0, 0])), 'image/tiff')
  assert.equal(mimeOf('a.heic', Buffer.from([0, 0])), 'image/heic')
  // HEIC magic: ftyp + heic 品牌
  const heic = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
  assert.equal(mimeOf('noext', heic), 'image/heic')
})

test('mimeOf: 未知类型默认 image/png', () => {
  assert.equal(mimeOf('x.xyz', Buffer.from([0, 0])), 'image/png')
})

// ---------- toImageUrl ----------

test('toImageUrl: http(s)/data URL 直通', async () => {
  assert.equal(await toImageUrl('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(await toImageUrl('data:image/png;base64,AA=='), 'data:image/png;base64,AA==')
})

test('toImageUrl: 本地文件 base64 内联（含 file:// 前缀）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dav-'))
  const f = path.join(dir, 't.png')
  fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  const url = await toImageUrl('file://' + f)
  assert.ok(url.startsWith('data:image/png;base64,'))
  const url2 = await toImageUrl(f)
  assert.ok(url2.startsWith('data:image/png;base64,'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('toImageUrl: 文件不存在/超限抛错', async () => {
  await assert.rejects(() => toImageUrl('/nonexistent/xx.png'), /文件不存在/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dav-'))
  const big = path.join(dir, 'big.png')
  fs.writeFileSync(big, Buffer.alloc(64))
  await assert.rejects(() => toImageUrl(big, 32), /上限/)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- visionChat（注入 fetch） ----------

test('visionChat: 注入 fetch 全链路（含脱敏）', async () => {
  const seen = []
  const fakeFetch = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization })
    return {
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'bad key sk-secret123' } }),
    }
  }
  await assert.rejects(
    () => visionChat({
      baseUrl: 'https://vlm.test/v1/', model: 'm', apiKey: 'sk-secret123',
      source: 'https://example.com/i.png', question: 'q',
      fetchImpl: fakeFetch,
    }),
    (e) => {
      // visionChat 内部已脱敏：错误消息含 *** 且不含原始 key
      assert.ok(!String(e.message).includes('sk-secret123'))
      assert.ok(String(e.message).includes('***'))
      return true
    }
  )
  assert.equal(seen[0].url, 'https://vlm.test/v1/chat/completions')
  assert.equal(seen[0].auth, 'Bearer sk-secret123')
})

test('visionChat: 成功响应（parts 数组 content）', async () => {
  const fakeFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: [{ text: '描述<think>推理</think>' }, { text: '结果' }] } }],
    }),
  })
  const text = await visionChat({
    baseUrl: 'https://vlm.test', model: 'm', apiKey: 'k',
    source: 'https://example.com/i.png', question: 'q',
    fetchImpl: fakeFetch,
  })
  assert.equal(text, '描述\n结果')
})

test('visionChat: 默认问题文本存在', () => {
  assert.ok(DEFAULT_QUESTION.includes('描述'))
})
