import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与后端单测一致：假凭据，不来自任何真实环境。 */
export const TEST_ACCESS_KEY = 'AKIATESTTEST1234'
export const TEST_SECRET_KEY = 'test-secret-key-not-a-real-credential'
export const TEST_REGION = 'us-east-1'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const BLINK_BIN = process.env['BLINK_BIN'] ?? resolve(ROOT, '../Blink/bin/blink')

export const blinkAvailable = existsSync(BLINK_BIN)

export interface BlinkInstance {
  endpoint: string
  port: number
  dataDir: string
  stop(): Promise<void>
}

/** 启动真实 Blink：临时数据目录 + 随机端口；测试结束必须 stop()。 */
export async function startBlink(): Promise<BlinkInstance> {
  if (!blinkAvailable) {
    throw new Error(`找不到 Blink 二进制：${BLINK_BIN}（用 BLINK_BIN 指定，或先在 Blink 仓库 make build）`)
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'blink-web-it-'))
  const port = await freePort()

  // 清掉宿主机的 BLINK_*，避免外部环境影响测试；凭据只经环境变量传给子进程。
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('BLINK_')) continue
    env[name] = value
  }
  env['BLINK_ACCESS_KEY'] = TEST_ACCESS_KEY
  env['BLINK_SECRET_KEY'] = TEST_SECRET_KEY
  env['BLINK_REGION'] = TEST_REGION
  env['BLINK_FSYNC_POLICY'] = 'meta' // 集成测试关注协议正确性，不是掉电语义

  const child = spawn(
    BLINK_BIN,
    ['--addr', `127.0.0.1:${port}`, '--data-dir', dataDir, '--log-level', 'error'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  )

  const stderr: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code))
  })

  const endpoint = `http://127.0.0.1:${port}`
  const ready = await waitForHealth(endpoint, child, exited, stderr)
  if (!ready) {
    child.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true })
    throw new Error(`Blink 未在 15s 内就绪${stderr.length ? `：${stderr.join('').slice(-2000)}` : ''}`)
  }

  let stopped = false
  return {
    endpoint,
    port,
    dataDir,
    async stop() {
      if (stopped) return
      stopped = true
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        await exited
        clearTimeout(timer)
      }
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function waitForHealth(
  endpoint: string,
  child: ChildProcess,
  exited: Promise<number | null>,
  stderr: string[],
): Promise<boolean> {
  let dead = false
  void exited.then(() => {
    dead = true
  })

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (dead) return false
    try {
      const res = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1_000) })
      if (res.ok) return true
    } catch {
      // 还没监听：继续轮询
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return false
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}
