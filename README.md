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
  `127.0.0.1`。

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

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `BLINK_ENDPOINT` | 代理目标，只允许 `http(s)://host[:port]` | `http://127.0.0.1:9000` |
| `HOST` | 生产服务器监听地址 | `127.0.0.1` |
| `PORT` | 生产服务器端口 | `8080` |
| `BLINK_TLS_INSECURE` | `1` 时接受自签证书，仅限本机后端 | 关闭 |
| `CHROME_PATH` | e2e 使用的 Chrome 可执行文件 | macOS 默认安装路径 |

压测 CLI 另用 `BLINK_ACCESS_KEY` / `BLINK_SECRET_KEY`（必填）、`BLINK_REGION`
（默认 `us-east-1`）、`BLINK_BIN`（默认 `../Blink/bin/blink`）。

## 安全边界

- 代理**不额外鉴权**：能访问代理就能访问后端。只应监听 loopback，或置于 TLS 与
  认证反向代理之后；不要把 `127.0.0.1:8080` 直接暴露到公网。
- 反向代理必须保留原始 `Host`，否则浏览器签名与后端校验不一致（403）。
- secret 只在内存；可选的 sessionStorage 仅保存 access key / region，默认关闭。
- 明文 HTTP 下凭据和正文可被窃听；仅建议 localhost 或 TLS 之后使用。

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
