import type { Metadata } from 'next'
import { DM_Sans, Noto_Sans_JP } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { brandConfig } from '@/brand'
import { Header } from '@/components/layout/header'
import { Footer } from '@/components/layout/footer'
import './globals.css'
import '@/brand/theme.css'

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const metadata: Metadata = {
  // TODO: Introduce a dedicated SITE_URL env var instead of reusing BETTER_AUTH_URL, and add an OG image to public/
  metadataBase: new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000'),
  title: brandConfig.siteName,
  description: brandConfig.siteDescription,
  icons: { icon: brandConfig.faviconPath },
  openGraph: { images: [brandConfig.ogImage] },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html lang={locale} className={`${dmSans.variable} ${notoSansJP.variable}`}>
      <body className="flex min-h-screen flex-col font-[family-name:var(--font-body)] antialiased">
        <NextIntlClientProvider messages={messages}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
