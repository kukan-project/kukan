import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DownloadButton } from '../download-button'

describe('DownloadButton', () => {
  const defaultProps = {
    datasetNameOrId: 'my-dataset',
    resourceId: 'res-123',
    filename: 'data.csv',
    label: 'Download',
  }

  beforeEach(() => {
    delete window.gtag
  })

  it('should render a download link with correct href', () => {
    render(<DownloadButton {...defaultProps} />)
    const link = screen.getByRole('link', { name: /Download/ })
    expect(link).toHaveAttribute('href', '/dataset/my-dataset/resource/res-123/download/data.csv')
  })

  it('should extract filename from a full URL', () => {
    render(<DownloadButton {...defaultProps} filename="https://example.com/files/report.pdf" />)
    const link = screen.getByRole('link', { name: /Download/ })
    expect(link).toHaveAttribute('href', '/dataset/my-dataset/resource/res-123/download/report.pdf')
  })

  it('should show formatted size when provided', () => {
    render(<DownloadButton {...defaultProps} size={1048576} />)
    expect(screen.getByText('(1.0 MB)')).toBeInTheDocument()
  })

  it('should not show size when null', () => {
    render(<DownloadButton {...defaultProps} size={null} />)
    expect(screen.queryByText(/MB|KB|B/)).not.toBeInTheDocument()
  })

  it('should not show size when zero', () => {
    render(<DownloadButton {...defaultProps} size={0} />)
    expect(screen.queryByText(/\(.*\)/)).not.toBeInTheDocument()
  })

  it('should call gtag with file_download event on click', () => {
    const mockGtag = vi.fn()
    window.gtag = mockGtag

    render(<DownloadButton {...defaultProps} format="csv" />)
    const link = screen.getByRole('link', { name: /Download/ })
    fireEvent.click(link)

    expect(mockGtag).toHaveBeenCalledWith('event', 'file_download', {
      file_name: 'data.csv',
      link_url: '/dataset/my-dataset/resource/res-123/download/data.csv',
      dataset_name: 'my-dataset',
      resource_id: 'res-123',
      format: 'csv',
    })
  })

  it('should not throw when gtag is not defined', () => {
    render(<DownloadButton {...defaultProps} />)
    const link = screen.getByRole('link', { name: /Download/ })
    expect(() => fireEvent.click(link)).not.toThrow()
  })
})
