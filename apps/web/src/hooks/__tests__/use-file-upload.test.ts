import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useFileUpload } from '../use-file-upload'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

function createFile(name: string, content = 'test') {
  return new File([content], name, { type: 'text/csv' })
}

// Minimal XMLHttpRequest mock
function mockXHR() {
  const listeners: Record<string, (() => void)[]> = {}
  const uploadListeners: Record<string, ((e: unknown) => void)[]> = {}

  const xhr = {
    open: vi.fn(),
    send: vi.fn(),
    setRequestHeader: vi.fn(),
    abort: vi.fn(),
    status: 200,
    addEventListener: vi.fn((event: string, cb: () => void) => {
      ;(listeners[event] ||= []).push(cb)
    }),
    upload: {
      addEventListener: vi.fn((event: string, cb: (e: unknown) => void) => {
        ;(uploadListeners[event] ||= []).push(cb)
      }),
    },
    // helpers for test
    _fireLoad: () => listeners['load']?.forEach((cb) => cb()),
    _fireError: () => listeners['error']?.forEach((cb) => cb()),
    _fireAbort: () => listeners['abort']?.forEach((cb) => cb()),
    _fireProgress: (loaded: number, total: number) =>
      uploadListeners['progress']?.forEach((cb) => cb({ lengthComputable: true, loaded, total })),
  }

  vi.stubGlobal(
    'XMLHttpRequest',
    vi.fn(() => xhr)
  )

  return xhr
}

describe('useFileUpload', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should start in idle state', () => {
    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1' }))
    expect(result.current.status).toBe('idle')
    expect(result.current.progress).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('should complete full upload flow', async () => {
    const xhr = mockXHR()
    const onComplete = vi.fn()

    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ upload_url: 'https://minio/upload' }))
      .mockResolvedValueOnce(jsonResponse({ pipeline_status: 'queued' }))

    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1', onComplete }))

    const file = createFile('data.csv')

    await act(async () => {
      result.current.upload(file)
      // Wait for upload-url request
      await vi.waitFor(() => {
        expect(xhr.open).toHaveBeenCalledWith('PUT', 'https://minio/upload')
      })
    })

    // Simulate progress
    act(() => {
      xhr._fireProgress(50, 100)
    })
    expect(result.current.progress).toBe(50)

    // Simulate upload complete
    await act(async () => {
      xhr._fireLoad()
    })

    // Wait for upload-complete call
    await vi.waitFor(() => {
      expect(result.current.status).toBe('done')
    })

    expect(onComplete).toHaveBeenCalled()
  })

  it('should handle upload-url request failure', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ detail: 'Unauthorized' }, false))

    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1' }))

    await act(async () => {
      result.current.upload(createFile('data.csv'))
    })

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error')
    })
    expect(result.current.error).toBe('Unauthorized')
  })

  it('should handle XHR error', async () => {
    const xhr = mockXHR()
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ upload_url: 'https://minio/upload' }))

    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1' }))

    await act(async () => {
      result.current.upload(createFile('data.csv'))
      await vi.waitFor(() => {
        expect(xhr.send).toHaveBeenCalled()
      })
    })

    await act(async () => {
      xhr._fireError()
    })

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error')
    })
    expect(result.current.error).toBe('Upload failed')
  })

  it('should handle cancel', async () => {
    const xhr = mockXHR()
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ upload_url: 'https://minio/upload' }))

    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1' }))

    await act(async () => {
      result.current.upload(createFile('data.csv'))
      await vi.waitFor(() => {
        expect(xhr.send).toHaveBeenCalled()
      })
    })

    act(() => {
      result.current.cancel()
    })

    expect(xhr.abort).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('should reset state', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ detail: 'error' }, false))

    const { result } = renderHook(() => useFileUpload({ resourceId: 'r1' }))

    await act(async () => {
      result.current.upload(createFile('data.csv'))
    })

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error')
    })

    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })
})
