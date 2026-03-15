'use client'

import { createContext, useContext } from 'react'

export interface DashboardUser {
  id: string
  name: string
  email: string
  role?: string
  sysadmin: boolean
}

const UserContext = createContext<DashboardUser | null>(null)

export function UserProvider({
  user,
  children,
}: {
  user: DashboardUser
  children: React.ReactNode
}) {
  return <UserContext value={user}>{children}</UserContext>
}

export function useUser(): DashboardUser {
  const user = useContext(UserContext)
  if (!user) throw new Error('useUser must be used within UserProvider')
  return user
}
