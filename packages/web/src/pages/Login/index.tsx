import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'

interface LoginForm {
  username: string
  password: string
}

export function Login() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const setAuth = useAuthStore((state) => state.setAuth)

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    try {
      const res = await authApi.login(values.username, values.password)
      if (res.success && res.data) {
        const { accessToken, user } = res.data as { accessToken: string; user: any }
        setAuth(accessToken, user)
        message.success('登入成功')
        navigate('/')
      } else {
        message.error(res.error?.message || '登入失敗')
      }
    } catch {
      message.error('登入失敗')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card title="渠道觀察者" style={{ width: 400 }}>
        <Form name="login" onFinish={onFinish} autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: '請輸入帳號' }]}>
            <Input prefix={<UserOutlined />} placeholder="帳號" size="large" />
          </Form.Item>

          <Form.Item name="password" rules={[{ required: true, message: '請輸入密碼' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密碼" size="large" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              登入
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
