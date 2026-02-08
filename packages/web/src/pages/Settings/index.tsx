import { useEffect, useState, useCallback } from 'react'
import {
  Card,
  Form,
  Input,
  Select,
  Button,
  message,
  Divider,
  Alert,
  Space,
  Tag,
  Tooltip,
  Spin,
  Typography,
  Switch,
  Segmented,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  CopyOutlined,
  RobotOutlined,
  LinkOutlined,
  CloudOutlined,
  PoweroffOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import { settingsApi, tunnelApi, OAuthStatus, TunnelStatus, TunnelHealth, ChannelStatus, TunnelMode } from '@/services/api'
import { useAuthStore } from '@/stores/auth'

const { Text, Paragraph } = Typography

export function Settings() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus[]>([])
  const [currentProvider, setCurrentProvider] = useState<string>('')
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null)
  const [tunnelHealth, setTunnelHealth] = useState<TunnelHealth | null>(null)
  const [tunnelLoading, setTunnelLoading] = useState(false)
  const [tunnelActionLoading, setTunnelActionLoading] = useState(false)
  const [lineStatus, setLineStatus] = useState<ChannelStatus | null>(null)
  const [lineStatusLoading, setLineStatusLoading] = useState(false)
  const [feishuStatus, setFeishuStatus] = useState<ChannelStatus | null>(null)
  const [feishuLoading, setFeishuLoading] = useState(false)
  const [customDomain, setCustomDomain] = useState('')
  const [customDomainSaving, setCustomDomainSaving] = useState(false)
  const [customWebhookUrls, setCustomWebhookUrls] = useState<{ line: string; feishu: string } | null>(null)
  const [tunnelMode, setTunnelMode] = useState<TunnelMode>('fixed')
  const [cloudflareToken, setCloudflareToken] = useState('')
  const [modeSaving, setModeSaving] = useState(false)
  const hasPermission = useAuthStore((state) => state.hasPermission)

  const fetchData = async () => {
    setLoading(true)
    try {
      const res = await settingsApi.get()
      if (res.success && res.data) {
        form.setFieldsValue(res.data)
        setCurrentProvider(res.data['ai.provider'] || 'gemini-oauth')
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  const fetchOAuthStatus = useCallback(async () => {
    setOauthLoading(true)
    try {
      const res = await settingsApi.getOAuthStatus()
      if (res.success && res.data) {
        setOauthStatus(res.data.providers)
        setCurrentProvider(res.data.currentProvider)
      }
    } catch {
      message.error('無法取得 OAuth 狀態')
    } finally {
      setOauthLoading(false)
    }
  }, [])

  const fetchTunnelStatus = useCallback(async () => {
    setTunnelLoading(true)
    try {
      const res = await tunnelApi.status()
      if (res.data) {
        setTunnelStatus(res.data)
        // 載入模式
        setTunnelMode((res.data.mode as TunnelMode) || 'fixed')
        // 載入自訂域名資訊
        if (res.data.customDomain) {
          setCustomDomain(res.data.customDomain)
        }
        setCustomWebhookUrls(res.data.customWebhookUrls || null)
        // 如果 tunnel 正在運行，檢查健康狀態
        if (res.data.isRunning) {
          const healthRes = await tunnelApi.health()
          if (healthRes.data) {
            setTunnelHealth(healthRes.data)
          }
        } else {
          setTunnelHealth(null)
        }
      }
    } catch {
      // ignore
    } finally {
      setTunnelLoading(false)
    }
  }, [])

  const handleTunnelStart = async () => {
    setTunnelActionLoading(true)
    try {
      const res = await tunnelApi.start()
      if (res.data?.success) {
        message.success('Tunnel 已啟動')
        fetchTunnelStatus()
      } else {
        message.error(res.data?.error || '啟動失敗')
      }
    } catch {
      message.error('啟動失敗')
    } finally {
      setTunnelActionLoading(false)
    }
  }

  const handleTunnelStop = async () => {
    setTunnelActionLoading(true)
    try {
      const res = await tunnelApi.stop()
      if (res.data?.success) {
        message.success('Tunnel 已停止')
        setTunnelStatus(null)
        setTunnelHealth(null)
      }
    } catch {
      message.error('停止失敗')
    } finally {
      setTunnelActionLoading(false)
    }
  }

  const handleTunnelRestart = async () => {
    setTunnelActionLoading(true)
    try {
      const res = await tunnelApi.restart()
      if (res.data?.success) {
        message.success('Tunnel 已重啟，新 URL 已生成')
        fetchTunnelStatus()
      } else {
        message.error(res.data?.error || '重啟失敗')
      }
    } catch {
      message.error('重啟失敗')
    } finally {
      setTunnelActionLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    message.success('已複製到剪貼簿')
  }

  const handleSaveCustomDomain = async () => {
    const trimmed = customDomain.trim()
    if (trimmed && !trimmed.startsWith('https://')) {
      message.error('域名必須以 https:// 開頭')
      return
    }
    if (trimmed.endsWith('/')) {
      message.error('域名結尾不可以有 /')
      return
    }
    setCustomDomainSaving(true)
    try {
      const res = await tunnelApi.updateCustomDomain(trimmed)
      if (res.success && res.data) {
        message.success('固定域名已儲存')
        setCustomDomain(res.data.customDomain)
        setCustomWebhookUrls(res.data.customWebhookUrls)
      } else {
        message.error((res.error as any)?.message || '儲存失敗')
      }
    } catch {
      message.error('儲存失敗')
    } finally {
      setCustomDomainSaving(false)
    }
  }

  const handleModeChange = async (newMode: TunnelMode) => {
    setModeSaving(true)
    try {
      const res = await tunnelApi.updateMode(
        newMode,
        newMode === 'fixed' ? cloudflareToken : undefined
      )
      if (res.success) {
        setTunnelMode(newMode)
        const data = res.data as any
        if (data?.started) {
          message.success(`已切換至${newMode === 'fixed' ? '固定域名' : '快速隧道'}模式並啟動`)
        } else {
          message.warning(`已切換至${newMode === 'fixed' ? '固定域名' : '快速隧道'}模式，但啟動失敗: ${data?.error || '未知錯誤'}`)
        }
        fetchTunnelStatus()
      }
    } catch {
      message.error('切換失敗')
    } finally {
      setModeSaving(false)
    }
  }

  const fetchLineStatus = useCallback(async () => {
    setLineStatusLoading(true)
    try {
      const res = await settingsApi.checkLineStatus()
      if (res.data) {
        setLineStatus(res.data)
      }
    } catch {
      // ignore
    } finally {
      setLineStatusLoading(false)
    }
  }, [])

  const fetchFeishuStatus = useCallback(async () => {
    setFeishuLoading(true)
    try {
      const res = await settingsApi.checkFeishuStatus()
      if (res.data) {
        setFeishuStatus(res.data)
      }
    } catch {
      // ignore
    } finally {
      setFeishuLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchOAuthStatus()
    fetchTunnelStatus()
    fetchLineStatus()
    fetchFeishuStatus()
  }, [fetchOAuthStatus, fetchTunnelStatus, fetchLineStatus, fetchFeishuStatus])

  const handleSave = async (values: Record<string, string>) => {
    setSaving(true)
    try {
      // 過濾掉被遮蔽的值（含有 ********）
      const filtered = Object.entries(values).reduce(
        (acc, [key, value]) => {
          if (value && !value.includes('********')) {
            acc[key] = value
          }
          return acc
        },
        {} as Record<string, string>
      )

      const res = await settingsApi.update(filtered)
      if (res.success) {
        message.success('儲存成功')
        fetchData()
        // 如果更改了 AI provider，重新檢查 OAuth 狀態
        if (filtered['ai.provider']) {
          fetchOAuthStatus()
        }
        // 如果更改了 LINE 設定，重新檢查連接狀態
        if (filtered['line.channelSecret'] || filtered['line.channelAccessToken']) {
          fetchLineStatus()
        }
        // 如果更改了飛書設定，重新檢查連接狀態
        if (filtered['feishu.appId'] || filtered['feishu.appSecret'] || filtered['feishu.enabled']) {
          fetchFeishuStatus()
        }
      } else {
        message.error(res.error?.message || '儲存失敗')
      }
    } catch {
      message.error('儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  const copyCommand = (command: string) => {
    navigator.clipboard.writeText(command)
    message.success('已複製到剪貼簿')
  }

  const renderOAuthStatus = (provider: string) => {
    const status = oauthStatus.find((s) => s.provider === provider)
    if (!status) return null

    const isCurrentProvider = currentProvider === provider

    return (
      <Alert
        type={status.valid ? 'success' : 'warning'}
        showIcon
        icon={status.valid ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
        message={
          <Space>
            <span>{status.message}</span>
            {isCurrentProvider && <Tag color="blue">目前使用中</Tag>}
          </Space>
        }
        description={
          !status.valid && status.refreshCommand && (
            <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
              <Text type="secondary">請在終端機執行以下指令進行授權：</Text>
              <Paragraph
                code
                copyable={{ text: status.refreshCommand }}
                style={{ margin: 0, padding: '8px 12px', background: '#f5f5f5', borderRadius: 4 }}
              >
                {status.refreshCommand}
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 12 }}>
                執行後會自動打開瀏覽器完成 Google 帳號登入，授權完成後點擊「檢查狀態」按鈕
              </Text>
            </Space>
          )
        }
        action={
          <Space direction="vertical">
            <Tooltip title="重新檢查授權狀態">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={fetchOAuthStatus}
                loading={oauthLoading}
              >
                檢查狀態
              </Button>
            </Tooltip>
            {!status.valid && status.refreshCommand && (
              <Tooltip title="複製授權指令">
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyCommand(status.refreshCommand!)}
                >
                  複製指令
                </Button>
              </Tooltip>
            )}
          </Space>
        }
        style={{ marginBottom: 16 }}
      />
    )
  }

  return (
    <Card title="系統設定" loading={loading}>
      <Form form={form} layout="vertical" onFinish={handleSave} disabled={!hasPermission('setting.edit')}>
        <Divider orientation="left">LINE 設定</Divider>

        {lineStatusLoading ? (
          <Spin tip="檢查 LINE 連接狀態..." style={{ display: 'block', marginBottom: 16 }} />
        ) : lineStatus && (
          <Alert
            type={lineStatus.connected ? 'success' : 'error'}
            showIcon
            icon={lineStatus.connected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            message={lineStatus.message}
            action={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={fetchLineStatus}
              >
                檢查狀態
              </Button>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        <Form.Item name="line.channelSecret" label="Channel Secret">
          <Input.Password placeholder="留空則不更新" />
        </Form.Item>
        <Form.Item name="line.channelAccessToken" label="Channel Access Token">
          <Input.Password placeholder="留空則不更新" />
        </Form.Item>

        <Divider orientation="left">飛書 (Feishu) 設定</Divider>
        <Form.Item
          name="feishu.enabled"
          label="啟用飛書渠道"
          valuePropName="checked"
          getValueFromEvent={(checked) => checked ? 'true' : 'false'}
          getValueProps={(value) => ({ checked: value === 'true' })}
        >
          <Switch checkedChildren="啟用" unCheckedChildren="停用" />
        </Form.Item>

        {feishuLoading ? (
          <Spin tip="檢查飛書連接狀態..." style={{ display: 'block', marginBottom: 16 }} />
        ) : feishuStatus && (
          <Alert
            type={feishuStatus.connected ? 'success' : 'warning'}
            showIcon
            icon={feishuStatus.connected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            message={feishuStatus.message}
            action={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={fetchFeishuStatus}
              >
                檢查狀態
              </Button>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        <Form.Item name="feishu.appId" label="App ID">
          <Input placeholder="飛書開放平台 App ID" />
        </Form.Item>
        <Form.Item name="feishu.appSecret" label="App Secret">
          <Input.Password placeholder="留空則不更新" />
        </Form.Item>
        <Form.Item
          name="feishu.verificationToken"
          label="Verification Token"
          extra="用於驗證 Webhook 請求（可選）"
        >
          <Input.Password placeholder="留空則不更新" />
        </Form.Item>
        <Form.Item
          name="feishu.encryptKey"
          label="Encrypt Key"
          extra="用於解密加密消息（可選，如開啟加密需填寫）"
        >
          <Input.Password placeholder="留空則不更新" />
        </Form.Item>

        <Alert
          type="info"
          message="飛書 Webhook 配置說明"
          description={
            <Space direction="vertical" size="small">
              <Text>1. 在飛書開放平台創建應用，獲取 App ID 和 App Secret</Text>
              <Text>2. 配置事件訂閱，Webhook URL 為：</Text>
              <Text code copyable>{tunnelStatus?.url ? `${tunnelStatus.url}/api/webhook/feishu` : '(請先啟動 Tunnel)'}</Text>
              <Text>3. 訂閱「接收消息」事件 (im.message.receive_v1)</Text>
              <Text>4. 發布應用版本並開通相關權限</Text>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />

        <Form.Item
          name="feishu.wikiSpaceId"
          label="飛書知識空間 ID (Space ID)"
          extra="用於同步飛書知識庫。在飛書知識庫 URL 中可以找到：https://xxx.feishu.cn/wiki/{spaceId}/..."
        >
          <Input placeholder="輸入飛書知識空間 ID（在知識庫頁面進行同步操作）" />
        </Form.Item>

        <Form.Item
          name="feishu.wikiNodeToken"
          label="節點 Token (可選)"
          extra="如果只想同步特定節點下的文檔，可以填寫節點 Token。留空則同步整個知識空間。"
        >
          <Input placeholder="輸入節點 Token（可選）" />
        </Form.Item>

        <Divider orientation="left">AI 設定</Divider>

        <Form.Item name="ai.provider" label="AI Provider">
          <Select
            options={[
              { value: 'gemini-oauth', label: 'Gemini CLI OAuth (免費) - 推薦' },
              { value: 'claude-code-oauth', label: 'Claude Code OAuth (CLI)' },
              { value: 'claude', label: 'Claude (API Key)' },
              { value: 'gemini', label: 'Gemini (API Key)' },
              { value: 'ollama', label: 'Ollama (本地)' },
            ]}
            onChange={(value) => setCurrentProvider(value)}
          />
        </Form.Item>

        {/* OAuth 狀態顯示 */}
        {oauthLoading ? (
          <Spin tip="檢查 OAuth 狀態..." style={{ display: 'block', marginBottom: 16 }} />
        ) : (
          <>
            {(currentProvider === 'gemini-oauth' || form.getFieldValue('ai.provider') === 'gemini-oauth') &&
              renderOAuthStatus('gemini-oauth')}
            {(currentProvider === 'claude-code-oauth' || form.getFieldValue('ai.provider') === 'claude-code-oauth') &&
              renderOAuthStatus('claude-code-oauth')}
          </>
        )}


        {/* Claude 設定 */}
        <Form.Item name="ai.claude.apiKey" label="Claude API Key">
          <Input.Password placeholder="留空則不更新 (僅 Claude API Key 模式需要)" />
        </Form.Item>
        <Form.Item name="ai.claude.model" label="Claude Model">
          <Select
            options={[
              { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
              { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
              { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
              { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
            ]}
            allowClear
            placeholder="使用預設模型"
          />
        </Form.Item>

        {/* Gemini 設定 */}
        <Form.Item name="ai.gemini.apiKey" label="Gemini API Key">
          <Input.Password placeholder="留空則不更新 (僅 Gemini API Key 模式需要)" />
        </Form.Item>
        <Form.Item name="ai.gemini.model" label="Gemini Model">
          <Select
            options={[
              { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash - 推薦' },
              { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
              { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
              { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
            ]}
          />
        </Form.Item>

        {/* Ollama 設定 */}
        <Form.Item name="ai.ollama.baseUrl" label="Ollama Base URL">
          <Input placeholder="http://localhost:11434" />
        </Form.Item>
        <Form.Item name="ai.ollama.model" label="Ollama Model">
          <Input placeholder="llama3" />
        </Form.Item>

        <Divider orientation="left">自動回覆設定</Divider>
        <Alert
          icon={<RobotOutlined />}
          type="info"
          message="自動回覆功能"
          description="啟用後，系統會自動偵測用戶提問並追蹤。當知識庫匹配信心度達到閾值時會自動回覆；低於閾值時不會回覆（除非提及 Bot 名稱）。所有偵測到的問題都會記錄到問題追蹤中，方便後續跟進。"
          style={{ marginBottom: 16 }}
          showIcon
        />
        <Form.Item
          name="bot.autoReply"
          label="啟用自動回覆"
          valuePropName="checked"
          getValueFromEvent={(checked) => checked ? 'true' : 'false'}
          getValueProps={(value) => ({ checked: value === 'true' })}
        >
          <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
        </Form.Item>
        <Form.Item
          name="bot.name"
          label="Bot 名稱"
          extra="設定 Bot 的名稱（多個名稱用逗號分隔）。當用戶訊息提及此名稱時，即使信心度較低也會強制回覆。"
        >
          <Input placeholder="例如：小助手,助理,小幫手" />
        </Form.Item>
        <Form.Item
          name="bot.confidenceThreshold"
          label="信心度閾值"
          extra="只有當知識庫匹配信心度達到此閾值時才會自動回覆（0-100）。低於閾值但被提及名稱時仍會回覆。"
        >
          <Input type="number" min={0} max={100} placeholder="50" />
        </Form.Item>
        <Form.Item
          name="bot.notFoundReply"
          label="無法回答時的回覆"
          extra="當知識庫中找不到匹配答案時，會回覆此訊息"
        >
          <Input.TextArea
            rows={2}
            placeholder="抱歉，我目前無法回答這個問題。請稍候，會有專人為您服務。"
          />
        </Form.Item>

        <Divider orientation="left">問題追蹤設定</Divider>
        <Form.Item name="issue.timeoutMinutes" label="超時時間（分鐘）">
          <Input type="number" />
        </Form.Item>
        <Form.Item name="issue.replyThreshold" label="回覆相關性閾值">
          <Input type="number" />
        </Form.Item>

        <Divider orientation="left">
          <Space>
            <CloudOutlined />
            Webhook 設定
          </Space>
        </Divider>
        <Alert
          icon={<LinkOutlined />}
          type="info"
          message="Webhook 連結管理"
          description="透過 Cloudflare Tunnel 建立外部可訪問的 Webhook URL。可選擇「固定域名」（需 Cloudflare Tunnel Token）或「快速隧道」（每次重啟獲得新 URL）。"
          style={{ marginBottom: 16 }}
          showIcon
        />

        <Card size="small" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Text strong>模式：</Text>
              <Segmented
                value={tunnelMode}
                options={[
                  { value: 'fixed', label: '固定域名' },
                  { value: 'quick', label: '快速隧道' },
                ]}
                onChange={(value) => handleModeChange(value as TunnelMode)}
                disabled={modeSaving || !hasPermission('setting.edit')}
              />
              {modeSaving && <Spin size="small" />}
            </Space>

            <Divider style={{ margin: '12px 0' }} />

            {tunnelLoading ? (
              <Spin tip="檢查 Tunnel 狀態..." style={{ display: 'block' }} />
            ) : tunnelMode === 'fixed' ? (
              /* Fixed 模式 */
              <Space direction="vertical" style={{ width: '100%' }}>
                <Text strong>Cloudflare Tunnel Token：</Text>
                <Space.Compact style={{ width: '100%' }}>
                  <Input.Password
                    value={cloudflareToken}
                    onChange={(e) => setCloudflareToken(e.target.value)}
                    placeholder="輸入 Cloudflare Tunnel Token"
                    style={{ fontFamily: 'monospace' }}
                    disabled={!hasPermission('setting.edit')}
                  />
                  <Button
                    icon={<SaveOutlined />}
                    onClick={async () => {
                      if (!cloudflareToken) {
                        message.error('Token 不可為空')
                        return
                      }
                      setModeSaving(true)
                      try {
                        await tunnelApi.updateMode('fixed', cloudflareToken)
                        message.success('Token 已儲存')
                      } catch {
                        message.error('儲存失敗')
                      } finally {
                        setModeSaving(false)
                      }
                    }}
                    loading={modeSaving}
                    disabled={!hasPermission('setting.edit')}
                  >
                    儲存
                  </Button>
                </Space.Compact>
                {tunnelStatus?.hasToken && !cloudflareToken && (
                  <Text type="secondary" style={{ fontSize: 12 }}>Token 已設定（已隱藏）</Text>
                )}

                <Text strong style={{ marginTop: 8 }}>固定域名：</Text>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="https://bot.example.com"
                    style={{ fontFamily: 'monospace' }}
                    disabled={!hasPermission('setting.edit')}
                  />
                  <Button
                    icon={<SaveOutlined />}
                    onClick={handleSaveCustomDomain}
                    loading={customDomainSaving}
                    disabled={!hasPermission('setting.edit')}
                  >
                    儲存
                  </Button>
                </Space.Compact>

                {customWebhookUrls && (
                  <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                    <Text strong>LINE Webhook URL：</Text>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input value={customWebhookUrls.line} readOnly style={{ fontFamily: 'monospace' }} />
                      <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(customWebhookUrls.line)}>
                        複製
                      </Button>
                    </Space.Compact>

                    <Text strong>飛書 Webhook URL：</Text>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input value={customWebhookUrls.feishu} readOnly style={{ fontFamily: 'monospace' }} />
                      <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(customWebhookUrls.feishu)}>
                        複製
                      </Button>
                    </Space.Compact>
                  </Space>
                )}

                <Divider style={{ margin: '12px 0' }} />

                <Space>
                  <Text strong>狀態：</Text>
                  {tunnelStatus?.isRunning ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>運行中</Tag>
                  ) : (
                    <Tag color="default" icon={<PoweroffOutlined />}>已停止</Tag>
                  )}
                  {tunnelHealth && (
                    tunnelHealth.isValid ? (
                      <Tag color="success">連線正常 ({tunnelHealth.latency}ms)</Tag>
                    ) : (
                      <Tag color="error">連線失敗: {tunnelHealth.error}</Tag>
                    )
                  )}
                </Space>

                {tunnelStatus?.error && (
                  <Alert type="error" message={tunnelStatus.error} style={{ marginTop: 8 }} />
                )}

                <Space style={{ marginTop: 8 }}>
                  {tunnelStatus?.isRunning ? (
                    <Button
                      danger
                      icon={<PoweroffOutlined />}
                      onClick={handleTunnelStop}
                      loading={tunnelActionLoading}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      type="primary"
                      icon={<CloudOutlined />}
                      onClick={handleTunnelStart}
                      loading={tunnelActionLoading}
                    >
                      啟動 Tunnel
                    </Button>
                  )}
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={fetchTunnelStatus}
                    loading={tunnelLoading}
                  >
                    檢查狀態
                  </Button>
                </Space>
              </Space>
            ) : (
              /* Quick 模式 */
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                  <Text strong>狀態：</Text>
                  {tunnelStatus?.isRunning ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>運行中</Tag>
                  ) : (
                    <Tag color="default" icon={<PoweroffOutlined />}>已停止</Tag>
                  )}
                  {tunnelHealth && (
                    tunnelHealth.isValid ? (
                      <Tag color="success">連線正常 ({tunnelHealth.latency}ms)</Tag>
                    ) : (
                      <Tag color="error">連線失敗: {tunnelHealth.error}</Tag>
                    )
                  )}
                </Space>

                {tunnelStatus?.webhookUrl ? (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Text strong>Webhook URL：</Text>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input value={tunnelStatus.webhookUrl} readOnly style={{ fontFamily: 'monospace' }} />
                      <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(tunnelStatus.webhookUrl!)}>
                        複製
                      </Button>
                    </Space.Compact>
                    {tunnelStatus.startedAt && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        啟動時間：{new Date(tunnelStatus.startedAt).toLocaleString()}
                      </Text>
                    )}
                  </Space>
                ) : tunnelStatus?.lastQuickUrl && (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Text strong>上次 Webhook URL：</Text>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input
                        value={`${tunnelStatus.lastQuickUrl}/api/webhook/line`}
                        readOnly
                        style={{ fontFamily: 'monospace', opacity: 0.6 }}
                      />
                      <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(`${tunnelStatus.lastQuickUrl}/api/webhook/line`)}>
                        複製
                      </Button>
                    </Space.Compact>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      上次使用的 URL（服務重啟後會自動重新建立隧道）
                    </Text>
                  </Space>
                )}

                {tunnelStatus?.error && (
                  <Alert type="error" message={tunnelStatus.error} style={{ marginTop: 8 }} />
                )}

                <Space style={{ marginTop: 8 }}>
                  {tunnelStatus?.isRunning ? (
                    <>
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={handleTunnelRestart}
                        loading={tunnelActionLoading}
                      >
                        重新獲取 URL
                      </Button>
                      <Button
                        danger
                        icon={<PoweroffOutlined />}
                        onClick={handleTunnelStop}
                        loading={tunnelActionLoading}
                      >
                        停止
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="primary"
                      icon={<CloudOutlined />}
                      onClick={handleTunnelStart}
                      loading={tunnelActionLoading}
                    >
                      啟動 Tunnel
                    </Button>
                  )}
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={fetchTunnelStatus}
                    loading={tunnelLoading}
                  >
                    檢查狀態
                  </Button>
                </Space>

                <Alert
                  type="info"
                  message="快速隧道會在服務重啟時自動啟動。URL 可能會改變，系統會保存最近一次的 URL。"
                  style={{ marginTop: 8 }}
                />
              </Space>
            )}
          </Space>
        </Card>

        {hasPermission('setting.edit') && (
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving}>
              儲存設定
            </Button>
          </Form.Item>
        )}
      </Form>
    </Card>
  )
}
