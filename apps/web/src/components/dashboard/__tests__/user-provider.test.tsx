import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { UserProvider, useUser, type DashboardUser } from '../user-provider'

const testUser: DashboardUser = {
  id: 'user-1',
  name: 'alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  sysadmin: false,
}

describe('UserProvider', () => {
  it('should provide user to children', () => {
    function Child() {
      const user = useUser()
      return <span>{user.displayName}</span>
    }

    render(
      <UserProvider user={testUser}>
        <Child />
      </UserProvider>
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })
})

describe('useUser', () => {
  it('should throw when used outside provider', () => {
    expect(() => {
      renderHook(() => useUser())
    }).toThrow('useUser must be used within UserProvider')
  })
})
