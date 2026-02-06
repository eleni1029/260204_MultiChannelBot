import { spawn, ChildProcess, execSync } from 'child_process'
import { logger } from '../utils/logger.js'

interface TunnelStatus {
  isRunning: boolean
  url: string | null
  startedAt: Date | null
  error: string | null
}

class TunnelService {
  private process: ChildProcess | null = null
  private url: string | null = null
  private startedAt: Date | null = null
  private error: string | null = null
  private outputBuffer: string = ''

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
    }
  }

  /**
   * 獲取 webhook URL
   */
  getWebhookUrl(): string | null {
    return this.url ? `${this.url}/api/webhook/line` : null
  }

  /**
   * 啟動 cloudflare tunnel
   */
  async start(port: number = 3000): Promise<{ success: boolean; url?: string; error?: string }> {
    // 先清理所有現有的 cloudflared tunnel 進程（包括遺留的）
    this.killAllTunnelProcesses()

    // 等待進程完全結束
    await new Promise(resolve => setTimeout(resolve, 1000))

    return new Promise((resolve) => {
      try {
        this.error = null
        this.outputBuffer = ''

        this.process = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
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
            logger.info({ url: this.url }, 'Cloudflare tunnel started')
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
            logger.warn({ code }, 'Cloudflare tunnel exited')
          }
          this.process = null
          this.url = null
          this.startedAt = null
        })

      } catch (err) {
        this.error = `啟動異常: ${err instanceof Error ? err.message : String(err)}`
        resolve({ success: false, error: this.error })
      }
    })
  }

  /**
   * 停止 tunnel
   */
  async stop(): Promise<{ success: boolean }> {
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
    return this.start(port)
  }

  /**
   * 檢查 webhook URL 是否有效
   */
  async checkHealth(): Promise<{
    isValid: boolean
    latency?: number
    error?: string
  }> {
    if (!this.url) {
      return { isValid: false, error: '沒有可用的 tunnel URL' }
    }

    const startTime = Date.now()

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const response = await fetch(`${this.url}/health`, {
        method: 'GET',
        signal: controller.signal,
      })

      clearTimeout(timeout)
      const latency = Date.now() - startTime

      if (response.ok) {
        return { isValid: true, latency }
      } else {
        return {
          isValid: false,
          latency,
          error: `HTTP ${response.status}: ${response.statusText}`
        }
      }
    } catch (err) {
      return {
        isValid: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

// 單例
export const tunnelService = new TunnelService()
