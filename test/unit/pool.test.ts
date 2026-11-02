import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Semaphore } from '../../src/core/pool.ts'

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

test('上限内立即获批，超出的排队；释放后按序唤醒', async () => {
  const pool = new Semaphore(2)
  const r1 = await pool.acquire()
  const r2 = await pool.acquire()
  assert.equal(pool.active, 2)

  let thirdGranted = false
  const third = pool.acquire().then((release) => {
    thirdGranted = true
    return release
  })
  await Promise.resolve()
  assert.equal(thirdGranted, false)
  assert.equal(pool.pending, 1)

  r1()
  const r3 = await third
  assert.equal(thirdGranted, true)
  assert.equal(pool.active, 2)
  assert.equal(pool.pending, 0)

  r2()
  r3()
  assert.equal(pool.active, 0)
})

test('释放是幂等的：重复调用不会凭空多放名额', async () => {
  const pool = new Semaphore(1)
  const r1 = await pool.acquire()

  const w1 = pool.acquire()
  let w2Granted = false
  const w2 = pool.acquire().then((release) => {
    w2Granted = true
    return release
  })

  // 一次释放只应唤醒一个等待者；第二次调用必须是空操作
  r1()
  r1()
  const release1 = await w1
  assert.equal(pool.active, 1)
  assert.equal(pool.pending, 1)
  assert.equal(w2Granted, false, '重复释放不得额外放行排队者')

  release1()
  const release2 = await w2
  assert.equal(w2Granted, true)
  release2()
  assert.equal(pool.active, 0)
})

test('等待中取消：移出队列并以 AbortError 失败，名额不漏放', async () => {
  const pool = new Semaphore(1)
  const release = await pool.acquire()
  const controller = new AbortController()
  const waiting = pool.acquire(controller.signal)

  controller.abort()
  await assert.rejects(waiting, isAbort)
  assert.equal(pool.pending, 0, '取消的等待者必须移出队列')

  release()
  assert.equal(pool.active, 0)

  // 取消之后信号量仍可正常工作
  const again = await pool.acquire()
  again()
  assert.equal(pool.active, 0)
})

test('已取消的信号不会占名额', async () => {
  const pool = new Semaphore(1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(pool.acquire(controller.signal), isAbort)
  assert.equal(pool.active, 0)
  assert.equal(pool.pending, 0)
})

test('run 在任务成功或抛错时都释放名额', async () => {
  const pool = new Semaphore(1)
  assert.equal(await pool.run(async () => 42), 42)
  assert.equal(pool.active, 0)

  await assert.rejects(
    pool.run(async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(pool.active, 0)
})

test('构造参数必须是正整数', () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new Semaphore(limit), RangeError)
  }
})
