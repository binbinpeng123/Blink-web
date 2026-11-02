import assert from 'node:assert/strict'
import { test } from 'node:test'
import { child, childText, children, decodeEntities, parseXml } from '../../src/core/xml.ts'

test('解析声明、命名空间、属性、实体与自闭合标签', () => {
  const root = parseXml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      '<Name>b</Name><KeyCount>0</KeyCount>' +
      '<Contents><Key>a&amp;b</Key><ETag>&quot;x&quot;</ETag>' +
      '<Size>0</Size><Empty/></Contents>' +
      '</ListBucketResult>',
  )

  assert.equal(root.name, 'ListBucketResult')
  assert.equal(childText(root, 'Name'), 'b')
  assert.equal(childText(root, 'KeyCount'), '0')

  const contents = child(root, 'Contents')
  assert.equal(childText(contents, 'Key'), 'a&b')
  assert.equal(childText(contents, 'ETag'), '"x"')
  assert.equal(child(contents, 'Empty')?.name, 'Empty')
})

test('处理注释、CDATA 与 DOCTYPE', () => {
  const root = parseXml(
    '<!DOCTYPE note [<!ELEMENT note ANY>]>' +
      '<!-- 说明 --><r><a><![CDATA[1 < 2 & 3]]></a></r>',
  )
  assert.equal(root.name, 'r')
  assert.equal(childText(root, 'a'), '1 < 2 & 3')
})

test('去命名空间前缀（带前缀时也能按本地名找到）', () => {
  const root = parseXml('<s3:Result xmlns:s3="x"><s3:Key>k</s3:Key></s3:Result>')
  assert.equal(root.name, 'Result')
  assert.equal(childText(root, 'Key'), 'k')
})

test('属性值中的 > 不会提前结束标签', () => {
  const root = parseXml('<r a="1>0" b=\'2>1\'><x>ok</x></r>')
  assert.equal(root.attributes['a'], '1>0')
  assert.equal(root.attributes['b'], '2>1')
  assert.equal(childText(root, 'x'), 'ok')
})

test('decodeEntities 支持命名与十进制/十六进制实体', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'')
  assert.equal(decodeEntities('&#65;&#x4e2d;'), 'A中')
  // 未识别的实体原样保留，避免静默吞掉内容
  assert.equal(decodeEntities('&nbsp;'), '&nbsp;')
})

test('childText 区分元素不存在与存在但为空', () => {
  const root = parseXml('<r><empty></empty><spaced>  v  </spaced></r>')
  assert.equal(childText(root, 'missing'), undefined)
  assert.equal(childText(root, 'empty'), '')
  assert.equal(childText(root, 'spaced'), 'v')
  assert.deepEqual(children(root, 'empty').length, 1)
})
