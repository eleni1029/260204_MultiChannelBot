import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Table, Tag, Select, Space, Button, Popconfirm, message, Dropdown } from 'antd'
import { DeleteOutlined, DownOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { MenuProps } from 'antd'
import { issuesApi, type Channel } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { ChannelTag } from '@/components/ChannelTag'

interface Issue {
  id: number
  questionSummary: string | null
  status: string
  sentiment: string | null
  replyRelevanceScore: number | null
  group: { id: number; displayName: string; channel: Channel; customer: { name: string } | null }
  triggerMessage: { member: { displayName: string } } | null
  repliedBy: { displayName: string } | null
  createdAt: string
  repliedAt: string | null
}

export function IssueList() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | undefined>()
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([])
  const navigate = useNavigate()
  const hasPermission = useAuthStore((state) => state.hasPermission)

  const fetchData = async (page = 1) => {
    setLoading(true)
    try {
      const res = await issuesApi.list({ page, pageSize: 20, status })
      if (res.success && res.data) {
        setIssues(res.data as Issue[])
        if (res.pagination) {
          setPagination({
            current: res.pagination.page,
            pageSize: res.pagination.pageSize,
            total: res.pagination.total,
          })
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [status])

  const handleDelete = async (id: number) => {
    try {
      const res = await issuesApi.delete(id)
      if (res.success) {
        message.success('刪除成功')
        fetchData(pagination.current)
      } else {
        message.error(res.error?.message || '刪除失敗')
      }
    } catch {
      message.error('刪除失敗')
    }
  }

  const handleBatchDelete = async () => {
    if (selectedRowKeys.length === 0) return

    try {
      const res = await issuesApi.batchDelete(selectedRowKeys)
      if (res.success) {
        message.success(`成功刪除 ${res.data?.deleted || selectedRowKeys.length} 個問題`)
        setSelectedRowKeys([])
        fetchData(1)
      } else {
        message.error(res.error?.message || '刪除失敗')
      }
    } catch {
      message.error('刪除失敗')
    }
  }

  const handleBatchUpdateStatus = async (newStatus: string) => {
    if (selectedRowKeys.length === 0) return

    try {
      const res = await issuesApi.batchUpdateStatus(selectedRowKeys, newStatus)
      if (res.success) {
        message.success(`成功更新 ${res.data?.updated || selectedRowKeys.length} 個問題狀態`)
        setSelectedRowKeys([])
        fetchData(pagination.current)
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

  const statusLabels: Record<string, string> = {
    PENDING: '待回覆',
    REPLIED: '已回覆',
    WAITING_CUSTOMER: '等待客戶',
    TIMEOUT: '超時',
    RESOLVED: '已解決',
    IGNORED: '已忽略',
  }

  const batchStatusMenuItems: MenuProps['items'] = [
    { key: 'PENDING', label: '設為待回覆' },
    { key: 'REPLIED', label: '設為已回覆' },
    { key: 'WAITING_CUSTOMER', label: '設為等待客戶' },
    { key: 'RESOLVED', label: '設為已解決' },
    { key: 'IGNORED', label: '設為已忽略' },
  ]

  const columns: ColumnsType<Issue> = [
    {
      title: '渠道',
      dataIndex: ['group', 'channel'],
      key: 'channel',
      width: 80,
      render: (channel) => <ChannelTag channel={channel || 'LINE'} />,
    },
    {
      title: '問題摘要',
      dataIndex: 'questionSummary',
      key: 'questionSummary',
      ellipsis: true,
      render: (text, record) => (
        <a onClick={() => navigate(`/issues/${record.id}`)}>{text || '(無摘要)'}</a>
      ),
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s) => <Tag color={statusColors[s]}>{statusLabels[s]}</Tag>,
    },
    {
      title: '提問者',
      dataIndex: 'triggerMessage',
      key: 'asker',
      render: (msg) => msg?.member?.displayName || '-',
    },
    {
      title: '回覆者',
      dataIndex: 'repliedBy',
      key: 'repliedBy',
      render: (member, record) => {
        if (member?.displayName) return member.displayName
        // 如果狀態是已回覆但沒有回覆者，表示是 Bot 回覆
        if (record.status === 'REPLIED' && !member) return 'Bot'
        return '-'
      },
    },
    {
      title: '回覆分數',
      dataIndex: 'replyRelevanceScore',
      key: 'score',
      width: 100,
      render: (score) => (score !== null ? score : '-'),
    },
    {
      title: '群聊',
      dataIndex: 'group',
      key: 'group',
      render: (group) => group.displayName || '(未命名)',
    },
    {
      title: '建立時間',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (t) => new Date(t).toLocaleString(),
    },
  ]

  // 添加操作列（如果有權限）
  if (hasPermission('issue.edit')) {
    columns.push({
      title: '操作',
      key: 'action',
      width: 80,
      render: (_, record) => (
        <Popconfirm
          title="確定要刪除此問題嗎？"
          onConfirm={() => handleDelete(record.id)}
          okText="確定"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Button type="link" danger size="small" icon={<DeleteOutlined />}>
            刪除
          </Button>
        </Popconfirm>
      ),
    })
  }

  const rowSelection = hasPermission('issue.edit')
    ? {
        selectedRowKeys,
        onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as number[]),
      }
    : undefined

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Space>
          <span>狀態：</span>
          <Select
            value={status}
            onChange={setStatus}
            allowClear
            placeholder="全部"
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
        </Space>

        {hasPermission('issue.edit') && selectedRowKeys.length > 0 && (
          <Space>
            <Dropdown
              menu={{
                items: batchStatusMenuItems,
                onClick: ({ key }) => handleBatchUpdateStatus(key),
              }}
            >
              <Button>
                批量更新狀態 ({selectedRowKeys.length}) <DownOutlined />
              </Button>
            </Dropdown>

            <Popconfirm
              title={`確定要刪除選中的 ${selectedRowKeys.length} 個問題嗎？`}
              onConfirm={handleBatchDelete}
              okText="確定刪除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />}>
                批量刪除
              </Button>
            </Popconfirm>
          </Space>
        )}
      </div>

      <Table
        columns={columns}
        dataSource={issues}
        rowKey="id"
        loading={loading}
        rowSelection={rowSelection}
        pagination={{
          ...pagination,
          onChange: (page) => fetchData(page),
        }}
      />
    </div>
  )
}
