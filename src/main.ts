import { App } from './ui/App.ts'
import { h } from './ui/dom.ts'

const root = document.getElementById('app')
if (!root) throw new Error('页面缺少 #app 容器')

if (!window.isSecureContext || !globalThis.crypto?.subtle) {
  // WebCrypto 只在 HTTPS 或 localhost/127.0.0.1 等安全上下文可用；没有它就无法签名。
  root.appendChild(
    h(
      'section',
      { class: 'blocked' },
      h('h1', { text: '需要安全上下文' }),
      h('p', {
        text: '浏览器只在 HTTPS 或 localhost / 127.0.0.1 下提供 WebCrypto，缺少它就无法计算 SigV4 签名。',
      }),
      h('p', {
        class: 'hint',
        text: '请通过 https:// 或 http://127.0.0.1:8080 访问本页面。',
      }),
    ),
  )
} else {
  new App(root).start()
}
