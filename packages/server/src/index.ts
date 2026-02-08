import { buildApp } from './app.js'
import { config } from './config/index.js'
import { logger } from './utils/logger.js'
import { tunnelService } from './services/tunnel.service.js'

const start = async () => {
  const app = await buildApp()

  try {
    await app.listen({ port: config.port, host: config.host })
    logger.info(`Server is running on http://${config.host}:${config.port}`)

    // Server 啟動後自動啟動 tunnel（不阻塞主流程）
    tunnelService.autoStart(config.port).catch((err) => {
      logger.error({ error: err }, 'Tunnel auto-start failed')
    })
  } catch (err) {
    logger.error(err)
    process.exit(1)
  }
}

start()
