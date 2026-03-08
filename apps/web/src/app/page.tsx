import Link from 'next/link'
import { Button } from '@kukan/ui'

export default function HomePage() {
  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] flex-col items-center gap-8 px-4 py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">KUKAN</h1>
        <p className="max-w-lg text-lg text-muted-foreground">
          オープンデータカタログ — 自治体・官公庁のデータを検索・活用するためのプラットフォーム
        </p>
      </div>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/dataset">データセットを探す</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/auth/sign-in">ログイン</Link>
        </Button>
      </div>
    </div>
  )
}
