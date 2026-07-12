import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
})
