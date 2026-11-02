import { S3Client } from '../core/client.ts'
import { SigV4Signer } from '../core/signer.ts'
import { FetchTransport } from '../core/transport.ts'
import type { Credentials } from '../core/types.ts'
import { BenchmarkPanel } from './BenchmarkPanel.ts'
import { BucketList } from './BucketList.ts'
import { ConnectionPanel } from './ConnectionPanel.ts'
import { DownloadPanel } from './DownloadPanel.ts'
import { append, clear, h } from './dom.ts'
import { describeError } from './errorText.ts'
import { Modal } from './Modal.ts'
import { ObjectBrowser } from './ObjectBrowser.ts'
import type { StatusKind } from './status.ts'
import { UploadPanel } from './UploadPanel.ts'

/**
 * 组合根：持有页面状态与各视图，视图之间不互相引用。
 * 浏览器只访问同源 `/s3`，签名 Host 是 location.host —— 与代理保留 Host 的不变式对应。
 */
export class App {
  readonly #root: HTMLElement
  readonly #statusBar: HTMLElement
  readonly #statusText: HTMLSpanElement
  readonly #connectionPanel: ConnectionPanel
  readonly #bucketList: BucketList
  readonly #browser: ObjectBrowser
  readonly #upload: UploadPanel
  readonly #download: DownloadPanel
  readonly #benchmark: BenchmarkPanel
  readonly #modal = new Modal()
  #client: S3Client | null = null
  #refreshTimer: ReturnType<typeof setTimeout> | undefined

  constructor(root: HTMLElement) {
    this.#root = root

    this.#statusText = h('span', { class: 'status-text' })
    this.#statusBar = h(
      'footer',
      { class: 'statusbar', attrs: { role: 'status', 'aria-live': 'polite' } },
      h('span', { class: 'status-dot' }),
      this.#statusText,
    )

    this.#benchmark = new BenchmarkPanel({
      onStatus: (message, kind) => this.#setStatus(message, kind),
    })
    this.#browser = new ObjectBrowser({
      onStatus: (message, kind) => this.#setStatus(message, kind),
      modal: this.#modal,
      // 上传写入"当前正在浏览的前缀"，压测只跟随当前桶（前缀固定为 bench/）。
      onNavigate: (state) => {
        this.#upload.setTarget(state)
        this.#benchmark.setTarget(state)
      },
      onDownload: (bucket, key) => this.#download.start(bucket, key),
    })
    this.#upload = new UploadPanel({
      onStatus: (message, kind) => this.#setStatus(message, kind),
      onUploaded: (bucket) => {
        if (this.#browser.bucket === bucket) this.#scheduleRefresh()
      },
    })
    this.#download = new DownloadPanel({
      onStatus: (message, kind) => this.#setStatus(message, kind),
    })
    this.#bucketList = new BucketList({
      onSelect: (bucket) => this.#browser.setBucket(bucket),
      onStatus: (message, kind) => this.#setStatus(message, kind),
    })
    this.#connectionPanel = new ConnectionPanel({
      onConnect: (credentials, region) => this.#connect(credentials, region),
      onDisconnect: () => this.#disconnect(),
    })
  }

  start(): void {
    const header = h(
      'header',
      { class: 'app-header' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark', text: 'B' }),
        h(
          'div',
          {},
          h('h1', { class: 'brand-title', text: 'Blink' }),
          h('span', { class: 'brand-sub', text: '浏览器上传 / 下载测试台' }),
        ),
      ),
      h(
        'div',
        {
          class: 'endpoint',
          title: '后端地址只由服务端 BLINK_ENDPOINT 决定，浏览器只访问同源 /s3',
        },
        h('span', { class: 'muted', text: '同源代理' }),
        h('code', { text: '/s3' }),
      ),
    )

    const main = h(
      'main',
      { class: 'layout' },
      h(
        'aside',
        { class: 'sidebar' },
        this.#connectionPanel.element,
        this.#bucketList.element,
      ),
      h(
        'section',
        { class: 'workspace' },
        this.#upload.element,
        this.#download.element,
        this.#browser.element,
        this.#benchmark.element,
      ),
    )

    clear(this.#root)
    append(this.#root, header, main, this.#statusBar)
    this.#setStatus('未连接：填写凭据后点「连接」', 'info')
  }

  async #connect(credentials: Credentials, region: string): Promise<void> {
    this.#setStatus('正在通过 ListBuckets 验证连接…', 'info')
    try {
      const client = new S3Client({
        transport: new FetchTransport('/s3'),
        signer: new SigV4Signer(credentials, region),
        host: location.host,
      })
      const buckets = await client.listBuckets()

      this.#client = client
      this.#connectionPanel.showConnected({ accessKeyId: credentials.accessKeyId, region })
      this.#bucketList.setClient(client, buckets)
      this.#benchmark.setClient(client)
      this.#browser.setClient(client)
      this.#upload.setClient(client)
      this.#download.setClient(client)
      this.#setStatus(`连接成功：${buckets.length} 个桶`, 'success')
    } catch (error) {
      this.#setStatus(`连接失败：${describeError(error)}`, 'error')
      throw error
    }
  }

  #disconnect(): void {
    this.#client = null
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer)
      this.#refreshTimer = undefined
    }
    // 先停掉压测：它会用运行开始时捕获的客户端清理已写入对象。
    this.#benchmark.setClient(null)
    this.#upload.setClient(null)
    this.#download.setClient(null)
    this.#bucketList.setClient(null)
    this.#browser.setClient(null)
    this.#connectionPanel.showDisconnected()
    this.#setStatus('已断开连接', 'info')
  }

  /**
   * 多个文件并发上传会各自触发一次完成回调，合并成一次列表刷新，
   * 避免同一前缀被连续请求多次。
   */
  #scheduleRefresh(): void {
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      void this.#browser.load()
    }, 250)
  }

  #setStatus(message: string, kind: StatusKind = 'info'): void {
    this.#statusText.textContent = message
    this.#statusBar.dataset['kind'] = kind
  }
}
