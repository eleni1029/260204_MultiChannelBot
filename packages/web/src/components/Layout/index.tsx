import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout as AntLayout, Menu, Avatar, Dropdown, Button } from 'antd'
import type { MenuProps } from 'antd'
import {
  DashboardOutlined,
  TeamOutlined,
  MessageOutlined,
  QuestionCircleOutlined,
  UserOutlined,
  SafetyOutlined,
  SettingOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  CommentOutlined,
  UsergroupAddOutlined,
  BookOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/services/api'

const { Header, Sider, Content } = AntLayout

const menuItems: MenuProps['items'] = [
  {
    key: '/dashboard',
    icon: <DashboardOutlined />,
    label: '儀表板',
  },
  {
    key: '/customers',
    icon: <TeamOutlined />,
    label: '客戶管理',
  },
  {
    key: '/groups',
    icon: <CommentOutlined />,
    label: '對話管理',
  },
  {
    key: '/members',
    icon: <UsergroupAddOutlined />,
    label: '人員管理',
  },
  {
    key: '/messages',
    icon: <MessageOutlined />,
    label: '訊息記錄',
  },
  {
    key: '/issues',
    icon: <QuestionCircleOutlined />,
    label: '問題追蹤',
  },
  {
    key: '/knowledge',
    icon: <BookOutlined />,
    label: '知識庫',
  },
  {
    type: 'divider',
  },
  {
    key: '/users',
    icon: <UserOutlined />,
    label: '用戶管理',
  },
  {
    key: '/roles',
    icon: <SafetyOutlined />,
    label: '角色權限',
  },
  {
    key: '/settings',
    icon: <SettingOutlined />,
    label: '系統設定',
  },
  {
    key: '/logs',
    icon: <FileTextOutlined />,
    label: '操作日誌',
  },
]

export function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    navigate(key)
  }

  const handleLogout = async () => {
    await authApi.logout()
    logout()
    navigate('/login')
  }

  const dropdownItems: MenuProps['items'] = [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '登出',
      onClick: handleLogout,
    },
  ]

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed} theme="light">
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <h2 style={{ margin: 0, fontSize: collapsed ? 14 : 16 }}>
            {collapsed ? '觀察者' : '渠道觀察者'}
          </h2>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <AntLayout>
        <Header
          style={{
            padding: '0 24px',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Dropdown menu={{ items: dropdownItems }} placement="bottomRight">
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar icon={<UserOutlined />} />
              <span>{user?.displayName || user?.username}</span>
            </div>
          </Dropdown>
        </Header>
        <Content style={{ margin: 24, background: '#fff', padding: 24, borderRadius: 8 }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}
