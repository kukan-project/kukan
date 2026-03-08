export function EntityImage({ imageUrl, name }: { imageUrl?: string | null; name: string }) {
  if (imageUrl) {
    return <img src={imageUrl} alt={name} className="h-16 w-16 rounded-lg object-contain" />
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-muted text-2xl font-bold text-muted-foreground">
      {name.charAt(0).toUpperCase()}
    </div>
  )
}
