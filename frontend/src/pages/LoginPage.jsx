import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getCloudProvider, getLoginUrl, isValidRegion, PODS } from '../constants/pods'
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

// ── User Login ───────────────────────────────────────────────────────────
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
    if (!isValidRegion(trimmedRegion)) return 'Please select a pod from the dropdown.'
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
        <label htmlFor="region">Pod / Region</label>
        <select
          id="region" name="region"
          value={region}
          onChange={(e) => { setRegion(e.target.value); setError('') }}
          disabled={loading}
          className={!region ? 'placeholder' : ''}
        >
          <option value="">Select your pod…</option>
          {PODS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.pods.map((p) => (
                <option key={p.region} value={p.region}>{p.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
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
