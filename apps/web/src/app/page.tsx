import { Button } from '@kukan/ui'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">KUKAN</h1>
      <p className="text-muted-foreground text-lg">オープンデータカタログ</p>
      <div className="flex gap-3">
        <Button>データセットを探す</Button>
        <Button variant="outline">ログイン</Button>
      </div>
    </main>
  )
}
