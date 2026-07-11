import './Pagination.css'

export default function Pagination({ page, totalPages, totalItems, pageSize, onPageChange }) {
  if (totalPages <= 1) return null

  const from = (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, totalItems)

  // build visible page numbers: always show first, last, current ±2, with ellipsis
  function getPages() {
    const pages = []
    const delta = 2
    const left  = page - delta
    const right = page + delta

    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= left && i <= right)) {
        pages.push(i)
      }
    }

    const withEllipsis = []
    let prev = null
    for (const p of pages) {
      if (prev && p - prev > 1) withEllipsis.push('...')
      withEllipsis.push(p)
      prev = p
    }
    return withEllipsis
  }

  return (
    <div className="pagination">
      <span className="pagination-info">
        Showing <strong>{from}–{to}</strong> of <strong>{totalItems}</strong>
      </span>

      <div className="pagination-controls">
        <button
          className="page-btn"
          onClick={() => onPageChange(1)}
          disabled={page === 1}
          title="First page"
        >«</button>

        <button
          className="page-btn"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 1}
          title="Previous page"
        >‹</button>

        {getPages().map((p, i) =>
          p === '...'
            ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span>
            : <button
                key={p}
                className={`page-btn ${p === page ? 'page-active' : ''}`}
                onClick={() => onPageChange(p)}
              >{p}</button>
        )}

        <button
          className="page-btn"
          onClick={() => onPageChange(page + 1)}
          disabled={page === totalPages}
          title="Next page"
        >›</button>

        <button
          className="page-btn"
          onClick={() => onPageChange(totalPages)}
          disabled={page === totalPages}
          title="Last page"
        >»</button>
      </div>
    </div>
  )
}
