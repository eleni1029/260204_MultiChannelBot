import { spawn, ChildProcess, execSync } from 'child_process'
import { logger } from '../utils/logger.js'
import { prisma } from '../lib/prisma.js'

export type TunnelMode = 'quick' | 'fixed'

interface TunnelStatus {
  isRunning: boolean
  url: string | null
  startedAt: Date | null
  error: string | null
  mode: TunnelMode
}

class TunnelService {
  private process: ChildProcess | null = null
  private url: string | null = null
  private startedAt: Date | null = null
  private error: string | null = null
  private outputBuffer: string = ''
  private mode: TunnelMode = 'fixed'
  private port: number = 3000
  private stopping: boolean = false

  /**
   * 檢查系統中是否有 cloudflared tunnel 進程在運行
   */
  private checkSystemProcess(): boolean {
    try {
      const result = execSync('pgrep -f "cloudflared tunnel"', { encoding: 'utf-8' })
      return result.trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * 殺死所有系統中的 cloudflared tunnel 進程
   */
  private killAllTunnelProcesses(): void {
    try {
      execSync('pkill -f "cloudflared tunnel"', { encoding: 'utf-8' })
      logger.info('Killed all existing cloudflared tunnel processes')
    } catch {
      // 沒有進程時 pkill 會返回非零狀態碼，忽略錯誤
    }
  }

  /**
   * 設定模式（同步記憶體中的 mode）
   */
  setMode(mode: TunnelMode): void {
    this.mode = mode
  }

  /**
   * 獲取當前 tunnel 狀態
   */
  getStatus(): TunnelStatus {
    const hasSystemProcess = this.checkSystemProcess()
    const isRunning = (this.process !== null && !this.process.killed) || hasSystemProcess

    return {
      isRunning,
      url: this.url,
      startedAt: this.startedAt,
      error: this.error,
      mode: this.mode,
    }
  }

  /**
   * 獲取 webhook URL（根據模式返回不同 URL）
   */
  async getWebhookUrl(): Promise<string | null> {
    if (this.mode === 'fixed') {
      const { getSetting } = await import('./settings.service.js')
      const domain = await getSetting('webhook.customDomain')
      return domain ? `${domain}/api/webhook/line` : null
    }
    // quick mode — 優先用記憶體中的 URL，否則從 DB 讀取上次保存的
    const url = this.url || (await this.getLastQuickUrl())
    return url ? `${url}/api/webhook/line` : null
  }

  /**
   * 從 DB 讀取上次保存的 quick tunnel URL
   */
  private async getLastQuickUrl(): Promise<string | null> {
    const setting = await prisma.setting.findUnique({
      where: { key: 'tunnel.lastQuickUrl' },
    })
    return setting?.value || null
  }

  /**
   * 保存 quick tunnel URL 到 DB
   */
  private async saveLastQuickUrl(url: string): Promise<void> {
    await prisma.setting.upsert({
      where: { key: 'tunnel.lastQuickUrl' },
      update: { value: url },
      create: { key: 'tunnel.lastQuickUrl', value: url, description: '上次快速隧道 URL' },
    })
  }

  /**
   * 啟動 Quick 模式隧道（臨時 trycloudflare.com URL）
   */
  async startQuick(port: number = 3000): Promise<{ success: boolean; url?: string; error?: string }> {
    // 先清理所有現有的 cloudflared tunnel 進程（包括遺留的）
    this.killAllTunnelProcesses()

    // 等待進程完全結束
    await new Promise(resolve => setTimeout(resolve, 1000))

    this.mode = 'quick'
    this.port = port
    this.stopping = false

    return new Promise((resolve) => {
      try {
        this.error = null
        this.outputBuffer = ''

        this.process = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const timeout = setTimeout(() => {
          if (!this.url) {
            this.error = '啟動超時，未能獲取 tunnel URL'
            resolve({ success: false, error: this.error })
          }
        }, 30000)

        const handleOutput = (data: Buffer) => {
          const output = data.toString()
          this.outputBuffer += output

          // 解析 URL
          const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
          if (urlMatch && !this.url) {
            this.url = urlMatch[0]
            this.startedAt = new Date()
            clearTimeout(timeout)
            logger.info({ url: this.url }, 'Cloudflare quick tunnel started')
            // 保存 URL 到 DB（不等待完成）
            this.saveLastQuickUrl(this.url).catch(() => {})
            resolve({ success: true, url: this.url })
          }
        }

        this.process.stdout?.on('data', handleOutput)
        this.process.stderr?.on('data', handleOutput)

        this.process.on('error', (err) => {
          this.error = `啟動失敗: ${err.message}`
          this.process = null
          clearTimeout(timeout)
          logger.error({ error: err }, 'Cloudflare tunnel error')
          resolve({ success: false, error: this.error })
        })

        this.process.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            this.error = `Tunnel 異常退出，代碼: ${code}`
            logger.warn({ code }, 'Cloudflare quick tunnel exited')
          }
          this.process = null
          this.url = null
          this.startedAt = null

          // 非主動停止時自動重啟
          if (!this.stopping) {
            logger.info('Quick tunnel crashed, auto-restarting in 5s...')
            setTimeout(() => {
              if (!this.stopping && !this.process) {
                this.autoStart(this.port).catch(() => {})
              }
            }, 5000)
          }
        })

      } catch (err) {
        this.error = `啟動異常: ${err instanceof Error ? err.message : String(err)}`
        resolve({ success: false, error: this.error })
      }
    })
  }

  /**
   * 啟動 Fixed 模式隧道（使用 Cloudflare Tunnel Token）
   */
  async startFixed(token: string): Promise<{ success: boolean; error?: string }> {
    if (!token) {
      return { success: false, error: 'Cloudflare Tunnel Token 不可為空' }
    }

    // 先清理所有現有的 cloudflared tunnel 進程（包括遺留的）
    this.killAllTunnelProcesses()

    // 等待進程完全結束
    await new Promise(resolve => setTimeout(resolve, 1000))

    this.mode = 'fixed'
    this.stopping = false

    return new Promise((resolve) => {
      try {
        this.error = null
        this.outputBuffer = ''
        this.url = null

        this.process = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        // Fixed 模式不需要從輸出中解析 URL，只需等待進程啟動
        const timeout = setTimeout(() => {
          // 如果進程仍在運行，視為成功
          if (this.process && !this.process.killed) {
            this.startedAt = new Date()
            logger.info('Cloudflare fixed tunnel started')
            resolve({ success: true })
          } else {
            this.error = '啟動超時'
            resolve({ success: false, error: this.error })
          }
        }, 5000)

        const handleOutput = (data: Buffer) => {
          const output = data.toString()
          this.outputBuffer += output
          logger.debug({ output: output.trim() }, 'cloudflared output')

          // 檢查是否有連線成功的信號
          if (output.includes('Registered tunnel connection') || output.includes('Connection registered')) {
            if (!this.startedAt) {
              this.startedAt = new Date()
              clearTimeout(timeout)
              logger.info('Cloudflare fixed tunnel connected')
              resolve({ success: true })
            }
          }

          // 檢查錯誤
          if (output.includes('error') && output.includes('token')) {
            this.error = 'Token 無效或連線失敗'
            clearTimeout(timeout)
            resolve({ success: false, error: this.error })
          }
        }

        this.process.stdout?.on('data', handleOutput)
        this.process.stderr?.on('data', handleOutput)

        this.process.on('error', (err) => {
          this.error = `啟動失敗: ${err.message}`
          this.process = null
          clearTimeout(timeout)
          logger.error({ error: err }, 'Cloudflare fixed tunnel error')
          resolve({ success: false, error: this.error })
        })

        this.process.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            this.error = `Tunnel 異常退出，代碼: ${code}`
            logger.warn({ code }, 'Cloudflare fixed tunnel exited')
          }
          this.process = null
          this.startedAt = null

          // 非主動停止時自動重啟
          if (!this.stopping) {
            logger.info('Fixed tunnel crashed, auto-restarting in 5s...')
            setTimeout(() => {
              if (!this.stopping && !this.process) {
                this.autoStart(this.port).catch(() => {})
              }
            }, 5000)
          }
        })

      } catch (err) {
        this.error = `啟動異常: ${err instanceof Error ? err.message : String(err)}`
        resolve({ success: false, error: this.error })
      }
    })
  }

  /**
   * 從 DB 讀取設定並自動啟動隧道（server 啟動時調用）
   */
  async autoStart(port: number): Promise<void> {
    try {
      const { getSetting } = await import('./settings.service.js')
      const mode = ((await getSetting('tunnel.mode')) || 'fixed') as TunnelMode
      const token = (await getSetting('tunnel.cloudflareToken')) || ''

      // fixed 模式需要 token，quick 模式直接啟動
      if (mode === 'fixed' && !token) {
        logger.info('Tunnel auto-start skipped: fixed mode but no token configured')
        return
      }

      logger.info({ mode }, 'Auto-starting tunnel on server boot')
      const result = await this.startByMode(mode, port, token)
      if (result.success) {
        logger.info({ mode, url: result.url }, 'Tunnel auto-started successfully')
      } else {
        logger.warn({ mode, error: result.error }, 'Tunnel auto-start failed')
      }
    } catch (err) {
      logger.error({ error: err }, 'Tunnel auto-start error')
    }
  }

  /**
   * 根據模式啟動隧道
   */
  async startByMode(mode: TunnelMode, port: number, token?: string): Promise<{ success: boolean; url?: string; error?: string }> {
    if (mode === 'fixed') {
      if (!token) {
        return { success: false, error: 'Fixed 模式需要 Cloudflare Tunnel Token' }
      }
      const result = await this.startFixed(token)
      return result
    }
    return this.startQuick(port)
  }

  /**
   * 停止 tunnel
   */
  async stop(): Promise<{ success: boolean }> {
    this.stopping = true

    // 先嘗試優雅地停止自己管理的進程
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM')

      // 等待進程結束
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 3000)

        this.process?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    // 清理所有系統中的 cloudflared tunnel 進程（包括遺留的）
    this.killAllTunnelProcesses()

    // 等待進程完全結束
    await new Promise(resolve => setTimeout(resolve, 500))

    this.process = null
    this.url = null
    this.startedAt = null
    this.error = null

    logger.info('Cloudflare tunnel stopped')
    return { success: true }
  }

  /**
   * 重啟 tunnel（獲取新 URL）
   */
  async restart(port: number = 3000): Promise<{ success: boolean; url?: string; error?: string }> {
    await this.stop()
    return this.startQuick(port)
  }

  /**
   * 檢查 webhook 是否有效
   * - quick 模式：檢查本地 server + cloudflared 進程是否存活
   * - fixed 模式：透過外部域名檢查
   */
  async checkHealth(port: number = 3000): Promise<{
    isValid: boolean
    latency?: number
    error?: string
  }> {
    const isRunning = (this.process !== null && !this.process.killed) || this.checkSystemProcess()

    if (this.mode === 'quick') {
      // Quick 模式：檢查 cloudflared 進程存活 + 本地 server 健康
      if (!isRunning) {
        return { isValid: false, error: 'cloudflared 進程未運行' }
      }
      const startTime = Date.now()
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const latency = Date.now() - startTime
        if (response.ok) {
          return { isValid: true, latency }
        }
        return { isValid: false, latency, error: `HTTP ${response.status}` }
      } catch (err) {
        return { isValid: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    // Fixed 模式：透過外部域名檢查
    const { getSetting } = await import('./settings.service.js')
    const checkUrl = await getSetting('webhook.customDomain')

    if (!checkUrl) {
      if (isRunning) {
        return { isValid: true, error: '進程運行中，但未設定固定域名' }
      }
      return { isValid: false, error: '未設定固定域名' }
    }

    const startTime = Date.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      const response = await fetch(`${checkUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latency = Date.now() - startTime
      if (response.ok) {
        return { isValid: true, latency }
      }
      return { isValid: false, latency, error: `HTTP ${response.status}: ${response.statusText}` }
    } catch (err) {
      // 如果外部 URL 不通但進程在跑，仍標記為部分正常
      if (isRunning) {
        return { isValid: false, error: `進程運行中，但外部連線失敗: ${err instanceof Error ? err.message : String(err)}` }
      }
      return { isValid: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// 單例
export const tunnelService = new TunnelService()
