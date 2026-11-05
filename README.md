# API Show

Windows 桌面工具：只输入中转站点的地址和凭据，就能拿到每条调用记录的**缓存命中率**和**实际 token 构成**，并把多个站点、多个分组放在一张表里横向对比。

做这个工具的起因是：不少 [sub2api](https://github.com/Wei-Shaw/sub2api) / new-api 站点的用量页只给你 `总 tokens`，不给缓存率，或者给的口径和你以为的不一样。而它们的用户态接口 `/api/v1/usage` 其实已经把四个字段都返回了——工具做的就是把口径统一，然后算给你看。

## 缓存率的口径

分母必须带上**缓存写入**，否则写入密集的时段会显得命中率虚高：

```
cacheRate = cache_read / (uncached_input + cache_creation + cache_read)
```

两个站点的字段口径不同，适配器在归一化时就换算掉，所以 `inputTokens` 在本工具里恒等于「未命中缓存的输入」：

| 站点 | 原始字段 | 处理 |
| --- | --- | --- |
| sub2api | `input / cache_creation / cache_read / output` 四件套 | `input` 本来就不含缓存，直接相加得总量 |
| new-api | `prompt_tokens` + `other.cache_tokens` | OpenAI 系的 `prompt_tokens` **已含**缓存，够减就减，不够减（Anthropic 系）就原样当未命中输入 |

## 功能

- **多站点档案**：保存多个站点，单站查看或跨站合并汇总，各自记住自己的登录态
- **明细表 + 汇总卡片**：请求数、输入/输出/缓存写/缓存读、总 token、缓存率、余额
- **异常高亮**：黄=可疑，红=明显偏离，只给越界的那个数字上色
- **横向对比**：任意 `(站点, 分组)` 组合并列对比，参考车评那种一列一车型、逐行标最优
- **免登录进面板**：用已拿到的 JWT 直接把站点官方后台开在应用内窗口，跳过登录页
- **暗色模式**、侧栏折叠、列可配置、自动刷新、每页条数自定义

## 取到凭据的三种方式

面板接口只认登录态 JWT，`sk-` 开头的 API key 读不到别人的用量记录，所以必须先拿到面板 token。

| 方式 | 说明 | 什么时候用 |
| --- | --- | --- |
| 邮箱/密码 | 直接调各站的登录接口（sub2api `/api/v1/auth/login`，带 2FA 走 `/auth/login/2fa`；new-api `/api/user/login`） | 站点没上人机验证 |
| 内置浏览器 | 打开真实登录页，你手动过完验证，主进程从请求头里截获 JWT | 站点挂了 Cloudflare Turnstile，纯 HTTP 登录必然失败 |
| 粘贴 JWT | 你从浏览器 DevTools 里复制面板 token | 前两种都不顺手时的兜底 |

后两种最终都落到同一份 JWT 上，所以下次打开不用再来一遍。

## 异常判定

判定挂在 `站点 + 模型 + 分组` 的桶里，拿组内**中位数**做基线——不同模型、不同分组的倍率本来就没法比。

- **缓存率**：比组内中位数低 15 个百分点 → 黄，低 40 个百分点 → 红。偏高是好事，不标。
- **输出吞吐**：比组内中位数慢 1.8 倍 → 黄，慢 2.8 倍 → 红。

耗时这里用的是 **TPS（输出 token / 秒）**而不是总耗时。原始耗时跟输出量线性相关，拿输出 3500 token 的记录去和输出 200 的比谁慢，比的其实是谁活儿多。同理，跨站也不比「区间总花费」，比的是折算到每百万 token 的有效单价。

两条刻意的限制：同组样本不足 5 条不判定（界面会说明「样本不足」，免得你把「没标色」读成「没异常」）；输出少于 300 token 的请求不计入 TPS，因为首字耗时会主导整个比值，46 token 算出 11 tok/s 只是分母小。

## 对比维度

11 行指标里只有 4 行参与「谁更优」的判定，其余仅陈述——因为成本、请求数这种东西，大不等于差。

| 指标 | 方向 | 参与判定 |
| --- | --- | --- |
| 缓存命中率 | 越高越好 | 是 |
| 有效单价（$/M token） | 越低越好 | 是 |
| 输出吞吐（中位 tok/s） | 越高越好 | 是 |
| 首字耗时（中位） | 越低越好 | 是 |
| 样本请求数 / 总 token / 未命中输入占比 / 每请求成本 / 每请求 token / 区间总花费 | — | 否 |

综合结论只数「哪一列在更多行拿到最优」，不做加权总分。每个人更在意价钱还是速度，加权分是在替你做假设。并列最优不额外扣分，取不到数据（`null`）的行既不判最优也不判最差，否则一个换算不出美元的站点会因为「没有值」而输掉整行。

## 免登录面板的安全边界

面板窗口加载的是第三方站点，所以它**不挂本应用的 preload**——否则等于把 `apiShow` 的 IPC 桥交给外部页面。另外：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，导航限制在该站点自己的域名内，站外的链接一律交给系统浏览器。登录态只写进独立的 `persist:panel` 分区。

## 数据存在哪

站点档案和偏好都在 Electron 的 `userData` 目录（Windows 下打包后是 `%APPDATA%\API Show\`，`pnpm dev` 时是 `%APPDATA%\api-show\`）：

- `sites.json` — 站点档案，其中密码是 `safeStorage`（Windows DPAPI）加密后的 base64，本机该系统不支持加密时干脆不存
- `prefs.json` — 侧栏状态、隐藏列、主题

密文和 JWT 只留在主进程。渲染层拿到的 `SiteProfile` 里只有 `hasPassword` / `hasJwt` 两个布尔值，凭据不跨 IPC 回流。这些文件都不在仓库里，`.gitignore` 也排掉了 `out/`、`dist/`、`node_modules/`。

## 开发

需要 Node 20+ 和 pnpm。`.npmrc` 里配了 npmmirror 的 Electron 镜像，国内网络下装 `electron` 和 `electron-builder` 的二进制会快很多；如果你在海外的干净环境，删掉那两行即可。

```bash
pnpm install
pnpm dev          # electron-vite 开发模式，热更新
pnpm typecheck    # tsc + vue-tsc，分别查主进程和渲染层
pnpm build        # 只编译到 out/，不打包
pnpm dist         # 打包 Windows portable exe + NSIS 安装器，产物在 dist/
pnpm dist:portable # 只打便携版
```

装完依赖如果 `node_modules/electron/dist/` 是空的（pnpm 默认拦了 postinstall），补一句 `node node_modules/electron/install.js`。

## 目录

```
src/shared/     contracts.ts —— 跨进程唯一的事实来源（类型、筛选、偏好、IPC 结果）
src/main/       index.ts 生命周期与 IPC · service.ts 多站点编排 · store.ts 加密存储
                http.ts 请求层 · capture.ts 浏览器截获令牌 · compare.ts 采样聚合 · panel.ts 内嵌面板
src/main/adapters/  types.ts 共用口径 · sub2api.ts · newapi.ts · index.ts 站点类型探测
src/preload/    暴露给渲染层的窄接口
src/renderer/   Vue 3 界面 · lib/ 是纯函数（anomaly 判定、compare 评分、format、rows、columns）
```

`lib/` 刻意不依赖组件，异常判定和对比评分都是纯函数，方便直接喂数据验证。

## 已知限制

- **汇总只覆盖当前页**：明细表顶部的卡片是从当前页的记录累加出来的，不是服务端全量统计。要看全量请用「对比」，它会按时间范围连续翻页采样。
- **对比有采样上限**（默认 4000 条/列），触到上限时该列会明确标出「已截断」。
- **`cache_creation` 为 0 不一定是 bug**：OpenAI 系上游没有 Anthropic 那种显式缓存写入计费，sub2api 在这个场景下就会返回 0。
- **new-api 的成本可能换算不出美元**：拿不到站点的 `quota_per_unit` 时，`costUsd` 留 `null`，该站的成本列不参与跨站对比——而不是把 quota 当美元混着算。
- **只实测过 Windows**：`pnpm dist` 目前只配了 win 目标（portable + nsis，x64）。
