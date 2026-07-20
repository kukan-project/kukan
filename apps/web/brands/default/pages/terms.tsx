import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '利用規約',
  description: 'KUKANの利用規約',
}

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-8 text-2xl font-bold">利用規約</h1>

      <section className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <h2 className="text-lg font-semibold text-foreground">第1条（適用）</h2>
        <p>
          本規約は、本サービスの利用に関する条件を定めるものです。
          利用者は本規約に同意の上、本サービスを利用するものとします。
        </p>

        <h2 className="text-lg font-semibold text-foreground">第2条（利用条件）</h2>
        <p>
          本サービスで公開されるデータは、各データセットに付与されたライセンスに従って利用できます。
          特段の記載がない場合、クリエイティブ・コモンズ 表示 4.0 国際（CC BY 4.0）が適用されます。
        </p>

        <h2 className="text-lg font-semibold text-foreground">第3条（禁止事項）</h2>
        <p>以下の行為を禁止します。</p>
        <ul className="list-inside list-disc space-y-1 pl-4">
          <li>法令または公序良俗に違反する行為</li>
          <li>サービスの運営を妨害する行為</li>
          <li>他の利用者の利用を妨げる行為</li>
        </ul>

        <h2 className="text-lg font-semibold text-foreground">第4条（免責事項）</h2>
        <p>
          本サービスで提供されるデータの正確性、完全性について保証するものではありません。
          データの利用により生じた損害について、運営者は一切の責任を負いません。
        </p>
      </section>
    </article>
  )
}
