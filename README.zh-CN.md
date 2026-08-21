<div align="center">

[![English](https://img.shields.io/badge/Language-English-blue.svg)](README.md)
[![简体中文](https://img.shields.io/badge/Language-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

</div>

# dsh-attachment-vision

> **⚠️ 已退役（2026-08-21）** — 被 DSH 0.1.1 官方原生多模态支持取代
> （`deepseek-v4-flash-vision-exp` + `ctx.attachments` AttachmentStore）。官方管道用原生
> 图片输入覆盖了本插件的核心场景（给纯文本模型装眼睛）。插件现归档为**管道层资产**
> （可换任意 VLM + qwen3-vl-plus 用于细粒度 OCR/地理定位），不再维护。本项目沉淀的
> 架构教训（Agent Note `2026-08-21-official-attachment-vs-plugin.md`）：用
> `ctx.attachments.readImage(ref)` 而非从 AttachmentId 推导文件路径；绝不向模型暴露
> 宿主机路径；遵守限额/准入治理（像素上限、媒体类型白名单、批量原子保存）。

[![Awesome DSH Plugin](https://img.shields.io/badge/awesome--DSH--plugin-listed-blueviolet)](https://github.com/Alex-Yanggg/awesome-DSH-plugin)

给纯文本 DeepSeek 模型加"眼睛"的 **零依赖、单文件 CommonJS** dsh 插件。

与只提供 `view_image` 工具的同类插件不同，本插件同时解决 **GUI 附件图片**：在 dsh web UI 里直接发图，插件会 patch DeepSeek adapter 的模态声明（让附件上传检查通过），并把图片块自动转写为附件真实路径的文本，模型再调 `view_image` 读图——纯文本模型全链路看图。

## 功能

1. **模态门控放行（可逆）**：patch `deepseek-official` adapter 的 `resolveModel`，声明支持 image 输入
2. **图片块自动转写**：`llm/stream` 水瀑中把图片块改写为「附件真实路径」提示文本；采用 waterfall **veto** 模式——绝不触碰深冻结的原始消息，浅拷贝带重入标记的新请求重新进入 `ctx.llm.stream()`
3. **`view_image` 工具**：本地路径 / `file://` / 公网 http(s) URL → 任意 OpenAI 兼容视觉模型（默认 DashScope `qwen3-vl-flash`）→ 文字描述

## 安装

要求 dsh **>= 0.1.0-rc.6**、Node **>= 20.11**。

```sh
git clone https://github.com/endlass/dsh-attachment-vision ~/dsh-plugins/dsh-attachment-vision

# 一键安装（幂等：复制插件 + 注册 cordis.patch.yml + 检查 API Key）
bash ~/dsh-plugins/dsh-attachment-vision/scripts/install.sh
```

或手动在 `~/.dsh/cordis.patch.yml`（home 共享层）或 profile patch 注册：

```yaml
- insert:
    - id: dsh-attachment-vision
      name: dsh-attachment-vision
```

或（npm 发布后）`dsh plugin --profile demo add dsh-attachment-vision`，然后重启 dsh。

## 配置

经 dsh credentials 服务从 `~/.dsh/.env` / `.credentials.yaml` 解析，按序：`QWEN_VL_API_KEY` → `VISION_API_KEY` → `DSH_VISION_API_KEY`（仅限 export；dsh 0812 起 `.env` 文件内禁止 `DSH_` 前缀变量）→ `ZHIPUAI_API_KEY` → `DASHSCOPE_API_KEY`。

| 变量 | 必填 | 默认 |
|---|---|---|
| 上表任一 key | **是** | — |
| `QWEN_VL_BASE_URL` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_VL_MODEL` | 否 | `qwen3-vl-flash` |
| `QWEN_VL_FALLBACK_MODELS` | 否 | *(空)* |

**降级链**：`QWEN_VL_FALLBACK_MODELS="glm-4.6v-flash,glm-4v-flash"`（逗号分隔）。主模型遇到可重试失败（HTTP 429 / 5xx / 超时 / 网络错误）时自动依次尝试下一个模型，回复会注明由哪个降级模型完成；配置类错误（401 / 404）立即失败不降级。模型名需在同一个 `QWEN_VL_BASE_URL` 端点上有效。

调试日志（写到 `/tmp/dsh-attachment-vision.log`）：`DSH_ATTACHMENT_VISION_DEBUG=1`。

## 工作原理

```
web UI 发图
  → 模态门控放行
  → llm/stream hook 把图片块改写为「附件真实路径」文本
  → 模型调 view_image(路径, 问题)
  → 插件读文件/URL，base64 内联，调用视觉模型
  → 描述文本作为工具结果返回 → 模型作答
```

**附件存储规则**（依赖 `dsh-attachment-local`）：`attachmentId = "sha256:<64hex>"` → 文件在 `~/.dsh/attachments/v1/objects/<前2位hex>/<64hex>`（原始字节，**无扩展名**）。

## 安全与健壮性

- **API Key 脱敏**：所有错误信息在展示给模型前都会把 key 替换为 `***`——不会经 VLM 端点错误、4xx 响应体或异常消息泄露凭据
- **多后端响应兼容**：VLM 返回的 `content` 可能是字符串或 parts 数组，两种都处理
- 本地支持格式：png / jpg / jpeg / webp / gif / bmp / tif / tiff / heic（magic bytes 优先，扩展名兜底）

## 真实实测（2026-08-15，百炼 DashScope）

测试图：dsh UI 横幅真实截图（"探索未至之境 / 预览版" + 鲸鱼 logo，606×126 PNG）。任务：逐字转录 + 布局描述。

| 模型 | 任务 | 延迟 | 结果 |
|---|---|---|---|
| `qwen3-vl-flash`（默认） | 文字转录 | **~1.0s** | ✅ 逐字正确 |
| `qwen3-vl-flash`（默认） | 布局描述 | ~4.0s | ✅ 详细（logo + 标题 + 风格） |
| `qwen3-vl-plus` | 文字转录 | **~0.6s** | ✅ 逐字正确 |
| `qwen3-vl-plus` | 布局描述 | ~7.8s | ✅ 更细（识别出字体族） |

结论：`qwen3-vl-flash` 是最佳默认——转录准确、描述够好，延迟和成本只有 plus 的零头；需要极细视觉细节时再换 `qwen3-vl-plus`（`QWEN_VL_MODEL` 一行切换）。

## ⚠️ 架构性依赖（升级前必读）

- **dsh-attachment-local 存储布局**：若官方改动存储规则，自动转写会失效（`view_image` 对任意路径/URL 仍可用）
- **dsh-llm 深冻结不变式 + rc.6 waterfall veto 语义**：hook 依赖"不调 next() 即拦截、`ctx.llm.stream()` 重入"的机制，dsh 升级需回归
- 单图 10MB 上限（base64 内联）、180s 超时、推理型模型输出自动剥 `<think>`

## 开发

```sh
npm run check         # node --check lib/*
npm test              # node:test 零依赖单测（26 例：改写/路径/MIME/脱敏/VLM/降级链）
bash scripts/verify.sh   # headless 冒烟：临时 DSH_HOME 挂载插件后问 dsh 一个问题
```

代码结构：`lib/index.js` 是 Cordis 接线层；纯逻辑都在 `lib/core.js`（可单测，与 dsh API 零耦合）。

## License

MIT
