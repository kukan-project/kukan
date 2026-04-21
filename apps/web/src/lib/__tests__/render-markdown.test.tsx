import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { renderSimpleMarkdown } from '../render-markdown'

function renderToText(text: string) {
  const { container } = render(<div>{renderSimpleMarkdown(text)}</div>)
  return container
}

describe('renderSimpleMarkdown', () => {
  it('should render plain text', () => {
    const container = renderToText('Hello world')
    expect(container.textContent).toBe('Hello world')
  })

  it('should render bold text', () => {
    const container = renderToText('This is **bold** text')
    const strong = container.querySelector('strong')
    expect(strong?.textContent).toBe('bold')
  })

  it('should render italic text', () => {
    const container = renderToText('This is *italic* text')
    const em = container.querySelector('em')
    expect(em?.textContent).toBe('italic')
  })

  it('should render strikethrough text', () => {
    const container = renderToText('This is ~~deleted~~ text')
    const del = container.querySelector('del')
    expect(del?.textContent).toBe('deleted')
  })

  it('should render inline code', () => {
    const container = renderToText('Use `console.log` here')
    const code = container.querySelector('code')
    expect(code?.textContent).toBe('console.log')
  })

  it('should render links', () => {
    const container = renderToText('Visit [Example](https://example.com)')
    const link = container.querySelector('a')
    expect(link?.textContent).toBe('Example')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('should render newlines as <br>', () => {
    const container = renderToText('Line 1\nLine 2')
    const brs = container.querySelectorAll('br')
    expect(brs.length).toBe(1)
  })

  it('should decode HTML entities', () => {
    const container = renderToText('A &amp; B &lt; C')
    expect(container.textContent).toBe('A & B < C')
  })

  it('should decode numeric HTML entities', () => {
    const container = renderToText('&#169; copyright')
    expect(container.textContent).toBe('© copyright')
  })

  it('should decode hex HTML entities', () => {
    const container = renderToText('&#x00A9; copyright')
    expect(container.textContent).toBe('© copyright')
  })

  it('should handle bold inside links', () => {
    const container = renderToText('[**Bold Link**](https://example.com)')
    const link = container.querySelector('a')
    const strong = link?.querySelector('strong')
    expect(strong?.textContent).toBe('Bold Link')
  })
})
