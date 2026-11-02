# Blink-web

Blink 的浏览器端上传 / 下载测试台。浏览器内完成 AWS SigV4 签名，经同源透明代理
访问 Blink；代理不持有、不转发、不落盘任何 secret。

## 功能

- 连接：access key / secret / region，`ListBuckets` 验证连通性；secret 只存在内存。
- 桶：列出、创建、删除（非空时展示后端 `409`）。
- 对象浏览：前缀过滤、`delimiter=/` 目录导航、面包屑、分页、HEAD 详情、删除。
- 上传：拖拽或选择多文件；`≤ 8 MiB` 单 PUT，`> 8 MiB` 8 MiB 分片并发；进度、
  速率、取消、失败重试、每请求 SHA-256；取消时中止分片上传。
- 下载：4 MiB Range 顺序读取，`If-Match` 防替换；优先 File System Access 流式
  写盘，不支持时回退内存 Blob（上限 256 MiB）。
- 压测：浏览器面板（快速冒烟）与 Node CLI（权威基线）复用同一套 `BenchmarkRunner`；
  输出 p50 / p95 / p99、吞吐、错误分类、SHA-256 校验和不一致数，可导出 JSON。
- 安全：无默认凭据；secret 不持久化；生产服务器下发 CSP 等安全头；默认只监听
  `127.0.0.1`。公网部署时启用令牌登录（会话 Cookie），非回环监听强制要求令牌。

## 前提

- Node.js 24+（直接运行 `.ts`，依赖类型剥离）。
- 一个可执行的 Blink 后端（默认路径 `../Blink/bin/blink`）。
- 仅 e2e 需要本机 Chrome；可用 `CHROME_PATH` 覆盖。
- 浏览器必须是安全上下文：localhost / 127.0.0.1，或 HTTPS。浏览器签名依赖
  `crypto.subtle`。

## 快速开始

### 1. 启动 Blink

凭据必须显式提供，Blink 没有默认凭据：

```bash
cd ../Blink
make build
BLINK_ACCESS_KEY=<your-access-key> BLINK_SECRET_KEY=<your-secret-key> ./bin/blink
```

默认监听 `127.0.0.1:9000`，数据目录 `./blink-data`。

### 2. 启动前端开发服务器

```bash
cd ../Blink-web
npm ci
BLINK_ENDPOINT=http://127.0.0.1:9000 npm run dev
```

打开 `http://127.0.0.1:5173`，填写与后端一致的 access key / secret。Vite 与生产
服务器共用 `server/proxy.ts`，`/s3/*` 被原样转发到 `BLINK_ENDPOINT`，并保留
浏览器原始 `Host`。

### 3. 生产形态

```bash
npm run build
BLINK_ENDPOINT=http://127.0.0.1:9000 HOST=127.0.0.1 PORT=8080 npm start
```

打开 `http://127.0.0.1:8080`。生产服务器托管 `dist/` 并代理 `/s3`，零运行时依赖。

### 4. 公网访问（Cloudflare 临时隧道 / TLS 反向代理）

公网访问必须同时满足：**HTTPS**（`crypto.subtle` 与 File System Access 只在安全
上下文可用）和**应用层鉴权**。服务端提供令牌门禁，不内置 TLS；TLS 由 Cloudflare
边缘或你自己的反向代理终止。配置令牌后，静态页面与 `/s3` 都要先通过 `/__login`
换取 HttpOnly 会话 Cookie。

```bash
# 1) 生成高熵令牌（至少 32 字符；不要写入仓库或启动脚本）
openssl rand -base64 32

# 2) 启动服务端（监听回环，由隧道暴露）
BLINK_ENDPOINT=http://127.0.0.1:9000 \
BLINK_WEB_TOKEN='<上一步的令牌>' \
HOST=127.0.0.1 PORT=8080 npm start

# 3) 另一终端：Cloudflare 临时隧道（需要本机能访问互联网）
cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate
# 日志里的 https://<随机>.trycloudflare.com 就是公网地址
```

打开公网地址会先看到访问验证页，输入令牌后进入控制台；右上角「退出登录」会清除
会话 Cookie。要点：

- 不配置令牌时**只能监听回环地址**：`HOST` 为其他值会直接拒绝启动，避免把无鉴权
  代理无意中暴露出去。
- 隧道 / 反向代理必须保留浏览器原始 `Host`（cloudflared 默认保留）；重写 `Host`
  会让 SigV4 校验失败，表现为 `403 SignatureDoesNotMatch`。
- 临时隧道 URL 每次重启都会变化，本机关机或休眠即断开；适合临时演示，不提供
  生产 SLA。需要稳定地址时请使用命名隧道或自有反向代理。
- Cloudflare 在边缘终止 TLS，因此 Cloudflare 可见请求元数据与正文（如果未启用
  端到端加密）；携带真实数据前请自行评估合规要求。
- 会话默认 24 小时（`BLINK_WEB_SESSION_HOURS`）。Cookie 为
  `HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure`；服务端同时下发 HSTS。
- 令牌是**共享口令**，不区分用户、没有审计与速率限制；令牌泄露等于测试台完全
  失守。更换 `BLINK_WEB_TOKEN` 并重启会让所有旧 Cookie 立即失效。

### 5. 前后端都在远程开发机时

若 Blink 与 Blink-web 运行在远程开发机、本地只能经堡垒机访问，且堡垒机禁止
`-L` / `-W` 端口转发，可在本地起一个**只监听 `127.0.0.1`** 的 TCP 中继：每条本地
连接执行一次 `ssh <host> nc 127.0.0.1 <port>`，双向搬运字节，把本地 `5173` 与
`9000` 映射到开发机的同号 loopback 端口。

几点实测约束：

- **不要复用 SSH 主连接**：该链路下 `ControlMaster` 多路复用会把吞吐压到约
  200 KiB/s（8 MiB 传输超过 180 s 仍未完成）。使用
  `-o ControlMaster=no -o ControlPath=none` 为每条连接独立握手，8 MiB 可稳定在
  约 6 MB/s；代价是每个新连接多约 1.3 s 握手。
- 中继保留原始字节流即可，不需要理解 HTTP；但必须**处理部分写入**（`write()` 可能
  只写一部分），否则请求体会被截断，后端会一直等待剩余 `Content-Length`。
- 浏览器必须访问 `http://127.0.0.1:5173`（安全上下文）；Chrome 需加
  `--no-proxy-server` 或把回环地址加入代理例外，否则导航会走系统代理而超时。
- 中继链路只用于功能验证与回归；**权威性能数字在开发机本机直连压测**，经中继的
  数字受 SSH 与堡垒机限制，不能作为服务端指标。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `BLINK_ENDPOINT` | 代理目标，只允许 `http(s)://host[:port]` | `http://127.0.0.1:9000` |
| `HOST` | 生产服务器监听地址 | `127.0.0.1` |
| `PORT` | 生产服务器端口 | `8080` |
| `BLINK_TLS_INSECURE` | `1` 时接受自签证书，仅限本机后端 | 关闭 |
| `BLINK_WEB_TOKEN` | 访问令牌（≥32 字符）；设置后启用登录页，非回环监听时必填 | 空（仅回环免鉴权） |
| `BLINK_WEB_SESSION_HOURS` | 登录会话有效期（小时） | `24` |
| `CHROME_PATH` | e2e 使用的 Chrome 可执行文件 | macOS 默认安装路径 |

压测 CLI 另用 `BLINK_ACCESS_KEY` / `BLINK_SECRET_KEY`（必填）、`BLINK_REGION`
（默认 `us-east-1`）、`BLINK_BIN`（默认 `../Blink/bin/blink`）。

## 安全边界

- **回环模式免鉴权**：默认 `HOST=127.0.0.1`，能访问该端口就能以代理身份访问后端。
  不要直接把该端口暴露到公网。
- **公网模式强制令牌**：配置 `BLINK_WEB_TOKEN` 后，静态资源、`/s3` 与登录后的所有
  请求都要带有效会话 Cookie；未登录导航跳 `/__login`，其余请求返回 401。监听非
  回环地址却没有令牌时服务直接拒绝启动。
- 令牌只用于进门禁，**不能替代 S3 凭据**：访问者仍需自己填写 access key / secret
  才能在浏览器里签名。服务端不保存任何 S3 凭据。
- 会话是无状态 HMAC Cookie，登出只清除浏览器里的 Cookie；在被盗用的情况下，
  轮换 `BLINK_WEB_TOKEN` 并重启才是立即失效的手段。
- 反向代理 / 隧道必须保留原始 `Host`，否则浏览器签名与后端校验不一致（403）。
- secret 只在内存；可选的 sessionStorage 仅保存 access key / region，默认关闭。
- 明文 HTTP 下凭据和正文可被窃听；公网请务必使用 HTTPS（隧道或 TLS 反向代理）。

更完整的威胁模型与限制见 [docs/limitations.md](docs/limitations.md)。

## 脚本

| 命令 | 内容 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（127.0.0.1:5173） |
| `npm run build` | 类型检查 + 生产构建到 `dist/` |
| `npm start` | 托管 `dist/` 并代理 `/s3` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `node:test` 单元测试 |
| `npm run test:integration` | 启动真实 Blink 的集成测试；二进制缺失时明确跳过 |
| `npm run test:e2e` | Puppeteer + 本机 Chrome 的端到端测试（需先 build） |
| `npm run bench` | Node 压测 CLI，结果写入 `bench-results/`（gitignore） |

## 压测

对已启动的后端压测：

```bash
BLINK_ACCESS_KEY=<key> BLINK_SECRET_KEY=<secret> \
  npm run bench -- --endpoint http://127.0.0.1:9000 --max-write-mib 512
```

让 CLI 为每个尺寸启动独占临时后端（需要 `--bin` 可执行；结束后删除临时数据目录）：

```bash
BLINK_ACCESS_KEY=<key> BLINK_SECRET_KEY=<secret> \
  npm run bench -- --spawn --bin ../Blink/bin/blink \
    --sizes 64KiB,1MiB,8MiB,32MiB --concurrency 1,4,16
```

默认 1000 样本 / 30 秒上限 / 10% warmup；写入预算整次运行 512 MiB，按尺寸均分。
压测数据每次唯一，避免 Blink 内容寻址去重扭曲写入量。结果只作**同机回归基线**，
不是对外性能承诺；环境绑定数字见 [docs/testing.md](docs/testing.md)。

## 测试

```bash
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:e2e
```

集成测试和 e2e 默认查找 `../Blink/bin/blink`；不存在时集成测试会打印跳过原因并
退出 0，e2e 需要 `dist/index.html` 与本机 Chrome。e2e 可用
`E2E_SCREENSHOTS=<dir>` 保存关键页面截图。

## 目录

```text
src/core/   签名、编码、XML、S3Client、上传/下载策略、重试、压测
src/ui/     组合根与各面板、DOM 辅助、下载落点
server/     静态文件 + 同源 /s3 代理（Vite 与生产共用）
scripts/    压测 CLI
test/       单元、集成、Puppeteer e2e
docs/       架构、测试报告、已知限制
```

## 文档

- [架构设计](docs/architecture.md)：方案对比、类图、签名路径不变式、边端扩展入口。
- [测试报告](docs/testing.md)：环境、命令、压测结果与可复现条件。
- [已知限制](docs/limitations.md)：代理安全边界、key 限制、浏览器能力、压测口径。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
