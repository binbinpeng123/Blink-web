import assert from 'node:assert/strict'
import { createHash, randomFillSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { S3Client } from '../../src/core/client.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import { FetchTransport } from '../../src/core/transport.ts'
import { createBlinkServer } from '../../server/server.ts'
import {
  BLINK_BIN,
  TEST_ACCESS_KEY,
  TEST_REGION,
  TEST_SECRET_KEY,
  blinkAvailable,
  startBlink,
  type BlinkInstance,
} from '../integration/harness.ts'

/**
 * 浏览器端到端验证（生产形态：dist 静态文件 + 同源 /s3 代理）。
 * 依赖本机 Chrome；CHROME_PATH 可覆盖。运行前需 npm run build。
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CHROME_PATH =
  process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BUCKET = 'e2e-basic'
const SCREENSHOT_DIR = process.env['E2E_SCREENSHOTS']

if (!blinkAvailable) {
  console.log(`跳过 e2e：找不到 Blink 二进制（${BLINK_BIN}）`)
  process.exit(0)
}
if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
  console.error('缺少 dist/index.html：先运行 npm run build')
  process.exit(1)
}
if (!existsSync(CHROME_PATH)) {
  console.error(`找不到 Chrome：${CHROME_PATH}（用 CHROME_PATH 指定）`)
  process.exit(1)
}

let blink: BlinkInstance | undefined
let app: ReturnType<typeof createBlinkServer> | undefined
let browser: Browser | undefined
let uploadTempPath: string | undefined
let downloadDir: string | undefined

try {
  blink = await startBlink()
  app = createBlinkServer({ endpoint: blink.endpoint, port: 0, dist: resolve(ROOT, 'dist'), log: () => {} })
  const { url } = await app.listen()
  console.log(`e2e：Blink ${blink.endpoint} ← 代理 ${url}`)
  if (SCREENSHOT_DIR) await mkdir(SCREENSHOT_DIR, { recursive: true })
  downloadDir = await mkdtemp(join(tmpdir(), 'blink-web-download-'))

  // 直连后端准备测试数据：浏览器只负责观察与操作
  const seed = new S3Client({
    transport: new FetchTransport(blink.endpoint),
    signer: new SigV4Signer({ accessKeyId: TEST_ACCESS_KEY, secretKey: TEST_SECRET_KEY }, TEST_REGION),
    host: `127.0.0.1:${blink.port}`,
  })

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) {
      pageErrors.push(message.text())
    }
  })
  page.on('dialog', (dialog) => void dialog.accept())

  // headless 无法弹系统保存对话框：隐藏 picker，让应用走 Blob 回退，
  // 再由 CDP 把下载落到临时目录，最后比对文件内容。
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  const downloadSession = await browser.target().createCDPSession()
  await downloadSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  })

  await page.goto(url, { waitUntil: 'domcontentloaded' })

  console.log('e2e：连接')
  await fill(page, 'input[name="access-key"]', TEST_ACCESS_KEY)
  await fill(page, 'input[name="secret-key"]', TEST_SECRET_KEY)
  await page.click('.connection-form button[type="submit"]')
  await waitForText(page, '.status-text', '连接成功')
  await waitForText(page, '.connection-summary-head', '已连接')

  console.log('e2e：创建桶')
  await fill(page, 'input[name="new-bucket"]', BUCKET)
  await page.click('.bucket-create button[type="submit"]')
  await page.waitForSelector(`[data-bucket="${BUCKET}"]`, { timeout: 15_000 })
  await waitForText(page, '.row-message', '桶是空的')
  // 上传面板也有一个 .panel-head-right：必须限定到对象面板，避免选错元素
  assert.equal(await text(page, 'section[aria-labelledby="objects-title"] .panel-head-right .muted'), BUCKET)

  console.log('e2e：列表、详情与删除对象')
  const content = new TextEncoder().encode('hello blink\n')
  await seed.putObject(BUCKET, 'docs/hello.txt', content, 'text/plain')
  await page.click('.workspace .panel-head-right .icon-button')
  // delimiter=/ 下对象先以目录形式出现，点进去才是对象
  await page.waitForSelector('[data-prefix="docs/"]', { timeout: 15_000 })
  await screenshot(page, 'objects-root')
  await page.click('[data-prefix="docs/"]')
  await page.waitForSelector('[data-key="docs/hello.txt"]', { timeout: 15_000 })
  assert.equal(await text(page, '[data-key="docs/hello.txt"] .col-size'), `${content.length} B`)
  await screenshot(page, 'objects')

  await page.click('[data-key="docs/hello.txt"] .row-actions button:first-child')
  await waitForText(page, '.modal-title', '对象详情')
  const details = await text(page, '.modal-body')
  assert.ok(details.includes('docs/hello.txt'), '详情应包含 key')
  assert.ok(details.includes('Content-Type'), '详情应包含 Content-Type')
  await screenshot(page, 'details')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.modal-backdrop')?.hidden === true)

  await page.click('[data-key="docs/hello.txt"] .row-actions button.danger')
  await waitForText(page, '.status-text', '已删除 docs/hello.txt')
  await page.waitForFunction(() => !document.querySelector('[data-key="docs/hello.txt"]'), {
    timeout: 15_000,
  })
  await waitForText(page, '.row-message', '此前缀下没有对象')
  await page.click('.breadcrumb button.crumb')
  await waitForText(page, '.row-message', '桶是空的')

  console.log('e2e：上传 12 MiB 文件（分片）')
  // 12 MiB 超过单 PUT 阈值，按默认 8 MiB 分片切成 8 MiB + 4 MiB，覆盖分片与 Complete 链路。
  const uploadBytes = 12 * 1024 * 1024
  const fileName = `e2e-upload-${Date.now()}.bin`
  uploadTempPath = join(tmpdir(), fileName)
  const payload = new Uint8Array(uploadBytes)
  randomFillSync(payload)
  await writeFile(uploadTempPath, payload)

  await waitForText(page, '.upload-target', `${BUCKET}/`)
  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15_000 })
  assert.ok(fileInput, '找不到上传文件输入框')
  await fileInput.uploadFile(uploadTempPath)
  await waitForText(page, '.status-text', `开始上传 ${fileName}`)
  await page.waitForSelector('.upload-task[data-state="done"]', { timeout: 60_000 })
  await waitForText(page, '.status-text', '已上传')
  const uploadDetail = await text(page, '.upload-task[data-state="done"] .upload-status')
  assert.ok(uploadDetail.includes('2 个分片'), `12 MiB 应按 8 MiB 切成 2 个分片，实际：${uploadDetail}`)
  await screenshot(page, 'upload')

  // onUploaded 会延迟刷新列表：等对象行出现并核对大小
  await page.waitForSelector(`tr[data-key="${fileName}"]`, { timeout: 15_000 })
  assert.equal(await text(page, `tr[data-key="${fileName}"] .col-size`), '12.0 MiB')

  console.log('e2e：下载 12 MiB 文件（Blob 回退 + CDP 捕获）')
  await page.click(`tr[data-key="${fileName}"] .row-actions .download`)
  await page.waitForSelector('.download-task[data-state="done"]', { timeout: 60_000 })
  const downloadDetail = await text(page, '.download-task[data-state="done"] .download-status')
  assert.ok(
    downloadDetail.includes('3 个分块'),
    `12 MiB 应按 4 MiB 切成 3 块，实际：${downloadDetail}`,
  )
  await waitForText(page, '.status-text', '已下载')
  await screenshot(page, 'download')

  const downloadedPath = join(downloadDir, fileName)
  await waitForFile(downloadedPath, uploadBytes)
  const downloaded = await readFile(downloadedPath)
  assert.equal(
    createHash('sha256').update(downloaded).digest('hex'),
    createHash('sha256').update(payload).digest('hex'),
    '下载文件的 SHA-256 应与上传源一致',
  )

  // 下载任务同样带 data-key，等待对象行消失时必须限定到表格行。
  await page.click(`tr[data-key="${fileName}"] .row-actions button.danger`)
  await waitForText(page, '.status-text', `已删除 ${fileName}`)
  await page.waitForFunction(
    (name) => !document.querySelector(`tr[data-key="${name}"]`),
    { timeout: 15_000 },
    fileName,
  )
  await waitForText(page, '.row-message', '桶是空的')

  console.log('e2e：浏览器压测面板（快速基线 + 自动清理）')
  await fill(page, 'input[name="bench-sizes"]', '64KiB')
  await fill(page, 'input[name="bench-concurrencies"]', '1')
  await fill(page, 'input[name="bench-samples"]', '5')
  await fill(page, 'input[name="bench-duration"]', '0')
  await page.click('button[name="bench-start"]')
  await waitForText(page, '.status-text', '压测完成')
  await waitForText(page, '.bench-summary', '已清理')
  const benchRows = await page.$$eval('.bench-table tbody tr', (rows) => rows.length)
  assert.equal(benchRows, 2, 'PUT 与 GET 各应产生一行结果')
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.bench-status[data-kind="ok"]').length),
    2,
    '快速基线不应出现错误或校验和不一致',
  )
  assert.equal(
    await page.evaluate(() => document.querySelector<HTMLElement>('button[name="bench-export"]')?.hidden),
    false,
    '有结果时应可导出 JSON',
  )
  await screenshot(page, 'benchmark')

  // 面板只删除自己记录的对象；刷新后桶应恢复为空。
  await page.click('[aria-label="刷新当前前缀"]')
  await waitForText(page, '.row-message', '桶是空的')

  console.log('e2e：断开连接')
  await page.click('.connection-summary button[name="disconnect"]')
  await waitForText(page, '.status-text', '已断开连接')
  const formVisible = await page.evaluate(
    () => !document.querySelector<HTMLFormElement>('.connection-form')?.hidden,
  )
  assert.equal(formVisible, true, '断开后应重新显示连接表单')

  // 重新连接验证 sessionStorage 中没有 secret
  const stored = await page.evaluate(() => JSON.stringify(sessionStorage))
  assert.equal(stored.includes(TEST_SECRET_KEY), false, 'secret 不得写入 sessionStorage')

  console.log('e2e：重新连接并删除桶')
  await fill(page, 'input[name="secret-key"]', TEST_SECRET_KEY)
  await page.click('.connection-form button[type="submit"]')
  await waitForText(page, '.status-text', '连接成功')
  await page.waitForSelector(`[data-bucket="${BUCKET}"]`, { timeout: 15_000 })
  await page.click(`[data-bucket="${BUCKET}"]`)
  await page.hover('.bucket-row.selected')
  await page.click('.bucket-row.selected .bucket-delete')
  await waitForText(page, '.status-text', '已删除桶')
  await waitForText(page, '.bucket-empty', '尚未创建桶')
  assert.equal(
    await text(page, 'section[aria-labelledby="objects-title"] .panel-head-right .muted'),
    '未选择桶',
  )

  if (pageErrors.length > 0) {
    throw new Error(`页面报错：\n${pageErrors.join('\n')}`)
  }
  console.log('e2e 通过：连接 → 建桶 → 浏览 → 上传 → 下载 → 删除 → 断开 → 重连 → 删桶')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (uploadTempPath) await unlink(uploadTempPath).catch(() => {})
  if (downloadDir) await rm(downloadDir, { recursive: true, force: true }).catch(() => {})
  await browser?.close().catch(() => {})
  if (app) {
    app.server.closeAllConnections()
    await app.close().catch(() => {})
  }
  await blink?.stop()
}

async function fill(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate(
    (sel, v) => {
      const input = document.querySelector<HTMLInputElement>(sel)
      if (!input) throw new Error(`找不到输入框 ${sel}`)
      input.value = v
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )
}

async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction(
    (sel, text) => document.querySelector(sel)?.textContent?.includes(text) ?? false,
    { timeout: 15_000, polling: 100 },
    selector,
    expected,
  )
}

/** Chrome 先写 .crdownload，完成后才以最终文件名出现；大小吻合即可读取。 */
async function waitForFile(path: string, expectedSize: number): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const info = await stat(path)
      if (info.size === expectedSize) return
    } catch {
      // 文件尚未出现，继续等
    }
    if (Date.now() > deadline) throw new Error(`等待下载文件超时：${path}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

async function text(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.textContent?.trim() ?? '',
    selector,
  )
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}
