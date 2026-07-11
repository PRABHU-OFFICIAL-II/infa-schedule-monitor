import { useEffect, useState } from 'react'
import './Toast.css'

export default function Toast({ message, type = 'success', onClose }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // double rAF ensures the initial painted state is flushed before
    // applying the visible class, which is required for CSS transitions to fire
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf2)
    })
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(onClose, 300)
    }, 4000)
    return () => { cancelAnimationFrame(raf1); clearTimeout(timer) }
  }, [onClose])

  return (
    <div className={`toast toast-${type} ${visible ? 'toast-visible' : ''}`}>
      <span className="toast-icon">{type === 'success' ? '✓' : '✕'}</span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={() => { setVisible(false); setTimeout(onClose, 300) }}>×</button>
    </div>
  )
}
