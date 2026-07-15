import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { AiSuggestCard } from '../ai-suggest-card'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
const mockClientFetch = vi.mocked(clientFetch)

const settingsResponse = (availableModels: string[]) =>
  ({
    ok: true,
    json: async () => ({
      enabled: true,
      provider: 'ollama',
      defaultModel: 'gemma4:e4b',
      model: '',
      effectiveModel: 'gemma4:e4b',
      suggestEnabled: true,
      availableModels,
    }),
  }) as Response

describe('AiSuggestCard', () => {
  beforeEach(() => mockClientFetch.mockReset())

  it('renders a model select when the provider lists available models', async () => {
    mockClientFetch.mockResolvedValue(settingsResponse(['gemma4:e4b', 'qwen3:8b']))
    render(<AiSuggestCard />)

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('falls back to a free-text input when no models are listed', async () => {
    mockClientFetch.mockResolvedValue(settingsResponse([]))
    render(<AiSuggestCard />)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('announces a successful connection test as a polite status, not an alert', async () => {
    mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return {
          ok: true,
          json: async () => ({ ok: true, model: 'gemma4:e4b', latencyMs: 123 }),
        } as Response
      return settingsResponse([])
    })
    render(<AiSuggestCard />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Connected: gemma4:e4b (123ms)')
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
