import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'KUKAN — オープンデータカタログ',
  description: 'Knowledge Unified Katalog And Network',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  )
}
