import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useKibana } from '../context/KibanaContext'
import { getCloudProvider, getLoginUrl, isValidRegion } from '../constants/pods'
import Toast from '../components/Toast'
import LoadingOverlay from '../components/LoadingOverlay'
import './LoginPage.css'

const TABS = [
  { id: 'standard',    label: 'Standard'    },
  { id: 'saml',        label: 'SAML'        },
  { id: 'oauth',       label: 'OAuth / JWT' },
  { id: 'salesforce',  label: 'Salesforce'  },
]

const ENDPOINTS = {
  standard:   '/api/auth/login',
  saml:       '/api/auth/login/saml',
  oauth:      '/api/auth/login/oauth',
  salesforce: '/api/auth/login/salesforce',
}

// ── Support Login ─────────────────────────────────────────────────────────
function SupportLoginForm() {
  const { connectKibana } = useKibana()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // stages: 'credentials' | 'push' | 'cookies'
  const [stage, setStage] = useState('credentials')
  const [kibanaData, setKibanaData] = useState(null)  // stored after push succeeds
  const [userSession, setUserSession] = useState('')
  const [xsrfToken, setXsrfToken] = useState('')
  const [toast, setToast] = useState(null)
  const dismissToast = useCallback(() => setToast(null), [])
  const pollingRef = useRef(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!username) { setError('Username is required.'); return }
    if (!password) { setError('Password is required.'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/kibana/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.detail || 'Login failed — check your credentials'
        setError(msg)
        setToast({ message: msg, type: 'error' })
        return
      }
      if (data.status === 'done') {
        setKibanaData(data)
        setStage('cookies')
      } else if (data.status === 'push_sent') {
        setStage('push')
        startPolling(data.stateHandle)
      }
    } catch {
      const msg = 'Cannot reach the backend — is it running?'
      setError(msg)
      setToast({ message: msg, type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  function startPolling(token) {
    if (pollingRef.current) return
    pollingRef.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/kibana/verify-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state_handle: token }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.detail || 'Push verification failed')
          setToast({ message: data.detail || 'Push rejected or timed out', type: 'error' })
          setStage('credentials')
        } else if (data.idmcAutoAuth) {
          // Auto IDMC SSO worked — go straight in, no manual paste needed
          connectKibana({
            sid:         data.sid,
            kibanaUrl:   data.kibanaUrl,
            kibanaSpace: data.kibanaSpace,
            userSession: data.userSession,
            xsrfToken:   data.xsrfToken,
          })
          navigate('/support/investigate')
        } else {
          // Auto SSO failed — ask user to paste cookies manually
          setKibanaData(data)
          setStage('cookies')
        }
      } catch {
        setError('Network error during MFA verification')
        setStage('credentials')
      } finally {
        pollingRef.current = false
      }
    })()
  }

  function handleCookieSubmit(e) {
    e.preventDefault()
    if (!userSession.trim()) { setError('USER_SESSION is required.'); return }
    if (!xsrfToken.trim())   { setError('XSRF_TOKEN is required.'); return }
    connectKibana({
      sid:         kibanaData.sid,
      kibanaUrl:   kibanaData.kibanaUrl,
      kibanaSpace: kibanaData.kibanaSpace,
      userSession: userSession.trim(),
      xsrfToken:   xsrfToken.trim(),
    })
    navigate('/support/investigate')
  }

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onClose={dismissToast} />}

      {stage === 'credentials' && (
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="support-info">
            <span className="support-info-icon">🔐</span>
            <p>Sign in with your <strong>Informatica corporate</strong> (Okta) account.<br />An Okta Verify push will be sent to your phone.</p>
          </div>
          <div className="form-group">
            <label htmlFor="sup-username">Informatica Email</label>
            <input
              id="sup-username" type="email" autoComplete="username"
              placeholder="you@informatica.com"
              value={username} onChange={(e) => { setUsername(e.target.value); setError('') }}
              disabled={loading}
            />
          </div>
          <div className="form-group">
            <label htmlFor="sup-password">Password</label>
            <input
              id="sup-password" type="password" autoComplete="current-password"
              placeholder="••••••••"
              value={password} onChange={(e) => { setPassword(e.target.value); setError('') }}
              disabled={loading}
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? <span className="spinner" /> : 'Sign In with Okta'}
          </button>
        </form>
      )}

      {stage === 'push' && (
        <div className="push-waiting">
          <div className="push-animation">
            <span className="push-icon">📱</span>
            <span className="push-ring" />
          </div>
          <p className="push-title">Check your phone</p>
          <p className="push-sub">An Okta Verify push notification has been sent.<br />Approve it to continue.</p>
          <p className="push-hint">Waiting for approval…</p>
          {error && <div className="login-error" style={{ marginTop: 16 }}>{error}</div>}
          <button
            className="login-btn"
            style={{ marginTop: 20, background: '#6b7280', fontSize: 13 }}
            onClick={() => { pollingRef.current = false; setStage('credentials'); setError('') }}
          >
            ← Cancel
          </button>
        </div>
      )}

      {stage === 'cookies' && (
        <form className="login-form" onSubmit={handleCookieSubmit} noValidate>
          <div className="support-info support-info-success">
            <span className="support-info-icon">✓</span>
            <p><strong>Kibana authenticated.</strong> Now paste your IDMC session cookies so the app can call the scheduler API on your behalf.</p>
          </div>
          <div className="support-cookie-steps">
            <p className="support-cookie-how">
              <strong>How to get these:</strong> In your browser, navigate to{' '}
              <code>use4.dm-us.informaticacloud.com</code> (or whatever pod the customer is on),
              open DevTools → Application → Cookies, and copy the values below.
            </p>
          </div>
          <div className="form-group">
            <label htmlFor="user-session">
              USER_SESSION
              <span className="field-hint">HttpOnly cookie from dm-us.informaticacloud.com</span>
            </label>
            <input
              id="user-session" type="password" autoComplete="off" spellCheck={false}
              placeholder="5yBkg6Es4ieeRUKKTIMOUu…"
              value={userSession} onChange={(e) => { setUserSession(e.target.value); setError('') }}
            />
          </div>
          <div className="form-group">
            <label htmlFor="xsrf-token">
              XSRF_TOKEN
              <span className="field-hint">Non-HttpOnly cookie from dm-us.informaticacloud.com</span>
            </label>
            <input
              id="xsrf-token" type="text" autoComplete="off" spellCheck={false}
              placeholder="ilzpZHfkVuaifRhO7Bbyed…"
              value={xsrfToken} onChange={(e) => { setXsrfToken(e.target.value); setError('') }}
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn">
            Enter Support Mode →
          </button>
          <button
            type="button"
            className="login-btn"
            style={{ background: '#6b7280', marginTop: 8, fontSize: 13 }}
            onClick={() => { setStage('credentials'); setError('') }}
          >
            ← Start Over
          </button>
        </form>
      )}
    </>
  )
}

// ── User Login (existing IICS tabs) ──────────────────────────────────────
function UserLoginForm() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [tab, setTab] = useState('standard')
  const [region, setRegion] = useState('')
  const [fields, setFields] = useState({
    username: '', password: '',
    samlToken: '', orgIdSaml: '',
    oauthToken: '', orgIdOauth: '',
    sfSessionId: '', sfServerUrl: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [toast, setToast] = useState(null)
  const dismissToast = useCallback(() => setToast(null), [])

  const trimmedRegion = region.trim().toLowerCase()
  const cloudProvider = isValidRegion(trimmedRegion) ? getCloudProvider(trimmedRegion) : null
  const loginUrl = isValidRegion(trimmedRegion) ? getLoginUrl(trimmedRegion) : ''

  function handleField(e) {
    setFields((f) => ({ ...f, [e.target.name]: e.target.value }))
    setError('')
  }

  function switchTab(id) { setTab(id); setError('') }

  function buildPayload() {
    switch (tab) {
      case 'standard':   return { username: fields.username, password: fields.password, loginUrl }
      case 'saml':       return { samlToken: fields.samlToken, orgId: fields.orgIdSaml, loginUrl }
      case 'oauth':      return { oauthToken: fields.oauthToken, orgId: fields.orgIdOauth, loginUrl }
      case 'salesforce': return { sfSessionId: fields.sfSessionId, sfServerUrl: fields.sfServerUrl, loginUrl }
    }
  }

  function validate() {
    if (!trimmedRegion) return 'Region is required.'
    if (!isValidRegion(trimmedRegion)) return 'Invalid region format. Examples: dm-us, dm1-em, dm2-us'
    switch (tab) {
      case 'standard':   if (!fields.username) return 'Username is required.'; if (!fields.password) return 'Password is required.'; break
      case 'saml':       if (!fields.samlToken) return 'SAML token is required.'; if (!fields.orgIdSaml) return 'Organisation ID is required.'; break
      case 'oauth':      if (!fields.oauthToken) return 'JWT access token is required.'; if (!fields.orgIdOauth) return 'Organisation ID is required.'; break
      case 'salesforce': if (!fields.sfSessionId) return 'Salesforce session ID is required.'; if (!fields.sfServerUrl) return 'Salesforce server URL is required.'; break
    }
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(ENDPOINTS[tab], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.detail || 'Login failed. Check your credentials.'
        setError(msg)
        setToast({ message: msg, type: 'error' })
        return
      }
      login({ ...data, regionLabel: trimmedRegion, cloudProvider })
      setToast({ message: `Welcome, ${data.firstName || data.name}! Login successful.`, type: 'success' })
      setTimeout(() => {
        setRedirecting(true)
        setTimeout(() => navigate('/app/dashboard'), 500)
      }, 2000)
    } catch {
      const msg = 'Unable to reach the server. Make sure the backend is running.'
      setError(msg)
      setToast({ message: msg, type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onClose={dismissToast} />}
      {redirecting && <LoadingOverlay message="Taking you to the dashboard..." />}

      {/* Region */}
      <div className="form-group region-row">
        <label htmlFor="region">Region</label>
        <input
          id="region" name="region" type="text"
          placeholder="e.g. dm-us, dm1-em, dm2-us"
          value={region} onChange={(e) => { setRegion(e.target.value); setError('') }}
          disabled={loading} spellCheck={false} autoComplete="off"
        />
        {cloudProvider && (
          <div className="pod-meta">
            <span className={`provider-badge provider-${cloudProvider.toLowerCase()}`}>{cloudProvider}</span>
            <span className="pod-url-hint">{loginUrl}</span>
          </div>
        )}
      </div>

      {/* Auth method tabs */}
      <div className="auth-tabs">
        {TABS.map((t) => (
          <button
            key={t.id} type="button"
            className={`auth-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => switchTab(t.id)} disabled={loading}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form className="login-form" onSubmit={handleSubmit} noValidate>
        {tab === 'standard' && (
          <>
            <div className="form-group">
              <label htmlFor="username">Username</label>
              <input id="username" name="username" type="email" autoComplete="username"
                placeholder="you@company.com" value={fields.username} onChange={handleField} disabled={loading} />
            </div>
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password"
                placeholder="••••••••" value={fields.password} onChange={handleField} disabled={loading} />
            </div>
          </>
        )}
        {tab === 'saml' && (
          <>
            <div className="form-group">
              <label htmlFor="orgIdSaml">Organisation ID</label>
              <input id="orgIdSaml" name="orgIdSaml" type="text"
                placeholder="e.g. 3FNFLs1uHe2IIgTs8tRjSJ" value={fields.orgIdSaml} onChange={handleField} disabled={loading} />
            </div>
            <div className="form-group">
              <label htmlFor="samlToken">SAML Token</label>
              <textarea id="samlToken" name="samlToken"
                placeholder="Paste your Base64-encoded SAML assertion here"
                value={fields.samlToken} onChange={handleField} disabled={loading} rows={4} />
              <span className="field-hint">Obtain this token from your identity provider after SSO login.</span>
            </div>
          </>
        )}
        {tab === 'oauth' && (
          <>
            <div className="form-group">
              <label htmlFor="orgIdOauth">Organisation ID</label>
              <input id="orgIdOauth" name="orgIdOauth" type="text"
                placeholder="e.g. 6xVpQpzHBAoizhbMOLzty9" value={fields.orgIdOauth} onChange={handleField} disabled={loading} />
            </div>
            <div className="form-group">
              <label htmlFor="oauthToken">JWT Access Token</label>
              <textarea id="oauthToken" name="oauthToken"
                placeholder="Paste your JWT access token here"
                value={fields.oauthToken} onChange={handleField} disabled={loading} rows={4} />
              <span className="field-hint">Obtain this token from your identity provider (IDP).</span>
            </div>
          </>
        )}
        {tab === 'salesforce' && (
          <>
            <div className="form-group">
              <label htmlFor="sfSessionId">Salesforce Session ID</label>
              <input id="sfSessionId" name="sfSessionId" type="text"
                placeholder="e.g. 00Df40000000coF!ARY..." value={fields.sfSessionId} onChange={handleField} disabled={loading} />
            </div>
            <div className="form-group">
              <label htmlFor="sfServerUrl">Salesforce Server URL</label>
              <input id="sfServerUrl" name="sfServerUrl" type="text"
                placeholder="e.g. https://c.na41.visual.force.com/services/Soap/..."
                value={fields.sfServerUrl} onChange={handleField} disabled={loading} />
              <span className="field-hint">Retrieve both values from the Salesforce Web Services API login response.</span>
            </div>
          </>
        )}
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-btn" disabled={loading}>
          {loading ? <span className="spinner" /> : 'Sign In'}
        </button>
      </form>
    </>
  )
}

// ── Main Login Page ───────────────────────────────────────────────────────
export default function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">⚡</div>
          <h1>INFA Schedule Monitor</h1>
          <p>Sign in with your Informatica IICS credentials</p>
        </div>

        <UserLoginForm />

        <p className="login-footer">Session is stored for this browser tab only.</p>
      </div>
    </div>
  )
}
