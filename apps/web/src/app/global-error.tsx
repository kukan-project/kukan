'use client'

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="ja">
      <body>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            gap: '1rem',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <h1 style={{ fontSize: '3.75rem', fontWeight: 'bold', color: '#6b7280' }}>500</h1>
          <p style={{ fontSize: '1.125rem', color: '#6b7280' }}>
            予期しないエラーが発生しました / An unexpected error occurred
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#111827',
              color: '#f9fafb',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            再試行 / Retry
          </button>
        </div>
      </body>
    </html>
  )
}
