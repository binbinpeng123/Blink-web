import { defineConfig } from 'vite'
import { createS3Proxy } from './server/proxy.ts'

// 开发与生产共用同一份代理实现，避免两套转发逻辑漂移。
const endpoint = process.env['BLINK_ENDPOINT'] ?? 'http://127.0.0.1:9000'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  plugins: [
    {
      name: 'blink-s3-proxy',
      configureServer(server) {
        server.middlewares.use(
          createS3Proxy({
            endpoint,
            insecureTls: process.env['BLINK_TLS_INSECURE'] === '1',
            log: (line) => server.config.logger.info(`[s3] ${line}`),
          }),
        )
      },
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
