import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemorySink, suggestedName } from '../../src/ui/downloadSinks.ts'

test('suggestedName 只取最后一段并替换非法字符', () => {
  assert.equal(suggestedName('docs/hello.txt'), 'hello.txt')
  assert.equal(suggestedName('a/b/中文 name.bin'), '中文 name.bin')
  assert.equal(suggestedName('bad:name?.bin'), 'bad_name_.bin')
  assert.equal(suggestedName('dir/'), 'download.bin')
  assert.equal(suggestedName('..'), 'download.bin')
  assert.equal(suggestedName('a\\b.bin'), 'a_b.bin')
})

test('MemorySink 汇总分块后按文件名交付 Blob', async () => {
  const delivered: Array<{ blob: Blob; name: string }> = []
  const sink = new MemorySink('docs/report.bin', 1024, (blob, name) => delivered.push({ blob, name }))

  await sink.write(new TextEncoder().encode('hello '))
  await sink.write(new TextEncoder().encode('world'))
  await sink.close()

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.name, 'report.bin')
  const read = new Uint8Array(await delivered[0]!.blob.arrayBuffer())
  assert.equal(new TextDecoder().decode(read), 'hello world')
})

test('MemorySink 超过上限立即失败，不等到收尾', async () => {
  const sink = new MemorySink('a.bin', 8)
  await sink.write(new Uint8Array(8))
  await assert.rejects(sink.write(new Uint8Array(1)), /内存下载上限/)
})

test('MemorySink 中止后丢弃已写内容，不再交付', async () => {
  const delivered: Blob[] = []
  const sink = new MemorySink('a.bin', 1024, (blob) => delivered.push(blob))
  await sink.write(new Uint8Array(16))
  await sink.abort()
  await sink.close()

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.size, 0, 'abort 后分块应被清空')
})
