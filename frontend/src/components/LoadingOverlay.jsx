import './LoadingOverlay.css'

export default function LoadingOverlay({ message = 'Loading...' }) {
  return (
    <div className="overlay">
      <div className="overlay-box">
        <div className="overlay-spinner" />
        <p className="overlay-message">{message}</p>
      </div>
    </div>
  )
}
