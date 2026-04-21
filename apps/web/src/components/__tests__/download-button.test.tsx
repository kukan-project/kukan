import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DownloadButton } from '../download-button'

describe('DownloadButton', () => {
  const defaultProps = {
    datasetNameOrId: 'my-dataset',
    resourceId: 'res-123',
    filename: 'data.csv',
    label: 'Download',
  }

  it('should render a download link with correct href', () => {
    render(<DownloadButton {...defaultProps} />)
    const link = screen.getByRole('link', { name: /Download/ })
    expect(link).toHaveAttribute(
      'href',
      '/dataset/my-dataset/resource/res-123/download/data.csv'
    )
  })

  it('should extract filename from a full URL', () => {
    render(
      <DownloadButton
        {...defaultProps}
        filename="https://example.com/files/report.pdf"
      />
    )
    const link = screen.getByRole('link', { name: /Download/ })
    expect(link).toHaveAttribute(
      'href',
      '/dataset/my-dataset/resource/res-123/download/report.pdf'
    )
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
})
