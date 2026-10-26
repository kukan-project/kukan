import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SystemInfoCard } from '../system-info-card'

/** The value shown under a label, so a swap of the two is not a pass */
function valueUnder(label: string) {
  return screen.getByText(label).parentElement?.querySelector('dd')?.textContent
}

describe('SystemInfoCard', () => {
  it('names the release and the runtime it is on', () => {
    render(<SystemInfoCard build={{ version: '0.32.1', node: 'v24.21.0' }} />)

    expect(valueUnder('Version')).toBe('0.32.1')
    expect(valueUnder('Node')).toBe('24.21.0')
  })
})
