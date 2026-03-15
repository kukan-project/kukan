import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SearchForm } from '../search-form'

describe('SearchForm', () => {
  it('should render input with default placeholder', () => {
    render(<SearchForm action="/dataset" />)
    expect(screen.getByPlaceholderText('データセットを検索...')).toBeInTheDocument()
  })

  it('should set default value', () => {
    render(<SearchForm action="/dataset" defaultValue="test query" />)
    expect(screen.getByDisplayValue('test query')).toBeInTheDocument()
  })

  it('should use custom placeholder', () => {
    render(<SearchForm action="/dataset" placeholder="組織を検索..." />)
    expect(screen.getByPlaceholderText('組織を検索...')).toBeInTheDocument()
  })

  it('should render form with correct action', () => {
    const { container } = render(<SearchForm action="/dataset" />)
    const form = container.querySelector('form')
    expect(form).toHaveAttribute('action', '/dataset')
    expect(form).toHaveAttribute('method', 'GET')
  })

  it('should render search button', () => {
    render(<SearchForm action="/dataset" />)
    expect(screen.getByRole('button', { name: '検索' })).toBeInTheDocument()
  })

  it('should render hidden params as hidden inputs', () => {
    const { container } = render(
      <SearchForm action="/dataset" hiddenParams={{ organization: 'org1', tags: 'tag1,tag2' }} />
    )
    const orgInput = container.querySelector('input[name="organization"]') as HTMLInputElement
    expect(orgInput).toBeInTheDocument()
    expect(orgInput.type).toBe('hidden')
    expect(orgInput.value).toBe('org1')

    const tagsInput = container.querySelector('input[name="tags"]') as HTMLInputElement
    expect(tagsInput).toBeInTheDocument()
    expect(tagsInput.value).toBe('tag1,tag2')
  })

  it('should not render hidden input for undefined values', () => {
    const { container } = render(
      <SearchForm action="/dataset" hiddenParams={{ organization: undefined, tags: 'tag1' }} />
    )
    expect(container.querySelector('input[name="organization"]')).not.toBeInTheDocument()
    expect(container.querySelector('input[name="tags"]')).toBeInTheDocument()
  })
})
