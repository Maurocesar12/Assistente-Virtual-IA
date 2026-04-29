export const DEMO_READ_ONLY_ERROR =
  'Modo demonstracao somente leitura. Registre sua conta para criar, editar ou conectar recursos.'

export function isDemoUser(user: { email?: string | null; name?: string | null; lastName?: string | null } | null | undefined) {
  if (!user?.email) return false
  const emailLooksDemo = /^demo_\d+@zapgpt\.com$/i.test(user.email)
  return emailLooksDemo && user.name === 'Demo' && user.lastName === 'User'
}
