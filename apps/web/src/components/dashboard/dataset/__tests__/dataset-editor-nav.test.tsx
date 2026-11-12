import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DatasetEditorNav } from '../dataset-editor-nav'
import type { EditorPackage } from '../dataset-editor-context'

// The status dots ask why a failed run failed; nothing here answers
vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
}))

const nav = vi.hoisted(() => ({ pathname: '/dashboard/datasets/pkg-1', search: '' }))
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}))

const pkg: EditorPackage = {
  id: 'pkg-1',
  name: 'population',
  title: 'Population',
  state: 'active',
  resources: [
    { id: 'r1', name: '2024.csv', format: 'CSV', section: 'Tables', pipelineStatus: 'complete' },
    { id: 'r2', name: '2023.csv', format: 'CSV', section: 'Tables', pipelineStatus: 'error' },
    { id: 'r3', name: 'form.pdf', format: 'PDF', section: 'Notes/Forms' },
  ],
}

describe('DatasetEditorNav', () => {
  beforeEach(() => {
    nav.pathname = '/dashboard/datasets/pkg-1'
    nav.search = ''
  })

  it('lists the resources under their headings, each linking to its page', () => {
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    expect(screen.getByRole('link', { name: /2024\.csv/ })).toHaveAttribute(
      'href',
      '/dashboard/datasets/pkg-1/resources/r1'
    )
    // One heading per run, and a `/` stays part of the label (ADR-050)
    expect(screen.getAllByText('Tables')).toHaveLength(1)
    expect(screen.getByText('Notes/Forms')).toBeInTheDocument()
  })

  it('names each state, so it does not rest on colour', () => {
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    expect(screen.getByRole('img', { name: 'Complete' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Error' })).toBeInTheDocument()
  })

  it('marks the page that is open', () => {
    nav.pathname = '/dashboard/datasets/pkg-1/resources/r2'
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    expect(screen.getByRole('link', { name: /2023\.csv/ })).toHaveAttribute('aria-current', 'page')
  })

  it('carries the state onto every link', () => {
    nav.search = 'state=draft'
    render(
      <DatasetEditorNav
        pkg={{ ...pkg, state: 'draft' }}
        readOnly={false}
        onUpdated={async () => true}
      />
    )
    expect(screen.getByRole('link', { name: /2024\.csv/ })).toHaveAttribute(
      'href',
      '/dashboard/datasets/pkg-1/resources/r1?state=draft'
    )
  })

  it('only shows the resources of a deleted dataset', () => {
    // Their pages could not be read or written (ADR-072 decision 4)
    nav.search = 'state=deleted'
    render(
      <DatasetEditorNav pkg={{ ...pkg, state: 'deleted' }} readOnly onUpdated={async () => true} />
    )
    expect(screen.getByText('2024.csv')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /2024\.csv/ })).not.toBeInTheDocument()
  })

  it('folds the contents under a bar naming what is open, for a narrow screen', () => {
    // One column there: the list stands above the page (ADR-072 decision 8)
    nav.pathname = '/dashboard/datasets/pkg-1/resources/r2'
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    const bar = screen.getByRole('button', { name: /2023\.csv/ })
    const contents = document.getElementById('dataset-editor-contents')!
    expect(bar).toHaveAttribute('aria-expanded', 'false')
    expect(contents).toHaveClass('hidden')

    fireEvent.click(bar)
    expect(bar).toHaveAttribute('aria-expanded', 'true')
    expect(contents).not.toHaveClass('hidden')
  })

  it('only shows the list to a viewer who cannot write the dataset', () => {
    // The API would refuse every arrangement, addition and edit
    render(<DatasetEditorNav pkg={pkg} readOnly onUpdated={async () => true} />)
    expect(screen.queryByRole('link', { name: /2024\.csv/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Add Resource')).not.toBeInTheDocument()
  })

  it('goes back to the list as it was left', async () => {
    sessionStorage.setItem(
      'kukan:dashboard-dataset-list',
      '/dashboard/datasets?category=drafts&page=2'
    )
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    expect(await screen.findByRole('link', { name: 'All datasets' })).toHaveAttribute(
      'href',
      '/dashboard/datasets?category=drafts&page=2'
    )
    sessionStorage.clear()
  })

  it('takes nothing but the list from storage', async () => {
    sessionStorage.setItem('kukan:dashboard-dataset-list', 'https://example.com/elsewhere')
    render(<DatasetEditorNav pkg={pkg} readOnly={false} onUpdated={async () => true} />)
    expect(await screen.findByRole('link', { name: 'All datasets' })).toHaveAttribute(
      'href',
      '/dashboard/datasets'
    )
    sessionStorage.clear()
  })
})
