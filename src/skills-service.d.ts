/**
 * Ambient typing for the host's `skills` registry (@deepseek-ai/dsh-skill),
 * mirrored only for the surface this plugin uses so it does not become a
 * hard dependency.
 */
import type { SkillProvider } from './skills/provider.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: {
      /** Register a provider; `control.invalidate()` makes the registry list it again. Returns the disposer. */
      registerProvider(create: (control: { readonly signal: AbortSignal; invalidate(): void }) => SkillProvider): () => void
    }
  }
}
