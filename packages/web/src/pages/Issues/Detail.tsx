import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Card, Descriptions, Tag, Button, Select, message } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { issuesApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'

interface Issue {
  id: number
  questionSummary: string | null
  status: string
  isQuestion: boolean
  replyRelevanceScore: number | null
  sentiment: string | null
  suggestedReply: string | null
  group: { id: number; displayName: string }
  customer: { id: number; name: string } | null
  triggerMessage: { content: string; member: { displayName: string }; createdAt: string } | null
  replyMessage: { content: string; member: { displayName: string }; createdAt: string } | null
  repliedBy: { displayName: string } | null
  tags: { tag: { name: string } }[]
  createdAt: string
  repliedAt: string | null
  timeoutAt: string | null
}

export function IssueDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [loading, setLoading] = useState(false)
  const hasPermission = useAuthStore((state) => state.hasPermission)

  const fetchData = async () => {
    if (!id) return
    setLoading(true)
    try {
      const res = await issuesApi.get(parseInt(id))
      if (res.success) setIssue(res.data as Issue)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [id])

  const handleStatusChange = async (status: string) => {
    if (!id) return
    try {
      const res = await issuesApi.update(parseInt(id), { status })
      if (res.success) {
        message.success('更新成功')
        fetchData()
      } else {
        message.error(res.error?.message || '更新失敗')
      }
    } catch {
      message.error('更新失敗')
    }
  }

  const statusColors: Record<string, string> = {
    PENDING: 'gold',
    REPLIED: 'green',
    WAITING_CUSTOMER: 'blue',
    TIMEOUT: 'red',
    RESOLVED: 'default',
    IGNORED: 'default',
  }

  if (loading || !issue) {
    return <Card loading={loading} />
  }

  return (
    <div>
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/issues')} style={{ marginBottom: 16 }}>
        返回
      </Button>

      <Card title="問題詳情">
        <Descriptions column={2}>
          <Descriptions.Item label="問題摘要" span={2}>
            {issue.questionSummary || '(無)'}
          </Descriptions.Item>
          <Descriptions.Item label="狀態">
            {hasPermission('issue.edit') ? (
              <Select
                value={issue.status}
                onChange={handleStatusChange}
                style={{ width: 150 }}
                options={[
                  { value: 'PENDING', label: '待回覆' },
                  { value: 'REPLIED', label: '已回覆' },
                  { value: 'WAITING_CUSTOMER', label: '等待客戶' },
                  { value: 'TIMEOUT', label: '超時' },
                  { value: 'RESOLVED', label: '已解決' },
                  { value: 'IGNORED', label: '已忽略' },
                ]}
              />
            ) : (
              <Tag color={statusColors[issue.status]}>{issue.status}</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="情緒">
            {issue.sentiment ? <Tag>{issue.sentiment}</Tag> : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="回覆相關性分數">
            {issue.replyRelevanceScore ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="標籤">
            {issue.tags.map((t) => (
              <Tag key={t.tag.name}>{t.tag.name}</Tag>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="群聊">
            <a onClick={() => navigate(`/groups/${issue.group.id}`)}>
              {issue.group.displayName || '(未命名)'}
            </a>
          </Descriptions.Item>
          <Descriptions.Item label="客戶">
            {issue.customer ? (
              <a onClick={() => navigate(`/customers/${issue.customer!.id}`)}>{issue.customer.name}</a>
            ) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="建立時間">
            {new Date(issue.createdAt).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="預計超時">
            {issue.timeoutAt ? new Date(issue.timeoutAt).toLocaleString() : '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="原始訊息" style={{ marginTop: 16 }}>
        {issue.triggerMessage ? (
          <Descriptions column={1}>
            <Descriptions.Item label="發送者">
              {issue.triggerMessage.member.displayName}
            </Descriptions.Item>
            <Descriptions.Item label="時間">
              {new Date(issue.triggerMessage.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="內容">
              {issue.triggerMessage.content}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <p>無原始訊息</p>
        )}
      </Card>

      <Card title="回覆訊息" style={{ marginTop: 16 }}>
        {issue.replyMessage ? (
          <Descriptions column={1}>
            <Descriptions.Item label="回覆者">
              {issue.replyMessage.member.displayName}
            </Descriptions.Item>
            <Descriptions.Item label="時間">
              {new Date(issue.replyMessage.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="內容">
              {issue.replyMessage.content}
            </Descriptions.Item>
          </Descriptions>
        ) : issue.status === 'REPLIED' && issue.suggestedReply ? (
          <Descriptions column={1}>
            <Descriptions.Item label="回覆者">
              <Tag color="blue">Bot</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="時間">
              {issue.repliedAt ? new Date(issue.repliedAt).toLocaleString() : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="內容">
              {issue.suggestedReply}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <p>尚無回覆</p>
        )}
      </Card>

      {issue.suggestedReply && (
        <Card title="AI 建議回覆" style={{ marginTop: 16 }}>
          <p>{issue.suggestedReply}</p>
        </Card>
      )}
    </div>
  )
}
